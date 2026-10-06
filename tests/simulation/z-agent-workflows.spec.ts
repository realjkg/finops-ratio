import { expect, test, type Page } from "@playwright/test";
async function login(page: Page, name: string) {
  await page.goto("/simulation");
  await page
    .getByRole("button", { name: `Continue as ${name}`, exact: true })
    .click();
  await expect(
    page.getByText(`Signed in as ${name}`, { exact: false }),
  ).toBeVisible();
  await page.goto("/agent-workflows");
  await page.getByText("Operational controls", { exact: true }).click();
}
test("embedded reviews recover interruptions and require independent human review", async ({
  page,
}) => {
  await login(page, "Sam");
  await page
    .getByRole("button", { name: "Queue outcome review", exact: true })
    .click();
  await expect(page.getByText("Status: queued · Attempt 0/3")).toBeVisible();
  await page
    .getByRole("button", { name: "Claim processing lease", exact: true })
    .click();
  await expect(page.getByText("Status: running · Attempt 1/3")).toBeVisible();
  await page
    .getByRole("button", { name: "Simulate interruption", exact: true })
    .click();
  await expect(page.getByText("Status: failed · Attempt 1/3")).toBeVisible();
  await page.reload();
  await page.getByText("Operational controls", { exact: true }).click();
  await page.getByRole("button", { name: "Retry review", exact: true }).click();
  await page
    .getByRole("button", { name: "Claim processing lease", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Process review", exact: true })
    .click();
  await expect(page.getByText("Status: review · Attempt 2/3")).toBeVisible();
  await page
    .getByLabel("Proposal review rationale")
    .fill(
      "Resolve missing costs and evidence before making a business decision.",
    );
  await expect(
    page.getByRole("button", { name: "Accept proposal review" }),
  ).toBeDisabled();
  await login(page, "Taylor");
  await page
    .getByLabel("Proposal review rationale")
    .fill(
      "Route the evidence tasks to finance and engineering for reconciliation.",
    );
  await page.getByRole("button", { name: "Accept proposal review" }).click();
  await expect(page.getByText("Status: accepted · Attempt 2/3")).toBeVisible();
  await page.reload();
  await page.getByText("Operational controls", { exact: true }).click();
  await expect(page.getByText("Status: accepted · Attempt 2/3")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".simulation-test-results/agent-workflows-mobile.png" });
  const ops = await page.request.get("/api/v1/simulation/operations");
  expect(ops.status()).toBe(200);
  expect(await ops.json()).toMatchObject({
    databaseReady: true,
    queue: { accepted: 1 },
    externalActions: 0,
  });
  await login(page, "Morgan");
  await expect(page.getByText("No agent reviews yet.")).toBeVisible();
});
