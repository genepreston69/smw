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

  for (const { accessToken, realmId } of connections) {
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
