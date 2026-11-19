/**
 * `x-codeSamples` (apps/api/src/lib/code-samples.ts) name the generated clients'
 * methods with a copy of the generator's naming rules. This test reads every sample in
 * the committed contract and checks the method and its arguments exist in the
 * committed clients: a rename on one side fails here, not in a reader's editor.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { camel, codeSamples, operationBadges, pyIdent } from "../../apps/api/src/lib/code-samples";

const ROOT = resolve(__dirname, "../..");
const doc = JSON.parse(
  readFileSync(join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json"), "utf8")
);

type Op = Record<string, any>;
const ops: { key: string; o: Op }[] = Object.entries(
  doc.paths as Record<string, Record<string, Op>>
).flatMap(([path, item]) =>
  Object.entries(item).map(([method, o]) => ({ key: `${method} ${path}`, o }))
);

const tsFile = (kon: string) =>
  readFileSync(
    join(ROOT, "packages/sdk/src/generated/kons", `${kon.replace(/^kon-/, "")}.ts`),
    "utf8"
  );
const pyFile = (kon: string) =>
  readFileSync(
    join(
      ROOT,
      "packages/sdk-python/kitsuden/_generated/kons",
      `${pyIdent(kon.replace(/^kon-/, ""))}.py`
    ),
    "utf8"
  );

describe("x-codeSamples", () => {
  it("every operation has a TypeScript and a Python sample", () => {
    expect(ops.length).toBeGreaterThan(100);
    for (const { key, o } of ops) {
      expect(
        o["x-codeSamples"]?.map((s: { lang: string }) => s.lang),
        key
      ).toEqual(["typescript", "python"]);
    }
  });

  it("each sample calls a method the generated clients have, with arguments they take", () => {
    for (const { key, o } of ops) {
      const x = o["x-kitsuden-operation"];
      const [ts, py] = o["x-codeSamples"] as { source: string }[];
      const tsCall = /kitsuden\.(\w+)\.(\w+)\((.*)\);/.exec(ts.source);
      const pyCall = /kitsuden\.(\w+)\.(\w+)\((.*)\)\n/.exec(py.source);
      expect(tsCall, key).not.toBeNull();
      expect(pyCall, key).not.toBeNull();
      const tsKon = tsFile(x.kon);
      const pyKon = pyFile(x.kon);
      expect(tsCall![1], key).toBe(camel(x.kon.replace(/^kon-/, "")));
      expect(tsKon, `${key}: TS method`).toContain(`readonly ${tsCall![2]}:`);
      const def = new RegExp(`def ${pyCall![2]}\\(([^\\n]*)\\)`).exec(pyKon);
      expect(def, `${key}: Python method ${pyCall![2]}`).not.toBeNull();
      for (const arg of pyCall![3].matchAll(/(?:^|, )(\w+)=/g)) {
        expect(def![1], `${key}: Python argument ${arg[1]}`).toMatch(new RegExp(`\\b${arg[1]}:`));
      }
    }
  });
});

describe("code-samples helpers", () => {
  it("required body fields and upload bodies", () => {
    const [ts, py] = codeSamples({
      konId: "kon-blog",
      operationId: "create-post",
      args: [{ name: "siteId", schema: { type: "integer" } }],
      body: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    });
    expect(ts.source).toContain(
      `kitsuden.blog.createPost({ siteId: 1, body: { title: "<title>" } })`
    );
    expect(py.source).toContain(`kitsuden.blog.create_post(site_id=1, body={"title": "<title>"})`);
    const upload = codeSamples({
      konId: "kon-media",
      operationId: "upload",
      args: [],
      body: "multipart",
    });
    expect(upload[1].source).toContain("upload(body=files)");
  });

  it("badges say what to know before calling, for Scalar (name) and RapiDoc (label)", () => {
    expect(
      operationBadges({ access: "session", sensitive: false, stream: false, mcpExcluded: false })
    ).toEqual([]);
    const b = operationBadges({
      access: "public",
      sensitive: true,
      stream: true,
      mcpExcluded: true,
    });
    expect(b.map((x) => x.name)).toEqual([
      "Public",
      "Sensitive",
      "Stream (SSE)",
      "Not an MCP tool",
    ]);
    for (const x of b) expect(x.label).toBe(x.name);
  });
});
