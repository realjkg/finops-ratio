// The engagement report on screen: renders the ONE engagement report model
// (the same one the XLSX and PDF render) as one table per section, every cell
// verbatim: exact amounts, 'N/A' with its reason in the row's Note, the
// last-published-batch warning always visible. Pure presentation: no data
// fetching, no server-only imports, theme tokens only.
import type { EngagementReportModel } from './engagementReportModel';

export function EngagementReportView({ model }: { model: EngagementReportModel }) {
  const gaps = model.sections.find((s) => s.id === 'coverageGaps');
  const warning = gaps?.rows.find((r) => r[0] === 'BATCH_STATUS_NOT_VISIBLE')?.[1];
  return (
    <article className="space-y-7" aria-labelledby="engagement-report-title">
      <header>
        <h2 id="engagement-report-title" className="text-xl font-semibold text-txt">
          {model.title}
        </h2>
        <p className="mt-1 text-sm text-sub">Generated {model.generatedAt}</p>
      </header>
      {warning && (
        <aside role="note" aria-label="Data status" className="rounded border border-shape bg-shape/10 p-4 text-sm text-txt">
          <p className="font-semibold">Data status</p>
          <p className="mt-1">{warning}</p>
        </aside>
      )}
      {model.sections.map((s) => (
        <section key={s.id} data-section={s.id} className="space-y-3">
          <h3 id={`section-${s.id}`} className="text-lg font-semibold text-txt">
            {s.title}
          </h3>
          <div role="region" aria-label={s.title} tabIndex={0} className="overflow-x-auto rounded border border-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-unit">
            <table className="sim-table">
              <thead>
                <tr>
                  {s.columns.map((c, i) => (
                    <th key={i} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((cell, i) => (
                      // Words and 64-character hashes stay whole (the table scrolls); only a longer unbroken token wraps anywhere.
                      <td key={i} className={`max-w-[40rem] whitespace-pre-wrap align-top ${/\S{65,}/.test(cell) ? '[overflow-wrap:anywhere]' : 'break-words'} ${i === r.length - 1 ? 'min-w-[24rem] text-sub' : cell.length > 60 ? 'min-w-[22rem]' : ''}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </article>
  );
}
