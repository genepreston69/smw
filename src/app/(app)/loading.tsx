// Shown inside the app shell while a page's data loads. The financial pages
// read a lot of ledger; without this a sidebar click looks like nothing
// happened until the whole page is ready.
export default function AppLoading() {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-64 rounded-md bg-line/70" />
      <div className="mt-3 h-4 w-96 max-w-full rounded bg-line/50" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-line bg-white" />
        ))}
      </div>
      <div className="mt-4 h-96 rounded-xl border border-line bg-white" />
    </div>
  );
}
