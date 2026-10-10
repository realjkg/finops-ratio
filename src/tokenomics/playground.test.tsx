// Component render smoke tests for the playground and the embed route.
// Uses react-dom/server (no DOM needed) — these execute the full component
// tree on the seeded default scenario and assert the rendered contract:
// controls present, run-button/mode-toggle flow gone, embed page bare.
// Slider interaction and animation are verified separately in the browser
// (agent-browser dogfood evidence on the PR).
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TokenomicsPlayground } from './TokenomicsPlayground';
import { TokenomicsPage } from './TokenomicsPage';
import { TokenFlowTrace } from './TokenFlowTrace';
import { MIX_MODELS, DEFAULT_SCENARIO, deriveScenario, METRIC_LABELS } from './index';
import EmbedPage from '../../pages/tokenomics/embed';

const count = (html: string, needle: string): number => html.split(needle).length - 1;

/** Escapes `&` the way React's SSR output does, so label assertions hold. */
const escapeHtmlAmp = (s: string): string => s.replace(/&/g, '&amp;');

describe('TokenomicsPlayground (render smoke)', () => {
  const html = renderToString(<TokenomicsPlayground />);

  it('renders the playground header and no-invented-numbers tagline', () => {
    expect(html).toContain('Tokenomics Playground');
    expect(html).toContain('traces to seed data × your inputs');
  });

  it('renders five sliders: volume, growth, and one per mix model', () => {
    expect(count(html, 'type="range"')).toBe(2 + MIX_MODELS.length);
    expect(html).toContain('Daily inferences');
    expect(html).toContain('Growth per month');
    for (const m of MIX_MODELS) {
      expect(html).toContain(m.displayName);
    }
  });

  it('renders the scenario value-ratio hero on the ValueRatioMeter (role=meter)', () => {
    const bridge = deriveScenario(DEFAULT_SCENARIO);
    expect(html).toContain('Value returned per inference dollar');
    expect(html).toContain('role="meter"');
    expect(html).toContain(`aria-valuenow="${bridge.valueRatio}`);
  });

  it('pairs cost with value (R4) and shows both figures', () => {
    expect(html).toContain('Monthly cost');
    expect(html).toContain('Monthly value returned');
  });

  it('renders the token-flow trace with all three layers', () => {
    expect(html).toContain('Token-flow traceability');
    expect(html).toContain('Hardware Ingest');
    expect(html).toContain('Data Pipeline');
    expect(html).toContain('UI Presentation');
  });

  it('renders all three integrity metric cards with the shared formulas', () => {
    expect(html).toContain(METRIC_LABELS.counterAlignment.focus);
    expect(html).toContain(escapeHtmlAmp(METRIC_LABELS.counterAlignment.formulaLabel));
    expect(html).toContain(escapeHtmlAmp(METRIC_LABELS.pipelineIntegrity.focus));
    expect(html).toContain(escapeHtmlAmp(METRIC_LABELS.pipelineIntegrity.formulaLabel));
    expect(html).toContain(METRIC_LABELS.ledgerSync.focus);
    expect(html).toContain(escapeHtmlAmp(METRIC_LABELS.ledgerSync.formulaLabel));
    // Metric 2's pending-unit assumption callout stays visible.
    expect(html).toContain('Assumption — needs confirmation');
  });

  it('has removed the Run-button / mode-toggle flow from the playground', () => {
    expect(html).not.toContain('Run Tokenomics Report');
    expect(html).not.toContain('Client mode');
  });

  it('renders the derivations panel citing seed workings', () => {
    expect(html).toContain('Derivations — seed × scenario');
    expect(html).toContain('Capture rate (seed)');
    expect(html).toContain('Heartbeat allowance (seed, unit pending)');
  });
});

describe('TokenomicsPlayground (zero-mix state)', () => {
  const zeroMix = {
    ...DEFAULT_SCENARIO,
    mixWeights: MIX_MODELS.map((m) => ({ modelId: m.modelId, weightPct: 0 })),
  };
  const html = renderToString(<TokenomicsPlayground initialScenario={zeroMix} />);

  it('shows the empty state and the seeded meters instead of invented figures', () => {
    expect(html).toContain('No model share — raise a mix slider to compute a scenario.');
    expect(html).toContain('aria-valuenow="0');
  });
});

describe('TokenFlowTrace (render smoke)', () => {
  it('renders in/out counts and the exact-zero ledger delta', () => {
    const html = renderToString(<TokenFlowTrace bridge={deriveScenario(DEFAULT_SCENARIO)} />);
    // SSR inserts comment markers between text nodes — assert comment-safe strings.
    expect(count(html, 'Hardware Ingest')).toBe(1);
    expect(count(html, 'Data Pipeline')).toBe(1);
    expect(count(html, 'UI Presentation')).toBe(1);
    expect(html).toContain('Δ $0');
    expect(html).toContain('capture gap');
    expect(html).toContain('dedup drop');
  });
});

describe('TokenomicsPage (shell route wrapper)', () => {
  it('renders the playground and the back link', () => {
    const html = renderToString(<TokenomicsPage />);
    expect(html).toContain('Tokenomics Playground');
    expect(html).toContain('← back to Ratio');
  });
});

describe('/tokenomics/embed (bare route)', () => {
  it('renders the full playground without any shell chrome', () => {
    const html = renderToString(<EmbedPage />);
    expect(html).toContain('Tokenomics Playground');
    expect(html).toContain('role="meter"');
    // No shell artifacts: no nav, no simulation bar, no agent launcher.
    expect(html).not.toContain('Simulation');
    expect(html).not.toContain('Ask Ratio');
  });
});
