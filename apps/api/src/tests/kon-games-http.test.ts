/**
 * Kon Games HTTP Tests
 *
 * Tests gaming domain routes if kon-games is loaded.
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { app } from "../index";
import { installedKon } from "../lib/installed-kons";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

// kon-games is an INSTALLABLE kon (kitsuden-kons repo): without it there are no routes to
// test. Anything that uses it is skipped in a clean clone of the core instead of failing.
const WITHOUT_GAMES = !installedKon("kon-games")?.path;

let dbAvailable = false;
let gamesEnabled = false;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe.skipIf(WITHOUT_GAMES)("Kon Games HTTP", () => {
  const email = `games-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookie = "";
  let createdGameId = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    // Admin: `GET /api/modules` (to know whether the kon is active) is admin-only
    // and `POST /api/games` is staff-only (middleware/authorization-matrix.ts).
    // With a normal user, the 403 from /api/modules left `gamesEnabled` at
    // false and the tests expected a 404 that never arrives.
    ({ cookie } = await enterAs(app, { email, password, name: "Games User", role: "admin" }));

    const modulesRes = await app.request(req("/api/modules", {}, cookie));
    if (modulesRes.status === 200) {
      const body = (await modulesRes.json()) as any;
      const allModules = Object.values(body.categories ?? {}).flatMap(
        (cat: any) => cat.modules ?? []
      );
      gamesEnabled = allModules.some(
        (m: any) => (m.key === "kon-games" || m.key === "games") && m.enabled
      );
    }
  });

  describe("Games Routes", () => {
    it("GET /api/games → lists games when kon is loaded, 404 otherwise", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/games", {}, cookie));
      expect(res.status).toBe(gamesEnabled ? 200 : 404);

      if (gamesEnabled) {
        const body = (await res.json()) as any;
        expect(Array.isArray(body.docs)).toBe(true);
      }
    });

    it("POST /api/games → creates game when kon is loaded, 404 otherwise", async () => {
      if (!dbAvailable) return;

      const testSlug = `test-game-${generateTestId()}`;
      const res = await app.request(
        req(
          "/api/games",
          {
            method: "POST",
            body: JSON.stringify({
              title: `Test Game ${generateTestId()}`,
              slug: testSlug,
              description: "Created by test suite",
              status: "published",
            }),
          },
          cookie
        )
      );

      expect(res.status).toBe(gamesEnabled ? 201 : 404);

      if (gamesEnabled) {
        const body = (await res.json()) as any;
        expect(body.id).toBeDefined();
        createdGameId = body.id;
      }
    });

    it("GET /api/games/platforms → lists platforms when kon is loaded, 404 otherwise", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/games/platforms", {}, cookie));
      expect(res.status).toBe(gamesEnabled ? 200 : 404);

      if (gamesEnabled) {
        const body = (await res.json()) as any;
        expect(Array.isArray(body.docs)).toBe(true);
      }
    });

    it("GET /api/games/tags → lists tags when kon is loaded, 404 otherwise", async () => {
      if (!dbAvailable) return;

      const res = await app.request(req("/api/games/tags", {}, cookie));
      expect(res.status).toBe(gamesEnabled ? 200 : 404);

      if (gamesEnabled) {
        const body = (await res.json()) as any;
        expect(Array.isArray(body.docs)).toBe(true);
      }
    });

    it("GET /api/games/:id → returns game detail when kon is loaded, 404 otherwise", async () => {
      if (!dbAvailable) return;

      const targetId = createdGameId || generateTestId();
      const res = await app.request(req(`/api/games/${targetId}`, {}, cookie));
      expect(res.status).toBe(gamesEnabled ? 200 : 404);

      if (gamesEnabled) {
        const body = (await res.json()) as any;
        expect(body.id).toBe(targetId);
      }
    });
  });
});
