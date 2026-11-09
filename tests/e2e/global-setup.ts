// @ts-nocheck
// Global Setup: Initialize test environment before E2E tests

import { spawn } from "child_process";
import { setTimeout } from "timers/promises";

import { FullConfig } from "@playwright/test";

let apiProcess: ReturnType<typeof spawn> | null = null;

async function globalSetup(config: FullConfig) {
  console.log("🚀 E2E Global Setup");

  const apiUrl = process.env.API_URL || "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL;

  // Check if API is already running
  const isApiRunning = await checkHealth(apiUrl);

  if (!isApiRunning) {
    console.log("📡 Starting API server...");
    apiProcess = spawn("bun", ["run", "start:api"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "test" },
      detached: true,
      stdio: "pipe",
    });

    // Wait for API to be ready
    let retries = 30;
    while (retries > 0) {
      await setTimeout(1000);
      if (await checkHealth(apiUrl)) {
        console.log("✅ API server is ready");
        break;
      }
      retries--;
    }

    if (retries === 0) {
      throw new Error("❌ API server failed to start");
    }
  } else {
    console.log("✅ API server already running");
  }

  // Run MCP seed script if not already seeded
  if (dbUrl && !process.env.SKIP_SEED) {
    console.log("🌱 Running seed script...");
    try {
      await execAsync("bun run apps/api/scripts/seed-mcp-test.ts");
    } catch (e) {
      console.log("⚠️ Seed may have already been run");
    }
  }

  // Store process for teardown
  (global as any).__API_PROCESS__ = apiProcess;
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function execAsync(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { shell: true, stdio: "inherit" });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
  });
}

export default globalSetup;
