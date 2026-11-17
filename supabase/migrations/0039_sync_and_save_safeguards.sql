-- =============================================================================
-- Sync and save safeguards
--
-- Three places where a failure partway through could lose or corrupt data:
--
--   1. Manual syncs ran outside the nightly sync's queue. The "one step
--      running at a time" rule (migration 0024) only covered cron steps, so a
--      manual sync during the nightly run — or two admins clicking at once —
--      could race the QuickBooks refresh-token rotation and overlap two ledger
--      imports of one company (prune_gl_lines then deletes the rows the other
--      import is still inserting). Manual syncs now go through the same queue
--      as trigger = 'manual' runs: claim_qb_sync_step takes an optional run id
--      so a manual request works only its own steps, and still gets nothing
--      while any other step is running.
--
--   2. Saving a barge quote deleted its steel lines and labor phases and then
--      re-inserted them as separate requests; a failed insert left the quote
--      with an empty takeoff. replace_barge_quote_content does the swap in one
--      transaction.
--
--   3. Saving a budget initiative replaced its account lines the same way.
--      replace_budget_initiative_lines does that swap in one transaction.
--
-- Apply this BEFORE deploying the code that calls these functions: until it is
-- applied, manual syncs, barge quote saves and initiative saves fail with a
-- "function not found" error (nothing is lost — they just don't run).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The sync queue serves manual runs too
-- ---------------------------------------------------------------------------

-- Replaces the two-argument version: an added optional argument would leave
-- two candidates for a call with no arguments.
drop function if exists public.claim_qb_sync_step(interval, int);

-- p_run_id null  → the next pending step of any run (the cron worker).
-- p_run_id given → the next pending step of that run only (a manual sync),
--                  so a manual request never starts the nightly run's steps.
-- Either way nothing is handed out while another step is running.
create or replace function public.claim_qb_sync_step(
  p_stale_after interval default '15 minutes',
  p_max_attempts int default 3,
  p_run_id uuid default null
)
returns jsonb
language plpgsql
as $$
declare
  v_step public.qb_sync_steps;
begin
  -- Serialize claimers against each other: overlapping callers would
  -- otherwise both see "nothing running" and each claim a different step,
  -- defeating the one-step-at-a-time rule below. Released at commit.
  perform pg_advisory_xact_lock(hashtext('qb_sync_step_claim'));

  -- Revive steps stranded by a function timeout: the invocation that claimed
  -- them is gone, so nothing else will ever finish them. A scheduled step goes
  -- back to pending for the next cron tick; a manual step fails for good — the
  -- request that would have retried it is gone, and a leftover pending manual
  -- step would otherwise run by itself the next morning.
  update public.qb_sync_steps s
     set status = case
                    when s.attempts >= p_max_attempts or r.trigger = 'manual' then 'failed'
                    else 'pending'
                  end,
         error = case
                   when s.attempts >= p_max_attempts or r.trigger = 'manual'
                     then coalesce(s.error, 'Timed out before the step finished')
                   else s.error
                 end,
         finished_at = case
                         when s.attempts >= p_max_attempts or r.trigger = 'manual' then now()
                         else null
                       end
    from public.qb_sync_runs r
   where r.id = s.run_id
     and s.status = 'running'
     and s.started_at < now() - p_stale_after;

  perform public.close_finished_qb_sync_runs();

  -- Serialize globally: never hand out a step while another one is running.
  if exists (select 1 from public.qb_sync_steps where status = 'running') then
    return null;
  end if;

  select s.* into v_step
  from public.qb_sync_steps s
  join public.qb_sync_runs r on r.id = s.run_id
  where s.status = 'pending'
    and (p_run_id is null or s.run_id = p_run_id)
    -- Ordered within a run: an earlier step that is still open (pending, or
    -- pending again after a retryable failure) blocks the ones after it.
    and not exists (select 1 from public.qb_sync_steps e
                     where e.run_id = s.run_id
                       and e.position < s.position
                       and e.status in ('pending', 'running'))
  order by r.started_at, s.position
  for update of s skip locked
  limit 1;

  if v_step.id is null then
    return null;
  end if;

  update public.qb_sync_steps
     set status = 'running',
         attempts = attempts + 1,
         started_at = now(),
         finished_at = null,
         error = null
   where id = v_step.id
  returning * into v_step;

  return to_jsonb(v_step);
end;
$$;

-- Fails every step of a run that has not started, and closes the run. A manual
-- sync calls this when it cannot go on (another sync holds the queue, or one
-- of its own steps failed), so nothing of it is left queued.
create or replace function public.cancel_qb_sync_run(
  p_run_id uuid,
  p_reason text
)
returns void
language plpgsql
as $$
begin
  update public.qb_sync_steps
     set status = 'failed',
         error = p_reason,
         finished_at = now()
   where run_id = p_run_id
     and status = 'pending';

  perform public.close_finished_qb_sync_runs();
end;
$$;

revoke all on function public.claim_qb_sync_step(interval, int, uuid) from public, anon, authenticated;
revoke all on function public.cancel_qb_sync_run(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_qb_sync_step(interval, int, uuid) to service_role;
grant execute on function public.cancel_qb_sync_run(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Barge quote content: replace lines and labor phases in one transaction
-- ---------------------------------------------------------------------------

-- Runs as the caller (not security definer), so RLS and the edit-lock guard
-- triggers apply exactly as they did to the separate requests. Array order is
-- the sort order. Any failure rolls the whole replacement back, leaving the
-- quote's previous lines and phases in place.
create or replace function public.replace_barge_quote_content(
  p_quote_id uuid,
  p_lines jsonb,
  p_labor jsonb
)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from public.barge_quote_steel_lines where quote_id = p_quote_id;
  delete from public.barge_quote_labor_phases where quote_id = p_quote_id;

  insert into public.barge_quote_steel_lines
    (quote_id, sort_order, section, item, unit, qty, unit_lb, yield_pct, price_per_lb)
  select p_quote_id,
         (t.ordinality - 1)::int,
         (t.line ->> 'section')::public.barge_section,
         coalesce(t.line ->> 'item', ''),
         t.line ->> 'unit',
         (t.line ->> 'qty')::numeric,
         (t.line ->> 'unit_lb')::numeric,
         (t.line ->> 'yield_pct')::numeric,
         (t.line ->> 'price_per_lb')::numeric
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as t(line, ordinality);

  insert into public.barge_quote_labor_phases (quote_id, sort_order, name, hours)
  select p_quote_id,
         (t.ordinality - 1)::int,
         coalesce(t.phase ->> 'name', ''),
         (t.phase ->> 'hours')::numeric
  from jsonb_array_elements(coalesce(p_labor, '[]'::jsonb)) with ordinality as t(phase, ordinality);
end;
$$;

revoke all on function public.replace_barge_quote_content(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_barge_quote_content(uuid, jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Budget initiative lines: replace in one transaction
-- ---------------------------------------------------------------------------

-- Service-role only, like the other budget writes (the action checks the admin
-- role first). The guard trigger still refuses unless the initiative is
-- proposed.
create or replace function public.replace_budget_initiative_lines(
  p_initiative_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from public.budget_initiative_lines where initiative_id = p_initiative_id;

  insert into public.budget_initiative_lines
    (initiative_id, account_name, classification, annual_amount)
  select p_initiative_id,
         t.line ->> 'account_name',
         t.line ->> 'classification',
         (t.line ->> 'annual_amount')::numeric
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as t(line);
end;
$$;

revoke all on function public.replace_budget_initiative_lines(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_budget_initiative_lines(uuid, jsonb) to service_role;
