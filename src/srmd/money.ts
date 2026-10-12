// Exact decimal <-> integer nano-unit conversion, string based so no float is
// ever involved. Same scale as aiSpendRatio.ts (that module does not export
// its helper and is not edited in this slice). BigInt() calls, not literals:
// the tsconfig target predates ES2020.
const NANOS = BigInt(1_000_000_000);

export function parseNanos(text: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (!m) throw new Error('not an exact decimal amount');
  const abs = BigInt(m[2]) * NANOS + BigInt((m[3] ?? '').padEnd(9, '0'));
  return m[1] ? -abs : abs;
}

export function formatNanos(nanos: bigint): string {
  const abs = nanos < BigInt(0) ? -nanos : nanos;
  return `${nanos < BigInt(0) ? '-' : ''}${abs / NANOS}.${(abs % NANOS).toString().padStart(9, '0')}`;
}
