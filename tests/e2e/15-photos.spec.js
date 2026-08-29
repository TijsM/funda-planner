import { test, expect } from '@playwright/test';
import path from 'path';
import { FIXTURES, addFromTray, appUrl, clickObject, fresh, starter, toast } from './helpers.js';

/* Attaching a photograph of the real object.
 *
 *  The point of the feature is that the render draws the sofa that was actually
 *  bought, so what has to be true end to end is a chain: a file becomes a stored
 *  JPEG, the JPEG becomes a thumbnail on the object, the object becomes a ticked
 *  row in the render panel, and the row becomes an image number in the brief. A
 *  unit test can check any one link; only a browser can check that they connect.
 *
 *  Driven through the file input rather than the store because the encoder is
 *  the part that cannot be tested anywhere else: `createImageBitmap`, the
 *  downscale and the JPEG encoder do not exist under jsdom. */

test.skip(process.env.E2E_TARGET !== 'next', 'v2 shell feature');

const SOFA = path.join(FIXTURES, 'photo-sofa.jpg');
const CUTOUT = path.join(FIXTURES, 'photo-cutout.png');

test.beforeEach(async ({ page }) => { await fresh(page); });

const items = page => page.evaluate(() => window.__S.proj.floors[window.__S.fi].items);
const photosOf = async (page, n = 0) => (await items(page))[n].photos ?? [];

/** A plan with one sofa, selected. */
async function withSofa(page) {
  await starter(page);
  await addFromTray(page, 'sofa3', 300, 240);
  /* placing selects it, but click it anyway so the toolbar is certainly up */
  const [sofa] = await items(page);
  await clickObject(page, sofa.x, sofa.y);
  await expect(page.locator('#ctx')).toHaveClass(/show/);
  return sofa;
}

const attach = async (page, file = SOFA) => {
  await page.locator('.ctx-photos input[type=file]').setInputFiles(file);
  await expect(toast(page, /Photo attached|photos attached/)).toBeVisible();
};

test.describe('attaching a photo to an object', () => {
  test('a file becomes a thumbnail on the selected object', async ({ page }) => {
    await withSofa(page);
    await expect(page.locator('#ctxPhotoAdd')).toContainText('Add photo');
    await attach(page);

    await expect(page.locator('.ctx-photo')).toHaveCount(1);
    /* the first one is ringed, because it is the one that gets sent */
    await expect(page.locator('.ctx-photo').first()).toHaveClass(/pri/);
    /* an <img> with real bytes behind it, not an empty tile */
    const w = await page.locator('.ctx-photo img').first().evaluate(el => el.naturalWidth);
    expect(w).toBeGreaterThan(0);
  });

  test('the document keeps a reference, and not the bytes', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    const [p] = await photosOf(page);
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('photo-sofa.jpg');
    /* Downscaled to the render request's budget, and portrait kept portrait —
       the fixture is 1400×1900. */
    expect(Math.max(p.w, p.h)).toBe(1024);
    expect(p.h).toBeGreaterThan(p.w);
    expect(p.bytes).toBeGreaterThan(1000);
    /* the document must never carry image data: it is stringified into every
       undo snapshot and autosaved to localStorage every three seconds */
    expect(JSON.stringify(p)).not.toMatch(/base64|data:image/);
    const doc = await page.evaluate(() => JSON.stringify(window.__S.proj).length);
    expect(doc).toBeLessThan(200_000);
  });

  test('undo takes the photo off again', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    expect(await photosOf(page)).toHaveLength(1);
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(200);
    expect(await photosOf(page)).toHaveLength(0);
  });

  test('a transparent cut-out is accepted and matted, not refused', async ({ page }) => {
    await withSofa(page);
    await attach(page, CUTOUT);
    const [p] = await photosOf(page);
    expect(p.name).toBe('photo-cutout.png');
    /* stored as JPEG whatever came in, so nothing downstream has to branch */
    expect(p.bytes).toBeGreaterThan(500);
  });

  test('the photo survives a reload', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    const [before] = await photosOf(page);

    /* Through the autosave, which is the crash buffer the app actually reboots
       from, flushed the way the persistence spec flushes it. And back to the app
       WITHOUT the `#new` hash — with it, boot makes a blank plan and the reload
       proves nothing. */
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.waitForTimeout(400);
    await page.goto(appUrl());
    await page.waitForFunction(() => window.__S && window.__S.proj);
    await page.waitForTimeout(500);

    const [after] = await photosOf(page);
    expect(after.id).toBe(before.id);
    /* and the bytes are still there — the tile draws from IndexedDB */
    const sofa = (await items(page))[0];
    await clickObject(page, sofa.x, sofa.y);
    await expect(page.locator('.ctx-photo img')).toHaveCount(1);
    const w = await page.locator('.ctx-photo img').first().evaluate(el => el.naturalWidth);
    expect(w).toBeGreaterThan(0);
  });
});

test.describe('managing the photos on one object', () => {
  test('the strip opens the manager, which can reorder and delete', async ({ page }) => {
    await withSofa(page);
    await page.locator('.ctx-photos input[type=file]').setInputFiles([SOFA, CUTOUT]);
    await expect(toast(page, /2 photos attached/)).toBeVisible();
    expect(await photosOf(page)).toHaveLength(2);

    await page.locator('.ctx-photo').first().click();
    await expect(page.locator('#ovPhotos')).toHaveClass(/open/);
    await expect(page.locator('.photo-card')).toHaveCount(2);
    /* the first card is badged, because first is what gets sent */
    await expect(page.locator('.photo-card').first()).toHaveClass(/pri/);

    const [, second] = await photosOf(page);
    await page.locator(`[data-first="${second.id}"]`).click();
    await page.waitForTimeout(150);
    expect((await photosOf(page))[0].id).toBe(second.id);

    await page.locator(`[data-del="${second.id}"]`).click();
    await page.waitForTimeout(250);
    expect(await photosOf(page)).toHaveLength(1);
    expect((await photosOf(page))[0].id).not.toBe(second.id);
  });

  test('a note on a photo is kept', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    await page.locator('.ctx-photo').first().click();
    const [p] = await photosOf(page);
    const note = page.locator(`[data-note="${p.id}"]`);
    await note.fill('from the front');
    await note.blur();
    await page.waitForTimeout(150);
    expect((await photosOf(page))[0].note).toBe('from the front');
  });
});

test.describe('the render panel', () => {
  const openPanel = async page => {
    await page.keyboard.press('Escape');
    await page.locator('#btnAI').click();
    await expect(page.locator('#ovAI')).toHaveClass(/open/);
  };

  test('lists the photographed object, ticked, with the image number it will be', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    await openPanel(page);

    const row = page.locator('#aiPhotos .ai-photo');
    await expect(row).toHaveCount(1);
    await expect(row.first()).toContainText('three-seat sofa');
    /* image 1 is always the plan, so the first photograph is image 2 */
    await expect(row.first()).toContainText('image 2');
    await expect(page.locator('#aiPhotos')).toContainText('1 of 7 slots used');

    /* and the brief names it as that image, not as a scene to copy — quoting the
       address it carries in the OBJECTS table — its name, its room and where it
       sits in that room. Nothing may be written on the picture, so those words
       are the only thing binding this sentence to a rectangle on it. */
    const prompt = await page.locator('#aiPrompt').inputValue();
    expect(prompt).toMatch(/Image 2 photographs an object already on the plan/);
    expect(prompt).toMatch(/Image 2: three-seat sofa, [^,]+, [a-z]/);
    expect(prompt).toMatch(/^Room \| Object \| Where/m);
    expect(prompt).toMatch(/\| Photo \|/);
    expect(prompt).toMatch(/^.* \| three-seat sofa \|.*image 2/m);
  });

  /** The eye-level view is the one where "which objects are in the picture" has
   *  an answer narrower than "all of them", and getting it wrong costs twice:
   *  the model is documented to reproduce every reference image it is handed, so
   *  a photograph of something behind the lens comes back as a second copy of
   *  that thing — and BFL meters input megapixels, so it is paid for as well.
   *
   *  Two sofas at opposite ends of a long room, a camera pointed at one of them. */
  test('sends only the photographs of objects the camera can see', async ({ page }) => {
    await starter(page);
    await addFromTray(page, 'sofa3', 300, 240);
    await addFromTray(page, 'sofa3', 380, 300);
    /* Moved into place by world coordinate rather than dropped there: the tray
       takes screen pixels, and where those land inside the building depends on
       the pan and zoom the starter happens to open at. Both ends of the room,
       on its centre line, is the arrangement this test needs. */
    const { near, far } = await page.evaluate(() => {
      const s = window.__ed(), f = s.floor();
      const xs = f.walls.flatMap(w => [w.a.x, w.b.x]);
      const ys = f.walls.flatMap(w => [w.a.y, w.b.y]);
      const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const [a, b] = f.items;
      a.x = x; a.y = Math.round(y0 + (y1 - y0) * 0.22);
      b.x = x; b.y = Math.round(y0 + (y1 - y0) * 0.78);
      s.touch();
      return { near: { x: a.x, y: a.y }, far: { x: b.x, y: b.y } };
    });

    for (const it of [near, far]) {
      await clickObject(page, it.x, it.y);
      await expect(page.locator('#ctx')).toHaveClass(/show/);
      await attach(page);
    }

    await openPanel(page);
    await expect(page.locator('#aiPhotos .ai-photo')).toHaveCount(2);
    /* both are in a top-down picture, so both go */
    await expect(page.locator('#aiPhotos')).toContainText('2 of 7 slots used');

    await page.locator('#aiView button[data-v="eye"]').click();
    await expect(page.locator('#aiCamMap')).toBeVisible();

    /* Stand on the line between the two sofas, 250 cm from the near one, looking
       back at it — which puts the far one directly behind the lens and keeps the
       camera inside the walls whatever coordinates the tray dropped them at.
       Set through the store rather than by dragging the minimap: this test is
       about which photographs go, and the drag has its own coverage. */
    const aim = await page.evaluate(({ a, b }) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const x = Math.round(a.x + (dx / L) * 250), y = Math.round(a.y + (dy / L) * 250);
      const yaw = Math.round((Math.atan2(a.y - y, a.x - x) * 180) / Math.PI);
      window.__renders().patch({
        camera: { ...window.__renders().camera, x, y, yaw, pitch: 0 },
      });
      return { x, y, yaw };
    }, { a: near, b: far });
    await page.waitForTimeout(400);
    /* the shot has to be a shot of the room, or "not in shot" would be true of
       everything and this test would pass for the wrong reason */
    await expect(page.locator('.cam-block .hint')).not.toHaveClass(/err/);

    /* Still listed — an object silently missing from the list would be
       inexplicable — but marked, disabled, and not taking a slot. */
    await expect(page.locator('#aiPhotos .ai-photo')).toHaveCount(2);
    const unseen = page.locator('#aiPhotos .ai-photo.unseen');
    await expect(unseen).toHaveCount(1);
    await expect(unseen).toContainText('not in shot');
    await expect(unseen.locator('input')).toBeDisabled();
    await expect(page.locator('#aiPhotos')).toContainText('1 of 7 slots used');
    await expect(page.locator('#aiPhotoNote')).toContainText('not in the camera');

    /* and the brief carries one photograph, not two */
    const prompt = await page.locator('#aiPrompt').inputValue();
    expect(prompt).toMatch(/Image 2 photographs an object already on the plan/);
    expect(prompt).not.toMatch(/Image 3:/);

    /* Turn round and the other one is the one in shot — the narrowing follows
       the camera rather than being decided once when the panel opened. */
    await page.evaluate(yaw => {
      window.__renders().patch({ camera: { ...window.__renders().camera, yaw } });
    }, (aim.yaw + 180) % 360);
    await page.waitForTimeout(400);
    await expect(page.locator('#aiPhotos .ai-photo.unseen')).toHaveCount(1);
    await expect(page.locator('#aiPhotos')).toContainText('1 of 7 slots used');
  });

  test('unticking an object takes it out of the brief', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    await openPanel(page);
    await page.locator('#aiPhotos .ai-photo input[type=checkbox]').first().uncheck();
    await page.waitForTimeout(200);

    await expect(page.locator('#aiPhotos .ai-photo').first()).toHaveClass(/off/);
    const prompt = await page.locator('#aiPrompt').inputValue();
    expect(prompt).not.toMatch(/photograph/i);
    expect(prompt).not.toMatch(/\| Photo \|/);
  });

  /* Ticking a map takes a slot from the photographs, because they are the same
     eight inputs — and the brief has to renumber, or every sentence after the
     first is pointing at the wrong picture. */
  test('a control map pushes the photographs down the numbering', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    await openPanel(page);
    await expect(page.locator('#aiPhotos')).toContainText('1 of 7 slots used');

    await page.locator('#aiControls button[data-k="line"]').click();
    await page.waitForTimeout(250);
    await expect(page.locator('#aiPhotos')).toContainText('1 of 6 slots used');

    const prompt = await page.locator('#aiPrompt').inputValue();
    /* the photograph keeps image 2 and the map takes image 3 */
    expect(prompt).toMatch(/Image 2: three-seat sofa, [^,]+, [a-z]/);
    expect(prompt).toMatch(/Image 3 is a line drawing/);
  });

  test('says plainly when the chosen provider cannot take a photograph at all', async ({ page }) => {
    await withSofa(page);
    await attach(page);
    await openPanel(page);
    await page.locator('#aiProvider').selectOption('z-image-cn');
    await page.waitForTimeout(250);

    await expect(page.locator('#aiPhotos')).toContainText('takes none');
    await expect(page.locator('#aiPhotoNote')).toContainText('one image input');
    const prompt = await page.locator('#aiPrompt').inputValue();
    expect(prompt).not.toMatch(/photograph/i);
  });
});
