/**
 * For scripts that make no sense on pg-mem. Import it FIRST, before anything that
 * reaches `src/db`, which chooses its database when it is first imported.
 *
 * With NODE_ENV=test, `src/db` uses pg-mem unless told otherwise. A migration run
 * there dies inside pg-mem's parser («A "codeblock" token», on every plpgsql body),
 * and the database you meant to migrate stays as it was. This asks for real Postgres,
 * which `src/db` then connects to or fails with the actual reason.
 */
if (process.env.NODE_ENV === "test") {
  if (process.env.KITSUDEN_TEST_DB?.trim().toLowerCase() === "memory") {
    console.error(
      "KITSUDEN_TEST_DB=memory: this script needs a real Postgres, and pg-mem is not one. " +
        "For the test database: pnpm test:db:migrate"
    );
    process.exit(1);
  }
  process.env.KITSUDEN_TEST_DB = "postgres";
}

export {};
