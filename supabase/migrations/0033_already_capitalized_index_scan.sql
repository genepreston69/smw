-- =============================================================================
-- Already Capitalized: read only the selected year of the ledger
--
-- capitalized_labor_entries (migration 0032) filtered gl_line_facts by date
-- alone, but gl_lines' date index leads with org_id (gl_lines_date_idx:
-- org_id, txn_date), so without an org condition the planner reads the whole
-- ledger — every year, every superseded sync generation — before keeping
-- one year of journal entries. Scoping to the organization lets that index
-- range-scan just the window. Same output as 0032.
--
-- Apply after 0032 (it only replaces that function).
-- =============================================================================

create or replace function public.capitalized_labor_entries(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = public
as $$
  with lines as (
    select f.realm_id,
           f.qb_txn_id,
           f.txn_date,
           f.doc_number,
           f.account_full_name as account,
           f.classification,
           f.account_type,
           case
             when f.classification = 'Asset'
                  and f.account_type in ('Fixed Asset', 'Other Asset') then 'asset'
             when public.cap_labor_account(f.account_full_name, f.classification) then 'labor'
             else 'other'
           end as kind,
           f.customer_name,
           f.memo,
           f.amount
    from public.gl_line_facts f
    -- One org per deployment; the subselect is evaluated once, so the date
    -- index can range-scan (org_id, txn_date).
    where f.org_id = (select public.default_org_id())
      and f.txn_date between p_from and p_to
      and f.txn_type ilike 'journal%entry'
      and f.qb_txn_id is not null
  ),
  entries as (
    select realm_id, qb_txn_id
    from lines
    group by 1, 2
    having bool_or(kind = 'asset' and amount > 0)
       and coalesce(sum(amount) filter (where kind = 'labor'), 0) < 0
  )
  select jsonb_build_object(
    'lines', coalesce(
      (select jsonb_agg(
                jsonb_build_array(l.realm_id, l.qb_txn_id, l.txn_date, l.doc_number,
                                  l.account, l.account_type, l.kind, l.customer_name,
                                  l.memo, l.amount, l.classification)
                order by l.txn_date desc, l.realm_id, l.qb_txn_id, l.kind, l.account)
         from lines l
         join entries e using (realm_id, qb_txn_id)),
      '[]'::jsonb));
$$;

revoke all on function public.capitalized_labor_entries(date, date) from anon, authenticated, public;
grant execute on function public.capitalized_labor_entries(date, date) to service_role;
