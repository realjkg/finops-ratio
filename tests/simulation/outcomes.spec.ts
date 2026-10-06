import { test, expect, type Page } from "@playwright/test";
import type { Workspace } from "../../src/simulation/types";
async function login(page: Page, name: string) {
  await page.goto("/simulation");
  await page
    .getByRole("button", { name: `Continue as ${name}`, exact: true })
    .click();
  await expect(
    page.getByText(`Signed in as ${name}`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open customer workflow" }).click();
  await page.getByRole("link", { name: "Measure initiative outcomes" }).click();
  await expect(
    page.getByRole("heading", { name: "Outcome accountability", exact: true }),
  ).toBeVisible();
}
async function state(page: Page): Promise<Workspace> {
  return page.evaluate(async () =>
    (await fetch("/api/v1/simulation/state")).json(),
  );
}
async function save(page: Page, button: string) {
  const before = (await state(page)).revision;
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect
    .poll(async () => (await state(page)).revision)
    .toBeGreaterThan(before);
}
test("owner, baseline, value evidence, full costs and cross-persona business decisions persist", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "Alex");
  const s = await state(page);
  const id = s.workloads[0].id;
  await page
    .getByLabel("Accountable owner", { exact: true })
    .fill("Morgan — customer outcome owner");
  await page.getByLabel("Performance target", { exact: true }).fill("82");
  await save(page, "Save owner and baseline");
  await expect(page.getByRole("button", { name: "Verify baseline evidence", exact: true })).toBeDisabled();
  await page
    .getByLabel("Value measure title", { exact: true })
    .fill("Incremental sales contribution");
  await page
    .getByRole("combobox", { name: "Value evidence status", exact: true })
    .selectOption("measured");
  await page
    .getByLabel("Incremental revenue (USD)", { exact: true })
    .fill("200000");
  await page.getByLabel("Contribution margin (%)", { exact: true }).fill("60");
  await page.getByLabel("AI attribution (%)", { exact: true }).fill("50");
  await page
    .getByLabel("Value evidence reference", { exact: true })
    .fill("Simulation ledger — sales cohort June 1–25");
  await page
    .getByLabel("Attribution or evaluation method", { exact: true })
    .fill(
      "Matched cohort; incremental sales exclude baseline revenue and overlapping claims",
    );
  await save(page, "Save value evidence");
  await expect(
    page.getByRole("button", {
      name: "Verify Incremental sales contribution",
      exact: true,
    }),
  ).toBeDisabled();
  for (const [label, amount] of [
    ["Infrastructure", "500"],
    ["Implementation allocation", "1000"],
    ["Oversight", "250"],
    ["Ongoing labor", "750"],
  ]) {
    await page.getByLabel(`${label} cost (USD)`, { exact: true }).fill(amount);
    await page
      .getByRole("combobox", { name: `${label} status`, exact: true })
      .selectOption("measured");
    await page
      .getByLabel(`${label} evidence`, { exact: true })
      .fill("Simulated invoice / timesheet for June 1–25");
    await save(page, `Save ${label.toLowerCase()} cost`);
    await expect(page.getByRole("button", { name: `Verify ${label.toLowerCase()} cost`, exact: true })).toBeDisabled();
  }
  await page.reload();
  await expect(
    page.getByLabel("Accountable owner", { exact: true }),
  ).toHaveValue("Morgan — customer outcome owner");
  await expect(
    page.getByRole("button", { name: "Record business decision", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "Jordan");
  await save(page, "Verify Incremental sales contribution");
  await expect(
    page.getByText("Verified by Jordan (simulated)", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Record business decision", exact: true })).toBeDisabled();
  await save(page, "Verify baseline evidence");
  for (const label of ["Infrastructure", "Implementation allocation", "Oversight", "Ongoing labor"]) {
    await expect(page.getByRole("button", { name: "Record business decision", exact: true })).toBeDisabled();
    await save(page, `Verify ${label.toLowerCase()} cost`);
  }
  const reviewed = (await state(page)).outcomes[id];
  expect(reviewed.planVerified?.by).toBe("Jordan (simulated)");
  for (const cost of Object.values(reviewed.costs)) expect(cost.verified?.by).toBe("Jordan (simulated)");
  await expect(
    page.getByText("Suggested decision:", { exact: false }),
  ).toContainText("expand");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "Morgan");
  await page
    .getByRole("combobox", { name: "Business decision", exact: true })
    .selectOption("expand");
  await page
    .getByLabel("Decision rationale", { exact: true })
    .fill(
      "Reviewed contribution exceeds our expansion threshold and the performance target is met.",
    );
  await save(page, "Record business decision");
  expect((await state(page)).outcomes[id].decisions.at(-1)?.action).toBe(
    "expand",
  );
  await page
    .getByRole("link", { name: "Reports", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Outcome evidence and full costs",
      exact: true,
    }),
  ).toBeVisible();
  const snapshot = await page.evaluate(async () =>
    (await fetch("/api/v1/simulation/report?format=json")).json(),
  );
  expect(snapshot.model.outcomeReports[0].result.measuredBenefitCents).toBe(
    6000000,
  );
  expect(snapshot.outcomes[id].owner).toBe("Morgan — customer outcome owner");
  await page
    .getByRole("link", { name: "Initiative outcomes", exact: true })
    .click();
  await expect(page).toHaveURL(/\/outcomes$/);
  await page.screenshot({
    path: ".simulation-test-results/outcomes-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "Alex");
  await page
    .getByLabel("Ongoing labor cost (USD)", { exact: true })
    .fill("900");
  await save(page, "Save ongoing labor cost");
  expect((await state(page)).outcomes[id].costs.labor.verified).toBeUndefined();
  await expect(
    page.getByText("Latest decision:", { exact: false }),
  ).toContainText("Needs renewed review");
  expect(errors).toEqual([]);
});
test("mobile baseline entry and nonfinancial evidence do not manufacture a cash return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "Sam");
  await page
    .getByLabel("Value measure title", { exact: true })
    .fill("Lower incident severity");
  await page
    .getByRole("combobox", { name: "Value category", exact: true })
    .selectOption("risk");
  await page
    .getByRole("combobox", { name: "Value evidence status", exact: true })
    .selectOption("measured");
  await page
    .getByLabel("Value evidence reference", { exact: true })
    .fill("Simulated incident comparison");
  await page
    .getByLabel("Attribution or evaluation method", { exact: true })
    .fill("Risk severity score compared with baseline");
  await save(page, "Save value evidence");
  await expect(
    page.getByText("Nonfinancial evidence", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record business decision", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".simulation-test-results/outcomes-mobile.png",
    fullPage: true,
  });
});
