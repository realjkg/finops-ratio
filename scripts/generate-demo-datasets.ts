// Writes the committed SYNTHETIC FOCUS 1.0 demo datasets (public cloud, private cloud, on-premise
// API connections) to src/demo/apiDatasets/data/ from src/ingest/fixtures/demoApiDatasets.ts.
//
//   npx tsx scripts/generate-demo-datasets.ts
//
// Deterministic: re-running produces identical files. A test (demoApiDatasets.test.ts) fails if
// the committed files drift from the generator. One row per line keeps diffs reviewable.
import fs from 'fs';
import path from 'path';
import { GENERATORS, serializeDataset } from '../src/ingest/fixtures/demoApiDatasets';

const OUT = path.resolve(__dirname, '..', 'src', 'demo', 'apiDatasets', 'data');
fs.mkdirSync(OUT, { recursive: true });
for (const [id, generate] of Object.entries(GENERATORS)) fs.writeFileSync(path.join(OUT, `${id}.json`), serializeDataset(generate()));
