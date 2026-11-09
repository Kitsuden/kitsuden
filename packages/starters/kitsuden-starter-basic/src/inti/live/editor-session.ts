/**
 * Is this request from a Kitsuden editor?
 * ============================================================================
 *
 * Only with INTI=true. Inti has no users of its own: outside development it
 * opens the editor only to whoever a plugin with `resolveActor` identifies.
 * This is that plugin for Kitsuden.
 *
 * The rule: forward the visitor's better-auth session cookie, as is, to
 * `GET <KITSUDEN_API_URL>/api/auth/get-session`; it counts only when the API
 * answers 200 with a user whose role is `admin` or `editor`. The site cannot
 * validate the cookie itself, so it never decides anything from it.
 *
 *   · No session cookie → no request to the API at all.
 *   · Only better-auth cookies travel, not every cookie of the browser.
 *   · Any failure (API down, odd answer, timeout) → not an editor.
 *   · One question per request (`perRequest`): the page, the toolbar and the
 *     actions all ask for the same actor.
 *
 * The cookie only reaches this site if the browser sends it here: the site
 * and the API must share the host (localhost on any port in development) or
 * a parent domain. See README → "Visual editing with Inti".
 */

export const EDITOR_ROLES = ["admin", "editor"] as const;

export interface KitsudenEditor {
  id: string;
  role: string;
  email?: string;
  name?: string;
}

const SESSION_COOKIE = /^(?:__Secure-|__Host-)?better-auth\.[A-Za-z0-9_.-]+$/;
const SESSION_TOKEN = /^(?:__Secure-|__Host-)?better-auth\.session_token=/;

/** The better-auth cookies of a `Cookie` header, or "" if there is no session token */
export function sessionCookies(header: string | null | undefined): string {
  if (!header) return "";
  const own = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      return eq > 0 && SESSION_COOKIE.test(part.slice(0, eq)) && part.length > eq + 1;
    });
  return own.some((part) => SESSION_TOKEN.test(part)) ? own.join("; ") : "";
}

/** The `get-session` body reduced to an editor, or `null` */
export function editorFromSession(body: unknown): KitsudenEditor | null {
  const user = (body as { user?: unknown } | null)?.user;
  if (!user || typeof user !== "object") return null;
  const { id, role, email, name } = user as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (typeof role !== "string" || !(EDITOR_ROLES as readonly string[]).includes(role)) return null;
  return {
    id,
    role,
    ...(typeof email === "string" ? { email } : {}),
    ...(typeof name === "string" ? { name } : {}),
  };
}

export async function resolveEditor(
  cookieHeader: string | null | undefined,
  {
    api,
    fetch: doFetch = fetch,
    timeoutMs = 3000,
  }: { api: string; fetch?: typeof fetch; timeoutMs?: number }
): Promise<KitsudenEditor | null> {
  const cookie = sessionCookies(cookieHeader);
  if (!cookie) return null;
  const base = api.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  try {
    const res = await doFetch(`${base}/api/auth/get-session`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200 ? editorFromSession(await res.json()) : null;
  } catch {
    return null;
  }
}

export function perRequest(
  resolver: (cookie: string | null) => Promise<KitsudenEditor | null>
): (request: Request | undefined) => Promise<KitsudenEditor | null> {
  const seen = new WeakMap<Request, Promise<KitsudenEditor | null>>();
  return (request) => {
    if (!request) return Promise.resolve(null);
    let pending = seen.get(request);
    if (!pending) {
      pending = resolver(request.headers.get("cookie"));
      seen.set(request, pending);
    }
    return pending;
  };
}

interface IntiContext {
  operation: string;
  request?: Request;
  actor?: KitsudenEditor | null;
}

/**
 * The Inti plugin: identifies the editor AND refuses any write without one.
 *
 * The second part matters: for Inti, a registered `resolveActor` is enough to
 * consider writes "guarded", but `resolveActor` returning `null` does not
 * stop them. Without `beforeWrite`, an anonymous POST to
 * `/_actions/inti.updateBlockField` would write with the server's agent key.
 */
export function kitsudenEditorPlugin(
  resolver: (request: Request | undefined) => Promise<KitsudenEditor | null>
) {
  return {
    name: "kitsuden-starter:editor",
    resolveActor: (ctx: IntiContext) => resolver(ctx.request),
    beforeWrite: async (ctx: IntiContext) => {
      const actor = ctx.actor ?? (await resolver(ctx.request));
      return actor && (EDITOR_ROLES as readonly string[]).includes(actor.role)
        ? { allowed: true }
        : { allowed: false, reason: "A Kitsuden session with role admin or editor is required." };
    },
  };
}
