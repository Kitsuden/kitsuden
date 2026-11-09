/** Reads an environment variable from `process.env`, where there is one. */
const processEnv = (): Record<string, string | undefined> =>
  typeof process !== "undefined" && process.env ? process.env : {};

export function readEnv(
  name: string,
  env: Record<string, string | undefined> = processEnv()
): string | undefined {
  return env[name];
}
