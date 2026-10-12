// Intent parsing: ordered keyword rules over the lowercased, length-capped
// question. First match wins; the order below is the contract (tests pin it).
// The five legacy intents keep their original substring regexes verbatim and
// are tried LAST, so an old question without any new cue still lands on the
// same answer byte for byte.

export type Intent =
  | 'migration'
  | 'ebitda'
  | 'capability'
  | 'outcomes'
  | 'alerts'
  | 'tokens'
  | 'team_rank'
  | 'workloads'
  | 'roi'
  | 'forecast'
  | 'savings'
  | 'cost_driver'
  | 'legacy';

const RX = {
  migration:
    /\b(?:migrat\w*|self[- ]?host\w*|on[- ]?prem\w*|payback|pay back|break[- ]?even|gpus?|cost to realized|cost to realised|realized savings|realised savings)\b|private(?:ly)?[- ](?:open[- ]?(?:source|weights?)?[- ]?)?(?:model|llm|deployment|hosting)|open[- ](?:source|weights?)\b|open model|public api|api provider/,
  ebitda: /\bebitda\b|\boperating (?:income|margin|profit)\b|\bmargin points?\b|\bprofit\w*/,
  capability:
    /what (?:can|could|all) (?:you|frank) (?:answer|do|tell|help)|what (?:questions|kinds? of questions)|how (?:deep|far|detailed|in[- ]depth)|capabilit|what do you (?:know|support|cover)|drill[- ]?down (?:levels?|options?)|\bladder\b/,
  outcomes: /\boutcomes?\b|\bevidence\b|\bmeasured\b|\brealized\b|\brealised\b/,
  alerts: /\balerts?\b|\bwarnings?\b|\banomal\w+/,
  tokens: /\btokens?\b|\bcache\b|\bcach\w+\b|\bunit cost\w*\b|\bper (?:call|request|1m|million)\b|\bprice\b|\bpricing\b/,
  workloads: /\bworkloads?\b|\bactivit\w+\b|\bbreak ?downs?\b|\bdrill\w*\b|\bdetails?\b/,
  // Only meaningful once a subject is known (entity named or remembered).
  entityLens: /\bmodels?\b|\bbudgets?\b|\btrends?\b|\bowners?\b|\bstatus\b/,
  roi: /\broi\b|return on|value ratio|\breturns?\b|worth it|\bvalue\b|pay(?:s|ing)? off/,
  teamWord: /\b(?:teams?|groups?|departments?|dept|orgs?|business units?)\b/,
  rankCue: /\b(?:which|who|what|rank\w*|top|highest|lowest|best|worst|most|least|biggest|largest|smallest|weakest|strongest|each|every|per|by)\b/,
  eachCue: /\b(?:each|every|per|all|by)\s+(?:team|group|department)s?\b|\bteams? (?:ranked|ranking)\b|\bby team\b/,
  forecast: /next (?:quarter|month|year|week)|\bforecast(?:ing|s)?\b|\bpredict\w*|\bwill (?:our|the|we|spend|cost)\b|\bgoing to (?:cost|spend)\b/,
  nextPeriod: /next (?:quarter|month|year|week)/,
  predictWord: /\bpredict\w*|\bforecast(?:ing|s)?\b/,
  savings: /\bsav\w*|\bopportunit\w*|\breduc\w*|\bcuts?\b|\bwaste\w*|\boptimi[sz]\w*/,
  costWord: /cost|spend|expens|driv|spike|budget/,
} as const;

// Legacy regexes, verbatim from the original MockAIClient (substring matches).
const LEGACY = {
  at_risk: /(risk|approval|pending|caution)/,
  cost_driver: /(cost|driv|expensive|spike|spend)/,
  savings: /(sav|opportunit|reduc|cut)/,
  summary: /(summar|overview|report|portfolio)/,
} as const;

type Metric = 'cost' | 'roi' | 'savings';

export interface Ranking {
  metric: Metric;
  /** true = worst/lowest first (weakest ROI, lowest cost). */
  ascending: boolean;
}

export function rankingOf(lower: string): Ranking {
  const ascending = /\b(?:lowest|worst|weakest|poorest|least|smallest|cheapest|bottom)\b/.test(lower);
  let metric: Metric = 'cost';
  if (RX.savings.test(lower)) metric = 'savings';
  else if (/\broi\b|\breturns?\b|\bvalue\b/.test(lower)) metric = 'roi';
  else if (/\b(?:best|worst|weakest|strongest|poorest)\b/.test(lower) && !/\b(?:cost|spend)/.test(lower)) metric = 'roi';
  return { metric, ascending };
}

interface Cues {
  hasEntity: boolean;
  /** An explicit team is named (not merely the word "team"). */
  namesTeam: boolean;
  /** The question points back at the conversation (pronoun, typed reference, or ellipsis). */
  backRef: boolean;
}

/** First matching intent in contract order. `legacy` = no new cue matched. */
export function classifyIntent(lower: string, c: Cues): Intent {
  // Explicit prediction wording refuses even with a valid scope ("predict Legal EBITDA next quarter").
  if (/\bpredict\w*/.test(lower) || (RX.predictWord.test(lower) && RX.nextPeriod.test(lower))) return 'forecast';
  if (!c.hasEntity && RX.forecast.test(lower)) {
    // Finance questions legitimately say "next year"; only explicit prediction words refuse them.
    const financial = RX.migration.test(lower) || RX.ebitda.test(lower);
    if (!financial || RX.predictWord.test(lower)) return 'forecast';
  }
  if (RX.migration.test(lower)) return 'migration';
  if (RX.ebitda.test(lower)) return 'ebitda';
  if (RX.capability.test(lower)) return 'capability';
  if (RX.outcomes.test(lower)) return 'outcomes';
  if (RX.alerts.test(lower)) return 'alerts';
  if (RX.tokens.test(lower)) return 'tokens';
  const asksWhichTeam =
    (RX.teamWord.test(lower) || /\bwho\b/.test(lower)) &&
    (RX.rankCue.test(lower) || RX.eachCue.test(lower)) &&
    !c.namesTeam &&
    !c.backRef &&
    (RX.roi.test(lower) || RX.costWord.test(lower) || RX.savings.test(lower) || /\b(?:best|worst|weakest|strongest|highest|lowest|rank\w*)\b/.test(lower));
  if (asksWhichTeam) return 'team_rank';
  if (RX.workloads.test(lower) || ((c.hasEntity || c.backRef) && RX.entityLens.test(lower))) return 'workloads';
  if (RX.roi.test(lower)) return 'roi';
  if (c.hasEntity || c.backRef) {
    if (RX.savings.test(lower)) return 'savings';
    if (RX.costWord.test(lower) && !LEGACY.at_risk.test(lower)) return 'cost_driver';
  }
  return 'legacy';
}

/** The original classify(), unchanged. */
type LegacyIntent = 'at_risk' | 'cost_driver' | 'savings' | 'summary' | 'help';
export function classifyLegacy(query: string): LegacyIntent {
  const q = query.toLowerCase();
  if (LEGACY.at_risk.test(q)) return 'at_risk';
  if (LEGACY.cost_driver.test(q)) return 'cost_driver';
  if (LEGACY.savings.test(q)) return 'savings';
  if (LEGACY.summary.test(q)) return 'summary';
  return 'help';
}
