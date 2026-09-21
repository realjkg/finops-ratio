// Live client — talks to the Next.js /api/prediction routes. Mirrors
// LiveTokenomicsClient / LiveCostSourceClient error handling: a typed Error on
// network failure and non-2xx so callers always see a message, never a raw
// fetch rejection.
import type {
  AccuracyReport,
  ChangePrediction,
  PredictionClient,
  ProposedChange,
} from './PredictionClient';
import { withBasePath } from '@/lib/basePath';

const PREDICT_URL = withBasePath('/api/prediction/predict');
const ACCURACY_URL = withBasePath('/api/prediction/accuracy');

export class LivePredictionClient implements PredictionClient {
  readonly mode = 'live' as const;

  async predictChange(change: ProposedChange): Promise<ChangePrediction> {
    let res: Response;
    try {
      res = await fetch(PREDICT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
    } catch (err) {
      throw new Error(
        `Prediction API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      throw new Error(`Prediction API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ChangePrediction;
  }

  async getAccuracyReport(): Promise<AccuracyReport> {
    let res: Response;
    try {
      res = await fetch(ACCURACY_URL);
    } catch (err) {
      throw new Error(
        `Accuracy API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      throw new Error(`Accuracy API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as AccuracyReport;
  }
}

