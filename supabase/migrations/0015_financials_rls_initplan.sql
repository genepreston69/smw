-- =============================================================================
-- Fix: 0014's admin-only GL policies caused statement timeouts
--
-- Migration 0014 wrote the policies as `using (public.is_admin())`.
-- is_admin() calls current_app_role(), which is SECURITY DEFINER, so
-- Postgres cannot inline it — the executor re-evaluates the policy qual for
-- every row scanned. On gl_lines (every posted ledger line) that is a
-- per-row profiles lookup across the whole scan, which blows past the
-- statement timeout: /financials 500s even for admins.
--
-- Wrapping the call in a scalar subquery turns it into an InitPlan —
-- evaluated once per statement, then treated as a constant for the scan.
-- Identical semantics, per-statement instead of per-row cost.
-- =============================================================================

drop policy gl_accounts_select on public.gl_accounts;
create policy gl_accounts_select on public.gl_accounts
  for select to authenticated using ((select public.is_admin()));

drop policy gl_lines_select on public.gl_lines;
create policy gl_lines_select on public.gl_lines
  for select to authenticated using ((select public.is_admin()));

drop policy gl_sync_state_select on public.gl_sync_state;
create policy gl_sync_state_select on public.gl_sync_state
  for select to authenticated using ((select public.is_admin()));
