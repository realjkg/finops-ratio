// Guard for the DB test suite: `npm run test:db` must FAIL (not skip) when no
// test database is configured, so a misconfigured CI job can never go green
// without having run the database tests.
export function requireTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.RATIO_TEST_DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error(
      'RATIO_TEST_DATABASE_URL is not set. The DB test suite requires a Postgres 16 superuser URL ' +
        '(e.g. postgres://postgres@127.0.0.1:55432/postgres); refusing to run (tests are never skipped).',
    );
  }
  return url;
}
