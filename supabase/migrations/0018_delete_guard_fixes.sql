-- =============================================================================
-- Fix: deleting a plan / barge quote (or a barge config) failed on the guard
-- triggers.
--
-- 1) Deleting a parent cascades to its child rows (line items, phases, steel
--    lines). The children's guard triggers re-check the parent's status, but
--    by the time the cascaded child deletes run the parent row is already
--    gone, so assert_*_editable raised 'not found' and aborted every delete
--    of a parent that had content. Treat a missing parent as "cascade delete
--    in progress" and allow it: direct child writes against a bogus id are
--    still caught by the foreign keys, and direct writes against a locked
--    parent still see its row and raise. This also lets admins delete
--    submitted/approved records, matching the RLS delete policies.
--
-- 2) barge_quotes.config_id is `on delete set null`: deleting a config that
--    a locked (submitted/approved) quote references fires the quote's
--    field-lock guard and failed. A config detach changes nothing the lock
--    protects, so exempt updates whose only change is config_id.
-- =============================================================================

create or replace function public.assert_plan_editable(p_plan_id uuid)
returns void
language plpgsql
as $$
declare
  s public.plan_status;
begin
  select status into s from public.project_plans where id = p_plan_id;
  if s is null then
    -- Parent already deleted: this is the FK cascade removing children.
    return;
  end if;
  if s not in ('draft', 'changes_requested') then
    raise exception 'Plan is % — line items and phases are locked', s;
  end if;
end;
$$;

create or replace function public.assert_barge_quote_editable(p_quote_id uuid)
returns void
language plpgsql
as $$
declare
  s public.plan_status;
begin
  select status into s from public.barge_quotes where id = p_quote_id;
  if s is null then
    -- Parent already deleted: this is the FK cascade removing children.
    return;
  end if;
  if s not in ('draft', 'changes_requested') then
    raise exception 'Quote is % — takeoff and labor are locked', s;
  end if;
end;
$$;

create or replace function public.guard_barge_quote_update()
returns trigger
language plpgsql
as $$
declare
  workflow boolean := coalesce(current_setting('app.workflow', true), '') = '1';
begin
  if not workflow and (
       new.status is distinct from old.status
    or new.version is distinct from old.version
    or new.submitted_at is distinct from old.submitted_at
    or new.approved_at is distinct from old.approved_at
  ) then
    raise exception 'Quote status can only change through submit/approve/reject/request_changes';
  end if;
  if not workflow and old.status not in ('draft', 'changes_requested') then
    -- The config FK's on-delete-set-null cascade may detach a config from a
    -- locked quote; anything beyond config_id stays locked.
    if (to_jsonb(new) - 'config_id' - 'updated_at')
       = (to_jsonb(old) - 'config_id' - 'updated_at') then
      return new;
    end if;
    raise exception 'Quote is % — fields are locked', old.status;
  end if;
  return new;
end;
$$;
