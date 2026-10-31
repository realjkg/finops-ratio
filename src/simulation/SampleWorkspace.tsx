// Read-only sample workspace for /simulation when server simulation is off. Local state only:
// nothing here calls the server, reads credentials, or writes to storage (so it does not use
// usePersona, which persists the choice).
import { useState } from 'react';
import type { Persona } from '@/lib/persona';
import { SAMPLE_LABEL, SAMPLE_PERSONAS, sampleView } from './sampleWorkspace';

const ORDER: Persona[] = ['executive', 'technical', 'procurement'];

export function SampleWorkspace() {
  const [persona, setPersona] = useState<Persona | null>(null);
  const view = persona ? sampleView(persona) : null;
  return (
    <div className="mt-8">
      <p role="note" className="inline-block rounded border border-unit/40 bg-unit/10 px-3 py-1 font-mono text-xs text-unit">{SAMPLE_LABEL}</p>
      <p className="mt-3 max-w-2xl text-sm text-sub">
        This deployment does not save customer workspaces, so here is a read-only sample. Pick a role to see the same synthetic costs through its lens. No sign-in is needed, nothing is sent anywhere, and it is gone when you close the tab.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {ORDER.map((p) => (
          <section key={p} className="flex flex-col rounded-lg border border-edge bg-deep p-5">
            <p className="text-xs uppercase tracking-widest text-dim">Sample</p>
            <h2 className="mt-2 text-lg">{SAMPLE_PERSONAS[p].title}</h2>
            <p className="mt-2 flex-1 text-sm text-sub">{SAMPLE_PERSONAS[p].blurb}</p>
            <button type="button" aria-pressed={persona === p} onClick={() => setPersona(p)} className="mt-5 rounded border border-gate px-3 py-2 text-sm text-gate aria-pressed:bg-gate aria-pressed:text-void">
              {persona === p ? `Viewing ${SAMPLE_PERSONAS[p].title}` : `Open ${SAMPLE_PERSONAS[p].title} sample`}
            </button>
          </section>
        ))}
      </div>
      {view && (
        <section aria-label={`Sample workspace: ${SAMPLE_PERSONAS[view.persona].title}`} className="mt-6 rounded-lg border border-edge bg-slab p-5">
          <dl className="grid gap-3 sm:grid-cols-3">
            {view.stats.map((s) => (
              <div key={s.label} className="rounded border border-edge bg-deep p-3">
                <dt className="text-xs text-sub">{s.label}</dt>
                <dd className="mt-1 font-mono text-lg tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-5 text-sm font-semibold">{view.heading}</h3>
          <ul className="mt-2 divide-y divide-edge">
            {view.rows.map((r) => (
              <li key={r.label} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0"><span className="block break-words">{r.label}</span><span className="block break-words text-xs text-sub">{r.detail}</span></span>
                <span className={`shrink-0 font-mono tabular-nums ${r.flag === 'risk' ? 'text-cost' : ''}`}>{r.value}{r.flag === 'risk' ? ' (watch)' : ''}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-sub">{view.note}</p>
        </section>
      )}
    </div>
  );
}
