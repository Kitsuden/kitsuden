/** Fixture: if the loader ever imported this, the test detects it. */
import { Hono } from "hono";

(globalThis as Record<string, unknown>).__importedFutureKon = true;

export const kon = {
  id: "kon-future-test",
  name: "Future (fixture)",
  version: "1.0.0",
  sdk: 99,
  mountPath: "/api/future-test",
  createRouter() {
    const r = new Hono();
    r.get("/", (c) => c.json({ mounted: true }));
    return r;
  },
};

export default kon;
