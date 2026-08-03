-- =============================================================================
-- Longer statement timeout for the sync's service role
--
-- swap_gl_lines (migration 0011) replaces a company's entire ledger in one
-- transaction, and with a few hundred thousand gl_lines rows that single
-- statement outruns Supabase's default per-role statement_timeout — the
-- ledger sync fails with "canceling statement due to statement timeout" and
-- rolls back.
--
-- PostgREST applies role-level settings on every request it serves, so
-- raising the timeout on service_role covers the swap RPC. (A SET clause on
-- the function itself would not work: statement_timeout is armed when the
-- top-level statement starts, before the function body's settings apply.)
-- service_role is only used by the server-side QuickBooks sync/OAuth routes,
-- which run in Vercel functions capped at 300 seconds — 5 minutes matches
-- that window. Browser-facing roles (anon/authenticated) are unchanged.
-- =============================================================================

alter role service_role set statement_timeout = '5min';
