// @ts-nocheck
// Vitest Setup File
// Runs before all unit tests

import { vi } from "vitest";

import { installWhereGuard } from "./guard-drizzle-where";

// Second call to `.where()` on the same Drizzle builder → throws.
// Complements the text guard: that one has no shape holes, but it only
// sees the paths the tests execute. See guard-drizzle-where.ts.
installWhereGuard();

// Mock environment variables
process.env.NODE_ENV = "test";
// A placeholder: unit tests never connect. Port 1 is unreachable on purpose, because 5432 may be a
// real database on the machine running them.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:1/test";

// Global mocks
global.fetch = vi.fn();

// Cleanup after each test
// (handled by Vitest's isolate option)
