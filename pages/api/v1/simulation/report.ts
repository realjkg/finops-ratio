import { database } from '@/simulation/server/database';
import { sessionFor, simulationRoute } from '@/simulation/server/http';
import { WorkflowError } from '@/simulation/server/workflow';
import { buildReportModel } from '@/executive/reportModel';
import { renderReportPdf } from '@/executive/reportPdf';
import { buildReportWorkbook } from '@/executive/reportXlsx';
export default simulationRoute(['GET'], async (req, res) => {
  const { identity } = sessionFor(req);
  const format = req.query.format ?? 'pdf';
  if (!['pdf', 'xlsx', 'json'].includes(String(format))) throw new WorkflowError(400, 'Choose PDF, XLSX or JSON.');
  const state = database().read(identity.tenant);
  const now = new Date();
  const model = buildReportModel(now, state.workloads, { budgets: state.budgets, alerts: state.alerts, now: new Date(state.asOf) }, { records: state.outcomes, ledger: state.ledger });
  model.periodLabel = `SIMULATED · ${identity.tenant} · June 2026 · revision ${state.revision}`;
  if (format === 'json') { res.status(200).json({ model, outcomes: state.outcomes, ledger: state.ledger, audit: state.audit, revision: state.revision }); return; }
  const data = format === 'pdf' ? await renderReportPdf(now, model) : await buildReportWorkbook(now, model);
  res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ratio-simulated-${identity.tenant}-r${state.revision}.${format}"`);
  res.status(200).send(data);
});
