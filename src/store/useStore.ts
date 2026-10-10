// App store — Zustand. Holds the (mutable) workload/budget/alert state plus UI
// selection, and drives the interactive flows: governance gate sequencing,
// demand-shape changes, threshold edits, alert acknowledgement, and agent chat.

import { create } from 'zustand';
import type { Command, SimSession, Workspace } from '@/simulation/types';
import { simulationRequest, SimulationHttpError } from '@/simulation/client';
import type { CostSourceClient } from '@/costsource';
import type {
  ConnectorBusyPhase,
  ConnectorSession,
  IngestRun,
} from '@/connectors/ingestLanding';
import { currentMonthWindow, FOCUS_DOOR_WALK_ID } from '@/connectors/ingestLanding';
import type {
  Alert,
  BudgetProfile,
  DemandShape,
  GovernanceGateId,
  ModelEntry,
  Workload,
} from '@/types';
import { WORKLOADS, DEMO_NOW } from '@/data/workloads';
import { BUDGET_PROFILES } from '@/data/budgets';
import { ALERTS } from '@/data/alerts';
import { MODEL_REGISTRY } from '@/data/models';
import { allGatesPassed } from '@/lib/derive';
import { buildAIContext, createAIClient } from '@/ai';
import type { AIMessage, AIProvider } from '@/ai';

export type SecondaryMode = 'value' | 'cost' | 'unit';
export type DetailTab = 'budget' | 'models' | 'governance' | 'demand' | 'unit' | 'alerts' | 'outcomes';

// Wave3b AI chat slice. Distinct from the Phase 1 agent slice above: multi-turn
// history, server-proxied via the AIClient seam (no key in the browser).
export type AIChatRole = 'user' | 'assistant' | 'system';

export interface AIChatMessage {
  id: string;
  role: AIChatRole;
  content: string;
  timestamp: string;
  initiativesReferenced?: string[];
  provider?: AIProvider;
}

export interface Filters {
  team: string;
  provider: string;
  environment: string;
}

// Gate keys in their enforced order (spec §5.1).
// Narrowly typed to the boolean governance fields only — excludes the string
// fields (last_reviewed, approved_by) so indexed boolean assignment is safe.
type GateKey = 'policy_check' | 'ethics_review' | 'cost_approval' | 'scale_authorized';

const GATE_ORDER: GateKey[] = [
  'policy_check',
  'ethics_review',
  'cost_approval',
  'scale_authorized',
];

const GATE_KEY: Record<GovernanceGateId, GateKey> = {
  policy: 'policy_check',
  ethics: 'ethics_review',
  cost: 'cost_approval',
  scale: 'scale_authorized',
};

// NEXT_PUBLIC_AI_MODE is a routing flag (mock | live), NOT a credential. Live
// mode proxies /api/ai/chat; the LLM key stays server-side. Default is mock so
// the app runs fully offline with no keys.
const aiClient = createAIClient(
  process.env.NEXT_PUBLIC_AI_MODE === 'live' ? 'live' : 'mock',
);

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `msg-${messageSeq}`;
}

interface AppState {
  simulation: { session: SimSession; state: Workspace } | null;
  simulationBusy: boolean;
  simulationError: string | null;
  loadSimulation: (session: SimSession, state: Workspace) => void;
  clearSimulation: () => void;
  simulationCommand: (command: Command) => Promise<void>;

  // Connector walk (connectors E2E demo): per-source session state + the
  // ingest runs whose data has landed in the connected surfaces. Sessions are
  // demo-walk state only — registry status stays the env-derived truth.
  connectorSessions: Record<string, ConnectorSession>;
  ingestRuns: Record<string, IngestRun>;
  connectorBusy: { sourceId: string; phase: ConnectorBusyPhase } | null;
  /** Health-probe connect for seam adapters: open iff reachable && authed. */
  connectConnector: (sourceId: string, client: CostSourceClient) => Promise<void>;
  /** Immediate open for the direct-ingest door — no external dependency to probe. */
  openConnectorSession: (sourceId: string) => void;
  /** Ingest through the seam: fetchCostRows + fetchFindings, run lands or error. */
  runConnectorIngest: (
    sourceId: string,
    sourceName: string,
    client: CostSourceClient,
  ) => Promise<void>;
  /** Landed run for the direct-ingest door (pre-computed by FocusFileAdapter). */
  recordDirectIngest: (walkId: string, run: IngestRun) => void;
  /** Close the session and withdraw its landed data — clean disconnect. */
  disconnectConnector: (sourceId: string) => void;
  now: Date;
  workloads: Workload[];
  budgets: BudgetProfile[];
  alerts: Alert[];
  models: ModelEntry[];

  selectedId: string;
  activeTab: DetailTab;
  secondaryMode: SecondaryMode;
  filters: Filters;

  aiMessages: AIChatMessage[];
  aiThinking: boolean;
  aiMode: 'mock' | 'live';
  aiPanelOpen: boolean;

  select: (id: string) => void;
  setTab: (tab: DetailTab) => void;
  setSecondaryMode: (mode: SecondaryMode) => void;
  setFilter: (key: keyof Filters, value: string) => void;
  resetFilters: () => void;

  toggleGate: (workloadId: string, gate: GovernanceGateId) => void;
  setDemandShape: (workloadId: string, shape: DemandShape) => void;
  updateThresholds: (
    workloadId: string,
    thresholds: { soft: number; hard: number; kill: number },
  ) => void;
  acknowledgeAlert: (alertId: string) => void;

  sendAIMessage: (content: string) => Promise<void>;
  toggleAIPanel: () => void;
}

export const useStore = create<AppState>((set, get) => ({
  simulation: null,
  simulationBusy: false,
  simulationError: null,
  connectorSessions: {},
  ingestRuns: {},
  connectorBusy: null,
  loadSimulation: (session, state) => set({ simulation: { session, state }, workloads: state.workloads, budgets: state.budgets, alerts: state.alerts, now: new Date(state.asOf), simulationError: null, connectorSessions: {}, ingestRuns: {}, connectorBusy: null }),
  clearSimulation: () => set({ simulation: null, simulationBusy: false, simulationError: null, workloads: structuredClone(WORKLOADS), budgets: structuredClone(BUDGET_PROFILES), alerts: structuredClone(ALERTS), now: DEMO_NOW, aiMessages: [], aiThinking: false, aiPanelOpen: false, connectorSessions: {}, ingestRuns: {}, connectorBusy: null }),
  simulationCommand: async (command) => {
    const current = get().simulation;
    if (!current || get().simulationBusy) return;
    set({ simulationBusy: true, simulationError: null });
    try {
      const state = await simulationRequest<Workspace>('command', { command, revision: current.state.revision, id: crypto.randomUUID() }, current.session.csrf);
      if (get().simulation?.session.csrf === current.session.csrf) get().loadSimulation(current.session, state);
    } catch (error) {
      if (get().simulation?.session.csrf === current.session.csrf) {
        if (error instanceof SimulationHttpError && error.status === 401) get().clearSimulation();
        set({ simulationError: error instanceof Error ? error.message : 'Save failed. Your changes have not been saved.' });
      }
    } finally { if (get().simulation?.session.csrf === current.session.csrf) set({ simulationBusy: false }); }
  },

  // -- Connector walk -------------------------------------------------------
  // Connect runs the seam's own health probe; success iff reachable && authed.
  // The seam's failure detail is stored verbatim — the demo shows the honest
  // reason (ships dark, missing env, auth required), never a friendlier gloss.
  connectConnector: async (sourceId, client) => {
    if (get().connectorBusy) return;
    set({ connectorBusy: { sourceId, phase: 'connecting' } });
    const openedAt = new Date().toISOString();
    try {
      const health = await client.healthCheck(sourceId);
      const session: ConnectorSession =
        health.reachable && health.authed
          ? { state: 'open', openedAt }
          : { state: 'error', error: health.detail, openedAt };
      set((state) => ({ connectorSessions: { ...state.connectorSessions, [sourceId]: session } }));
    } catch (err) {
      set((state) => ({
        connectorSessions: {
          ...state.connectorSessions,
          [sourceId]: {
            state: 'error',
            error: err instanceof Error ? err.message : String(err),
            openedAt,
          },
        },
      }));
    } finally {
      set({ connectorBusy: null });
    }
  },

  openConnectorSession: (sourceId) => {
    set((state) => ({
      connectorSessions: {
        ...state.connectorSessions,
        [sourceId]: { state: 'open', openedAt: new Date().toISOString() },
      },
    }));
  },

  runConnectorIngest: async (sourceId, sourceName, client) => {
    if (get().connectorBusy) return;
    const session = get().connectorSessions[sourceId];
    if (!session || session.state !== 'open') return; // ingest requires an open session
    set({ connectorBusy: { sourceId, phase: 'ingesting' } });
    try {
      const result = await client.fetchCostRows(sourceId, currentMonthWindow());
      const findings = await client.fetchFindings(sourceId);
      const run: IngestRun = {
        sourceId,
        sourceName,
        at: new Date().toISOString(),
        result,
        findings,
      };
      set((state) => ({
        ingestRuns: { ...state.ingestRuns, [sourceId]: run },
        connectorSessions: { ...state.connectorSessions, [sourceId]: { state: 'open', openedAt: session.openedAt } },
      }));
    } catch (err) {
      // Landed data stays put when a re-ingest fails; the session carries the
      // seam's error verbatim so the demo can show the honest failure.
      set((state) => ({
        connectorSessions: {
          ...state.connectorSessions,
          [sourceId]: {
            state: 'error',
            error: err instanceof Error ? err.message : String(err),
            openedAt: session.openedAt,
          },
        },
      }));
    } finally {
      set({ connectorBusy: null });
    }
  },

  recordDirectIngest: (walkId, run) => {
    if (walkId !== FOCUS_DOOR_WALK_ID) return; // only the door may record direct ingests
    set((state) => ({
      ingestRuns: { ...state.ingestRuns, [walkId]: run },
      connectorSessions: {
        ...state.connectorSessions,
        [walkId]: { state: 'open', openedAt: state.connectorSessions[walkId]?.openedAt ?? run.at },
      },
    }));
  },

  disconnectConnector: (sourceId) => {
    set((state) => {
      const sessions = { ...state.connectorSessions };
      const runs = { ...state.ingestRuns };
      delete sessions[sourceId];
      delete runs[sourceId];
      return { connectorSessions: sessions, ingestRuns: runs };
    });
  },

  now: DEMO_NOW,
  workloads: WORKLOADS,
  budgets: BUDGET_PROFILES,
  alerts: ALERTS,
  models: MODEL_REGISTRY,

  selectedId: WORKLOADS[0]?.id ?? '',
  activeTab: 'budget',
  secondaryMode: 'value',
  filters: { team: 'all', provider: 'all', environment: 'all' },

  aiMessages: [
    {
      id: nextMessageId(),
      role: 'system',
      content:
        'Ask about initiative risk, cost drivers, or projected savings. This demo uses simulated portfolio data.',
      timestamp: DEMO_NOW.toISOString(),
    },
  ],
  aiThinking: false,
  aiMode: aiClient.mode,
  aiPanelOpen: false,

  select: (id) => set({ selectedId: id }),
  setTab: (tab) => set({ activeTab: tab }),
  setSecondaryMode: (mode) => set({ secondaryMode: mode }),
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () => set({ filters: { team: 'all', provider: 'all', environment: 'all' } }),

  toggleGate: (workloadId, gate) => {
    if (get().simulation) { void get().simulationCommand({ type: 'gate', workloadId, gate }); return; }
    set((state) => ({ workloads: state.workloads.map(w => {
      if (w.id !== workloadId) return w;
      const key = GATE_KEY[gate], idx = GATE_ORDER.indexOf(key), turningOn = !w.governance[key];
      if (turningOn && !GATE_ORDER.slice(0, idx).every(k => w.governance[k])) return w;
      const governance = { ...w.governance };
      if (turningOn) governance[key] = true;
      else GATE_ORDER.slice(idx).forEach(k => { governance[k] = false; });
      return { ...w, governance };
    }) }));
  },
  setDemandShape: (workloadId, shape) => {
    if (get().simulation) { void get().simulationCommand({ type: 'shape', workloadId, shape }); return; }
    set(state => ({ workloads: state.workloads.map(w => w.id !== workloadId || (shape === 'always_on' && !allGatesPassed(w)) ? w : { ...w, demand_shape: shape }) }));
  },
  updateThresholds: (workloadId, thresholds) => {
    if (get().simulation) { void get().simulationCommand({ type: 'thresholds', workloadId, ...thresholds }); return; }
    set(state => ({ budgets: state.budgets.map(b => b.workload_id !== workloadId ? b : { ...b, soft_threshold_pct: thresholds.soft, hard_threshold_pct: thresholds.hard, kill_threshold_pct: thresholds.kill }) }));
  },
  acknowledgeAlert: (alertId) => {
    if (get().simulation) { void get().simulationCommand({ type: 'acknowledge-alert', alertId }); return; }
    set(state => ({ alerts: state.alerts.map(a => a.id === alertId ? { ...a, acknowledged: true, acknowledged_by: 'demo-user' } : a) }));
  },

  sendAIMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const { workloads, selectedId, now, aiMessages } = get();

    const userMessage: AIChatMessage = {
      id: nextMessageId(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    set((state) => ({ aiMessages: [...state.aiMessages, userMessage], aiThinking: true }));

    // Wire history: prior user/assistant turns + this one. System messages (the
    // welcome line and any inline errors) are dropped — the route builds and
    // prepends its own system prompt from the context.
    const history: AIMessage[] = [...aiMessages, userMessage]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    const context = buildAIContext(workloads, selectedId || null, now);

    const sim = get().simulation;
    try {
      const reply = sim
        ? await simulationRequest<import('@/ai/AIClient').AIResponse>('chat', { message: trimmed, workloadId: selectedId }, sim.session.csrf)
        : await aiClient.chat(history, context);
      if (get().simulation?.session.csrf !== sim?.session.csrf) return;
      const assistantMessage: AIChatMessage = {
        id: nextMessageId(),
        role: 'assistant',
        content: reply.message.content,
        timestamp: new Date().toISOString(),
        initiativesReferenced: reply.initiativesReferenced,
        provider: reply.provider,
      };
      set((state) => ({
        aiMessages: [...state.aiMessages, assistantMessage],
        aiThinking: false,
      }));
    } catch (error) {
      if (get().simulation?.session.csrf !== sim?.session.csrf) return;
      // Never swallow the failure — surface it inline so the user can retry.
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorMessage: AIChatMessage = {
        id: nextMessageId(),
        role: 'system',
        content: `AI error: ${message}`,
        timestamp: new Date().toISOString(),
      };
      set((state) => ({
        aiMessages: [...state.aiMessages, errorMessage],
        aiThinking: false,
      }));
    }
  },

  toggleAIPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
}));

