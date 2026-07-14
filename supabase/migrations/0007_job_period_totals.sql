-- =============================================================================
-- Year-to-date / month-to-date rollups for the Jobs dashboard
--
-- The Jobs dashboard gets time filters (All time / Year to date / Month to
-- date), so the per-job rollup views gain period columns computed at query
-- time. Aggregating in the views keeps the dashboard on one small query per
-- view instead of pulling every raw cost/invoice line through the API.
--
-- Period boundaries use current_date, i.e. the database clock (UTC on
-- Supabase); a transaction dated Jan 1 counts toward YTD as soon as the
-- server's calendar rolls over. New columns are appended so
-- create-or-replace is allowed, and re-running this file is harmless.
-- =============================================================================

create or replace view public.job_cost_totals
with (security_invoker = true)
as
select job_id,
       sum(amount)  as total_amount,
       sum(hours)   as total_hours,
       count(*)     as line_count,
       max(txn_date) as latest_txn_date,
       sum(amount) filter (where cost_type = 'materials') as materials_amount,
       sum(amount) filter (where cost_type = 'labor')     as labor_amount,
       sum(amount) filter (where cost_type = 'other')     as other_amount,
       sum(amount) filter (where txn_date >= date_trunc('year',  current_date)) as ytd_amount,
       sum(amount) filter (where txn_date >= date_trunc('month', current_date)) as mtd_amount
from public.job_costs
group by job_id;

create or replace view public.job_invoice_totals
with (security_invoker = true)
as
select job_id,
       sum(amount)   as total_invoiced,
       count(*)      as invoice_count,
       max(txn_date) as latest_invoice_date,
       sum(amount) filter (where txn_date >= date_trunc('year',  current_date)) as ytd_invoiced,
       sum(amount) filter (where txn_date >= date_trunc('month', current_date)) as mtd_invoiced
from public.job_invoices
group by job_id;
