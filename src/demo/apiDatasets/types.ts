// Shapes of the synthetic FOCUS 1.0 demo datasets (the committed JSON under ./data). Types only.

export type ConnectionType = 'public_cloud' | 'private_cloud' | 'on_premise';

export interface CurrencyTotals { rows: number; billed: string; effective: string; naBilled: number; naEffective: number }
export interface DatasetMeta {
  id: string;
  name: string;
  connectionType: ConnectionType;
  apiStyle: string;
  provider: string;
  currency: string;
  /** A fixed, simulated time: this is a fixture, nothing ran. */
  lastImport: string;
  billingPeriod: string;
  rowCount: number;
  controlTotals: Record<string, CurrencyTotals>;
  /** Why a column is empty in this dataset (an empty cell is N/A, never 0). */
  naReasons: Record<string, string>;
  /** Why BilledCost is a true zero (not missing) on some rows. */
  zeroBilledReason?: string;
  synthetic: true;
}
export interface Dataset { meta: DatasetMeta; columns: string[]; rows: string[][] }
