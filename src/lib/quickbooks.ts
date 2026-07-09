import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

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

// Internal blended labor cost rate used to value time entries — matches the
// estimating default (project_plans.labor_cost_rate default).
const DEFAULT_LABOR_COST_RATE = 37.15;

// Only transactions dated on or after this are imported into job_costs.
// The transaction-history feature pools costs from the start of 2023. Must
// reach back at least to NO_TXN_CUTOFF (src/lib/jobViews.ts) so the
// No Transactions view can classify against real data.
const JOB_COSTS_START_DATE = "2023-01-01";

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
    const paged = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
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
    const rows: T[] =
      json.QueryResponse?.Customer ??
      json.QueryResponse?.[Object.keys(json.QueryResponse ?? {})[0]] ??
      [];
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

    const all = await qboQuery<QboCustomer>(
      accessToken,
      realmId,
      "SELECT * FROM Customer",
    );

    const now = new Date().toISOString();
    const topLevel = all.filter((c) => !c.Job);
    const jobRecords = all.filter((c) => c.Job && c.ParentRef?.value);

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

    // Map QB parent ids -> our customer uuids for job linking (per company)
    const { data: customerRows } = await supabase
      .from("customers")
      .select("id, qb_id")
      .eq("org_id", org.id)
      .eq("realm_id", realmId);
    const byQbId = new Map((customerRows ?? []).map((c) => [c.qb_id, c.id]));

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

  return {
    customers: customerCount,
    jobs: jobCount,
    companies: connections.length,
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

    const { data: jobRows } = await supabase
      .from("jobs")
      .select("id, qb_id")
      .eq("org_id", org.id)
      .eq("realm_id", realmId);
    const jobIdByQbId = new Map(
      (jobRows ?? []).map((j) => [j.qb_id as string, j.id as string]),
    );
    if (jobIdByQbId.size === 0) continue; // no jobs synced for this company yet

    const since = `WHERE TxnDate >= '${JOB_COSTS_START_DATE}'`;
    const [bills, purchases, timeActivities, qbInvoices] = [
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
