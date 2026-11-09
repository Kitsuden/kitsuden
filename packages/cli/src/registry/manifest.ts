/**
 * The kon manifest spec, version 1 — what a published kon declares
 * ============================================================================
 *
 * A published kon is described by its `kon.json`, the same file every kon
 * already has. Version 1 of the spec ("manifest": 1) does not invent a second
 * file: it fixes which fields a PUBLISHED kon must carry and normalizes the
 * spellings kons already use, so the existing 30 manifests stay valid inputs.
 *
 *   id            kon-<kebab>          required (same pattern as kon-schema.json)
 *   version       semver               required
 *   name, description                  required
 *   sdk           integer >= 1         kon SDK contract (GET /api/version → sdk.kons)
 *   kitsuden      semver range         core compatibility; also read from
 *                                      `compatibility.kitsuden` or
 *                                      package.json `kitsuden.minVersion` (→ ">=x")
 *   license       SPDX expression      required to publish
 *   author        string | {name,email?,url?}
 *   repository    string | {type?,url,directory?}
 *   dependencies.kons      ["kon-x"]  (an array: every existing reader expects one)
 *   dependencies.versions  {"kon-x": "^1.2.0"}  optional ranges; missing = any version
 *   tables        ["t"] or [{name:"t",…}] → names
 *   migrations    computed at pack time: the files of migrations/*.sql
 *   permissions   {scopes:[…], hosts:[…], sensitive:[…]} — what the user
 *                 consents to on install; required to publish (empty lists are
 *                 a valid, explicit "nothing")
 *
 * Every other field of kon.json (admin, mount, tier, madurez…) is kept as is.
 * The admin view `src` rule is the one of the admin extension point
 * (`packages/shared/src/admin-view.ts` → isSafeAssetPath), copied, NOT relaxed.
 */

import { coerceRelease, satisfies, valid, validRange } from "./semver.js";

export const MANIFEST_SPEC_VERSION = 1;

export interface DeclaredPermissions {
  scopes: string[];
  hosts: string[];
  sensitive: string[];
}

export interface NormalizedManifest {
  manifest: number;
  id: string;
  name: string;
  version: string;
  description: string;
  sdk: number | null;
  kitsuden: string | null;
  license: string | null;
  author: { name: string; email?: string; url?: string } | null;
  repository: { type?: string; url: string; directory?: string } | null;
  dependencies: Record<string, string>;
  tables: string[];
  migrations: string[];
  permissions: DeclaredPermissions | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: NormalizedManifest | null;
}

export const KON_ID = /^kon-[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE = /^!?[a-z0-9*][a-z0-9*:._-]{0,127}$/;
const HOST =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(:\d{1,5})?$/;
const OP_ID = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.sql$/;

/** Kons that come with the core: a dependency on them is satisfied by the core. */
export const CORE_KONS = new Set(["kon-datasets", "kon-media", "kon-blocks"]);

// Well-known SPDX ids. An expression with an id outside this list is accepted
// with a warning (the full list has 600+ ids); `LicenseRef-*` is always valid.
const KNOWN_SPDX = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "0BSD",
  "Unlicense",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "EUPL-1.2",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "BUSL-1.1",
  "Zlib",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "Elastic-2.0",
  "SSPL-1.0",
]);
const SPDX_EXCEPTIONS = new Set(["Classpath-exception-2.0", "LLVM-exception", "GCC-exception-3.1"]);

/**
 * Syntax check of an SPDX license expression (`MIT`, `MIT OR Apache-2.0`,
 * `(GPL-2.0-only WITH Classpath-exception-2.0)`, `LicenseRef-Acme`).
 * Returns the unknown ids (for a warning) or throws on bad syntax.
 */
export function validateSpdx(expr: string): { unknownMany: string[] } {
  if (typeof expr !== "string" || !expr.trim() || expr.length > 256)
    throw new Error("empty or too long");
  const tokens = expr.match(/\(|\)|[A-Za-z0-9.+-]+|\S/g) ?? [];
  const unknownMany: string[] = [];
  let i = 0;
  const id = (allowException = false): void => {
    const t = tokens[i++];
    if (!t || !/^[A-Za-z0-9.-]+\+?$/.test(t) || ["AND", "OR", "WITH"].includes(t)) {
      throw new Error(`expected a license id at "${t ?? "end"}"`);
    }
    const withoutMore = t.replace(/\+$/, "");
    if (allowException) {
      if (!SPDX_EXCEPTIONS.has(withoutMore)) unknownMany.push(withoutMore);
    } else if (!withoutMore.startsWith("LicenseRef-") && !KNOWN_SPDX.has(withoutMore)) {
      unknownMany.push(withoutMore);
    }
  };
  const primary = (): void => {
    if (tokens[i] === "(") {
      i++;
      expression();
      if (tokens[i++] !== ")") throw new Error("unbalanced parenthesis");
      return;
    }
    id();
    if (tokens[i] === "WITH") {
      i++;
      id(true);
    }
  };
  const expression = (): void => {
    primary();
    while (tokens[i] === "AND" || tokens[i] === "OR") {
      i++;
      primary();
    }
  };
  expression();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return { unknownMany };
}

/** The admin extension point's rule for an admin asset `src` — do not relax. */
export function isSafeArtifactPath(src: string): boolean {
  if (!src || typeof src !== "string") return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  if (src.startsWith("//")) return false;
  if (src.startsWith("/")) return false;
  if (src.includes("..")) return false;
  if (src.includes("\0") || src.includes("\\")) return false;
  return /\.(js|mjs|css|map)$/.test(src);
}

function text(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function list(x: unknown, field: string, pattern: RegExp, errors: string[]): string[] {
  if (x === undefined) return [];
  if (!Array.isArray(x)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const output: string[] = [];
  for (const v of x) {
    if (typeof v !== "string" || !pattern.test(v))
      errors.push(`${field}: invalid entry ${JSON.stringify(v)}`);
    else if (!output.includes(v)) output.push(v);
  }
  if (output.length > 500) errors.push(`${field}: more than 500 entries`);
  return output.sort();
}

export interface ValidationOptions {
  /** Publishing (or installing from a registry) requires license + permissions. */
  forPublish?: boolean;
  /** package.json of the kon, if any (version, license, author, repository, scripts). */
  package?: Record<string, unknown> | null;
  /** Files under migrations/ (pack time). */
  migrations?: string[];
}

/**
 * Validates and normalizes a kon.json (+ its package.json). Never throws: the
 * result lists every error, so `kon publish` can show all of them at once.
 */
export function validateManifest(raw: unknown, o: ValidationOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["kon.json is not a JSON object"], warnings, manifest: null };
  }
  const m = raw as Record<string, any>;
  const pkg = (o.package ?? null) as Record<string, any> | null;

  if (m.manifest !== undefined && m.manifest !== MANIFEST_SPEC_VERSION) {
    errors.push(
      `manifest: this CLI understands spec version ${MANIFEST_SPEC_VERSION}, the kon declares ${JSON.stringify(m.manifest)}`
    );
  }

  const id = text(m.id);
  if (!id || !KON_ID.test(id))
    errors.push(`id: must match ${KON_ID} (got ${JSON.stringify(m.id)})`);

  const version = text(m.version) ?? text(pkg?.version);
  if (!version || !valid(version))
    errors.push(`version: must be semver (got ${JSON.stringify(m.version)})`);
  if (pkg?.version && m.version && pkg.version !== m.version) {
    (o.forPublish ? errors : warnings).push(
      `version: kon.json says ${m.version} and package.json says ${pkg.version}; they must match`
    );
  }

  const name = text(m.name);
  if (!name) errors.push("name: required");
  const description = text(m.description) ?? text(pkg?.description);
  if (!description) errors.push("description: required");

  let sdk: number | null = null;
  if (m.sdk !== undefined) {
    if (!Number.isInteger(m.sdk) || m.sdk < 1) errors.push(`sdk: must be an integer >= 1`);
    else sdk = m.sdk;
  } else if (o.forPublish) {
    errors.push("sdk: required to publish (the kon SDK version the kon is written for)");
  }

  let kitsuden: string | null =
    text(m.kitsuden) ??
    text(m.compatibility?.kitsuden) ??
    (text(pkg?.kitsuden?.minVersion) ? `>=${pkg!.kitsuden.minVersion}` : null);
  if (kitsuden && !validRange(kitsuden)) {
    errors.push(`kitsuden: not a semver range (${JSON.stringify(kitsuden)})`);
    kitsuden = null;
  }
  if (!kitsuden && o.forPublish)
    errors.push('kitsuden: required to publish (core compatibility range, e.g. ">=0.9.0 <2")');

  const license = text(m.license) ?? text(pkg?.license);
  if (license) {
    try {
      const { unknownMany } = validateSpdx(license);
      if (unknownMany.length)
        warnings.push(`license: not a well-known SPDX id: ${unknownMany.join(", ")}`);
    } catch (e) {
      errors.push(`license: not an SPDX expression (${(e as Error).message})`);
    }
  } else if (o.forPublish) {
    errors.push(
      'license: required to publish (an SPDX expression such as "MIT"; "LicenseRef-<name>" for your own)'
    );
  }

  let author: NormalizedManifest["author"] = null;
  const a = m.author ?? pkg?.author;
  if (typeof a === "string" && a.trim()) author = { name: a.trim() };
  else if (a && typeof a === "object" && text(a.name)) {
    author = {
      name: a.name.trim(),
      ...(text(a.email) ? { email: a.email } : {}),
      ...(text(a.url) ? { url: a.url } : {}),
    };
  } else if (a !== undefined) errors.push("author: must be a string or {name, email?, url?}");
  if (!author && o.forPublish) errors.push("author: required to publish");

  let repository: NormalizedManifest["repository"] = null;
  const r = m.repository ?? pkg?.repository;
  if (typeof r === "string" && r.trim()) repository = { url: r.trim() };
  else if (r && typeof r === "object" && text(r.url)) {
    repository = {
      ...(text(r.type) ? { type: r.type } : {}),
      url: r.url,
      ...(text(r.directory) ? { directory: r.directory } : {}),
    };
  } else if (r !== undefined)
    errors.push("repository: must be a URL string or {type?, url, directory?}");
  if (repository && !/^(https:\/\/|git\+https:\/\/|git@|ssh:\/\/)/.test(repository.url)) {
    warnings.push(`repository: ${repository.url} is not an https/ssh URL`);
  }
  if (!repository && o.forPublish) warnings.push("repository: not declared (recommended)");

  const dependencies: Record<string, string> = {};
  const d = m.dependencies;
  const deps = Array.isArray(d) ? d : d?.kons;
  const ranges = !Array.isArray(d) && d?.versions !== undefined ? d.versions : {};
  if (!ranges || typeof ranges !== "object" || Array.isArray(ranges))
    errors.push("dependencies.versions: must be an {id: range} object");
  if (Array.isArray(deps)) {
    for (const x of deps) {
      if (typeof x !== "string" || !KON_ID.test(x))
        errors.push(`dependencies.kons: invalid id ${JSON.stringify(x)}`);
      else dependencies[x] = "*";
    }
    for (const [k, v] of Object.entries((ranges ?? {}) as Record<string, unknown>)) {
      if (!(k in dependencies))
        errors.push(`dependencies.versions.${k}: not listed in dependencies.kons`);
      else if (typeof v !== "string" || !validRange(v))
        errors.push(`dependencies.versions.${k}: not a semver range`);
      else dependencies[k] = v;
    }
  } else if (deps && typeof deps === "object") {
    if (o.forPublish) {
      errors.push(
        "dependencies.kons: must be an array of ids (the API loader, `kon add --from` and the Docker installer read it); " +
          'put version ranges in dependencies.versions, e.g. {"kons": ["kon-a"], "versions": {"kon-a": "^1.2.0"}}'
      );
    }
    for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
      if (!KON_ID.test(k)) errors.push(`dependencies.kons: invalid id ${JSON.stringify(k)}`);
      else if (typeof v !== "string" || !validRange(v))
        errors.push(`dependencies.kons.${k}: not a semver range`);
      else dependencies[k] = v;
    }
  } else if (deps !== undefined)
    errors.push("dependencies.kons: must be an array of ids or an {id: range} object");
  if (id && dependencies[id]) errors.push("dependencies.kons: a kon cannot depend on itself");

  // Only `dependencies.kons` reaches the signed manifest. Older manifests also
  // spell dependencies as `dependencies.required`, or as `@kitsuden/kon-*` in
  // package.json. The installer used to follow those too, so a package could pull
  // in a "dependency" the signed index and the permission prompt never showed.
  const outsideManifest = (x: string, field: string): void => {
    if (x in dependencies || CORE_KONS.has(x)) return;
    (o.forPublish ? errors : warnings).push(
      `${field}: ${x} must also be listed in dependencies.kons`
    );
  };
  const requiredValues = !Array.isArray(d) && d?.required !== undefined ? d.required : [];
  if (!Array.isArray(requiredValues)) errors.push("dependencies.required: must be an array of ids");
  else {
    for (const x of requiredValues) {
      if (typeof x !== "string" || !KON_ID.test(x))
        errors.push(`dependencies.required: invalid id ${JSON.stringify(x)}`);
      else outsideManifest(x, "dependencies.required");
    }
  }
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg?.[field] ?? {})) {
      if (!name.startsWith("@kitsuden/kon-")) continue;
      const dep = name.slice("@kitsuden/".length);
      if (!KON_ID.test(dep))
        errors.push(`package.json ${field}: invalid kon package ${JSON.stringify(name)}`);
      else outsideManifest(dep, `package.json ${field}`);
    }
  }

  const tables: string[] = [];
  if (m.tables !== undefined) {
    if (!Array.isArray(m.tables)) errors.push("tables: must be an array");
    else {
      for (const t of m.tables) {
        const n = typeof t === "string" ? t : t?.name;
        if (typeof n !== "string" || !TABLE.test(n))
          errors.push(`tables: invalid table ${JSON.stringify(n)}`);
        else if (!tables.includes(n)) tables.push(n);
      }
    }
  }
  tables.sort();

  const migrations = (o.migrations ??
    (Array.isArray(m.migrations) ? m.migrations : [])) as unknown[];
  const validMigrations: string[] = [];
  for (const f of migrations) {
    if (typeof f !== "string" || !MIGRATION.test(f))
      errors.push(`migrations: invalid file name ${JSON.stringify(f)}`);
    else validMigrations.push(f);
  }
  validMigrations.sort();

  let permissions: DeclaredPermissions | null = null;
  if (m.permissions !== undefined) {
    const p = m.permissions;
    if (!p || typeof p !== "object" || Array.isArray(p))
      errors.push("permissions: must be an object");
    else {
      for (const k of Object.keys(p)) {
        if (!["scopes", "hosts", "sensitive"].includes(k))
          errors.push(`permissions.${k}: unknown field`);
      }
      permissions = {
        scopes: list(p.scopes, "permissions.scopes", SCOPE, errors),
        hosts: list(
          Array.isArray(p.hosts)
            ? p.hosts.map((h: unknown) => (typeof h === "string" ? h.toLowerCase() : h))
            : p.hosts,
          "permissions.hosts",
          HOST,
          errors
        ),
        sensitive: list(p.sensitive, "permissions.sensitive", OP_ID, errors),
      };
      if (permissions.hosts.includes("*"))
        errors.push("permissions.hosts: a bare * is not allowed");
    }
  } else if (o.forPublish) {
    errors.push(
      'permissions: required to publish — {"scopes": [], "hosts": [], "sensitive": []} (empty lists are an explicit "none")'
    );
  }

  // Admin views: same rule as the admin extension point.
  const views = m.admin?.views;
  if (Array.isArray(views)) {
    for (const v of views) {
      if (v?.type === "element" && !isSafeArtifactPath(String(v.src ?? "").replace(/^\.\//, ""))) {
        errors.push(
          `admin.views[${v.id}].src: ${JSON.stringify(v.src)} is not a safe asset path (relative, no "..", .js/.mjs/.css/.map)`
        );
      }
    }
  }

  // No install scripts: pnpm runs a workspace package's lifecycle scripts.
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts) : [];
  const forbiddenItems = scripts.filter((s) => FORBIDDEN_SCRIPTS.has(s));
  if (forbiddenItems.length) {
    errors.push(
      `package.json: lifecycle scripts are not allowed in a published kon (${forbiddenItems.join(", ")})`
    );
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    manifest: ok
      ? {
          manifest: MANIFEST_SPEC_VERSION,
          id: id!,
          name: name!,
          version: version!,
          description: description!,
          sdk,
          kitsuden,
          license,
          author,
          repository,
          dependencies,
          tables,
          migrations: validMigrations,
          permissions,
        }
      : null,
  };
}

/** npm/pnpm lifecycle scripts that run on install, pack or publish. */
export const FORBIDDEN_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
  "prepack",
  "postpack",
  "pnpm:devPreinstall",
  "dependencies",
]);

/** Does this core version satisfy the kon's `kitsuden` range? (pre-release tag ignored) */
export function compatibleWithTheCore(range: string | null, coreVersion: string | null): boolean {
  if (!range || !coreVersion) return true;
  const v = coerceRelease(coreVersion);
  return v ? satisfies(v, range) : false;
}
