// Text size and font controls in the top bar. Choices apply immediately, persist in
// localStorage when it is available, and never block the page when it is not.
import { useEffect, useState } from 'react';
import { DEFAULT_TYPOGRAPHY, FAMILIES, SCALES, applyTypography, loadTypography, saveTypography, type FamilyId, type Typography } from '@/theme/typography';

const btn = 'rounded border border-edge bg-raised px-2 py-1 font-mono text-xs text-txt hover:bg-slab';
const select = 'min-w-0 rounded border border-edge bg-raised px-1 py-0.5 text-txt';

export function TypographyMenu() {
  const [t, setT] = useState<Typography>(DEFAULT_TYPOGRAPHY);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => setT(loadTypography()), []);

  const choose = (next: Typography) => {
    setT(next);
    applyTypography(next);
    setNote(saveTypography(next) ? '' : 'Storage is unavailable: this choice will not be saved after you leave the page.');
  };

  return (
    <div>
      <button type="button" className={btn} aria-expanded={open} aria-controls="typography-panel" onClick={() => setOpen(!open)}>Text</button>
      <div className="absolute inset-x-2 top-full z-40 mt-1 text-xs text-txt md:inset-x-auto md:right-0 md:w-72">
        <p id="typography-status" role="status" className={note ? 'rounded border border-edge bg-slab p-2' : ''}>{note}</p>
        {open && (
          <section id="typography-panel" aria-label="Text settings" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2 rounded border border-edge bg-slab p-3 shadow-lg">
            <label htmlFor="text-size">Text size</label>
            <select id="text-size" value={t.scale} onChange={(e) => choose({ ...t, scale: Number(e.target.value) as Typography['scale'] })} className={select}>
              {SCALES.map((s) => <option key={s} value={s}>{s}%{s === 100 ? ' (default)' : ''}</option>)}
            </select>
            <label htmlFor="text-font">Font</label>
            <select id="text-font" value={t.family} onChange={(e) => choose({ ...t, family: e.target.value as FamilyId })} className={select}>
              {Object.entries(FAMILIES).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
            </select>
          </section>
        )}
      </div>
    </div>
  );
}
