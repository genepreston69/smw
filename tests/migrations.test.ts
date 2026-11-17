import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS, TRACKING_MIGRATION, missingMigrations } from "@/lib/schemaVersion";
import { FINANCIALS_START_DATE, JOB_COSTS_START_DATE, NO_TXN_CUTOFF } from "@/lib/businessRules";

const dir = path.join(__dirname, "../supabase/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const tracked = files.filter((f) => f >= TRACKING_MIGRATION);

describe("migration conventions", () => {
  it("EXPECTED_MIGRATIONS lists exactly the files in supabase/migrations", () => {
    // Added a migration? Add its file name to src/lib/schemaVersion.ts.
    expect([...EXPECTED_MIGRATIONS]).toEqual(files);
  });

  it("every migration from 0040 on records itself in schema_migrations", () => {
    for (const f of tracked) {
      expect(read(f), `${f} must end with its schema_migrations insert`).toMatch(
        new RegExp(`insert into public\\.schema_migrations \\(filename\\)\\s+values \\('${f.replace(".", "\\.")}'\\)\\s+on conflict do nothing;\\s*$`),
      );
    }
  });

  it("file names are NNNN_snake_case.sql and new numbers are never reused", () => {
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = tracked.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    // New files continue the sequence, with no gaps.
    numbers.forEach((n, i) => expect(Number(n)).toBe(40 + i));
  });

  it("missingMigrations reports what a database lacks, in order", () => {
    expect(missingMigrations(EXPECTED_MIGRATIONS)).toEqual([]);
    expect(missingMigrations(EXPECTED_MIGRATIONS.slice(0, -2))).toEqual(EXPECTED_MIGRATIONS.slice(-2));
  });
});

describe("dates that must stay code (businessRules.ts)", () => {
  it("the cost import window reaches back at least as far as the No Transactions cutoff", () => {
    expect(JOB_COSTS_START_DATE <= NO_TXN_CUTOFF).toBe(true);
  });

  it("the ledger import start matches the date frozen into gl_line_facts", () => {
    // The view hides un-archived lines before this date (migration 0020).
    // Changing FINANCIALS_START_DATE needs a migration that archives first.
    const view = [...files].reverse().map(read).find((sql) => /create (or replace )?view public\.gl_line_facts/i.test(sql));
    expect(view).toBeDefined();
    const def = view!.slice(view!.search(/create (or replace )?view public\.gl_line_facts/i));
    expect(def.slice(0, def.indexOf(";"))).toContain(`'${FINANCIALS_START_DATE}'`);
  });
});
