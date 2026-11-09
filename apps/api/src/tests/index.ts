/**
 * Test Suite Entry Point
 *
 * Aggregates all test suites for the API.
 */

import "./auth.test";
import "./datasets.test";
import "./modules.test";
import "./rls.test";

console.log("Test suites loaded:");
console.log("- Auth Module Tests");
console.log("- Datasets Module Tests");
console.log("- Modules (Kons) Tests");
console.log("- Row Level Security Tests");
