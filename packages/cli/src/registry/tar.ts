/**
 * Kon packages: a deterministic tarball in, a safe extraction out
 * ============================================================================
 *
 * WRITING (`kon publish`). The same folder always gives the same bytes: plain
 * ustar, entries sorted by path, every file under `package/`, mode 0644, uid/gid
 * 0, mtime 0, no user or group names, no directory entries (the reader creates
 * parents), gzip level 9 with mtime 0 and OS byte 255. Two publishers packing
 * the same commit get the same `sha256` (with the same zlib).
 *
 * What is packed is what `kitsuden kon add --from` copies (no node_modules,
 * dist, .git, coverage, .turbo, *.tsbuildinfo), so the installed copy's hash in
 * kitsuden.kons.json equals the package's `contentHash`. Packing REFUSES
 * symlinks and files that look like secrets (.env, private keys, .npmrc).
 *
 * READING (`kon add`). The archive is untrusted until its signature and hash
 * checked out, and even then it is parsed defensively:
 *
 *   · only regular files and directories; symlinks, hard links, devices, FIFOs,
 *     pax/GNU extension headers are refused (a link entry is how an archive
 *     writes outside its folder on extraction);
 *   · every path must be `package/<relative>` with no empty, `.` or `..`
 *     segment, no backslash, colon, NUL or control character, no Windows
 *     reserved name (CON, NUL, COM1…), no trailing dot or space; duplicates are
 *     refused, case-insensitively (two names that are one file on Windows);
 *   · header checksums are verified; sizes are capped (compressed, expanded,
 *     per file, number of entries);
 *   · extraction goes into a NEW empty folder, files are created with `wx`
 *     (never through an existing file or link), each target is checked to stay
 *     inside the folder before writing, and the result is checked again after
 *     `realpath` — the same three layers as the admin asset route.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync, constants as zlib } from "node:zlib";

export const LIMITS = {
  compressed: 20 * 1024 * 1024,
  expanded: 64 * 1024 * 1024,
  byFile: 16 * 1024 * 1024,
  entries: 10_000,
  path: 255,
};

const NOT_PACKAGED = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

/** Names that must never leave the publisher's machine. */
export function looksLikeSecret(name: string): boolean {
  const n = name.toLowerCase();
  if (n === ".env" || (n.startsWith(".env.") && !/\.(example|sample|template)$/.test(n)))
    return true;
  if (n === ".npmrc" || n === ".pypirc" || n === ".netrc") return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(n)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(n)) return true;
  if (n.endsWith(".minisign_key") || n.endsWith(".kitsuden-key") || n.endsWith(".sec")) return true;
  return false;
}

export class PackageError extends Error {}

export interface PackageFile {
  path: string; // relative, forward slashes
  data: Buffer;
}

/** The files a kon folder publishes, sorted. Refuses symlinks and secrets. */
export function filesToPackage(dir: string): PackageFile[] {
  const output: PackageFile[] = [];
  let total = 0;
  const visit = (actual: string): void => {
    for (const name of readdirSync(actual).sort()) {
      if (NOT_PACKAGED.has(name) || name.endsWith(".tsbuildinfo")) continue;
      const route = join(actual, name);
      const rel = relative(dir, route).split(sep).join("/");
      const st = lstatSync(route);
      if (st.isSymbolicLink()) throw new PackageError(`${rel}: symlinks cannot be published`);
      if (st.isDirectory()) {
        visit(route);
        continue;
      }
      if (!st.isFile()) throw new PackageError(`${rel}: not a regular file`);
      if (looksLikeSecret(name)) {
        throw new PackageError(
          `${rel}: looks like a secret (env file, private key or registry credentials); remove it before publishing`
        );
      }
      validateRelativePath(rel);
      if (st.size > LIMITS.byFile)
        throw new PackageError(`${rel}: larger than ${LIMITS.byFile} bytes`);
      total += st.size;
      if (total > LIMITS.expanded)
        throw new PackageError(`the kon is larger than ${LIMITS.expanded} bytes`);
      output.push({ path: rel, data: readFileSync(route) });
      if (output.length > LIMITS.entries)
        throw new PackageError(`more than ${LIMITS.entries} files`);
    }
  };
  visit(dir);
  return output.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Content hash: the same algorithm as `fingerprintOf` of the copy installer
 * (path, NUL, bytes, NUL; sorted by path), so the installed copy can be checked.
 */
export function filesFingerprint(files: PackageFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path);
    h.update("\0");
    h.update(f.data);
    h.update("\0");
  }
  return h.digest("hex");
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── ustar ───────────────────────────────────────────────────────────────────

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function splitRoute(route: string): { name: string; prefix: string } {
  if (Buffer.byteLength(route) <= 100) return { name: route, prefix: "" };
  for (let i = route.length - 1; i > 0; i--) {
    if (route[i] !== "/") continue;
    const prefix = route.slice(0, i);
    const name = route.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new PackageError(`path too long for the package format: ${route}`);
}

function header(route: string, size: number): Buffer {
  const b = Buffer.alloc(512, 0);
  const { name: name, prefix } = splitRoute(route);
  b.write(name, 0, 100, "utf8");
  b.write(octal(0o644, 8), 100, 8, "ascii");
  b.write(octal(0, 8), 108, 8, "ascii");
  b.write(octal(0, 8), 116, 8, "ascii");
  b.write(octal(size, 12), 124, 12, "ascii");
  b.write(octal(0, 12), 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii");
  b.write("0", 156, 1, "ascii");
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  b.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return b;
}

/** Deterministic `.tgz` of the files, each under `package/`. */
export function packFiles(files: PackageFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    validateRelativePath(f.path);
    parts.push(header(`package/${f.path}`, f.data.length), f.data);
    const padding = (512 - (f.data.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(parts), {
    level: 9,
    memLevel: 9,
    strategy: zlib.Z_DEFAULT_STRATEGY,
  });
  gz.writeUInt32LE(0, 4); // mtime
  gz[9] = 255; // OS: unknown (zlib writes the build platform's)
  return gz;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** A relative path inside a package that is safe on every OS. Throws otherwise. */
export function validateRelativePath(rel: string): void {
  if (!rel || Buffer.byteLength(rel) > LIMITS.path)
    throw new PackageError(`invalid path length: ${JSON.stringify(rel)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(rel))
    throw new PackageError(`forbidden character in path: ${JSON.stringify(rel)}`);
  if (rel.startsWith("/") || /^[a-z]:/i.test(rel))
    throw new PackageError(`absolute path: ${JSON.stringify(rel)}`);
  for (const seg of rel.split("/")) {
    if (!seg || seg === "." || seg === "..")
      throw new PackageError(`path traversal or empty segment: ${JSON.stringify(rel)}`);
    if (/[. ]$/.test(seg))
      throw new PackageError(`segment ends with a dot or space: ${JSON.stringify(rel)}`);
    if (RESERVED_WINDOWS.test(seg))
      throw new PackageError(`reserved file name: ${JSON.stringify(rel)}`);
  }
}

function readString(b: Buffer, start: number, long: number): string {
  const chunk = b.subarray(start, start + long);
  const fin = chunk.indexOf(0);
  return chunk.subarray(0, fin < 0 ? long : fin).toString("utf8");
}

function readOctal(b: Buffer, start: number, long: number): number {
  const s = readString(b, start, long).trim();
  if (!/^[0-7]*$/.test(s)) throw new PackageError("corrupt tar header (number)");
  return s ? parseInt(s, 8) : 0;
}

/** Parses a kon `.tgz` into its files, refusing anything unsafe. Nothing is written. */
export function readPackage(tgz: Buffer): PackageFile[] {
  if (tgz.length > LIMITS.compressed)
    throw new PackageError(`package larger than ${LIMITS.compressed} bytes`);
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: LIMITS.expanded + 2048 });
  } catch (e) {
    throw new PackageError(
      `not a valid gzip package, or it expands beyond ${LIMITS.expanded} bytes (${(e as Error).message})`
    );
  }
  const files: PackageFile[] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== readOctal(h, 148, 8)) throw new PackageError("corrupt tar header (checksum)");
    const type = String.fromCharCode(h[156]!);
    const name = readString(h, 0, 100);
    const prefix = readString(h, 257, 6).startsWith("ustar") ? readString(h, 345, 155) : "";
    const route = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(h, 124, 12);
    pos += 512;
    if (type === "2" || type === "1")
      throw new PackageError(`links are not allowed in a kon package: ${route}`);
    if (type !== "0" && type !== "\0" && type !== "5") {
      throw new PackageError(
        `entry type ${JSON.stringify(type)} is not allowed (only files and folders): ${route}`
      );
    }
    if (!route.startsWith("package/"))
      throw new PackageError(`entry outside package/: ${JSON.stringify(route)}`);
    const rel = route.slice("package/".length).replace(/\/$/, "");
    if (type === "5") {
      if (rel) validateRelativePath(rel);
      if (size !== 0) throw new PackageError(`folder entry with data: ${route}`);
      continue;
    }
    validateRelativePath(rel);
    if (size > LIMITS.byFile) throw new PackageError(`${rel}: larger than ${LIMITS.byFile} bytes`);
    if (pos + size > tar.length) throw new PackageError(`truncated package at ${rel}`);
    const key = rel.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new PackageError(`duplicate entry (case-insensitive): ${rel}`);
    seen.add(key);
    files.push({ path: rel, data: Buffer.from(tar.subarray(pos, pos + size)) });
    if (files.length > LIMITS.entries)
      throw new PackageError(`more than ${LIMITS.entries} entries`);
    pos += Math.ceil(size / 512) * 512;
  }
  // A file that is also used as a folder (`a` and `a/b`) cannot be extracted.
  for (const f of files) {
    const parts = f.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/")))
        throw new PackageError(`${f.path}: a parent is also a file`);
    }
  }
  return files;
}

/** Writes the files into `target`, which must be a new, empty folder. */
export function extract(files: PackageFile[], target: string): void {
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length) throw new PackageError(`extraction folder is not empty: ${root}`);
  const realRoot = realpathSync(root);
  for (const f of files) {
    validateRelativePath(f.path);
    const target = resolve(root, ...f.path.split("/"));
    if (!target.startsWith(root + sep))
      throw new PackageError(`path escapes the package: ${f.path}`);
    const parent = resolve(target, "..");
    mkdirSync(parent, { recursive: true });
    const realParent = realpathSync(parent);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      throw new PackageError(`path escapes the package after realpath: ${f.path}`);
    }
    writeFileSync(target, f.data, { flag: "wx", mode: 0o644 });
  }
}
