// Test-only child process for the PDF render-cost watchdog: builds a hostile
// engagement report model (SYNTHETIC) and renders it to PDF, then prints
// {"ms":..., "rss":..., "bytes":...}. The parent kills it after its budget,
// because react-pdf's layout is synchronous and no in-process timer can stop it.
import { assembleReportFacts } from '../reportFacts';
import { buildEngagementReportModel } from '../engagementReportModel';
import { renderEngagementReportPdf } from '../engagementReportPdf';
import { ENGAGEMENT, g, sampleInput } from './sampleFacts';

const kind = process.argv[2];
const cell = (i: number) => (kind === 'spaced' ? `w${i} `.repeat(8_000).slice(0, 32_000) : `${i}`.repeat(32_000).slice(0, 32_000));
const groups = [g({}), ...Array.from({ length: 64 }, (_, i) => g({ isTotal: false, chargeCategory: cell(i), rowCount: '1', billedCost: '0.01', effectiveCost: '0.01' }))];
const model = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), ENGAGEMENT);
const t0 = Date.now();
void renderEngagementReportPdf(model).then((pdf) => {
  process.stdout.write(JSON.stringify({ ms: Date.now() - t0, rss: process.memoryUsage().rss, bytes: pdf.length }) + '\n');
});
