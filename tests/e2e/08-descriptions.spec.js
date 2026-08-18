import { test, expect } from '@playwright/test';
import { fresh, importMocked, starter, addFromTray, clickObject, toast } from './helpers.js';

/* Descriptions live only in the React shell. index.html is the frozen POC that
   still serves GitHub Pages, so this suite has nothing to assert against it. */
test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

test.beforeEach(async ({ page }) => { await fresh(page); });

/* read the raw document, since S() deliberately reports only counts */
const descs = page => page.evaluate(() => {
  const f = window.__S.proj.floors[window.__S.fi];
  return {
    items: f.items.map(i => ({ k: i.kind, has: 'desc' in i, d: i.desc })),
    areas: f.areas.map(a => ({ n: a.name, has: 'desc' in a, d: a.desc })),
  };
});


const openRender = async page => {
  await page.locator('#btnAI').click();
  await expect(page.locator('#ovAI')).toHaveClass(/open/);
  await expect(page.locator('#aiPrompt')).not.toBeEmpty();
  return page.locator('#aiPrompt').inputValue();
};

test.describe('a description on every object', () => {
  test('is empty by default, on placed and imported objects alike', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    await addFromTray(page, 'sofa3', 700, 420);

    const d = await descs(page);
    expect(d.items.length).toBeGreaterThan(1);           // fitted units + our sofa
    expect(d.items.filter(i => i.has)).toHaveLength(0);
    expect(d.areas.filter(a => a.has)).toHaveLength(0);
  });

  test('the toolbar row writes it, and an empty one removes the field again', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);

    /* present the moment the object is selected — never a click away */
    await expect(page.locator('#ctxDesc')).toBeVisible();
    await page.locator('#ctxDesc').fill('dark green velvet, mid-century');
    await page.waitForTimeout(150);
    expect((await descs(page)).items[0].d).toBe('dark green velvet, mid-century');

    await page.locator('#ctxDesc').fill('  ');
    await page.waitForTimeout(150);
    expect((await descs(page)).items[0].has).toBe(false);
  });

  test('is there again, already written, when you reselect the object', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);
    await page.locator('#ctxDesc').fill('oxblood leather');
    await page.waitForTimeout(150);

    /* the first Escape leaves the text field, the second clears the selection */
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('#ctxDesc')).toHaveCount(0);

    const p = await page.evaluate(() => {
      const i = window.__S.proj.floors[0].items[0];
      return { x: i.x, y: i.y };
    });
    await clickObject(page, p.x, p.y);
    await expect(page.locator('#ctxDesc')).toHaveValue('oxblood leather');
  });

  test('works on a room too', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:room', 300, 260);
    await page.locator('#ctxName').fill('Werkkamer');
    await page.locator('#ctxDesc').fill('wide oak floorboards, north light');
    await page.waitForTimeout(150);

    const a = (await descs(page)).areas.find(x => x.n === 'Werkkamer');
    expect(a.d).toBe('wide oak floorboards, north light');
  });

  test('survives reselecting the object', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);
    await page.locator('#ctxDesc').fill('from the toolbar');
    await page.waitForTimeout(150);

    /* the description used to have a second home in the Pro inspector; with one
       field left, what matters is that it is still there when you come back */
    /* the first Escape only blurs the field it was typed in — the document
       handler ignores keys aimed at an input, which is what protects typing */
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('#ctx')).toBeHidden();
    /* addFromTray aims in screen pixels, clickObject in world centimetres — ask
       the document where the sofa actually landed rather than reusing 380,300 */
    const at = await page.evaluate(() => {
      const i = window.__S.proj.floors[0].items[0];
      return { x: i.x, y: i.y };
    });
    await clickObject(page, at.x, at.y);
    await expect(page.locator('#ctxDesc')).toHaveValue('from the toolbar');
    await page.locator('#ctxDesc').fill('rewritten on the object');
    await page.waitForTimeout(150);
    expect((await descs(page)).items[0].d).toBe('rewritten on the object');
  });

  test('reaches the render prompt, on the object and on the room', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);

    /* describe a room through the selection toolbar */
    const woon = await page.evaluate(() => {
      const a = window.__S.proj.floors[1].areas.find(x => x.name === 'Woonkamer');
      const c = a.poly.reduce((s, p) => ({ x: s.x + p.x / a.poly.length, y: s.y + p.y / a.poly.length }), { x: 0, y: 0 });
      window.__setSel([{ t: 'area', id: a.id }]);
      return c;
    });
    await page.waitForTimeout(200);
    await page.locator('#ctxDesc').fill('plastered walls, low winter light');
    await page.waitForTimeout(150);
    await addFromTray(page, 'sofa3', 0, 0);              // lands, then we move it in
    await page.evaluate(c => {
      const f = window.__S.proj.floors[1];
      const i = f.items[f.items.length - 1];
      i.x = c.x; i.y = c.y;
      i.desc = 'dark green velvet, mid-century, low back';
      window.__ed().touch();
    }, woon);
    await page.waitForTimeout(150);

    const p = await openRender(page);
    expect(p).toContain('plastered walls, low winter light');
    expect(p).toContain('dark green velvet, mid-century, low back');
    /* named right next to its object, not dumped in a separate block */
    expect(p).toMatch(/sofa 3-seat \([\d×]+ cm\) — dark green velvet/);
    expect(p).toMatch(/deliberate instructions/i);
  });

  test('survives save, wipe and reload', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 380, 300);
    await page.locator('#ctxDesc').fill('oxblood leather, brass castors');
    await page.waitForTimeout(150);

    await page.locator('#projName').fill('Met beschrijving');
    await page.locator('#btnSave').click();
    await expect(toast(page, 'Met beschrijving')).toBeVisible();

    await page.evaluate(() => { window.__S.proj.floors[0].items.length = 0; });
    await page.locator('#btnLib').click();
    await page.locator('#libList .lib-i [data-act=open]').click();
    await page.waitForTimeout(600);

    expect((await descs(page)).items[0].d).toBe('oxblood leather, brass castors');
  });

  test('an undescribed plan reads exactly as it did before', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(1).click();
    await page.waitForTimeout(250);
    const p = await openRender(page);
    expect(p).not.toMatch(/deliberate instructions/i);
    expect(p).toContain('Woonkamer');
  });
});
