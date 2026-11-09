/**
 * The kon SDK operations of a source file, sliced up.
 *
 * For tests that read a kon's code (what each route checks):
 * with the SDK a route is no longer `router.get("/x", …)` but a declaration
 * `defineOperation({ …, method: "GET", route: "/x", …, handle })`. Each slice
 * goes from its `method:` to the next one's `method:`, so it includes its `access`,
 * its `permission` and the handler body. Kons written before the English rename
 * use the keys `metodo:` / `ruta:`; both spellings are recognized.
 */
export interface SourceOperation {
  method: string;
  route: string;
  body: string;
}

export function sourceOperations(source: string): SourceOperation[] {
  const re = /(?:method|metodo):\s*"(GET|POST|PUT|PATCH|DELETE)",\s*(?:route|ruta):\s*"([^"]*)"/g;
  const marks = [...source.matchAll(re)].map((m) => ({
    method: m[1]!,
    route: m[2]!,
    index: m.index!,
  }));
  return marks.map((m, i) => ({
    method: m.method,
    route: m.route,
    body: source.slice(m.index, marks[i + 1]?.index ?? source.length),
  }));
}
