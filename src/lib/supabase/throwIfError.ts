// A Supabase query that fails resolves with `{ data: null, error }` — it does
// not throw. A page that reads only `data` therefore renders a failed query as
// "nothing here": an empty approval queue, a plan with no line items, $0
// totals. Pass every query's `error` through this so an outage shows the
// error page (src/app/(app)/error.tsx) instead of data that looks real.
export function throwIfError(
  /** Names what was being loaded, for the server log. */
  what: string,
  ...errors: ({ message: string } | null | undefined)[]
): void {
  const failed = errors.find(Boolean);
  if (failed) throw new Error(`Could not load ${what}: ${failed.message}`);
}
