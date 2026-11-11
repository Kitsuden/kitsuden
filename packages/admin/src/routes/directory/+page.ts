import { redirect } from "@sveltejs/kit";

// Kept for old links: this screen lives at /g/kon-directory.
export function load() {
  redirect(307, "/g/kon-directory");
}
