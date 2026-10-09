import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import { executeCommand, seedWorkspace } from "@/simulation/server/workflow";
import { buildReportModel } from "@/executive/reportModel";
import { buildReportWorkbook } from "@/executive/reportXlsx";
import { renderReportPdf } from "@/executive/reportPdf";
it("exports the same baseline, evidence and full-cost model in snapshot appendices", async () => {
  const tech = { tenant: "acme", user: "Alex", persona: "technical" as const };
  const reviewer = { tenant: "acme", user: "Jordan", persona: "procurement" as const };
  let s = seedWorkspace();
  const workloadId = s.workloads[0].id;
  s = executeCommand(s, tech, {
    type: "save-outcome-plan",
    workloadId,
    plan: { ...s.outcomes[workloadId], target: 82 },
  });
  s = executeCommand(s, reviewer, { type: "verify-outcome-plan", workloadId });
  s = executeCommand(s, tech, {
    type: "save-full-cost",
    workloadId,
    category: "infrastructure",
    cost: { cents: 1200, status: "measured", reference: "Invoice fixture" },
  });
  s = executeCommand(s, reviewer, {
    type: "verify-full-cost",
    workloadId,
    category: "infrastructure",
  });
  const now = new Date(s.asOf);
  const model = buildReportModel(
    now,
    s.workloads,
    { budgets: s.budgets, alerts: s.alerts, now },
    { records: s.outcomes, ledger: s.ledger },
  );
  model.periodLabel = "SIMULATED · acme · June 2026";
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await buildReportWorkbook(now, model)) as unknown as ArrayBuffer,
  );
  const column = (sheet: ExcelJS.Worksheet, name: string) => {
    let found = 0;
    sheet.getRow(1).eachCell((cell, index) => {
      if (cell.value === name) found = index;
    });
    expect(found).toBeGreaterThan(0);
    return found;
  };
  const outcomes = book.getWorksheet("Outcomes")!;
  expect(outcomes.getRow(2).getCell(6).value).toBe(70);
  expect(outcomes.getRow(2).getCell(column(outcomes, "Performance recorded by")).value).toBe(tech.user);
  expect(outcomes.getRow(2).getCell(column(outcomes, "Performance verified by")).value).toBe(reviewer.user);
  expect(outcomes.getRow(2).getCell(column(outcomes, "Full cost USD")).value).toBeNull();
  expect(book.getWorksheet("Value Evidence")?.getRow(2).getCell(4).value).toBe(
    "assumed",
  );
  const costs = book.getWorksheet("Full Costs")!;
  // One header row + five cost rows per workload in the seeded workspace.
  expect(costs.rowCount).toBe(s.workloads.length * 5 + 1);
  expect(costs.getRow(3).getCell(column(costs, "Recorded by")).value).toBe(tech.user);
  expect(costs.getRow(3).getCell(column(costs, "Verified by")).value).toBe(reviewer.user);
  expect(book.getWorksheet("Decision History")?.rowCount).toBe(1);
  const pdf = await renderReportPdf(now, model);
  expect(pdf.toString("ascii", 0, 4)).toBe("%PDF");
  // Page tree grows with the seeded portfolio (the initiative table paginates);
  // pin the structural invariant — the outcomes appendix makes it multi-page.
  const pageCount = Number(pdf.toString("latin1").match(/\/Count (\d+)/)?.[1]);
  expect(pageCount).toBeGreaterThanOrEqual(2);
});
