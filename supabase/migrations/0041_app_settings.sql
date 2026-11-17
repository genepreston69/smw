-- =============================================================================
-- Business rules as settings
--
-- Rules that change on the business's schedule, not the code's, were constants
-- in the source: changing the budget year, the accounts in the Cost of Benefits
-- denominator, or the list of sister companies needed a code change and a
-- deploy. public.app_settings holds them as data, edited by an admin on the
-- Settings page.
--
-- One row per setting, keyed by name, with a JSON value. A setting with no row
-- uses the default in src/lib/appSettings.ts — that module owns the list of
-- settings, their shapes and their defaults, and validates every value it
-- reads, so nothing is seeded here.
--
-- Deliberately NOT settings: the import window and freeze dates
-- (JOB_COSTS_START_DATE, FINANCIALS_START_DATE, NO_TXN_CUTOFF in
-- src/lib/businessRules.ts). Moving those hides or deletes imported history,
-- so they stay a reviewed code change.
-- =============================================================================

create table if not exists public.app_settings (
  org_id uuid not null references public.organizations (id) default public.default_org_id(),
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) default auth.uid(),
  primary key (org_id, key)
);

alter table public.app_settings enable row level security;

-- Everyone signed in reads them: the Jobs dashboard buckets jobs by the
-- sister-company list for every user. Only admins change them.
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

drop policy if exists app_settings_insert on public.app_settings;
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists app_settings_delete on public.app_settings;
create policy app_settings_delete on public.app_settings
  for delete to authenticated using ((select public.is_admin()));

revoke all on public.app_settings from anon;

insert into public.schema_migrations (filename)
values ('0041_app_settings.sql') on conflict do nothing;
