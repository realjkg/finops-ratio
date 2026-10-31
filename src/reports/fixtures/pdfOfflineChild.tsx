// Test-only child process for the offline check (pdfFonts.test.ts): every network
// entry point is trapped BEFORE the PDF stack loads; then a SYNTHETIC CJK-heavy
// report is rendered. Prints {"trapped","attempts","dataUrlFetches","bytes"}.
import { attempts, dataUrlFetches, trapped } from './netTrap';

const main = async () => {
  const { assembleReportFacts } = await import('../reportFacts');
  const { buildEngagementReportModel } = await import('../engagementReportModel');
  const { renderEngagementReportPdf } = await import('../engagementReportPdf');
  const { ENGAGEMENT, g, sampleInput } = await import('./sampleFacts');
  const groups = [g({}), ...['成本报告', 'コスト', '비용', 'Москва'].map((c) => g({ isTotal: false, chargeCategory: c.repeat(20), rowCount: '1' }))];
  const pdf = await renderEngagementReportPdf(buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), { ...ENGAGEMENT, displayName: '成本报告 コスト 비용' }));
  process.stdout.write(JSON.stringify({ trapped, attempts, dataUrlFetches: dataUrlFetches.length, bytes: pdf.length }) + '\n');
};
void main();
