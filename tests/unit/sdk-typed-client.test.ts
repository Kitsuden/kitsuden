/**
 * The generated SDK makes a misnamed field fail at compile time
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * `kitsuden generate-sdk` only knew how to substitute `{collection}` and `{id}`. With a
 * contract that already includes kon routes it produced calls to paths with a literal
 * `{tournamentId}`, and no body type: `{ winner: "p1" }` instead of
 * `{ winnerId: "p1" }` was only discovered by reading a 422.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * The client is generated from a minimal OpenAPI with the shape Kitsuden
 * publishes and COMPILED with real TypeScript: correct usage gives no
 * errors and the misnamed field does. Then it is run against a fake `fetch`
 * to check the path, the token header and the error.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  generateTypedClient,
  type EspecOpenApi,
} from "../../packages/cli/src/commands/sdk/typed-client";

const SPEC: EspecOpenApi = {
  paths: {
    "/esports/matches/tournament/{tournamentId}/report": {
      post: {
        operationId: "reportSet",
        summary: "Reports the winner of a set",
        tags: ["kon-esports"],
        parameters: [
          { name: "tournamentId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  matchId: { type: "string" },
                  winnerId: { type: "string", description: "Participant id" },
                  participant1Score: { type: "integer" },
                },
                required: ["winnerId"],
                additionalProperties: false,
              },
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    },
    "/esports/tournaments/{id}": {
      get: {
        operationId: "esports_get_tournaments_id",
        tags: ["kon-esports"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        security: [],
      },
    },
    "/tierlist/templates": {
      get: {
        operationId: "tierlist_get_templates",
        tags: ["kon-tierlist"],
        parameters: [{ name: "page", in: "query", required: false, schema: { type: "integer" } }],
      },
    },
    "/items/characters": {
      post: {
        operationId: "dataset_characters_create",
        tags: ["Datasets"],
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Dataset_characters" } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Dataset_characters: {
        type: "object",
        properties: { name: { type: "string" }, image: { type: "string", nullable: true } },
        required: ["name"],
      },
    },
  },
};

/** Compiles in-memory files and returns the diagnostics as text. */
function diagnostics(files: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  /**
   * On Windows TypeScript asks for "C:/virtual/…" even though it was given
   * "/virtual/…". Without normalizing, the in-memory files are not found and the
   * error talks about a module that does not exist, not about the generated code.
   */
  const key = (name: string) =>
    name
      .split(String.fromCharCode(92))
      .join("/")
      .replace(/^[A-Za-z]:/, "");
  const virtual = new Map(Object.entries(files).map(([n, c]) => [key(n), c]));

  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    virtual.has(key(name))
      ? ts.createSourceFile(name, virtual.get(key(name))!, version)
      : original(name, version);
  const exists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual.has(key(name)) || exists(name);
  const read = host.readFile.bind(host);
  host.readFile = (name) => virtual.get(key(name)) ?? read(name);

  const program = ts.createProgram(Object.keys(files), options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Transpiles the client to CommonJS and evaluates it: it has no imports. */
function load(code: string): any {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} as any };
  new Function("module", "exports", outputText)(mod, mod.exports);
  return mod.exports;
}

describe("the generated client", () => {
  const code = generateTypedClient(SPEC, { baseUrl: "http://api.test/api" });

  it("groups by kon and uses the readable operationId when there is one", () => {
    expect(code).toContain("esports: {");
    expect(code).toContain("reportSet:");
    // The generated one is converted by removing the kon prefix, which is already the namespace.
    expect(code).toContain("getTournamentsId:");
    expect(code).toContain("tierlist: {");
    expect(code).toContain("datasets: {");
  });

  it("compiles without errors and a misnamed field does NOT compile", () => {
    const errors = diagnostics({
      "/virtual/usage.ts": `${code}

        // ── Usage ──
        const k = createKitsudenClient({ token: "kitsuden_agent_x" });

        void k.esports.reportSet({ tournamentId: "t1" }, { matchId: "m1", winnerId: "p1" });
        void k.esports.getTournamentsId({ id: "t1" });
        void k.tierlist.getTemplates({ page: 2 });
        void k.tierlist.getTemplates();
        void k.datasets.charactersCreate({ name: "Aria", image: null });

        // @ts-expect-error — \`winner\` does not exist: the field is \`winnerId\`.
        void k.esports.reportSet({ tournamentId: "t1" }, { matchId: "m1", winner: "p1" });

        // @ts-expect-error — the route parameter is missing.
        void k.esports.reportSet({}, { winnerId: "p1" });

        // @ts-expect-error — a dataset also rejects fields it does not have.
        void k.datasets.charactersCreate({ name: "Aria", picture: "x" });`,
    });

    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("calls the right path, with the token and the body", async () => {
    const { createKitsudenClient } = load(code);
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const k = createKitsudenClient({ token: "kitsuden_agent_x", fetch: fakeFetch });
    const r = await k.esports.reportSet({ tournamentId: "t/1" }, { winnerId: "p1" });

    expect(r).toEqual({ ok: true });
    expect(calls[0].url, "the id is encoded: a slash cannot change the path").toBe(
      "http://api.test/api/esports/matches/tournament/t%2F1/report"
    );
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer kitsuden_agent_x"
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ winnerId: "p1" });
  });

  it("the error brings the body and the suggestions in the message", async () => {
    const { createKitsudenClient, KitsudenApiError } = load(code);
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION",
            message: "Unknown fields in the request",
            details: { unknownKeys: [{ key: "winner", didYouMean: "winnerId" }] },
          },
        }),
        { status: 422 }
      );

    const k = createKitsudenClient({ fetch: fakeFetch });
    const error = await k.esports
      .reportSet({ tournamentId: "t1" }, { winner: "p1" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KitsudenApiError);
    expect(error.status).toBe(422);
    expect(error.message).toContain("«winner» → «winnerId»");
    expect(error.body.error.code).toBe("VALIDATION");
  });
});
