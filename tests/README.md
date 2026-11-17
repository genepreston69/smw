# Tests

```bash
npm test            # everything that can run here
npm run test:watch  # re-run on change
```

Two kinds:

- **Unit tests** (`tests/*.test.ts`) cover the pure business logic in
  `src/lib` — cost math, job bucketing, budget spreads, benefit rate, period
  parsing, settings, and the conventions around migrations. They need nothing.
- **Database tests** (`tests/db/*.test.ts`) run against a real Postgres. Before
  the run, `tests/db/globalSetup.ts` wipes the test database and applies
  `tests/db/supabase-stub.sql` (the API roles and a minimal `auth` schema) and
  then every file in `supabase/migrations/`, in order. The tests then check the
  SQL the app relies on: that the cost views and their TypeScript mirrors
  (`costing.ts`, `barge.ts`) produce the same numbers, the sync queue's rules,
  the all-or-nothing saves, the ledger pivot, and migration tracking.

Database tests are **skipped** unless `TEST_DATABASE_URL` points at a
throwaway database (it is wiped on every run — never point it at real data):

```bash
createdb smw_test
TEST_DATABASE_URL=postgres://localhost/smw_test npm test
```

CI (`.github/workflows/ci.yml`) runs lint, the type check, both kinds of test
against a Postgres service, and the production build on every pull request.

When you add a migration: end it with its `schema_migrations` insert and add
the file name to `EXPECTED_MIGRATIONS` in `src/lib/schemaVersion.ts` —
`tests/migrations.test.ts` fails otherwise.
