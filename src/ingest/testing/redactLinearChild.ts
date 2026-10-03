// Child process for redactLinear.test.ts (run with tsx). A synchronous regex
// cannot be pre-empted inside the test worker, so each case runs here under a
// hard wall-clock kill. Input: env RATIO_LINEAR_CASE = JSON
// { expr: string (JS expression building the input), sizes: number[] }.
// Output (stdout): one JSON line per (size, entry point) with the time taken,
// the output length, whether the truncation marker is present and every
// secret form that survived.
import { jsonLineRedactorFor, redact, secretsFromEnv } from '../redact';

/** The truncation marker the capped redactor appends (same text as the app redactor, #47). */
export const LINEAR_TRUNCATED_MARKER = ' …[TRUNCATED]';

export const LINEAR_SECRET = 'pw"q\\b%22x';
export const LINEAR_ENV: Record<string, string> = {
  RATIO_DATABASE_URL: `postgres://worker_login:${encodeURIComponent(LINEAR_SECRET)}@127.0.0.1:5432/db`,
  RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'S3-secret-key-value-linear',
};

/** Every form of the secrets that must never survive (raw, URL-encoded, JSON-escaped, both). */
export function linearForms(): string[] {
  const out = new Set<string>();
  for (const s of [LINEAR_SECRET, LINEAR_ENV.RATIO_SOURCE_S3_SECRET_ACCESS_KEY]) {
    for (const v of [s, encodeURIComponent(s)]) {
      out.add(v);
      out.add(JSON.stringify(v).slice(1, -1));
    }
  }
  return [...out];
}

function main(): void {
  const spec = JSON.parse(process.env.RATIO_LINEAR_CASE ?? '{}') as { expr: string; sizes: number[] };
  const build = new Function('N', 'SECRET', `return (${spec.expr});`) as (n: number, secret: string) => string;
  const secrets = secretsFromEnv(LINEAR_ENV);
  const line = jsonLineRedactorFor(LINEAR_ENV);
  const forms = linearForms();
  for (const size of spec.sizes) {
    const input = build(size, LINEAR_SECRET);
    if (input.length < size * 0.9) throw new Error(`input too small: ${input.length} < ${size}`);
    for (const [entry, fn] of [
      ['redact', () => redact(input, secrets)],
      ['jsonLineRedactorFor', () => line({ message: input, err: new Error(input), nested: { [input.slice(0, 64)]: [input] } })],
    ] as Array<[string, () => string]>) {
      const t0 = performance.now();
      const out = fn();
      const ms = Math.round(performance.now() - t0);
      process.stdout.write(
        JSON.stringify({ size, entry, ms, outLen: out.length, truncated: out.includes(LINEAR_TRUNCATED_MARKER), leaked: forms.filter((f) => out.includes(f)) }) + '\n',
      );
    }
  }
}

if (process.env.RATIO_LINEAR_CASE) main();
