-- =============================================================================
-- Capitalized Jobs: record that a job was approved for capitalization
--
-- /capitalized-jobs lists the direct cost of non-billable and intercompany
-- jobs. Each row gets an Approved check box and the page an Approved tab, so
-- accounting can see which jobs have been signed off. The approval belongs to
-- the job, not to a period: an approved job stays approved whichever year,
-- month or range is on screen, until someone clears it.
--
-- cap_job_approvals holds one row per approved job (who and when).
-- Unapproving deletes the row; audit_log keeps the history either way.
-- Nobody writes the table directly — set_cap_job_approval owns the rule
-- (approvers and admins only) and the audit entry, like the plan workflow
-- functions.
--
-- Apply before deploying the code that reads cap_job_approvals. Until then
-- the page shows a banner naming this file and the check boxes are disabled.
-- =============================================================================

create table if not exists public.cap_job_approvals (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz not null default now()
);

-- Readable by every signed-in user, like the page; no insert / update /
-- delete policy, so the only way to write is the function below.
alter table public.cap_job_approvals enable row level security;
drop policy if exists cap_job_approvals_select on public.cap_job_approvals;
create policy cap_job_approvals_select on public.cap_job_approvals
  for select to authenticated using (true);

revoke all on public.cap_job_approvals from anon, public;
grant select on public.cap_job_approvals to authenticated;
grant all on public.cap_job_approvals to service_role;

-- Approves (p_approved = true) or clears (false) a job. Setting the state it
-- already has changes nothing and writes no audit entry, so a double click or
-- two people ticking the same box is harmless — the first approver stands.
-- Returns the resulting state.
create or replace function public.set_cap_job_approval(p_job_id uuid, p_approved boolean)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  caller_role public.app_role := public.current_app_role();
  job_name text;
  changed int;
begin
  if caller_role is null or caller_role not in ('approver', 'admin') then
    raise exception 'Only approvers and admins can approve capitalized jobs';
  end if;
  if p_approved is null then
    raise exception 'Approved must be true or false';
  end if;
  select name into job_name from public.jobs where id = p_job_id;
  if not found then
    raise exception 'Job not found';
  end if;

  if p_approved then
    insert into public.cap_job_approvals (job_id, approved_by)
    values (p_job_id, auth.uid())
    on conflict (job_id) do nothing;
  else
    delete from public.cap_job_approvals where job_id = p_job_id;
  end if;
  get diagnostics changed = row_count;

  if changed > 0 then
    perform public.write_audit(
      'capitalized_job', p_job_id,
      case when p_approved then 'approved' else 'approval_cleared' end,
      jsonb_build_object('job', job_name));
  end if;
  return p_approved;
end;
$$;

revoke all on function public.set_cap_job_approval(uuid, boolean) from public, anon;
grant execute on function public.set_cap_job_approval(uuid, boolean) to authenticated;

insert into public.schema_migrations (filename)
values ('0045_capitalized_job_approvals.sql') on conflict do nothing;
