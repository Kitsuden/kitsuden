/**
 * Agent Authentication Service — Unit Tests
 *
 * Covers pure logic and middleware in agent-auth.ts with mocked DB.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

import { createMockContext, getLastJsonResponse } from "../tests/mock-context";

// ─── Configurable DB proxy ──────────────────────────────────────────────────
let selectResult: any[] = [];
let insertResult: any[] = [];
let updateResult: any[] = [];
let deleteResult: any[] = [];

function createDbProxy(result: any): any {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: any) => resolve(result);
      }
      return createDbProxy(result);
    },
    apply(_target, _thisArg, _args) {
      return createDbProxy(result);
    },
  });
}

const mockDb = {
  select: mock(() => createDbProxy(selectResult)),
  insert: mock(() => createDbProxy(insertResult)),
  update: mock(() => createDbProxy(updateResult)),
  delete: mock(() => createDbProxy(deleteResult)),
};

// ─── Mocks must be declared BEFORE imports ──────────────────────────────────
mock.module("../db", () => ({
  mergedSchema: {},
  db: mockDb,
}));
mock.module("../db/schema", () => ({
  agentIdentities: {
    id: "id",
    name: "name",
    isActive: "isActive",
    rateLimit: "rateLimit",
    scopes: "scopes",
    capabilities: "capabilities",
    allowedTools: "allowedTools",
    systemPrompt: "systemPrompt",
    description: "description",
    type: "type",
    createdAt: "createdAt",
  },
  agentApiKeys: {
    id: "id",
    agentId: "agentId",
    keyId: "keyId",
    keyHash: "keyHash",
    keyPrefix: "keyPrefix",
    algorithm: "algorithm",
    expiresAt: "expiresAt",
    lastUsedAt: "lastUsedAt",
    createdAt: "createdAt",
  },
}));
// NOTE: we do NOT mock "drizzle-orm". bun's `mock.module` patches the module
// registry GLOBALLY and irreversibly: stubbing `sql` as `() => "sql"`
// removed `sql.raw` from ALL the other test files (it broke rls-builder).
// The `db` mocked above ignores the SQL it is given, so the real `eq`/`and`/
// `sql` work perfectly well here (bun's mock.module leaks across files).
mock.module("../utils/id-generator", () => ({
  generateAgentApiKey: mock(() => ({
    plainKey: "kitsuden_agent_claude-desktop_1234567890abcdef_secretpart",
    keyHash: "$argon2id$v=19$m=65536,t=3,p=4$c29tZWhhc2h2YWx1ZXNvbWVoYXNodmFsdWVzb21laGFzaA",
    keyId: "1234567890abcdef",
    algorithm: "argon2id",
    keyPrefix: "kitsuden_agent_claude-desktop_****cdef",
  })),
  AGENT_TYPES: {},
  getAgentTypeFromApiKey: mock(() => "claude-desktop"),
}));
mock.module("@node-rs/argon2", () => ({
  verify: mock(() => Promise.resolve(true)),
  hash: mock(() => Promise.resolve("$argon2id$hash")),
}));
mock.module("./agent-audit", () => ({
  logAuthSuccess: mock(() => {}),
  logAuthFailure: mock(() => {}),
  logRateLimited: mock(() => {}),
}));

// ─── Import the module under test ───────────────────────────────────────────
import {
  generateAgentApiKey,
  hashApiKeyLegacy,
  authenticateAgent,
  hasScope,
  hasAllScopes,
  hasAnyScope,
  cleanupRateLimitCache,
  requireAgentAuth,
  optionalAgentAuth,
  createAgent,
  revokeApiKey,
  deactivateAgent,
  listAgents,
} from "../services/agent-auth";

afterAll(() => mock.restore());

const originalDateNow = Date.now;

function resetRateLimitCache() {
  Date.now = () => 0;
  cleanupRateLimitCache();
  Date.now = originalDateNow;
}

beforeEach(() => {
  selectResult = [];
  insertResult = [];
  updateResult = [];
  deleteResult = [];
  resetRateLimitCache();
});

// ═════════════════════════════════════════════════════════════════════════════
// KEY GENERATION
// ═════════════════════════════════════════════════════════════════════════════

describe("generateAgentApiKey", () => {
  it("delegates to typed generator when type is provided", async () => {
    const result = await generateAgentApiKey("claude-desktop");
    expect(result.plainKey).toBe("kitsuden_agent_claude-desktop_1234567890abcdef_secretpart");
    expect(result.keyHash.length).toBeGreaterThan(64);
    expect(result.keyId.length).toBe(16);
    expect(result.algorithm).toBe("argon2id");
  });

  it("generates fallback key without type", async () => {
    const result = await generateAgentApiKey();
    expect(result.plainKey.startsWith("kitsuden_agent_")).toBe(true);
    expect(result.keyHash.length).toBeGreaterThan(64);
    expect(result.keyId.length).toBe(16);
    expect(result.algorithm).toBe("argon2id");
  });
});

describe("hashApiKeyLegacy", () => {
  it("returns SHA-256 hex digest", () => {
    const expected = require("crypto").createHash("sha256").update("my-key").digest("hex");
    expect(hashApiKeyLegacy("my-key")).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTHENTICATE AGENT
// ═════════════════════════════════════════════════════════════════════════════

describe("authenticateAgent", () => {
  it("rejects invalid key format", async () => {
    const result = await authenticateAgent("bad-key");
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_KEY_FORMAT");
  });

  it("rejects unknown or expired key", async () => {
    selectResult = [];
    const result = await authenticateAgent(
      "kitsuden_agent_test_1234567890123456789012345678901234567890123456789012345678"
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("INVALID_KEY");
  });

  it("rejects deactivated agent", async () => {
    selectResult = [
      {
        id: "k1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: false,
        rateLimit: 60,
        scopes: [],
      },
    ];
    const result = await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");
    expect(result.success).toBe(false);
    expect(result.code).toBe("AGENT_DEACTIVATED");
  });

  // The per-minute limit is NO LONGER counted on authentication (it was counted twice
  // per MCP message and answered 401). lib/agent-quotas.ts counts it,
  // once, with 429 (see src/tests/fine-grained-agent-permissions.test.ts).
  it("does not count the per-minute limit on authentication (the quotas do)", async () => {
    selectResult = [
      {
        id: "k1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 1,
        scopes: [],
      },
    ];
    const r1 = await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");
    expect(r1.success).toBe(true);

    const r2 = await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");
    expect(r2.success).toBe(true);
    expect(r2.context?.rateLimit).toBe(1);
  });

  it("returns context on success", async () => {
    selectResult = [
      {
        id: "a1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 60,
        scopes: ["read"],
      },
    ];
    const result = await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");
    expect(result.success).toBe(true);
    expect(result.context?.agentId).toBe("a1");
    expect(result.context?.agentName).toBe("Test");
    expect(result.context?.scopes).toEqual(["read"]);
    expect(result.context?.rateLimit).toBe(60);
    expect(result.context?.keyId).toBe("a1");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SCOPE CHECKING
// ═════════════════════════════════════════════════════════════════════════════

describe("hasScope", () => {
  const ctx = (scopes: string[]) =>
    ({
      agentId: "a1",
      agentName: "Test",
      scopes,
      rateLimit: 60,
      keyId: "k1",
    }) as any;

  it("exact match", () => {
    expect(hasScope(ctx(["read:users"]), "read:users")).toBe(true);
  });

  it("admin super-scope", () => {
    expect(hasScope(ctx(["admin"]), "any:thing")).toBe(true);
  });

  it("admin:* wildcard", () => {
    expect(hasScope(ctx(["admin:*"]), "admin:users")).toBe(true);
  });

  it("resource wildcard read:*", () => {
    expect(hasScope(ctx(["read:*"]), "read:posts")).toBe(true);
  });

  it("action wildcard *:users", () => {
    expect(hasScope(ctx(["*:users"]), "write:users")).toBe(true);
  });

  it("no match", () => {
    expect(hasScope(ctx(["read:users"]), "write:users")).toBe(false);
  });

  it("empty scopes", () => {
    expect(hasScope(ctx([]), "read:users")).toBe(false);
  });
});

describe("hasAllScopes", () => {
  const ctx = (scopes: string[]) =>
    ({
      agentId: "a1",
      agentName: "Test",
      scopes,
      rateLimit: 60,
      keyId: "k1",
    }) as any;

  it("requires every scope", () => {
    expect(hasAllScopes(ctx(["read", "write"]), ["read", "write"])).toBe(true);
    expect(hasAllScopes(ctx(["read"]), ["read", "write"])).toBe(false);
  });
});

describe("hasAnyScope", () => {
  const ctx = (scopes: string[]) =>
    ({
      agentId: "a1",
      agentName: "Test",
      scopes,
      rateLimit: 60,
      keyId: "k1",
    }) as any;

  it("requires at least one scope", () => {
    expect(hasAnyScope(ctx(["read", "write"]), ["admin"])).toBe(false);
    expect(hasAnyScope(ctx(["read", "write"]), ["read"])).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RATE LIMIT CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

describe("cleanupRateLimitCache", () => {
  it("removes expired entries", async () => {
    selectResult = [
      {
        id: "k1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 1,
        scopes: [],
      },
    ];
    await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");

    // Expire the window artificially
    Date.now = () => originalDateNow() + 2 * 60 * 1000;
    cleanupRateLimitCache();
    Date.now = originalDateNow;

    // After cleanup the agent should be allowed again
    const after = await authenticateAgent("kitsuden_agent_test_1234567890abcdef_secretpart");
    expect(after.success).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═════════════════════════════════════════════════════════════════════════════

describe("requireAgentAuth middleware", () => {
  const next = mock(() => Promise.resolve());

  beforeEach(() => {
    next.mockReset?.();
  });

  it("401 when Authorization header is missing", async () => {
    const c = createMockContext();
    const middleware = requireAgentAuth();
    await middleware(c, next);
    const res = getLastJsonResponse(c);
    expect(res.status).toBe(401);
    expect(res.data.code).toBe("MISSING_AUTH");
    expect(next.mock.calls.length).toBe(0);
  });

  it("401 for invalid auth format", async () => {
    const c = createMockContext({ headers: { Authorization: "Basic abc" } });
    const middleware = requireAgentAuth();
    await middleware(c, next);
    const res = getLastJsonResponse(c);
    expect(res.status).toBe(401);
    expect(res.data.code).toBe("INVALID_AUTH_FORMAT");
  });

  it("401 when API key is invalid", async () => {
    selectResult = [];
    const c = createMockContext({
      headers: { Authorization: "Bearer kitsuden_agent_test_1234567890abcdef_secretpart" },
    });
    const middleware = requireAgentAuth();
    await middleware(c, next);
    const res = getLastJsonResponse(c);
    expect(res.status).toBe(401);
    expect(res.data.code).toBe("INVALID_KEY");
  });

  it("403 when required scope is missing", async () => {
    selectResult = [
      {
        id: "k1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 60,
        scopes: ["read"],
      },
    ];
    const c = createMockContext({
      headers: { Authorization: "Bearer kitsuden_agent_test_1234567890abcdef_secretpart" },
    });
    const middleware = requireAgentAuth({ scopes: ["admin"] });
    await middleware(c, next);
    const res = getLastJsonResponse(c);
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("FORBIDDEN");
  });

  it("calls next and sets agent context on success", async () => {
    selectResult = [
      {
        id: "a1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 60,
        scopes: ["read"],
      },
    ];
    const c = createMockContext({
      headers: { Authorization: "Bearer kitsuden_agent_test_1234567890abcdef_secretpart" },
    });
    const middleware = requireAgentAuth({ scopes: ["read"] });
    await middleware(c, next);
    expect(getLastJsonResponse(c)).toBeUndefined();
    expect(c.get("agent")?.agentId).toBe("a1");
    expect(next.mock.calls.length).toBe(1);
  });
});

describe("optionalAgentAuth middleware", () => {
  const next = mock(() => Promise.resolve());

  beforeEach(() => {
    next.mockReset?.();
  });

  it("calls next without agent when no header", async () => {
    const c = createMockContext();
    const middleware = optionalAgentAuth();
    await middleware(c, next);
    expect(c.get("agent")).toBeUndefined();
    expect(next.mock.calls.length).toBe(1);
  });

  it("calls next without agent when key is invalid", async () => {
    selectResult = [];
    const c = createMockContext({
      headers: { Authorization: "Bearer kitsuden_agent_test_1234567890abcdef_secretpart" },
    });
    const middleware = optionalAgentAuth();
    await middleware(c, next);
    expect(c.get("agent")).toBeUndefined();
    expect(next.mock.calls.length).toBe(1);
  });

  it("sets agent when key is valid", async () => {
    selectResult = [
      {
        id: "a1",
        agentId: "a1",
        keyHash: "$argon2id$v=19$m=65536,t=3,p=4$valid",
        algorithm: "argon2id",
        keyPrefix: "kitsuden_agent_test_****cdef",
        name: "Test",
        isActive: true,
        rateLimit: 60,
        scopes: ["read"],
      },
    ];
    const c = createMockContext({
      headers: { Authorization: "Bearer kitsuden_agent_test_1234567890abcdef_secretpart" },
    });
    const middleware = optionalAgentAuth();
    await middleware(c, next);
    expect(c.get("agent")?.agentId).toBe("a1");
    expect(next.mock.calls.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("createAgent", () => {
  it("creates agent with API key", async () => {
    insertResult = [
      {
        id: "agent-1",
        name: "Bot",
        type: "custom",
        capabilities: [],
        allowedTools: [],
        scopes: [],
        rateLimit: 60,
      },
    ];
    const result = await createAgent({ name: "Bot" });
    expect(result.agent.id).toBe("agent-1");
    expect(result.plainApiKey).toBe("kitsuden_agent_claude-desktop_1234567890abcdef_secretpart");
  });
});

describe("revokeApiKey", () => {
  it("executes without error", async () => {
    await revokeApiKey("key-1");
    expect(true).toBe(true);
  });
});

describe("deactivateAgent", () => {
  it("executes without error", async () => {
    await deactivateAgent("agent-1");
    expect(true).toBe(true);
  });
});

describe("listAgents", () => {
  it("returns agents with keys array", async () => {
    selectResult = [{ id: "agent-1", name: "Bot" }];
    const result = await listAgents();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("agent-1");
    expect(Array.isArray(result[0].keys)).toBe(true);
  });
});
