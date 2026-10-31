// A small table of money values that stays readable on a phone: a real table from the sm breakpoint up,
// and stacked label / value rows (a description list) below it, so no number is clipped or hidden behind
// a sideways scroll. The first column is the row header.
const th = 'px-2 py-1 text-left text-xs font-medium text-sub';
const td = 'whitespace-nowrap px-2 py-1 font-mono text-xs tabular-nums';

export function MoneyTable({ label, caption, headers, rows }: { label: string; caption: string; headers: string[]; rows: string[][] }) {
  return (
    <div>
      <p className="pb-1 text-xs text-sub sm:hidden">{caption}</p>
      <div className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <dl key={r[0]} className="rounded border border-edge bg-deep p-2 text-xs">
            <dt className="sr-only">{headers[0]}</dt>
            <dd className="mb-1 break-words font-medium">{r[0]}</dd>
            {headers.slice(1).map((h, i) => (
              <div key={h} className="flex items-baseline justify-between gap-3">
                <dt className="text-sub">{h}</dt>
                <dd className="font-mono tabular-nums">{r[i + 1]}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      <table className="hidden w-full sm:table" aria-label={label}>
        <caption className="pb-1 text-left text-xs text-sub">{caption}</caption>
        <thead><tr>{headers.map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <th scope="row" className={`${th} text-txt`}>{r[0]}</th>
              {r.slice(1).map((v, i) => <td key={headers[i + 1]} className={td}>{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
