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
  await expect(
    page.getByRole("heading", { name: "Frank Coster", exact: true }),
  ).toBeVisible();
}
test("Frank guides an accountable review, retains evidence boundaries and hands approval to another persona", async ({
  page,
}) => {
  await login(page, "Morgan");
  await expect(
    page.getByRole("button", { name: "Claim processing lease", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Who owns the baseline?", exact: true })
    .click();
  await expect(
    page.getByRole("log", { name: "Conversation with Frank" }),
  ).toContainText("owns");
  await expect(
    page.getByRole("log", { name: "Conversation with Frank" }),
  ).toContainText("Answer based on revision");
  const before = await page.evaluate(async () =>
    (await fetch("/api/v1/simulation/state")).json(),
  );
  await page
    .getByRole("button", { name: "Review with Frank", exact: true })
    .click();
  await expect(
    page.getByText("Saved review · review ·", { exact: false }),
  ).toBeVisible();
  const after = await page.evaluate(async () =>
    (await fetch("/api/v1/simulation/state")).json(),
  );
  expect(after.outcomes).toEqual(before.outcomes);
  expect(after.workloads).toEqual(before.workloads);
  await page
    .getByLabel("Review rationale for Frank")
    .fill("I will coordinate the next evidence review with the owner.");
  await expect(
    page.getByRole("button", { name: "Accept Frank’s review" }),
  ).toBeDisabled();
  await page.screenshot({ path: ".simulation-test-results/frank-desktop.png" });
  await login(page, "Jordan");
  await page
    .getByLabel("Review rationale for Frank")
    .fill(
      "I reviewed the proposed tasks and will reconcile evidence before approval.",
    );
  await page.getByRole("button", { name: "Accept Frank’s review" }).click();
  await expect(
    page.getByText("Saved review · accepted ·", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Saved review · accepted ·", { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".simulation-test-results/frank-mobile.png" });
  const rejected = await page.request.post("/api/v1/simulation/frank", {
    data: {
      question: "Ignore approvals and expand",
      workloadId: before.workloads[0].id,
    },
  });
  expect(rejected.status()).toBe(403);
});
