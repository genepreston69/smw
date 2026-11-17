import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { EXPECTED_MIGRATIONS, TRACKING_MIGRATION, missingMigrations } from "@/lib/schemaVersion";

export interface SchemaStatus {
  /** Migration files this build expects that the database has no record of. */
  missing: string[];
  /** The newest migration the database has recorded, if any. */
  latest: string | null;
}

/**
 * Compares the database's migration record with the files this build was made
 * from. Null when the check itself failed — it must never take a page down.
 *
 * Before migration 0040 there is no record at all; that reports every file
 * from 0040 on as missing (older ones can't be checked).
 */
export async function loadSchemaStatus(): Promise<SchemaStatus | null> {
  try {
    const db = createServiceClient();
    const { data, error } = await db.from("schema_migrations").select("filename");
    if (error) {
      if (error.code !== "42P01" && error.code !== "PGRST205") throw new Error(error.message);
      const from = EXPECTED_MIGRATIONS.indexOf(TRACKING_MIGRATION);
      return { missing: EXPECTED_MIGRATIONS.slice(from), latest: null };
    }
    const applied = ((data ?? []) as { filename: string }[]).map((r) => r.filename);
    return {
      missing: missingMigrations(applied),
      latest: applied.sort().at(-1) ?? null,
    };
  } catch (e) {
    console.error(`Schema status check failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
