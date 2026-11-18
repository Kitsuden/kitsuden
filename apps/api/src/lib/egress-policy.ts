/**
 * Egress policy for sandboxed code
 * ============================================================================
 *
 * Decides whether a `fetch` from a code action may reach a host and port. It
 * replaces the flat host list (`fetchAllow` + `KITSUDEN_SANDBOX_FETCH_ALLOW`),
 * which keeps working: each entry there is an `allow` rule.
 *
 * Two layers, evaluated in this order (the first that decides wins):
 *
 *   1. PLATFORM `denyAlways`   — set by the operator; no action can undo it.
 *   2. PLATFORM `allowAlways`  — set by the operator; reachable from every action.
 *   3. ACTION rules            — `egress.rules` in the action's config, plus
 *      `fetchAllow` and `KITSUDEN_SANDBOX_FETCH_ALLOW` as allows. Inside this
 *      layer a matching `deny` beats a matching `allow`, whatever the order.
 *   4. PLATFORM `defaultAction` — `deny` unless the operator says otherwise.
 *      An action cannot choose its own default: that would let a draft open
 *      every host with one field.
 *
 * Before any of that, the platform port floor (`ports`), when set, refuses
 * every TCP port outside it.
 *
 * Targets: `api.example.com` (exact), `*.example.com` (subdomains only), `*`
 * (any host), an IP literal, or a CIDR (`10.0.0.0/8`, `fd00::/8`). IP and CIDR
 * rules are matched against the ADDRESSES the name resolved to, after the
 * resolution that the connection is pinned to (lib/safe-fetch.ts), so a name
 * cannot slip past a CIDR deny by resolving differently later. A rule with
 * `ports` and no target matches any host on those ports.
 *
 * The internal-address guard (lib/public-address.ts) still runs first and is
 * not a rule: allowing `10.0.0.0/8` here does nothing unless the operator also
 * set `KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH=true`.
 *
 * Hot changes: the platform layer can live in a JSON file
 * (`KITSUDEN_EGRESS_POLICY_FILE`) that is re-read when it changes, with no
 * restart. Every sandbox `fetch` opens a fresh connection (`agent: false`), so a
 * tightened policy also applies to the next request of a running execution:
 * there are no established connections to drop. The file fails CLOSED: if it
 * is set and has never been read correctly, every request is denied; if a later
 * edit is invalid, the last valid version stays in force and the error is logged.
 *
 * Inspired by OpenSandbox's egress sidecar (Apache-2.0); no code is copied.
 * See docs/agents/egress.md.
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";

import { logger } from "./logger";

export type EgressAction = "allow" | "deny";

export interface EgressRule {
  action: EgressAction;
  /** Host, `*.domain`, `*`, IP or CIDR. Without it, the rule needs `ports`. */
  target?: string;
  /** TCP destination ports. Without them, any port. */
  ports?: number[];
}

export interface PlatformEgressPolicy {
  defaultAction: EgressAction;
  denyAlways: EgressRule[];
  allowAlways: EgressRule[];
  /** Port floor: the only TCP ports reachable at all. Empty = any. */
  ports: number[];
}

export interface EgressRequest {
  hostname: string;
  port: number;
  /** Resolved addresses. Absent before resolution: IP/CIDR rules then match only IP literals. */
  addresses?: string[];
}

export interface EgressDecision {
  allowed: boolean;
  /** Which layer decided, for the error message and the audit. */
  layer:
    | "ports"
    | "deny_always"
    | "allow_always"
    | "action_deny"
    | "action_allow"
    | "default"
    | "invalid_policy";
  rule?: EgressRule;
}

const MAX_RULES = 200;
const MAX_PORTS = 256;

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Does this text look like a valid target? Returns the normalized form or null. */
export function normalizeTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!t || t.length > 253) return null;
  if (t === "*") return t;
  const slash = t.indexOf("/");
  if (slash !== -1) {
    const ip = t.slice(0, slash).replace(/^\[|\]$/g, "");
    const bits = Number(t.slice(slash + 1));
    const family = isIP(ip);
    if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128))
      return null;
    return `${ip}/${bits}`;
  }
  const bare = t.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return bare;
  const host = t.startsWith("*.") ? t.slice(2) : t;
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/.test(host))
    return null;
  return t;
}

function validPorts(raw: unknown): number[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PORTS) return null;
  const out: number[] = [];
  for (const p of raw) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) return null;
    out.push(p);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Parses one rule. Returns the problem as text when it is invalid. */
export function parseRule(raw: unknown): EgressRule | string {
  if (!raw || typeof raw !== "object") return "A rule must be an object";
  const r = raw as Record<string, unknown>;
  if (r.action !== "allow" && r.action !== "deny")
    return 'A rule needs "action": "allow" or "deny"';
  const ports = validPorts(r.ports);
  if (ports === null) return `Invalid "ports" (TCP ports 1-65535, at most ${MAX_PORTS})`;
  if (r.target === undefined || r.target === "") {
    if (!ports.length) return 'A rule needs a "target", "ports" or both';
    return { action: r.action, ports };
  }
  const target = normalizeTarget(r.target);
  if (!target) return `Invalid target: ${String(r.target).slice(0, 80)}`;
  return ports.length ? { action: r.action, target, ports } : { action: r.action, target };
}

/** Parses a list of rules; the first invalid one is the problem. */
export function parseRules(raw: unknown): EgressRule[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "Rules must be a list";
  if (raw.length > MAX_RULES) return `At most ${MAX_RULES} rules`;
  const out: EgressRule[] = [];
  for (const [i, item] of raw.entries()) {
    const r = parseRule(item);
    if (typeof r === "string") return `Rule ${i + 1}: ${r}`;
    out.push(r);
  }
  return out;
}

/**
 * The problem with an action's `egress` config, or null. Used when an action is
 * saved and when a draft is proposed. `defaultAction` is refused on purpose.
 */
export function actionEgressProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    return '"egress" must be an object with "rules"';
  const e = raw as Record<string, unknown>;
  const extra = Object.keys(e).filter((k) => k !== "rules");
  if (extra.length) {
    return extra.includes("defaultAction")
      ? '"egress.defaultAction" is set by the operator, not by an action (KITSUDEN_EGRESS_POLICY_FILE)'
      : `Unknown key in "egress": ${extra[0]}`;
  }
  const rules = parseRules(e.rules);
  return typeof rules === "string" ? rules : null;
}

/** The action's rules: `egress.rules` plus every `fetchAllow` host as an allow. */
export function actionRules(
  config: { egress?: unknown; fetchAllow?: unknown } | undefined,
  serverAllow: string[] = []
): EgressRule[] {
  const out: EgressRule[] = [];
  const e = config?.egress as { rules?: unknown } | undefined;
  const parsed = e && typeof e === "object" ? parseRules(e.rules) : [];
  if (typeof parsed !== "string") out.push(...parsed);
  const hosts = [
    ...(Array.isArray(config?.fetchAllow) ? (config!.fetchAllow as unknown[]) : []),
    ...serverAllow,
  ];
  for (const h of hosts) {
    const target = normalizeTarget(h);
    if (target) out.push({ action: "allow", target });
  }
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────────────

const blockLists = new Map<string, BlockList>();

function cidrList(cidr: string): BlockList {
  let list = blockLists.get(cidr);
  if (!list) {
    list = new BlockList();
    const [ip, bits] = cidr.split("/") as [string, string];
    list.addSubnet(ip, Number(bits), isIP(ip) === 6 ? "ipv6" : "ipv4");
    if (blockLists.size > 1000) blockLists.clear();
    blockLists.set(cidr, list);
  }
  return list;
}

function ipMatches(target: string, ip: string): boolean {
  const family = isIP(ip);
  if (!family) return false;
  if (target.includes("/")) {
    const [base] = target.split("/") as [string];
    if (isIP(base) !== family) return false;
    return cidrList(target).check(ip, family === 6 ? "ipv6" : "ipv4");
  }
  return (
    isIP(target) === family &&
    cidrList(`${target}/${family === 6 ? 128 : 32}`).check(ip, family === 6 ? "ipv6" : "ipv4")
  );
}

function targetMatches(target: string | undefined, req: EgressRequest): boolean {
  if (target === undefined || target === "*") return true;
  const host = req.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (target.includes("/") || isIP(target)) {
    if (isIP(host)) return ipMatches(target, host);
    return (req.addresses ?? []).some((a) => ipMatches(target, a));
  }
  if (target.startsWith("*."))
    return host.endsWith(target.slice(1)) && host.length > target.length - 1;
  return host === target;
}

export function ruleMatches(rule: EgressRule, req: EgressRequest): boolean {
  if (rule.ports?.length && !rule.ports.includes(req.port)) return false;
  return targetMatches(rule.target, req);
}

/** The decision for one request. Pure: the platform layer is passed in. */
export function decideEgress(
  platform: PlatformEgressPolicy | null,
  rules: EgressRule[],
  req: EgressRequest
): EgressDecision {
  if (!platform) return { allowed: false, layer: "invalid_policy" };
  if (platform.ports.length && !platform.ports.includes(req.port))
    return { allowed: false, layer: "ports" };
  const deny = platform.denyAlways.find((r) => ruleMatches(r, req));
  if (deny) return { allowed: false, layer: "deny_always", rule: deny };
  const allow = platform.allowAlways.find((r) => ruleMatches(r, req));
  if (allow) return { allowed: true, layer: "allow_always", rule: allow };
  const actionDeny = rules.find((r) => r.action === "deny" && ruleMatches(r, req));
  if (actionDeny) return { allowed: false, layer: "action_deny", rule: actionDeny };
  const actionAllow = rules.find((r) => r.action === "allow" && ruleMatches(r, req));
  if (actionAllow) return { allowed: true, layer: "action_allow", rule: actionAllow };
  return { allowed: platform.defaultAction === "allow", layer: "default" };
}

/** Could resolving the name change a DENY into an allow? (Only IP/CIDR allows can.) */
export function resolutionCouldAllow(
  platform: PlatformEgressPolicy | null,
  rules: EgressRule[]
): boolean {
  if (!platform) return false;
  const ipAllow = (r: EgressRule) =>
    r.action === "allow" && !!r.target && (r.target.includes("/") || isIP(r.target) !== 0);
  return (
    platform.allowAlways.some(ipAllow) || rules.some(ipAllow) || platform.defaultAction === "allow"
  );
}

/** Human text for a refusal. */
export function describeDenial(d: EgressDecision, req: EgressRequest): string {
  const where = `${req.hostname}:${req.port}`;
  switch (d.layer) {
    case "ports":
      return `Port not reachable from the sandbox: ${where} (the operator's port floor)`;
    case "deny_always":
      return `Host denied by the platform egress policy: ${where}`;
    case "action_deny":
      return `Host denied by this action's egress rules: ${where}`;
    case "invalid_policy":
      return "The platform egress policy could not be read: every request is refused until it is fixed";
    default:
      return `Host not allowed: ${where} (add it to the action's fetchAllow or egress.rules)`;
  }
}

// ── The platform layer (env + hot-reloaded file) ─────────────────────────────

function envTargets(name: string): EgressRule[] {
  const action: EgressAction = name.includes("DENY") ? "deny" : "allow";
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => normalizeTarget(s))
    .filter((t): t is string => !!t)
    .map((target) => ({ action, target }));
}

function envPorts(): number[] {
  return (process.env.KITSUDEN_EGRESS_PORTS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}

/** Parses the platform file. Returns the problem as text when it is invalid. */
export function parsePlatformPolicy(text: string): Omit<PlatformEgressPolicy, never> | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must be a JSON object";
  const p = raw as Record<string, unknown>;
  const known = new Set(["defaultAction", "denyAlways", "allowAlways", "ports"]);
  const unknown = Object.keys(p).find((k) => !known.has(k));
  if (unknown) return `unknown key "${unknown}"`;
  const defaultAction = p.defaultAction ?? "deny";
  if (defaultAction !== "allow" && defaultAction !== "deny")
    return '"defaultAction" must be "allow" or "deny"';
  const denyAlways = parseRules(p.denyAlways);
  if (typeof denyAlways === "string") return `denyAlways: ${denyAlways}`;
  if (denyAlways.some((r) => r.action !== "deny"))
    return 'denyAlways: every rule must have "action": "deny"';
  const allowAlways = parseRules(p.allowAlways);
  if (typeof allowAlways === "string") return `allowAlways: ${allowAlways}`;
  if (allowAlways.some((r) => r.action !== "allow"))
    return 'allowAlways: every rule must have "action": "allow"';
  const ports = validPorts(p.ports);
  if (ports === null) return '"ports" must be a list of TCP ports';
  return { defaultAction, denyAlways, allowAlways, ports };
}

interface FileState {
  path: string;
  mtimeMs: number;
  size: number;
  policy: PlatformEgressPolicy | null;
  checkedAt: number;
}

let fileState: FileState | null = null;
/** How often the file's mtime is checked (ms). A change is seen within this. */
const RECHECK_MS = 1000;

function readFileLayer(path: string, now: number): PlatformEgressPolicy | null {
  if (fileState && fileState.path === path && now - fileState.checkedAt < RECHECK_MS)
    return fileState.policy;
  const last = fileState?.path === path ? fileState.policy : null;
  // One descriptor for the stat and the read: what is parsed is the file that was
  // stat-ed, even if it is replaced in between (no check-then-use race).
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    logger.error(
      { path, err: (err as Error).message },
      "[egress] Policy file unreadable; keeping the last valid one"
    );
    fileState = { path, mtimeMs: -1, size: -1, policy: last, checkedAt: now };
    return last;
  }
  try {
    const st = fstatSync(fd);
    if (
      fileState &&
      fileState.path === path &&
      fileState.mtimeMs === st.mtimeMs &&
      fileState.size === st.size
    ) {
      fileState.checkedAt = now;
      return fileState.policy;
    }
    let parsed: PlatformEgressPolicy | string;
    try {
      parsed = parsePlatformPolicy(readFileSync(fd, "utf8"));
    } catch (err) {
      parsed = (err as Error).message;
    }
    if (typeof parsed === "string") {
      logger.error(
        { path, problem: parsed },
        last
          ? "[egress] Invalid policy file; the last valid version stays in force"
          : "[egress] Invalid policy file and no valid version yet: every request is denied"
      );
      fileState = { path, mtimeMs: st.mtimeMs, size: st.size, policy: last, checkedAt: now };
      return last;
    }
    if (last) logger.info({ path }, "[egress] Policy file reloaded");
    fileState = { path, mtimeMs: st.mtimeMs, size: st.size, policy: parsed, checkedAt: now };
    return parsed;
  } finally {
    closeSync(fd);
  }
}

/**
 * The platform layer now: the file (when set) plus the env lists. `null` means
 * the file is set but has never been valid: deny everything.
 */
export function platformEgressPolicy(now = Date.now()): PlatformEgressPolicy | null {
  const path = process.env.KITSUDEN_EGRESS_POLICY_FILE?.trim();
  const fromFile = path ? readFileLayer(path, now) : null;
  if (path && !fromFile) return null;
  const envDefault = process.env.KITSUDEN_EGRESS_DEFAULT === "allow" ? "allow" : "deny";
  return {
    defaultAction: fromFile?.defaultAction ?? envDefault,
    denyAlways: [...envTargets("KITSUDEN_EGRESS_DENY_ALWAYS"), ...(fromFile?.denyAlways ?? [])],
    allowAlways: [...envTargets("KITSUDEN_EGRESS_ALLOW_ALWAYS"), ...(fromFile?.allowAlways ?? [])],
    ports: fromFile?.ports.length ? fromFile.ports : envPorts(),
  };
}

/** Tests only: forget the cached file. */
export function _resetEgressPolicyCache(): void {
  fileState = null;
}

/** The TCP port of a URL (explicit or the scheme's default). */
export function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}
