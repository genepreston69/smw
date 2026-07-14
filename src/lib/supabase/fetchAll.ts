// Supabase/PostgREST silently caps any query at 1000 rows (the project
// default for max-rows). Every list that must be complete — the Jobs
// dashboard, exports, and the sync's id-lookup maps — pages through with
// .range() until a short page signals the end.
//
// The `page` factory must build a fresh query per call (builders are
// one-shot) and MUST include a deterministic .order() so pages don't
// overlap or skip rows.

const PAGE_SIZE = 1000;

interface PageResult<Row> {
  data: Row[] | null;
  error: { message: string } | null;
}

export async function fetchAllRows<Row>(
  page: (from: number, to: number) => PromiseLike<PageResult<Row>>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}
