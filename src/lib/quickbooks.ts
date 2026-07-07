import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

// ---------------------------------------------------------------------------
// QuickBooks Online OAuth2 + API client.
// Env: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_ENVIRONMENT (sandbox|production),
//      NEXT_PUBLIC_APP_URL (e.g. https://smw.vercel.app) for the redirect URI.
// ---------------------------------------------------------------------------

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function apiBase(): string {
  return process.env.QB_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
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

export function redirectUri(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!base) throw new Error("Missing NEXT_PUBLIC_APP_URL");
  return `${base.replace(/\/$/, "")}/api/qb/callback`;
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirectUri(),
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
    throw new Error(`QuickBooks token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
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

  const now = Date.now();
  const { error } = await supabase.from("qb_connections").upsert(
    {
      org_id: org.id,
      realm_id: opts.realmId,
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
    { onConflict: "org_id" },
  );
  if (error) throw new Error(error.message);

  await supabase
    .from("organizations")
    .update({ qb_realm_id: opts.realmId })
    .eq("id", org.id);
}

/** Returns a valid access token + realm, refreshing (and persisting) if expired. */
export async function getValidConnection(): Promise<{
  accessToken: string;
  realmId: string;
}> {
  const supabase = createServiceClient();
  const { data: conn, error } = await supabase
    .from("qb_connections")
    .select("*")
    .eq("status", "connected")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!conn) throw new Error("QuickBooks is not connected");

  const expiresAt = new Date(conn.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: conn.access_token, realmId: conn.realm_id };
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
    return { accessToken: tokens.access_token, realmId: conn.realm_id };
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
      throw new Error(`QuickBooks query failed: ${res.status} ${await res.text()}`);
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
}> {
  const { accessToken, realmId } = await getValidConnection();
  const supabase = createServiceClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at")
    .limit(1)
    .single();
  if (!org) throw new Error("No organization found");

  const all = await qboQuery<QboCustomer>(
    accessToken,
    realmId,
    "SELECT * FROM Customer",
  );

  const now = new Date().toISOString();
  const topLevel = all.filter((c) => !c.Job);
  const jobRecords = all.filter((c) => c.Job && c.ParentRef?.value);

  let customerCount = 0;
  if (topLevel.length > 0) {
    const { error } = await supabase.from("customers").upsert(
      topLevel.map((c) => ({
        org_id: org.id,
        qb_id: c.Id,
        display_name: c.DisplayName,
        company_name: c.CompanyName ?? null,
        email: c.PrimaryEmailAddr?.Address ?? null,
        phone: c.PrimaryPhone?.FreeFormNumber ?? null,
        billing_address: c.BillAddr ?? null,
        active: c.Active ?? true,
        last_synced_at: now,
      })),
      { onConflict: "org_id,qb_id" },
    );
    if (error) throw new Error(`Customer upsert failed: ${error.message}`);
    customerCount = topLevel.length;
  }

  // Map QB parent ids -> our customer uuids for job linking
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id, qb_id")
    .eq("org_id", org.id);
  const byQbId = new Map((customerRows ?? []).map((c) => [c.qb_id, c.id]));

  let jobCount = 0;
  if (jobRecords.length > 0) {
    const { error } = await supabase.from("jobs").upsert(
      jobRecords.map((j) => ({
        org_id: org.id,
        qb_id: j.Id,
        customer_id: byQbId.get(j.ParentRef!.value) ?? null,
        name: j.DisplayName,
        fully_qualified_name: j.FullyQualifiedName ?? null,
        active: j.Active ?? true,
        last_synced_at: now,
      })),
      { onConflict: "org_id,qb_id" },
    );
    if (error) throw new Error(`Job upsert failed: ${error.message}`);
    jobCount = jobRecords.length;
  }

  await supabase
    .from("qb_connections")
    .update({ last_sync_at: now, last_sync_error: null })
    .eq("realm_id", realmId);

  return { customers: customerCount, jobs: jobCount };
}
