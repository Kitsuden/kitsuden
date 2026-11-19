/**
 * One Spectral function for every Kitsuden-specific rule (scripts/api-contract/spectral.yaml).
 *
 * Receives an operation object (`$.paths[*][get|put|post|delete|patch]`) and
 * `functionOptions.check`, the rule to apply. Returns Spectral results
 * (`{ message, path? }`, path relative to the operation). An operation without
 * `x-kitsuden-operation` (a hand-written route found by discovery, not
 * declared with `defineOperation`) only gets the `declared` check.
 */

const KON_ID = /^kon-[a-z0-9]+(-[a-z0-9]+)*$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `/kebab-case/{param}` segments; the last one may be a file name with an extension. */
const PATH_STYLE =
  /^(\/([a-z0-9]+(-[a-z0-9]+)*|\{[a-zA-Z][a-zA-Z0-9]*\}))*\/([a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)?|\{[a-zA-Z][a-zA-Z0-9]*\})$/;

/** OperationAccess in packages/shared/src/operations.ts. */
const ACCESS = new Set(["public", "optional", "session"]);
const ERROR_CODE = /^KITSUDEN_E_[A-Z0-9_]+$/;
const PAGINATION = new Set(["limit", "cursor", "page", "offset", "pageSize", "perPage"]);
/** What reaches the next page: an offset, a page number, a cursor or a time boundary. */
const PAGE_MOVES = new Set(["offset", "page", "cursor", "before", "after"]);
const STATUS_OF = {
  KITSUDEN_E_UNAUTHENTICATED: "401",
  KITSUDEN_E_FORBIDDEN: "403",
  KITSUDEN_E_RATE_LIMITED: "429",
  KITSUDEN_E_INTERNAL: "500",
};

const isError = (status) => /^[45]\d\d$/.test(status);

export default function kitsudenOperation(op, options, context) {
  if (!op || typeof op !== "object") return [];
  const check = options?.check;
  const x = op["x-kitsuden-operation"];
  const method = String(context.path[context.path.length - 1]).toLowerCase();
  const responses = op.responses ?? {};
  const statuses = Object.keys(responses);
  const params = Array.isArray(op.parameters) ? op.parameters : [];
  const out = [];
  const fail = (message, path = []) => out.push({ message, path: [...context.path, ...path] });

  if (check === "declared") {
    if (!x)
      fail(
        "Not declared with defineOperation: no x-kitsuden-operation (no typed client, no MCP tool)."
      );
    return out;
  }
  if (check === "path-style") {
    // Every route, declared or discovered. A deprecated operation keeps its old path
    // until its sunset: that is the point of deprecating it instead of renaming it.
    const path = String(context.path[1]);
    if (op.deprecated !== true && !PATH_STYLE.test(path)) {
      fail(
        `Path '${path}' must be lowercase kebab-case with no trailing slash (the last segment may be a file such as widget.js). To rename a route, add the new one and deprecate the old.`,
        []
      );
    }
    return out;
  }
  if (!x) return out;
  const short = typeof x.kon === "string" ? x.kon.replace(/^kon-/, "") : "";

  switch (check) {
    case "extension": {
      if (typeof x.kon !== "string" || !KON_ID.test(x.kon))
        fail("x-kitsuden-operation.kon must be a kon id (kon-<kebab>).", [
          "x-kitsuden-operation",
          "kon",
        ]);
      if (typeof x.id !== "string" || !KEBAB.test(x.id))
        fail("x-kitsuden-operation.id must be kebab-case.", ["x-kitsuden-operation", "id"]);
      if (!ACCESS.has(x.access))
        fail("x-kitsuden-operation.access must be 'public', 'optional' or 'session'.", [
          "x-kitsuden-operation",
          "access",
        ]);
      if (typeof x.sensitive !== "boolean")
        fail("x-kitsuden-operation.sensitive must say true or false.", [
          "x-kitsuden-operation",
          "sensitive",
        ]);
      if (!Array.isArray(x.errors) || x.errors.some((c) => !ERROR_CODE.test(c)))
        fail("x-kitsuden-operation.errors must list KITSUDEN_E_* codes.", [
          "x-kitsuden-operation",
          "errors",
        ]);
      break;
    }
    case "operation-id": {
      const want = `${short}.${x.id}`;
      if (op.operationId !== want)
        fail(
          `operationId must be '${want}' (<kon without kon->.<operation id>): the generated clients and MCP tools are named from it.`,
          ["operationId"]
        );
      break;
    }
    case "tag": {
      if (!Array.isArray(op.tags) || op.tags[0] !== x.kon)
        fail(`The first tag must be the kon id '${x.kon}'.`, ["tags"]);
      break;
    }
    case "scope": {
      const want = `kon:${short}:${x.id}`;
      if (x.scope !== want)
        fail(
          `x-kitsuden-operation.scope must be the operation's fine scope '${want}': agent keys are granted and denied by it.`,
          ["x-kitsuden-operation", "scope"]
        );
      break;
    }
    case "errors-documented": {
      for (const code of x.errors ?? []) {
        const documented = statuses.some(
          (s) => isError(s) && String(responses[s]?.description ?? "").includes(code)
        );
        if (!documented)
          fail(`${code} is in x-kitsuden-operation.errors but no error response names it.`, [
            "responses",
          ]);
      }
      for (const s of statuses.filter(isError)) {
        const r = responses[s] ?? {};
        const media = r.content?.["application/problem+json"];
        if (!media)
          fail(`Response ${s} must be application/problem+json (RFC 9457).`, ["responses", s]);
        else if (media.schema?.$ref !== "#/components/schemas/Problem")
          fail(`Response ${s} must use #/components/schemas/Problem.`, [
            "responses",
            s,
            "content",
            "application/problem+json",
            "schema",
          ]);
        if (!/KITSUDEN_E_[A-Z0-9_]+/.test(String(r.description ?? "")))
          fail(`Response ${s} must name its KITSUDEN_E_* code in the description.`, [
            "responses",
            s,
            "description",
          ]);
      }
      break;
    }
    case "standard-errors": {
      // Any operation can be denied by a scoped key (403, even a public one),
      // rate limited (429) or fail (500); a session one can be unauthenticated (401).
      const needed = ["KITSUDEN_E_FORBIDDEN", "KITSUDEN_E_RATE_LIMITED", "KITSUDEN_E_INTERNAL"];
      if (x.access === "session") needed.unshift("KITSUDEN_E_UNAUTHENTICATED");
      for (const code of needed) {
        if (!statuses.includes(STATUS_OF[code]) || !(x.errors ?? []).includes(code)) {
          fail(
            `Missing ${STATUS_OF[code]} ${code}: every ${x.access === "session" ? "session " : ""}operation can answer it.`,
            ["responses"]
          );
        }
      }
      break;
    }
    case "idempotency-key": {
      if (method === "get") break;
      const has = params.some(
        (p) => p?.in === "header" && String(p.name).toLowerCase() === "idempotency-key"
      );
      if (!has)
        fail(
          "A non-GET operation must announce the Idempotency-Key header (retries replay instead of running twice).",
          ["parameters"]
        );
      break;
    }
    case "success": {
      if (!statuses.some((s) => /^[23]\d\d$/.test(s)))
        fail("The operation declares no success (2xx) or redirect (3xx) response.", ["responses"]);
      break;
    }
    case "get-no-body": {
      if (method === "get" && op.requestBody)
        fail("A GET operation cannot take a body.", ["requestBody"]);
      break;
    }
    case "documented": {
      if (!String(op.summary ?? "").trim()) fail("Missing summary.", ["summary"]);
      if (!String(op.description ?? "").trim())
        fail("Missing description: agents choose operations by reading it.", ["description"]);
      break;
    }
    case "pagination": {
      // `unpaginated`: the operation says why it returns the whole collection.
      if (method !== "get" || !/^(list|search)-/.test(x.id) || x.stream || x.unpaginated) break;
      const query = params.filter((p) => p?.in === "query").map((p) => p.name);
      // A page size alone is not enough: `limit` with no way to the next page is a cap
      // the client chooses (kon-directory's list-employees stopped at 100 that way).
      if (!query.some((n) => PAGE_MOVES.has(n)))
        fail(
          query.some((n) => PAGINATION.has(n))
            ? "This list takes a page size but no way to the next page: add `offset`, `page` or `cursor` (with `hasMore`), or declare `unpaginated` with the reason it is bounded."
            : "A list operation takes a page size and a way to the next page (limit + offset, page or cursor), or declares `unpaginated` with the reason it is bounded: a list that stops at a server cap hides rows with no sign.",
          ["parameters"]
        );
      break;
    }
    case "query-camel-case": {
      params.forEach((p, i) => {
        // A deprecated parameter is an old name kept for old clients; a dotted name
        // (`hub.mode`, `hub.verify_token`) belongs to another party's protocol (Meta's
        // webhook check) and is not ours to rename.
        const name = String(p?.name);
        if (
          p?.in === "query" &&
          !p.deprecated &&
          !name.includes(".") &&
          !/^[a-z][a-zA-Z0-9]*$/.test(name)
        )
          fail(`Query parameter '${p.name}' should be camelCase like the rest of the API.`, [
            "parameters",
            i,
            "name",
          ]);
      });
      break;
    }
    case "deprecation-sunset": {
      params.forEach((p, i) => {
        if (p?.deprecated === true && !/^\d{4}-\d{2}-\d{2}$/.test(String(p["x-sunset"] ?? ""))) {
          fail(`Deprecated parameter '${p.name}' must say when it goes: x-sunset: YYYY-MM-DD.`, [
            "parameters",
            i,
          ]);
        }
      });
      if (op.deprecated === true && !/^\d{4}-\d{2}-\d{2}$/.test(String(op["x-sunset"] ?? ""))) {
        fail(
          "A deprecated operation must say when it goes: x-sunset: YYYY-MM-DD (oasdiff checks the notice before it may be removed).",
          ["x-sunset"]
        );
      }
      break;
    }
    default:
      fail(`kitsudenOperation: unknown check '${check}'.`);
  }
  return out;
}
