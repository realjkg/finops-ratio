// App store — Zustand. Holds the (mutable) workload/budget/alert state plus UI
// selection, and drives the interactive flows: governance gate sequencing,
// demand-shape changes, threshold edits, alert acknowledgement, and agent chat.

import { create } from 'zustand';
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
import type { AIMessage } from '@/ai';

export type SecondaryMode = 'value' | 'cost' | 'unit';
export type DetailTab = 'budget' | 'models' | 'governance' | 'demand' | 'unit' | 'alerts';

// Wave3b AI chat slice. Distinct from the Phase 1 agent slice above: multi-turn
// history, server-proxied via the AIClient seam (no key in the browser).
export type AIChatRole = 'user' | 'assistant' | 'system';

export interface AIChatMessage {
  id: string;
  role: AIChatRole;
  content: string;
  timestamp: string;
  initiativesReferenced?: string[];
  provider?: 'claude' | 'openai' | 'openllm' | 'mock';
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
        'Ratio AI online. Ask about initiative risk, cost drivers, or savings — every answer is grounded in your live portfolio data.',
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

  toggleGate: (workloadId, gate) =>
    set((state) => ({
      workloads: state.workloads.map((w) => {
        if (w.id !== workloadId) return w;
        const key = GATE_KEY[gate];
        const idx = GATE_ORDER.indexOf(key);
        const turningOn = !w.governance[key];
        // Sequential enforcement: a gate can only turn on if all prior gates are
        // on; turning a gate off cascades to every gate after it.
        if (turningOn) {
          const priorAllPassed = GATE_ORDER.slice(0, idx).every((k) => w.governance[k]);
          if (!priorAllPassed) return w;
        }
        const nextGov = { ...w.governance };
        if (turningOn) {
          nextGov[key] = true;
        } else {
          for (let i = idx; i < GATE_ORDER.length; i += 1) {
            nextGov[GATE_ORDER[i]] = false;
          }
        }
        return { ...w, governance: nextGov };
      }),
    })),

  setDemandShape: (workloadId, shape) =>
    set((state) => ({
      workloads: state.workloads.map((w) => {
        if (w.id !== workloadId) return w;
        // Spec §5.3: Always-On requires all gates; block the change otherwise.
        if (shape === 'always_on' && !allGatesPassed(w)) return w;
        return { ...w, demand_shape: shape };
      }),
    })),

  updateThresholds: (workloadId, thresholds) =>
    set((state) => ({
      budgets: state.budgets.map((b) =>
        b.workload_id === workloadId
          ? {
              ...b,
              soft_threshold_pct: thresholds.soft,
              hard_threshold_pct: thresholds.hard,
              kill_threshold_pct: thresholds.kill,
            }
          : b,
      ),
    })),

  acknowledgeAlert: (alertId) =>
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === alertId ? { ...a, acknowledged: true, acknowledged_by: 'k.user' } : a,
      ),
    })),

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

    try {
      const reply = await aiClient.chat(history, context);
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

