// EvidenceMark — the quiet provenance mark beside a value number (audit C1/C8).
// Says how firm the value is: "Estimated value" (assumptions), "Projected value" or
// "Measured value". Renders nothing when no evidence status exists (the UI never invents
// provenance).
//
// `explain` turns the label into a button that opens a short explanation. It works by tap,
// click or keyboard (Enter and Space; Escape or an outside tap closes), unlike a title
// tooltip. Escape closes it only when focus is on the button or in the popup (or nowhere in
// particular), so Escape pressed inside another panel (Frank) is left to that panel. When open,
// the button is described by the popup (aria-describedby) and a polite live region next to the
// button announces the text, because the portaled popup is not next to the button in the DOM. The explanation is rendered in a portal with fixed placement clamped to the
// viewport (lib/popupPlacement.ts), so a narrow phone or an overflow container never clips it.
// On phones a pseudo-element extends the hit area to at least 44px tall without adding layout height
// (a taller box would push neighbouring lines at large text sizes).
// Leave `explain` off where the mark sits inside another button or link (a list row), where
// a nested control is not allowed; the static label keeps the title text.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EvidenceStatus } from '@/types';
import { EVIDENCE_META } from '@/lib/valueEvidence';
import { placePopup, type Placement } from '@/lib/popupPlacement';

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
  const [place, setPlace] = useState<Placement | null>(null);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLSpanElement>(null);

  const reposition = () => {
    if (!button.current) return;
    const a = button.current.getBoundingClientRect();
    const h = note.current?.offsetHeight ?? 90;
    setPlace(placePopup(a, h, { width: window.innerWidth, height: window.innerHeight }));
  };

  useLayoutEffect(() => {
    if (open) reposition();
    else setPlace(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !note.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as Node | null;
      const mine = !t || t === document.body || t === document.documentElement || button.current?.contains(t) || note.current?.contains(t);
      if (!mine) return; // e.g. Escape inside the Frank panel closes that panel, not this popup
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
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
    <span className={`inline-flex ${className}`}>
      <button
        ref={button}
        type="button"
        className="relative inline-flex items-center text-[11px] font-medium underline decoration-dotted underline-offset-2 max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-3.5 max-md:before:content-['']"
        style={style}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {meta.label}
      </button>
      {/* Announces the explanation when it opens (polite: it does not interrupt). Empty when closed. */}
      <span className="sr-only" aria-live="polite" data-testid="evidence-live">{open ? meta.title : ''}</span>
      {open &&
        createPortal(
          <span
            ref={note}
            id={id}
            role="note"
            data-testid="evidence-note"
            className="fixed z-50 rounded border border-edge bg-raised p-2 text-xs font-normal text-txt shadow-lg"
            style={place ? { left: place.left, top: place.top, width: place.width } : { left: 0, top: 0, width: 224, visibility: 'hidden' }}
          >
            {meta.title}
          </span>,
          document.body,
        )}
    </span>
  );
}
