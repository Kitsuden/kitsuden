/**
 * Kitsuden — Real-time WebSocket Server
 *
 * Provides WebSocket connections for Live Queries and Presence.
 * Uses Valkey Pub/Sub as the message broker for horizontal scaling.
 *
 * Channels:
 *   - table:{datasetId}  → All mutations in a dataset
 *   - entry:{entryId}    → Single entry updates
 *   - presence:{room}    → Who's online in a room
 *
 * Protocol (JSON messages):
 *   Client → Server:
 *     { "type": "subscribe", "channel": "table:abc123" }
 *     { "type": "unsubscribe", "channel": "table:abc123" }
 *     { "type": "presence:join", "room": "editor:doc-1" }
 *     { "type": "presence:leave", "room": "editor:doc-1" }
 *     { "type": "ping" }
 *
 *   Server → Client:
 *     { "type": "subscribed", "channel": "table:abc123" }
 *     { "type": "unsubscribed", "channel": "table:abc123" }
 *     { "type": "message", "channel": "table:abc123", "data": {...} }
 *     { "type": "presence", "room": "...", "users": [...] }
 *     { "type": "pong" }
 *     { "type": "error", "message": "..." }
 */

import type { ServerWebSocket } from "bun";

import { subscribe, publish, getValkeyClient } from "./valkey";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface WSClient {
  id: string;
  userId: string | null;
  /** User role — needed by channel authorization. */
  userRole: string | null;
  /** better-auth session the socket was opened with (null: anonymous). */
  sessionId: string | null;
  /** That session's expiry (ms epoch): the socket does not outlive it. */
  sessionExpiresAt: number | null;
  socket: ServerWebSocket<WSClientData>;
  channels: Set<string>;
  rooms: Set<string>; // Presence rooms
}

export interface WSClientData {
  clientId: string;
  userId: string | null;
  userRole?: string | null;
  sessionId?: string | null;
  sessionExpiresAt?: number | null;
}

interface IncomingMessage {
  type: "subscribe" | "unsubscribe" | "presence:join" | "presence:leave" | "ping";
  channel?: string;
  room?: string;
}

/**
 * Cap on `type`, `channel` and `room` in a client frame. Valid names are
 * short; a huge one only burns CPU in a regex or inflates the error echoed back.
 */
export const MAX_FRAME_NAME_LENGTH = 200;

/** How often the session of every signed-in socket is re-read. */
export const SESSION_REVALIDATE_MS = 60_000;

/** Close code for a socket whose session no longer holds (4000–4999: application). */
export const CLOSE_INVALID_SESSION = 4401;

// ═══════════════════════════════════════════════════════════════
// Session revalidation (pure, testable)
// ═══════════════════════════════════════════════════════════════

/** What the socket stored when it was opened. */
export interface SocketSession {
  userId: string | null;
  userRole: string | null;
  sessionId: string | null;
}

/** The session as it is NOW in the database (null: it no longer exists). */
export interface CurrentSession {
  userId: string;
  role: string | null;
  /** ms epoch */
  expiresAt: number;
}

export type SessionDecision =
  | { keep: true; expiresAt: number | null }
  | {
      keep: false;
      reason: "revoked" | "expired" | "other-user" | "role-changed" | "no-session";
    };

/**
 * Does the socket still hold? Decided from what was stored when it opened and
 * what the database says now. An anonymous socket has no session to re-read:
 * it stays (its permissions are already the minimum). A role change in either
 * direction closes it: the client reconnects and is authorized with the new role.
 */
export function decideSession(
  socket: SocketSession,
  current: CurrentSession | null,
  now: number
): SessionDecision {
  if (!socket.userId) return { keep: true, expiresAt: null };
  // A user without a session id cannot be revalidated: close.
  if (!socket.sessionId) return { keep: false, reason: "no-session" };
  if (!current) return { keep: false, reason: "revoked" };
  if (current.expiresAt <= now) return { keep: false, reason: "expired" };
  if (current.userId !== socket.userId) return { keep: false, reason: "other-user" };
  if ((current.role ?? null) !== (socket.userRole ?? null)) {
    return { keep: false, reason: "role-changed" };
  }
  return { keep: true, expiresAt: current.expiresAt };
}

/** A name that comes in a frame: a non-empty string under the cap. */
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FRAME_NAME_LENGTH;
}

// ═══════════════════════════════════════════════════════════════
// Connection Manager
// ═══════════════════════════════════════════════════════════════

class RealtimeManager {
  private clients = new Map<string, WSClient>();
  private channelSubscribers = new Map<string, Set<string>>(); // channel → Set<clientId>
  private presenceRooms = new Map<string, Map<string, { id: string; name?: string }>>(); // room → Map<clientId, user>
  // @ts-ignore - Private property, may be used in future
  private _valkeySubscriptions = new Map<string, () => Promise<void>>(); // channel → unsubscribe fn
  private initialized = false;
  /** Periodic session sweep; it only exists while there are clients. */
  private revalidationTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize Valkey subscriber for real-time events.
   * Call once at server startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Subscribe to all table, entry, and content channels via pattern
      await subscribe("table:*", (channel, message) => {
        this.broadcastToChannel(channel, message);
      });

      await subscribe("entry:*", (channel, message) => {
        this.broadcastToChannel(channel, message);
      });

      await subscribe("content:*", (channel, message) => {
        this.broadcastToChannel(channel, message);
      });

      this.initialized = true;
      console.log("  📡 Real-time Manager initialized (Valkey Pub/Sub)");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️  Real-time Manager: Valkey not available (${message})`);
    }
  }

  /**
   * Register a new WebSocket connection.
   */
  addClient(
    clientId: string,
    socket: ServerWebSocket<WSClientData>,
    userId: string | null,
    userRole: string | null = null,
    session: { id: string | null; expiresAt: number | null } = { id: null, expiresAt: null }
  ): WSClient {
    const client: WSClient = {
      id: clientId,
      userId,
      userRole,
      sessionId: userId ? session.id : null,
      sessionExpiresAt: userId ? session.expiresAt : null,
      socket,
      channels: new Set(),
      rooms: new Set(),
    };
    this.clients.set(clientId, client);
    this.startRevalidation();
    console.log(`  📡 [WS] Client connected: ${clientId} (user: ${userId || "anonymous"})`);
    return client;
  }

  // ═══════════════════════════════════════════════════════════
  // Session revalidation
  //
  // Identity and role were read ONCE at the upgrade and held for the life of
  // the socket: an account demoted or with its session revoked kept receiving
  // data. Now the session is re-read on every subscribe and every
  // SESSION_REVALIDATE_MS, and the socket is closed when the session is gone,
  // expired, or the role changed.
  // ═══════════════════════════════════════════════════════════

  /**
   * Revalidates one client; `true` if it is still connected. When the session
   * cannot be read (no database), the socket is closed: it fails closed, as
   * HTTP treats a request whose session cannot be read as anonymous.
   */
  async revalidateClient(clientId: string): Promise<boolean> {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (!client.userId) return true; // anonymous: nothing to revalidate

    let current: CurrentSession | null;
    try {
      if (_sessionValidator && client.sessionId) {
        current = await _sessionValidator(client.sessionId);
      } else {
        // No validator registered: at least the expiry stored at the upgrade.
        current =
          client.sessionExpiresAt !== null
            ? { userId: client.userId, role: client.userRole, expiresAt: client.sessionExpiresAt }
            : null;
      }
    } catch (err) {
      console.warn(`  🔒 [WS] ${clientId}: session check failed (${errorMessage(err)})`);
      this.closeClient(clientId, "Session could not be verified");
      return false;
    }

    // The client may have left while the session was being read.
    if (this.clients.get(clientId) !== client) return false;

    const decision = decideSession(
      { userId: client.userId, userRole: client.userRole, sessionId: client.sessionId },
      current,
      Date.now()
    );
    if (!decision.keep) {
      console.warn(`  🔒 [WS] ${clientId} closed: session ${decision.reason}`);
      this.closeClient(clientId, `Session ${decision.reason}`);
      return false;
    }
    // better-auth extends a session when it is used: keep the new expiry.
    client.sessionExpiresAt = decision.expiresAt;
    return true;
  }

  /** Revalidates every signed-in socket (called by the periodic sweep). */
  async revalidateAll(): Promise<void> {
    const ids = [...this.clients.values()].filter((c) => c.userId).map((c) => c.id);
    await Promise.all(ids.map((id) => this.revalidateClient(id).catch(() => false)));
  }

  /** Closes the socket and cleans up its state. Idempotent. */
  closeClient(clientId: string, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.sendError(client.socket, reason);
    try {
      client.socket.close(CLOSE_INVALID_SESSION, reason.slice(0, 120));
    } catch {
      // Already closed
    }
    this.removeClient(clientId);
  }

  private startRevalidation(): void {
    if (this.revalidationTimer) return;
    this.revalidationTimer = setInterval(() => {
      this.revalidateAll().catch((err: unknown) => {
        console.warn(`  🔒 [WS] session sweep failed: ${errorMessage(err)}`);
      });
    }, SESSION_REVALIDATE_MS);
    // The sweep alone does not keep the process alive.
    (this.revalidationTimer as { unref?: () => void }).unref?.();
  }

  private stopRevalidationIfIdle(): void {
    if (this.clients.size > 0 || !this.revalidationTimer) return;
    clearInterval(this.revalidationTimer);
    this.revalidationTimer = null;
  }

  /** Has the stored session already expired? (cheap check, no database). */
  private sessionExpired(client: WSClient): boolean {
    return (
      client.userId !== null &&
      client.sessionExpiresAt !== null &&
      client.sessionExpiresAt <= Date.now()
    );
  }

  /**
   * Remove a WebSocket connection and clean up subscriptions.
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Leave all channels
    for (const channel of client.channels) {
      this.unsubscribeFromChannel(clientId, channel);
    }

    // Leave all presence rooms
    for (const room of client.rooms) {
      this.leavePresenceRoom(clientId, room);
    }

    this.clients.delete(clientId);
    this.stopRevalidationIfIdle();
    console.log(`  📡 [WS] Client disconnected: ${clientId}`);
  }

  /**
   * Subscribe a client to a channel.
   */
  async subscribeToChannel(clientId: string, channel: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Validate channel format (table, entry, content channels)
    // The error does not echo the channel back: it is whatever the client sent.
    if (!validName(channel) || !/^(table|entry|content):[a-zA-Z0-9_-]+$/.test(channel)) {
      this.sendError(client.socket, "Invalid channel format");
      return;
    }

    // The session is re-read BEFORE authorizing: the role that decides must be
    // the current one, not the one from the upgrade.
    if (!(await this.revalidateClient(clientId))) return;

    // AUTHORIZATION — before, only the channel FORMAT was validated, so
    // any connected client could listen to any table. The
    // authorizer is injected by the host (see setSubscriptionAuthorizer) so as not to
    // couple the transport to the policies or create an import cycle.
    // Without a registered authorizer: deny-by-default except admin.
    const user = { id: client.userId, role: client.userRole ?? null };
    const allowed = _authorizer ? await _authorizer(channel, user) : client.userRole === "admin";

    if (!allowed) {
      this.sendError(client.socket, `Not authorized for channel: ${channel}`);
      console.warn(`  🔒 [WS] ${clientId} DENIED on ${channel} (user: ${client.userId ?? "anon"})`);
      return;
    }

    // It left (or was closed) while being authorized: leave no orphan subscriber.
    if (this.clients.get(clientId) !== client) return;

    client.channels.add(channel);

    // Track channel subscribers
    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(clientId);

    this.send(client.socket, { type: "subscribed", channel });
    console.log(`  📡 [WS] ${clientId} subscribed to ${channel}`);
  }

  /**
   * Unsubscribe a client from a channel.
   */
  unsubscribeFromChannel(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.channels.delete(channel);
      this.send(client.socket, { type: "unsubscribed", channel });
    }

    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }
  }

  /**
   * Broadcast a message to all subscribers of a channel.
   */
  private broadcastToChannel(channel: string, message: string): void {
    // The row filter may need the database (the channel's policy): broadcasts of
    // one channel are chained so its messages still arrive in order.
    const previous = this.channelQueue.get(channel) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliverToChannel(channel, message))
      .catch((err: unknown) => {
        console.error(`[realtime] broadcast on ${channel} failed:`, err);
      });
    this.channelQueue.set(channel, next);
    void next.then(() => {
      if (this.channelQueue.get(channel) === next) this.channelQueue.delete(channel);
    });
  }

  private channelQueue = new Map<string, Promise<void>>();

  private async deliverToChannel(channel: string, message: string): Promise<void> {
    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      data = message;
    }

    for (const clientId of [...subscribers]) {
      const client = this.clients.get(clientId);
      if (!client) continue;

      // The session expired between two sweeps: nothing is delivered, the socket closes.
      if (this.sessionExpired(client)) {
        this.closeClient(clientId, "Session expired");
        continue;
      }

      // PER-SUBSCRIBER FILTERING — not a blind fan-out.
      // Delivering the same row to everyone subscribed to the channel would leak data
      // between users (the same bug we had in GraphQL and in dataset
      // entries, but in streaming). The filter decides PER CLIENT whether that
      // specific row belongs to them; without a registered filter, it is only delivered
      // a admins (deny-by-default).
      // A filter that throws (synchronously or not) delivers nothing to that
      // client and does not cut off the other subscribers (fails closed).
      const filter = _rowFilter;
      const visible = filter
        ? await Promise.resolve()
            .then(() => filter(channel, data, { id: client.userId, role: client.userRole ?? null }))
            .catch((err: unknown) => {
              console.warn(`  🔒 [WS] row filter failed on ${channel}: ${errorMessage(err)}`);
              return null;
            })
        : client.userRole === "admin"
          ? data
          : null;

      if (visible === null || visible === undefined) continue;
      this.send(client.socket, { type: "message", channel, data: visible });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Presence System
  // ═══════════════════════════════════════════════════════════

  /**
   * Join a presence room.
   */
  joinPresenceRoom(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Validate room format
    if (!validName(room) || !/^[a-zA-Z0-9_:-]+$/.test(room)) {
      this.sendError(client.socket, "Invalid room format");
      return;
    }

    // Presence only with a session: anyone who opened the socket joined
    // any room and saw who was there (an earlier audit).
    if (!client.userId) {
      this.sendError(client.socket, "Presence requires an authenticated session");
      return;
    }

    client.rooms.add(room);

    if (!this.presenceRooms.has(room)) {
      this.presenceRooms.set(room, new Map());
    }

    const roomUsers = this.presenceRooms.get(room)!;
    roomUsers.set(clientId, {
      id: client.userId || clientId,
      name: client.userId ? undefined : "Anonymous",
    });

    // Broadcast presence update to all in room
    this.broadcastPresence(room);
    console.log(`  📡 [WS] ${clientId} joined presence room ${room}`);
  }

  /**
   * Leave a presence room.
   */
  leavePresenceRoom(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.rooms.delete(room);
    }

    const roomUsers = this.presenceRooms.get(room);
    if (roomUsers) {
      roomUsers.delete(clientId);
      if (roomUsers.size === 0) {
        this.presenceRooms.delete(room);
      } else {
        this.broadcastPresence(room);
      }
    }
  }

  /**
   * Broadcast current presence to all users in a room.
   */
  private broadcastPresence(room: string): void {
    const roomUsers = this.presenceRooms.get(room);
    if (!roomUsers) return;

    const users = Array.from(roomUsers.values());
    const payload = { type: "presence", room, users, count: users.length };

    for (const [clientId] of roomUsers) {
      const client = this.clients.get(clientId);
      if (client) {
        this.send(client.socket, payload);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Public API for KonContext
  // ═══════════════════════════════════════════════════════════

  /**
   * Broadcast a message to a channel.
   * Used by KonContext.realtime.broadcast()
   */
  broadcast(channel: string, message: unknown): void {
    // Publish to Valkey for horizontal scaling (async, fire-and-forget)
    getValkeyClient()
      .then((valkey) => {
        if (valkey) {
          valkey.publish(channel, JSON.stringify(message)).catch(() => {
            // Valkey publish failed, ignore
          });
        }
      })
      .catch(() => {
        // Valkey not available, broadcast locally only
      });

    // Also broadcast locally
    this.broadcastToChannel(channel, JSON.stringify(message));
  }

  /**
   * Send a message to a specific user.
   * Used by KonContext.realtime.sendToUser()
   */
  sendToUser(userId: string, message: unknown): void {
    // Find all clients for this user
    for (const [, client] of this.clients) {
      if (client.userId === userId) {
        this.send(client.socket, message);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Message Handling
  // ═══════════════════════════════════════════════════════════

  /**
   * Handle incoming WebSocket message.
   */
  handleMessage(clientId: string, raw: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // The frame comes from a client that may be anonymous: nothing in it is
    // used before its type is checked. A `null`, a number or `{"channel": 1}`
    // used to throw inside a promise nobody caught.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(client.socket, "Invalid JSON");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.sendError(client.socket, "Invalid message");
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if (!validName(msg.type)) {
      this.sendError(client.socket, "Invalid message type");
      return;
    }
    const type = msg.type as IncomingMessage["type"];

    const needsChannel = type === "subscribe" || type === "unsubscribe";
    const needsRoom = type === "presence:join" || type === "presence:leave";
    if (needsChannel && !validName(msg.channel)) {
      this.sendError(client.socket, "Invalid channel");
      return;
    }
    if (needsRoom && !validName(msg.room)) {
      this.sendError(client.socket, "Invalid room");
      return;
    }
    const channel = msg.channel as string;
    const room = msg.room as string;

    try {
      switch (type) {
        case "subscribe":
          this.subscribeToChannel(clientId, channel).catch((err: unknown) => {
            console.warn(`  📡 [WS] ${clientId} subscribe failed: ${errorMessage(err)}`);
            const alive = this.clients.get(clientId);
            if (alive) this.sendError(alive.socket, "Subscription failed");
          });
          break;

        case "unsubscribe":
          this.unsubscribeFromChannel(clientId, channel);
          break;

        case "presence:join":
          this.joinPresenceRoom(clientId, room);
          break;

        case "presence:leave":
          this.leavePresenceRoom(clientId, room);
          break;

        case "ping":
          this.send(client.socket, { type: "pong", timestamp: Date.now() });
          break;

        default:
          // The type is not echoed back: it is whatever the client sent.
          this.sendError(client.socket, "Unknown message type");
      }
    } catch (err) {
      console.warn(`  📡 [WS] ${clientId} message failed: ${errorMessage(err)}`);
      this.sendError(client.socket, "Message failed");
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private send(socket: ServerWebSocket<WSClientData>, data: unknown): void {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      // Socket closed
    }
  }

  private sendError(socket: ServerWebSocket<WSClientData>, message: string): void {
    this.send(socket, { type: "error", message });
  }

  /**
   * Get stats for monitoring.
   */
  getStats(): {
    connections: number;
    channels: number;
    rooms: number;
  } {
    return {
      connections: this.clients.size,
      channels: this.channelSubscribers.size,
      rooms: this.presenceRooms.size,
    };
  }
}

// Singleton instance
export const realtimeManager = new RealtimeManager();

// ═══════════════════════════════════════════════════════════════
// Broadcast Helper (for use in data layer)
// ═══════════════════════════════════════════════════════════════

/**
 * Publish a content update to the real-time layer.
 * Used when blog posts or pages are updated in the editor.
 *
 * @param contentId Post/page ID
 * @param event Event type: "update" | "publish" | "unpublish"
 * @param content The content data (blocks, metadata)
 */
export async function broadcastContentUpdate(
  contentId: string,
  event: "update" | "publish" | "unpublish",
  content: Record<string, unknown>
): Promise<void> {
  const payload = {
    event,
    contentId,
    content,
    timestamp: Date.now(),
  };
  await publish(`content:${contentId}`, payload);
}

/**
 * Publish a mutation event to the real-time layer.
 * Call this from the data layer after successful insert/update/delete.
 *
 * @param datasetId Dataset ID
 * @param event Event type: "insert" | "update" | "delete"
 * @param entry The entry data
 */
export async function broadcastMutation(
  datasetId: string,
  event: "insert" | "update" | "delete",
  entry: Record<string, unknown>
): Promise<void> {
  const payload = {
    event,
    datasetId,
    entry,
    timestamp: Date.now(),
  };

  // Publish to table channel (all entries in dataset)
  await publish(`table:${datasetId}`, payload);

  // Publish to entry channel (specific entry)
  if (entry.id) {
    await publish(`entry:${entry.id}`, payload);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INJECTABLE AUTHORIZATION (setTelemetryProvider pattern)
//
// The transport must not know the data policies: the host wires them at
// startup. This way realtime.ts imports neither rls-builder nor the DB — avoiding the cycle and
// leaving the module testable in isolation.
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal user seen by the realtime authorization layer. */
export interface RealtimeUser {
  id: string | null;
  role: string | null;
}

/** Can this user subscribe to this channel? */
export type SubscriptionAuthorizer = (
  channel: string,
  user: RealtimeUser
) => boolean | Promise<boolean>;

/**
 * Trims an event for a specific subscriber. Returns `null` to NOT
 * deliver it (e.g. the row belongs to another user).
 */
export type RowFilter = (
  channel: string,
  data: unknown,
  user: RealtimeUser
) => unknown | null | Promise<unknown | null>;

let _authorizer: SubscriptionAuthorizer | null = null;
let _rowFilter: RowFilter | null = null;

/**
 * Registers who can subscribe to what. WITHOUT this, only admins can
 * subscribe (deny-by-default): we prefer a realtime that does not work to one
 * that leaks data between users.
 */
export function setSubscriptionAuthorizer(fn: SubscriptionAuthorizer | null): void {
  _authorizer = fn;
}

/** Registers the per-row filter applied to each subscriber on broadcast. */
export function setRowFilter(fn: RowFilter | null): void {
  _rowFilter = fn;
}

/** The registered per-row filter (for the tests that check the wiring). */
export function currentRowFilter(): RowFilter | null {
  return _rowFilter;
}

/** Reads a session by id as it is now (null if it no longer exists). */
export type SessionValidator = (sessionId: string) => Promise<CurrentSession | null>;

let _sessionValidator: SessionValidator | null = null;

/**
 * Registers how a socket's session is re-read. Without it only the expiry
 * stored at the upgrade is checked (revocations and role changes go unseen).
 */
export function setSessionValidator(fn: SessionValidator | null): void {
  _sessionValidator = fn;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
