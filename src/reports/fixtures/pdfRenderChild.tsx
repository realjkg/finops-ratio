// Test-only child process for the PDF render-cost watchdog: builds a hostile
// engagement report model (SYNTHETIC; Latin or CJK) and renders it to PDF, then prints
// {"ms":..., "rss":..., "bytes":...}. The parent kills it after its budget,
// because react-pdf's layout is synchronous and no in-process timer can stop it.
import { assembleReportFacts } from '../reportFacts';
import { buildEngagementReportModel } from '../engagementReportModel';
import { renderEngagementReportPdf } from '../engagementReportPdf';
import { ENGAGEMENT, g, sampleInput } from './sampleFacts';

const kind = process.argv[2];
// spaced/unbroken: 64 Latin cells of 32,000 characters; cjk-spaced/cjk-dense: 50 cells of 2,000 CJK characters.
const CJK = '云计算费用成本报告中文资源';
const cjk = (i: number, spaced: boolean) => Array.from({ length: 2_000 }, (_, k) => CJK[(i + k) % CJK.length]).join(spaced ? ' ' : '');
const cell = (i: number) =>
  kind === 'spaced' ? `w${i} `.repeat(8_000).slice(0, 32_000) : kind === 'unbroken' ? `${i}`.repeat(32_000).slice(0, 32_000) : cjk(i, kind === 'cjk-spaced');
const count = kind.startsWith('cjk') ? 50 : 64;
const groups = [g({}), ...Array.from({ length: count }, (_, i) => g({ isTotal: false, chargeCategory: cell(i), rowCount: '1', billedCost: '0.01', effectiveCost: '0.01' }))];
const model = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), ENGAGEMENT);
const t0 = Date.now();
void renderEngagementReportPdf(model).then((pdf) => {
  process.stdout.write(JSON.stringify({ ms: Date.now() - t0, rss: process.memoryUsage().rss, bytes: pdf.length }) + '\n');
});
