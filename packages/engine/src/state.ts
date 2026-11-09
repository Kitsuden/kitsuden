/**
 * Synced State — live shared state between server, panel and graphic
 * ============================================================================
 *
 * The equivalent of NodeCG's "replicant", which is the primitive everything else
 * hangs from there: you declare a typed state, mutate it from anywhere, and
 * every subscribed client sees it instantly. It survives restarts.
 *
 * What this adds over NodeCG, which is exactly where NodeCG is weak:
 *
 *   - **Real, injectable persistence** — NodeCG writes a JSON to disk and
 *     assumes one machine. Here the store is a dependency: Postgres, Valkey or
 *     memory. Multi-process and multi-operator stop being a problem.
 *   - **Monotonic revision** — every change increments `revision`. A message
 *     that arrives late (WebSocket reconnection, bad network at a tournament) is
 *     discarded instead of overwriting a newer state. It is THE classic bug of
 *     live overlays.
 *   - **Named channel** (`state:<key>`) so that the existing subscription
 *     authorizer decides who can listen to what. NodeCG has no
 *     concept of permissions.
 *
 * Everything is injected and nothing throws: without a transport it keeps working in memory,
 * without a store it simply does not persist. An overlay must never go down because
 * Valkey went away.
 *
 *   const scoreboard = defineSyncedState("broadcast:match:42", {
 *     default: { a: 0, b: 0 },
 *   });
 *
 *   await scoreboard.patch({ a: 1 });      // broadcasts to all subscribers
 *   scoreboard.subscribe((v) => render(v));
 */

// ── Injectable contracts ─────────────────────────────────────────────────────

/** Broadcast to connected clients. Implemented by the host's realtime layer. */
export interface StateTransport {
  broadcast(channel: string, message: unknown): void;
}

/** Persistence. Postgres, Valkey or whatever — the primitive does not care. */
export interface StateStore {
  read(key: string): Promise<{ value: unknown; revision: number } | null>;
  write(key: string, value: unknown, revision: number): Promise<void>;
}

export interface SyncedStateOptions<T> {
  /** Initial value if nothing is persisted. */
  default: T;
  /**
   * Persist changes. Defaults to `true`.
   * Set it to `false` for ephemeral state (e.g. "who is watching this").
   */
  persist?: boolean;
  /**
   * Milliseconds to wait before writing to the store. Groups bursts — pressing
   * `+` five times in a row must not cause five writes.
   * Defaults to 250 ms. With 0 it writes immediately (useful in tests).
   */
  persistDebounceMs?: number;
  /**
   * Optional validator. If it throws, the change is rejected and the state is untouched:
   * that is preferable to broadcasting garbage to an overlay that is on air.
   */
  validate?: (value: unknown) => T;
}

/** Message that travels over the channel. The client applies it only if `revision` is greater. */
export interface SyncedStateMessage<T = unknown> {
  type: "state:sync";
  key: string;
  revision: number;
  value: T;
}

export type Unsubscribe = () => void;

// ── Global registry (process singleton) ──────────────────────────────────────

let transport: StateTransport | null = null;
let store: StateStore | null = null;
// `unknown` instead of `any`: the real type is recovered by `defineSyncedState`
// with an explicit cast at the point where it IS known.
const registry = new Map<string, SyncedState<unknown>>();

/** Called by the host at startup. Without it, the state works but does not broadcast. */
export function setStateTransport(t: StateTransport | null): void {
  transport = t;
}

/** Called by the host at startup. Without it, the state works but does not persist. */
export function setStateStore(s: StateStore | null): void {
  store = s;
}

/** Clears the entire registry. For tests. */
export function resetSyncedState(): void {
  for (const s of registry.values()) s.dispose();
  registry.clear();
  transport = null;
  store = null;
}

/** Channel name of a state. Public so the authorizer can match it. */
export function stateChannel(key: string): string {
  return `state:${key}`;
}

// ── The state ────────────────────────────────────────────────────────────────

export class SyncedState<T> {
  readonly key: string;
  readonly channel: string;

  private value: T;
  private rev = 0;
  private readonly opts: Required<Omit<SyncedStateOptions<T>, "validate">> &
    Pick<SyncedStateOptions<T>, "validate">;
  private readonly listeners = new Set<(value: T, revision: number) => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;

  constructor(key: string, options: SyncedStateOptions<T>) {
    this.key = key;
    this.channel = stateChannel(key);
    this.value = options.default;
    this.opts = {
      default: options.default,
      persist: options.persist ?? true,
      persistDebounceMs: options.persistDebounceMs ?? 250,
      validate: options.validate,
    };
  }

  /** Current in-memory value. Synchronous on purpose: an overlay renders per frame. */
  get(): T {
    return this.value;
  }

  /** Current revision. Monotonic within the process. */
  get revision(): number {
    return this.rev;
  }

  /**
   * Loads the persisted value. Idempotent: only the first call reads.
   * If the store fails, it keeps the default — an overlay must open anyway.
   */
  async hydrate(): Promise<T> {
    if (this.hydrated || !this.opts.persist || !store) {
      this.hydrated = true;
      return this.value;
    }
    this.hydrated = true;
    try {
      const row = await store.read(this.key);
      if (row) {
        this.value = this.opts.validate ? this.opts.validate(row.value) : (row.value as T);
        this.rev = row.revision;
      }
    } catch {
      // Store down: carry on with the in-memory default.
    }
    return this.value;
  }

  /** Replaces the entire value. */
  async set(next: T): Promise<T> {
    const validated = this.opts.validate ? this.opts.validate(next) : next;
    this.value = validated;
    this.bump();
    return this.value;
  }

  /**
   * Shallow merge over the current value — the PATCH protocol of an operator
   * panel. Touching the sponsor must not wipe the scoreboard.
   */
  async patch(partial: Partial<T>): Promise<T> {
    if (typeof this.value !== "object" || this.value === null || Array.isArray(this.value)) {
      throw new Error(`[synced-state] patch() requires an object; "${this.key}" is not one`);
    }
    const merged = { ...(this.value as object), ...(partial as object) } as T;
    return this.set(merged);
  }

  /**
   * Applies a message received from another process. Discards stale ones: this is the
   * defense against message reordering after a reconnection.
   * Returns `true` if it was applied.
   */
  applyRemote(message: SyncedStateMessage): boolean {
    if (message.key !== this.key) return false;
    if (message.revision <= this.rev) return false; // arrived late
    try {
      this.value = this.opts.validate ? this.opts.validate(message.value) : (message.value as T);
    } catch {
      return false; // invalid payload: better to keep what was there
    }
    this.rev = message.revision;
    this.emit();
    return true;
  }

  /** Listens for local and remote changes. Returns the function to unsubscribe. */
  subscribe(fn: (value: T, revision: number) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Message ready to send to a client that has just connected. */
  toMessage(): SyncedStateMessage<T> {
    return { type: "state:sync", key: this.key, revision: this.rev, value: this.value };
  }

  /** Cancels the pending write. Called by `resetSyncedState`. */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.listeners.clear();
  }

  /** Forces the pending write now. Useful when shutting down the process and in tests. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeNow();
  }

  // ── internal ──

  private bump(): void {
    this.rev++;
    this.emit();
    this.broadcast();
    this.schedulePersist();
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.value, this.rev);
      } catch {
        // A subscriber that blows up cannot bring down the others.
      }
    }
  }

  private broadcast(): void {
    if (!transport) return;
    try {
      transport.broadcast(this.channel, this.toMessage());
    } catch {
      // Transport down: the in-memory state is still correct.
    }
  }

  private schedulePersist(): void {
    if (!this.opts.persist || !store) return;
    if (this.opts.persistDebounceMs <= 0) {
      void this.writeNow();
      return;
    }
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.writeNow();
    }, this.opts.persistDebounceMs);
  }

  private async writeNow(): Promise<void> {
    if (!this.opts.persist || !store) return;
    try {
      await store.write(this.key, this.value, this.rev);
    } catch {
      // Persistence down: we do not lose the live broadcast over this.
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Declares (or retrieves) a synced state. Calling it twice with the same
 * key returns THE SAME instance — like `nodecg.Replicant`, so that
 * two modules talking about the same scoreboard do not end up with two copies.
 */
export function defineSyncedState<T>(key: string, options: SyncedStateOptions<T>): SyncedState<T> {
  const existing = registry.get(key);
  if (existing) return existing as unknown as SyncedState<T>;
  const created = new SyncedState<T>(key, options);
  registry.set(key, created as unknown as SyncedState<unknown>);
  return created;
}

/** Already-declared state, or `null`. */
export function getSyncedState<T>(key: string): SyncedState<T> | null {
  return (registry.get(key) as unknown as SyncedState<T>) ?? null;
}

/** Declared keys. For diagnostics/admin. */
export function listSyncedStateKeys(): string[] {
  return [...registry.keys()];
}

// ── In-memory store (default for tests and for lite mode without Valkey) ─────

export function createMemoryStateStore(): StateStore & { dump(): Map<string, unknown> } {
  const data = new Map<string, { value: unknown; revision: number }>();
  return {
    async read(key) {
      return data.get(key) ?? null;
    },
    async write(key, value, revision) {
      data.set(key, { value, revision });
    },
    dump() {
      return new Map([...data].map(([k, v]) => [k, v.value]));
    },
  };
}
