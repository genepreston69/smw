-- =============================================================================
-- Admin deletes
--
-- 1. Fix guard_plan_children: deleting a plan cascades to its line items and
--    phases, and the cascaded child deletes fire this guard AFTER the plan row
--    is already gone — assert_plan_editable then raised "Plan not found",
--    which blocked deleting ANY plan that had line items. Treat a missing
--    plan row as "cascade in progress" and allow it. Direct child writes are
--    unaffected: the FK guarantees the plan row exists for those.
-- 2. Audit-log plan deletions (who deleted what, and its status at the time).
--
-- RLS already grants deletes: admins can delete any plan (plans_delete),
-- creators their own drafts, and admins can delete customers/jobs
-- (customers_admin_write / jobs_admin_write).
-- =============================================================================

create or replace function public.guard_plan_children()
returns trigger
language plpgsql
as $$
declare
  s public.plan_status;
begin
  select status into s
    from public.project_plans
   where id = coalesce(new.plan_id, old.plan_id);
  -- Plan row already deleted: this write is the cascade from deleting the
  -- plan itself, which is authorized by the plans_delete RLS policy.
  if s is null then
    return coalesce(new, old);
  end if;
  if s not in ('draft', 'changes_requested') then
    raise exception 'Plan is % — line items and phases are locked', s;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.audit_plan_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.write_audit('project_plan', old.id, 'deleted',
    jsonb_build_object('title', old.title, 'status', old.status, 'version', old.version));
  return old;
end;
$$;

drop trigger if exists audit_project_plan_delete on public.project_plans;
create trigger audit_project_plan_delete
  after delete on public.project_plans
  for each row execute function public.audit_plan_delete();
