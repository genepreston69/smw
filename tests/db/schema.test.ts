import { expect, it } from "vitest";
import { missingMigrations } from "@/lib/schemaVersion";
import { createUser, describeDb, num } from "./db";

describeDb("migration tracking (0040)", (db) => {
  it("a database built from every migration reports nothing missing", async () => {
    const { rows } = await db().query("select filename from schema_migrations");
    expect(missingMigrations(rows.map((r) => r.filename))).toEqual([]);
  });

  it("only migrations can write the record", async () => {
    const admin = await createUser(db(), "first-admin@superiormarineinc.com");
    await db().query("begin");
    try {
      await db().query("set local role authenticated");
      await db().query("select set_config('request.jwt.claim.sub', $1, true)", [admin]);
      await expect(
        db().query("insert into schema_migrations (filename) values ('9999_forged.sql')"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db().query("rollback");
    }
  });
});

describeDb("sync queue (0024 / 0039)", (db) => {
  const begin = async (trigger: string, steps: object[]) =>
    (await db().query("select public.begin_qb_sync_run(current_date, 'America/New_York', $1, $2) as id", [
      JSON.stringify(steps), trigger,
    ])).rows[0].id as string;
  const claim = async (runId?: string) =>
    (await db().query("select public.claim_qb_sync_step(p_run_id => $1) as step", [runId ?? null])).rows[0]
      .step as { id: string; label: string; attempts: number } | null;
  const finish = (id: string, ok: boolean, maxAttempts = 3) =>
    db().query("select public.finish_qb_sync_step($1, $2, null, $3, $4)", [id, ok, ok ? null : "boom", maxAttempts]);

  it("runs one step at a time, and a manual sync works only its own steps", async () => {
    await db().query("truncate qb_sync_runs cascade");
    const scheduled = await begin("scheduled", [
      { kind: "customers_jobs", label: "A" },
      { kind: "job_costs", label: "B" },
    ]);
    const manual = await begin("manual", [{ kind: "general_ledger", realm_id: "r1", label: "M" }]);

    const m = await claim(manual);
    expect(m?.label).toBe("M");
    expect(await claim()).toBeNull(); // the nightly worker waits
    expect(await claim(manual)).toBeNull();
    await finish(m!.id, true);

    const a = await claim();
    expect(a?.label).toBe("A"); // steps in order
    // A second scheduled run the same day is not created.
    expect(await begin("scheduled", [{ kind: "job_costs", label: "dup" }])).toBeNull();
    await finish(a!.id, true);

    // A manual sync started now takes its own step, not the nightly run's B.
    const manual2 = await begin("manual", [{ kind: "customers_jobs", label: "M2" }]);
    expect((await claim(manual2))?.label).toBe("M2");
    void scheduled;
  });

  it("a failed manual step is not retried; cancelling clears what hasn't started", async () => {
    await db().query("truncate qb_sync_runs cascade");
    const run = await begin("manual", [
      { kind: "customers_jobs", label: "first" },
      { kind: "job_costs", label: "second" },
    ]);
    const first = await claim(run);
    await finish(first!.id, false, 1);
    await db().query("select public.cancel_qb_sync_run($1, 'Skipped')", [run]);
    const { rows } = await db().query(
      "select label, status, error from qb_sync_steps where run_id = $1 order by position", [run]);
    expect(rows).toEqual([
      { label: "first", status: "failed", error: "boom" },
      { label: "second", status: "failed", error: "Skipped" },
    ]);
    expect((await db().query("select status from qb_sync_runs where id = $1", [run])).rows[0].status).toBe("failed");
  });

  it("a stranded nightly step is retried; a stranded manual one is failed", async () => {
    await db().query("truncate qb_sync_runs cascade");
    const manual = await begin("manual", [{ kind: "customers_jobs", label: "M" }]);
    await claim(manual);
    await db().query("update qb_sync_steps set started_at = now() - interval '20 minutes'");
    const scheduled = await begin("scheduled", [{ kind: "job_costs", label: "N" }]);
    const n = await claim();
    expect(n?.label).toBe("N");
    expect((await db().query("select status from qb_sync_steps where run_id = $1", [manual])).rows[0].status)
      .toBe("failed");
    await db().query("update qb_sync_steps set started_at = now() - interval '20 minutes' where run_id = $1", [scheduled]);
    expect((await claim())?.attempts).toBe(2);
  });
});

describeDb("all-or-nothing saves (0039)", (db) => {
  it("a barge quote keeps its takeoff when the replacement fails", async () => {
    const user = await createUser(db(), "barge-owner@superiormarineinc.com");
    const quoteId = (await db().query(
      "insert into barge_quotes (name, created_by) values ('Q', $1) returning id", [user])).rows[0].id;
    const good = [{ section: "plating", item: "kept", unit: "ft", qty: 1, unit_lb: 2, yield_pct: 90, price_per_lb: 1 }];
    await db().query("select public.replace_barge_quote_content($1, $2, $3)", [
      quoteId, JSON.stringify(good), JSON.stringify([{ name: "fit", hours: 5 }]),
    ]);
    // yield_pct 0 violates the table's check, after the deletes have run.
    const bad = [{ ...good[0], item: "new", yield_pct: 0 }];
    await expect(
      db().query("select public.replace_barge_quote_content($1, $2, '[]')", [quoteId, JSON.stringify(bad)]),
    ).rejects.toThrow(/yield_pct/);
    const lines = await db().query("select item from barge_quote_steel_lines where quote_id = $1", [quoteId]);
    const labor = await db().query("select name from barge_quote_labor_phases where quote_id = $1", [quoteId]);
    expect(lines.rows).toEqual([{ item: "kept" }]);
    expect(labor.rows).toEqual([{ name: "fit" }]);
  });

  it("someone who doesn't own the quote can't replace its content", async () => {
    const owner = await createUser(db(), "barge-owner2@superiormarineinc.com");
    const other = await createUser(db(), "barge-other@superiormarineinc.com");
    const quoteId = (await db().query(
      "insert into barge_quotes (name, created_by) values ('Q2', $1) returning id", [owner])).rows[0].id;
    const line = [{ section: "plating", item: "x", unit: "ft", qty: 1, unit_lb: 2, yield_pct: 90, price_per_lb: 1 }];
    await db().query("begin");
    try {
      await db().query("set local role authenticated");
      await db().query("select set_config('request.jwt.claim.sub', $1, true)", [other]);
      await expect(
        db().query("select public.replace_barge_quote_content($1, $2, '[]')", [quoteId, JSON.stringify(line)]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await db().query("rollback");
    }
  });

  it("a budget initiative keeps its lines when the replacement fails", async () => {
    const id = (await db().query(
      "insert into budget_initiatives (budget_year, realm_id, name) values (2027, 'r1', 'I') returning id")).rows[0].id;
    await db().query("select public.replace_budget_initiative_lines($1, $2)", [
      id, JSON.stringify([{ account_name: "kept", classification: "Expense", annual_amount: 100 }]),
    ]);
    await expect(
      db().query("select public.replace_budget_initiative_lines($1, $2)", [
        id, JSON.stringify([{ account_name: "new", classification: "Expense", annual_amount: "not a number" }]),
      ]),
    ).rejects.toThrow(/numeric/);
    const { rows } = await db().query(
      "select account_name, annual_amount from budget_initiative_lines where initiative_id = $1", [id]);
    expect(rows.map((r) => [r.account_name, num(r.annual_amount)])).toEqual([["kept", 100]]);
  });
});

describeDb("ledger pivot (0009 / 0042)", (db) => {
  it("gl_pivot_cells returns exactly gl_pivot's cells, and only the published ledger", async () => {
    const org = (await db().query("select public.default_org_id() as id")).rows[0].id;
    await db().query(
      `insert into gl_accounts (realm_id, qb_id, name, fully_qualified_name, classification, account_type) values
         ('r1', 'a1', '400 Sales', '400 Sales', 'Revenue', 'Income'),
         ('r1', 'a2', '710 Labor Cost', '710 Labor Cost', 'Expense', 'Cost of Goods Sold')`);
    const current = "11111111-1111-1111-1111-111111111111";
    const stale = "22222222-2222-2222-2222-222222222222";
    await db().query(
      "insert into gl_sync_state (org_id, realm_id, current_sync_id) values ($1, 'r1', $2)", [org, current]);
    await db().query(
      `insert into gl_lines (realm_id, account_qb_id, account_name, txn_date, class_name, amount, sync_id) values
         ('r1', 'a1', '400 Sales', '2026-01-15', 'Shop', 1000, $1),
         ('r1', 'a1', '400 Sales', '2026-02-10', null, 250.5, $1),
         ('r1', 'a2', '710 Labor Cost', '2026-01-20', 'Shop', 400, $1),
         ('r1', 'a2', '710 Labor Cost', '2026-01-21', 'Shop', 999, $2)`, [current, stale]);

    const args = ["2026-01-01", "2026-12-31", "account", "month", null, ["Revenue", "Expense"]];
    const table = await db().query(
      `select classification, account_type, row_key, col_key, amount, line_count
         from public.gl_pivot($1, $2, $3, $4, $5, $6) order by row_key, col_key`, args);
    const json = (await db().query("select public.gl_pivot_cells($1, $2, $3, $4, $5, $6) as cells", args)).rows[0]
      .cells as { row_key: string; col_key: string; amount: number; line_count: number }[];

    expect(json.map((c) => [c.row_key, c.col_key, c.amount, c.line_count])).toEqual(
      table.rows.map((r) => [r.row_key, r.col_key, num(r.amount), num(r.line_count)]),
    );
    // The superseded generation's 999 is not in the ledger.
    expect(json.map((c) => [c.row_key, c.col_key, c.amount])).toEqual([
      ["400 Sales", "2026-01", 1000],
      ["400 Sales", "2026-02", 250.5],
      ["710 Labor Cost", "2026-01", 400],
    ]);
  });
});

describeDb("business rule settings (0041)", (db) => {
  it("anyone signed in can read them; only an admin can change them", async () => {
    await db().query("truncate app_settings");
    // The first user ever created in this database is the admin.
    const admin = (await db().query("select id from profiles where role = 'admin' limit 1")).rows[0].id;
    const user = await createUser(db(), "settings-user@superiormarineinc.com");
    const as = async (uid: string, sql: string) => {
      await db().query("begin");
      try {
        await db().query("set local role authenticated");
        await db().query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
        return await db().query(sql);
      } finally {
        await db().query("rollback");
      }
    };
    const write = "insert into app_settings (key, value) values ('budget_year', '2028') returning key";
    await expect(as(user, write)).rejects.toThrow(/row-level security/);
    expect((await as(admin, write)).rows).toEqual([{ key: "budget_year" }]);
    await db().query("insert into app_settings (key, value) values ('budget_year', '2028')");
    expect((await as(user, "select value from app_settings where key = 'budget_year'")).rows).toEqual([{ value: 2028 }]);
  });
});
