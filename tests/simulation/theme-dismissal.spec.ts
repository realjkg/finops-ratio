import { expect, test } from '@playwright/test';
for (const width of [390, 1440]) {
  test(`theme editor saves and dismisses without losing the selected theme at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/');
    const opener = page.getByRole('button', { name: width < 768 ? 'Appearance' : 'Preview', exact: true });
    await opener.click();
    const editor = page.getByRole('region', { name: 'Theme editor' });
    await editor.locator('label', { hasText: /^Light$/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // Custom themes live behind the closed Developer disclosure.
    await expect(editor.locator('details')).not.toHaveAttribute('open', '');
    await editor.getByText('Developer: contrast audit', { exact: true }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('brownstone');
    await editor.getByRole('button', { name: 'Save and apply', exact: true }).click();
    await expect(page.getByText('Saved and applied brownstone.', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'brownstone');
    await editor.getByRole('button', { name: 'Close theme editor', exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); await page.getByRole('navigation', { name: 'Main navigation' }).locator('span').filter({ hasText: /^Ratio$/ }).click();
    await expect(editor).toHaveCount(0);
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'brownstone');
  });
}
