import { expect, type Locator } from '@playwright/test';

// The Trends "Every date" table's row actions (Open, and Meals or Meal log on a nutrition series) in the application and
// the showcase, which share TrendsContent and styles.css. Release step 9, finding 1: the actions cell shrank to one
// character, so every label wrapped letter by letter while the page itself still fitted, and a page-width check alone
// passed. This reads each label's line boxes instead: one line, and nothing clipped inside the button.

/** Every row action inside `scope` shows its whole label on one line. Returns how many were checked. */
export async function expectTrendsRowActionsOnOneLine(scope: Locator): Promise<number> {
  const buttons = scope.locator('.trends-table__actions button');
  await expect(buttons.first()).toBeVisible();
  const measured = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      // One rectangle per line box of the label; a label broken across lines has rectangles at different heights.
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => Math.round(rect.top)));
      return { clipped: node.scrollWidth > node.clientWidth, label: node.getAttribute('aria-label'), lines: tops.size, text: node.textContent };
    }),
  );
  expect(measured.length).toBeGreaterThan(0);
  expect(measured.filter((button) => button.lines !== 1 || button.clipped), 'row actions whose label wraps or is clipped').toEqual([]);
  return measured.length;
}
