// FOCUS date/time values are ISO 8601 in UTC. Accepts `Z`, numeric offsets,
// fractional seconds, a space instead of `T`, a bare date, and offset-less
// values (interpreted as UTC, as the FOCUS spec mandates UTC). Rejects
// impossible calendar values. Returns a normalized ISO string for Postgres.

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface ParsedTimestamp {
  /** Normalized ISO-8601 string (offset preserved; `Z` when none was given). */
  iso: string;
  /** Instant in ms (fractional digits beyond ms are ignored here, kept in iso). */
  epochMs: number;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function parseFocusTimestamp(s: string): ParsedTimestamp | null {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m = TS_RE.exec(s);
  if (!m) return null;
  const [, ys, mos, ds, hs = '00', mis = '00', ss = '00', frac = '', zone = 'Z'] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const sec = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59) return null;
  let offsetMin = 0;
  let zoneOut = 'Z';
  if (zone !== 'Z') {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    const zh = Number(zm[2]);
    const zmin = Number(zm[3]);
    if (zh > 14 || zmin > 59) return null;
    offsetMin = (zm[1] === '-' ? -1 : 1) * (zh * 60 + zmin);
    zoneOut = `${zm[1]}${zm[2]}:${zm[3]}`;
  }
  const ms = frac ? Number((frac.slice(1) + '00').slice(0, 3)) : 0;
  const epochMs = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000;
  const iso = `${ys}-${mos}-${ds}T${hs}:${mis}:${ss}${frac}${zoneOut}`;
  return { iso, epochMs };
}
