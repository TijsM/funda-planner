import { test, expect } from '@playwright/test';
import { fresh, S, floorOf, importMocked, starter, addFromTray, clickPlan, dragPlan, screenOf, clickObject } from './helpers.js';

test.beforeEach(async ({ page }) => { await fresh(page); });

test.describe('the meeting shell', () => {
  test('carries no side panels and shows all floors as chips', async ({ page }) => {
    await importMocked(page);
    await expect(page.locator('#floorbar')).toBeVisible();
    /* v2 deleted the panels; the shipped build merely hides them in Simple */
    if (process.env.E2E_TARGET === 'next') {
      await expect(page.locator('.panel')).toHaveCount(0);
      await expect(page.locator('.statusbar')).toHaveCount(0);
    } else {
      await expect(page.locator('.panel.left')).toBeHidden();
      await expect(page.locator('.panel.right')).toBeHidden();
      await expect(page.locator('.statusbar')).toBeHidden();
    }

    const chips = page.locator('#fchips .fchip');
    await expect(chips).toHaveCount(5);
    await expect(chips.nth(0)).toContainText('Begane Grond Tuin');
    await expect(chips.nth(4)).toContainText('Berging');
    await expect(chips.nth(1)).toContainText('m²');
  });

  test('the closed Add tray never covers the floor bar', async ({ page }) => {
    await importMocked(page);
    const bar = await page.locator('#floorbar').boundingBox();
    const tray = await page.locator('#tray').boundingBox();
    expect(tray.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    await expect(page.locator('#tray')).toBeHidden();
    await expect(page.locator('#fchips .fchip').nth(0)).toBeVisible();
    await page.locator('#fchips .fchip').nth(0).click();   // would throw if intercepted
    expect((await S(page)).fi).toBe(0);
  });

  test('floor chips switch floors', async ({ page }) => {
    await importMocked(page);
    await page.locator('#fchips .fchip').nth(2).click();
    await page.waitForTimeout(250);
    const s = await S(page);
    expect(s.fi).toBe(2);
    expect(s.floors[2].name).toBe('Eerste Verdieping');
    await expect(page.locator('#fchips .fchip').nth(2)).toHaveClass(/on/);
  });
});

test.describe('the Add tray', () => {
  test('holds the draw tools next to the furniture, and filters', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect(page.locator('#tray')).toHaveClass(/open/);

    for (const k of ['draw:wall', 'draw:room', 'draw:note', 'draw:arrow', 'draw:measure'])
      await expect(page.locator(`.tile[data-kind="${k}"]`)).toBeVisible();
    const tiles = await page.locator('#trayBody .tile').count();
    expect(tiles).toBeGreaterThanOrEqual(120);           // 5 draw tools + the catalogue
    for (const k of ['potM', 'potL', 'gpotR', 'firepit', 'rugRound'])
      await expect(page.locator(`.tile[data-kind="${k}"]`)).toHaveCount(1);

    await page.locator('#traySearch').fill('bed');
    await page.waitForTimeout(150);
    const names = await page.locator('#trayBody .tile b').allInnerTexts();
    expect(names.length).toBeGreaterThan(0);
    expect(names.join(' ').toLowerCase()).toContain('bed');
    expect(await page.locator('.tile[data-kind="sofa3"]').count()).toBe(0);

    await page.locator('#traySearch').fill('zzzz');
    await page.waitForTimeout(150);
    await expect(page.locator('#trayBody .empty')).toBeVisible();
  });

  test('finds the L-shaped sofas by synonym, and places one at real size', async ({ page }) => {
    /* the frozen POC in index.html has neither the L glyphs nor search aliases */
    test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');
    await starter(page);
    await page.locator('#fAdd').click();

    /* the words a person types — none of which is the tile's own name */
    for (const [q, kind] of [['l-shape', 'sofaL'], ['hoekbank', 'sofaL'], ['chaise', 'sofaChaise'],
      ['corner', 'sofaL'], ['sectional', 'sofaL']]) {
      await page.locator('#traySearch').fill(q);
      await page.waitForTimeout(150);
      await expect(page.locator(`.tile[data-kind="${kind}"]`), q).toHaveCount(1);
    }
    /* the alias is a search key, never shown */
    await page.locator('#traySearch').fill('hoekbank');
    await page.waitForTimeout(150);
    expect((await page.locator('#trayBody .tile b').allInnerTexts()).join(' ')).toBe('L-shaped sofa');

    await page.locator('.tile[data-kind="sofaL"]').click();
    await clickPlan(page, 400, 320);
    await page.waitForTimeout(200);
    const f = await floorOf(page);
    expect(f.items).toBe(1);
    const it = await page.evaluate(() => {
      const i = window.__S.proj.floors[0].items[0];
      return { kind: i.kind, w: i.w, h: i.h, label: i.label };
    });
    expect(it).toMatchObject({ kind: 'sofaL', w: 265, h: 200, label: 'L-shaped sofa' });
  });

  test('closes itself once you arm an item, so the plan is visible', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="sofa3"]').click();
    await expect(page.locator('#tray')).not.toHaveClass(/open/);
    expect((await S(page)).place).toBe('sofa3');
    await expect(page.locator('.tool-tip')).toContainText('Sofa 3-seat');
  });

  test('Escape cancels an armed item', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="sofa3"]').click();
    await page.keyboard.press('Escape');
    expect((await S(page)).place).toBe(null);
  });

  test('an item can be dragged straight from the tray onto the plan', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await page.locator('.tile[data-kind="armchair"]').scrollIntoViewIfNeeded();
    const tile = await page.locator('.tile[data-kind="armchair"]').boundingBox();
    const canvas = await page.locator('#cv').boundingBox();
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.3, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const f = await floorOf(page);
    expect(f.items).toBe(1);
    await expect(page.locator('#tray')).not.toHaveClass(/open/);
  });
});

test.describe('placing and editing without ever leaving the canvas', () => {
  test('furniture: place, rotate, mirror, recolour, duplicate, delete', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    expect((await floorOf(page)).items).toBe(1);

    const ctx = page.locator('#ctx');
    await expect(ctx).toBeVisible();
    await expect(ctx.locator('#ctxRot')).toBeVisible();

    await ctx.locator('#ctxRot').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].rot)).toBe(90);
    await ctx.locator('#ctxRot').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].rot)).toBe(180);

    await ctx.locator('#ctxFlip').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].flip)).toBe(1);

    await ctx.locator('.sw').nth(2).click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].color)).toBeTruthy();

    await ctx.locator('#ctxDup').click();
    expect((await floorOf(page)).items).toBe(2);

    await ctx.locator('#ctxDel').click();
    expect((await floorOf(page)).items).toBe(1);
  });

  test('dragging an object moves it', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 650, 400);
    const before = await page.evaluate(() => ({ ...window.__S.proj.floors[0].items[0] }));
    const p = await screenOf(page, before.x, before.y);
    await dragPlan(page, p.x, p.y, p.x + 120, p.y + 60);
    const after = await page.evaluate(() => ({ ...window.__S.proj.floors[0].items[0] }));
    expect(after.x).toBeGreaterThan(before.x + 20);
    expect(after.y).toBeGreaterThan(before.y + 10);
  });

  test('wall: drop it, then add a door and size it from the same bar', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:wall', 700, 500);
    expect((await floorOf(page)).walls).toBe(5);            // 4 from the starter + 1

    const ctx = page.locator('#ctx');
    await expect(ctx.locator('#ctxDoor')).toBeVisible();
    await expect(ctx.locator('#ctxWin')).toBeVisible();
    await expect(ctx).toContainText('300 cm');

    await ctx.locator('#ctxDoor').click();
    let op = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings[0]);
    expect(op.type).toBe('door');
    expect(op.width).toBe(90);

    await ctx.locator('#ctxWiden').click();
    op = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings[0]);
    expect(op.width).toBe(100);
    await ctx.locator('#ctxNarrow').click();
    await ctx.locator('#ctxNarrow').click();
    op = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings[0]);
    expect(op.width).toBe(80);

    await ctx.locator('#ctxHinge').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings[0].flip)).toBe(1);
    await ctx.locator('#ctxSide').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings[0].side)).toBe(1);

    await ctx.locator('#ctxDel').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings.length)).toBe(0);
  });

  test('a second opening lands in the free half of the wall', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:wall', 700, 500);
    await page.locator('#ctxDoor').click();
    const w = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1));
    await clickObject(page, (w.a.x + w.b.x) / 2, (w.a.y + w.b.y) / 2);
    await expect(page.locator('#ctxWin')).toBeVisible();
    await page.locator('#ctxWin').click();
    await page.waitForTimeout(150);
    const ats = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1).openings.map(o => o.at));
    expect(ats).toHaveLength(2);
    expect(Math.abs(ats[0] - ats[1])).toBeGreaterThan(0.2);
  });

  test('room: drop it and name it in the bubble', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:room', 800, 420);
    const ctx = page.locator('#ctx');
    await expect(ctx.locator('#ctxName')).toBeFocused();
    await expect(ctx).toContainText('9.0 m²');            // 3 m × 3 m

    await ctx.locator('#ctxName').fill('Werkkamer');
    await page.waitForTimeout(200);
    const f = await floorOf(page);
    expect(f.names).toContain('Werkkamer');

    await ctx.locator('.sw').nth(3).click();
    await ctx.locator('#ctxDel').click();
    expect((await floorOf(page)).areas).toBe(1);          // starter room only
  });

  test('note: drop it and type into the bubble', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:note', 760, 380);
    const ctx = page.locator('#ctx');
    await expect(ctx.locator('#ctxNote')).toBeFocused();
    await ctx.locator('#ctxNote').fill('muur eruit?');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__S.proj.floors[0].notes[0].text)).toBe('muur eruit?');

    const size0 = await page.evaluate(() => window.__S.proj.floors[0].notes[0].size);
    await ctx.locator('#ctxBig').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].notes[0].size)).toBeGreaterThan(size0);
    await ctx.locator('#ctxSmall').click();
    await ctx.locator('#ctxSmall').click();
    expect(await page.evaluate(() => window.__S.proj.floors[0].notes[0].size)).toBeLessThan(size0);
  });

  test('arrow and measure', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:arrow', 700, 400);
    expect(await page.evaluate(() => window.__S.proj.floors[0].lines.at(-1).arrow)).toBe(1);
    await expect(page.locator('#ctx .sw')).toHaveCount(5);

    await addFromTray(page, 'draw:measure', 700, 600);
    expect((await floorOf(page)).dims).toBe(1);
    // measuring turns the dimension layer back on by itself
    expect(await page.evaluate(() => !!window.__S.view.dims)).toBe(true);
    await expect(page.locator('#ctx')).toContainText(/m|cm/);
  });

  test('the toolbar follows the object and disappears on empty canvas', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 650, 400);
    const a = await page.locator('#ctx').boundingBox();
    await page.mouse.wheel(0, -300);                      // zoom, toolbar must re-anchor
    await page.waitForTimeout(250);
    const b = await page.locator('#ctx').boundingBox();
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(2);

    await clickPlan(page, 120, 120);                      // empty space
    await page.waitForTimeout(150);
    await expect(page.locator('#ctx')).toBeHidden();
  });
});

test.describe('undo, redo, keyboard', () => {
  test('the big undo/redo buttons work', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 650, 400);
    expect((await floorOf(page)).items).toBe(1);
    await page.locator('#btnUndo2').click();
    await page.waitForTimeout(150);
    expect((await floorOf(page)).items).toBe(0);
    await page.locator('#btnRedo2').click();
    await page.waitForTimeout(150);
    expect((await floorOf(page)).items).toBe(1);
  });

  test('delete key and arrow-key nudging', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 650, 400);
    const y0 = await page.evaluate(() => window.__S.proj.floors[0].items[0].y);
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].y)).toBe(y0 + 1);
    await page.keyboard.press('Shift+ArrowDown');
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].y)).toBe(y0 + 11);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    expect((await floorOf(page)).items).toBe(0);
  });

  test('typing in the room-name bubble does not trigger shortcuts', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:room', 800, 420);
    await page.locator('#ctxName').fill('Bad');          // 'd' = door tool, 'b' = ref toggle in pro
    await page.waitForTimeout(200);
    expect((await floorOf(page)).names).toContain('Bad');
    expect((await S(page)).floors[0].areas).toBe(2);     // nothing extra created
  });
});

test.describe('object labels', () => {
  test('every placed object is labelled with its name', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'chair', 620, 380);
    await addFromTray(page, 'desk', 780, 380);
    const items = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => i.label));
    expect(items).toEqual(['Chair', 'Desk']);
  });

  test('the label is editable straight from the object toolbar', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'desk', 700, 400);
    const fld = page.locator('#ctxLabel');
    await expect(fld).toBeVisible();
    await expect(fld).toHaveValue('Desk');

    await fld.fill("Tijs' bureau");
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].label)).toBe("Tijs' bureau");

    // clearing it means "show nothing", and that survives a reselect
    await page.locator('#ctxLabel').fill('');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0])).toMatchObject({ label: '', noLabel: 1 });
    await clickPlan(page, 60, 60);
    await page.waitForTimeout(150);
    const p = await screenOf(page, ...Object.values(await page.evaluate(() => {
      const i = window.__S.proj.floors[0].items[0]; return [i.x, i.y];
    })));
    await clickPlan(page, p.x, p.y);
    await expect(page.locator('#ctxLabel')).toHaveValue('');
  });

  test('the label is drawn on the plan and survives a save', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'bed140', 700, 420);
    await page.locator('#ctxLabel').fill('Logeerbed');
    await page.waitForTimeout(250);
    await page.locator('#btnSave').click();
    await page.waitForTimeout(400);

    // it reaches the canvas: dark label pixels appear over the object
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('#cv');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
      return dark;
    });
    expect(drawn).toBeGreaterThan(50);

    await page.locator('#btnLib').click();
    await page.locator('#libList .lib-i [data-act=open]').click();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__S.proj.floors[0].items[0].label)).toBe('Logeerbed');
  });

  test('the label reaches the image-generator prompt', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 700, 400);
    await page.locator('#ctxLabel').fill('Grote hoekbank');
    await page.waitForTimeout(250);
    await page.locator('#btnAI').click();
    await page.waitForTimeout(400);
    expect(await page.locator('#aiPrompt').inputValue()).toContain('grote hoekbank');
  });
});

test.describe('decoration and axis-locked rulers', () => {
  test('round plants and decoration are in the tray and place correctly', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'potL', 700, 380);
    await addFromTray(page, 'gpotR', 820, 380);
    const items = await page.evaluate(() => window.__S.proj.floors[0].items.map(i => ({ k: i.kind, l: i.label, w: i.w, h: i.h })));
    expect(items).toEqual([
      { k: 'potL', l: 'Plant, large', w: 85, h: 85 },
      { k: 'gpotR', l: 'Round planter', w: 80, h: 80 },
    ]);
    // round objects are square-footprint, so rotating must not change the box
    await page.locator('#ctxRot').click();
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.__S.proj.floors[0].items[1]);
    expect(after.w).toBe(after.h);
  });

  test('the decoration group is browsable and searchable', async ({ page }) => {
    await starter(page);
    await page.locator('#fAdd').click();
    await expect(page.locator('.tgroup .lbl', { hasText: 'Decoration' })).toBeVisible();
    await page.locator('#traySearch').fill('plant');
    await page.waitForTimeout(200);
    const names = (await page.locator('#trayBody .tile b').allInnerTexts()).join(' | ');
    expect(names).toMatch(/Plant pot|Plant, medium|Plant, large/);
  });

  test('shift locks a ruler end to the axis', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:measure', 700, 500);
    const d0 = await page.evaluate(() => window.__S.proj.floors[0].dims[0]);
    expect(d0.a.y).toBe(d0.b.y);                       // starts horizontal

    const S0 = await page.evaluate(() => ({ z: window.__S.zoom, px: window.__S.px, py: window.__S.py }));
    const scr = (x, y) => ({ x: x * S0.z + S0.px, y: y * S0.z + S0.py });
    const end = scr(d0.b.x, d0.b.y);

    // drag the end well off-axis WITHOUT shift — it follows the pointer
    await dragPlan(page, end.x, end.y, end.x + 100, end.y + 90);
    let d = await page.evaluate(() => window.__S.proj.floors[0].dims[0]);
    expect(Math.abs(d.b.y - d.a.y)).toBeGreaterThan(20);

    // put it back, then drag the same distance holding shift — y must not move
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(200);
    d = await page.evaluate(() => window.__S.proj.floors[0].dims[0]);
    const e2 = scr(d.b.x, d.b.y);
    await page.keyboard.down('Shift');
    await dragPlan(page, e2.x, e2.y, e2.x + 100, e2.y + 90);
    await page.keyboard.up('Shift');
    d = await page.evaluate(() => window.__S.proj.floors[0].dims[0]);
    expect(d.b.y).toBe(d.a.y);                          // locked to the axis
    expect(d.b.x).toBeGreaterThan(d0.b.x);              // but it did extend
  });

  test('shift also locks a wall end', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'draw:wall', 700, 520);
    const w0 = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1));
    const S0 = await page.evaluate(() => ({ z: window.__S.zoom, px: window.__S.px, py: window.__S.py }));
    const end = { x: w0.b.x * S0.z + S0.px, y: w0.b.y * S0.z + S0.py };
    await page.keyboard.down('Shift');
    await dragPlan(page, end.x, end.y, end.x + 60, end.y + 120);
    await page.keyboard.up('Shift');
    const w = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1));
    // The axis is measured from the end that stays put. This wall is 3 m long
    // horizontally, so a 120 px vertical nudge does not out-reach it: it stays
    // horizontal and simply extends.
    expect(w.b.y).toBe(w.a.y);
    expect(w.b.x).toBeGreaterThan(w0.b.x);

    // pull far enough vertically and it flips to the other axis
    const S1 = await page.evaluate(() => ({ z: window.__S.zoom, px: window.__S.px, py: window.__S.py }));
    const e2 = { x: w.b.x * S1.z + S1.px, y: w.b.y * S1.z + S1.py };
    await page.keyboard.down('Shift');
    await dragPlan(page, e2.x, e2.y, e2.x - 20, e2.y + 420);
    await page.keyboard.up('Shift');
    const w2 = await page.evaluate(() => window.__S.proj.floors[0].walls.at(-1));
    expect(w2.b.x).toBe(w2.a.x);
  });
});
