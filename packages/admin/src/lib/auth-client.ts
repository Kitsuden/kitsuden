import { createAuthClient } from "better-auth/client";

// In production: "" (relative, proxied by nginx). In dev: "http://localhost:3001"
const API_URL = import.meta.env.VITE_API_URL ?? "";

export const authClient = createAuthClient({
  baseURL: API_URL || undefined, // undefined = same origin (relative)
});
