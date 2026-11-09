/**
 * Fixture for `kon-activated-hot.test.ts`.
 *
 * Reproduces the shape of kon-ecommerce that exposed the failure: `mountPath` in the
 * code ("/api/storefront", which cannot be deduced from the id) and a kon.json that does not declare `mount.path`. The
 * loader CANNOT deduce that path from the id (`/api/shop-test` or
 * `/api/custom/kon-shop-test` would be its usual candidates).
 */
import { Hono } from "hono";

export const kon = {
  id: "kon-shop-test",
  name: "Shop (fixture)",
  version: "1.0.0",
  sdk: 1,
  mountPath: "/api/storefront",
  createRouter() {
    const r = new Hono();
    r.get("/products", (c) => c.json({ products: ["mug"] }));
    return r;
  },
};

export default kon;
