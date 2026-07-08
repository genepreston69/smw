export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-bold tracking-wide text-ink-900">
        SMW <span className="font-normal text-ink-400">Job Plans</span>
      </p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-900">
        {title}
      </h1>
      <div className="mt-6 space-y-4 text-sm leading-relaxed text-ink-600">
        {children}
      </div>
    </div>
  );
}
