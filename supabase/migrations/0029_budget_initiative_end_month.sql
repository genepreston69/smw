-- =============================================================================
-- Budget initiatives: end month
--
-- Migration 0026 spread an initiative's amounts evenly from its start month
-- through December. An initiative can now also end before December: each
-- account's amount (the initiative's total for the budget year) is spread
-- evenly over start_month..end_month and is zero outside that run.
--
-- Existing initiatives default to end_month = 12, so their numbers don't move.
--
-- The run decides which budget months carry the money, so it locks with the
-- amounts: like budget_initiative_lines (0026's guard), start_month and
-- end_month may change only while the initiative is proposed — return an
-- approved or rejected initiative to proposed to change its timing.
-- =============================================================================

alter table public.budget_initiatives
  add column end_month int not null default 12 check (end_month between 1 and 12);

alter table public.budget_initiatives
  add constraint budget_initiatives_month_order check (end_month >= start_month);

comment on column public.budget_initiatives.start_month is
  'First budget-year month (1-12) the initiative''s amounts are spread over.';
comment on column public.budget_initiatives.end_month is
  'Last budget-year month (1-12) the initiative''s amounts are spread over; >= start_month.';

create or replace function public.budget_initiatives_timing_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'proposed'
     and (new.start_month, new.end_month) is distinct from (old.start_month, old.end_month) then
    raise exception 'Initiative is %; return it to proposed before changing its months', old.status;
  end if;
  return new;
end;
$$;

create trigger budget_initiatives_timing_guard
  before update on public.budget_initiatives
  for each row execute function public.budget_initiatives_timing_guard();
