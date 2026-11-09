// @ts-nocheck
// Global Teardown: Cleanup after E2E tests

import { FullConfig } from "@playwright/test";

async function globalTeardown(config: FullConfig) {
  console.log("🧹 E2E Global Teardown");

  const apiProcess = (global as any).__API_PROCESS__;

  if (apiProcess) {
    console.log("🛑 Stopping API server...");
    process.kill(-apiProcess.pid!);
    console.log("✅ API server stopped");
  }
}

export default globalTeardown;
