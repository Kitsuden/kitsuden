/**
 * @kitsuden/sdk — Real-time Module
 *
 * Provides WebSocket connection management and Live Query subscriptions.
 *
 * Usage:
 *   import { KitsudenRealtime, createRealtime } from '@kitsuden/sdk/realtime';
 *
 *   const rt = createRealtime('http://localhost:3000');
 *   await rt.connect();
 *
 *   // Subscribe to all changes in a dataset
 *   const unsub = rt.subscribe('table:matches', (data) => {
 *     console.log('Mutation:', data.event, data.entry);
 *   });
 *
 *   // Presence
 *   rt.joinRoom('editor:doc-123');
 *   rt.onPresence('editor:doc-123', (users) => {
 *     console.log('Users online:', users);
 *   });
 *
 *   // Cleanup
 *   unsub();
 *   rt.disconnect();
 */

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface MutationEvent {
  event: "insert" | "update" | "delete";
  datasetId: string;
  entry: Record<string, unknown>;
  timestamp: number;
}

export interface PresenceUser {
  id: string;
  name?: string;
}

export interface PresenceEvent {
  room: string;
  users: PresenceUser[];
  count: number;
}

type MessageHandler = (data: MutationEvent) => void;
type PresenceHandler = (users: PresenceUser[]) => void;
type StateHandler = (state: ConnectionState) => void;

interface InternalMessage {
  type: string;
  channel?: string;
  room?: string;
  data?: unknown;
  users?: PresenceUser[];
  count?: number;
  clientId?: string;
  userId?: string | null;
  message?: string;
  timestamp?: number;
}

export class KitsudenRealtime {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private clientId: string | null = null;
  private userId: string | null = null;

  /** Get the server-assigned client ID */
  getClientId(): string | null {
    return this.clientId;
  }

  /** Get the authenticated user ID (if any) */
  getUserId(): string | null {
    return this.userId;
  }

  // Subscriptions
  private channelHandlers = new Map<string, Set<MessageHandler>>();
  private presenceHandlers = new Map<string, Set<PresenceHandler>>();
  private stateHandlers = new Set<StateHandler>();

  // Reconnection
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending subscriptions (to restore after reconnect)
  private pendingChannels = new Set<string>();
  private pendingRooms = new Set<string>();

  // Heartbeat
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pingTimeout = 30000;

  constructor(url: string) {
    this.url = url;
  }

  // ═══════════════════════════════════════════════════════════
  // Connection Management
  // ═══════════════════════════════════════════════════════════

  /**
   * Connect to the WebSocket server.
   * Returns a promise that resolves when connected.
   */
  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") {
      return;
    }

    return new Promise((resolve, reject) => {
      this.setState("connecting");

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          // Wait for "connected" message from server
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data as string);

          // Resolve promise on first connection
          if (this.state === "connecting") {
            this.setState("connected");
            this.resubscribe();
            resolve();
          }
        };

        this.ws.onclose = () => {
          this.stopHeartbeat();
          if (this.state !== "disconnected") {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (_error: Event) => {
          console.error("[KitsudenRealtime] WebSocket error");
          if (this.state === "connecting") {
            reject(new Error("Failed to connect"));
          }
        };
      } catch (err) {
        this.setState("disconnected");
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect(): void {
    this.setState("disconnected");
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.clientId = null;
    this.userId = null;
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Listen for connection state changes.
   */
  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Channel Subscriptions (Live Queries)
  // ═══════════════════════════════════════════════════════════

  /**
   * Subscribe to a channel for live updates.
   *
   * @param channel Channel name (e.g., "table:datasetId" or "entry:entryId")
   * @param handler Callback for mutation events
   * @returns Unsubscribe function
   */
  subscribe(channel: string, handler: MessageHandler): () => void {
    // Track handler
    if (!this.channelHandlers.has(channel)) {
      this.channelHandlers.set(channel, new Set());
    }
    const handlers = this.channelHandlers.get(channel)!;
    handlers.add(handler);

    // Track for reconnection
    this.pendingChannels.add(channel);

    // Send subscription request if connected
    if (this.state === "connected") {
      this.send({ type: "subscribe", channel });
    }

    // Return unsubscribe function
    return () => {
      const h = this.channelHandlers.get(channel);
      if (h) {
        h.delete(handler);
        if (h.size === 0) {
          this.channelHandlers.delete(channel);
          this.pendingChannels.delete(channel);
          if (this.state === "connected") {
            this.send({ type: "unsubscribe", channel });
          }
        }
      }
    };
  }

  /**
   * Convenience method to subscribe to a dataset's changes.
   */
  subscribeToDataset(datasetId: string, handler: MessageHandler): () => void {
    return this.subscribe(`table:${datasetId}`, handler);
  }

  /**
   * Convenience method to subscribe to a single entry's changes.
   */
  subscribeToEntry(entryId: string, handler: MessageHandler): () => void {
    return this.subscribe(`entry:${entryId}`, handler);
  }

  // ═══════════════════════════════════════════════════════════
  // Presence
  // ═══════════════════════════════════════════════════════════

  /**
   * Join a presence room to track who's online.
   */
  joinRoom(room: string): void {
    this.pendingRooms.add(room);
    if (this.state === "connected") {
      this.send({ type: "presence:join", room });
    }
  }

  /**
   * Leave a presence room.
   */
  leaveRoom(room: string): void {
    this.pendingRooms.delete(room);
    this.presenceHandlers.delete(room);
    if (this.state === "connected") {
      this.send({ type: "presence:leave", room });
    }
  }

  /**
   * Listen for presence updates in a room.
   */
  onPresence(room: string, handler: PresenceHandler): () => void {
    if (!this.presenceHandlers.has(room)) {
      this.presenceHandlers.set(room, new Set());
    }
    const handlers = this.presenceHandlers.get(room)!;
    handlers.add(handler);

    return () => {
      const h = this.presenceHandlers.get(room);
      if (h) {
        h.delete(handler);
        if (h.size === 0) {
          this.presenceHandlers.delete(room);
        }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Internal Methods
  // ═══════════════════════════════════════════════════════════

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // ignore handler errors
      }
    }
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(raw: string): void {
    let msg: InternalMessage;
    try {
      msg = JSON.parse(raw) as InternalMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "connected":
        this.clientId = msg.clientId ?? null;
        this.userId = msg.userId ?? null;
        break;

      case "message":
        if (msg.channel && msg.data) {
          const handlers = this.channelHandlers.get(msg.channel);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(msg.data as MutationEvent);
              } catch {
                // ignore handler errors
              }
            }
          }
        }
        break;

      case "presence":
        if (msg.room && msg.users) {
          const handlers = this.presenceHandlers.get(msg.room);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(msg.users);
              } catch {
                // ignore handler errors
              }
            }
          }
        }
        break;

      case "subscribed":
      case "unsubscribed":
        // Acknowledgments — could track pending state
        break;

      case "pong":
        // Heartbeat response
        break;

      case "error":
        console.warn("[KitsudenRealtime] Server error:", msg.message);
        break;
    }
  }

  private resubscribe(): void {
    // Restore channel subscriptions
    for (const channel of this.pendingChannels) {
      this.send({ type: "subscribe", channel });
    }

    // Restore presence rooms
    for (const room of this.pendingRooms) {
      this.send({ type: "presence:join", room });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState("disconnected");
      console.error("[KitsudenRealtime] Max reconnection attempts reached");
      return;
    }

    this.setState("reconnecting");
    this.reconnectAttempts++;

    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.log(
      `[KitsudenRealtime] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Will retry via onclose
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, this.pingTimeout);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════

/**
 * Create a KitsudenRealtime instance with sensible defaults.
 *
 * @param baseUrl Base URL of the Kitsuden API (e.g., "http://localhost:3000")
 */
export function createRealtime(baseUrl: string): KitsudenRealtime {
  const wsUrl =
    baseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "") + "/api/realtime";

  return new KitsudenRealtime(wsUrl);
}
