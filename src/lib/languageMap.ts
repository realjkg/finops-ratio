// Language map (Ratio v2 Wave 2a). The same engine numbers, projected through a
// persona-specific vocabulary — "one source of truth, persona-projected". Each
// persona reads the identical data through a different lens; only the words
// change, never the math. `useLanguage()` returns the active persona's map.

import { VOCAB } from './vocabulary';
import type { Persona } from './persona';
import { usePersona } from './persona';

export interface LanguageMap {
  boardTitle: string;
  itemLabel: string;
  fuelLabel: string;
  trajectoryLabel: string;
  gateLabel: string;
  adjustmentLabel: string;
  valueRatioLabel: string;
}

export const LANGUAGE_MAP: Record<Persona, LanguageMap> = {
  executive: {
    boardTitle: 'Initiative Dashboard',
    itemLabel: 'Initiative',
    fuelLabel: VOCAB.budgetUsed.label,
    trajectoryLabel: 'Forecast',
    gateLabel: 'Approval Required',
    adjustmentLabel: 'Proposed change',
    valueRatioLabel: 'Value / cost',
  },
  technical: {
    boardTitle: 'Mission Board',
    itemLabel: 'Mission',
    fuelLabel: 'Fuel',
    trajectoryLabel: 'Trajectory',
    gateLabel: 'Gate',
    adjustmentLabel: 'Proposed adjustment',
    valueRatioLabel: 'Value / cost',
  },
  procurement: {
    boardTitle: 'Spend Overview',
    itemLabel: 'Cost Center',
    fuelLabel: 'Budget',
    trajectoryLabel: 'Projected savings',
    gateLabel: 'Pending Sign-off',
    adjustmentLabel: 'Savings opportunity',
    valueRatioLabel: 'Value / cost',
  },
};

export function languageFor(persona: Persona): LanguageMap {
  return LANGUAGE_MAP[persona];
}

// Hook: the vocabulary for the currently active persona.
export function useLanguage(): LanguageMap {
  const { persona } = usePersona();
  return LANGUAGE_MAP[persona];
}

