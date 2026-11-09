/**
 * In production, a 5xx does not tell non-admins what failed internally.
 * ============================================================================
 *
 * `app.onError` already hides the detail of exceptions. But dozens of
 * handlers catch the error themselves and respond
 * `c.json({ error, message: (error as Error).message }, 500)`, and the message of
 * a Drizzle failure carries the entire SQL query with its parameters (tables,
 * columns, sometimes the email that had just been sent). Audit 2026-10-15:
 * `POST /api/datasets/:id/query`, accessible to any account, did this.
 *
 * Fixing them one by one leaves out the next one that gets written; this is the
 * safety net: after the handler, if the response is a 5xx in JSON, the environment is
 * production and the asker is not admin (nor an agent with `admin` scope),
 * the body is replaced by a generic one with the `requestId` to look it up in
 * the log. The admin still sees the detail: they debug from the panel.
 */
import { createMiddleware } from "hono/factory";

export function shouldHideDetail(params: {
  status: number;
  isJson: boolean;
  inProduction: boolean;
  isAdmin: boolean;
}): boolean {
  return params.inProduction && params.status >= 500 && params.isJson && !params.isAdmin;
}

export function errorsWithoutDetail(inProduction: () => boolean) {
  return createMiddleware(async (c, next) => {
    await next();
    // Health already filters its detail (`healthDetail`) and its body is read by
    // monitors even when it responds 503.
    if (c.req.path.startsWith("/api/health")) return;
    const res = c.res;
    const get = c.get as (k: string) => unknown;
    const user = get("user") as { role?: string } | null | undefined;
    const agent = get("agent") as { scopes?: string[] } | undefined;
    const isAdmin = user?.role === "admin" || agent?.scopes?.includes("admin") === true;
    if (
      !shouldHideDetail({
        status: res.status,
        isJson: (res.headers.get("content-type") ?? "").includes("application/json"),
        inProduction: inProduction(),
        isAdmin,
      })
    ) {
      return;
    }
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    c.res = new Response(
      JSON.stringify({
        error: res.status === 503 ? "Service Unavailable" : "Internal Server Error",
        requestId: get("requestId") ?? null,
      }),
      { status: res.status, headers }
    );
  });
}
