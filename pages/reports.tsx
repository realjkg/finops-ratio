// Reports — placeholder (Wave 4 Slice 1).
// PDF and XLSX report exports are generated from the Overview page;
// a dedicated reports hub lives here in a future slice.
export default function Reports() {
  return (
    <div className="flex h-full flex-col bg-void font-body text-txt">
      <main className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-dim">Coming soon</p>
        <h1 className="font-mono text-xl font-bold text-txt">Reports</h1>
        <p className="text-sm text-sub">
          PDF and XLSX exports are available today from the{' '}
          <a href="/overview" className="text-gate underline hover:no-underline">
            Overview
          </a>{' '}
          page.
        </p>
      </main>
    </div>
  );
}

