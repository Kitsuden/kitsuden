/**
 * `GET /api/docs/operations?filter=…`: a small query language over the list
 * ============================================================================
 *
 * Borrowed from RapiDoc's `filter-operations`. Terms separated by spaces; an
 * operation is listed when it matches EVERY plain term and NONE of the `!` ones.
 *
 *   tag:media          a tag (the kon id is always one)
 *   kon:blog           the kon, with or without `kon-`
 *   method:post        the HTTP method
 *   deprecated         deprecated operations (`!deprecated`: the others)
 *   sdk                declared with defineOperation (typed clients, MCP tool)
 *   /api/media/**      the path: `*` one segment, `**` anything (`{id}` style)
 *   blocks.get-page    an operationId, exactly
 *   folder             anything else: text in the operationId, summary or path
 *   !term              excludes what `term` matches
 */

export interface FilterableOperation {
  konId: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  sdk?: boolean;
  deprecated?: boolean;
}

type Test = (op: FilterableOperation) => boolean;

function pathGlob(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function termTest(term: string): Test {
  const lower = term.toLowerCase();
  const [key, ...rest] = term.split(":");
  const value = rest.join(":").toLowerCase();
  if (rest.length && value) {
    if (key === "tag") return (op) => op.tags.some((t) => t.toLowerCase() === value);
    if (key === "kon") {
      const id = value.startsWith("kon-") ? value : `kon-${value}`;
      return (op) => op.konId.toLowerCase() === id;
    }
    if (key === "method") return (op) => op.method.toLowerCase() === value;
  }
  if (lower === "deprecated") return (op) => op.deprecated === true;
  if (lower === "sdk") return (op) => op.sdk === true;
  if (term.startsWith("/")) {
    const rx = pathGlob(term);
    return (op) => rx.test(op.path);
  }
  return (op) =>
    op.operationId.toLowerCase() === lower ||
    op.operationId.toLowerCase().includes(lower) ||
    op.summary.toLowerCase().includes(lower) ||
    op.path.toLowerCase().includes(lower);
}

/** The test for a whole filter; an empty filter keeps everything. */
export function operationFilter(filter: string | undefined): Test {
  const terms = (filter ?? "").split(/\s+/).filter(Boolean).slice(0, 20);
  const must = terms.filter((t) => !t.startsWith("!")).map(termTest);
  const mustNot = terms
    .filter((t) => t.startsWith("!") && t.length > 1)
    .map((t) => termTest(t.slice(1)));
  return (op) => must.every((t) => t(op)) && !mustNot.some((t) => t(op));
}
