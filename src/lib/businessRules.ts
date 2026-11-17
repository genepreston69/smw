// Business rules that are code on purpose.
//
// Rules an admin can change without a deploy live in the database
// (public.app_settings, edited on the Settings page; see appSettings.ts): the
// budget year, the Cost of Benefits base accounts and the sister-company list.
//
// The dates here are different: moving one changes which imported history the
// app keeps or shows, so each stays a reviewed code change, in this one file.

/**
 * Start of the job cost / invoice import window. Each sync refreshes rows
 * dated on or after this; earlier rows are frozen audited history (the books
 * are audited through 2024-12-31) and are never deleted or re-fetched.
 *
 * Must not be later than NO_TXN_CUTOFF (the test suite checks this).
 */
export const JOB_COSTS_START_DATE = "2025-01-01";

/**
 * Start of the general-ledger import window. Earlier ledger lines are frozen
 * (`archived`, migration 0020).
 *
 * DO NOT change this alone: the gl_line_facts view hard-codes the same date
 * and prune_gl_lines deletes un-archived lines outside the current import, so
 * moving it forward without a migration that archives the gap first would
 * hide and then delete that part of the ledger.
 */
export const FINANCIALS_START_DATE = "2025-01-01";

/**
 * Jobs with no cost or invoice activity on or after this date land in the
 * Jobs dashboard's No Transactions view (US Army Corps of Engineers jobs are
 * exempt). The job cost import window must reach back at least this far, or
 * recent activity would be invisible to the test.
 */
export const NO_TXN_CUTOFF = "2025-01-01";
