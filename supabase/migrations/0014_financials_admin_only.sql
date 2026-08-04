-- =============================================================================
-- Admin-only financials
--
-- General-ledger data (gl_accounts, gl_lines, gl_sync_state) was readable by
-- every authenticated user; financial statements are sensitive, so reads are
-- now restricted to admins. Enforcement lives here in RLS — the Financials
-- pages, nav link, and Excel export also gate on role, but that is UX, not
-- security:
--
--   * gl_pivot and gl_lines_detail are SECURITY INVOKER and read only
--     through the security_invoker view gl_line_facts, so these policies
--     apply inside both functions — a non-admin calling the RPCs directly
--     (e.g. straight through PostgREST) gets zero rows.
--   * The QuickBooks sync writes with the service role, which bypasses RLS,
--     so imports are unaffected.
--   * is_admin() (migration 0001) reads the caller's row in profiles via a
--     security-definer helper, so these policies can't be sidestepped by
--     RLS on profiles itself.
-- =============================================================================

drop policy gl_accounts_select on public.gl_accounts;
create policy gl_accounts_select on public.gl_accounts
  for select to authenticated using (public.is_admin());

drop policy gl_lines_select on public.gl_lines;
create policy gl_lines_select on public.gl_lines
  for select to authenticated using (public.is_admin());

drop policy gl_sync_state_select on public.gl_sync_state;
create policy gl_sync_state_select on public.gl_sync_state
  for select to authenticated using (public.is_admin());
