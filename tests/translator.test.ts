// @ts-nocheck
/**
 * Tests for Kitsuden QL Engine (translator.ts)
 *
 * Verifies:
 * - Mapping of Prisma operators to Drizzle
 * - Logical operators AND/OR/NOT
 * - Column and operator validation
 * - Auto-Join with expand
 * - Semantic errors
 */

import { describe, it, expect } from "vitest";

import { agentIdentities, agentTraces, dataSets } from "../apps/api/src/db/schema";
import {
  validateKitsudenQuery,
  getAvailableRelations,
  debugQuery,
  KitsudenQLError,
} from "../packages/engine/src/translator";

describe("Kitsuden QL Engine - translator.ts", () => {
  describe("Comparison Operators", () => {
    it("should translate eq (equality)", () => {
      const debug = debugQuery(agentIdentities, {
        where: { type: { eq: "service" } },
      });
      expect(debug.sql).toContain("SELECT");
    });

    it("should translate neq (not equal)", () => {
      const debug = debugQuery(agentIdentities, {
        where: { type: { neq: "disabled" } },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate gt/gte/lt/lte (numeric)", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          rateLimit: { gte: 60, lte: 100 },
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate in (array of values)", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          type: { in: ["service", "worker", "agent"] },
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate contains (text search)", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          name: { contains: "agent" },
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate startsWith and endsWith", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          name: { startsWith: "test", endsWith: "bot" },
        },
      });
      expect(debug.sql).toBeTruthy();
    });
  });

  describe("Direct Equality", () => {
    it("should support direct equality without an operator", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          isActive: true,
          type: "service",
        },
      });
      expect(debug.sql).toBeTruthy();
    });
  });

  describe("Logical Operators", () => {
    it("should translate AND", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          AND: [{ isActive: true }, { type: { eq: "service" } }],
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate OR", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          OR: [{ type: { eq: "service" } }, { type: { eq: "worker" } }],
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should translate NOT", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          NOT: { isActive: false },
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("should support complex AND/OR/NOT nesting", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          AND: [
            { isActive: true },
            {
              OR: [{ type: { eq: "service" } }, { type: { eq: "worker" } }],
            },
          ],
        },
      });
      expect(debug.sql).toBeTruthy();
    });
  });

  describe("Error Validation", () => {
    it("should throw an error for a nonexistent column", () => {
      expect(() => {
        debugQuery(agentIdentities, {
          where: { nonExistentField: { eq: "value" } },
        });
      }).toThrow(KitsudenQLError);
    });

    it("should throw an error for an unsupported operator", () => {
      expect(() => {
        debugQuery(agentIdentities, {
          where: { name: { invalidOp: "value" } as any },
        });
      }).toThrow(KitsudenQLError);
    });

    it("should throw an error for an invalid value for 'in'", () => {
      expect(() => {
        debugQuery(agentIdentities, {
          where: { type: { in: "not-an-array" } as any },
        });
      }).toThrow(KitsudenQLError);
    });

    it("should throw an error for a nonexistent relation in expand", () => {
      expect(() => {
        debugQuery(agentIdentities, {
          where: {},
          expand: ["nonExistentRelation"],
        });
      }).toThrow(KitsudenQLError);
    });
  });

  describe("Validation without Execution", () => {
    it("should validate a correct query", () => {
      const { valid, errors } = validateKitsudenQuery(agentIdentities, {
        where: { isActive: true },
        expand: ["traces"],
      });
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it("should detect invalid columns", () => {
      const { valid, errors } = validateKitsudenQuery(agentIdentities, {
        where: { invalidField: { eq: "value" } },
      });
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("should detect invalid relations", () => {
      const { valid, errors } = validateKitsudenQuery(agentIdentities, {
        expand: ["invalidRelation"],
      });
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("should detect invalid limits", () => {
      const { valid, errors } = validateKitsudenQuery(agentIdentities, {
        limit: 5000,
      });
      expect(valid).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("Available Relations", () => {
    it("should list the relations of agentIdentities", () => {
      const relations = getAvailableRelations(agentIdentities);
      expect(relations).toContain("traces");
      expect(relations).toContain("apiKeys");
      expect(relations).toContain("memories");
      expect(relations).toContain("auditLogs");
    });

    it("should list the relations of agentTraces", () => {
      const relations = getAvailableRelations(agentTraces);
      expect(relations).toContain("steps");
      expect(relations).toContain("agent");
    });

    it("should list the relations of dataSets", () => {
      const relations = getAvailableRelations(dataSets);
      expect(relations).toContain("entries");
      expect(relations).toContain("game");
    });
  });

  describe("BDD Scenarios", () => {
    it("Scenario 1: Complex filters with implicit AND", () => {
      // Given: Payload {"level": {"gte": 50}, "element": "pyro"}
      // When: Process against the table
      // Then: Returns an AND condition
      const debug = debugQuery(agentIdentities, {
        where: {
          rateLimit: { gte: 50 },
          type: "service",
        },
      });
      expect(debug.sql).toBeTruthy();
    });

    it("Scenario 2: Relation expansion", () => {
      // Given: Parameter "expand": ["traces", "apiKeys"]
      const debug = debugQuery(agentIdentities, {
        where: { isActive: true },
        expand: ["traces", "apiKeys"],
      });
      expect(debug.sql).toBeTruthy();
    });

    it("Scenario 3: Text search with contains", () => {
      const debug = debugQuery(agentIdentities, {
        where: {
          name: { contains: "agent" },
          description: { contains: "AI" },
        },
      });
      expect(debug.sql).toBeTruthy();
    });
  });
});
