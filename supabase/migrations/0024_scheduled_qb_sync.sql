-- =============================================================================
-- Scheduled QuickBooks sync — durable run/step queue
--
-- The manual sync is two buttons for a reason (see src/components/QbSyncButton
-- .tsx): customers/jobs/costs in one request, then the general ledger one
-- company at a time, because everything in a single invocation blows past
-- Vercel's function window. A cron invocation has the same 300s ceiling, so
-- the nightly sync cannot be "one request that does everything" either.
--
-- Instead every nightly sync is a *run* made of ordered *steps*, and the cron
-- endpoint (/api/cron/qb-sync) is a worker: each invocation claims whatever
-- steps it can finish inside its window and returns; later invocations drain
-- the rest. That makes the sync resumable — a step stranded by a function
-- timeout is retried on the next tick instead of silently vanishing.
--
-- Invariants owned here, not by the route:
--   * one scheduled run per org per local calendar date (partial unique
--     index) — every tick in the cron window calls begin_qb_sync_run and only
--     the first one creates work;
--   * one step running at a time across the whole app (claim_qb_sync_step
--     returns nothing while another step is running). Every step refreshes the
--     QuickBooks tokens and QBO *rotates* refresh tokens, so two concurrent
--     steps could race the refresh and strand a connection;
--   * steps within a run run in `position` order — job costs import against
--     the jobs the previous step just imported;
--   * a step whose invocation died mid-flight (status 'running', no
--     finish call) is revived after p_stale_after and retried up to
--     p_max_attempts times, then permanently failed so the run can close.
--
-- Rows are written only by the cron route through the service-role client;
-- admins can read them (the Settings page shows the last run). No insert or
-- update policy exists, so authenticated callers can never forge a run.
-- =============================================================================

create table public.qb_sync_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  trigger text not null default 'scheduled' check (trigger in ('scheduled', 'manual')),
  -- The calendar date in the sync's configured timezone, not UTC: the run is
  -- "the morning of the 5th" even when it starts at 08:00Z.
  local_date date not null,
  timezone text not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index qb_sync_runs_one_scheduled_per_day
  on public.qb_sync_runs (org_id, local_date)
  where trigger = 'scheduled';

create index qb_sync_runs_started_at on public.qb_sync_runs (started_at desc);

create table public.qb_sync_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.qb_sync_runs (id) on delete cascade,
  position int not null,
  kind text not null
    check (kind in ('customers_jobs', 'job_costs', 'general_ledger')),
  -- Set for general_ledger steps (one per connected QB company), null for the
  -- entity steps, which cover every company in one pass.
  realm_id text,
  label text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempts int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  result jsonb,
  unique (run_id, position)
);

create index qb_sync_steps_open
  on public.qb_sync_steps (run_id, position)
  where status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- Starting a run
-- ---------------------------------------------------------------------------

-- Returns the new run id, or null when this org already has a scheduled run
-- for p_local_date (every later tick in the cron window hits that case and
-- just drains the queue).
create or replace function public.begin_qb_sync_run(
  p_local_date date,
  p_timezone text,
  p_steps jsonb,
  p_trigger text default 'scheduled'
)
returns uuid
language plpgsql
as $$
declare
  v_run_id uuid;
begin
  insert into public.qb_sync_runs (local_date, timezone, trigger)
  values (p_local_date, p_timezone, p_trigger)
  on conflict do nothing
  returning id into v_run_id;

  if v_run_id is null then
    return null;
  end if;

  insert into public.qb_sync_steps (run_id, position, kind, realm_id, label)
  select v_run_id,
         t.ordinality,
         t.step ->> 'kind',
         nullif(t.step ->> 'realm_id', ''),
         t.step ->> 'label'
  from jsonb_array_elements(p_steps) with ordinality as t(step, ordinality);

  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Closing finished runs
-- ---------------------------------------------------------------------------

-- A run is done when no step is pending or running: succeeded if every step
-- succeeded, failed if none did, partial in between. Called after every step
-- transition (including the stale-step recovery, which can permanently fail
-- the last open step without any finish call).
create or replace function public.close_finished_qb_sync_runs()
returns void
language sql
as $$
  update public.qb_sync_runs r
     set status = case
                    when not exists (select 1 from public.qb_sync_steps s
                                      where s.run_id = r.id and s.status = 'failed')
                      then 'succeeded'
                    when exists (select 1 from public.qb_sync_steps s
                                  where s.run_id = r.id and s.status = 'succeeded')
                      then 'partial'
                    else 'failed'
                  end,
         finished_at = now()
   where r.finished_at is null
     and not exists (select 1 from public.qb_sync_steps s
                      where s.run_id = r.id and s.status in ('pending', 'running'));
$$;

-- ---------------------------------------------------------------------------
-- Claiming the next step
-- ---------------------------------------------------------------------------

-- Returns the claimed step as a JSON object (jsonb rather than the row type so
-- the shape through PostgREST is unambiguous), or null when there is nothing
-- to do right now.
create or replace function public.claim_qb_sync_step(
  p_stale_after interval default '15 minutes',
  p_max_attempts int default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_step public.qb_sync_steps;
begin
  -- Serialize claimers against each other: overlapping cron ticks would
  -- otherwise both see "nothing running" and each claim a different step,
  -- defeating the one-step-at-a-time rule below. Released at commit.
  perform pg_advisory_xact_lock(hashtext('qb_sync_step_claim'));

  -- Revive steps stranded by a function timeout: the invocation that claimed
  -- them is gone, so nothing else will ever finish them.
  update public.qb_sync_steps
     set status = case when attempts >= p_max_attempts then 'failed' else 'pending' end,
         error = case
                   when attempts >= p_max_attempts
                     then coalesce(error, 'Timed out before the step finished')
                   else error
                 end,
         finished_at = case when attempts >= p_max_attempts then now() else null end
   where status = 'running'
     and started_at < now() - p_stale_after;

  perform public.close_finished_qb_sync_runs();

  -- Serialize globally: never hand out a step while another one is running.
  if exists (select 1 from public.qb_sync_steps where status = 'running') then
    return null;
  end if;

  select s.* into v_step
  from public.qb_sync_steps s
  join public.qb_sync_runs r on r.id = s.run_id
  where s.status = 'pending'
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

-- ---------------------------------------------------------------------------
-- Finishing a step
-- ---------------------------------------------------------------------------

-- A failed step goes back to 'pending' so a later tick retries it, until it
-- has burned p_max_attempts — then it fails for good and stops blocking the
-- steps behind it (stale jobs don't prevent a cost or ledger import).
create or replace function public.finish_qb_sync_step(
  p_step_id uuid,
  p_ok boolean,
  p_result jsonb default null,
  p_error text default null,
  p_max_attempts int default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_step public.qb_sync_steps;
begin
  update public.qb_sync_steps
     set status = case
                    when p_ok then 'succeeded'
                    when attempts >= p_max_attempts then 'failed'
                    else 'pending'
                  end,
         result = coalesce(p_result, result),
         error = case when p_ok then null else p_error end,
         finished_at = case
                         when p_ok or attempts >= p_max_attempts then now()
                         else null
                       end
   where id = p_step_id
  returning * into v_step;

  if v_step.id is null then
    raise exception 'No such sync step %', p_step_id;
  end if;

  perform public.close_finished_qb_sync_runs();

  return to_jsonb(v_step);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.qb_sync_runs enable row level security;
alter table public.qb_sync_steps enable row level security;

-- Scalar-subquery form so the is_admin() lookup is an InitPlan, per 0015.
create policy qb_sync_runs_select on public.qb_sync_runs
  for select to authenticated using ((select public.is_admin()));
create policy qb_sync_steps_select on public.qb_sync_steps
  for select to authenticated using ((select public.is_admin()));

revoke all on public.qb_sync_runs from anon;
revoke all on public.qb_sync_steps from anon;

-- The worker is the only caller; it uses the service-role client.
revoke all on function public.begin_qb_sync_run(date, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.claim_qb_sync_step(interval, int) from public, anon, authenticated;
revoke all on function public.finish_qb_sync_step(uuid, boolean, jsonb, text, int) from public, anon, authenticated;
revoke all on function public.close_finished_qb_sync_runs() from public, anon, authenticated;
grant execute on function public.begin_qb_sync_run(date, text, jsonb, text) to service_role;
grant execute on function public.claim_qb_sync_step(interval, int) to service_role;
grant execute on function public.finish_qb_sync_step(uuid, boolean, jsonb, text, int) to service_role;
grant execute on function public.close_finished_qb_sync_runs() to service_role;
