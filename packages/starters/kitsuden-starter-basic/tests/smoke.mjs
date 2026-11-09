#!/usr/bin/env node
/**
 * Smoke test against a REAL Kitsuden API and a running starter
 * ============================================================================
 *
 *   SMOKE_API_URL=http://localhost:3000 SMOKE_SITE_URL=http://localhost:4321 node tests/smoke.mjs
 *
 * What it does, in order:
 *
 *   1. Signs in as an admin. On an API with zero users it first creates the
 *      first admin (`POST /api/system/setup`) with random credentials that
 *      are never printed (saved to SMOKE_CREDENTIALS_FILE if given, for the
 *      next run). On an initialized API it needs SMOKE_ADMIN_EMAIL and
 *      SMOKE_ADMIN_PASSWORD, or that file.
 *   2. Uploads a small generated PNG to the media library.
 *   3. Creates a published page (hero with that image, text, image, cards,
 *      quote, cta, divider, spacer, plus one block type this site does not
 *      render) and a published post.
 *   4. Fetches the starter and checks that the page, the blog list, the
 *      post, the image proxy, the sitemap and the 404 show what was created.
 *   5. Deletes the page, the post and the image, also when a check fails.
 *
 * It writes to the API: it refuses to run against anything but localhost
 * unless SMOKE_ALLOW_REMOTE=1. Use a throwaway installation.
 *
 * Optional: SMOKE_INTI=1 also checks the editing markup for a signed-in
 * admin (the site must be built with INTI=true).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const API = (process.env.SMOKE_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const SITE = (process.env.SMOKE_SITE_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://localhost:3001";
const CHECK_INTI = process.env.SMOKE_INTI === "1";

for (const url of [API, SITE]) {
  const host = new URL(url).hostname;
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(host) &&
    process.env.SMOKE_ALLOW_REMOTE !== "1"
  ) {
    console.error(
      `Refusing to write to ${host}: set SMOKE_ALLOW_REMOTE=1 for a non-local throwaway API.`
    );
    process.exit(2);
  }
}

const run = randomBytes(3).toString("hex");
const results = [];
let cookie = "";

function known(name, why) {
  console.info(`KNOWN ${name}  (${why})`);
}

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.info(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function api(method, path, body, extra = {}) {
  const headers = {
    origin: ORIGIN,
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
    ...extra.headers,
  };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    const jar = new Map(
      cookie
        .split("; ")
        .filter(Boolean)
        .map((c) => [c.split("=")[0], c])
    );
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      jar.set(pair.split("=")[0], pair);
    }
    cookie = [...jar.values()].join("; ");
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function site(path, init = {}) {
  const res = await fetch(`${SITE}${path}`, { redirect: "manual", ...init });
  return {
    status: res.status,
    headers: res.headers,
    text: res.status < 300 ? await res.text() : "",
  };
}

/** A real 16x16 PNG (a two-colour square), so sharp can transform it */
function png() {
  const w = 16;
  const rows = [];
  for (let y = 0; y < w; y++) {
    const row = [0];
    for (let x = 0; x < w; x++) row.push(...(x < 8 ? [47, 111, 222] : [240, 180, 40]));
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const created = { pageId: null, postId: null, mediaId: null, mediaPath: null };

async function signIn() {
  const init = await api("GET", "/api/system/init-check");
  const file = process.env.SMOKE_CREDENTIALS_FILE;
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let email = process.env.SMOKE_ADMIN_EMAIL ?? saved.email;
  let password = process.env.SMOKE_ADMIN_PASSWORD ?? saved.password;
  if (init.json?.initialized === false) {
    email = `smoke-${run}@example.test`;
    password = randomBytes(18).toString("base64url");
    const setup = await api("POST", "/api/system/setup", { name: "Smoke Admin", email, password });
    check(
      "first admin created with POST /api/system/setup",
      setup.status < 300,
      `HTTP ${setup.status}`
    );
    if (file) writeFileSync(file, JSON.stringify({ email, password }), { mode: 0o600 });
  } else if (!email || !password) {
    throw new Error("The API already has users: set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD.");
  }
  cookie = "";
  const login = await api("POST", "/api/auth/sign-in/email", { email, password });
  check(
    "admin signs in",
    login.status === 200 && cookie.includes("session_token"),
    `HTTP ${login.status}`
  );
}

async function createContent() {
  const form = new FormData();
  form.append("files", new Blob([png()], { type: "image/png" }), `smoke-${run}.png`);
  const upload = await api("POST", "/api/media/upload", form);
  created.mediaId = upload.json?.files?.[0]?.id ?? null;
  const url = upload.json?.files?.[0]?.url;
  created.mediaPath = typeof url === "string" && url.startsWith("/media/") ? url : null;
  check("image uploaded to the media library", Boolean(created.mediaId), `HTTP ${upload.status}`);

  const slug = `smoke-${run}`;
  const page = await api("POST", "/api/page-builder/pages", {
    title: `Smoke page ${run}`,
    slug,
    status: "published",
    metaDescription: `Smoke test page ${run}`,
    ogImageId: created.mediaId ?? undefined,
    blocks: [
      {
        type: "hero",
        content: {
          headline: `Hello from smoke ${run}`,
          description: "Rendered by the starter",
          mediaId: created.mediaId ?? undefined,
          primaryButton: { label: "Read the blog", url: "/blog" },
        },
      },
      {
        type: "text",
        content: {
          text: `<p>Paragraph <strong>${run}</strong> <a href="javascript:alert(1)">bad link</a></p>`,
          format: "html",
        },
      },
      { type: "text", content: { text: `## Markdown ${run}\n\n- one\n- two`, format: "markdown" } },
      {
        type: "image",
        content: {
          mediaId: created.mediaId ?? "",
          altText: `Alt ${run}`,
          caption: `Caption ${run}`,
        },
      },
      {
        type: "cards",
        content: {
          columns: 2,
          cards: [
            { id: "a", title: `Card A ${run}`, description: "first" },
            { id: "b", title: `Card B ${run}` },
          ],
        },
      },
      { type: "quote", content: { quote: `Quote ${run}`, author: "Ada" } },
      { type: "cta", content: { title: `CTA ${run}`, buttonLabel: "Go", buttonUrl: "/" } },
      { type: "divider", content: { style: "dashed" } },
      { type: "spacer", content: { height: "sm" } },
      { type: "tier-list", content: { anything: true } },
    ],
  });
  created.pageId = page.json?.id ?? null;
  check(
    "page with blocks created",
    page.status === 201 && Boolean(created.pageId),
    `HTTP ${page.status}`
  );

  const post = await api("POST", "/api/blog", {
    title: `Smoke post ${run}`,
    slug: `smoke-post-${run}`,
    excerpt: `Excerpt ${run}`,
    content: `<p>Body of the post ${run}</p><script>alert(1)</script>`,
    status: "published",
    locale: "en",
    featuredImageId: created.mediaId ?? undefined,
  });
  created.postId = post.json?.id ?? null;
  check("blog post created", post.status === 201 && Boolean(created.postId), `HTTP ${post.status}`);
  return { slug, postSlug: `smoke-post-${run}` };
}

async function checkSite({ slug, postSlug }) {
  // The page list and the page are cached by the API for up to 120 s; the
  // page was just created, so a first read by slug is fresh.
  const page = await site(`/${slug}`);
  check(`GET /${slug} → 200`, page.status === 200, `HTTP ${page.status}`);
  check("page shows the hero headline as <h1>", /<h1[^>]*>Hello from smoke/.test(page.text));
  check(
    "page title and description in <head>",
    page.text.includes(`<title>Smoke page ${run}`) && page.text.includes(`Smoke test page ${run}`)
  );
  check(
    "canonical uses SITE_URL",
    /<link rel="canonical" href="https?:\/\/[^"]+\/smoke-/.test(page.text)
  );
  check("html text block rendered", page.text.includes(`<strong>${run}</strong>`));
  check("javascript: link removed", !/href="javascript:/i.test(page.text));
  check(
    "markdown text block rendered",
    page.text.includes(`Markdown ${run}</h2>`) && page.text.includes("<li>two</li>")
  );
  check(
    "cards, quote and cta rendered",
    ["Card A", "Card B", `Quote ${run}`, `CTA ${run}`].every((s) => page.text.includes(s))
  );
  check(
    "unknown block type rendered as nothing",
    !page.text.includes("anything") && !page.text.includes("No component for block type")
  );
  check("no Inti markup for an anonymous visitor", !page.text.includes("data-inti-"));

  if (created.mediaId) {
    const src = `/img/${created.mediaId}/large`;
    check("image block points at the same-origin proxy", page.text.includes(src));
    const img = await site(src);
    const type = img.headers.get("content-type") ?? "";
    const label = `GET ${src.replace(created.mediaId, "<id>")} → image`;
    if (img.status === 404 && process.env.SMOKE_STRICT_MEDIA !== "1") {
      // Known API defect (2026-10-18): with the local storage driver,
      // /api/media/transform/:id redirects to a transformed file it never
      // generated (getSignedDownloadUrl does not check that it exists).
      // The proxy itself answered; the file behind it does not exist.
      known(label, "API transform redirects to a file that was never generated");
    } else {
      check(label, img.status === 200 && type.startsWith("image/"), `HTTP ${img.status} ${type}`);
    }
  }

  if (created.mediaPath) {
    const file = await site(created.mediaPath);
    const type = file.headers.get("content-type") ?? "";
    check(
      "GET /media/<key> (original file) → image through the proxy",
      file.status === 200 && type.startsWith("image/"),
      `HTTP ${file.status} ${type}`
    );
  }

  const blog = await site("/blog");
  check(
    "GET /blog lists the post",
    blog.status === 200 && blog.text.includes(`Smoke post ${run}`),
    `HTTP ${blog.status}`
  );

  const post = await site(`/blog/${postSlug}`);
  check(`GET /blog/${postSlug} → 200`, post.status === 200, `HTTP ${post.status}`);
  check(
    "post body rendered without <script>",
    post.text.includes(`Body of the post ${run}`) && !post.text.includes("<script>alert")
  );
  check("post marked as article", post.text.includes('property="og:type" content="article"'));

  const home = await site("/");
  check("GET / → 200", home.status === 200, `HTTP ${home.status}`);

  const sitemap = await site("/sitemap.xml");
  check(
    "sitemap lists the page and the post",
    sitemap.text.includes(`/${slug}</loc>`) && sitemap.text.includes(`/blog/${postSlug}</loc>`)
  );

  const missing = await site(`/does-not-exist-${run}`);
  check("unknown page → 404", missing.status === 404, `HTTP ${missing.status}`);
  const missingPost = await site(`/blog/does-not-exist-${run}`);
  check("unknown post → 404", missingPost.status === 404, `HTTP ${missingPost.status}`);

  if (CHECK_INTI) {
    const asEditor = await site(`/${slug}`, { headers: { cookie } });
    check(
      "Inti: editor gets data-inti-block markup",
      asEditor.text.includes('data-inti-block="hero"') &&
        asEditor.text.includes(`data-inti-document-id="${created.pageId}"`)
    );
    check(
      "Inti: editor gets data-inti-field on the headline",
      asEditor.text.includes('data-inti-field="headline"')
    );
    check(
      "Inti: editor response is private",
      (asEditor.headers.get("cache-control") ?? "").includes("private")
    );
    check("Inti: editor gets the editor UI", /inti/i.test(asEditor.text.split("</main>")[1] ?? ""));

    // A write through Inti: anonymous is refused, the editor writes with the server key
    const action = (headers) =>
      fetch(`${SITE}/_actions/inti.updateBlockField`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: SITE,
          ...headers,
        },
        body: JSON.stringify({
          documentId: created.pageId,
          blockIndex: 0,
          field: "headline",
          value: `Edited by Inti ${run}`,
        }),
      });
    const anonymous = await action({});
    check("Inti: anonymous write refused", anonymous.status >= 400, `HTTP ${anonymous.status}`);
    const edited = await action({ cookie });
    check("Inti: editor write accepted", edited.status === 200, `HTTP ${edited.status}`);
    const fresh = await api("GET", `/api/page-builder/pages/${created.pageId}`);
    check(
      "Inti: the API has the new headline",
      fresh.json?.blocks?.[0]?.content?.headline === `Edited by Inti ${run}`
    );
  }
}

async function cleanUp() {
  if (created.pageId) {
    const r = await api("DELETE", `/api/page-builder/pages/${created.pageId}`);
    check("page deleted", r.status < 300, `HTTP ${r.status}`);
  }
  if (created.postId) {
    const r = await api("DELETE", `/api/blog/${created.postId}`);
    check("post deleted", r.status < 300, `HTTP ${r.status}`);
  }
  if (created.mediaId) {
    const r = await api("DELETE", `/api/media/${created.mediaId}`);
    check("image deleted", r.status < 300, `HTTP ${r.status}`);
  }
}

try {
  await signIn();
  const slugs = await createContent();
  await checkSite(slugs);
} catch (error) {
  check(
    "smoke run finished without exceptions",
    false,
    error instanceof Error ? error.message : String(error)
  );
} finally {
  await cleanUp().catch((error) => check("clean up", false, error.message));
}

const failed = results.filter((r) => !r.ok);
console.info(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
