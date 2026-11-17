import { Client } from "pg";
import { afterAll, beforeAll, describe } from "vitest";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * A describe block that runs against the test database (rebuilt from the
 * migrations by globalSetup), and is skipped when TEST_DATABASE_URL is unset.
 * The callback gets a function returning the connected client.
 */
export function describeDb(name: string, body: (db: () => Client) => void) {
  describe.skipIf(!TEST_DATABASE_URL)(name, () => {
    let client: Client;
    beforeAll(async () => {
      client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
    });
    afterAll(async () => {
      await client.end();
    });
    body(() => client);
  });
}

/** A signed-up user (the signup trigger creates the profile). */
export async function createUser(db: Client, email: string): Promise<string> {
  const { rows } = await db.query("insert into auth.users (email) values ($1) returning id", [
    email,
  ]);
  return rows[0].id as string;
}

/** Postgres returns numeric as text; compare as numbers. */
export const num = (v: unknown): number => Number(v);
