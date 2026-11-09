/**
 * ID Generator Utilities
 *
 * Centralized utilities to generate unique identifiers
 * with standardized formats according to the entity type.
 *
 * Agent format: kitsuden_agent_{type}_{unique_hash}
 * Example: kitsuden_agent_claude_abc123xyz
 */

import { createHash, randomBytes } from "crypto";

import { hash as argon2Hash } from "@node-rs/argon2";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_ID_PREFIX = "kitsuden_agent";

/**
 * Legacy prefixes accepted ONLY when parsing/validating identities already issued.
 * They are never generated. Sunset 2026-08-01 (same as the `kitsuden_sk_*` keys), after
 * which this list is removed and the old tokens stop authenticating.
 */
const LEGACY_AGENT_ID_PREFIXES = ["grm_agent"] as const;

/** Canonical + legacy prefix, for tolerant parsing during the migration. */
const ACCEPTED_AGENT_ID_PREFIXES = [AGENT_ID_PREFIX, ...LEGACY_AGENT_ID_PREFIXES];

/** Returns the accepted prefix that `value` starts with, or null. */
function matchAgentPrefix(value: string): string | null {
  return ACCEPTED_AGENT_ID_PREFIXES.find((p) => value.startsWith(`${p}_`)) ?? null;
}
const ID_HASH_LENGTH = 16; // Length of the unique hash
const API_KEY_RANDOM_LENGTH = 32; // Bytes used to generate the random part

// Supported agent types
export const AGENT_TYPES = {
  CLAUDE_DESKTOP: "claude-desktop",
  CLAUDE_WEB: "claude-web",
  SCRAPER: "scraper",
  WORKER: "worker",
  WEBHOOK: "webhook",
  MCP_SERVER: "mcp-server",
  CUSTOM: "custom",
} as const;

export type AgentType = (typeof AGENT_TYPES)[keyof typeof AGENT_TYPES];

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates that an agent type is valid
 */
export function isValidAgentType(type: string): type is AgentType {
  return Object.values(AGENT_TYPES).includes(type as AgentType);
}

/**
 * Normalizes an agent type (lowercase, no spaces)
 */
export function normalizeAgentType(type: string): string {
  return type
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// ID GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentIdOptions {
  /** Agent type (e.g. 'claude-desktop', 'scraper') */
  type: string;
  /** Hash length (default: 16) */
  hashLength?: number;
}

export interface GeneratedAgentId {
  /** Full ID: kitsuden_agent_{type}_{hash} */
  id: string;
  /** Only the normalized type */
  type: string;
  /** Only the unique hash */
  hash: string;
  /** Full prefix */
  prefix: string;
}

/**
 * Generates a unique ID for an agent with a standardized format.
 *
 * Format: kitsuden_agent_{type}_{unique_hash}
 * Example: kitsuden_agent_claude-desktop_a1b2c3d4e5f67890
 *
 * @param options - Generation options
 * @returns Object with the full ID and its components
 *
 * @example
 * ```typescript
 * const agentId = generateAgentId({ type: "claude-desktop" });
 * console.log(agentId.id); // "kitsuden_agent_claude-desktop_a1b2c3d4e5f67890"
 * ```
 */
export function generateAgentId(options: AgentIdOptions): GeneratedAgentId {
  const { type, hashLength = ID_HASH_LENGTH } = options;

  // Normalize the type
  const normalizedType = normalizeAgentType(type);

  if (!normalizedType) {
    throw new Error("Agent type cannot be empty");
  }

  if (normalizedType.length > 50) {
    throw new Error("Agent type too long (max 50 chars)");
  }

  // Generate a unique hash using secure crypto
  const randomPart = randomBytes(16).toString("hex");
  const timestamp = Date.now().toString(36);
  const hashInput = `${randomPart}-${timestamp}-${Math.random()}`;
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, hashLength);

  // Build the full ID
  const id = `${AGENT_ID_PREFIX}_${normalizedType}_${hash}`;

  return {
    id,
    type: normalizedType,
    hash,
    prefix: AGENT_ID_PREFIX,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API KEY GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentApiKeyOptions {
  /** Agent type to include in the key */
  type: string;
  /** Length of the random part (default: 32 bytes) */
  randomLength?: number;
}

export interface GeneratedAgentApiKey {
  /** Full API key in plain text (SHOW ONLY ONCE) */
  plainKey: string;
  /** Argon2id hash of the secret to store in the DB */
  keyHash: string;
  /** Public keyId for DB lookup */
  keyId: string;
  /** Hashing algorithm */
  algorithm: "argon2id";
  /** Prefix to show in the UI (hides the sensitive part) */
  keyPrefix: string;
  /** Key components */
  components: {
    prefix: string;
    type: string;
    keyId: string;
    secret: string;
  };
}

/**
 * Generates an API key for an agent with a standardized format and Argon2id.
 *
 * New format: kitsuden_agent_{type}_{key_id}_{secret}
 * Example: kitsuden_agent_claude-desktop_a1b2c3d4e5f67890_xxxxxxxx...
 *
 * - key_id: public 16-hex identifier (64 bits) for DB lookup.
 * - secret: 256-bit secret part hashed with Argon2id.
 *
 * @param options - Generation options
 * @returns Object with the plain key, Argon2id hash and keyId
 *
 * @example
 * ```typescript
 * const apiKey = await generateAgentApiKey({ type: "claude-desktop" });
 * console.log(apiKey.plainKey); // "kitsuden_agent_claude-desktop_..."
 * console.log(apiKey.keyHash);  // Store this in the DB
 * ```
 */
export async function generateAgentApiKey(
  options: AgentApiKeyOptions
): Promise<GeneratedAgentApiKey> {
  const { type, randomLength = API_KEY_RANDOM_LENGTH } = options;

  // Normalize type
  const normalizedType = normalizeAgentType(type);

  if (!normalizedType) {
    throw new Error("Agent type cannot be empty");
  }

  // Public 16-hex key_id (64 bits) for unique lookup
  const keyId = randomBytes(8).toString("hex");

  // High-entropy secret (256 bits)
  const secret = randomBytes(randomLength).toString("base64url");

  // Full key
  const plainKey = `${AGENT_ID_PREFIX}_${normalizedType}_${keyId}_${secret}`;

  // Argon2id hash of the secret (not of the whole key)
  const keyHash = await argon2Hash(secret);

  // Prefix for the UI (last 4 chars of the keyId)
  const keyPrefix = `${AGENT_ID_PREFIX}_${normalizedType}_****${keyId.slice(-4)}`;

  return {
    plainKey,
    keyHash,
    keyId,
    algorithm: "argon2id",
    keyPrefix,
    components: {
      prefix: AGENT_ID_PREFIX,
      type: normalizedType,
      keyId,
      secret,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSERS AND VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses an agent ID to extract its components
 *
 * @param id - Full ID (e.g. "kitsuden_agent_claude-desktop_abc123")
 * @returns ID components or null if invalid
 */
export function parseAgentId(id: string): { prefix: string; type: string; hash: string } | null {
  // Accepts the canonical prefix (kitsuden_agent) and the legacy ones in sunset (grm_agent).
  const prefix = matchAgentPrefix(id);
  if (!prefix) return null;

  const parts = id.slice(prefix.length + 1).split("_");

  // At least type + hash must remain
  if (parts.length < 2) return null;

  // The type may contain underscores (everything but the last part)
  const hash = parts[parts.length - 1];
  const type = parts.slice(0, parts.length - 1).join("_");

  return { prefix, type, hash };
}

/**
 * Validates whether a string is a valid agent ID
 *
 * @param id - String to validate
 * @param expectedType - Expected type (optional)
 * @returns true if valid
 */
export function isValidAgentId(id: string, expectedType?: string): boolean {
  const parsed = parseAgentId(id);
  if (!parsed) return false;

  if (expectedType) {
    return parsed.type === normalizeAgentType(expectedType);
  }

  return true;
}

/**
 * Extracts the agent type from an ID
 *
 * @param id - Agent ID
 * @returns Normalized type or null if invalid
 */
export function getAgentTypeFromId(id: string): string | null {
  const parsed = parseAgentId(id);
  return parsed?.type || null;
}

/**
 * Extracts the agent type from an API key
 *
 * @param apiKey - Full API key
 * @returns Normalized type or null if invalid
 */
export function getAgentTypeFromApiKey(apiKey: string): string | null {
  const prefix = matchAgentPrefix(apiKey);
  if (!prefix) return null;

  const parts = apiKey.slice(prefix.length + 1).split("_");
  if (parts.length < 2) return null;

  // The type is all the parts except the last (random)
  return parts.slice(0, parts.length - 1).join("_");
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY GENERATORS (Backward Compatibility)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates an API key without a type (legacy format)
 * @deprecated Use generateAgentApiKey({ type: "..." }) instead
 */
export async function generateLegacyAgentApiKey(): Promise<{
  plainKey: string;
  keyHash: string;
  keyId: string;
  algorithm: "argon2id";
  keyPrefix: string;
}> {
  return generateAgentApiKey({ type: "legacy" });
}
