-- =============================================================================
-- Capitalized Labor dashboard support
--
-- The Capitalized Labor dashboard surfaces journal-entry lines that post
-- labor/payroll/wages accounts to non-billable (EQP) or intercompany jobs —
-- payroll allocations that may belong in a capital account rather than job
-- cost. The rows already exist in job_costs (qb_txn_type = 'JournalEntry',
-- cost_type = 'labor'); this migration adds:
--
--   qb_doc_number — the transaction's user-facing number (a journal entry's
--     "Journal no.", a bill's ref number) so lines can be traced back to the
--     exact entry in QuickBooks. Populated by the next sync — each sync fully
--     refreshes a company's rows, so no backfill is needed.
--
--   a partial index for the dashboard's cross-job scan of journal labor lines.
-- =============================================================================

-- Idempotent guards so re-running (e.g. pasted into the SQL editor twice)
-- is harmless.
alter table public.job_costs
  add column if not exists qb_doc_number text;

create index if not exists job_costs_journal_labor_idx
  on public.job_costs (org_id, txn_date desc)
  where qb_txn_type = 'JournalEntry' and cost_type = 'labor';
