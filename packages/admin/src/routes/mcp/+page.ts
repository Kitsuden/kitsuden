import { redirect } from "@sveltejs/kit";

// Kept for old links: this screen lives at /settings?tab=mcp.
export function load() {
  redirect(307, "/settings?tab=mcp");
}
