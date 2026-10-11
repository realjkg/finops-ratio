// Public API of src/detection: pure, deterministic fleet forecasting, anomaly
// detection, lifecycle and budget evaluation (RFQ checklist Step 2, items 2.1
// to 2.4). Nothing here performs I/O, reads a clock or uses randomness; callers
// pass data and explicit UTC as-of days. See README.md for caps and known gaps.

export { buildDailySeries } from './series';
export type { BuildSeriesOptions, BuildSeriesResult, BuildSeriesStats, CostRowInput } from './series';

export { backtestSeries, forecastFleet, forecastSeries } from './forecast';
export type {
  BacktestAggregate,
  BacktestOptions,
  BacktestOrigin,
  BacktestResult,
  FleetForecast,
  FleetGroupForecast,
  ForecastOptions,
  ForecastPoint,
  ForecastReason,
  GapPolicy,
  MonthEndProjection,
  SeriesForecast,
} from './forecast';

export { detectAnomalies } from './anomaly';
export type {
  AnomalyCategory,
  AnomalyConfig,
  AnomalyResult,
  AnomalyStats,
  CandidateSource,
  Contributor,
  Finding,
  FindingScope,
} from './anomaly';

export { DEFAULT_MIN_IMPACT, FLOORS, classifySeverity, resolveConfig } from './severity';
export type { ResolvedConfig, SeverityInput } from './severity';

export { reduceFindings } from './lifecycle';
export type {
  FindingRecord,
  LifecycleEvent,
  LifecycleEventType,
  LifecycleOptions,
  LifecycleResult,
  RecordStatus,
  ResolveReason,
} from './lifecycle';

export { DEFAULT_THRESHOLDS, evaluateBudgetThresholds, evaluateForecastBreach } from './budget';
export type {
  Budget,
  BudgetAlertType,
  BudgetEvaluation,
  BudgetLevel,
  BudgetPeriod,
  BudgetThresholds,
  BreachForecastInput,
  ForecastBreachEvaluation,
  ForecastBreachStatus,
  MonthlyBudget,
  Spend,
  ThresholdCrossing,
} from './budget';

export { addDays, daysInMonth, formatDay, isLeapYear, lastCompleteDay, parseDay } from './dates';
export { DetectionError, LIMITS } from './types';
export type { CostField, DailySeries, DetectionErrorCode, Severity, SeriesKey } from './types';
