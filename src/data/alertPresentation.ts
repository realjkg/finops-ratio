// Display wording for alerts. The seeded alert messages are values in the public API contract
// (src/compat/golden/api.json), so they are never edited in place. Where the contract wording uses
// a retired term, this table (keyed by the stable alert id, never by matching message text) gives
// the display text. Anything not listed shows the contract message unchanged.

import type { Alert } from '@/types';
import { formatRatio } from '@/lib/format';

const BY_ID: Record<string, (a: Alert) => string> = {
  'al-002': (a) =>
    `Value / cost fell to ${formatRatio(a.actual_value)}: counted value is negative after the quality floor and harm subtraction. Critical value review, not a cost-side fix.`,
};

export function alertMessage(alert: Alert): string {
  return BY_ID[alert.id]?.(alert) ?? alert.message;
}
