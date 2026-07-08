-- =============================================================================
-- Multi-company QuickBooks support
--
-- The enterprise runs several QuickBooks Online companies. Allow one
-- connection per company (realm) instead of one per organization, and tag
-- imported customers/jobs with the realm they came from so records from
-- different companies can't collide (QB record IDs are only unique within a
-- realm).
-- =============================================================================

-- One connection per company, with a display name for the settings page.
alter table public.qb_connections
  drop constraint if exists qb_connections_org_id_key;

alter table public.qb_connections
  add column if not exists company_name text;

alter table public.qb_connections
  add constraint qb_connections_org_realm_key unique (org_id, realm_id);

-- Tag customers and jobs with their source company.
alter table public.customers
  add column if not exists realm_id text;

alter table public.jobs
  add column if not exists realm_id text;

-- Backfill existing rows from the (previously single) connection.
update public.customers c
   set realm_id = (select realm_id from public.qb_connections limit 1)
 where c.realm_id is null;

update public.jobs j
   set realm_id = (select realm_id from public.qb_connections limit 1)
 where j.realm_id is null;

-- Uniqueness is per company now.
alter table public.customers
  drop constraint if exists customers_org_id_qb_id_key;
alter table public.customers
  add constraint customers_org_realm_qb_key unique (org_id, realm_id, qb_id);

alter table public.jobs
  drop constraint if exists jobs_org_id_qb_id_key;
alter table public.jobs
  add constraint jobs_org_realm_qb_key unique (org_id, realm_id, qb_id);

-- Expose the company name (still no tokens) to signed-in users.
drop view if exists public.qb_connection_status;
create view public.qb_connection_status as
select org_id, realm_id, company_name, status, last_sync_at, last_sync_error,
       created_at, updated_at
from public.qb_connections;

revoke all on public.qb_connection_status from anon;
grant select on public.qb_connection_status to authenticated;
