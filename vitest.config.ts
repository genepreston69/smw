import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure business logic in src/lib, plus database tests
// (tests/db) that apply every migration to a real Postgres and check the SQL
// the app depends on. The database tests run only when TEST_DATABASE_URL is
// set — see tests/README.md.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next's marker package throws outside a server bundle.
      "server-only": path.resolve(__dirname, "tests/stubs/empty.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/db/globalSetup.ts"],
    // The database tests share one database.
    fileParallelism: false,
  },
});
