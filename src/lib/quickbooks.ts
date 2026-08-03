import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/fetchAll";

// ---------------------------------------------------------------------------
// QuickBooks Online OAuth2 + API client.
// Env: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_ENVIRONMENT (sandbox|production),
//      NEXT_PUBLIC_APP_URL (e.g. https://smw.vercel.app) for the redirect URI.
// ---------------------------------------------------------------------------

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

function apiBase(): string {
  // Production is the default; sandbox must be requested explicitly so a
  // missing env var never sends production tokens to the sandbox API (403
  // ApplicationAuthorizationFailed).
  return process.env.QB_ENVIRONMENT === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
}

function clientId(): string {
  const v = process.env.QB_CLIENT_ID;
  if (!v) throw new Error("Missing QB_CLIENT_ID");
  return v;
}

function clientSecret(): string {
  const v = process.env.QB_CLIENT_SECRET;
  if (!v) throw new Error("Missing QB_CLIENT_SECRET");
  return v;
}

// The public origin the user is browsing. On Vercel the request's own URL
// carries the internal deployment host — the real domain is in
// x-forwarded-host — so headers take priority.
export function publicOrigin(request: {
  headers: Headers;
  nextUrl: { origin: string };
}): string {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : request.nextUrl.origin;
}

// The redirect URI must match Intuit's registered value exactly. Prefer the
// canonical configured URL; otherwise derive it from the domain the user is
// actually browsing (requestOrigin) so per-deployment *.vercel.app hosts are
// never sent to Intuit by accident.
export function redirectUri(requestOrigin?: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? requestOrigin;
  if (!base) throw new Error("Missing NEXT_PUBLIC_APP_URL");
  return `${base.replace(/\/$/, "")}/api/qb/callback`;
}

export function authorizeUrl(state: string, requestOrigin?: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirectUri(requestOrigin),
    state,
  });
  return `${AUTH_BASE}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const auth = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    // intuit_tid identifies the request in Intuit's logs for support cases.
    const tid = res.headers.get("intuit_tid");
    const detail = `${res.status} ${await res.text()}${tid ? ` (intuit_tid: ${tid})` : ""}`;
    console.error(`QuickBooks token request failed: ${detail}`);
    throw new Error(`QuickBooks token request failed: ${detail}`);
  }
  return res.json();
}

export async function exchangeCode(
  code: string,
  requestOrigin?: string,
): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(requestOrigin),
    }),
  );
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

// ---------------------------------------------------------------------------
// Connection storage (service-role — qb_connections is RLS deny-all)
// ---------------------------------------------------------------------------

export async function saveConnection(opts: {
  realmId: string;
  tokens: TokenResponse;
  connectedBy: string | null;
}) {
  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at")
    .limit(1)
    .single();
  if (!org) throw new Error("No organization found");

  // Fetch the company name so the settings page can tell companies apart.
  let companyName: string | null = null;
  try {
    companyName = await fetchCompanyName(opts.tokens.access_token, opts.realmId);
  } catch {
    // Non-fatal: the connection still works without a display name.
  }

  const now = Date.now();
  const { error } = await supabase.from("qb_connections").upsert(
    {
      org_id: org.id,
      realm_id: opts.realmId,
      company_name: companyName,
      access_token: opts.tokens.access_token,
      refresh_token: opts.tokens.refresh_token,
      access_token_expires_at: new Date(
        now + opts.tokens.expires_in * 1000,
      ).toISOString(),
      refresh_token_expires_at: new Date(
        now + opts.tokens.x_refresh_token_expires_in * 1000,
      ).toISOString(),
      connected_by: opts.connectedBy,
      status: "connected",
    },
    { onConflict: "org_id,realm_id" },
  );
  if (error) throw new Error(error.message);
}

async function fetchCompanyName(
  accessToken: string,
  realmId: string,
): Promise<string | null> {
  const url = `${apiBase()}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.CompanyInfo?.CompanyName ?? null;
}

// Revoke a company's grant at Intuit (equivalent to disconnecting the app
// from the QuickBooks side) and remove the local connection. A fresh
// Connect afterwards mints a brand-new grant.
export async function revokeConnection(realmId?: string): Promise<void> {
  const supabase = createServiceClient();
  let query = supabase.from("qb_connections").select("id, refresh_token");
  if (realmId) query = query.eq("realm_id", realmId);
  const { data: conn, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!conn) throw new Error("QuickBooks is not connected");

  const auth = Buffer.from(`${clientId()}:${clientSecret()}`).toString(
    "base64",
  );
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token: conn.refresh_token }),
  });
  // Intuit returns 200 on success and 400 if the token was already invalid —
  // either way the grant is dead, so clear the local record.
  if (!res.ok && res.status !== 400) {
    const tid = res.headers.get("intuit_tid");
    throw new Error(
      `QuickBooks revoke failed: ${res.status} ${await res.text()}${tid ? ` (intuit_tid: ${tid})` : ""}`,
    );
  }

  const { error: delError } = await supabase
    .from("qb_connections")
    .delete()
    .eq("id", conn.id);
  if (delError) throw new Error(delError.message);
}

interface ConnectionRow {
  id: string;
  realm_id: string;
  company_name: string | null;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
}

/** All connected companies, each with a valid access token (refreshed if expired). */
export async function getValidConnections(): Promise<
  { accessToken: string; realmId: string; companyName: string | null }[]
> {
  const supabase = createServiceClient();
  const { data: conns, error } = await supabase
    .from("qb_connections")
    .select("id, realm_id, company_name, access_token, refresh_token, access_token_expires_at")
    .eq("status", "connected")
    .order("created_at");
  if (error) throw new Error(error.message);
  if (!conns || conns.length === 0) {
    throw new Error("QuickBooks is not connected");
  }

  const results = [];
  for (const conn of conns as ConnectionRow[]) {
    results.push({
      accessToken: await validAccessToken(conn),
      realmId: conn.realm_id,
      companyName: conn.company_name,
    });
  }
  return results;
}

async function validAccessToken(conn: ConnectionRow): Promise<string> {
  const supabase = createServiceClient();
  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return conn.access_token;
  }

  try {
    const tokens = await refreshTokens(conn.refresh_token);
    const now = Date.now();
    await supabase
      .from("qb_connections")
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        access_token_expires_at: new Date(
          now + tokens.expires_in * 1000,
        ).toISOString(),
        refresh_token_expires_at: new Date(
          now + tokens.x_refresh_token_expires_in * 1000,
        ).toISOString(),
      })
      .eq("id", conn.id);
    return tokens.access_token;
  } catch (e) {
    await supabase
      .from("qb_connections")
      .update({
        status: "error",
        last_sync_error: e instanceof Error ? e.message : "Token refresh failed",
      })
      .eq("id", conn.id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// QBO query API + customer/job import
// ---------------------------------------------------------------------------

interface QboCustomer {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  FullyQualifiedName?: string;
  Active?: boolean;
  Job?: boolean;
  ParentRef?: { value: string };
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: Record<string, unknown>;
}

interface QboExpenseLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  ItemBasedExpenseLineDetail?: {
    CustomerRef?: { value: string };
    ItemRef?: { name?: string };
  };
  AccountBasedExpenseLineDetail?: {
    CustomerRef?: { value: string };
    AccountRef?: { name?: string };
  };
}

interface QboTxn {
  Id: string;
  TxnDate?: string;
  DocNumber?: string;
  VendorRef?: { name?: string };
  EntityRef?: { name?: string };
  Line?: QboExpenseLine[];
}

interface QboTimeActivity {
  Id: string;
  TxnDate?: string;
  CustomerRef?: { value: string };
  EmployeeRef?: { name?: string };
  VendorRef?: { name?: string };
  Description?: string;
  Hours?: number;
  Minutes?: number;
}

interface QboInvoice {
  Id: string;
  TxnDate?: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: { value: string };
}

// Journal entries carry payroll allocations (e.g. Paychex gross wages posted
// as direct labor per job): each line debits a labor account with the job as
// the line's entity.
interface QboJournalLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: "Debit" | "Credit";
    AccountRef?: { name?: string };
    Entity?: { Type?: string; EntityRef?: { value?: string } };
  };
}

interface QboJournalEntry {
  Id: string;
  TxnDate?: string;
  DocNumber?: string;
  Line?: QboJournalLine[];
}

// Internal blended labor cost rate used to value time entries — matches the
// estimating default (project_plans.labor_cost_rate default).
const DEFAULT_LABOR_COST_RATE = 37.15;

// Only transactions dated on or after this are imported into job_costs.
// The transaction-history feature pools costs from the start of 2023. Must
// reach back at least to NO_TXN_CUTOFF (src/lib/jobViews.ts) so the
// No Transactions view can classify against real data.
const JOB_COSTS_START_DATE = "2023-01-01";

// General-ledger lines (gl_lines) are imported from this date forward.
// Balance-sheet accounts on the Financials page therefore show activity
// since this date, not ending balances.
const FINANCIALS_START_DATE = "2023-01-01";

// Direct-cost buckets for the per-job transaction history.
type CostType = "materials" | "labor" | "other";

const LABOR_NAME = /labor|payroll|wages?/i;

// Item-based lines are purchased goods (materials); account-based lines are
// other direct costs — except lines whose item/account name marks them as
// labor. Time entries are always labor (classified at the call site).
function classifyCostType(line: QboExpenseLine): CostType {
  if (line.ItemBasedExpenseLineDetail) {
    const itemName = line.ItemBasedExpenseLineDetail.ItemRef?.name ?? "";
    return LABOR_NAME.test(itemName) ? "labor" : "materials";
  }
  const accountName =
    line.AccountBasedExpenseLineDetail?.AccountRef?.name ?? "";
  return LABOR_NAME.test(accountName) ? "labor" : "other";
}

async function qboQuery<T>(
  accessToken: string,
  realmId: string,
  query: string,
): Promise<T[]> {
  const results: T[] = [];
  const pageSize = 500;
  let start = 1;
  for (;;) {
    // ORDERBY Id makes STARTPOSITION paging deterministic — without it QBO
    // gives no ordering guarantee, so pages can skip or repeat records.
    const paged = `${query} ORDERBY Id STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const url = `${apiBase()}/v3/company/${realmId}/query?query=${encodeURIComponent(paged)}&minorversion=75`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const tid = res.headers.get("intuit_tid");
      const detail = `${res.status} ${await res.text()}${tid ? ` (intuit_tid: ${tid})` : ""}`;
      console.error(`QuickBooks query failed: ${detail}`);
      throw new Error(`QuickBooks query failed: ${detail}`);
    }
    const json = await res.json();
    // QueryResponse holds the entity array alongside scalar keys
    // (startPosition, maxResults, totalCount), so find the array rather
    // than trusting key order. An empty page has no array at all.
    const rows =
      (Object.values(json.QueryResponse ?? {}).find(Array.isArray) as
        | T[]
        | undefined) ?? [];
    results.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return results;
}

export async function syncCustomersAndJobs(): Promise<{
  customers: number;
  jobs: number;
  companies: number;
  /** Total rows now in Supabase after the sync, to confirm nothing was dropped. */
  dbCustomers: number;
  dbJobs: number;
}> {
  const connections = await getValidConnections();
  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at")
    .limit(1)
    .single();
  if (!org) throw new Error("No organization found");

  let customerCount = 0;
  let jobCount = 0;

  for (const { accessToken, realmId, companyName } of connections) {
    // Self-heal connections created before company names were captured.
    if (!companyName) {
      const fetched = await fetchCompanyName(accessToken, realmId);
      if (fetched) {
        await supabase
          .from("qb_connections")
          .update({ company_name: fetched })
          .eq("realm_id", realmId);
      }
    }

    // Without the Active filter QBO returns only active records, so jobs
    // made inactive in QuickBooks would silently vanish from the import.
    const all = await qboQuery<QboCustomer>(
      accessToken,
      realmId,
      "SELECT * FROM Customer WHERE Active IN (true, false)",
    );

    const now = new Date().toISOString();
    const topLevel = all.filter((c) => !c.Job);
    const jobRecords = all.filter((c) => c.Job && c.ParentRef?.value);
    console.log(
      `QB sync ${realmId} (${companyName ?? "unnamed"}): QuickBooks returned ${all.length} Customer records — ${topLevel.length} customers, ${jobRecords.length} jobs`,
    );

    if (topLevel.length > 0) {
      const { error } = await supabase.from("customers").upsert(
        topLevel.map((c) => ({
          org_id: org.id,
          realm_id: realmId,
          qb_id: c.Id,
          display_name: c.DisplayName,
          company_name: c.CompanyName ?? null,
          email: c.PrimaryEmailAddr?.Address ?? null,
          phone: c.PrimaryPhone?.FreeFormNumber ?? null,
          billing_address: c.BillAddr ?? null,
          active: c.Active ?? true,
          last_synced_at: now,
        })),
        { onConflict: "org_id,realm_id,qb_id" },
      );
      if (error) throw new Error(`Customer upsert failed: ${error.message}`);
      customerCount += topLevel.length;
    }

    // Map QB parent ids -> our customer uuids for job linking (per company).
    // Paged read: past 1000 customers an unpaged select truncates and jobs
    // would lose their customer link.
    const customerRows = await fetchAllRows((from, to) =>
      supabase
        .from("customers")
        .select("id, qb_id")
        .eq("org_id", org.id)
        .eq("realm_id", realmId)
        .order("id")
        .range(from, to),
    );
    const byQbId = new Map(customerRows.map((c) => [c.qb_id, c.id]));

    if (jobRecords.length > 0) {
      const { error } = await supabase.from("jobs").upsert(
        jobRecords.map((j) => ({
          org_id: org.id,
          realm_id: realmId,
          qb_id: j.Id,
          customer_id: byQbId.get(j.ParentRef!.value) ?? null,
          name: j.DisplayName,
          fully_qualified_name: j.FullyQualifiedName ?? null,
          active: j.Active ?? true,
          last_synced_at: now,
        })),
        { onConflict: "org_id,realm_id,qb_id" },
      );
      if (error) throw new Error(`Job upsert failed: ${error.message}`);
      jobCount += jobRecords.length;
    }

    await supabase
      .from("qb_connections")
      .update({ last_sync_at: now, last_sync_error: null })
      .eq("realm_id", realmId);
  }

  // Row counts now in Supabase, so the sync result can confirm the imported
  // records all landed (counts are cheap head requests, immune to row caps).
  const [{ count: dbCustomers }, { count: dbJobs }] = await Promise.all([
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
  ]);
  console.log(
    `QB sync complete: pulled ${customerCount} customers + ${jobCount} jobs from QuickBooks; Supabase now holds ${dbCustomers ?? 0} customers + ${dbJobs ?? 0} jobs`,
  );

  return {
    customers: customerCount,
    jobs: jobCount,
    companies: connections.length,
    dbCustomers: dbCustomers ?? 0,
    dbJobs: dbJobs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Actual job costs: bill/purchase lines tagged to a job in QuickBooks
// ---------------------------------------------------------------------------

function extractJobCostRows(
  txns: QboTxn[],
  txnType: "Bill" | "Purchase",
  jobIdByQbId: Map<string, string>,
  orgId: string,
  realmId: string,
  now: string,
) {
  const rows = [];
  for (const txn of txns) {
    const vendor = txn.VendorRef?.name ?? txn.EntityRef?.name ?? null;
    for (const line of txn.Line ?? []) {
      const detail =
        line.ItemBasedExpenseLineDetail ?? line.AccountBasedExpenseLineDetail;
      const customerQbId = detail?.CustomerRef?.value;
      if (!customerQbId) continue;
      const jobId = jobIdByQbId.get(customerQbId);
      if (!jobId) continue; // tagged to a top-level customer, not a job
      rows.push({
        org_id: orgId,
        realm_id: realmId,
        job_id: jobId,
        qb_txn_type: txnType,
        qb_txn_id: txn.Id,
        qb_line_id: line.Id ?? "0",
        qb_doc_number: txn.DocNumber ?? null,
        txn_date: txn.TxnDate ?? null,
        vendor_name: vendor,
        description: line.Description ?? null,
        category:
          line.ItemBasedExpenseLineDetail?.ItemRef?.name ??
          line.AccountBasedExpenseLineDetail?.AccountRef?.name ??
          null,
        cost_type: classifyCostType(line),
        amount: line.Amount ?? 0,
        last_synced_at: now,
      });
    }
  }
  return rows;
}

/**
 * Import actual costs (bill/purchase lines tagged to jobs) and invoiced
 * revenue (invoices billed to jobs) for all companies.
 */
export async function syncJobCosts(): Promise<{
  costLines: number;
  invoices: number;
  companies: number;
}> {
  const connections = await getValidConnections();
  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at")
    .limit(1)
    .single();
  if (!org) throw new Error("No organization found");

  let costLines = 0;
  let invoiceCount = 0;

  for (const { accessToken, realmId } of connections) {
    const now = new Date().toISOString();

    // Paged read: past 1000 jobs an unpaged select truncates the map and
    // cost/invoice lines for the missing jobs would be dropped.
    const jobRows = await fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select("id, qb_id")
        .eq("org_id", org.id)
        .eq("realm_id", realmId)
        .order("id")
        .range(from, to),
    );
    const jobIdByQbId = new Map(
      jobRows.map((j) => [j.qb_id as string, j.id as string]),
    );
    if (jobIdByQbId.size === 0) continue; // no jobs synced for this company yet

    const since = `WHERE TxnDate >= '${JOB_COSTS_START_DATE}'`;
    const [bills, purchases, timeActivities, qbInvoices, journalEntries] = [
      await qboQuery<QboTxn>(accessToken, realmId, `SELECT * FROM Bill ${since}`),
      await qboQuery<QboTxn>(
        accessToken,
        realmId,
        `SELECT * FROM Purchase ${since}`,
      ),
      await qboQuery<QboTimeActivity>(
        accessToken,
        realmId,
        `SELECT * FROM TimeActivity ${since}`,
      ),
      await qboQuery<QboInvoice>(
        accessToken,
        realmId,
        `SELECT * FROM Invoice ${since}`,
      ),
      await qboQuery<QboJournalEntry>(
        accessToken,
        realmId,
        `SELECT * FROM JournalEntry ${since}`,
      ),
    ];

    const timeRows = [];
    for (const t of timeActivities) {
      const jobId = t.CustomerRef?.value
        ? jobIdByQbId.get(t.CustomerRef.value)
        : undefined;
      if (!jobId) continue;
      const hours = (t.Hours ?? 0) + (t.Minutes ?? 0) / 60;
      if (hours <= 0) continue;
      timeRows.push({
        org_id: org.id,
        realm_id: realmId,
        job_id: jobId,
        qb_txn_type: "TimeActivity",
        qb_txn_id: t.Id,
        qb_line_id: "0",
        txn_date: t.TxnDate ?? null,
        vendor_name: t.EmployeeRef?.name ?? t.VendorRef?.name ?? null,
        description: t.Description ?? null,
        category: "Labor (time entries)",
        cost_type: "labor",
        amount: hours * DEFAULT_LABOR_COST_RATE,
        hours,
        last_synced_at: now,
      });
    }

    // Journal-entry lines tagged to a job (e.g. Paychex gross wages posted
    // as direct labor). Debits are costs; credits reduce them. Only
    // customer-type entities can be jobs — vendor/employee refs share the
    // same id space and must not match.
    const journalRows = [];
    for (const je of journalEntries) {
      for (const line of je.Line ?? []) {
        const detail = line.JournalEntryLineDetail;
        const entity = detail?.Entity;
        if (entity?.Type && entity.Type !== "Customer") continue;
        const jobId = entity?.EntityRef?.value
          ? jobIdByQbId.get(entity.EntityRef.value)
          : undefined;
        if (!jobId) continue;
        const account = detail?.AccountRef?.name ?? "";
        const amount = line.Amount ?? 0;
        journalRows.push({
          org_id: org.id,
          realm_id: realmId,
          job_id: jobId,
          qb_txn_type: "JournalEntry",
          qb_txn_id: je.Id,
          qb_line_id: line.Id ?? "0",
          qb_doc_number: je.DocNumber ?? null,
          txn_date: je.TxnDate ?? null,
          vendor_name: null,
          description: line.Description ?? null,
          category: account || null,
          cost_type: LABOR_NAME.test(account) ? "labor" : "other",
          amount: detail?.PostingType === "Credit" ? -amount : amount,
          last_synced_at: now,
        });
      }
    }

    const rows = [
      ...extractJobCostRows(bills, "Bill", jobIdByQbId, org.id, realmId, now),
      ...extractJobCostRows(
        purchases,
        "Purchase",
        jobIdByQbId,
        org.id,
        realmId,
        now,
      ),
      ...timeRows,
      ...journalRows,
    ];

    // Full refresh per company so edits/deletions in QuickBooks are reflected.
    const { error: delError } = await supabase
      .from("job_costs")
      .delete()
      .eq("org_id", org.id)
      .eq("realm_id", realmId);
    if (delError) throw new Error(`Job cost refresh failed: ${delError.message}`);

    if (rows.length > 0) {
      // Insert in chunks to stay under request size limits.
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from("job_costs")
          .insert(rows.slice(i, i + 500));
        if (error) throw new Error(`Job cost insert failed: ${error.message}`);
      }
    }
    costLines += rows.length;

    // Invoices billed to a job (sub-customer); ones billed to a top-level
    // customer aren't job revenue and are skipped.
    const invoiceRows = [];
    for (const inv of qbInvoices) {
      const jobId = inv.CustomerRef?.value
        ? jobIdByQbId.get(inv.CustomerRef.value)
        : undefined;
      if (!jobId) continue;
      invoiceRows.push({
        org_id: org.id,
        realm_id: realmId,
        job_id: jobId,
        qb_invoice_id: inv.Id,
        doc_number: inv.DocNumber ?? null,
        txn_date: inv.TxnDate ?? null,
        amount: inv.TotalAmt ?? 0,
        balance: inv.Balance ?? null,
        last_synced_at: now,
      });
    }

    // Full refresh per company, same as job_costs.
    const { error: invDelError } = await supabase
      .from("job_invoices")
      .delete()
      .eq("org_id", org.id)
      .eq("realm_id", realmId);
    if (invDelError)
      throw new Error(`Invoice refresh failed: ${invDelError.message}`);

    if (invoiceRows.length > 0) {
      for (let i = 0; i < invoiceRows.length; i += 500) {
        const { error } = await supabase
          .from("job_invoices")
          .insert(invoiceRows.slice(i, i + 500));
        if (error) throw new Error(`Invoice insert failed: ${error.message}`);
      }
    }
    invoiceCount += invoiceRows.length;
  }

  return { costLines, invoices: invoiceCount, companies: connections.length };
}

// ---------------------------------------------------------------------------
// General ledger: chart of accounts + every posted ledger line
//
// Lines come from the GeneralLedger report rather than per-entity queries so
// QuickBooks does the double-entry expansion for every transaction type —
// reconstructing postings from Bill/Invoice/Payment/Deposit/… entities
// ourselves would be error-prone and incomplete. Amounts are the report's
// "natural" signed amounts: positive increases the account in its normal
// direction, so net income = sum(Revenue) - sum(Expense).
// ---------------------------------------------------------------------------

interface QboAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  Classification?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
  ParentRef?: { value?: string };
  CurrentBalance?: number;
}

interface QboReportColData {
  value?: string;
  id?: string;
}

interface QboReportRow {
  type?: string; // "Section" | "Data"
  ColData?: QboReportColData[];
  Header?: { ColData?: QboReportColData[] };
  Rows?: { Row?: QboReportRow[] };
}

interface QboReport {
  Columns?: {
    Column?: {
      ColTitle?: string;
      ColType?: string;
      MetaData?: { Name?: string; Value?: string }[];
    }[];
  };
  Rows?: { Row?: QboReportRow[] };
}

interface GlLine {
  accountQbId: string | null;
  accountName: string;
  txnDate: string;
  txnType: string | null;
  qbTxnId: string | null;
  docNumber: string | null;
  entityName: string | null;
  customerName: string | null;
  vendorName: string | null;
  memo: string | null;
  splitAccount: string | null;
  className: string | null;
  departmentName: string | null;
  amount: number;
}

const GL_COLUMNS =
  "tx_date,txn_type,doc_num,name,cust_name,vend_name,memo,split_acc,klass_name,dept_name,subt_nat_amount";

// Fallback for companies where an optional column (class/department/…) makes
// the report request fail.
const GL_COLUMNS_MINIMAL =
  "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount";

async function fetchGeneralLedger(
  accessToken: string,
  realmId: string,
  startDate: string,
  endDate: string,
): Promise<QboReport> {
  const request = (columns: string) => {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      accounting_method: "Accrual",
      columns,
      minorversion: "75",
    });
    return fetch(
      `${apiBase()}/v3/company/${realmId}/reports/GeneralLedger?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );
  };

  let res = await request(GL_COLUMNS);
  if (res.status === 400) res = await request(GL_COLUMNS_MINIMAL);
  if (!res.ok) {
    const tid = res.headers.get("intuit_tid");
    const detail = `${res.status} ${await res.text()}${tid ? ` (intuit_tid: ${tid})` : ""}`;
    console.error(`QuickBooks GeneralLedger report failed: ${detail}`);
    throw new Error(`QuickBooks GeneralLedger report failed: ${detail}`);
  }
  return res.json();
}

// The report nests a Section per account (sub-accounts nest deeper), with
// data rows aligned to the requested columns. Beginning-balance and summary
// rows carry no transaction date and are skipped.
function parseGlReport(report: QboReport): GlLine[] {
  const colKeys = (report.Columns?.Column ?? []).map(
    (c) =>
      c.MetaData?.find((m) => m.Name === "ColKey")?.Value ??
      c.ColType ??
      c.ColTitle?.toLowerCase() ??
      "",
  );
  const col = (row: QboReportRow, key: string): QboReportColData | undefined => {
    const i = colKeys.indexOf(key);
    return i === -1 ? undefined : row.ColData?.[i];
  };
  const text = (row: QboReportRow, key: string): string | null => {
    const v = col(row, key)?.value?.trim();
    return v ? v : null;
  };

  const lines: GlLine[] = [];
  const walk = (
    rows: QboReportRow[],
    account: { qbId: string | null; name: string } | null,
  ) => {
    for (const row of rows) {
      if (row.Rows?.Row) {
        const header = row.Header?.ColData?.[0];
        walk(
          row.Rows.Row,
          header?.value
            ? { qbId: header.id ?? null, name: header.value }
            : account,
        );
        continue;
      }
      if (!row.ColData || (row.type && row.type !== "Data") || !account) {
        continue;
      }
      const txnDate = text(row, "tx_date");
      if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) continue;
      lines.push({
        accountQbId: account.qbId,
        accountName: account.name,
        txnDate,
        txnType: text(row, "txn_type"),
        qbTxnId: col(row, "txn_type")?.id ?? col(row, "doc_num")?.id ?? null,
        docNumber: text(row, "doc_num"),
        entityName: text(row, "name"),
        customerName: text(row, "cust_name"),
        vendorName: text(row, "vend_name"),
        memo: text(row, "memo"),
        splitAccount: text(row, "split_acc"),
        className: text(row, "klass_name"),
        departmentName: text(row, "dept_name"),
        amount: Number.parseFloat(col(row, "subt_nat_amount")?.value ?? "") || 0,
      });
    }
  };
  walk(report.Rows?.Row ?? [], null);
  return lines;
}

// Quarter-sized report windows from the start date through today, so no
// single report response grows unbounded.
function quarterRanges(startDate: string): { start: string; end: string }[] {
  const today = new Date().toISOString().slice(0, 10);
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(today.slice(0, 4));
  const ranges = [];
  for (let year = startYear; year <= endYear; year++) {
    for (let q = 0; q < 4; q++) {
      const start = `${year}-${String(q * 3 + 1).padStart(2, "0")}-01`;
      const endMonthLastDay = new Date(Date.UTC(year, q * 3 + 3, 0));
      const end = endMonthLastDay.toISOString().slice(0, 10);
      if (end < startDate || start > today) continue;
      ranges.push({ start: start < startDate ? startDate : start, end });
    }
  }
  return ranges;
}

/**
 * Import the chart of accounts and all posted general-ledger lines since
 * FINANCIALS_START_DATE. Pass a realmId to import a single company — the
 * full import for every company in one serverless invocation exceeds
 * Vercel's function window, so the sync button runs one request per realm.
 */
export async function syncGeneralLedger(realmId?: string): Promise<{
  accounts: number;
  glLines: number;
  companies: number;
}> {
  let connections = await getValidConnections();
  if (realmId) {
    connections = connections.filter((c) => c.realmId === realmId);
    if (connections.length === 0) {
      throw new Error(`No connected QuickBooks company for realm ${realmId}`);
    }
  }
  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at")
    .limit(1)
    .single();
  if (!org) throw new Error("No organization found");

  let accountCount = 0;
  let lineCount = 0;

  for (const { accessToken, realmId, companyName } of connections) {
    const now = new Date().toISOString();

    const accounts = await qboQuery<QboAccount>(
      accessToken,
      realmId,
      "SELECT * FROM Account WHERE Active IN (true, false)",
    );
    if (accounts.length > 0) {
      const { error } = await supabase.from("gl_accounts").upsert(
        accounts.map((a) => ({
          org_id: org.id,
          realm_id: realmId,
          qb_id: a.Id,
          name: a.Name,
          fully_qualified_name: a.FullyQualifiedName ?? null,
          account_number: a.AcctNum ?? null,
          classification: a.Classification ?? null,
          account_type: a.AccountType ?? null,
          account_sub_type: a.AccountSubType ?? null,
          parent_qb_id: a.ParentRef?.value ?? null,
          active: a.Active ?? true,
          current_balance: a.CurrentBalance ?? null,
          last_synced_at: now,
        })),
        { onConflict: "org_id,realm_id,qb_id" },
      );
      if (error) throw new Error(`GL account upsert failed: ${error.message}`);
      accountCount += accounts.length;
    }

    const glLines: GlLine[] = [];
    for (const range of quarterRanges(FINANCIALS_START_DATE)) {
      const report = await fetchGeneralLedger(
        accessToken,
        realmId,
        range.start,
        range.end,
      );
      glLines.push(...parseGlReport(report));
    }
    console.log(
      `QB GL sync ${realmId} (${companyName ?? "unnamed"}): ${accounts.length} accounts, ${glLines.length} ledger lines since ${FINANCIALS_START_DATE}`,
    );

    // Full refresh per company so edits/deletions in QuickBooks are
    // reflected. gl_lines has no unique key (report rows carry no stable
    // per-line id), so a direct delete-then-insert doubles rows when two
    // syncs overlap — and doing the whole replacement in one transaction
    // outruns statement_timeout at real ledger sizes. Generation scheme
    // instead (migration 0013): rows insert tagged with this run's sync_id,
    // invisible to readers (gl_line_facts filters to the current generation)
    // until finish_gl_sync flips the company's generation pointer in a
    // one-row upsert. No long statement anywhere, and the last completed
    // sync wins wholesale however requests overlap or retry.
    const syncId = crypto.randomUUID();
    const rows = glLines.map((l) => ({
      org_id: org.id,
      realm_id: realmId,
      account_qb_id: l.accountQbId,
      account_name: l.accountName,
      txn_date: l.txnDate,
      txn_type: l.txnType,
      qb_txn_id: l.qbTxnId,
      doc_number: l.docNumber,
      entity_name: l.entityName,
      customer_name: l.customerName,
      vendor_name: l.vendorName,
      memo: l.memo,
      split_account: l.splitAccount,
      class_name: l.className,
      department_name: l.departmentName,
      amount: l.amount,
      last_synced_at: now,
      sync_id: syncId,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("gl_lines")
        .insert(rows.slice(i, i + 500));
      if (error) throw new Error(`GL line insert failed: ${error.message}`);
    }
    const { error: flipError } = await supabase.rpc("finish_gl_sync", {
      p_org_id: org.id,
      p_realm_id: realmId,
      p_sync_id: syncId,
    });
    if (flipError)
      throw new Error(`GL sync publish failed: ${flipError.message}`);
    lineCount += rows.length;

    // Superseded generations (including rows from abandoned runs) are
    // already invisible; delete them in small batches. Failures are
    // non-fatal — the next sync prunes whatever is left.
    const PRUNE_BATCH = 10_000;
    for (let i = 0; i < 500; i++) {
      const { data: pruned, error: pruneError } = await supabase.rpc(
        "prune_gl_lines",
        { p_org_id: org.id, p_realm_id: realmId, p_limit: PRUNE_BATCH },
      );
      if (pruneError) {
        console.error(
          `GL prune for ${realmId} stopped (${pruneError.message}); next sync will finish cleanup`,
        );
        break;
      }
      if ((pruned ?? 0) < PRUNE_BATCH) break;
    }
  }

  return {
    accounts: accountCount,
    glLines: lineCount,
    companies: connections.length,
  };
}
