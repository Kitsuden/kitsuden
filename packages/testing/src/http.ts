/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HTTP TEST CLIENT - Make requests to kon routers
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Hono } from "hono";

import type { TestHttpClient, TestResponse, TestUser, TestKonContext, TestKon } from "./types.js";

interface RequestContext {
  user?: TestUser;
  token?: string;
  headers: Record<string, string>;
}

/**
 * Create HTTP test client for making requests to kons
 */
export function createTestHttpClient(
  kons: Record<string, TestKon>,
  _context: TestKonContext
): TestHttpClient {
  const requestContext: RequestContext = {
    headers: {},
  };

  // Combine all kon routers into one app
  const app = new Hono();

  for (const [id, kon] of Object.entries(kons)) {
    const mountPath = kon.definition.mountPath || `/api/${id.replace(/^kon-/, "")}`;
    app.route(mountPath, kon.router);
  }

  // Middleware to inject test context
  app.use("*", async (c, next) => {
    if (requestContext.user) {
      (c as any).set("user", requestContext.user);
      (c as any).set("testUser", requestContext.user);
    }
    if (requestContext.token) {
      (c as any).set("token", requestContext.token);
    }
    await next();
  });

  const client: TestHttpClient = {
    asUser: (userIdOrUser: string | TestUser) => {
      if (typeof userIdOrUser === "string") {
        // Look up user from fixtures or create mock
        requestContext.user = {
          id: userIdOrUser,
          email: `${userIdOrUser}@test.com`,
          name: `Test User ${userIdOrUser}`,
          role: "user",
        };
      } else {
        requestContext.user = userIdOrUser;
      }
      return client;
    },

    withToken: (token: string) => {
      requestContext.token = token;
      requestContext.headers["Authorization"] = `Bearer ${token}`;
      return client;
    },

    withHeaders: (headers: Record<string, string>) => {
      Object.assign(requestContext.headers, headers);
      return client;
    },

    get: async (path: string): Promise<TestResponse> => {
      return makeRequest(app, "GET", path, null, requestContext.headers);
    },

    post: async (path: string, body: any): Promise<TestResponse> => {
      return makeRequest(app, "POST", path, body, requestContext.headers);
    },

    patch: async (path: string, body: any): Promise<TestResponse> => {
      return makeRequest(app, "PATCH", path, body, requestContext.headers);
    },

    put: async (path: string, body: any): Promise<TestResponse> => {
      return makeRequest(app, "PUT", path, body, requestContext.headers);
    },

    delete: async (path: string): Promise<TestResponse> => {
      return makeRequest(app, "DELETE", path, null, requestContext.headers);
    },
  };

  return client;
}

/**
 * Execute a request against the Hono app
 */
async function makeRequest(
  app: Hono,
  method: string,
  path: string,
  body: any | null,
  headers: Record<string, string>
): Promise<TestResponse> {
  // Build request
  const url = new URL(path, "http://localhost");

  const requestInit: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body && method !== "GET") {
    requestInit.body = JSON.stringify(body);
  }

  const request = new Request(url.toString(), requestInit);

  // Execute request
  const response = await app.fetch(request);

  // Parse response
  const responseBody = await parseResponseBody(response);

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
    json: async () => responseBody,
    text: async () =>
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
  };
}

/**
 * Parse response body based on content type
 */
async function parseResponseBody(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  return await response.text();
}

export default { createTestHttpClient };
