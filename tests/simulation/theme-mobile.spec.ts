import { expect, test } from '@playwright/test';

// The theme switcher sits in the shared top bar: at phone widths it must not widen
// the page, clip a control, or push the agent launcher off screen, and it must
// still switch themes from the keyboard.
for (const width of [320, 390, 430]) {
  test(`theme switcher fits the top bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const route of ['/', '/overview', '/workloads']) {
      await page.goto(route);
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav.getByRole('button', { name: 'Ask Frank Coster' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
      for (const control of await nav.locator('button:visible, select:visible').all()) {
        const box = await control.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width, `${route} ${await control.textContent()}`).toBe(true);
        expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), await control.textContent() ?? '').toBe(true);
      }
    }
    const toggle = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Appearance', exact: true });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.locator('#theme-editor label', { hasText: /^High contrast$/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
