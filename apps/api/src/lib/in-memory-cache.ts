/**
 * In-process memory cache: the substitute for Valkey on a single instance
 * ============================================================================
 *
 * Without `VALKEY_URL` (plan B1b: Valkey is optional and only needed
 * to scale horizontally), the caches that used it —queries, LLM responses,
 * the agent— store here. Per PROCESS: with several replicas each one
 * would have its own, which is why Valkey is configured with several replicas.
 *
 * Key cap (`CACHE_MEMORY_MAX_KEYS`, 5,000): when full, expired keys are swept
 * and, if it is still full, the oldest goes out (insertion order of the
 * Map). A cache must never be a memory leak.
 */

interface Input {
  value: string;
  expires: number;
}

const inputs = new Map<string, Input>();

function maxKeys(): number {
  const n = Number(process.env.CACHE_MEMORY_MAX_KEYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}

function sweep(now: number): void {
  for (const [key, e] of inputs) if (e.expires <= now) inputs.delete(key);
}

export function memoryGet(key: string): string | null {
  const e = inputs.get(key);
  if (!e) return null;
  if (e.expires <= Date.now()) {
    inputs.delete(key);
    return null;
  }
  return e.value;
}

export function memorySet(key: string, value: string, ttlSeconds: number): void {
  const now = Date.now();
  inputs.delete(key);
  if (inputs.size >= maxKeys()) sweep(now);
  while (inputs.size >= maxKeys()) {
    const first = inputs.keys().next().value;
    if (first === undefined) break;
    inputs.delete(first);
  }
  inputs.set(key, { value, expires: now + Math.max(1, ttlSeconds) * 1000 });
}

export function memoryOf(key: string): void {
  inputs.delete(key);
}

/** Live keys that match a Valkey pattern (`*` and `?`). */
export function memoryKeys(pattern: string): string[] {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`
  );
  const now = Date.now();
  const alive: string[] = [];
  for (const [key, e] of inputs) {
    if (e.expires <= now) inputs.delete(key);
    else if (re.test(key)) alive.push(key);
  }
  return alive;
}

/** For tests only. */
export function clearInMemoryCache(): void {
  inputs.clear();
}
