-- =============================================================================
-- Close the audit log and the workflow functions to callers who shouldn't
-- reach them
--
-- Postgres lets every role execute a new function unless told otherwise, and
-- Supabase exposes every function in `public` over its API. Two consequences
-- in migrations 0001 / 0017:
--
--   * write_audit is security definer and takes the entity, action and details
--     as arguments, so anyone holding the public anon key — signed in or not —
--     could call it directly and write any audit entry they liked (a forged
--     "approved" on a plan, say). It is only ever meant to be called from the
--     workflow functions and the plan-delete trigger. Those are security
--     definer themselves and run as the owner, so they keep working once
--     every API role is shut out.
--
--   * the workflow functions were callable without signing in. Their role
--     checks compare against current_app_role(), which is NULL for a caller
--     with no profile, and `NULL not in (...)` is NULL rather than true — so
--     submit_plan / submit_barge_quote's "only the creator or an admin" test
--     never raised for an anonymous caller, who could move a draft to
--     submitted given its id. (The approve / reject / request-changes
--     functions fail further down for such a caller, on approvals.approver_id
--     being not null, but they have no business being reachable either.)
--     Every signed-in user has a profile and a role, so restricting these to
--     `authenticated` leaves the role checks with nothing NULL to trip on.
-- =============================================================================

revoke all on function public.write_audit(text, uuid, text, jsonb)
  from public, anon, authenticated;

revoke all on function public.submit_plan(uuid) from public, anon;
revoke all on function public.approve_plan(uuid, text) from public, anon;
revoke all on function public.reject_plan(uuid, text) from public, anon;
revoke all on function public.request_changes(uuid, text) from public, anon;
grant execute on function public.submit_plan(uuid) to authenticated;
grant execute on function public.approve_plan(uuid, text) to authenticated;
grant execute on function public.reject_plan(uuid, text) to authenticated;
grant execute on function public.request_changes(uuid, text) to authenticated;

revoke all on function public.submit_barge_quote(uuid) from public, anon;
revoke all on function public.approve_barge_quote(uuid, text) from public, anon;
revoke all on function public.reject_barge_quote(uuid, text) from public, anon;
revoke all on function public.request_barge_quote_changes(uuid, text) from public, anon;
grant execute on function public.submit_barge_quote(uuid) to authenticated;
grant execute on function public.approve_barge_quote(uuid, text) to authenticated;
grant execute on function public.reject_barge_quote(uuid, text) to authenticated;
grant execute on function public.request_barge_quote_changes(uuid, text) to authenticated;
