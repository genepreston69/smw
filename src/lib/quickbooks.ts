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

/**
 * A token request Intuit answered with a refusal. `permanent` is true only
 * for `invalid_grant` — the refresh token is expired or revoked and nothing
 * but reconnecting the company fixes it. Everything else (5xx, rate limits,
 * and network failures, which never get this far) is worth retrying.
 */
export class QbTokenError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "QbTokenError";
  }
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
    const text = await res.text();
    const detail = `${res.status} ${text}${tid ? ` (intuit_tid: ${tid})` : ""}`;
    console.error(`QuickBooks token request failed: ${detail}`);
    throw new QbTokenError(
      `QuickBooks token request failed: ${detail}`,
      res.status === 400 && text.includes("invalid_grant"),
    );
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
      last_sync_error: null,
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
  status: string;
}

/**
 * Every company that can sync right now, each with a valid access token
 * (refreshed if expired).
 *
 * Connections marked `error` are tried again rather than skipped: a refresh
 * that works puts the company back to `connected`, so one bad morning never
 * drops a company for good. A company whose refresh token Intuit has
 * definitively refused is left out — the others still sync — and stays
 * `error` until an admin reconnects it. A transient failure (network, 5xx)
 * throws without touching the connection, so the caller's retry gets a
 * clean second attempt.
 */
export async function getValidConnections(): Promise<
  { accessToken: string; realmId: string; companyName: string | null }[]
> {
  const supabase = createServiceClient();
  const { data: conns, error } = await supabase
    .from("qb_connections")
    .select("id, realm_id, company_name, access_token, refresh_token, access_token_expires_at, status")
    .in("status", ["connected", "error"])
    .order("created_at");
  if (error) throw new Error(error.message);
  if (!conns || conns.length === 0) {
    throw new Error("QuickBooks is not connected");
  }

  const results = [];
  for (const conn of conns as ConnectionRow[]) {
    let accessToken: string;
    try {
      accessToken = await validAccessToken(conn);
    } catch (e) {
      if (e instanceof QbTokenError && e.permanent) continue;
      throw e;
    }
    results.push({
      accessToken,
      realmId: conn.realm_id,
      companyName: conn.company_name,
    });
  }
  if (results.length === 0) {
    throw new Error(
      "QuickBooks needs to be reconnected: every company's authorization has expired or been revoked",
    );
  }
  return results;
}

async function validAccessToken(conn: ConnectionRow): Promise<string> {
  const supabase = createServiceClient();
  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  // A connection in `error` always goes back to Intuit: its stored access
  // token is not trusted until a refresh succeeds.
  if (conn.status === "connected" && expiresAt - Date.now() > 60_000) {
    return conn.access_token;
  }

  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(conn.refresh_token);
  } catch (e) {
    // Only Intuit saying the grant is dead takes a company out of the sync.
    // A network blip or a 5xx leaves it connected for the next attempt.
    if (e instanceof QbTokenError && e.permanent) {
      await supabase
        .from("qb_connections")
        .update({
          status: "error",
          last_sync_error: `Reconnect this company — QuickBooks no longer accepts its authorization. ${e.message}`,
        })
        .eq("id", conn.id);
    }
    throw e;
  }

  const now = Date.now();
  const { error } = await supabase
    .from("qb_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
      refresh_token_expires_at: new Date(
        now + tokens.x_refresh_token_expires_in * 1000,
      ).toISOString(),
      status: "connected",
      last_sync_error: null,
    })
    .eq("id", conn.id);
  if (error) {
    // QuickBooks rotates refresh tokens, so an unsaved one can strand the
    // connection later. This run can still use the access token it just got.
    console.error(
      `QuickBooks tokens for realm ${conn.realm_id} could not be saved: ${error.message}`,
    );
  }
  return tokens.access_token;
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
    ItemRef?: { value?: string; name?: string };
  };
  AccountBasedExpenseLineDetail?: {
    CustomerRef?: { value: string };
    AccountRef?: { value?: string; name?: string };
  };
}

interface QboTxn {
  Id: string;
  TxnDate?: string;
  DocNumber?: string;
  VendorRef?: { name?: string };
  EntityRef?: { name?: string };
  /** Purchase only: true for a credit-card credit (a refund), not a charge. */
  Credit?: boolean;
  Line?: QboExpenseLine[];
}

// Products and services, for the account an item-based purchase line posts
// to: a stock item's inventory asset, otherwise its expense account.
interface QboItem {
  Id: string;
  Type?: string;
  ExpenseAccountRef?: { value?: string };
  AssetAccountRef?: { value?: string };
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
    AccountRef?: { value?: string; name?: string };
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

// The books are audited through 2024-12-31, so syncs import — and refresh —
// only transactions dated on or after this. Rows dated before it were
// imported prior to the freeze and persist untouched in Supabase (the
// transaction-history feature still pools costs from the start of 2023).
// Must reach back at least to NO_TXN_CUTOFF (src/lib/jobViews.ts) so the
// No Transactions view can classify against real data.
const JOB_COSTS_START_DATE = "2025-01-01";

// General-ledger lines (gl_lines) are imported from this date forward.
// Pre-2025 ledger lines are frozen audited history: migration 0020 marked
// them archived, gl_line_facts keeps them visible outside the generation
// scheme, and prune_gl_lines never touches them. Balance-sheet accounts on
// the Financials page show activity since 2023-01-01 (frozen history plus
// this import window), not ending balances.
const FINANCIALS_START_DATE = "2025-01-01";

// Direct-cost buckets for the per-job transaction history.
type CostType = "materials" | "labor" | "other";

const LABOR_NAME = /labor|payroll|wages?/i;

// A journal entry that debits a capital asset is moving cost onto the balance
// sheet — the signature of a capitalization entry. The asset account varies
// by equipment and job, so this goes by account type, never by name.
// Migration 0030 backfilled frozen rows with the same rule from the ledger.
const CAPITAL_ASSET_TYPES = new Set(["Fixed Asset", "Other Asset"]);

function isCapitalAssetAccount(account: QboAccount | undefined): boolean {
  return (
    account?.Classification === "Asset" &&
    CAPITAL_ASSET_TYPES.has(account.AccountType ?? "")
  );
}

// The account a bill / purchase line posts to: an account-based line names
// it; an item-based line posts to its item's purchase account — the inventory
// asset for a stock item, the expense account otherwise. Capitalized
// Materials (cap_material_lines, migration 0036) counts only lines that
// reached an expense account.
function expenseLineAccountId(
  line: QboExpenseLine,
  itemById: Map<string, QboItem>,
): string | null {
  if (line.ItemBasedExpenseLineDetail) {
    const item = itemById.get(line.ItemBasedExpenseLineDetail.ItemRef?.value ?? "");
    const ref =
      item?.Type === "Inventory" ? item.AssetAccountRef : item?.ExpenseAccountRef;
    return ref?.value ?? null;
  }
  return line.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null;
}

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
// Actual job costs: bill/purchase/vendor-credit lines tagged to a job in QuickBooks
// ---------------------------------------------------------------------------

function extractJobCostRows(
  txns: QboTxn[],
  txnType: "Bill" | "Purchase" | "VendorCredit",
  jobIdByQbId: Map<string, string>,
  accountById: Map<string, QboAccount>,
  itemById: Map<string, QboItem>,
  orgId: string,
  realmId: string,
  now: string,
) {
  const rows = [];
  for (const txn of txns) {
    const vendor = txn.VendorRef?.name ?? txn.EntityRef?.name ?? null;
    // A vendor credit or a credit-card credit refunds cost, so it counts
    // against the job — the same sign rule as a journal-entry credit.
    const sign = txnType === "VendorCredit" || txn.Credit ? -1 : 1;
    for (const line of txn.Line ?? []) {
      const detail =
        line.ItemBasedExpenseLineDetail ?? line.AccountBasedExpenseLineDetail;
      const customerQbId = detail?.CustomerRef?.value;
      if (!customerQbId) continue;
      const jobId = jobIdByQbId.get(customerQbId);
      if (!jobId) continue; // tagged to a top-level customer, not a job
      const accountId = expenseLineAccountId(line, itemById);
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
        amount: sign * (line.Amount ?? 0),
        qb_account_id: accountId,
        account_classification: accountId
          ? (accountById.get(accountId)?.Classification ?? null)
          : null,
        last_synced_at: now,
      });
    }
  }
  return rows;
}

/**
 * Import actual costs (bill/purchase/vendor-credit lines tagged to jobs) and
 * invoiced revenue (invoices billed to jobs) for all companies.
 */
/**
 * Replaces one company's import window (rows dated on or after
 * JOB_COSTS_START_DATE) with what QuickBooks just returned, without ever
 * leaving the window empty.
 *
 * Every fetched row is upserted on its QuickBooks key and stamped with this
 * sync's time; only then are the window's rows that this sync did not touch
 * deleted — those are transactions edited away or deleted in QuickBooks. The
 * old order (delete the window, then insert) lost a company's costs whenever
 * the inserts failed or the function was killed in between. Now a sync that
 * dies partway leaves every row in place (some refreshed, some not yet) and
 * the next sync finishes the job.
 *
 * Upserting also absorbs a transaction re-dated in QuickBooks from before the
 * window into it: its frozen row has the same key, so it is updated in place
 * instead of colliding with the unique constraint and failing every sync.
 * Rows dated before the window that QuickBooks did not return are frozen
 * audited history and are never touched. (No row can have a null txn_date:
 * the QBO queries filter on TxnDate.)
 */
async function refreshImportWindow(
  supabase: ReturnType<typeof createServiceClient>,
  opts: {
    table: "job_costs" | "job_invoices";
    conflictKey: string;
    /** Names the rows in error messages. */
    what: string;
    orgId: string;
    realmId: string;
    /** This sync's last_synced_at stamp, already set on every row. */
    syncedAt: string;
    rows: Record<string, unknown>[];
  },
): Promise<void> {
  // Chunked to stay under request size limits.
  for (let i = 0; i < opts.rows.length; i += 500) {
    const { error } = await supabase
      .from(opts.table)
      .upsert(opts.rows.slice(i, i + 500), { onConflict: opts.conflictKey });
    if (error) throw new Error(`${opts.what} import failed: ${error.message}`);
  }

  const untouched = () =>
    supabase
      .from(opts.table)
      .delete()
      .eq("org_id", opts.orgId)
      .eq("realm_id", opts.realmId)
      .gte("txn_date", JOB_COSTS_START_DATE);
  for (const { error } of [
    await untouched().lt("last_synced_at", opts.syncedAt),
    await untouched().is("last_synced_at", null),
  ]) {
    if (error) throw new Error(`${opts.what} cleanup failed: ${error.message}`);
  }
}

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

  for (const { accessToken, realmId, companyName } of connections) {
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
    if (jobIdByQbId.size === 0) {
      // No jobs synced for this company yet.
      console.log(
        `QB cost sync ${realmId} (${companyName ?? "unnamed"}): skipped — no jobs in Supabase for this company`,
      );
      continue;
    }

    const since = `WHERE TxnDate >= '${JOB_COSTS_START_DATE}'`;
    const [
      bills,
      purchases,
      vendorCredits,
      timeActivities,
      qbInvoices,
      journalEntries,
      accounts,
      items,
    ] = [
      await qboQuery<QboTxn>(accessToken, realmId, `SELECT * FROM Bill ${since}`),
      await qboQuery<QboTxn>(
        accessToken,
        realmId,
        `SELECT * FROM Purchase ${since}`,
      ),
      await qboQuery<QboTxn>(
        accessToken,
        realmId,
        `SELECT * FROM VendorCredit ${since}`,
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
      // The chart of accounts, so journal and bill / purchase lines carry
      // their account's classification (Capitalized Labor and Capitalized
      // Materials count only expense-side lines) and capitalization entries
      // can be told apart.
      await qboQuery<QboAccount>(
        accessToken,
        realmId,
        "SELECT * FROM Account WHERE Active IN (true, false)",
      ),
      // Products and services, for the account an item-based line posts to.
      await qboQuery<QboItem>(
        accessToken,
        realmId,
        "SELECT * FROM Item WHERE Active IN (true, false)",
      ),
    ];
    const accountById = new Map(accounts.map((a) => [a.Id, a]));
    const itemById = new Map(items.map((i) => [i.Id, i]));

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
    // same id space and must not match. Each line also records its account's
    // classification and whether its entry capitalizes — debits a capital
    // asset on any line, tagged or not — for the Capitalized Labor rule
    // (cap_labor_lines, migration 0030).
    const journalRows = [];
    for (const je of journalEntries) {
      const debitsAsset = (je.Line ?? []).some(
        (l) =>
          l.JournalEntryLineDetail?.PostingType === "Debit" &&
          isCapitalAssetAccount(
            accountById.get(l.JournalEntryLineDetail.AccountRef?.value ?? ""),
          ),
      );
      for (const line of je.Line ?? []) {
        const detail = line.JournalEntryLineDetail;
        const entity = detail?.Entity;
        if (entity?.Type && entity.Type !== "Customer") continue;
        const jobId = entity?.EntityRef?.value
          ? jobIdByQbId.get(entity.EntityRef.value)
          : undefined;
        if (!jobId) continue;
        const account = detail?.AccountRef?.name ?? "";
        const accountId = detail?.AccountRef?.value ?? null;
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
          qb_account_id: accountId,
          account_classification: accountId
            ? (accountById.get(accountId)?.Classification ?? null)
            : null,
          je_debits_asset: debitsAsset,
          last_synced_at: now,
        });
      }
    }

    const expenseRows = (
      txns: QboTxn[],
      txnType: "Bill" | "Purchase" | "VendorCredit",
    ) =>
      extractJobCostRows(
        txns,
        txnType,
        jobIdByQbId,
        accountById,
        itemById,
        org.id,
        realmId,
        now,
      );
    const rows = [
      ...expenseRows(bills, "Bill"),
      ...expenseRows(purchases, "Purchase"),
      ...expenseRows(vendorCredits, "VendorCredit"),
      ...timeRows,
      ...journalRows,
    ];

    // Refresh the import window per company so edits/deletions in QuickBooks
    // are reflected — write first, clear second (refreshImportWindow), so a
    // sync that dies partway never leaves the company's costs missing.
    await refreshImportWindow(supabase, {
      table: "job_costs",
      conflictKey: "org_id,realm_id,qb_txn_type,qb_txn_id,qb_line_id",
      what: "Job cost",
      orgId: org.id,
      realmId,
      syncedAt: now,
      rows,
    });
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

    // Refresh the import window per company, same as job_costs.
    await refreshImportWindow(supabase, {
      table: "job_invoices",
      conflictKey: "org_id,realm_id,qb_invoice_id",
      what: "Invoice",
      orgId: org.id,
      realmId,
      syncedAt: now,
      rows: invoiceRows,
    });
    invoiceCount += invoiceRows.length;
    console.log(
      `QB cost sync ${realmId} (${companyName ?? "unnamed"}): ${rows.length} cost lines + ${invoiceRows.length} invoices since ${JOB_COSTS_START_DATE}`,
    );
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
  Summary?: { ColData?: QboReportColData[] };
  Rows?: { Row?: QboReportRow[] };
}

interface QboReport {
  Header?: { Option?: { Name?: string; Value?: string }[] };
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
// the report request fail. A report fetched this way has no class, customer,
// vendor or department on any line, so the fallback is never silent: the
// caller counts it (GlColumnUse) and syncGeneralLedger refuses to publish a
// ledger that mixes the two, or that would drop classes the published ledger
// has.
const GL_COLUMNS_MINIMAL =
  "tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount";

/** How many report windows of one company's sync came back with the full
    column set, and how many only with the minimal one. */
interface GlColumnUse {
  full: number;
  minimal: number;
}

async function fetchGeneralLedger(
  accessToken: string,
  realmId: string,
  startDate: string,
  endDate: string,
  columnUse: GlColumnUse,
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
  // A 400 is either a company that rejects an optional column (every window
  // will) or a one-off fault. Ask once more before giving up the columns.
  if (res.status === 400) res = await request(GL_COLUMNS);
  if (res.status === 400) {
    console.warn(
      `QB GL report ${realmId} ${startDate}..${endDate}: QuickBooks rejected the full column set (400); retrying without class, customer, vendor and department`,
    );
    res = await request(GL_COLUMNS_MINIMAL);
    if (res.ok) columnUse.minimal += 1;
  } else if (res.ok) {
    columnUse.full += 1;
  }
  if (!res.ok) {
    const tid = res.headers.get("intuit_tid");
    const detail = `${res.status} ${await res.text()}${tid ? ` (intuit_tid: ${tid})` : ""}`;
    console.error(`QuickBooks GeneralLedger report failed: ${detail}`);
    throw new Error(`QuickBooks GeneralLedger report failed: ${detail}`);
  }
  return res.json();
}

// The Reports API caps a response at 400,000 cells and, past that, does not
// fail: the report just stops, ending with an "Unable to display more data.
// Please reduce the date range." row. The GeneralLedger report lists accounts
// in chart order — balance sheet, income, cost of goods sold, expenses, then
// other income / other expense — so a cut-off window silently loses the
// accounts at the end (interest expense among them). A report that carries
// the notice, or that comes close enough to the cap that it may have been
// cut without one, counts as truncated.
const REPORT_CELL_LIMIT = 400_000;
const REPORT_TRUNCATED_CELLS = REPORT_CELL_LIMIT * 0.95;
const REPORT_TRUNCATED_TEXT = "unable to display more data";

const mentionsTruncation = (text: string | undefined) =>
  !!text && text.toLowerCase().includes(REPORT_TRUNCATED_TEXT);

// The report nests a Section per account (sub-accounts nest deeper), with
// data rows aligned to the requested columns. Beginning-balance and summary
// rows carry no transaction date and are skipped. `truncated` means the lines
// are incomplete and the window must be re-fetched in smaller pieces.
function parseGlReport(report: QboReport): { lines: GlLine[]; truncated: boolean } {
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

  // Every amount is read from this column. If QuickBooks ever renames or
  // drops it, each line would parse as 0 and a ledger of zeros would replace
  // the good one — fail instead. (A report with no columns at all is an
  // empty window, which is fine.)
  if (colKeys.length > 0 && !colKeys.includes("subt_nat_amount")) {
    throw new Error(
      `QuickBooks GeneralLedger report has no amount column (subt_nat_amount); got columns: ${colKeys.join(", ")}`,
    );
  }

  const lines: GlLine[] = [];
  let cells = 0;
  let truncated = (report.Header?.Option ?? []).some(
    (o) => mentionsTruncation(o.Name) || mentionsTruncation(o.Value),
  );
  // Notices sit in rows that are not ledger lines; a line's own text (its
  // memo) is never checked, so a memo can't masquerade as the notice.
  const checkNotice = (cols: QboReportColData[] | undefined) => {
    if (cols?.some((c) => mentionsTruncation(c.value))) truncated = true;
  };
  const walk = (
    rows: QboReportRow[],
    account: { qbId: string | null; name: string } | null,
  ) => {
    for (const row of rows) {
      cells +=
        (row.ColData?.length ?? 0) +
        (row.Header?.ColData?.length ?? 0) +
        (row.Summary?.ColData?.length ?? 0);
      checkNotice(row.Header?.ColData);
      checkNotice(row.Summary?.ColData);
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
        checkNotice(row.ColData);
        continue;
      }
      const txnDate = text(row, "tx_date");
      if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
        checkNotice(row.ColData);
        continue;
      }
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
  return { lines, truncated: truncated || cells >= REPORT_TRUNCATED_CELLS };
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Every ledger line dated start..end (inclusive). A window whose report comes
 * back truncated is split in half and re-fetched until each piece fits; a
 * single day that still doesn't fit fails the sync rather than publishing a
 * ledger with lines missing.
 */
async function fetchGeneralLedgerLines(
  accessToken: string,
  realmId: string,
  start: string,
  end: string,
  columnUse: GlColumnUse,
): Promise<GlLine[]> {
  const { lines, truncated } = parseGlReport(
    await fetchGeneralLedger(accessToken, realmId, start, end, columnUse),
  );
  if (!truncated) return lines;
  if (start >= end) {
    throw new Error(
      `QuickBooks GeneralLedger report for ${start} exceeds the report API's ${REPORT_CELL_LIMIT.toLocaleString("en-US")}-cell limit even for a single day`,
    );
  }
  const from = Date.parse(`${start}T00:00:00Z`);
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - from) / DAY_MS);
  const mid = from + Math.floor(days / 2) * DAY_MS;
  console.log(
    `QB GL report ${realmId} ${start}..${end} hit the report cell limit; re-fetching as ${start}..${isoDay(mid)} and ${isoDay(mid + DAY_MS)}..${end}`,
  );
  return [
    ...(await fetchGeneralLedgerLines(accessToken, realmId, start, isoDay(mid), columnUse)),
    ...(await fetchGeneralLedgerLines(
      accessToken,
      realmId,
      isoDay(mid + DAY_MS),
      end,
      columnUse,
    )),
  ];
}

// Quarter-sized report windows from the start date through today, so no
// single report response grows unbounded; fetchGeneralLedgerLines splits a
// window further when its report still hits the cell limit.
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
 * Pull one company's chart of accounts from QuickBooks and upsert it into
 * gl_accounts. The explicit column list never includes the user-owned
 * `category` (migration 0019) or `created_at`, so existing rows keep both —
 * only QuickBooks' own facts (name, number, type, active, balance) refresh.
 */
async function upsertChartOfAccounts(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  accessToken: string,
  realmId: string,
  now: string,
): Promise<QboAccount[]> {
  const accounts = await qboQuery<QboAccount>(
    accessToken,
    realmId,
    "SELECT * FROM Account WHERE Active IN (true, false)",
  );
  if (accounts.length > 0) {
    const { error } = await supabase.from("gl_accounts").upsert(
      accounts.map((a) => ({
        org_id: orgId,
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
  }
  return accounts;
}

/**
 * Refresh only the chart of accounts for every connected company — no
 * ledger lines, so it finishes in seconds (the Chart of Accounts page's
 * Refresh button). Nothing is deleted and categories are untouched; `added`
 * counts the accounts that did not exist here before this call.
 */
export async function syncChartOfAccounts(): Promise<{
  accounts: number;
  added: number;
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

  let accountCount = 0;
  let added = 0;
  for (const { accessToken, realmId } of connections) {
    const known = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("gl_accounts")
        .select("qb_id")
        .eq("org_id", org.id)
        .eq("realm_id", realmId)
        .order("qb_id")
        .range(from, from + 999);
      if (error) throw new Error(`GL account read failed: ${error.message}`);
      for (const r of data ?? []) known.add(r.qb_id as string);
      if ((data ?? []).length < 1000) break;
    }
    const accounts = await upsertChartOfAccounts(
      supabase,
      org.id,
      accessToken,
      realmId,
      new Date().toISOString(),
    );
    accountCount += accounts.length;
    added += accounts.filter((a) => !known.has(a.Id)).length;
  }
  return { accounts: accountCount, added, companies: connections.length };
}

/**
 * Import the chart of accounts and all posted general-ledger lines since
 * FINANCIALS_START_DATE. Ledger lines dated before that (through the
 * 2024-12-31 audit) are frozen in gl_lines as archived rows and are not
 * re-fetched. Pass a realmId to import a single company — the
 * full import for every company in one serverless invocation exceeds
 * Vercel's function window, so the sync button runs one request per realm.
 */
/** Set QB_LEDGER_FORCE_PUBLISH=1 to publish a ledger the checks below refuse
    (after confirming in QuickBooks that the change is real), then unset it. */
const LEDGER_FORCE_PUBLISH = process.env.QB_LEDGER_FORCE_PUBLISH === "1";

/** A fetched ledger smaller than this share of the published one is refused. */
const LEDGER_MIN_SHARE = 0.5;

/**
 * Refuses to publish a fetched ledger that would quietly damage the one on
 * screen. The import window always starts at FINANCIALS_START_DATE, so a
 * company's ledger only grows from sync to sync; each of these means the
 * response is wrong, not the books:
 *
 *   - some report windows came back with classes and some without (a one-off
 *     QuickBooks fault on the ones without);
 *   - no window has classes, but the published ledger does;
 *   - far fewer lines than the published ledger, or none at all.
 *
 * Throwing here leaves the published ledger untouched — the sync step fails
 * visibly and is retried.
 */
async function assertLedgerPublishable(
  supabase: ReturnType<typeof createServiceClient>,
  opts: {
    orgId: string;
    realmId: string;
    company: string;
    lineCount: number;
    columnUse: GlColumnUse;
  },
): Promise<void> {
  const { orgId, realmId, company, lineCount, columnUse } = opts;
  const refuse = (why: string) => {
    if (LEDGER_FORCE_PUBLISH) {
      console.warn(`QB GL sync ${realmId}: publishing anyway (QB_LEDGER_FORCE_PUBLISH): ${why}`);
      return;
    }
    throw new Error(
      `${company}: ledger not updated — ${why}. The previous ledger is still in place.`,
    );
  };

  if (columnUse.minimal > 0 && columnUse.full > 0) {
    refuse(
      `QuickBooks returned ${columnUse.minimal} of ${columnUse.minimal + columnUse.full} report periods without class, customer and vendor detail`,
    );
  }

  const { data: state, error: stateError } = await supabase
    .from("gl_sync_state")
    .select("current_sync_id")
    .eq("org_id", orgId)
    .eq("realm_id", realmId)
    .maybeSingle();
  if (stateError) throw new Error(`GL sync state read failed: ${stateError.message}`);
  const currentSyncId = (state?.current_sync_id as string | undefined) ?? null;
  if (!currentSyncId) return; // first import: nothing to compare against

  const published = () =>
    supabase
      .from("gl_lines")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("realm_id", realmId)
      .eq("sync_id", currentSyncId);

  const { count: publishedCount, error: countError } = await published();
  if (countError) throw new Error(`GL line count failed: ${countError.message}`);
  const before = publishedCount ?? 0;
  if (before > 0 && lineCount < before * LEDGER_MIN_SHARE) {
    refuse(
      `QuickBooks returned ${lineCount.toLocaleString("en-US")} ledger lines where ${before.toLocaleString("en-US")} are published`,
    );
  }

  if (columnUse.minimal > 0 && columnUse.full === 0) {
    const { count: classed, error: classError } = await published().not(
      "class_name",
      "is",
      null,
    );
    if (classError) throw new Error(`GL class check failed: ${classError.message}`);
    if ((classed ?? 0) > 0) {
      refuse(
        "QuickBooks returned every report period without class detail, but the published ledger has classes",
      );
    }
  }
}

export async function syncGeneralLedger(realmId?: string): Promise<{
  accounts: number;
  glLines: number;
  companies: number;
  /** Companies whose ledger was imported without class/customer/vendor
      columns because QuickBooks rejected them. */
  withoutClasses: number;
}> {
  let connections = await getValidConnections();
  if (realmId) {
    connections = connections.filter((c) => c.realmId === realmId);
    if (connections.length === 0) {
      throw new Error(
        `QuickBooks company ${realmId} is not syncing — reconnect it in Settings`,
      );
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
  let withoutClasses = 0;

  for (const { accessToken, realmId, companyName } of connections) {
    const now = new Date().toISOString();

    const accounts = await upsertChartOfAccounts(
      supabase,
      org.id,
      accessToken,
      realmId,
      now,
    );
    accountCount += accounts.length;

    const glLines: GlLine[] = [];
    const columnUse: GlColumnUse = { full: 0, minimal: 0 };
    for (const range of quarterRanges(FINANCIALS_START_DATE)) {
      glLines.push(
        ...(await fetchGeneralLedgerLines(
          accessToken,
          realmId,
          range.start,
          range.end,
          columnUse,
        )),
      );
    }
    console.log(
      `QB GL sync ${realmId} (${companyName ?? "unnamed"}): ${accounts.length} accounts, ${glLines.length} ledger lines since ${FINANCIALS_START_DATE}`,
    );

    // Nothing has been written yet: if what QuickBooks returned doesn't look
    // like this company's ledger, stop here and leave the published one alone.
    await assertLedgerPublishable(supabase, {
      orgId: org.id,
      realmId,
      company: companyName ?? `Company ${realmId}`,
      lineCount: glLines.length,
      columnUse,
    });
    if (columnUse.minimal > 0) withoutClasses += 1;

    // Full refresh of the import window per company so edits/deletions in
    // QuickBooks are reflected; archived pre-FINANCIALS_START_DATE rows sit
    // outside the generation scheme (migration 0020) and are untouched.
    // gl_lines has no unique key (report rows carry no stable
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
    withoutClasses,
  };
}
