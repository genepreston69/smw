import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// Rebuilds the test database from nothing before the run: the Supabase stub,
// then every migration file in name order — which is itself the test that all
// migrations apply cleanly, in order, to an empty database.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return; // database tests skip themselves

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "drop schema if exists public cascade; drop schema if exists auth cascade; create schema public;",
    );
    await client.query(fs.readFileSync(path.join(__dirname, "supabase-stub.sql"), "utf8"));
    const dir = path.join(__dirname, "../../supabase/migrations");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      try {
        await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      } catch (e) {
        throw new Error(`Migration ${file} failed to apply: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await client.end();
  }
}
