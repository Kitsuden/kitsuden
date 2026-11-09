/**
 * Media — Authorization Policy
 * ============================================================================
 *
 * Deny-by-default. Importing this module registers the "media" policy.
 *
 * The media library belongs to the TEAM: whoever edits the site (`admin`/`editor`)
 * uploads, sorts and deletes. The routes only asked for a session (and sign-up is public), so
 * the only defense was the prefix rule in `auth-guard.ts`; removing it
 * let any account upload files to the API domain.
 *
 * The FILES are served without a session (`/media/*` and the transformations), which is
 * what the web renders. What is not public is the CATALOG: the listing, each
 * medium's detail (original name, folder, metadata) and the folders.
 *
 * The configuration (storage provider and its credentials, connection
 * test) is `admin`-only: it may contain S3/R2 keys, and the connection test
 * writes to a disk path or calls an arbitrary endpoint.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

const isStaff = (user: AuthzUser | null | undefined): boolean =>
  user?.role === "admin" || user?.role === "editor";

export function registerMediaPolicy(): void {
  definePolicy<unknown>("media", {
    /** Listing, detail and folders. */
    view: (user) => isStaff(user),
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    configure: (user) => user?.role === "admin",
  });
}

registerMediaPolicy();
