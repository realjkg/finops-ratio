// The worker redactor's input cap and per-string cost (L-p / L-q).
//
// - Only MAX_REDACTED_LENGTH characters are ever kept, so the input cap is a
//   little above that (MAX_REDACTED_LENGTH + 512): every rule's work is bounded
//   by a few KB per string, however long the message.
// - The cut backs up to a delimiter AND never lands inside an occurrence of a
//   configured secret form, so a straddling secret leaves no fragment (sweep).
// - Per-string budgets (median of several runs, so load does not make them
//   flaky): a string AT the cap, of every scheme-repeat shape, redacts in
//   < 25 ms; so does a 2 MB string (the cap bounds the work).
import { describe, expect, it } from 'vitest';
import { capForRedaction, MAX_REDACT_INPUT_CHARS, MAX_REDACTED_LENGTH, redact, secretsFromEnv, TRUNCATED_MARKER } from './redact';

const SECRET = 'pw"q\\b%22x';
const ENV = {
  RATIO_DATABASE_URL: `postgres://worker_login:${encodeURIComponent(SECRET)}@127.0.0.1:5432/db`,
  RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'S3-secret-key-value-cap',
};
const SECRETS = secretsFromEnv(ENV);

function medianMs(f: () => unknown, runs = 9): number {
  f(); // warm-up (regex compilation, JIT)
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    f();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

describe('input cap', () => {
  it('is a little above the kept length: MAX_REDACTED_LENGTH < cap <= MAX_REDACTED_LENGTH + 512', () => {
    expect(MAX_REDACT_INPUT_CHARS).toBeGreaterThan(MAX_REDACTED_LENGTH);
    expect(MAX_REDACT_INPUT_CHARS).toBeLessThanOrEqual(MAX_REDACTED_LENGTH + 512);
  });

  it('caps long text at a delimiter, appends the marker, leaves short text alone', () => {
    const short = 'x'.repeat(MAX_REDACT_INPUT_CHARS);
    expect(capForRedaction(short)).toBe(short);
    const long = 'abcdef '.repeat(1_000_000 / 7);
    const out = capForRedaction(long);
    expect(out.length).toBeLessThanOrEqual(MAX_REDACT_INPUT_CHARS + TRUNCATED_MARKER.length);
    expect(out.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(long.startsWith(out.slice(0, -TRUNCATED_MARKER.length))).toBe(true);
    expect(long[out.length - TRUNCATED_MARKER.length]).toBe(' ');
  });

  it('a secret form straddling the cut never leaves a fragment (sweep over every form, offset and filler)', () => {
    const forms = [...new Set(SECRETS)];
    const fillers = ['z'.repeat(MAX_REDACT_INPUT_CHARS * 2), 'zzzzzz '.repeat(MAX_REDACT_INPUT_CHARS / 3), 'z,z;z&z<z>z'.repeat(MAX_REDACT_INPUT_CHARS / 5)];
    let cases = 0;
    for (const form of forms) {
      const prefixes = Array.from({ length: form.length - 1 }, (_, i) => form.slice(0, i + 2)); // every prefix of >= 2 chars
      for (const filler of fillers) {
        for (let start = MAX_REDACT_INPUT_CHARS - form.length - 2; start <= MAX_REDACT_INPUT_CHARS + 1; start++) {
          const text = filler.slice(0, start) + form + filler.slice(start);
          const kept = capForRedaction(text, SECRETS);
          const body = kept.endsWith(TRUNCATED_MARKER) ? kept.slice(0, -TRUNCATED_MARKER.length) : kept;
          // Either the whole form is kept (and then redacted by the literal rule), or none of it.
          if (!body.includes(form)) {
            const tail = body.slice(Math.max(0, start - 1));
            for (const p of prefixes) expect(tail.includes(p), `fragment ${JSON.stringify(p)} of ${JSON.stringify(form)} at ${start}`).toBe(false);
          }
          const red = redact(text, SECRETS);
          for (const f of forms) expect(red.includes(f)).toBe(false);
          cases++;
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });
});

describe('per-string cost (median of 9 runs)', () => {
  const SHAPES: Record<string, string> = {
    'a://': 'a://',
    'x://y://': 'x://y://',
    'a.b://': 'a.b://',
    'http://': 'http://',
    'a://b?': 'a://b?',
    letters: 'a',
    'scheme chars': 'a.b-c+d',
  };
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  for (const [name, unit] of Object.entries(SHAPES)) {
    it(`${name} repeated, exactly at the cap: < 25 ms`, () => {
      const text = fill(unit, MAX_REDACT_INPUT_CHARS);
      expect(medianMs(() => redact(text, SECRETS))).toBeLessThan(25);
    });
    it(`${name} repeated, 2 MB (the cap bounds the work): < 25 ms`, () => {
      const text = fill(unit, 2_000_000);
      expect(medianMs(() => redact(text, SECRETS))).toBeLessThan(25);
    });
  }
});
