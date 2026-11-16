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
 * This module has no imports on purpose: realtime.ts, the wiring and
 * kon-setup.ts all read it, and none of them may import the others.
 */

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

const authorizers = new Map<string, KonChannelAuthorizer>();

/** The namespace of a kon: `kon-koe` and `koe` are both `koe`. */
export function konChannelShortId(konId: string): string {
  return konId.replace(/^kon-/, "");
}

/** The full channel name for a kon's `<rest>` (what a kon broadcasts to). */
export function konChannel(konId: string, rest: string): string {
  return `kon:${konChannelShortId(konId)}:${rest}`;
}

/** Registers (or replaces) the authorizer of a kon's namespace. */
export function registerKonChannels(konId: string, authorize: KonChannelAuthorizer): void {
  authorizers.set(konChannelShortId(konId), authorize);
}

/** Forgets a kon's authorizer (the kon was disabled; tests). */
export function unregisterKonChannels(konId: string): void {
  authorizers.delete(konChannelShortId(konId));
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
  const authorize = authorizers.get(match[1]!);
  if (!authorize) return false;
  try {
    return (await authorize(match[2]!, user)) === true;
  } catch (err: unknown) {
    console.warn(
      `  🔒 [WS] the authorizer of kon:${match[1]} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}
