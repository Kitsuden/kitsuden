/// <reference types="astro/client" />

/** `true` when the site was built with `INTI=true` (set in astro.config.mjs) */
declare const __INTI__: boolean;

declare namespace App {
  interface Locals {
    /** API client for this request (set in src/middleware.ts) */
    kitsuden: import("./lib/kitsuden").KitsudenClient;
  }
}
