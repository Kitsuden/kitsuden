import { describe, it, expect } from "bun:test";

import {
  AGENT_TYPES,
  isValidAgentType,
  normalizeAgentType,
  generateAgentId,
  generateAgentApiKey,
  parseAgentId,
  isValidAgentId,
  getAgentTypeFromId,
  getAgentTypeFromApiKey,
  generateLegacyAgentApiKey,
} from "../utils/id-generator";

describe("ID Generator", () => {
  describe("Constants", () => {
    it("should have expected agent types", () => {
      expect(AGENT_TYPES.CLAUDE_DESKTOP).toBe("claude-desktop");
      expect(AGENT_TYPES.SCRAPER).toBe("scraper");
      expect(AGENT_TYPES.WEBHOOK).toBe("webhook");
    });
  });

  describe("isValidAgentType", () => {
    it("returns true for valid types", () => {
      expect(isValidAgentType("claude-desktop")).toBe(true);
      expect(isValidAgentType("scraper")).toBe(true);
    });
    it("returns false for invalid types", () => {
      expect(isValidAgentType("invalid")).toBe(false);
      expect(isValidAgentType("")).toBe(false);
    });
  });

  describe("normalizeAgentType", () => {
    it("normalizes to lowercase with hyphens", () => {
      expect(normalizeAgentType("Claude Desktop")).toBe("claude-desktop");
      expect(normalizeAgentType("My Type!")).toBe("my-type");
    });
    it("returns empty for empty input", () => {
      expect(normalizeAgentType("")).toBe("");
    });
  });

  describe("generateAgentId", () => {
    it("generates a structured ID", () => {
      const result = generateAgentId({ type: "claude-desktop" });
      expect(result.id.startsWith("kitsuden_agent_claude-desktop_")).toBe(true);
      expect(result.type).toBe("claude-desktop");
      expect(result.hash.length).toBe(16);
      expect(result.prefix).toBe("kitsuden_agent");
    });
    it("throws on empty type", () => {
      expect(() => generateAgentId({ type: "" })).toThrow("Agent type cannot be empty");
    });
    it("throws on very long type", () => {
      expect(() => generateAgentId({ type: "a".repeat(51) })).toThrow("Agent type too long");
    });
  });

  describe("generateAgentApiKey", () => {
    it("generates a key with argon2id hash", async () => {
      const result = await generateAgentApiKey({ type: "worker" });
      expect(result.plainKey.startsWith("kitsuden_agent_worker_")).toBe(true);
      expect(result.keyHash.length).toBeGreaterThan(64); // argon2id hash
      expect(result.keyId.length).toBe(16); // 16 hex chars
      expect(result.algorithm).toBe("argon2id");
      expect(result.keyPrefix.includes("****")).toBe(true);
      expect(result.components.type).toBe("worker");
    });
    it("throws on empty type", () => {
      expect(() => generateAgentApiKey({ type: "" })).toThrow("Agent type cannot be empty");
    });
  });

  describe("parseAgentId", () => {
    it("parses a valid agent ID", () => {
      const parsed = parseAgentId("kitsuden_agent_claude-desktop_abc123");
      expect(parsed).not.toBeNull();
      expect(parsed!.prefix).toBe("kitsuden_agent");
      expect(parsed!.type).toBe("claude-desktop");
      expect(parsed!.hash).toBe("abc123");
    });
    it("returns null for invalid IDs", () => {
      expect(parseAgentId("invalid")).toBeNull();
      expect(parseAgentId("")).toBeNull();
    });
    it("handles types with underscores", () => {
      const parsed = parseAgentId("kitsuden_agent_my_type_abc123");
      expect(parsed!.type).toBe("my_type");
    });
  });

  describe("isValidAgentId", () => {
    it("validates correct IDs", () => {
      expect(isValidAgentId("kitsuden_agent_test_123")).toBe(true);
    });
    it("rejects incorrect IDs", () => {
      expect(isValidAgentId("bad")).toBe(false);
    });
    it("checks expected type", () => {
      expect(isValidAgentId("kitsuden_agent_test_123", "test")).toBe(true);
      expect(isValidAgentId("kitsuden_agent_test_123", "other")).toBe(false);
    });
  });

  describe("getAgentTypeFromId", () => {
    it("extracts type", () => {
      expect(getAgentTypeFromId("kitsuden_agent_worker_123")).toBe("worker");
    });
    it("returns null for invalid", () => {
      expect(getAgentTypeFromId("bad")).toBeNull();
    });
  });

  describe("getAgentTypeFromApiKey", () => {
    it("extracts type from key", () => {
      expect(getAgentTypeFromApiKey("kitsuden_agent_worker_random")).toBe("worker");
    });
    it("returns null for invalid key", () => {
      expect(getAgentTypeFromApiKey("bad_key")).toBeNull();
      expect(getAgentTypeFromApiKey("kitsuden_agent_random")).toBeNull();
    });
  });

  describe("generateLegacyAgentApiKey", () => {
    it("generates legacy key migrated to argon2id", async () => {
      const result = await generateLegacyAgentApiKey();
      expect(result.plainKey.startsWith("kitsuden_agent_")).toBe(true);
      expect(result.keyHash.length).toBeGreaterThan(64);
      expect(result.algorithm).toBe("argon2id");
    });
  });
});
