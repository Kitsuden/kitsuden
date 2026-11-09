/**
 * Hono Context Mock Helper
 *
 * Creates a minimal mock Hono context for testing route handlers directly.
 */

export interface MockContextOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  user?: Record<string, unknown>;
}

export function createMockContext(options: MockContextOptions = {}) {
  const { params = {}, query = {}, body = null, headers = {}, user } = options;
  const jsonResponses: Array<{ data: unknown; status?: number }> = [];
  const stored = new Map<string, unknown>();

  if (user) {
    stored.set("user", user);
  }

  const c = {
    req: {
      param: (name: string) => params[name] ?? undefined,
      query: (name: string) => query[name] ?? undefined,
      json: async () => body,
      header: (name: string) => headers[name] ?? undefined,
      raw: { headers: new Headers() },
    },
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    json: (data: unknown, status?: number) => {
      jsonResponses.push({ data, status });
      return new Response(JSON.stringify(data), { status: status ?? 200 });
    },
    body: (data: unknown, status?: number) => {
      return new Response(data as any, { status: status ?? 200 });
    },
    _jsonResponses: jsonResponses,
  } as any;

  return c;
}

export function getLastJsonResponse(c: any) {
  return c._jsonResponses[c._jsonResponses.length - 1];
}
