# Analytics

Views per subject and day, with no personal data: how often a game page, a blog post, a wiki page,
a dataset, a tournament or a streamer page was viewed. It was the kon `kon-analytics`; since 0.9 it
is part of Kitsuden, with the same routes, ids, scopes (`kon:analytics:*`) and MCP tools.

Code: `apps/api/src/routes/analytics.ts`, table in `apps/api/src/db/schema-core.ts`, migration
`0083_analytics.sql`.

## What is stored

One row per subject and day (`analytics_views`) with a counter. No IP, no cookie, no user agent:
nobody's path can be rebuilt from it, and no consent banner is needed. It counts **views**, never
unique visitors, and an interface must call them that.

Subjects: `game`, `blog_post`, `wiki_page`, `wiki`, `dataset`, `tournament`, `streamer`. Each lives
in its own table, owned by a kon that may not be installed; a type without its kon simply has no
rows.

## Routes

| Route                                  | Who    | What                                                                                               |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `POST /api/analytics/hit`              | public | Adds ONE view of `{ type, id }` for today. Answers 204.                                            |
| `GET /api/analytics/top`               | public | The most viewed of a type over `days` (1–365, default 30); `limit` 1–50; `ids` ranks inside a set. |
| `GET /api/analytics/subject/:type/:id` | public | One subject's views per day, oldest first, with the total.                                         |

## A public counter can be inflated

`hit` cannot know who calls it without storing exactly what it refuses to store. So:

- known bots are dropped by their user agent;
- one request adds one view, never a number from the body;
- the subject must be a uuid of a known type, and one that does not exist is not counted (the
  answer is the same 204, so `hit` cannot be used to ask which ids exist);
- `hit` has its own per-IP limit, 30 a minute (the IP is a key in the limiter's cache, never
  stored).

What is left is an indicative ranking. For auditable figures, use server analytics over the logs.

## Coming from kon-analytics

Nothing to migrate by hand: `0083` creates the table only if it is missing, keeps every row of an
installation that had the kon, and renames its 0.8 index names in place. If the kon is still in
`packages/kons`, the loader does not mount it and says so; remove it with
`kitsuden kon remove analytics`.
