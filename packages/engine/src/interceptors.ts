/**
 * Kitsuden — Interceptors (reusable contract, NestJS style)
 * ============================================================================
 *
 * An Interceptor wraps the execution of a route with `before` / `after`
 * / `onError` hooks, and can TRANSFORM the JSON response (something a plain
 * Hono middleware does not do ergonomically). It is the NestJS pattern without decorators.
 *
 * "Onion" model: the `before` hooks run in order; the `after` hooks in REVERSE
 * order, wrapping the handler.
 *
 *   app.get("/posts",
 *     applyInterceptors(timingInterceptor(), responseEnvelope()),
 *     handler);
 *
 * Use cases: wrapping responses in { data }, measuring times, cache headers,
 * masking fields, auditing — in a composable and testable way.
 */

import type { Context, MiddlewareHandler } from "hono";

export interface InterceptorContext {
  c: Context;
  method: string;
  path: string;
}

export interface Interceptor {
  name: string;
  /** Before the handler. Returning a Response cuts the pipeline (short-circuit). */
  before?(ctx: InterceptorContext): void | Response | Promise<void | Response>;
  /** After the handler. It can transform the JSON body before sending it. */
  after?(ctx: InterceptorContext, body: unknown): unknown | Promise<unknown>;
  /** On error. It does not handle it (the composer rethrows it); it only observes/audits. */
  onError?(ctx: InterceptorContext, err: unknown): void | Promise<void>;
}

/**
 * Composes interceptors into a Hono middleware. `after` hooks that transform the body
 * only apply to `application/json` responses.
 */
export function applyInterceptors(...interceptors: Interceptor[]): MiddlewareHandler {
  return async (c, next) => {
    const ctx: InterceptorContext = { c, method: c.req.method, path: c.req.path };

    // before (in order). A Response cuts the pipeline.
    for (const it of interceptors) {
      if (it.before) {
        const short = await it.before(ctx);
        if (short instanceof Response) {
          c.res = short;
          return;
        }
      }
    }

    try {
      await next();
    } catch (err) {
      for (const it of interceptors) {
        if (it.onError) await it.onError(ctx, err);
      }
      throw err;
    }

    // Hono does not always rethrow from next(): it captures the error in c.error.
    // We observe onError anyway and let app.onError handle it.
    if (c.error) {
      for (const it of interceptors) {
        if (it.onError) await it.onError(ctx, c.error);
      }
      return;
    }

    // after (reverse order — onion model). It only transforms JSON.
    const hasAfter = interceptors.some((it) => it.after);
    if (!hasAfter) return;

    const contentType = c.res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return;

    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      return; // no era JSON parseable
    }

    let transformed = body;
    for (let i = interceptors.length - 1; i >= 0; i--) {
      const it = interceptors[i];
      if (it.after) transformed = await it.after(ctx, transformed);
    }

    if (transformed !== body) {
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(JSON.stringify(transformed), {
        status: c.res.status,
        headers,
      });
    }
  };
}

// ── Built-in interceptors ─────────────────────────────────────────────────────

/** Adds `X-Response-Time` (ms) to the response. */
export function timingInterceptor(): Interceptor {
  const starts = new WeakMap<Context, number>();
  return {
    name: "timing",
    before(ctx) {
      starts.set(ctx.c, Date.now());
    },
    after(ctx, body) {
      const start = starts.get(ctx.c);
      if (start) ctx.c.header("X-Response-Time", `${Date.now() - start}ms`);
      return body;
    },
  };
}

/**
 * Wraps the body in `{ data, meta }` consistently (opt-in per route).
 * If the body already carries `data`, it does not rewrap it (idempotent).
 */
export function responseEnvelope(meta: Record<string, unknown> = {}): Interceptor {
  return {
    name: "response-envelope",
    after(_ctx, body) {
      if (body && typeof body === "object" && "data" in (body as object)) return body;
      return { data: body, meta: { ...meta, ts: new Date().toISOString() } };
    },
  };
}

/** Sets `Cache-Control` on successful GET responses. */
export function cacheControl(seconds: number): Interceptor {
  return {
    name: "cache-control",
    after(ctx, body) {
      if (ctx.method === "GET" && ctx.c.res.status < 300) {
        ctx.c.header("Cache-Control", `public, max-age=${seconds}`);
      }
      return body;
    },
  };
}

/** Removes sensitive fields from the response body (defense in depth). */
export function maskFields(...fields: string[]): Interceptor {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (!fields.includes(k)) out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  return {
    name: "mask-fields",
    after(_ctx, body) {
      return strip(body);
    },
  };
}
