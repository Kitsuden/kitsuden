// Utility functions for Kitsuden CLI
import { execSync } from "child_process";
import path from "path";

import fs from "fs-extra";

export async function checkDocker(): Promise<boolean> {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function checkDockerCompose(): Promise<boolean> {
  try {
    execSync("docker compose version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function isKitsudenProject(dir: string): Promise<boolean> {
  const hasDockerCompose = await fs.pathExists(path.join(dir, "docker-compose.yml"));
  const hasKitsudenConfig = await fs.pathExists(path.join(dir, "kitsuden.config.ts"));
  return hasDockerCompose || hasKitsudenConfig;
}

export function getProjectName(dir: string): string {
  try {
    const packageJson = fs.readJsonSync(path.join(dir, "package.json"));
    return packageJson.name || "kitsuden-project";
  } catch {
    return path.basename(dir);
  }
}
