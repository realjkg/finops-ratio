// FinIO overview — the public explainer for the A2A interchange, served at
// /finio with the live exchange one click away at /finio/demo.
//
// Why this lives in the app rather than on the marketing site: FinIO is a
// Next.js app with server-side routes, so a static site builder can only ever
// link to it or frame it. Keeping the explainer here means /finio/demo is a real
// route rather than an iframe, the page inherits the design tokens for free, and
// there is one deploy instead of two.
//
// Visual register follows the UI Direction rules in .obvious/obvious.md: calm,
// hairline borders, generous whitespace, and the warm accent ('shape') reserved
// for the recommended-action CTA — nowhere else on the page.
//
// The FOCUS column list is read from the schema itself rather than retyped, so
// the page cannot drift out of sync with what the exchange actually sends.

import { COLUMNS_BY_VERSION } from '@/costsource/focusVersions';
import { SUPPORTED_FOCUS_VERSIONS } from './exchange';

const DEMO_HREF = '/finio/demo';

/** The mandatory FOCUS core every exchange carries, straight from the schema. */
const FOCUS_CORE_COLUMNS = COLUMNS_BY_VERSION['1.0'];

/** Ratio's value extensions. Each needs a human gloss, so these are annotated. */
const RATIO_EXTENSION_COLUMNS: Array<{ name: string; gloss: string }> = [
  { name: 'x_RatioValueRatio', gloss: 'return per dollar' },
  { name: 'x_RatioTotalValue', gloss: 'revenue protected + cost avoided' },
  { name: 'x_RatioWorkloadId', gloss: 'which workload earned it' },
  { name: 'x_RatioDemandShape', gloss: 'how it is being run' },
  { name: 'x_RatioGovernanceGates', gloss: 'gates passed, 0–4' },
];

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-edge py-14">
      {eyebrow && (
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
          {eyebrow}
        </p>
      )}
      <h2 className="mb-5 max-w-2xl text-xl font-semibold tracking-tight text-txt">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p className="max-w-2xl text-sm leading-relaxed text-sub">{children}</p>;
}

/** The single warm-accent CTA. Reserved role — do not reuse this style. */
function PrimaryCta({ children }: { children: React.ReactNode }) {
  return (
    <a
      href={DEMO_HREF}
      className="inline-flex items-center gap-2 rounded-card bg-shape px-5 py-2.5 text-sm font-semibold text-void transition-opacity hover:opacity-90"
    >
      {children}
      <span aria-hidden="true">→</span>
    </a>
  );
}

function StepCard({
  step,
  route,
  children,
}: {
  step: string;
  route: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-edge bg-slab p-5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-gate">
        {step}
      </p>
      <p className="mb-3 break-all font-mono text-sm font-bold text-txt">{route}</p>
      <p className="text-[13px] leading-relaxed text-sub">{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function FinioOverviewPage() {
  return (
    <div className="min-h-screen bg-void font-body text-txt">
      <div className="mx-auto max-w-4xl px-6 pb-20">

        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <header className="pt-20 pb-14">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-dim">
            Agent-to-agent FinOps interchange
          </p>
          <h1 className="mb-5 text-4xl font-semibold tracking-tight text-txt">FinIO</h1>
          <p className="mb-4 max-w-2xl text-base leading-relaxed text-txt">
            Two agents, one cost-and-value conversation. FinIO lets the Ratio agent
            exchange FinOps data with another company&apos;s agent over plain HTTP —
            using the FinOps Foundation&apos;s{' '}
            <a
              href="https://focus.finops.org/focus-specification/"
              target="_blank"
              rel="noreferrer"
              className="text-unit underline decoration-unit/30 underline-offset-4 hover:decoration-unit"
            >
              FOCUS specification
            </a>{' '}
            as the wire schema.
          </p>
          <p className="mb-8 max-w-2xl text-sm leading-relaxed text-sub">
            It is not a new protocol. It is FOCUS-shaped JSON moved through a small
            handshake. Any organization already exporting FOCUS-formatted billing can
            speak it without custom integration work.
          </p>
          <PrimaryCta>See the exchange</PrimaryCta>
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* The problem                                                      */}
        {/* ---------------------------------------------------------------- */}
        <Section
          eyebrow="Why it exists"
          title="FOCUS standardizes cost. Cost alone is just spend."
        >
          <Prose>
            The FOCUS specification did the hard work of making billing data portable
            across clouds and vendors. What it does not model is value — what the money
            bought. Two agents negotiating on cost columns alone can only ever argue
            about who spends less.
          </Prose>
          <div className="mt-4" />
          <Prose>
            FinIO carries both. Standard FOCUS columns carry the cost. A thin band of{' '}
            <span className="font-mono text-value">x_Ratio*</span> extension columns
            carries the value ratio: business outcome per inference dollar.
            Vendor-prefixed extension columns are explicitly permitted by the FOCUS
            spec, so this stays conformant while expressing the thing FOCUS leaves out.
          </Prose>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* How it works                                                     */}
        {/* ---------------------------------------------------------------- */}
        <Section eyebrow="The exchange" title="Two steps, synchronous, over HTTP">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StepCard step="Step 1 · Handshake" route="POST /api/v1/a2a/handshake">
              The initiating agent presents its identity, the operations it wants, and
              the FOCUS version it speaks. The responder authenticates the peer, agrees
              a version, and returns a short-lived session.
            </StepCard>
            <StepCard step="Step 2 · Export" route="GET /api/v1/finio/export">
              The session buys one FOCUS-shaped dataset, shaped to the version the two
              sides agreed on. Cost columns and value columns arrive together.
            </StepCard>
          </div>
          <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-dim">
            Version negotiation is real, not decorative. The agreed version is signed
            into the session, so the export cannot quietly return a shape the peer never
            agreed to. Anything outside the supported{' '}
            <span className="font-mono text-sub">
              v{SUPPORTED_FOCUS_VERSIONS[0]}–v
              {SUPPORTED_FOCUS_VERSIONS[SUPPORTED_FOCUS_VERSIONS.length - 1]}
            </span>{' '}
            range is refused, naming both sides.
          </p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* What crosses the wire                                            */}
        {/* ---------------------------------------------------------------- */}
        <Section eyebrow="The payload" title="One row, both halves of the ratio">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Cost half */}
            <div className="rounded-card border border-edge bg-slab p-5">
              <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.18em] text-sub">
                FOCUS standard — the cost
              </p>
              <ul className="space-y-1">
                {FOCUS_CORE_COLUMNS.map((column) => (
                  <li key={column} className="font-mono text-[11px] text-txt">
                    {column}
                  </li>
                ))}
              </ul>
            </div>

            {/* Value half */}
            <div className="rounded-card border border-value/25 bg-value/[0.03] p-5">
              <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.18em] text-value">
                Ratio extension — the value
              </p>
              <ul className="space-y-2.5">
                {RATIO_EXTENSION_COLUMNS.map(({ name, gloss }) => (
                  <li key={name}>
                    <span className="block font-mono text-[11px] text-value">{name}</span>
                    <span className="block text-[11px] text-dim">{gloss}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-dim">
            Interoperable with any FinOps tool that reads FOCUS. Meaningful to any agent
            that cares why the money was worth spending.
          </p>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Trust boundary                                                   */}
        {/* ---------------------------------------------------------------- */}
        <Section eyebrow="Security" title="A peer is not a stranger">
          <Prose>
            A shared token gates the handshake. A successful handshake returns a session
            that carries its own signed expiry — there is no server-side session table,
            so it holds up across instances. Peer credentials and session credentials
            travel in separate headers from the tenant API key, so two
            differently-scoped secrets never collide on one header and authenticate the
            wrong principal.
          </Prose>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Honest scope                                                     */}
        {/* ---------------------------------------------------------------- */}
        <Section eyebrow="Scope" title="What v1 is, and is not">
          <Prose>
            v1 is a working demonstration of the interchange, not a partner integration.
            One initiator, one responder, synchronous request and response. Deliberately
            out of scope: OAuth and mTLS, persistence, multi-party fan-out, webhook push,
            and full FOCUS column coverage.
          </Prose>
          <div className="mt-4" />
          <Prose>
            We would rather show you a small thing that actually runs than a large thing
            that does not.
          </Prose>
          <div className="mt-8">
            <PrimaryCta>Run the exchange yourself</PrimaryCta>
          </div>
        </Section>

        <footer className="border-t border-edge pt-8">
          <a href="/" className="font-mono text-xs text-dim hover:text-sub">
            ← back to Ratio
          </a>
        </footer>
      </div>
    </div>
  );
}
