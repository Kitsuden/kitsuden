/**
 * lib/api-console/spec.ts: the document the API console hands to <rapi-doc-mini>.
 *
 * RapiDoc renders descriptions as Markdown into HTML and its fallback sanitizer only
 * strips <script>, on* and javascript: in href/src. These tests run each neutralised
 * text through `marked` (the same major version RapiDoc bundles) and check that no
 * element other than the ones Markdown itself makes comes out, and no live link scheme.
 */
import { marked } from "marked";
import { describe, expect, it } from "vitest";

import {
  listOperations,
  listTags,
  neutraliseMarkdown,
  parseSelection,
  prepareConsoleSpec,
  selectionValue,
} from "./spec";

/** Payloads the RapiDoc 12 shim lets through, plus the classics it does catch. */
const PAYLOADS = [
  `<script>alert(1)</script>`,
  `<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>`,
  `<img src=x onerror=alert(1)>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  `<form action="https://evil.example"><input name=p><button formaction="javascript:alert(1)">go</button></form>`,
  `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
  `<base href="https://evil.example/">`,
  `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  `<a href="java&#9;script:alert(1)">tab</a>`,
  `<object data="javascript:alert(1)"></object>`,
  `<style>*{background:url(https://evil.example/t)}</style>`,
  `&#60;img src=x onerror=alert(1)&#62;`,
  `[click](javascript:alert(1))`,
  `[click](JaVaScRiPt:alert(1))`,
  `[click]( javascript\\:alert(1))`,
  `[click](vbscript:msgbox(1))`,
  `[ref]\n\n[ref]: javascript:alert(1)`,
  `[tab](java&#9;script:alert(1))`,
  `![pixel](https://tracker.example/p.png)`,
  `<javascript:alert(1)>`,
];

/** Tags marked makes from Markdown; anything else came from raw HTML. */
const MARKDOWN_TAGS = new Set(["p", "a", "em", "strong", "code", "pre", "br", "ul", "ol", "li"]);

function rendered(text: string): string {
  return marked.parse(neutraliseMarkdown(text), { async: false });
}

/** What in this HTML would be live in a page: foreign elements, handlers, loading attributes, script links. */
function liveParts(html: string): string[] {
  const tpl = document.createElement("template");
  tpl.innerHTML = html; // inert: a <template> runs nothing and loads nothing
  const live: string[] = [];
  for (const el of tpl.content.querySelectorAll("*")) {
    const tag = el.localName;
    if (!MARKDOWN_TAGS.has(tag)) live.push(tag);
    for (const { name, value } of el.attributes) {
      if (/^on|^(src|srcdoc|style|action|formaction|data|xlink:href)$/i.test(name)) {
        live.push(`${tag}[${name}]`);
      }
      // What a URL parser ignores: whitespace and control characters (code points up to space).
      const scheme = [...value]
        .filter((c) => c.charCodeAt(0) > 0x20)
        .join("")
        .toLowerCase();
      if (name === "href" && /^(javascript|vbscript|data):/.test(scheme)) {
        live.push(`href=${value}`);
      }
    }
  }
  return live;
}

describe("neutraliseMarkdown", () => {
  it.each(PAYLOADS)("leaves no live HTML: %s", (payload) => {
    expect(liveParts(rendered(payload))).toEqual([]);
  });

  it("the check above does catch live HTML", () => {
    const raw = (s: string) => marked.parse(s, { async: false });
    expect(liveParts(raw(PAYLOADS[1]))).toContain("iframe[srcdoc]");
    expect(liveParts(raw("[x](javascript:alert(1))"))).toEqual(["href=javascript:alert(1)"]);
    expect(liveParts(raw(PAYLOADS[18]))).toContain("img[src]");
  });

  it("keeps Markdown readable", () => {
    const html = rendered(
      "Lists **posts** and `ids`.\n\n- one\n- [docs](https://example.com/a?b=1&c=2)"
    );
    expect(html).toContain("<strong>posts</strong>");
    expect(html).toContain("<code>ids</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
  });

  it("shows < > & as characters outside code", () => {
    const html = rendered("Returns a <Post> when a < b & c > d");
    expect(html).toContain("&lt;Post&gt;");
    // As text: the browser shows "<Post>", never parses an element.
    const div = document.createElement("div");
    div.innerHTML = html;
    expect(div.textContent).toContain("Returns a <Post> when a < b & c > d");
    expect(div.querySelector("post")).toBeNull();
  });
});

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Blog <b>API</b>", description: "<img src=x onerror=alert(1)>", version: "1" },
  servers: [{ url: "https://evil.example/api", description: "<script>x</script>" }],
  security: [{ bearer: [] }],
  tags: [{ name: "posts", description: "<iframe srcdoc='x'></iframe>" }],
  webhooks: { ping: {} },
  paths: {
    "/blog/posts": {
      servers: [{ url: "https://evil.example" }],
      parameters: [{ name: "q", in: "query", description: "<b>q</b>" }],
      get: {
        tags: ["posts"],
        summary: "List <em>posts</em>",
        operationId: "listPosts",
        servers: [{ url: "https://evil.example" }],
        security: [{ bearer: [] }],
        responses: {
          "200": {
            description: "<svg onload=alert(1)>",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  title: "<b>Page</b>",
                  properties: {
                    description: { type: "string", description: "<img src=x>" },
                    example: { $ref: "https://evil.example/schema.json" },
                    author: { $ref: "#/components/schemas/Author" },
                  },
                },
              },
            },
          },
        },
      },
      post: { tags: ["posts"], summary: "Create", callbacks: { done: {} }, responses: {} },
    },
    "/blog/stats": { get: { tags: ["stats"], responses: {} } },
  },
  components: {
    schemas: { Author: { type: "object", description: "<script>x</script>" } },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
};

describe("prepareConsoleSpec", () => {
  const sel = { kind: "operation", method: "get", path: "/blog/posts" } as const;
  const out = prepareConsoleSpec(SPEC, { serverUrl: "https://panel.example/api", selection: sel });
  const json = JSON.stringify(out);

  it("no raw tag survives anywhere in the document", () => {
    expect(json).not.toMatch(/</);
    expect((out.info as Record<string, string>).title).toBe("Blog &lt;b&gt;API&lt;/b&gt;");
  });

  it("only this API as server, at every level; no security schemes, webhooks or callbacks", () => {
    expect(out.servers).toEqual([{ url: "https://panel.example/api" }]);
    expect(json).not.toContain("evil.example");
    expect(out).not.toHaveProperty("security");
    expect(out).not.toHaveProperty("webhooks");
    expect(out.components).not.toHaveProperty("securitySchemes");
    expect(json).not.toContain("callbacks");
  });

  it("drops external $ref and keeps local ones", () => {
    expect(json).toContain('"$ref":"#/components/schemas/Author"');
    expect(json).not.toContain("schema.json");
  });

  it("keeps only the selected operation, with its path's parameters", () => {
    expect(Object.keys(out.paths as object)).toEqual(["/blog/posts"]);
    const item = (out.paths as Record<string, Record<string, unknown>>)["/blog/posts"];
    expect(Object.keys(item).sort()).toEqual(["get", "parameters"]);
  });

  it("a tag keeps every operation in it", () => {
    const byTag = prepareConsoleSpec(SPEC, {
      serverUrl: "/api",
      selection: { kind: "tag", tag: "posts" },
    });
    const item = (byTag.paths as Record<string, Record<string, unknown>>)["/blog/posts"];
    expect(item).toHaveProperty("get");
    expect(item).toHaveProperty("post");
    expect(byTag.paths).not.toHaveProperty("/blog/stats");
  });

  it("does not change its input and copies no __proto__", () => {
    const before = JSON.stringify(SPEC);
    const evil = JSON.parse('{"paths":{},"__proto__":{"polluted":true}}');
    prepareConsoleSpec(evil, { serverUrl: "/api", selection: sel });
    expect(JSON.stringify(SPEC)).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("operations and selections", () => {
  it("lists operations by tag, path and method", () => {
    const ops = listOperations(SPEC);
    expect(ops.map((o) => `${o.method} ${o.path}`)).toEqual([
      "get /blog/posts",
      "post /blog/posts",
      "get /blog/stats",
    ]);
    expect(listTags(ops)).toEqual(["posts", "stats"]);
    expect(listOperations(null)).toEqual([]);
  });

  it("a selection survives the round trip through a <select> value", () => {
    for (const sel of [
      { kind: "operation", method: "delete", path: "/a/{id}" },
      { kind: "tag", tag: "with space" },
    ] as const) {
      expect(parseSelection(selectionValue(sel))).toEqual(sel);
    }
    expect(parseSelection("op:fetch /x")).toBeNull();
    expect(parseSelection("")).toBeNull();
  });
});
