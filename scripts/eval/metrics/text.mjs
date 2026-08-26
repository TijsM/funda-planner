/** METRIC 1 — textPixelFraction: how much of the image is lettering?
 *
 *  WHAT IT MEASURES  The fraction of the frame covered by the bounding boxes of
 *  words an OCR engine actually reads, plus the words themselves. It exists to
 *  settle one live product argument with an A/B rather than an opinion: if we
 *  bake object names into the conditioning image so the generator knows what a
 *  shape is, does that lettering bleed through into the render?
 *
 *  GOOD  ~0 on a render (no text asked for, none appeared) and the token list
 *        empty. On a labelled conditioning image the fraction is whatever the
 *        labels cover — this metric is only ever read as a DIFFERENCE between
 *        the two arms of the A/B, never as an absolute quality.
 *  BAD   anything above a few thousandths on a render, and worse, tokens that
 *        echo our own object names back at us.
 *
 *  SPEED  ~75 ms per 1 MP image once the worker is up; the first call adds a
 *  couple of hundred milliseconds to start it, plus a one-off 5 MB download of
 *  eng.traineddata on a cold cache. The worker is kept at module scope and
 *  reused; call closeTextWorker() when the process is done or Node will not
 *  exit — this is the slowest metric in the set and the only asynchronous one.
 *
 *  THE PAGE SEGMENTATION MODE IS THE METRIC — see getWorker below. Left at
 *  tesseract.js's default, a lone word on a drawing reads as nothing at all, and
 *  the failure is invisible in a test that puts two words on a white page.
 *
 *  THE FILTER IS A GUARD, not the metric. Under that default mode Tesseract read
 *  "HIER" at confidence 43 out of a picture of nothing but rectangles, in a box
 *  spanning the whole image, and unfiltered that single hallucination scored a
 *  bare floor plan at 0.65. PSM 3 has not done it on any geometry we have thrown
 *  at it since — dimension ticks, hatching, scattered furniture blocks, all
 *  silent — and the filter stays regardless: it costs nothing, and a
 *  photorealistic render carries texture that a wall drawing does not.
 *  minConfidence is the first half of it; the box-size check is the second, since
 *  real lettering in our frames is small and a "word" covering a quarter of the
 *  picture is not one.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorker, PSM } from 'tesseract.js';
import { grey, downscaleGrey, greyToPixels, toPng } from './pixels.mjs';

/** @typedef {import('./pixels.mjs').Pixels} Pixels */

/** Absolute, and inside node_modules so it is already ignored: given a relative
 *  path Tesseract writes eng.traineddata into whatever the current directory
 *  happens to be, which put a 5 MB blob in the repo root the first time. */
const CACHE = fileURLToPath(new URL('../../../node_modules/.cache/tesseract', import.meta.url));

let worker = null;

async function getWorker(cachePath) {
  if (worker) return worker;
  const dir = cachePath || CACHE;
  /* Tesseract swallows the write when the directory is missing, so every run
     silently re-downloads 5 MB of language data and an offline run fails
     outright. Create it first and the cache is real. */
  fs.mkdirSync(dir, { recursive: true });
  worker = await createWorker('eng', 1, { cachePath: dir, logger: () => {} });
  /* tesseract.js defaults to PSM 6, "the image is one uniform block of text".
     On a plan carrying several labels it copes — enough of the frame reads as a
     block — and on ONE word alone it is blind: a single WOONKAMER on a plan came
     back as two rejected fragments and nothing kept, while the same plan with two
     labels on it read both at 92. One bled word is precisely the arm of the A/B
     that matters, so the default answers "no lettering" to the only question this
     metric is ever asked. PSM 3 runs layout analysis first, reads the lone label
     at 92, and still reads nothing off the same plan unlabelled.
     Not PSM 11: despite being named SPARSE_TEXT it found one label out of three
     and invented three words on a furniture render. Not 12, which wants an
     osd.traineddata we do not ship and warns on every call without it. */
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  return worker;
}

/** Terminates the shared OCR worker. Vitest hangs on the open worker handle
 *  otherwise, and so does the sweep. */
export async function closeTextWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  await w.terminate();
}

/**
 * @param {Pixels} px
 * @param {{ minConfidence?: number, maxSide?: number, minChars?: number, maxBoxFraction?: number, cachePath?: string }} [opts]
 * @returns {Promise<{ fraction: number, tokens: { text: string, confidence: number, bbox: { x0: number, y0: number, x1: number, y1: number } }[], rejected: number }>}
 */
export async function textPixelFraction(px, opts = {}) {
  const minConfidence = opts.minConfidence ?? 60;
  const minChars = opts.minChars ?? 2;
  const maxBoxFraction = opts.maxBoxFraction ?? 0.25;

  /* Greyscale and downscaled: Tesseract is slower on colour and no better on it,
     and the labels we care about survive a 1000 px long side comfortably. */
  const { grey: g, k } = downscaleGrey(grey(px), opts.maxSide ?? 1000);
  const w = await getWorker(opts.cachePath);
  const res = await w.recognize(toPng(greyToPixels(g)), {}, { blocks: true });

  const tokens = [];
  let rejected = 0;
  const area = g.width * g.height;
  const cover = new Uint8Array(area);
  for (const block of res.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const b = word.bbox;
          const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
          const letters = (word.text || '').replace(/[^A-Za-z0-9]/g, '');
          const ok = word.confidence >= minConfidence
            && letters.length >= minChars
            && bw > 0 && bh > 0
            && (bw * bh) / area <= maxBoxFraction;
          if (!ok) { rejected++; continue; }
          tokens.push({
            text: word.text,
            confidence: word.confidence,
            /* Reported in the caller's own pixels, not the downscaled ones — the
               caller framed the image and has no idea what we resized it to. */
            bbox: { x0: b.x0 / k, y0: b.y0 / k, x1: b.x1 / k, y1: b.y1 / k },
          });
          /* Union, not a sum of areas: two boxes on the same word (it happens on
             wide letter spacing) must not count their overlap twice. */
          for (let y = Math.max(0, b.y0); y < Math.min(g.height, b.y1); y++) {
            for (let x = Math.max(0, b.x0); x < Math.min(g.width, b.x1); x++) cover[y * g.width + x] = 1;
          }
        }
      }
    }
  }
  let n = 0;
  for (let i = 0; i < area; i++) n += cover[i];
  return { fraction: n / area, tokens, rejected };
}
