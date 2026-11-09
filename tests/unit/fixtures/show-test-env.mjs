// Run by test-environment.test.ts through `test-db.mjs exec`. Shows what the child got.
process.stdout.write(
  JSON.stringify({
    url: process.env.DATABASE_URL,
    env: process.env.NODE_ENV,
    mode: process.env.KITSUDEN_TEST_DB,
    secret: Boolean(process.env.BETTER_AUTH_SECRET),
  })
);
