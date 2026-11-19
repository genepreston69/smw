import { beforeAll, expect, it } from "vitest";
import { describeDb, num } from "./db";

// cap_job_lines (migration 0044) is the one definition of what the
// Capitalized Jobs page counts and which Direct Cost column each line is in.
describeDb("capitalized jobs (0044)", (db) => {
  let jobId: string;
  // [txn type, line, category, account id, classification, cost_type, amount, je_debits_asset]
  const costs: [string, string, string, string | null, string | null, string, number, boolean | null][] = [
    ["JournalEntry", "wages", "710 Labor Cost:Wages", "a710w", "Expense", "labor", 1000, false],
    // Employer taxes booked outside 710 are still labor.
    ["JournalEntry", "fica", "Payroll Taxes:FICA Employer", "atax", "Expense", "labor", 80, false],
    // Withholdings are a liability and never count.
    ["JournalEntry", "wh", "Payroll Liabilities:Federal W/H", "aliab", "Liability", "labor", -150, false],
    ["Bill", "sub", "720 Contract Service", "a720", "Expense", "other", 300, null],
    // A payroll-sounding account under 720 follows its account, not its name.
    ["JournalEntry", "clabor", "720 Contract Service:Contract Labor", "a720l", "Expense", "labor", 25, false],
    ["Purchase", "fuel", "839 Fuel & Oil", "a839", "Expense", "other", 40, null],
    // An item line posts to its item's expense account.
    ["Bill", "steel", "Steel Plate", "a705", "Expense", "materials", 500, null],
    ["VendorCredit", "credit", "Steel Plate", "a705", "Expense", "materials", -50, null],
    ["Bill", "freight", "837 Freight", "a837", "Expense", "other", 60, null],
    // Matched by account number when the name doesn't carry it.
    ["Bill", "numbered", "Shipping", "anum", "Expense", "other", 5, null],
    // Not a Direct Cost account; a stock item bought into inventory.
    ["Bill", "rent", "800 Rent", "a800", "Expense", "other", 999, null],
    ["Bill", "stock", "Paint", "ainv", "Asset", "materials", 777, null],
    // Frozen history: an account the chart no longer has, and an untraceable item line.
    ["Bill", "oldfuel", "839 Fuel & Oil:Diesel", null, null, "other", 7, null],
    ["Bill", "olditem", "Welding Rod", null, null, "materials", 9, null],
    // The capitalizing entry credits cost off to an asset.
    ["JournalEntry", "cap", "710 Labor Cost:Wages", "a710w", "Expense", "labor", -600, true],
    ["JournalEntry", "capasset", "150 Equipment", "afa", "Asset", "other", 600, true],
    ["TimeActivity", "time", "Welder", null, null, "labor", 400, null],
  ];

  beforeAll(async () => {
    await db().query("delete from job_costs where realm_id = 'cap'");
    await db().query("delete from jobs where realm_id = 'cap'");
    await db().query("delete from gl_accounts where realm_id = 'cap'");
    await db().query(
      `insert into gl_accounts (realm_id, qb_id, name, fully_qualified_name, account_number, classification, account_type, parent_qb_id) values
         ('cap', 'a710',  '710 Labor Cost', '710 Labor Cost', null, 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'a710w', 'Wages', '710 Labor Cost:Wages', null, 'Expense', 'Cost of Goods Sold', 'a710'),
         ('cap', 'atax',  'FICA Employer', 'Payroll Taxes:FICA Employer', null, 'Expense', 'Expense', null),
         ('cap', 'aliab', 'Federal W/H', 'Payroll Liabilities:Federal W/H', null, 'Liability', 'Other Current Liability', null),
         ('cap', 'a720',  '720 Contract Service', '720 Contract Service', null, 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'a720l', 'Contract Labor', '720 Contract Service:Contract Labor', null, 'Expense', 'Cost of Goods Sold', 'a720'),
         ('cap', 'a839',  '839 Fuel & Oil', '839 Fuel & Oil', null, 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'a705',  '705 Material Cost', '705 Material Cost', null, 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'a837',  '837 Freight', '837 Freight', null, 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'anum',  'Shipping', 'Shipping', '837', 'Expense', 'Cost of Goods Sold', null),
         ('cap', 'a800',  '800 Rent', '800 Rent', null, 'Expense', 'Expense', null),
         ('cap', 'ainv',  'Inventory Asset', 'Inventory Asset', null, 'Asset', 'Other Current Asset', null),
         ('cap', 'afa',   '150 Equipment', '150 Equipment', null, 'Asset', 'Fixed Asset', null)`,
    );
    jobId = (await db().query(
      "insert into jobs (qb_id, name, realm_id) values ('capjob', 'EQP-1', 'cap') returning id",
    )).rows[0].id;
    for (const [type, lineId, category, accountId, classification, costType, amount, debitsAsset] of costs) {
      await db().query(
        `insert into job_costs (realm_id, job_id, qb_txn_type, qb_txn_id, qb_line_id, txn_date, category,
                                qb_account_id, account_classification, cost_type, amount, je_debits_asset)
         values ('cap', $1, $2, $3, $3, '2026-03-15', $4, $5, $6, $7, $8, $9)`,
        [jobId, type, lineId, category, accountId, classification, costType, amount, debitsAsset],
      );
    }
  });

  it("puts each line in its Direct Cost column and leaves the rest out", async () => {
    const { rows } = await db().query(
      "select qb_line_id, kind, treatment from cap_job_lines l join job_costs jc using (id) where l.job_id = $1 order by 1",
      [jobId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.qb_line_id, `${r.kind}/${r.treatment}`]))).toEqual({
      wages: "labor/posted",
      fica: "labor/posted",
      sub: "contract/posted",
      clabor: "contract/posted",
      fuel: "fuel/posted",
      steel: "materials/posted",
      credit: "materials/posted",
      freight: "freight/posted",
      numbered: "freight/posted",
      oldfuel: "fuel/posted",
      olditem: "materials/posted",
      cap: "labor/capitalized",
    });
  });

  it("totals by column", async () => {
    const { rows } = await db().query(
      "select kind, treatment, sum(amount) as amount from cap_job_lines where job_id = $1 group by 1, 2",
      [jobId],
    );
    const total = (kind: string, treatment = "posted") =>
      num(rows.find((r) => r.kind === kind && r.treatment === treatment)?.amount ?? 0);
    expect(total("labor")).toBe(1080);
    expect(total("contract")).toBe(325);
    expect(total("fuel")).toBe(47);
    expect(total("materials")).toBe(459);
    expect(total("freight")).toBe(65);
    expect(total("labor", "capitalized")).toBe(-600);
  });

  // The chart of accounts is admin-only; the page is not. A non-admin must
  // see the same lines, and still not the chart itself.
  it("non-admin users see every line; anonymous callers cannot read it", async () => {
    await db().query("begin");
    try {
      await db().query("set local role authenticated");
      const { rows } = await db().query("select count(*) as n from cap_job_lines where job_id = $1", [jobId]);
      expect(num(rows[0].n)).toBe(12);
      expect((await db().query("select 1 from gl_accounts where realm_id = 'cap'")).rows).toEqual([]);
      await db().query("rollback");
      await db().query("begin");
      await db().query("set local role anon");
      await expect(db().query("select 1 from cap_job_lines limit 1")).rejects.toThrow(/permission denied/);
    } finally {
      await db().query("rollback");
    }
  });
});
