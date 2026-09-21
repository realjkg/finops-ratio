// SnapshotButton (Ratio v2 Wave 2b). The executive surface's on-demand reporting
// affordance — a light-theme dropdown offering the two approved exports (PDF +
// XLSX). Each option fetches /api/report/snapshot and hands the browser an
// auto-timestamped download, preserving the server's Content-Disposition
// filename. Framer Motion fade-in honors prefers-reduced-motion. Pure client
// glue: all report math + rendering lives server-side behind the API route.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { TOKEN_HEX } from '@/lib/scales';
import { withBasePath } from '@/lib/basePath';
import type { ReportFormat } from './reportFilename';

const OPTIONS: { format: ReportFormat; label: string }[] = [
  { format: 'pdf', label: 'Download PDF report' },
  { format: 'xlsx', label: 'Download Spreadsheet (.xlsx)' },
];

type DownloadState = 'idle' | 'working' | 'error';

// Pull the auto-timestamped filename the server set, so the saved file matches
// the report's generated instant rather than a guessed client name.
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/.exec(header);
  return match?.[1] ?? null;
}

async function downloadReport(format: ReportFormat): Promise<void> {
  const res = await fetch(withBasePath(`/api/report/snapshot?format=${format}`));
  if (!res.ok) throw new Error(`Snapshot failed: ${res.status}`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const filename =
    filenameFromDisposition(res.headers.get('Content-Disposition')) ??
    `ratio-report.${format}`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function SnapshotButton() {
  const reducedMotion = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DownloadState>('idle');
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismiss the menu on outside-click and Escape (standard popover semantics).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function handleSelect(format: ReportFormat) {
    setState('working');
    try {
      await downloadReport(format);
      setState('idle');
      setOpen(false);
    } catch (err) {
      // Never swallow: surface a recoverable inline error, keep the menu open.
      console.error('Snapshot export failed', err);
      setState('error');
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={state === 'working'}
        className="rounded-full border border-exec-border bg-exec-surface px-4 py-2 font-mono text-xs font-semibold tracking-wide shadow-sm transition-colors hover:bg-exec-bg focus:outline-none focus-visible:ring-2 disabled:opacity-60"
        style={{ color: TOKEN_HEX.gate, ['--tw-ring-color' as string]: TOKEN_HEX.gate }}
      >
        {state === 'working' ? 'Preparing…' : 'Snapshot ↓'}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Download report"
            initial={reducedMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-10 mt-2 w-56 overflow-hidden rounded-lg border border-exec-border bg-exec-surface shadow-lg"
          >
            {OPTIONS.map((opt) => (
              <button
                key={opt.format}
                type="button"
                role="menuitem"
                onClick={() => handleSelect(opt.format)}
                disabled={state === 'working'}
                className="block w-full px-4 py-2.5 text-left font-body text-sm text-exec-text transition-colors hover:bg-exec-bg disabled:opacity-60"
              >
                {opt.label}
              </button>
            ))}
            {state === 'error' && (
              <p className="px-4 py-2 font-body text-xs" style={{ color: TOKEN_HEX.cost }} role="alert">
                Export failed — please try again.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

