-- =============================================================================
-- Nightly sync: rebuild the benefit allocation as the run's last step
--
-- job_benefit_allocation_cache (migration 0025) is rebuilt whenever its inputs
-- move — and the nightly sync moves all of them (job costs and the ledger)
-- without rebuilding it. Only the manual sync buttons did, so every morning
-- the Jobs and Capitalized Labor dashboards showed yesterday's allocation
-- beside today's costs.
--
-- The rebuild becomes a step of the run rather than a call at the end of a
-- cron tick: a tick that just imported a large ledger has little of its 300s
-- left, and a rebuild killed there would never be retried. As a step it gets
-- the queue's own guarantees — it runs after every import has finished or
-- given up, is retried up to three times, and shows on the Settings page.
--
-- Apply this before deploying the code that plans the step. (If the order
-- slips, the worker starts the run without the step instead of failing.)
-- =============================================================================

alter table public.qb_sync_steps
  drop constraint if exists qb_sync_steps_kind_check;

alter table public.qb_sync_steps
  add constraint qb_sync_steps_kind_check
  check (kind in ('customers_jobs', 'job_costs', 'general_ledger', 'benefit_allocation'));
