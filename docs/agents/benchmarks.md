# Agent benchmarks

What Kitsuden's agent-facing features measurably do, with the method and the
raw numbers. Three measurements so far, all free (no model calls):

1. **Response formats**: token counts of compact JSON, TOON, TRON and the
   `auto` mode on real API responses, with round-trip checks and latency.
2. **Agent test bench**: the MCP harness run with its two control agents
   (oracle and null).
3. **Load and latency**: requests per second and p50/p95/p99 under 50–200
   concurrent connections, before and after a round of performance work
   ([section 3](#3-load-and-latency)).

The paid run with Claude is prepared but **not run**; see
[the paid run](#the-paid-run-with-claude-prepared-not-run).

Section 1 was measured on 2026-10-25, section 3 on 2026-10-27.

## 1. Response formats on real responses: JSON, TOON, TRON and auto

The same data can leave the API in three lossless formats, and an `auto`
mode picks one per response:

| Format       | Ask for it with                                           | What it is                                                                                                         |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| compact JSON | default; `Accept: application/json`                       | `JSON.stringify` with no whitespace                                                                                |
| TOON         | `Accept: application/vnd.toon` or `?format=toon`          | [TOON](https://toonformat.dev): flat, uniform lists become a table (`[N]{a,b}:` + CSV rows)                        |
| TRON         | `Accept: application/vnd.tron` or `?format=tron`          | [TRON](https://tron-format.github.io): JSON with "classes" (`class A: a,b`, then `A(1,2)`) for objects that repeat |
| auto         | `Accept: application/vnd.kitsuden.auto` or `?format=auto` | the shortest of the three for this response that decodes back to the same data                                     |

Every response says which one it is in `Content-Type` and in
`X-Kitsuden-Format: json|toon|tron`. An explicit `Accept: application/json`
always gets JSON, even if the URL carries `?format=` (the admin panel
and other first-party frontends ask that way). MCP tools use `auto` by default and put
the chosen format in the result's `_meta["kitsuden/format"]`; `format: "json"`
forces compact JSON.

### Method

- **Data**: a database restored from a dump of a real deployment (dataset
  rows, blog posts, game catalog, wiki and tier-list data) into a throwaway
  local Postgres 16 container.
- **Server**: the API from the working tree, all the kons the database has
  installed, no Valkey. Authenticated endpoints were called
  with a session of a test admin created in the throwaway database only.
- **Requests**: the 24 `GET` endpoints below, each with
  `Accept: application/json`, `application/vnd.toon`, `application/vnd.tron`
  and `application/vnd.kitsuden.auto`, plus `Accept: application/json` with
  `?format=auto`. Token columns are counted on the bodies exactly as served.
- **Tokenizers** (all offline; none is the tokenizer of current Claude models):
  `o200k_base` and `cl100k_base` via `js-tiktoken@1.0.21`, and
  `@anthropic-ai/tokenizer@0.0.4` (Anthropic's legacy tokenizer, not accurate
  for current models). Anthropic does not publish an offline tokenizer for
  current Claude models; the exact count needs `POST /v1/messages/count_tokens`
  with an API key, which was not used. Treat the ratios as estimates; the three
  tokenizers agree on which format wins on every endpoint but one.
- **Round-trip**: every non-JSON body was decoded and compared with the JSON
  body: TOON with the repo's decoder and with the reference implementation
  `@toon-format/toon@4.4.0`, TRON with `@tron-format/tron@0.1.3`, and the
  `auto` body with the decoder its header names. "OK" means
  `JSON.stringify(decoded)` is byte-identical to the JSON body.

### Results

Token columns are `o200k_base`; the percentage is the saving against compact
JSON (negative = bigger).

|   # | Area                  | Endpoint                                     | Compact JSON |             TOON |            TRON |             auto (chosen) | Round-trip (TOON repo / TOON reference / TRON / auto) |
| --: | --------------------- | -------------------------------------------- | -----------: | ---------------: | --------------: | ------------------------: | ----------------------------------------------------- |
|   1 | dataset entries       | `/items/<characters>?limit=50`               |       20,089 | 22,587 (−12.4 %) | 15,971 (20.5 %) | 15,971 (20.5 %, **tron**) | OK / OK / OK / OK                                     |
|   2 | dataset entries       | `/items/<weapons>?limit=50`                  |       13,395 | 14,753 (−10.1 %) |  9,855 (26.4 %) |  9,855 (26.4 %, **tron**) | OK / OK / OK / OK                                     |
|   3 | dataset entries       | `/items/<cards-a>?limit=50`                  |       19,514 | 21,617 (−10.8 %) | 16,482 (15.5 %) | 16,482 (15.5 %, **tron**) | OK / OK / OK / OK                                     |
|   4 | dataset entries       | `/items/<cards-b>?limit=50`                  |        8,584 |  9,599 (−11.8 %) |  7,296 (15.0 %) |  7,296 (15.0 %, **tron**) | OK / OK / OK / OK                                     |
|   5 | dataset entries       | `/items/<abilities>?limit=50`                |        6,669 |   5,367 (19.5 %) |  5,498 (17.6 %) |  5,367 (19.5 %, **toon**) | OK / OK / OK / OK                                     |
|   6 | dataset entries       | `/datasets/{characters id}/entries?limit=50` |       22,955 | 25,940 (−13.0 %) | 17,607 (23.3 %) | 17,607 (23.3 %, **tron**) | OK / OK / OK / OK                                     |
|   7 | dataset definition    | `/datasets/slug/<weapons>`                   |          968 |  1,078 (−11.4 %) |    853 (11.9 %) |    853 (11.9 %, **tron**) | OK / OK / OK / OK                                     |
|   8 | dataset list          | `/datasets?limit=20`                         |       11,708 | 13,355 (−14.1 %) |  8,969 (23.4 %) |  8,969 (23.4 %, **tron**) | OK / OK / OK / OK                                     |
|   9 | dataset list (public) | `/data-sets`                                 |       27,681 | 31,547 (−14.0 %) | 21,029 (24.0 %) | 21,029 (24.0 %, **tron**) | OK / OK / OK / OK                                     |
|  10 | page-builder          | `/page-builder/block-types`                  |        1,274 |  1,520 (−19.3 %) |  1,117 (12.3 %) |  1,117 (12.3 %, **tron**) | OK / OK / OK / OK                                     |
|  11 | blog                  | `/blog?limit=20`                             |       53,945 |  55,435 (−2.8 %) |  51,226 (5.0 %) |  51,226 (5.0 %, **tron**) | OK / OK / OK / OK                                     |
|  12 | blog                  | `/blog/slug/{slug}`                          |        2,469 |   2,481 (−0.5 %) |   2,469 (0.0 %) |   2,469 (0.0 %, **json**) | OK / OK / OK / OK                                     |
|  13 | blog                  | `/blog/categories`                           |        1,895 |   1,538 (18.8 %) |  1,552 (18.1 %) |  1,538 (18.8 %, **toon**) | OK / OK / OK / OK                                     |
|  14 | games                 | `/games?limit=20`                            |       72,181 | 80,570 (−11.6 %) | 59,117 (18.1 %) | 59,117 (18.1 %, **tron**) | OK / OK / OK / OK                                     |
|  15 | games                 | `/games/slug/{slug}`                         |        2,617 |   2,714 (−3.7 %) |   2,417 (7.6 %) |   2,417 (7.6 %, **tron**) | OK / OK / OK / OK                                     |
|  16 | games                 | `/games/platforms`                           |        1,009 |     780 (22.7 %) |    813 (19.4 %) |    780 (22.7 %, **toon**) | OK / OK / OK / OK                                     |
|  17 | games                 | `/games/tags`                                |          344 |     292 (15.1 %) |    297 (13.7 %) |    292 (15.1 %, **toon**) | OK / OK / OK / OK                                     |
|  18 | kon: tierlist         | `/tierlist/templates`                        |        5,927 |   5,139 (13.3 %) |  5,220 (11.9 %) |  5,139 (13.3 %, **toon**) | OK / OK / OK / OK                                     |
|  19 | kon: tierlist         | `/tierlist/templates/{slug}`                 |       10,628 |   9,252 (12.9 %) |  8,992 (15.4 %) |  8,992 (15.4 %, **tron**) | OK / OK / OK / OK                                     |
|  20 | kon: wiki             | `/wiki/wikis`                                |        3,083 |   2,740 (11.1 %) |  2,756 (10.6 %) |  2,740 (11.1 %, **toon**) | OK / OK / OK / OK                                     |
|  21 | kon: wiki             | `/wiki/wikis/{wiki}/pages`                   |        3,722 |   2,775 (25.4 %) |  2,932 (21.2 %) |  2,775 (25.4 %, **toon**) | OK / OK / OK / OK                                     |
|  22 | kon: builder          | `/builder/definitions`                       |          498 |     425 (14.7 %) |    441 (11.4 %) |    425 (14.7 %, **toon**) | OK / OK / OK / OK                                     |
|  23 | kon: broadcast        | `/broadcast/sections`                        |          123 |      93 (24.4 %) |    110 (10.6 %) |     93 (24.4 %, **toon**) | OK / OK / OK / OK                                     |
|  24 | kon: streamers        | `/streamers`                                 |          202 |      192 (5.0 %) |     202 (0.0 %) |     192 (5.0 %, **toon**) | OK / OK / OK / OK                                     |

**Totals over the 24 responses** (percentages are the saving against compact JSON; negative = bigger)

| Tokenizer                          | Compact JSON |             TOON |             TRON |             auto | Best format per endpoint |                 Pretty JSON |
| ---------------------------------- | -----------: | ---------------: | ---------------: | ---------------: | -----------------------: | --------------------------: |
| `o200k_base`                       |      291,480 | 311,789 (−7.0 %) | 243,221 (16.6 %) | 242,741 (16.7 %) |         242,741 (16.7 %) | 385,526 (auto saves 37.0 %) |
| `cl100k_base`                      |      299,490 | 321,734 (−7.4 %) | 253,107 (15.5 %) | 252,628 (15.6 %) |         252,628 (15.6 %) | 395,138 (auto saves 36.1 %) |
| `@anthropic-ai/tokenizer` (legacy) |      320,203 |  319,698 (0.2 %) | 268,943 (16.0 %) | 268,192 (16.2 %) |         268,191 (16.2 %) | 407,639 (auto saves 34.2 %) |

Bytes: compact JSON 893,113, TOON 967,820, TRON 683,179, auto 680,179 (23.8 %).
auto chose TRON 13 times, TOON 10, JSON 1.

Checks on the same run:

- `Accept: application/json` returned a body **byte-identical** to the one
  served before these changes on 24 of 24 endpoints, and
  `Accept: application/json` + `?format=auto` returned JSON on 24 of 24.
- Headers seen: `application/vnd.toon` + `X-Kitsuden-Format: toon`,
  `application/vnd.tron` + `tron`, `application/json` + `json`.
- `auto` picked the format with the fewest `o200k_base` tokens on 24 of 24
  endpoints (0 tokens above the best possible choice).

### What this means

- **TOON alone still does not pay off on this data**: −7.0 % in total with
  `o200k_base`. It wins on flat, uniform lists (categories, platforms, tags,
  tier-list templates, wiki pages, builder definitions, broadcast sections:
  5–25 %) and on dataset rows whose only nesting is a small uniform object
  (`/items/<abilities>`, 19.5 %, thanks to folding `_meta{…}` into the
  table header). Rows with arrays or rich text fall back to TOON's indented
  list form, which costs more than compact JSON.
- **TRON wins where TOON loses**: it is the best format on 13 endpoints
  (dataset entries and definitions, dataset lists, block types, the blog and
  games lists, one game page, one rendered tier list: 5–26 %), because it
  declares each repeated object shape once even when it is nested, and
  otherwise stays JSON. It never came out bigger than compact JSON here
  (0.0 % at worst).
- **auto takes the best of both**: 16.7 % fewer tokens than compact JSON over
  the 24 responses (15.6 % `cl100k_base`, 16.2 % legacy), and 37.0 % fewer than
  the pretty-printed JSON the MCP tools used to return. The MCP tools now
  return compact JSON when `format` is `json`, so most of that 37 % was
  whitespace.

### What the TOON codec guarantees

The round-trip check above is only meaningful if the codec is correct, so these
properties are covered by tests that would fail on a naive implementation
(`apps/api/src/tests-unit/toon-tabular.test.ts`, `toon.test.ts`):

1. **The decoder reads TOON's list form**, not just tables: list form at any
   depth, tables with folded columns (`docs[2]{id,_meta{ds,at}}:`), keyed
   tables (`byId[2:]{x,y}:`), and the `,` `	` `|` delimiters. Malformed TOON
   throws `ToonDecodeError` instead of returning partial data.
2. **Nothing is unwrapped by the response middleware**: keys next to `data`
   (`view` on `/tierlist/templates/{slug}`, `profile` on
   `/broadcast/sections`) survive.
3. **`{}` is written as `key:` with nothing after it**, because `key: {}` is
   read by TOON as the string `"{}"`.
4. **A root array is written in the spec's keyless `[N]…:` form**, not under an
   invented `data` key.

The encoder's output is **byte-identical to the reference encoder's**
(`@toon-format/toon@4.4.0`, including its nested-header folding): the unit
test checks that on the shapes above and on 20,000 random values, in both
directions. The reference package is a devDependency of `apps/api`, used only
by tests. The codec has byte-identical copies in `packages/sdk/src/toon.ts`
and `packages/mcp-server/src/toon.ts` (checked by
`apps/api/src/tests-unit/toon-mirrors.test.ts`), and the Python SDK has a port
of the decoder tested against shared cases
(`packages/sdk-python/tests/fixtures/toon-cases.json`, regenerated and checked
by `apps/api/src/tests-unit/toon-shared-cases.test.ts`).

### How auto chooses, and what it costs

`apps/api/src/lib/formats.ts`:

1. Serialize the response as compact JSON. Below **256 characters** it stays
   JSON (the possible saving is a few tokens).
2. Encode it as TOON and TRON, and keep only those at least **2 % shorter**
   than the JSON. Below that margin the difference is within the error of the
   estimate, and JSON is the least surprising format.
3. Take the shortest, **decode it and compare** with the JSON. If it does not
   give back the same data, try the next one; JSON is always the last resort.
   Nothing is ever sent that loses data.
4. For responses of **16 KB or more**, remember the winner per response shape
   (the route plus a fingerprint of the structure: keys and types to depth 3,
   first 3 items of each array) and encode only in that format the next time,
   still verifying the round-trip. Every 50th use the shape is measured again.
   The memory holds 256 shapes.

**The cost estimate is the length of the text.** On the 24 bodies, choosing
by length picked the same format as `o200k_base` on 23 of 24 (12 tokens lost
in total; 23/24 and 14 tokens with `cl100k_base`, 22/24 and 18 tokens with the
legacy tokenizer), and costs nothing to compute. Alternatives that were
tried: counting pre-tokenizer-like chunks (words, 1–3 digit groups,
punctuation) picked right on 19 of 24 and took 18–43 ms on a 220 KB body;
`length/4 + punctuation/2` picked right on 21 of 24. With the 2 % margin,
length picks the best format on 24 of 24.

**Latency.** In-process, median of 15 runs per body (Bun 1.3.14, Windows, a
busy laptop; noisy):

| Body                                   | Compact JSON `stringify` | auto, first time (measures all) | auto, shape remembered |
| -------------------------------------- | -----------------------: | ------------------------------: | ---------------------: |
| `/games?limit=20` (222 KB)             |                   0.7 ms |                         31.5 ms |                24.1 ms |
| `/blog?limit=20` (167 KB)              |                   0.7 ms |                         19.5 ms |                12.5 ms |
| `/data-sets` (90 KB)                   |                   0.3 ms |                         13.7 ms |                 9.1 ms |
| `/items/<characters>?limit=50` (55 KB) |                   0.3 ms |                          9.9 ms |                 6.9 ms |
| 14 bodies under 16 KB                  |                ≤ 0.12 ms |                      0.1–3.7 ms |       (not remembered) |
| all 24 bodies (1.04 MB)                |                   3.6 ms |                        127.9 ms |                94.8 ms |

Most of the remembered-shape cost is the round-trip check (decoding what was
encoded), which is kept on purpose. End to end over HTTP on localhost (median
of 7, client side), `auto` added up to 23 ms per request on the big ones
(67.6 → 90.2 ms on `/games?limit=20`, 98.6 → 117.3 ms on `/blog?limit=20`,
117.0 → 134.7 ms on `/items/<cards-a>?limit=50`) and between −3.5 and
+13.3 ms on the rest, which on this machine is mostly noise. The repo's TOON decoder is 1.5–3× faster than the
reference decoder on these bodies (e.g. 22 ms vs 67 ms on `/games`).

### TRON: why it is in, and its risks

TRON beat compact JSON on 22 of 24 endpoints (and tied on the other 2), beat
TOON on 14, and every body round-tripped. So it is a candidate in `auto` and available as
`Accept: application/vnd.tron`, pinned to exactly `@tron-format/tron@0.1.3`.

The risks, measured rather than assumed:

- **Maturity.** Version 0.1.3, published 2025-11-29 with no release since;
  six versions in its first week; a small project with one author. MIT, no
  dependencies, 31 KB.
- **Bugs found by fuzzing it against its own parser** (random values,
  20,000 per run): property names `null`, `true`, `false` and `class` are
  written unquoted in the class header and the output cannot be parsed back;
  a `__proto__` key is lost on parsing; when objects share a key set in
  different orders, they are decoded in the first object's order (same
  values; JSON objects are unordered, so the comparison for TRON ignores key
  order). With those keys left out of the generator, 0 failures in 40,000.
- **What protects against them:** the round-trip check. A TRON body that does
  not decode back to the same data is never sent; the response falls back to
  TOON or JSON and the header says so (tested in `apps/api/src/tests-unit/formats.test.ts` and
  `toon.test.ts`).
- **Clients:** the typed clients (`createKitsuden`, `KitsudenApi`; see
  [clients.md](clients.md)) decode TRON with their own dependency-free decoders. The
  older helper clients (`packages/sdk/src/index.ts`, `packages/sdk-python/kitsuden/client.py`)
  do not, and ask for `auto` limited to JSON and TOON
  (`Accept: application/vnd.kitsuden.auto; formats="json,toon"`). Agents
  reading MCP results get TRON as text.

If it has to go, removing `tron` from `FORMATS` in `apps/api/src/lib/formats.ts` turns
it off everywhere; `auto` then chooses between JSON and TOON (computed offline on the same
bodies: 1.9 % fewer `o200k_base` tokens than compact JSON instead of 16.7 %,
because TOON only wins on the flat lists).

Scripts (not part of the repo): a Bun script that fetches each endpoint in
every format, counts tokens and checks the round-trip; one that calibrates the
estimate; one that times the steps in process. They are described here so the
run can be repeated with any copy of the data.

## 2. Agent test bench (free controls)

The harness now lives in the kons repository, because its cases need kon-tierlist and kon-esports. It has to be repointed at the kons' MCP tools before it runs again. The harness, in that repository's `extras/from-core/apps/api/evals/agents-mcp/`, gives an agent the domain MCP
tools (18 of them, tournament / tier list / broadcast) on a fresh in-memory
Kitsuden (PGlite, the kons' real migrations, the kons' real routers) per case,
and grades each of its 15 synthetic cases by the **final state of the
database**, not by what the agent says. Two control agents need no model:

- **oracle**: a reference solution per case, using the same tools. It must
  score 15/15, or the case or the environment is wrong.
- **null**: does nothing. It must score 0/15, or a case passes by default.

The harness is self-contained: it does not talk to the Postgres database used in
section 1. `tsc -p extras/from-core/apps/api/evals/agents-mcp/tsconfig.json` exits 0.

```
$ bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent oraculo --flow <tmp>
[oraculo] 15 of 15 (case, rep) left to run
  ✓ tierlist-crear-y-colocar rep0
  ✓ tierlist-sacar-al-pool rep0
  ✓ tierlist-nuevos-sin-mover rep0
  ✓ tierlist-intercambiar rep0
  ✓ suizo-de-principio-a-fin rep0
  ✓ suizo-reportar-y-emparejar rep0
  ✓ suizo-ronda-a-medias rep0
  ✓ suizo-corregir-resultado rep0
  ✓ eliminacion-crear-8 rep0
  ✓ eliminacion-semifinal-con-marcador rep0
  ✓ liga-todos-contra-todos rep0
  ✓ checkin-marcar-llegadas rep0
  ✓ checkin-quitar-ausentes rep0
  ✓ emision-gran-final-bo5 rep0
  ✓ emision-evento-bo3 rep0
[oraculo] completed: 15/15 (100 % ± 0 %, approx. 95 % CI) · no errors: 15/15

$ bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent nulo --flow <tmp>
[nulo] 15 of 15 (case, rep) left to run
  ✗ tierlist-sacar-al-pool rep0: Boro is in S, expected unranked
  ✗ tierlist-nuevos-sin-mover rep0: has 3 items, expected 5 · Fenix missing · Gala missing
  ✗ tierlist-crear-y-colocar rep0: there are 0 tier lists named "Campeones de Arena", expected 1
  ...  (all 15 fail, each with the reason the grader found)
[nulo] completed: 0/15 (0 % ± 0 %, approx. 95 % CI) · no errors: 0/15
```

(The agent names `oraculo` and `nulo` are the values `--agent` accepts; the case
ids and sample data are in Spanish.) `--flow <tmp>` points the results at a fresh
directory: the runner resumes by skipping (case, rep) pairs it has already
scored in the flow directory, so reusing an old one would report old rows.

Noise in the output that is not a failure: importing the API in test mode
runs the core migrations on pg-mem and prints a count of benign failures that
were ignored, and Better Auth warns that `BETTER_AUTH_URL` is unset.

## 3. Load and latency

Measured on 2026-10-27. The tool is
[`scripts/bench/`](../../scripts/bench/README.md) (autocannon 8.0.0); every
figure below can be repeated with it.

### Method

- **Data**: a database restored from a dump of a real deployment (207,200
  dataset rows, 360 datasets) in a throwaway Postgres 16 container, plus a
  throwaway Valkey 7.
- **Server**: the API from the working tree with `NODE_ENV=production`,
  connecting as a **non-superuser role without `BYPASSRLS`** (so every policy
  applies), the default pool (`DB_POOL_MAX=20`), the per-route limiter on,
  all the kons the database has installed.
- **Identities**: a test admin (session cookie) and a test agent created in
  the throwaway database only. The agent's per-minute quota was set high so it does not cut
  the load, but it is still counted on every request. The limiter allows 300
  requests per minute per client; the benchmark signs requests as site
  visitors (`SITE_API_KEY`) spread over 5,000 of them, so the limiter runs
  on every request without rejecting the load.
- **Load**: 10 s measured after a 3 s warm-up per scenario, 50 connections,
  and 100 and 200 for four of them.
- **Machine**: one Windows 11 laptop (8 logical CPUs) running the API, the
  load generator and Docker Desktop, with other work
  running at the same time (other test databases and builds). A round trip from the API to
  Postgres or Valkey measured 1.3 ms at p50 when idle (4 ms at p90) and
  6–48 ms when the machine was busy. That makes every absolute figure here
  pessimistic: with the API and Postgres on a shared Docker network, a round
  trip is a fraction of a millisecond.
- **Before vs after**: to separate the changes from the noise, the two
  versions were run **interleaved**, before, after, before, after, in the
  same 25 minutes, and each figure is the median of the two runs of its side.
  "Before" is the same tree with the performance changes reverted.

### Results (median of 2 interleaved runs per side)

| Scenario                   | Conn | req/s before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after |
| -------------------------- | ---: | -------------------: | --------------------: | --------------------: | --------------------: |
| anon games list            |   50 |          54.8 → 72.9 |             702 → 665 |           1,885 → 922 |         1,958 → 1,265 |
| anon blog list             |   50 |          32.2 → 38.8 |         1,352 → 1,241 |         2,697 → 1,645 |         3,128 → 1,966 |
| anon dataset list          |   50 |        108.2 → 111.4 |             344 → 463 |             819 → 548 |           2,077 → 668 |
| anon dataset entries (RLS) |   50 |         102.9 → 90.5 |             407 → 537 |             818 → 715 |           1,129 → 785 |
| anon page-builder types    |   50 |        1,283 → 1,323 |               38 → 41 |               54 → 60 |               75 → 75 |
| anon games, `format=auto`  |   50 |          18.7 → 14.4 |         2,375 → 2,633 |         4,017 → 4,726 |         4,272 → 4,988 |
| session: dataset entries   |   50 |          55.3 → 81.3 |             910 → 584 |           1,257 → 741 |           1,368 → 967 |
| session: blog list         |   50 |          19.5 → 36.0 |         2,278 → 1,247 |         3,497 → 1,782 |         3,742 → 2,082 |
| agent: dataset entries     |   50 |         26.9 → 101.7 |           2,135 → 477 |           3,092 → 531 |           3,259 → 646 |
| agent: settings            |   50 |         32.9 → 236.9 |           1,906 → 206 |           2,632 → 246 |           3,048 → 295 |
| agent: entries, `auto`     |   50 |          17.0 → 47.5 |           3,451 → 965 |         4,760 → 1,402 |         5,193 → 1,708 |
| agent: idempotent write    |   50 |         21.9 → 109.1 |           2,099 → 439 |           3,455 → 560 |           3,568 → 660 |
| agent: replayed write      |   50 |         22.4 → 170.0 |           1,853 → 191 |           3,073 → 519 |           3,366 → 584 |
| MCP `tools/list`           |   50 |          9.4 → 108.7 |           4,537 → 445 |           5,665 → 546 |           6,039 → 691 |
| MCP call, built-in tool    |   50 |           6.0 → 47.3 |           6,738 → 785 |         7,554 → 2,998 |         8,444 → 3,149 |
| MCP call, SDK tool         |   50 |          10.7 → 42.7 |           3,938 → 795 |         4,841 → 3,152 |         5,208 → 3,669 |
| anon blog list             |  100 |          16.9 → 31.5 |         4,418 → 2,327 |         6,256 → 4,709 |         6,526 → 4,873 |
| anon dataset entries       |  100 |          49.7 → 86.7 |           1,918 → 861 |         2,733 → 2,296 |         3,152 → 2,457 |
| agent: dataset entries     |  100 |          15.4 → 78.3 |         5,421 → 1,153 |         6,327 → 1,977 |         6,667 → 2,130 |
| MCP call, SDK tool         |  100 |           7.5 → 60.3 |         8,460 → 1,467 |         9,116 → 2,271 |         9,152 → 2,539 |
| anon blog list             |  200 |          32.6 → 39.7 |         5,440 → 4,348 |         5,857 → 5,554 |         6,244 → 6,018 |
| anon dataset entries       |  200 |          77.1 → 96.5 |         2,223 → 1,736 |         3,598 → 2,824 |         3,972 → 3,005 |
| agent: dataset entries     |  200 |           9.9 → 89.5 |         7,597 → 1,938 |         8,308 → 2,416 |         8,499 → 2,588 |
| MCP call, SDK tool         |  200 |           0.1 → 48.3 |         5,584 → 3,151 |         5,584 → 4,951 |         5,584 → 5,201 |

Errors: none in any scenario at 50 connections, before or after. At 200
connections the anonymous blog list answered `503` + `Retry-After` to part of
the requests on both sides (145 before, 111 after, median): the pool of 20
connections waits up to 5 s and then gives up. Before the changes, an agent
at 200 connections also got `401` when the pool ran out (see "Fixed on the
way" below).

**CPU per request** (API process CPU divided by requests per second, median):
agent entries 12.2 → 1.2 ms, idempotent write 14.9 → 1.2 ms, MCP `tools/list`
37.5 → 1.1 ms, MCP SDK call 32.8 → 2.8 ms, anonymous blog list 6.7 → 4.6 ms,
session blog list 7.5 → 3.7 ms. After the changes the API process sits at
120–180 % CPU (it can use more) while the pool shows 20 of 20 connections in
use and 20–290 requests waiting for one: **the limit is now the database
round trips through a pool of 20, not the API's CPU.**

How to read the anonymous rows: the changes that touch them are small (one
round trip less per transaction, the blog sanitizer cache), and on this
machine run-to-run noise is ±30 %. The blog rows move consistently; the
dataset list, entries at 50 connections, page-builder and `format=auto` rows
did not change in code and move within the noise.

### Where the time went (the profile)

`bun --cpu-prof` on Windows recorded 830 samples in 150 s and slowed start-up
past two minutes, so the profile was built from three other sources:
per-middleware self time (`KITSUDEN_PROFILE_MIDDLEWARE`, off by default, see
the [bench README](../../scripts/bench/README.md#per-middleware-timing)),
Postgres statement logs on the restored database (statements per request), and in-process
micro-benchmarks of the suspects.

| Finding                                                                                     | Measured                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| argon2id verification of the agent key on **every** request                                 | 31 ms CPU each (`m=19456, t=2`); 16 in parallel took 157 ms. An agent topped out at ~20–30 req/s with the API at 330–470 % CPU |
| `/api/mcp` authenticated **twice** per message (global auth, then the MCP route's own)      | two argon2, two key and agent reads, two `auth_success` audit rows per MCP message                                             |
| A department lookup (`directory_employees`) on every authenticated request, agents included | without kon-directory installed (the normal case) it failed every time: one round trip and one Postgres `ERROR` per request    |
| `UPDATE agent_api_keys SET last_used_at` on every agent request                             | one write (connection, commit) per request for a column the panel shows as a date                                              |
| RLS transaction start                                                                       | `begin` and one or two `set_config` sent one by one: 2–3 round trips before the first real query                               |
| Per-route limiter                                                                           | 4 sequential Valkey calls per request (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE`), not atomic                             |
| Agent quotas                                                                                | up to 6 sequential Valkey calls per agent request                                                                              |
| Blog list: sanitizing every post body on every request                                      | 9–13 ms CPU per page of 20 posts (the SQL of that request: ~7 ms over 10 queries)                                              |
| A page that totals the rows of every dataset                                                | counting dataset rows read every row: 223 requests and 73.4 MB for 198 datasets                                                |
| Approvals config, `format=auto` choice                                                      | already cached (approvals snapshot; `auto` remembers the winning format per response shape)                                    |

### What changed (each keeps the check it speeds up)

| Change                                                                                                                                                                                           | Where                                                                   | Why it keeps the guarantee                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A successful argon2 verification is remembered per key: an HMAC-SHA256 of the secret (random per-process key), the key's stored hash, 5 min (`AGENT_KEY_VERIFY_CACHE_SECONDS`, `0` turns it off) | `services/agent-auth.ts`                                                | Only the same secret against the same unchanged hash skips argon2; a wrong secret always pays argon2 and is never remembered (nor does it evict the right one). The key row and the agent row are still read from the database on **every** request, so revocation, expiry and deactivation apply on the next request as before           |
| `/api/mcp` reuses the global authentication of the same request when the token is identical                                                                                                      | `routes/mcp.ts`, `index.ts`                                             | Same request, same token, the same database read microseconds earlier. One `auth_success` audit row per request instead of two                                                                                                                                                                                                            |
| `last_used_at` written at most once per minute per key and process                                                                                                                               | `services/agent-auth.ts`                                                | It is a display date; the audit trail (`agent_audit_logs`, one `auth_success` row per request) is unchanged                                                                                                                                                                                                                               |
| Department lookup skipped for agents, and only when `directory_employees` exists (checked once a minute)                                                                                         | `middleware/user-context.ts`                                            | Agents are not employees; humans still get it once kon-directory is installed                                                                                                                                                                                                                                                             |
| `begin` + `set_config` (+ the agent's scopes) sent as one simple query                                                                                                                           | `packages/engine/src/rls-request.ts`                                    | Only for exactly those statement shapes (closed patterns) with text values, written as literals by the driver's `escapeLiteral`; anything else is sent one by one as before. Postgres runs them in order and stops at the first error. Every transactional request still sets its user, role and scopes; `verify-rls` and the matrix pass |
| Limiter window in one Lua script                                                                                                                                                                 | `lib/rate-limiter.ts`                                                   | Same four operations, now atomic (before, concurrent requests could all read the same count and pass). Falls back to the four calls if the client cannot run scripts                                                                                                                                                                      |
| Agent quotas in one Lua script                                                                                                                                                                   | `lib/agent-quotas.ts`                                                   | Same counters, same order (the day is not counted if the minute already failed), same refunds; falls back to the old steps on any script error                                                                                                                                                                                            |
| Blog sanitizer remembers its output by the **full text** (LRU, 2,000 entries / 8 M characters) and compiles its regular expressions once                                                         | the blog kon's sanitizer (`kon-blog` in the `kitsuden-kons` repository) | Sanitizing is a pure function of the text: same text, same output. A new or edited body is a different key and is sanitized in full. 9–13 → ~2 ms per page                                                                                                                                                                                |
| `GET /api/data-sets/:id/entries?count=exact` returns `totalCount`; with `limit=0` it reads no rows                                                                                               | `routes/crud.ts`                                                        | `count(*)` with the same visibility filter and inside the same RLS transaction as the rows; a user who cannot see a row does not count it (tested)                                                                                                                                                                                        |

A page that totals the rows of every dataset can use that count: on the restored
database, the same **52,264** rows over 198 datasets (0 datasets with a different
figure), with 198 requests and 10.3 KB instead of 223 requests and 73.4 MB, 4.0 s
instead of 9.0 s when done one after another.

### Fixed on the way

- When the pool ran out, agent authentication failed with `401` ("invalid
  key"); a client could take that as a revoked key. It is now `503` with
  `Retry-After: 5` (`KITSUDEN_E_UNAVAILABLE` in MCP). It still does not let
  anyone in.
- The authorization matrix reported `anonymous → 429` on
  `POST /api/cardsim/sessions/:id/join` depending on the order of the run: that
  route allows 10 attempts per 5 minutes, without Valkey it counts in memory,
  and the matrix sends everything from one IP. The matrix now clears the
  in-memory limiter before each request; it measures the gates, not the
  limits (those have their own tests).

### What was not changed, and why

- **The `format=auto` round-trip check is not sampled.** The idea was to skip
  the decode check on shapes already validated (check 1 in N). The shape
  signature looks at three levels and the first three elements of each array;
  a later element with a key TRON cannot write (`null`, `true`, `class`,
  `__proto__`) would go out lossy. Sampling would trade the "never lossy"
  guarantee for ~10–25 ms on 200 KB bodies, so it stays a check on every
  response.
- **The kon cache is still off.** `ctx.cache` in the module loader is a stub
  (`get` always misses), so the blog list, game collections and page-builder
  queries that "cache" do not. Turning it on would help the blog list most,
  but it serves one requester's response to others: the blog's keys separate
  staff from public, but not an editor from an admin, and the lists would be
  up to 60 s stale (comment counts, scheduled posts). That needs a decision
  and a review of each key, not a performance patch.
- **No per-request transaction is skipped**, even for anonymous reads, and no
  security middleware is reordered or bypassed: the in-process MCP pipeline
  keeps identity, gates, idempotency, RLS, quotas and approvals exactly as
  before.
- **The MCP SDK call still serializes and parses the body once each way**
  (`app.request` in process, no network). Passing the handler's JSON string
  straight to `auto` saves ~1 ms per 100 KB but is only safe if that string is
  compact JSON, which a kon is not required to produce.
- **Audit rows are not batched.** One `auth_success` row per agent request is
  still written, asynchronously, as before.
- **Pool size stays at 20.** 20 vs 40 connections at 100 connections,
  interleaved twice, gave no consistent difference on this machine (the
  round trips, not the pool size, were the limit). `DB_POOL_MAX` is the knob;
  measure on your own hardware before changing the default.
- **The per-request query queue** serializes queries _inside_ one
  request's transaction only, because a transaction is one connection; it
  does not block other requests.

### Checks after the changes

- Authorization matrix: 1,079 routes × 10 identities, **0 discrepancies**,
  5 of 5 fine-grained probes.
- `verify-rls` against the restored database with the application role: isolation
  verified (57 protected tables, 12 checked with data).
- MCP harness: oracle 15/15, null 0/15.
- New tests cover the sanitizer cache, the one-statement transaction start
  including a hostile value (`tests/unit/rls-begin-in-one-statement.test.ts`),
  the department lookup (`apps/api/src/tests-unit/user-context.test.ts`) and
  `count=exact` under RLS (`apps/api/src/tests/datasets-http.test.ts`).

## The paid run with Claude (prepared, not run)

Nothing below has been executed. No call to the Claude API was made.

### Cases and grading

The 15 cases in `extras/from-core/apps/api/evals/agents-mcp/cases.ts`, written as a person
would ask their coding assistant, without ids or tool names:

| Group       | Cases                                                                                                        | What the grader checks                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Tier list   | `tierlist-crear-y-colocar`, `tierlist-nuevos-sin-mover`, `tierlist-sacar-al-pool`, `tierlist-intercambiar`   | the list exists once, each item is in the expected tier (or unranked), new items added without moving placed ones |
| Swiss       | `suizo-de-principio-a-fin`, `suizo-reportar-y-emparejar`, `suizo-ronda-a-medias`, `suizo-corregir-resultado` | winners per set, next round paired only when the round is complete, a corrected result                            |
| Elimination | `eliminacion-crear-8`, `eliminacion-semifinal-con-marcador`                                                  | an 8-player bracket; a reported semifinal with its score and the winner advanced                                  |
| League      | `liga-todos-contra-todos`                                                                                    | a round robin with every pairing                                                                                  |
| Check-in    | `checkin-marcar-llegadas`, `checkin-quitar-ausentes`                                                         | who is checked in; absentees removed and the window closed                                                        |
| Broadcast   | `emision-gran-final-bo5`, `emision-evento-bo3`                                                               | one broadcast set with the right sides and best-of                                                                |

Per (case, rep): `completado` (1 if the final state is the one asked for:
the headline metric) and `limpio` (completed with no failed tool call on the
way). The run also records tool calls, tool errors, turns, time and tokens.
Infrastructure failures (API errors, timeouts, a fallback model answering)
go to `errors.jsonl` and are not scored as zeros.

With 15 cases × 3 reps the 95 % interval is about ±15 points: a difference
smaller than that between two runs is not a result.

**Sign-off needed** on: the 15 cases, the grading, the minimal system
prompt (`claude-agent.ts`, `SYSTEM`), and the harness itself
(`--approve-harness`, which writes its hash into `_state.json`). The cases
are synthetic; real requests from users would be worth more.

### Cost estimate

Prices: Anthropic's pricing page,
`https://platform.claude.com/docs/en/about-claude/pricing`, read on
2026-10-25 (USD per million tokens):

| Model                                   | Input | 5-min cache write | Cache hit | Output |
| --------------------------------------- | ----: | ----------------: | --------: | -----: |
| Claude Opus 5.5 (`claude-opus-5-5`)     |    $4 |                $5 |     $0.20 |    $20 |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) |    $2 |             $2.50 |     $0.10 |    $10 |

Inputs to the estimate, measured without a model:

- Fixed prefix per request: 18 tool definitions (2,443 tokens), system prompt
  (61), Anthropic's tool-use system prompt (286 per the pricing page):
  ~2,790 `o200k` tokens, ~3,630 after the +30 % for Claude's tokenizer.
- The oracle needs 53 tool calls for the 15 cases (1 to 10 per case) and
  reads ~17,300 tokens of tool results.

Assumptions: the model makes 1.5× / 2× / 3× the oracle's calls (it has to
look things up first), one call per turn (no parallel calls: pessimistic for
turns), 400 / 800 / 1,500 output tokens per turn (thinking included), and the
harness's automatic prompt caching works (each turn re-reads the previous
context as a cache hit). The no-cache column is the ceiling if caching never
hits.

| Scenario    | Model      | 1 pass (15 cases), cached | 1 pass, no cache | 3 reps, cached | 3 reps, no cache |
| ----------- | ---------- | ------------------------: | ---------------: | -------------: | ---------------: |
| optimistic  | Sonnet 5.5 |                     $0.73 |            $1.72 |          $2.20 |            $5.15 |
| expected    | Sonnet 5.5 |                     $1.44 |            $3.19 |          $4.31 |            $9.56 |
| pessimistic | Sonnet 5.5 |                     $3.59 |            $8.49 |         $10.76 |           $25.46 |
| optimistic  | Opus 5.5   |                     $1.47 |            $3.43 |          $4.41 |           $10.29 |
| expected    | Opus 5.5   |                     $2.87 |            $6.37 |          $8.61 |           $19.11 |
| pessimistic | Opus 5.5   |                     $7.17 |           $16.97 |         $21.51 |           $50.92 |

Hard ceiling per case set by the harness: 40 turns (`MAX_TURNS`),
16,000 output tokens per turn, 900 s per case. A run that hits those limits
everywhere would cost far more than the pessimistic row; the logs record
`usage` per case, so a runaway shows up after the first rows.

Plan: one **pilot pass** (1 rep) per model first, read its real `usage`,
then decide on the 3-rep baseline. The pilot is rep 0 of the baseline, so the
expected total for both models is the 3-rep figures added up: about $13
(cached) to $29 (no cache); pessimistic about $32 to $76.

### What you need to provide

- An Anthropic API key **in an environment variable for that shell only**:
  `export ANTHROPIC_API_KEY=...` (PowerShell: `$env:ANTHROPIC_API_KEY = '...'`).
  Never in `.env`, `_state.json`, a script or any other file.
- The approval of the harness (`--approve-harness`, once, after reviewing
  `run.ts`, `environment.ts`, `cases.ts`, `claude-agent.ts`).
- The OK on cases, grading and budget.

### Exact commands

From the repository root, Bun installed, dependencies installed:

```bash
# 0. Controls first, every time (free). Both must hold: 15/15 and 0/15.
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent oraculo --flow .claude/hillclimb/agents-mcp-paid
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent nulo    --flow .claude/hillclimb/agents-mcp-paid

# 1. Pilot, 1 rep per model (PAID). The first run asks you to approve the
#    harness: review it, then pass --approve-harness once; that stores its hash
#    in <flow>/_state.json.
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent claude --approve-harness   --flow .claude/hillclimb/agents-mcp-paid --variant v1   --model claude-sonnet-5-5 --effort high --reps 1 --concurrency 3
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent claude   --flow .claude/hillclimb/agents-mcp-paid --variant v2   --model claude-opus-5-5 --effort high --reps 1 --concurrency 3

# 2. Baseline, 3 reps (PAID), only after reading the pilot's usage.
#    The runner resumes: rep 0 from the pilot is kept, reps 1-2 run.
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent claude   --flow .claude/hillclimb/agents-mcp-paid --variant v1   --model claude-sonnet-5-5 --effort high --reps 3
bun extras/from-core/apps/api/evals/agents-mcp/run.ts --agent claude   --flow .claude/hillclimb/agents-mcp-paid --variant v2   --model claude-opus-5-5 --effort high --reps 3
```

Notes on the commands:

- `--model` is always passed: the harness default is `claude-opus-5`, the
  previous Opus, at $5 / $25.
- `--effort high` is the harness default and is always sent; it is written
  out because the models' own defaults differ (`medium` on Opus 5.5, `high`
  on Sonnet 5.5), so a comparison must fix it.
- Results land in `<flow>/<variant>/results.jsonl`, traces in
  `<flow>/<variant>/traces/`, infrastructure failures in `errors.jsonl`.
- The request shape was checked against the current API by reading
  `claude-agent.ts`, not by calling it: adaptive thinking with summarized
  display, `output_config.effort`, top-level `cache_control`, the
  `server-side-fallback-2026-07-01` beta with `fallbacks: "default"` (a turn
  answered by the fallback model is not scored), no forced `tool_choice`, no
  sampling parameters, and the assistant turn appended unchanged (needed by
  the thinking-history check on these models).
- To also settle section 1 with Claude's real tokenizer, count a sample of
  the same JSON and TOON bodies with `POST /v1/messages/count_tokens`
  (same key; it is not a generation call).
