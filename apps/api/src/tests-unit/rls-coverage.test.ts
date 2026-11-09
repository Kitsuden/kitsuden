/**
 * RLS coverage — every table with an owner is DECIDED, not forgotten
 * ============================================================================
 *
 * The hole this test closes: RLS covered 2 tables out of 147 and nobody
 * knew, because nothing forced a decision. A new table with `user_id` was born
 * without a policy and without any check flagging it.
 *
 * The rule: every table with an ownership column (user_id, owner_id,
 * created_by, author_id) must be in ONE of two places:
 *
 *   · rls-owned-tables.sql — PERSONAL ownership → isolated by RLS
 *   · COLLABORATIVE (here) — authorship in a team tool → decided that it is
 *     NOT isolated, with the reason written next to it
 *
 * A table in neither breaks the test. That way "I forgot" stops
 * being a possible state: either you isolated it, or you signed off on why not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..", "..");

/**
 * Tables whose ownership column is AUTHORSHIP in a collaborative tool.
 * Isolating them by creator would break the team visibility that is the point of
 * those apps; their access control lives in the application policies, which
 * understand teams and roles.
 */
const COLLABORATIVE = new Map<string, string>([
  // Store: `owner_id` is WHO CREATED IT, not whose row it is. The buyer
  // is not a system user — they are identified by `customer_email` —, and the
  // team running the store has to see the whole catalog and all orders
  // or it cannot serve them. Isolating by creator would leave half the staff unable to see
  // the orders they have to fulfill.
  ["shop_products", "catalog shared by the store team"],
  ["shop_orders", "orders are served by the team, not only by whoever registered them"],

  // CRM: deals and contacts belong to the sales TEAM, not to whoever typed them in.
  ["crm_companies", "portfolio shared by the sales team"],
  ["crm_contacts", "portfolio shared by the sales team"],
  ["crm_pipelines", "shared configuration"],
  ["crm_deals", "portfolio shared by the sales team"],
  ["crm_activities", "activity visible to the team"],
  ["crm_entity_configs", "shared configuration"],
  // Agile: an issue is seen by the whole project, not only by whoever opened it. Project
  // membership is enforced by kon-agile/0001's own RLS.
  ["agile_project_members", "project membership; own RLS in kon-agile/0001"],
  ["agile_projects", "visible to the whole project team"],
  ["agile_cycles", "shared planning"],
  ["agile_modules", "shared planning"],
  ["agile_issues", "an issue is seen by the whole project"],
  ["agile_issue_links", "relations between shared issues"],
  ["agile_intakes", "team inbox"],
  ["agile_comments", "conversation visible to the project"],
  // Accounting: the accounting role is granted by an admin; own RLS in kon-conta/0001.
  ["conta_permissions", "accounting permissions; own RLS in kon-conta/0001"],
  // DMS: documents are shared (by ACL, with own RLS in
  // kon-dms/0005); the personal trail IS isolated.
  ["dms_documents", "documents shared with viewers/editors"],
  ["dms_access_log", "audit: compliance must see it, not only the actor"],
  ["dms_document_comments", "conversation visible to whoever sees the document"],
  // Directory: it is a directory — its nature is to be visible.
  ["directory_employees", "corporate directory, visible by design"],
  // Already covered by rls-policies.sql (the original policy, with its nuance of
  // owner_id NULL + data->>'ownerId' that this generator does not reproduce).
  ["data_entries", "isolated in rls-policies.sql with its own policy"],
  // Academy: group membership and log — managed by training/HR.
  ["group_users", "group enrollment, managed by the trainer"],
  ["academy_activity_log", "training audit: the trainer must see it"],
  // Blog: author_id is editorial authorship; posts are public or part of the
  // editorial flow, never private to the author.
  ["blog_posts", "editorial content, visible through the publishing flow"],
  // OCR: documents come in through a pipeline (system context) and are reviewed by
  // a team of operators.
  ["ocr_documents", "processing queue reviewed by operators"],
  // Broadcast: a tournament set is operated by an entire production team
  // (direction, scoreboard operator, casters) and its overlay is read by OBS WITHOUT a
  // session. Isolating it by the operator who typed it in would break the live stream; who
  // can MUTATE it is decided by the "broadcast" policy.
  [
    "broadcast_matches",
    "live production: the whole team sees it, and the overlay without a session",
  ],
  // Wiki: history is its reason for being. Isolating revisions by author would leave
  // each editor seeing only their own — that is, with no history.
  ["wiki_revisions", "a wiki's history is public by definition"],
  // CardSim: a game is shared by its players and its spectators. What
  // each one SEES is trimmed by `viewFor` per seat, which is the right layer:
  // isolating the whole row would leave the opponent unable to see the table.
  ["cardsim_sessions", "shared game; secrecy is applied by viewFor per seat"],
  // A ranking is PUBLIC: it is literally what gets published. Isolating it
  // by user would leave each person seeing only their own row — that is, without
  // ranking.
  ["cardsim_ratings", "public ranking table: isolating it would empty it"],
  // The matchmaking queue ONLY works if the matchmaker can read other
  // people's rows: isolated by user, nobody would ever find an opponent. The
  // rows never go out to the client — only the route that forms the table reads them.
  [
    "cardsim_queue",
    "the matchmaker needs to see other people's rows; they are not served to the client",
  ],
  // A showcase is PUBLIC: it is literally what gets published. Isolating the
  // entries by author would leave each person seeing only their own decks — that is, without a
  // gallery. Who can EDIT them is decided by the "deckshow" policy.
  ["deckshow_entries", "public gallery: isolating it by author would empty it"],
  // A "like" has to be counted and has to be able to answer "have I
  // given it one?". Isolated by user, neither can be done.
  ["deckshow_likes", "the counter is public and you need to know if you already voted"],
  // A card dataset is an editorial catalog: whoever administers uploads it and
  // anyone queries it without an account, which is the tool's reason for being.
  ["handlab_datasets", "public card catalog; owner_id says who administers it"],
  // An autobattler set is a catalog of the GAME: whoever administers uploads it and
  // anyone queries it without an account — computing synergies is what people come in for.
  ["autobattler_sets", "public set catalog; owner_id says who administers it"],
  // Comps are a public tier list. Isolating them by author would leave each person
  // seeing only their own; who can EDIT them is decided by the policy.
  ["autobattler_comps", "public tier list of compositions: isolating it would empty it"],
  // A comment is published to be read. Isolating it by author would leave
  // each person seeing only their own, which is a thread of one person. What is
  // HIDDEN (deleted, under moderation) is decided by `status`, not RLS.
  ["comments", "public thread: isolating it by author would leave it a monologue"],
  // Same case as deckshow_likes: the counter is public and the interface has
  // to be able to answer "have I already voted?" — isolated, neither is possible.
  ["comment_votes", "the counter is public and you need to know if you already voted"],
  // ── The three that widening OWNERSHIP to `*_user_id` uncovered ──
  // Esports: a player profile and a list of registrants are PUBLIC —it is
  // literally what gets published about a tournament. Isolating them by the account that
  // signed up would leave the bracket empty for everyone except its owner.
  // Who can MUTATE them is decided by the kon's policy.
  ["esports_players", "public competitor profile: the bracket shows it to everyone"],
  ["esports_tournament_participants", "a tournament's list of registrants is public by definition"],
  // Members: `auth_user_id` is the OPTIONAL bridge to a CMS account (normally
  // null), not the ownership of the row. A member is a contact managed
  // by the team from the admin; isolating it by that column would hide from the
  // panel the thousands who have no account.
  ["members", "contact managed by the team; auth_user_id is an optional bridge"],

  // `sponsor_user_id` is the human who SIGNS what an agent
  // creates, not the owner of the row. Agents and proposals are configuration
  // and the team's inbox (only the API and the admin/editor panel touch them).
  [
    "agent_identities",
    "agent identity managed by admin; sponsor_user_id is its signer, not its owner",
  ],
  [
    "agent_proposals",
    "team approval inbox, system and admin/editor under RLS (rls-system-only.sql); sponsor_user_id is the agent's signer",
  ],
  // History of an agent's definition (0066): configuration that admins read and
  // restore; `created_by` is who changed it, not who owns the row.
  ["agent_versions", "history of an agent's definition, admin only; created_by is the editor"],
  // Two-factor secrets and backup codes (0072): STRICTER than owner isolation. The
  // table is system-only (rls-system-only.sql): not even the user reads their own
  // row through SQL, only better-auth with the empty context does.
  ["auth_two_factors", "system-only under RLS (rls-system-only.sql); user_id is not a read grant"],
  // A team is PUBLIC: it appears in the bracket, in the rankings and in the
  // overlay. `created_by_user_id` says who can administer it, not who
  // can see it — that is decided by the kon's policy (only the captain invites).
  ["esports_teams", "a team is published in the bracket; created_by is whoever administers it"],
  // An invitation has to be seen by BOTH: the inviter, to know whether it
  // is still pending, and the recipient. Isolating it by the sender would leave the
  // invitee unable to open their own link. What protects it is the token,
  // which is random and single-use.
  ["esports_team_invites", "seen by sender and recipient; what protects it is the token"],
]);

/**
 * Columns that denote ownership/authorship.
 *
 * The suffix is anchored at the end but NOT at the start: it used to require the exact name
 * (`"user_id"`), so a column `registered_by_user_id` —or
 * any `*_user_id`, which is the normal way to name it when the table
 * already has another reference to a user— got in without anyone having to decide
 * anything. That is exactly the hole this test exists to close.
 */
const OWNERSHIP = /"(\w*_)?(user_id|owner_id|created_by|author_id)"/;

/** Extracts (table → has an ownership column) from a schema file. */
function ownedTablesIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];

  // Splits by table definition; the SQL name is the first argument.
  const chunks = source.split(/export const \w+ = pgTable\(/).slice(1);
  for (const chunk of chunks) {
    const name = chunk.match(/^\s*"(\w+)"/)?.[1];
    if (!name) continue;
    // Only the body of THIS table, not what comes after.
    const body = chunk.slice(
      0,
      chunk.indexOf("pgTable(") === -1 ? undefined : chunk.indexOf("pgTable(")
    );
    if (OWNERSHIP.test(body)) out.push(name);
  }
  return out;
}

function allSchemaFiles(): string[] {
  const files = [join(ROOT, "apps/api/src/db/schema-core.ts")];
  const konsDir = join(ROOT, "packages/kons");
  for (const kon of readdirSync(konsDir, { withFileTypes: true })) {
    if (!kon.isDirectory()) continue;
    const base = join(konsDir, kon.name);
    for (const candidate of readdirSync(base)) {
      if (candidate.endsWith(".schema.ts")) files.push(join(base, candidate));
    }
    // Some kons keep the schema in src/
    try {
      for (const candidate of readdirSync(join(base, "src"))) {
        if (/^schema.*\.ts$/.test(candidate)) files.push(join(base, "src", candidate));
      }
    } catch {
      /* without src/ */
    }
  }
  return files;
}

const RLS_SQL = readFileSync(join(ROOT, "apps/api/src/db/rls-owned-tables.sql"), "utf8");

describe("RLS coverage", () => {
  const owned = allSchemaFiles().flatMap(ownedTablesIn);

  test("there are tables with owners to audit (the detector works)", () => {
    // If this drops below 20, the parser broke and the rest of the test would be
    // passing vacuously — the kind of false green that has bitten us before.
    // (Without installed kons —clean clone of the core— only the core's
    // are left, which are a few: the threshold goes down, but not to zero.)
    const hasKons = readdirSync(join(ROOT, "packages/kons"), { withFileTypes: true }).some(
      (e) => e.isDirectory() && e.name.startsWith("kon-")
    );
    expect(owned.length).toBeGreaterThan(hasKons ? 20 : 3);
  });

  for (const table of new Set(owned)) {
    test(`${table}: isolated by RLS or excluded with a reason`, () => {
      const isolated = RLS_SQL.includes(`('${table}',`);
      const excluded = COLLABORATIVE.has(table);

      expect(
        isolated || excluded,
        `The table "${table}" has an ownership column but is in neither ` +
          `rls-owned-tables.sql nor in this test's COLLABORATIVE list. ` +
          `Decide: is the row PERSONAL (add it to the SQL) or TEAM-owned ` +
          `(add it to COLLABORATIVE with the reason)?`
      ).toBe(true);

      // Being in both places is also an error: it means two
      // people decided opposite things without seeing each other.
      expect(
        !(isolated && excluded),
        `"${table}" is isolated in the SQL AND excluded as collaborative. Pick one.`
      ).toBe(true);
    });
  }

  test("the SQL applies FORCE, not just ENABLE", () => {
    // Without FORCE the table owner (the app role) is exempt and all
    // these policies would be decorative.
    expect(RLS_SQL).toContain("FORCE ROW LEVEL SECURITY");
  });
});
