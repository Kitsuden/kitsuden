/**
 * The signed kon registry — manifest, signatures, tarballs, resolution, lockfile
 * and the CLI end to end, on a fake project and a local registry in a temp dir.
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/registry.test.mjs
 *
 * Keys are generated into the temp dir for each run: nothing is written to the
 * repository.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const DIST = resolve(import.meta.dirname, "..", "dist");
const CLI = join(DIST, "index.js");
const m = (p) => import(new URL(`file:///${join(DIST, p).replace(/\\/g, "/")}`).href);

const semver = await m("registry/semver.js");
const manifest = await m("registry/manifest.js");
const signature = await m("registry/signature.js");
const tar = await m("registry/tar.js");
const permissions = await m("registry/permissions.js");
const resolverM = await m("registry/resolver.js");

let base;
before(() => {
  assert.ok(existsSync(CLI), "build the CLI first: pnpm --filter @kitsuden/cli build");
  base = mkdtempSync(join(tmpdir(), "kr-registro-"));
});
after(() => base && rmSync(base, { recursive: true, force: true }));

function write(route, content) {
  mkdirSync(join(route, ".."), { recursive: true });
  writeFileSync(route, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

const PUBLISHABLE = {
  id: "kon-demo",
  name: "Demo",
  description: "A demo kon",
  version: "1.0.0",
  sdk: 1,
  kitsuden: ">=0.9.0",
  license: "MIT",
  author: "Tester",
  repository: "https://example.com/demo.git",
  permissions: { scopes: [], hosts: [], sensitive: [] },
};

// ── Manifest ────────────────────────────────────────────────────────────────

describe("manifest spec v1", () => {
  it("normalizes what existing kons declare (array deps, compatibility.kitsuden, table objects)", () => {
    const r = manifest.validateManifest({
      id: "kon-blog",
      name: "Blog",
      description: "x",
      version: "2.0.0",
      sdk: 1,
      compatibility: { kitsuden: ">=0.8.0" },
      dependencies: { kons: ["kon-media"], core: ["auth"] },
      tables: ["blog_posts", { name: "blog_tags", label: "Tags" }],
    });
    assert.ok(r.ok, r.errors.join("; "));
    assert.equal(r.manifest.kitsuden, ">=0.8.0");
    assert.deepEqual(r.manifest.dependencies, { "kon-media": "*" });
    assert.deepEqual(r.manifest.tables, ["blog_posts", "blog_tags"]);
    assert.equal(r.manifest.permissions, null);
  });

  it("publishing requires license, sdk, kitsuden range, author and an explicit permissions block", () => {
    const r = manifest.validateManifest(
      { id: "kon-x", name: "X", description: "x", version: "1.0.0" },
      { forPublish: true }
    );
    assert.equal(r.ok, false);
    const t = r.errors.join("\n");
    for (const field of ["license", "sdk", "kitsuden", "author", "permissions"])
      assert.match(t, new RegExp(field));
    assert.ok(manifest.validateManifest(PUBLISHABLE, { forPublish: true }).ok);
  });

  it("rejects bad ids, versions, SPDX, ranges, scopes and hosts", () => {
    const bad = (extra) =>
      manifest.validateManifest({ ...PUBLISHABLE, ...extra }, { forPublish: true });
    assert.equal(bad({ id: "Demo" }).ok, false);
    assert.equal(bad({ version: "1.0" }).ok, false);
    assert.equal(bad({ license: "MIT OR" }).ok, false);
    assert.equal(bad({ license: "(MIT" }).ok, false);
    assert.ok(bad({ license: "(MIT OR Apache-2.0) AND LicenseRef-Acme" }).ok);
    assert.equal(bad({ kitsuden: ">=banana" }).ok, false);
    assert.equal(
      bad({ dependencies: { kons: ["kon-a"], versions: { "kon-a": "^banana" } } }).ok,
      false
    );
    assert.equal(
      bad({ dependencies: { kons: [], versions: { "kon-a": "^1" } } }).ok,
      false,
      "range for an unlisted kon"
    );
    assert.equal(
      bad({ dependencies: { kons: { "kon-a": "^1" } } }).ok,
      false,
      "object form is not publishable"
    );
    assert.deepEqual(
      bad({ dependencies: { kons: ["kon-a"], versions: { "kon-a": "^1.2" } } }).manifest
        .dependencies,
      { "kon-a": "^1.2" }
    );
    assert.equal(
      bad({ permissions: { scopes: ["Bad Scope"], hosts: [], sensitive: [] } }).ok,
      false
    );
    assert.equal(
      bad({ permissions: { scopes: [], hosts: ["https://x.com"], sensitive: [] } }).ok,
      false
    );
    assert.equal(bad({ permissions: { scopes: [], hosts: ["*"], sensitive: [] } }).ok, false);
    assert.equal(
      bad({ permissions: { scopes: [], hosts: [], sensitive: [], extra: [] } }).ok,
      false
    );
    assert.equal(bad({ dependencies: { kons: ["kon-demo"] } }).ok, false, "self dependency");
  });

  it("keeps the admin extension point's src rule (no .., no absolute, no URL, only js/css)", () => {
    for (const src of [
      "../../etc/passwd.js",
      "/abs.js",
      "https://cdn.x/a.js",
      "a\\b.js",
      "view.html",
      "x.ts",
    ]) {
      const r = manifest.validateManifest(
        { ...PUBLISHABLE, admin: { views: [{ id: "v", type: "element", element: "x-y", src }] } },
        { forPublish: true }
      );
      assert.equal(r.ok, false, src);
    }
    assert.ok(
      manifest.validateManifest(
        {
          ...PUBLISHABLE,
          admin: { views: [{ id: "v", type: "element", element: "x-y", src: "./admin/v.js" }] },
        },
        { forPublish: true }
      ).ok
    );
  });

  it("refuses lifecycle (install) scripts in package.json", () => {
    const r = manifest.validateManifest(PUBLISHABLE, {
      forPublish: true,
      package: { version: "1.0.0", scripts: { build: "tsc", postinstall: "node evil.js" } },
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /postinstall/);
  });

  it("core compatibility ignores the core's pre-release tag (0.9.0-beta satisfies >=0.9.0)", () => {
    assert.ok(manifest.compatibleWithTheCore(">=0.9.0", "0.9.0-beta"));
    assert.equal(manifest.compatibleWithTheCore(">=1.0.0", "0.9.0-beta"), false);
  });
});

// ── Semver ──────────────────────────────────────────────────────────────────

describe("semver", () => {
  const cases = [
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.9.9", "1.x", true],
    ["2.0.0-beta.1", "<2.0.0", false],
    ["2.0.0-beta.1", "^2.0.0-beta.0", true],
    ["2.0.0-beta.1", "*", false],
    ["1.5.0", ">=1.0.0 <2", true],
    ["3.0.0", "1.x || >=3", true],
    ["1.5.0", "1.0.0 - 1.4.0", false],
    ["1.4.0", "1.0.0 - 1.4", true],
    ["1.0.0", "=1.0.0", true],
  ];
  for (const [v, r, expected] of cases) {
    it(`${v} ${expected ? "satisfies" : "does not satisfy"} ${r}`, () =>
      assert.equal(semver.satisfies(v, r), expected));
  }
  it("maxSatisfying picks the highest", () => {
    assert.equal(semver.maxSatisfying(["1.0.0", "1.4.0", "2.0.0", "1.10.0"], "^1"), "1.10.0");
  });
});

// ── Signatures ──────────────────────────────────────────────────────────────

describe("signatures (minisign format, Ed25519)", () => {
  const { publicKey: publicKeyPem, secretKey: secret } = signature.generateKeys();
  const other = signature.generateKeys();
  const data = Buffer.from("kon package bytes");

  it("verifies and returns the signed comment", () => {
    const s = signature.signData(
      data,
      signature.readSecretKey(secret),
      "kitsuden-kon id=kon-a version=1.0.0"
    );
    assert.equal(
      signature.verifySignature(data, s, signature.readPublicKey(publicKeyPem)),
      "kitsuden-kon id=kon-a version=1.0.0"
    );
  });

  it("fails on tampered data", () => {
    const s = signature.signData(data, signature.readSecretKey(secret), "c");
    assert.throws(
      () =>
        signature.verifySignature(
          Buffer.from("kon package bytez"),
          s,
          signature.readPublicKey(publicKeyPem)
        ),
      /does not match/
    );
  });

  it("fails with the wrong key", () => {
    const s = signature.signData(data, signature.readSecretKey(secret), "c");
    assert.throws(
      () => signature.verifySignature(data, s, signature.readPublicKey(other.publicKey)),
      /expected/
    );
  });

  it("fails with the wrong key even if the key id is forged to match", () => {
    const s = signature.signData(data, signature.readSecretKey(secret), "c");
    const real = signature.readPublicKey(publicKeyPem);
    const fake = { keyId: real.keyId, key: signature.readPublicKey(other.publicKey).key };
    assert.throws(() => signature.verifySignature(data, s, fake), /does not match/);
  });

  it("fails when the trusted comment is edited", () => {
    const s = signature.signData(
      data,
      signature.readSecretKey(secret),
      "kitsuden-kon id=kon-a version=1.0.0"
    );
    const edited = s.replace("version=1.0.0", "version=9.9.9");
    assert.throws(
      () => signature.verifySignature(data, edited, signature.readPublicKey(publicKeyPem)),
      /trusted comment/
    );
  });

  it("an encrypted secret key needs its passphrase", () => {
    const c = signature.generateKeys("correct horse");
    assert.throws(() => signature.readSecretKey(c.secretKey), /encrypted/);
    assert.throws(() => signature.readSecretKey(c.secretKey, "wrong"), /could not open/);
    assert.ok(signature.readSecretKey(c.secretKey, "correct horse"));
  });
});

// ── Tarballs ────────────────────────────────────────────────────────────────

/** A raw tar entry with any type and name (to craft hostile archives). */
function input(name, data = Buffer.alloc(0), type = "0", link = "") {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let s = 0;
  for (const x of h) s += x;
  h.write(s.toString(8).padStart(6, "0") + "\0 ", 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([h, data, padding]);
}
const tgzOf = (...inputs) => gzipSync(Buffer.concat([...inputs, Buffer.alloc(1024, 0)]));

describe("package tarballs", () => {
  it("are deterministic and round-trip", () => {
    const f = [
      { path: "kon.json", data: Buffer.from("{}") },
      { path: "src/a.ts", data: Buffer.from("export {}") },
    ];
    const a = tar.packFiles(f);
    const b = tar.packFiles([...f].reverse());
    assert.ok(a.equals(b));
    assert.deepEqual(
      tar.readPackage(a).map((x) => x.path),
      ["kon.json", "src/a.ts"]
    );
    assert.equal(tar.filesFingerprint(tar.readPackage(a)), tar.filesFingerprint(f));
  });

  const hostiles = [
    ["path traversal", input("package/../../evil.js", Buffer.from("x")), /traversal/],
    ["absolute path", input("/etc/passwd", Buffer.from("x")), /outside package/],
    ["windows drive", input("package/C:/x.js", Buffer.from("x")), /forbidden character|absolute/],
    ["backslash", input("package/a\\..\\..\\x.js", Buffer.from("x")), /forbidden character/],
    [
      "symlink",
      input("package/link", Buffer.alloc(0), "2", "/etc/passwd"),
      /links are not allowed/,
    ],
    [
      "hard link",
      input("package/link", Buffer.alloc(0), "1", "package/kon.json"),
      /links are not allowed/,
    ],
    ["device", input("package/dev", Buffer.alloc(0), "3"), /not allowed/],
    ["pax header", input("package/x", Buffer.from("30 path=../../x\n"), "x"), /not allowed/],
    ["reserved name", input("package/CON.js", Buffer.from("x")), /reserved/],
    ["outside package/", input("other/x.js", Buffer.from("x")), /outside package/],
  ];
  for (const [name, e, error] of hostiles) {
    it(`rejects a ${name} entry`, () => assert.throws(() => tar.readPackage(tgzOf(e)), error));
  }

  it("rejects case-insensitive duplicates", () => {
    const t = tgzOf(
      input("package/Kon.json", Buffer.from("a")),
      input("package/kon.json", Buffer.from("b"))
    );
    assert.throws(() => tar.readPackage(t), /duplicate/);
  });

  it("rejects a corrupted header checksum", () => {
    const e = input("package/a.js", Buffer.from("x"));
    e[0] = "b".charCodeAt(0);
    assert.throws(() => tar.readPackage(tgzOf(e)), /checksum/);
  });

  it("rejects a gzip bomb beyond the expanded limit", () => {
    const large = Buffer.alloc(tar.LIMITS.expanded + 1024 * 1024, 0);
    assert.throws(() => tar.readPackage(gzipSync(large)), /expands beyond/);
  });

  it("extracts only into a new empty folder, never through an existing file", () => {
    const target = join(base, "extraer");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "ya.txt"), "x");
    assert.throws(
      () => tar.extract([{ path: "a.js", data: Buffer.from("x") }], target),
      /not empty/
    );
  });

  it("packing refuses symlinks and secret-looking files", (t) => {
    const dir = join(base, "pack-src");
    write(join(dir, "kon.json"), "{}");
    write(join(dir, ".env"), "SECRET=1");
    assert.throws(() => tar.filesToPackage(dir), /secret/);
    rmSync(join(dir, ".env"));
    write(join(dir, ".env.example"), "SECRET=");
    assert.equal(tar.filesToPackage(dir).length, 2);
    try {
      symlinkSync(join(dir, "kon.json"), join(dir, "enlace.json"), "file");
    } catch {
      t.skip("no symlink privilege on this machine");
      return;
    }
    assert.throws(() => tar.filesToPackage(dir), /symlinks/);
  });
});

// ── Permission diff ─────────────────────────────────────────────────────────

describe("permission diff", () => {
  const mf = (p, extra = {}) => ({
    ...manifest.validateManifest({ ...PUBLISHABLE, permissions: p, ...extra }).manifest,
  });
  it("wildcards cover narrower scopes and hosts", () => {
    const d = permissions.permissionsDiff(
      { manifest: mf({ scopes: ["datasets:*:read"], hosts: ["*.example.com"], sensitive: [] }) },
      {
        manifest: mf(
          { scopes: ["datasets:clients:read"], hosts: ["api.example.com"], sensitive: [] },
          { version: "1.1.0" }
        ),
      }
    );
    assert.equal(permissions.wide(d), false);
  });
  it("new scopes, hosts, sensitive ops and dropped denials widen", () => {
    const before = mf({ scopes: ["kon:demo:read", "!kon:demo:delete"], hosts: [], sensitive: [] });
    for (const p of [
      { scopes: ["kon:demo:read", "kon:demo:write", "!kon:demo:delete"], hosts: [], sensitive: [] },
      { scopes: ["kon:demo:read", "!kon:demo:delete"], hosts: ["evil.example"], sensitive: [] },
      { scopes: ["kon:demo:read", "!kon:demo:delete"], hosts: [], sensitive: ["borrar-todo"] },
      { scopes: ["kon:demo:read"], hosts: [], sensitive: [] },
    ]) {
      assert.equal(
        permissions.wide(
          permissions.permissionsDiff(
            { manifest: before },
            { manifest: mf(p, { version: "2.0.0" }) }
          )
        ),
        true,
        JSON.stringify(p)
      );
    }
  });
});

// ── Resolver ────────────────────────────────────────────────────────────────

function indexOf(kons, advisories = []) {
  const k = {};
  for (const [id, versions] of Object.entries(kons)) {
    k[id] = { owners: ["K"], versions: {} };
    for (const [v, extra] of Object.entries(versions)) {
      const { yanked, kitsuden, ...mextra } = extra;
      k[id].versions[v] = {
        yanked: Boolean(yanked),
        keyId: "K",
        manifest: {
          id,
          version: v,
          sdk: 1,
          kitsuden: kitsuden ?? ">=0.9.0",
          dependencies: {},
          tables: [],
          migrations: [],
          permissions: null,
          ...mextra,
        },
      };
    }
  }
  return {
    format: "kitsuden-kon-index",
    version: 1,
    serial: 1,
    kons: k,
    advisories,
    publishers: {},
    revokedKeys: [],
  };
}

describe("resolution and lockfile", () => {
  const base = { coreVersion: "0.9.0-beta", coreSdk: 1 };
  const plan = (r) => Object.fromEntries(r.plan.map((e) => [e.id, e.version]));

  it("picks the highest version that satisfies every range, dependencies first", () => {
    const index = indexOf({
      "kon-a": { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} },
      "kon-b": { "1.0.0": { dependencies: { "kon-a": "^1.2.0" } } },
    });
    const r = resolverM.resolver({ ...base, index, requested: { "kon-b": "*" } });
    assert.deepEqual(plan(r), { "kon-a": "1.5.0", "kon-b": "1.0.0" });
    assert.equal(r.plan[0].id, "kon-a");
  });

  it("reports a conflict with who asked for what", () => {
    const index = indexOf({
      "kon-a": { "1.0.0": {}, "2.0.0": {} },
      "kon-b": { "1.0.0": { dependencies: { "kon-a": "^1" } } },
    });
    assert.throws(
      () => resolverM.resolver({ ...base, index, requested: { "kon-b": "*", "kon-a": "^2" } }),
      /no version of kon-a fits[\s\S]*kon-b@1.0.0/
    );
  });

  it("refuses yanked versions", () => {
    const index = indexOf({ "kon-a": { "1.0.0": { yanked: true } } });
    assert.throws(
      () => resolverM.resolver({ ...base, index, requested: { "kon-a": "1.0.0" } }),
      /yanked/
    );
  });

  it("keeps a yanked version the lockfile pins (warning), but update refuses it", () => {
    const index = indexOf({ "kon-a": { "1.0.0": { yanked: true }, "0.9.0": {} } });
    const blocking = {
      lockfileVersion: 1,
      registries: {},
      kons: { "kon-a": { version: "1.0.0" } },
    };
    const r = resolverM.resolver({ ...base, index, requested: { "kon-a": "*" }, blocking });
    assert.equal(plan(r)["kon-a"], "1.0.0");
    assert.match(r.warnings.join(), /yanked/);
    const u = resolverM.resolver({
      ...base,
      index,
      requested: { "kon-a": "*" },
      blocking,
      update: "all",
    });
    assert.equal(plan(u)["kon-a"], "0.9.0");
  });

  it("refuses revoked versions even when locked", () => {
    const index = indexOf({ "kon-a": { "1.0.0": {} } }, [
      {
        id: "KKA-1",
        kon: "kon-a",
        versions: "<=1.0.0",
        severity: "critical",
        summary: "backdoor",
        revoked: true,
      },
    ]);
    const blocking = {
      lockfileVersion: 1,
      registries: {},
      kons: { "kon-a": { version: "1.0.0" } },
    };
    assert.throws(
      () => resolverM.resolver({ ...base, index, requested: { "kon-a": "=1.0.0" }, blocking }),
      /revoked/
    );
  });

  it("skips versions for a newer core or SDK", () => {
    const index = indexOf({
      "kon-a": { "1.0.0": {}, "2.0.0": { kitsuden: ">=1.0.0" }, "3.0.0": { sdk: 2 } },
    });
    assert.equal(
      plan(resolverM.resolver({ ...base, index, requested: { "kon-a": "*" } }))["kon-a"],
      "1.0.0"
    );
  });

  it("prefers the locked version until update lifts it", () => {
    const index = indexOf({ "kon-a": { "1.0.0": {}, "1.1.0": {} } });
    const blocking = {
      lockfileVersion: 1,
      registries: {},
      kons: { "kon-a": { version: "1.0.0" } },
    };
    assert.equal(
      plan(resolverM.resolver({ ...base, index, requested: { "kon-a": "^1" }, blocking }))["kon-a"],
      "1.0.0"
    );
    assert.equal(
      plan(
        resolverM.resolver({
          ...base,
          index,
          requested: { "kon-a": "^1" },
          blocking,
          update: new Set(["kon-a"]),
        })
      )["kon-a"],
      "1.1.0"
    );
  });

  it("core kons and source-installed kons satisfy dependencies", () => {
    const index = indexOf({
      "kon-b": { "1.0.0": { dependencies: { "kon-media": "*", "kon-local": "^1" } } },
    });
    const r = resolverM.resolver({
      ...base,
      index,
      requested: { "kon-b": "*" },
      installedOutside: { "kon-local": "1.2.0" },
    });
    assert.deepEqual(plan(r), { "kon-b": "1.0.0" });
    assert.throws(
      () =>
        resolverM.resolver({
          ...base,
          index,
          requested: { "kon-b": "*" },
          installedOutside: { "kon-local": "0.1.0" },
        }),
      /installed from a source folder/
    );
  });

  it("parses id@range requests", () => {
    const id = (n) => (n.startsWith("kon-") ? n : `kon-${n}`);
    assert.deepEqual(resolverM.readRequest("blog@^2.1", id), { id: "kon-blog", range: "^2.1" });
    assert.deepEqual(resolverM.readRequest("blog", id), { id: "kon-blog", range: "*" });
  });
});

// ── CLI end to end ──────────────────────────────────────────────────────────

describe("kitsuden kon (registry) end to end", () => {
  let project, registry, sources, keys;

  const cli = (args, env = {}) =>
    spawnSync(process.execPath, [CLI, "kon", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        KITSUDEN_API_URL: "",
        KITSUDEN_KONS_SOURCE: "",
        KITSUDEN_PUBLIC: "",
        KITSUDEN_KON_REGISTRY: "",
        ...env,
      },
    });
  const inProject = (args, env) => cli([...args, "--root", project], env);
  const declaredAll = () =>
    JSON.parse(readFileSync(join(project, "kitsuden.kons.json"), "utf8")).kons;
  const blocking = () => JSON.parse(readFileSync(join(project, "kitsuden.kons.lock"), "utf8"));

  function sourceKon(id, version, extra = {}) {
    const dir = join(sources, `${id}-${version}`);
    rmSync(dir, { recursive: true, force: true });
    write(join(dir, "kon.json"), {
      ...PUBLISHABLE,
      id,
      name: id,
      version,
      tables: [`${id.replace(/-/g, "_")}_items`],
      ...extra,
    });
    write(join(dir, "package.json"), {
      name: `@kitsuden/${id}`,
      version,
      scripts: { build: "tsc" },
    });
    write(join(dir, "index.ts"), `export const kon = "${id}@${version}";\n`);
    write(
      join(dir, "migrations", "0001_init.sql"),
      `CREATE TABLE IF NOT EXISTS ${id.replace(/-/g, "_")}_items (id int);\n`
    );
    write(join(dir, "node_modules", "junk", "x.js"), "never packed");
    return dir;
  }
  const publish = (dir, ...extra) =>
    cli([
      "publish",
      dir,
      "--registry",
      registry,
      "--key",
      keys.editor + ".key",
      "--index-key",
      keys.registry + ".key",
      ...extra,
    ]);

  before(() => {
    project = join(base, "proyecto");
    registry = join(base, "record");
    sources = join(base, "fuentes");
    const k = join(base, "claves");
    keys = { editor: join(k, "editor"), registry: join(k, "record"), other: join(k, "otra") };
    write(join(project, "package.json"), {
      name: "kitsuden",
      version: "0.9.0-beta",
      private: true,
    });
    write(join(project, "pnpm-workspace.yaml"), 'packages:\n  - "packages/kons/*"\n');
    write(join(project, "packages", "kons", "package.json"), {
      name: "@kitsuden/kons",
      private: true,
    });
    write(
      join(project, "packages", "shared", "src", "operations.ts"),
      "export const KONS_SDK_VERSION = 1;\n"
    );
    write(
      join(project, "apps", "api", "scripts", "migrate.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync("migrate-args.json", JSON.stringify(process.argv.slice(2)));\n`
    );
    for (const c of Object.values(keys)) {
      const r = cli(["keygen", "--out", c]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    }
    const pub = readFileSync(keys.registry + ".pub", "utf8")
      .trim()
      .split("\n")[1];
    write(join(project, "kitsuden.registries.json"), {
      default: "local",
      registries: { local: { url: registry, key: pub } },
    });
  });

  it("keygen refuses to write a secret key inside a git repository", () => {
    const r = cli(["keygen", "--out", resolve(import.meta.dirname, "no-debe-existir")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /inside a git repository/);
    assert.ok(!existsSync(resolve(import.meta.dirname, "no-debe-existir.key")));
  });

  it("publish refuses a manifest without license and permissions", () => {
    const dir = sourceKon("kon-mal", "1.0.0", { license: undefined, permissions: undefined });
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /license[\s\S]*permissions/);
  });

  it("publishes three kons (one depending on another) into a local registry", () => {
    let r = publish(sourceKon("kon-base", "1.0.0"));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = publish(sourceKon("kon-base", "1.2.0"));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = publish(
      sourceKon("kon-app", "1.0.0", {
        dependencies: { kons: ["kon-base", "kon-media"], versions: { "kon-base": "^1.1.0" } },
        permissions: { scopes: ["kon:app:read"], hosts: ["api.example.com"], sensitive: [] },
      })
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = publish(sourceKon("kon-solo", "1.0.0"));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const index = JSON.parse(readFileSync(join(registry, "index.json"), "utf8"));
    assert.deepEqual(Object.keys(index.kons).sort(), ["kon-app", "kon-base", "kon-solo"]);
    assert.ok(existsSync(join(registry, "index.json.minisig")));
    assert.ok(existsSync(join(registry, "packages", "kon-app", "kon-app-1.0.0.tgz.minisig")));
    // Immutable versions.
    r = publish(sourceKon("kon-solo", "1.0.0"));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /immutable/);
  });

  it("the same folder packs to the same bytes (deterministic)", () => {
    const dir = sourceKon("kon-det", "1.0.0");
    const a = cli([
      "publish",
      dir,
      "--registry",
      registry,
      "--key",
      keys.editor + ".key",
      "--index-key",
      keys.registry + ".key",
      "--dry-run",
    ]);
    const b = cli([
      "publish",
      dir,
      "--registry",
      registry,
      "--key",
      keys.editor + ".key",
      "--index-key",
      keys.registry + ".key",
      "--dry-run",
    ]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout.match(/sha256 (\w+)/)[1], b.stdout.match(/sha256 (\w+)/)[1]);
  });

  it("another key cannot publish a kon it does not own", () => {
    const r = cli([
      "publish",
      sourceKon("kon-solo", "1.1.0"),
      "--registry",
      registry,
      "--key",
      keys.other + ".key",
      "--index-key",
      keys.registry + ".key",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is owned by/);
  });

  it("search and info read the signed index", () => {
    let r = inProject(["search", "kon-"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kon-app[\s\S]*kon-base/);
    r = inProject(["info", "app"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /api\.example\.com/);
    assert.match(r.stdout, /kon-base@\^1\.1\.0/);
  });

  it("add without a terminal and without --yes shows the permissions and installs nothing", () => {
    const r = inProject(["add", "app", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.match(r.stdout, /api\.example\.com/);
    assert.match(r.stderr, /confirmation required/);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-app")));
    assert.ok(!existsSync(join(project, "kitsuden.kons.lock")));
  });

  it("add --yes installs the kon and its dependency, writes the lockfile and runs the normal runner", () => {
    const r = inProject(["add", "app@^1", "--yes", "--no-install"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const d = declaredAll();
    assert.equal(d["kon-app"].source, "registry:local");
    assert.equal(d["kon-base"].version, "1.2.0");
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-app", "node_modules")));
    const b = blocking();
    assert.equal(b.kons["kon-app"].requested, "^1");
    assert.equal(b.kons["kon-base"].version, "1.2.0");
    assert.equal(
      b.kons["kon-app"].contentHash,
      d["kon-app"].hash,
      "installed copy hash = signed content hash"
    );
    assert.equal(b.kons["kon-app"].license, "MIT");
    assert.match(b.kons["kon-app"].sha256, /^[0-9a-f]{64}$/);
    assert.ok(b.kons["kon-app"].signed);
    const args = JSON.parse(
      readFileSync(join(project, "apps", "api", "migrate-args.json"), "utf8")
    );
    assert.deepEqual(args.sort(), ["--kon", "--kon", "kon-app", "kon-base"].sort());
    const staging = join(project, ".kitsuden", "registry-staging");
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, "staging is cleaned up");
  });

  it("kon list still works and shows the registry kons", () => {
    const r = inProject(["list"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok\s+kon-app/);
  });

  it("verify passes, then fails after an installed file is edited", () => {
    let r = inProject(["verify"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const f = join(project, "packages", "kons", "kon-app", "index.ts");
    const original = readFileSync(f, "utf8");
    writeFileSync(f, original + "// tampered\n");
    r = inProject(["verify"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /differs from the signed package/);
    writeFileSync(f, original);
  });

  it("verify --file checks a package offline with the publisher key", () => {
    const tgz = join(registry, "packages", "kon-solo", "kon-solo-1.0.0.tgz");
    let r = cli(["verify", "--file", tgz, "--key", keys.editor + ".pub"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = cli(["verify", "--file", tgz, "--key", keys.other + ".pub"]);
    assert.notEqual(r.status, 0);
  });

  it("an update that widens hosts is refused with --yes alone and accepted with --accept-wider", () => {
    let r = publish(
      sourceKon("kon-app", "1.1.0", {
        dependencies: { kons: ["kon-base"], versions: { "kon-base": "^1.1.0" } },
        permissions: {
          scopes: ["kon:app:read"],
          hosts: ["api.example.com", "exfil.example.net"],
          sensitive: [],
        },
      })
    );
    assert.equal(r.status, 0, r.stderr);
    r = inProject(["outdated"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kon-app\s+1\.0\.0\s+1\.1\.0/);
    r = inProject(["update", "app", "--yes", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.match(r.stdout, /\+ exfil\.example\.net/);
    assert.match(r.stderr, /accept-wider/);
    assert.equal(blocking().kons["kon-app"].version, "1.0.0");
    r = inProject(["update", "app", "--yes", "--accept-wider", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(blocking().kons["kon-app"].version, "1.1.0");
  });

  it("a tampered tarball is refused and nothing changes", () => {
    const tgz = join(registry, "packages", "kon-solo", "kon-solo-1.0.0.tgz");
    const original = readFileSync(tgz);
    const bad = Buffer.from(original);
    bad[bad.length - 20] ^= 0xff;
    writeFileSync(tgz, bad);
    const before = JSON.stringify(declaredAll());
    const r = inProject(["add", "solo", "--yes", "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /tampered/);
    assert.equal(JSON.stringify(declaredAll()), before);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-solo")));
    writeFileSync(tgz, original);
  });

  it("an edited index (hash swapped by whoever controls the host) is refused", () => {
    // Attacker with write access to the host replaces the package AND the
    // index entry's hash, but cannot sign the index with the registry key.
    const routeIndex = join(registry, "index.json");
    const original = readFileSync(routeIndex);
    const j = JSON.parse(original);
    j.kons["kon-solo"].versions["1.0.0"].sha256 = "0".repeat(64);
    writeFileSync(routeIndex, JSON.stringify(j));
    const r = inProject(["add", "solo", "--yes", "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /registry index signature/);
    writeFileSync(routeIndex, original);
  });

  it("the wrong registry key is refused", () => {
    const r = inProject(["search", "--registry", registry, "--registry-key", keys.other + ".pub"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /registry index signature/);
  });

  it("--allow-unsigned is refused when KITSUDEN_PUBLIC=true", () => {
    const r = inProject(["search", "--allow-unsigned"], { KITSUDEN_PUBLIC: "true" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /KITSUDEN_PUBLIC=true/);
  });

  it("an unsigned package is refused without --allow-unsigned", () => {
    const sig = join(registry, "packages", "kon-solo", "kon-solo-1.0.0.tgz.minisig");
    const original = readFileSync(sig);
    rmSync(sig);
    let r = inProject(["add", "solo", "--yes", "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not signed/);
    r = inProject(["add", "solo", "--yes", "--no-install", "--no-migrate", "--allow-unsigned"], {
      KITSUDEN_PUBLIC: "true",
    });
    assert.notEqual(r.status, 0);
    writeFileSync(sig, original);
  });

  it("a yanked version is refused for a new install", () => {
    let r = cli([
      "yank",
      "kon-solo@1.0.0",
      "--registry",
      registry,
      "--index-key",
      keys.registry + ".key",
      "--reason",
      "broken",
    ]);
    assert.equal(r.status, 0, r.stderr);
    r = inProject(["add", "solo@1.0.0", "--yes", "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /yanked \(broken\)/);
  });

  it("a revoked version is refused even though the lockfile pins it", () => {
    let r = cli([
      "yank",
      "kon-base@1.2.0",
      "--registry",
      registry,
      "--index-key",
      keys.registry + ".key",
      "--revoke",
      "--advisory",
      "malicious build",
      "--severity",
      "critical",
    ]);
    assert.equal(r.status, 0, r.stderr);
    r = inProject(["verify"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REVOKED/);
    r = inProject(["sync", "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /revoked/);
  });

  it("an older index (rollback) is refused once a newer serial was seen", () => {
    const seen = blocking().registries.local.serial;
    assert.ok(seen > 1);
    const b = blocking();
    b.registries.local.serial = seen + 100;
    writeFileSync(join(project, "kitsuden.kons.lock"), JSON.stringify(b));
    const r = inProject(["search"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /rollback/);
    b.registries.local.serial = seen;
    writeFileSync(join(project, "kitsuden.kons.lock"), JSON.stringify(b));
  });

  it("remove drops the kon from the lockfile", () => {
    const r = inProject(["remove", "app", "--no-install"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!blocking().kons["kon-app"]);
  });

  it("source installs (--from) still work alongside the registry", () => {
    const dir = sourceKon("kon-local", "1.0.0");
    const r = inProject(["add", "local", "--from", dir, "--no-install", "--no-migrate"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-local"].mode, "copy");
  });
});

// Hash helper sanity (the content hash equals the copy installer's algorithm).
describe("content hash", () => {
  it("matches path\\0bytes\\0 over sorted files", () => {
    const f = [
      { path: "b", data: Buffer.from("2") },
      { path: "a", data: Buffer.from("1") },
    ];
    const h = createHash("sha256")
      .update("a\0")
      .update("1")
      .update("\0")
      .update("b\0")
      .update("2")
      .update("\0")
      .digest("hex");
    assert.equal(tar.filesFingerprint(f), h);
  });
});
