// EvidenceMark — the quiet provenance mark beside a value number (audit C1/C8).
// Says how firm the value is: "Estimated value" (assumptions), "Projected value" or
// "Measured value". Renders nothing when no evidence status exists (the UI never invents
// provenance).
//
// `explain` turns the label into a button that opens a short explanation. It works by tap,
// click or keyboard (Enter and Space; Escape or an outside tap closes), unlike a title
// tooltip. Leave it off where the mark sits inside another button or link (a list row), where
// a nested control is not allowed; the static label keeps the title text.

import { useEffect, useId, useRef, useState } from 'react';
import type { EvidenceStatus } from '@/types';
import { EVIDENCE_META } from '@/lib/valueEvidence';

export function EvidenceMark({
  status,
  className = '',
  explain = false,
}: {
  status?: EvidenceStatus;
  className?: string;
  explain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  if (!status) return null;
  const meta = EVIDENCE_META[status];
  const style = { color: meta.color };
  const base = `text-[11px] font-medium ${className}`;

  if (!explain) {
    return (
      <span className={base} style={style} title={meta.title}>
        {meta.label}
      </span>
    );
  }
  return (
    <span ref={box} className={`relative inline-flex ${className}`} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="text-[11px] font-medium underline decoration-dotted underline-offset-2"
        style={style}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {meta.label}
      </button>
      {open && (
        <span id={id} role="note" className="absolute left-0 top-full z-20 mt-1 w-56 rounded border border-edge bg-raised p-2 text-xs font-normal text-txt shadow-lg">
          {meta.title}
        </span>
      )}
    </span>
  );
}
