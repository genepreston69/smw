-- =============================================================================
-- Rollback: restore pre-0014 GL read policies
--
-- The admin-only policies from 0014/0015 caused statement timeouts on
-- /financials even in InitPlan form. Until the admin check can be enforced
-- without per-query cost (see PR discussion — likely security-definer RPCs
-- with a one-time role check), GL reads go back to the original
-- authenticated-wide policies from 0009/0013.
--
-- NOTE: this temporarily removes database-level enforcement of admin-only
-- financials. The app still gates /financials, /financials/lines, the Excel
-- export, and the nav link by role, but a non-admin hitting PostgREST
-- directly can read gl_* rows again until the durable fix lands.
-- =============================================================================

drop policy gl_accounts_select on public.gl_accounts;
create policy gl_accounts_select on public.gl_accounts
  for select to authenticated using (true);

drop policy gl_lines_select on public.gl_lines;
create policy gl_lines_select on public.gl_lines
  for select to authenticated using (true);

drop policy gl_sync_state_select on public.gl_sync_state;
create policy gl_sync_state_select on public.gl_sync_state
  for select to authenticated using (true);
