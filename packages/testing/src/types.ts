/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TESTING FRAMEWORK TYPES - Minimalist Kon Testing
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { KonContext, KonDefinition } from "@kitsuden/shared";
import type { Hono } from "hono";

/** Configuration for test sandbox */
export interface SandboxConfig {
  /** Kons to load */
  kons: string[];

  /** Fixtures to load before tests */
  fixtures?: string | Record<string, any>;

  /** Database strategy */
  database?: "memory" | "transaction" | "postgres";

  /** Auto-cleanup between tests */
  autoReset?: boolean;
}

/** Test sandbox instance */
export interface TestSandbox {
  /** Unique sandbox ID */
  id: string;

  /** Full KonContext like in production */
  context: TestKonContext;

  /** Loaded kons with their routers */
  kons: Record<string, TestKon>;

  /** Fixture data */
  fixtures: Record<string, any>;

  /** HTTP test client */
  http: TestHttpClient;

  /** Database helpers */
  db: TestDatabase;

  /** Event tracking */
  events: TestEvents;

  /** Simple assertions */
  assert: TestAssertions;

  /** Lifecycle */
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
  reset: () => Promise<void>;
}

/** Simplified KonContext for testing */
export interface TestKonContext extends KonContext {
  /** Sandbox-specific metadata */
  sandboxId: string;
}

/** Loaded kon in test environment */
export interface TestKon {
  definition: KonDefinition;
  router: Hono;

  /** Direct access to kon's internal functions */
  invoke: <T>(method: string, ...args: any[]) => Promise<T>;
}

/** HTTP test client */
export interface TestHttpClient {
  /** Set authentication user */
  asUser: (userId: string | TestUser) => TestHttpClient;

  /** Set bearer token */
  withToken: (token: string) => TestHttpClient;

  /** Set headers */
  withHeaders: (headers: Record<string, string>) => TestHttpClient;

  /** HTTP methods */
  get: (path: string) => Promise<TestResponse>;
  post: (path: string, body: any) => Promise<TestResponse>;
  patch: (path: string, body: any) => Promise<TestResponse>;
  put: (path: string, body: any) => Promise<TestResponse>;
  delete: (path: string) => Promise<TestResponse>;
}

/** Test HTTP response */
export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: any;

  /** Helper to parse JSON */
  json: <T = any>() => Promise<T>;

  /** Helper to parse text */
  text: () => Promise<string>;
}

/** Test user for authentication */
export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: string;
  [key: string]: any;
}

/** Database helpers */
export interface TestDatabase {
  /** Check if row exists */
  has: (table: string, where: Record<string, any>) => Promise<boolean>;

  /** Get row by ID or conditions */
  get: (table: string, where: Record<string, any>) => Promise<any | null>;

  /** Count rows */
  count: (table: string, where?: Record<string, any>) => Promise<number>;

  /** Truncate tables */
  truncate: (...tables: string[]) => Promise<void>;

  /** Raw query */
  query: (sql: string, params?: any[]) => Promise<any[]>;

  /** Insert data */
  insert: (table: string, data: Record<string, any>) => Promise<any>;
}

/** Event tracking */
export interface TestEvents {
  /** All events emitted */
  all: Array<{ name: string; data: any; timestamp: Date }>;

  /** Check if event was emitted */
  wasEmitted: (name: string, data?: Record<string, any>) => boolean;

  /** Get last event by name */
  last: <T = any>(name: string) => { name: string; data: T; timestamp: Date } | undefined;

  /** Clear events */
  clear: () => void;
}

/** Simple assertions */
export interface TestAssertions {
  /** Database assertions */
  database: {
    has: (table: string, where: Record<string, any>, message?: string) => Promise<void>;
    missing: (table: string, where: Record<string, any>, message?: string) => Promise<void>;
    count: (
      table: string,
      expected: number,
      where?: Record<string, any>,
      message?: string
    ) => Promise<void>;
  };

  /** Event assertions */
  events: {
    emitted: (name: string, data?: Record<string, any>, message?: string) => void;
    notEmitted: (name: string, message?: string) => void;
  };
}

/** Fixture definition */
export interface Fixture {
  id: string;
  dependencies?: string[];
  setup: (ctx: TestKonContext) => Promise<Record<string, any>>;
  teardown?: (ctx: TestKonContext, data: Record<string, any>) => Promise<void>;
}
