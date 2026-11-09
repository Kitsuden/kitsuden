/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FIXTURE LOADING - Setup test data
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { TestKonContext, Fixture } from "./types.js";

/**
 * Load fixtures into the test context
 */
export async function loadFixtures(
  fixtures: string | Record<string, any>,
  context: TestKonContext
): Promise<Record<string, any>> {
  // If fixtures is an object, use it directly
  if (typeof fixtures !== "string") {
    return fixtures;
  }

  // Try to load from file
  try {
    const fixtureModule = await import(`./fixtures/${fixtures}.js`);
    const fixture: Fixture = fixtureModule.default || fixtureModule;

    if (typeof fixture.setup === "function") {
      return await fixture.setup(context);
    }

    // If it's just a plain object
    return fixture;
  } catch (error) {
    console.warn(`[Test] Could not load fixture "${fixtures}":`, error);
    return {};
  }
}

/**
 * Define a fixture with dependencies
 */
export function defineFixture(fixture: Fixture): Fixture {
  return fixture;
}

/**
 * Helper to create simple data fixtures
 */
export function createDataFixture<T extends Record<string, any>>(data: T): T {
  return data;
}

export default { loadFixtures, defineFixture, createDataFixture };
