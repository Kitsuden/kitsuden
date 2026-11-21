/**
 * Realtime channels a kon owns: `kon:<short id>:<rest>`
 * ============================================================================
 *
 * Until now a socket could only subscribe to `table:`, `entry:` and `content:`
 * channels, and every channel without a dataset policy was admin-only. A kon
 * with its own notion of who may listen (an inbox where an agent sees their
 * team's conversations, a visitor who sees only their own chat) had no way in.
 *
 * A kon now declares one authorizer for its namespace through
 * `ctx.realtime.channels(authorize)`. The namespace is derived from the kon's
 * id (`kon-koe` → `kon:koe:`), and the context each kon receives is bound to
 * its own id (lib/kon-setup.ts), so a kon cannot authorize another kon's
 * channels.
 *
 *   - Subscribing to `kon:<short>:<rest>` calls the kon's authorizer with
 *     `<rest>` and the socket's user (`id: null` for an anonymous socket).
 *     Without an authorizer the channel is denied, admins included: nobody
 *     but the kon knows what the channel carries.
 *   - The authorizer runs again on every periodic sweep (every minute), so
 *     access the kon revokes (a reassigned conversation) stops within it.
 *   - An authorizer that throws denies.
 *
 * Capability channels. A channel a kon authorizes for whoever names it (a web
 * chat visitor, who has no account) is only as private as its name. If that
 * name is something the kon also stores where staff can read it (kon-koe used
 * the visitor hash it keeps as the contact's identity), anyone who once read it
 * keeps listening for ever, after their access is gone. `konCapability`
 * (`ctx.realtime.capability(material)`) turns a value into a channel part
 * keyed by this installation's secret: the kon broadcasts on it and hands it
 * only to whoever proves the original secret, and a value copied from the
 * kon's tables does not let anyone compute it.
 *
 * This module imports nothing but node:crypto on purpose: realtime.ts, the
 * wiring and kon-setup.ts all read it, and none of them may import the others.
 */
import { createHmac } from "node:crypto";

export interface KonChannelUser {
  id: string | null;
  role: string | null;
}

export type KonChannelAuthorizer = (
  rest: string,
  user: KonChannelUser
) => boolean | Promise<boolean>;

/** `kon:<short>:<rest>`: the short id of a kon, then the kon's own part. */
export const KON_CHANNEL = /^kon:([a-z0-9][a-z0-9-]{0,39}):([a-zA-Z0-9_.:-]{1,200})$/;

/** Short id → the kon that registered it, the context it came from, and its authorizer. */
const authorizers = new Map<
  string,
  { konId: string; owner: object | undefined; authorize: KonChannelAuthorizer }
>();

/**
 * Whether a kon is switched on right now (lib/realtime-wiring.ts plugs in
 * `konSwitchedOff`). A kon disabled from the panel keeps its authorizer in
 * memory until the restart; without this gate its channels stayed open (H18).
 */
export type KonChannelGate = (konId: string) => boolean | Promise<boolean>;
let gate: KonChannelGate | null = null;

export function setKonChannelGate(next: KonChannelGate | null): void {
  gate = next;
}

/** The namespace of a kon: `kon-koe` and `koe` are both `koe`. */
export function konChannelShortId(konId: string): string {
  return konId.replace(/^kon-/, "");
}

/** The full channel name for a kon's `<rest>` (what a kon broadcasts to). */
export function konChannel(konId: string, rest: string): string {
  return `kon:${konChannelShortId(konId)}:${rest}`;
}

/**
 * Registers (or replaces) the authorizer of a kon's namespace. `owner` is the
 * bound context the call came through (lib/kon-setup.ts): the same kon may
 * register again, but a second kon loaded with the same short id (`koe` from
 * a grimoire and `kon-koe` from npm) throws instead of silently taking over
 * the first one's channels (H18).
 */
export function registerKonChannels(
  konId: string,
  authorize: KonChannelAuthorizer,
  owner?: object
): void {
  const short = konChannelShortId(konId);
  const holder = authorizers.get(short);
  if (holder && owner && holder.owner && holder.owner !== owner) {
    throw new Error(
      `${konId} cannot register realtime channels kon:${short}:, which another loaded ${holder.konId} already holds`
    );
  }
  authorizers.set(short, { konId, owner, authorize });
}

/** Forgets a kon's authorizer (the kon was disabled; tests). */
export function unregisterKonChannels(konId: string): void {
  authorizers.delete(konChannelShortId(konId));
}

/** Namespaces the core broadcasts in, or that reach users directly: never a kon's. */
const CORE_CHANNEL_NAMESPACES = new Set(["table", "entry", "content", "kon", "user", "presence"]);

/**
 * Whether a kon may broadcast on `channel` through its context (H19): its own
 * `kon:<short>:` channels, or the older `<short>:` ones (kon-blog's
 * `blog:post:<id>`). A kon broadcasting on `table:` or `entry:` forged change
 * events that subscribers' row filters took for the core's; on another kon's
 * `kon:` channel it spoke to that kon's clients as that kon.
 */
export function konMayBroadcast(konId: string, channel: unknown): boolean {
  if (typeof channel !== "string" || channel.length > 300) return false;
  const short = konChannelShortId(konId);
  if (channel.startsWith(`kon:${short}:`)) return isKonChannel(channel);
  const at = channel.indexOf(":");
  if (at <= 0) return false;
  const namespace = channel.slice(0, at);
  return namespace === short && !CORE_CHANNEL_NAMESPACES.has(namespace);
}

export function isKonChannel(channel: string): boolean {
  return KON_CHANNEL.test(channel);
}

/**
 * Whether this user may listen to a kon channel. `false` for a malformed
 * channel, a namespace nobody registered, or an authorizer that throws.
 */
export async function authorizeKonChannel(channel: string, user: KonChannelUser): Promise<boolean> {
  const match = KON_CHANNEL.exec(channel);
  if (!match) return false;
  const holder = authorizers.get(match[1]!);
  if (!holder) return false;
  try {
    // A kon switched off since startup answers for nothing, as its routes answer 404.
    if (gate && (await gate(holder.konId)) !== true) return false;
    return (await holder.authorize(match[2]!, user)) === true;
  } catch (err: unknown) {
    console.warn(
      `  🔒 [WS] the authorizer of kon:${match[1]} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

function capabilityKey(env: NodeJS.ProcessEnv): string {
  const raw = env.KITSUDEN_SECRETS_KEY || env.BETTER_AUTH_SECRET || "";
  if (raw.length < 16)
    throw new Error(
      "A realtime capability channel needs KITSUDEN_SECRETS_KEY (or BETTER_AUTH_SECRET)"
    );
  return raw;
}

/**
 * A channel part (64 hex characters) for `material`, keyed by the installation's secret and the kon: the same
 * material gives the same part, another kon or another installation a different one, and nobody without the
 * server key can compute it from the material. Bound to the kon's id in its context, so a kon cannot compute
 * another kon's parts.
 */
export function konCapability(konId: string, material: string, env = process.env): string {
  if (!material) throw new Error("A realtime capability needs a non-empty material");
  const key = createHmac("sha256", capabilityKey(env))
    .update("kitsuden:realtime-capability:v1")
    .digest();
  return createHmac("sha256", key)
    .update(`${konChannelShortId(konId)}\n${material}`)
    .digest("hex");
}
