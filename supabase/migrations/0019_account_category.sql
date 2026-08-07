-- =============================================================================
-- User-assigned income-statement category on GL accounts
--
-- The Chart of Accounts page (/financials/accounts) lets admins tag each
-- imported QuickBooks account with a free-form Category label; the Income
-- Statement page (/financials/statement) groups Revenue and Expense accounts
-- by that label into expandable statement sections.
--
-- Safe across QuickBooks syncs: syncGeneralLedger upserts gl_accounts with an
-- explicit column list that does not include category, so ON CONFLICT updates
-- never touch it.
--
-- Writes go through the admin-gated server action using the service-role
-- client (the same access pattern as the Financials reads — see migration
-- 0014/0015 for why app reads bypass the admin RLS qual after a role check),
-- so no insert/update policy is needed here.
-- =============================================================================

alter table public.gl_accounts
  add column category text;
