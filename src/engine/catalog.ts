import type { Pt } from './types';

/** A glyph draws itself in local centimetres, centred on (0,0). `u` is the size
 *  of one screen pixel in world units, so strokes stay hairline at any zoom. */
export type Ctx = CanvasRenderingContext2D;
export type Glyph = (g: Ctx, w: number, h: number, u: number) => void;

export interface CatalogEntry {
  kind: string; name: string; w: number; h: number; draw: Glyph; group: string;
}

/* ── drawing primitives ─────────────────────────────────────────── */
export function rr(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
export const ln = (g: Ctx, x1: number, y1: number, x2: number, y2: number) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
export const ci = (g: Ctx, x: number, y: number, r: number, fill?: number) => { g.beginPath(); g.arc(x, y, r, 0, 6.2832); fill ? g.fill() : g.stroke(); };
export const box = (g: Ctx, w: number, h: number, r?: number) => { rr(g, -w / 2, -h / 2, w, h, r || 2); g.fill(); g.stroke(); };

/* generic glyph builders */
export const G = {
  /* upholstered seat: body + back along top edge + arms */
  seat(g: Ctx, w: number, h: number, back?: number, arm?: number) {
    box(g, w, h, 6);
    g.save(); g.globalAlpha = .5;
    if (back) { rr(g, -w / 2, -h / 2, w, h * .26, 4); g.fill(); }
    if (arm) { rr(g, -w / 2, -h / 2, w * .13, h, 4); g.fill(); rr(g, w / 2 - w * .13, -h / 2, w * .13, h, 4); g.fill(); }
    g.restore();
    if (back) { rr(g, -w / 2, -h / 2, w, h * .26, 4); g.stroke(); }
  },
  bed(g: Ctx, w: number, h: number) {
    box(g, w, h, 3);
    g.save(); g.globalAlpha = .45; rr(g, -w / 2, -h / 2, w, h * .17, 2); g.fill(); g.restore();
    ln(g, -w / 2, -h / 2 + h * .17, w / 2, -h / 2 + h * .17);
    ln(g, -w / 2, -h / 2 + h * .30, w / 2, -h / 2 + h * .30);
    const pw = w > 110 ? w / 2 - 6 : w - 10;
    for (let i = 0; i < (w > 110 ? 2 : 1); i++) {
      const cx = w > 110 ? (i ? w / 4 + 1.5 : -w / 4 - 1.5) : 0;
      rr(g, cx - pw / 2, -h / 2 + 3, pw, h * .11, 3); g.stroke();
    }
  },
  table(g: Ctx, w: number, h: number) { box(g, w, h, 3); },
  round(g: Ctx, w: number) { ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2); },
  chairs(g: Ctx, w: number, h: number, n: number, side?: 'lr') {
    g.save(); g.globalAlpha = .55;
    for (let i = 0; i < n; i++) {
      const t = (i + .5) / n;
      if (side === 'lr') { ci(g, -w / 2 - 22, -h / 2 + t * h, 17, 1); ci(g, w / 2 + 22, -h / 2 + t * h, 17, 1); }
      else { ci(g, -w / 2 + t * w, -h / 2 - 22, 17, 1); ci(g, -w / 2 + t * w, h / 2 + 22, 17, 1); }
    }
    g.restore();
  },
  cabinet(g: Ctx, w: number, h: number, doors?: number) {
    box(g, w, h, 1.5);
    const n = doors || Math.max(1, Math.round(w / 60));
    for (let i = 1; i < n; i++) ln(g, -w / 2 + i * w / n, -h / 2, -w / 2 + i * w / n, h / 2);
    g.save(); g.globalAlpha = .35;
    for (let i = 0; i < n; i++) { const cx = -w / 2 + (i + .5) * w / n; ln(g, cx - w / n * .22, h / 2 - 2, cx + w / n * .22, h / 2 - 2); }
    g.restore();
  },
  /* round pot seen from above: rim, soil, foliage radiating out */
  pot(g: Ctx, w: number, leaves?: number, ruffle?: number) {
    ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2);
    g.save(); g.globalAlpha = .45; ci(g, 0, 0, w * .34); g.restore();
    g.save(); g.globalAlpha = .75;
    const n = leaves || 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832 + (ruffle ? .3 : 0);
      const r0 = w * .12, r1 = w * (ruffle ? .5 : .46);
      g.beginPath();
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.quadraticCurveTo(
        Math.cos(a + .28) * r1 * .7, Math.sin(a + .28) * r1 * .7,
        Math.cos(a) * r1, Math.sin(a) * r1);
      g.stroke();
    }
    g.restore();
  },
  /* concentric rings — bowls, bird baths, fire pits */
  rings(g: Ctx, w: number, n?: number) {
    ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2);
    g.save(); g.globalAlpha = .5;
    for (let i = 1; i < (n || 2); i++) ci(g, 0, 0, w / 2 * (1 - i / (n || 2)));
    g.restore();
  },
  plant(g: Ctx, w: number, ticks?: number) {
    g.save(); g.globalAlpha = .3; ci(g, 0, 0, w / 2, 1); g.restore();
    ci(g, 0, 0, w / 2);
    g.save(); g.globalAlpha = .5;
    const n = ticks || 9;
    for (let i = 0; i < n; i++) { const a = i / n * 6.2832; ln(g, Math.cos(a) * w * .16, Math.sin(a) * w * .16, Math.cos(a) * w * .46, Math.sin(a) * w * .46); }
    g.restore();
  },
};

const RAW: [string, [string, string, number, number, Glyph][]][] = [
  ['Living', [
    ['sofa2',   'Sofa 2-seat', 165,  90, (g, w, h) => G.seat(g, w, h, 1, 1)],
    ['sofa3',   'Sofa 3-seat', 225,  95, (g, w, h) => G.seat(g, w, h, 1, 1)],
    ['sofaL',   'Corner sofa', 265, 200, (g, w, h) => { box(g, w, h, 6); g.save(); g.globalAlpha = .5; rr(g, -w / 2, -h / 2, w, 32, 4); g.fill(); rr(g, -w / 2, -h / 2, 32, h, 4); g.fill(); g.restore(); rr(g, -w / 2 + 32, -h / 2 + 32, w - 32, h - 32, 4); g.stroke(); }],
    ['armchair','Armchair',     88,  88, (g, w, h) => G.seat(g, w, h, 1, 1)],
    ['pouf',    'Pouf',         55,  55, (g, w) => G.round(g, w)],
    ['coffee',  'Coffee table',110,  60, G.table],
    ['sidetbl', 'Side table',   50,  50, (g, w) => G.round(g, w)],
    ['tvstand', 'TV unit',     170,  42, (g, w, h) => G.cabinet(g, w, h)],
    ['tv',      'TV',          120,  10, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .4; rr(g, -w * .12, h / 2, w * .24, 6, 1); g.fill(); g.restore(); }],
    ['shelf',   'Bookshelf',    90,  32, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .35; for (let i = 1; i < 4; i++) ln(g, -w / 2 + i * w / 4, -h / 2, -w / 2 + i * w / 4, h / 2); g.restore(); }],
    ['rug',     'Rug',         240, 170, (g, w, h) => { g.save(); g.setLineDash([9, 6]); box(g, w, h, 4); g.restore(); }],
    ['lamp',    'Floor lamp',   42,  42, (g, w) => { ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .5; ci(g, 0, 0, w / 6, 1); g.restore(); }],
    ['piano',   'Piano',       152, 112, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .45; rr(g, -w / 2 + 4, h / 2 - 16, w * .62, 12, 1); g.fill(); g.restore(); }],
    ['fireplc', 'Fireplace',   120,  35, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .4; rr(g, -w * .28, -h / 2 + 6, w * .56, h - 10, 2); g.fill(); g.restore(); }],
  ]],
  ['Dining', [
    ['dt4',   'Table 4p',  120,  80, (g, w, h) => { G.chairs(g, w, h, 1, 'lr'); G.chairs(g, w, h, 1); G.table(g, w, h); }],
    ['dt6',   'Table 6p',  180,  90, (g, w, h) => { G.chairs(g, w, h, 2); G.chairs(g, w, h, 1, 'lr'); G.table(g, w, h); }],
    ['dt8',   'Table 8p',  220, 100, (g, w, h) => { G.chairs(g, w, h, 3); G.chairs(g, w, h, 1, 'lr'); G.table(g, w, h); }],
    ['dtr',   'Round 6p',  130, 130, (g, w, h) => { G.chairs(g, w * .74, h * .74, 3); G.chairs(g, w * .74, h * .74, 1, 'lr'); G.round(g, w); }],
    ['chair', 'Chair',      46,  48, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .45; rr(g, -w / 2, -h / 2, w, 8, 2); g.fill(); g.restore(); }],
    ['stool', 'Bar stool',  38,  38, (g, w) => G.round(g, w)],
    ['sideb', 'Sideboard', 180,  45, (g, w, h) => G.cabinet(g, w, h, 3)],
    ['bar',   'Bar / island',200, 60, (g, w, h) => { box(g, w, h, 1.5); g.save(); g.globalAlpha = .3; rr(g, -w / 2, h / 2 - 12, w, 12, 1); g.fill(); g.restore(); }],
  ]],
  ['Bedroom', [
    ['bed90',  'Single 90',    90, 200, G.bed],
    ['bed140', 'Double 140',  140, 200, G.bed],
    ['bed160', 'Queen 160',   160, 210, G.bed],
    ['bed180', 'King 180',    180, 210, G.bed],
    ['bunk',   'Bunk bed',     95, 200, (g, w, h) => { G.bed(g, w, h); g.save(); g.globalAlpha = .3; g.setLineDash([6, 5]); box(g, w - 8, h - 8, 2); g.restore(); }],
    ['crib',   'Crib',         70, 140, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .35; box(g, w - 12, h - 12, 2); g.restore(); }],
    ['nstand', 'Nightstand',   46,  42, (g, w, h) => G.cabinet(g, w, h, 1)],
    ['wardr',  'Wardrobe',    160,  62, (g, w, h) => G.cabinet(g, w, h)],
    ['dresser','Dresser',     110,  50, (g, w, h) => G.cabinet(g, w, h, 3)],
    ['desk',   'Desk',        140,  70, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .3; rr(g, -w / 2 + 6, h / 2 - 14, w * .3, 10, 1); g.fill(); g.restore(); }],
    ['ochair', 'Office chair', 60,  60, (g, w, h) => { G.round(g, w); g.save(); g.globalAlpha = .45; rr(g, -w / 2, -h / 2, w, 10, 4); g.fill(); g.restore(); }],
    ['mirror', 'Mirror',       80,   6, (g, w, h) => { box(g, w, h, 1); }],
  ]],
  ['Kitchen', [
    ['kcount', 'Counter run', 120,  62, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .28; rr(g, -w / 2, -h / 2, w, 8, 1); g.fill(); g.restore(); }],
    ['kcorner','Corner unit',  62,  62, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .3; g.beginPath(); g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, h / 2); g.stroke(); g.restore(); }],
    ['kisland','Island',      200, 100, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .25; box(g, w - 14, h - 14, 1); g.restore(); }],
    ['sink',   'Sink',         80,  60, (g, w, h) => { box(g, w, h, 2); rr(g, -w / 2 + 7, -h / 2 + 8, w - 14, h - 20, 3); g.stroke(); g.save(); g.globalAlpha = .5; ci(g, 0, h / 2 - 6, 3, 1); g.restore(); }],
    ['sink2',  'Double sink', 120,  60, (g, w, h) => { box(g, w, h, 2); rr(g, -w / 2 + 6, -h / 2 + 8, w / 2 - 10, h - 20, 3); g.stroke(); rr(g, 4, -h / 2 + 8, w / 2 - 10, h - 20, 3); g.stroke(); }],
    ['hob',    'Hob',          62,  60, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .5; ci(g, -w * .19, -h * .19, w * .13); ci(g, w * .19, -h * .19, w * .13); ci(g, -w * .19, h * .19, w * .13); ci(g, w * .19, h * .19, w * .13); g.restore(); }],
    ['oven',   'Oven',         62,  62, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .4; box(g, w - 14, h - 20, 2); g.restore(); }],
    ['fridge', 'Fridge',       70,  70, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .35; ln(g, -w / 2, h * .08, w / 2, h * .08); g.restore(); }],
    ['fridge2','Am. fridge',   95,  75, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .35; ln(g, 0, -h / 2, 0, h / 2); g.restore(); }],
    ['dishw',  'Dishwasher',   62,  62, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .35; rr(g, -w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 2); g.stroke(); g.restore(); }],
    ['hood',   'Extractor',    92,  50, (g, w, h) => { g.save(); g.setLineDash([7, 5]); box(g, w, h, 2); g.restore(); }],
    ['pantry', 'Tall cabinet', 62,  62, (g, w, h) => { G.cabinet(g, w, h, 1); g.save(); g.globalAlpha = .3; ln(g, -w / 2, -h / 2, w / 2, h / 2); ln(g, w / 2, -h / 2, -w / 2, h / 2); g.restore(); }],
  ]],
  ['Bathroom', [
    ['toilet',  'Toilet',      40,  68, (g, w, h) => { rr(g, -w / 2, -h / 2, w, h * .3, 2); g.fill(); g.stroke(); g.beginPath(); g.ellipse(0, h * .12, w / 2, h * .33, 0, 0, 6.2832); g.fill(); g.stroke(); }],
    ['basin',   'Basin',       62,  50, (g, w, h) => { box(g, w, h, 3); g.beginPath(); g.ellipse(0, 2, w * .34, h * .27, 0, 0, 6.2832); g.stroke(); }],
    ['basin2',  'Double basin',130, 52, (g, w, h) => { box(g, w, h, 3); g.beginPath(); g.ellipse(-w * .23, 2, w * .16, h * .27, 0, 0, 6.2832); g.stroke(); g.beginPath(); g.ellipse(w * .23, 2, w * .16, h * .27, 0, 0, 6.2832); g.stroke(); }],
    ['bath',    'Bathtub',    172,  76, (g, w, h) => { box(g, w, h, 6); rr(g, -w / 2 + 8, -h / 2 + 7, w - 22, h - 14, 12); g.stroke(); g.save(); g.globalAlpha = .5; ci(g, w / 2 - 12, 0, 3, 1); g.restore(); }],
    ['shower',  'Shower',      92,  92, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .4; ln(g, -w / 2, -h / 2, w / 2, h / 2); ln(g, w / 2, -h / 2, -w / 2, h / 2); g.restore(); ci(g, 0, 0, 7); }],
    ['showerW', 'Walk-in show',140, 92, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .4; for (let i = -3; i <= 3; i++) ln(g, i * w / 8, -h / 2, i * w / 8 + h / 3, h / 2); g.restore(); }],
    ['washer',  'Washer',      62,  62, (g, w, h) => { box(g, w, h, 2); ci(g, 0, 0, w * .28); }],
    ['dryer',   'Dryer',       62,  62, (g, w, h) => { box(g, w, h, 2); ci(g, 0, 0, w * .28); g.save(); g.globalAlpha = .4; ci(g, 0, 0, w * .16); g.restore(); }],
    ['radiator','Radiator',   100,  10, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .4; for (let i = 1; i < 10; i++) ln(g, -w / 2 + i * w / 10, -h / 2, -w / 2 + i * w / 10, h / 2); g.restore(); }],
    ['towel',   'Towel rail',  60,   8, (g, w, h) => box(g, w, h, 2)],
  ]],
  ['Structure', [
    ['stairU',  'Stairs',     105, 260, (g, w, h) => { box(g, w, h, 0); const n = Math.max(3, Math.round(h / 26)); g.save(); g.globalAlpha = .5; for (let i = 1; i < n; i++) ln(g, -w / 2, -h / 2 + i * h / n, w / 2, -h / 2 + i * h / n); g.restore(); g.save(); g.globalAlpha = .8; g.beginPath(); g.moveTo(0, h / 2 - 8); g.lineTo(0, -h / 2 + 8); g.stroke(); g.beginPath(); g.moveTo(-7, -h / 2 + 20); g.lineTo(0, -h / 2 + 8); g.lineTo(7, -h / 2 + 20); g.stroke(); g.restore(); }],
    ['stairS',  'Spiral stair',150,150, (g, w, h) => { ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .5; for (let i = 0; i < 12; i++) { const a = i / 12 * 6.2832; ln(g, Math.cos(a) * 12, Math.sin(a) * 12, Math.cos(a) * w / 2, Math.sin(a) * w / 2); } g.restore(); ci(g, 0, 0, 12); }],
    ['column',  'Column',      32,  32, (g, w, h) => { box(g, w, h, 1); }],
    ['colR',    'Round column',34,  34, (g, w) => G.round(g, w)],
    ['duct',    'Shaft / duct',60,  40, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .45; ln(g, -w / 2, -h / 2, w / 2, h / 2); ln(g, w / 2, -h / 2, -w / 2, h / 2); g.restore(); }],
    ['hatch',   'Roof hatch',  70,  90, (g, w, h) => { g.save(); g.setLineDash([8, 6]); box(g, w, h, 1); g.restore(); }],
    ['meter',   'Meter box',   60,  40, (g, w, h) => { box(g, w, h, 1); }],
  ]],
  ['Decoration', [
    ['potS',     'Plant pot',      36,  36, (g, w) => G.pot(g, w, 6)],
    ['potM',     'Plant, medium',  55,  55, (g, w) => G.pot(g, w, 7)],
    ['potL',     'Plant, large',   85,  85, (g, w) => G.pot(g, w, 9, 1)],
    ['potXL',    'Statement plant',120,120, (g, w) => G.pot(g, w, 11, 1)],
    ['potTall',  'Tall plant',     60,  60, (g, w) => { G.pot(g, w, 5); g.save(); g.globalAlpha = .5; ci(g, 0, 0, w * .13); g.restore(); }],
    ['potTrio',  'Pot cluster',   110,  70, (g, w, h) => { G.pot(g, Math.min(w, h) * .62, 6); g.save(); g.translate(w * .3, h * .18); G.pot(g, Math.min(w, h) * .42, 5); g.restore(); g.save(); g.translate(-w * .28, h * .22); G.pot(g, Math.min(w, h) * .34, 5); g.restore(); }],
    ['hangPlant','Hanging plant',  40,  40, (g, w) => { g.save(); g.setLineDash([4, 4]); ci(g, 0, 0, w / 2); g.restore(); G.pot(g, w * .74, 7); }],
    ['planterBox','Planter box',  120,  35, (g, w, h) => { box(g, w, h, 3); const n = Math.max(2, Math.round(w / 45)); for (let i = 0; i < n; i++) { g.save(); g.translate(-w / 2 + (i + .5) * w / n, 0); G.pot(g, Math.min(h * .8, w / n * .8), 6); g.restore(); } }],
    ['vase',     'Vase',           26,  26, (g, w) => G.rings(g, w, 2)],
    ['bowl',     'Bowl',           34,  34, (g, w) => G.rings(g, w, 3)],
    ['rugRound', 'Round rug',     200, 200, (g, w) => { g.save(); g.setLineDash([10, 7]); ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2); g.restore(); g.save(); g.globalAlpha = .4; ci(g, 0, 0, w / 2 - 14); g.restore(); }],
    ['art',      'Artwork',        90,   5, (g, w, h) => { box(g, w, h, 1); }],
    ['mirrorW',  'Wall mirror',    70,   5, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .45; ln(g, -w / 2 + 5, 0, w / 2 - 5, 0); g.restore(); }],
    ['clock',    'Clock',          32,  32, (g, w) => { ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .7; ln(g, 0, 0, 0, -w * .3); ln(g, 0, 0, w * .22, 0); g.restore(); }],
    ['sculpt',   'Sculpture',      40,  40, (g, w, h) => { g.save(); g.globalAlpha = .35; box(g, w, h, 3); g.restore(); ci(g, 0, 0, w * .3); }],
    ['candles',  'Candles',        24,  24, (g, w) => { ci(g, -w * .22, 0, w * .16); ci(g, w * .18, w * .1, w * .12); }],
    ['screen',   'Room divider',  160,  22, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .45; for (let i = 1; i < 4; i++) ln(g, -w / 2 + i * w / 4, -h / 2, -w / 2 + i * w / 4, h / 2); g.restore(); }],
    ['coatrack', 'Coat rack',      45,  45, (g, w) => { ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .55; for (let i = 0; i < 5; i++) { const a = i / 5 * 6.2832; ci(g, Math.cos(a) * w * .34, Math.sin(a) * w * .34, w * .09, 1); } g.restore(); }],
    ['basket',   'Basket',         45,  45, (g, w) => G.rings(g, w, 2)],
    ['petbed',   'Pet bed',        70,  55, (g, w, h) => { g.beginPath(); g.ellipse(0, 0, w / 2, h / 2, 0, 0, 6.2832); g.fill(); g.stroke(); g.save(); g.globalAlpha = .45; g.beginPath(); g.ellipse(0, 0, w / 2 - 8, h / 2 - 7, 0, 0, 6.2832); g.stroke(); g.restore(); }],
    ['shoerack', 'Shoe rack',      80,  32, (g, w, h) => G.cabinet(g, w, h, 3)],
  ]],
  ['Garden', [
    ['gpotR',    'Round planter',  80,  80, (g, w) => G.pot(g, w, 8, 1)],
    ['gpotXL',   'Large pot',     130, 130, (g, w) => G.pot(g, w, 10, 1)],
    ['bedRound', 'Round bed',     260, 260, (g, w) => { g.save(); g.globalAlpha = .22; ci(g, 0, 0, w / 2); g.fill(); g.restore(); g.save(); g.setLineDash([10, 7]); ci(g, 0, 0, w / 2); g.restore(); g.save(); g.globalAlpha = .55; for (let i = 0; i < 8; i++) { const a = i / 8 * 6.2832; ci(g, Math.cos(a) * w * .28, Math.sin(a) * w * .28, w * .09); } g.restore(); }],
    ['firepit',  'Fire pit',      100, 100, (g, w) => { G.rings(g, w, 3); g.save(); g.globalAlpha = .8; for (let i = 0; i < 6; i++) { const a = i / 6 * 6.2832; ln(g, Math.cos(a) * w * .1, Math.sin(a) * w * .1, Math.cos(a) * w * .22, Math.sin(a) * w * .22); } g.restore(); }],
    ['birdbath', 'Bird bath',      70,  70, (g, w) => G.rings(g, w, 3)],
    ['water',    'Water feature', 160, 160, (g, w) => { g.save(); g.globalAlpha = .3; ci(g, 0, 0, w / 2); g.fill(); g.restore(); ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .5; ci(g, 0, 0, w * .3); ci(g, 0, 0, w * .15); g.restore(); }],
    ['lantern',  'Garden lantern', 28,  28, (g, w) => { ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2); }],
    ['hammock',  'Hammock',       300, 110, (g, w, h) => { g.beginPath(); g.ellipse(0, 0, w / 2, h / 2, 0, 0, 6.2832); g.fill(); g.stroke(); g.save(); g.globalAlpha = .45; for (let i = -3; i <= 3; i++) ln(g, i * w / 9, -h / 2 + 10, i * w / 9, h / 2 - 10); g.restore(); }],
    ['swing',    'Swing seat',    180, 120, (g, w, h) => { g.save(); g.setLineDash([7, 5]); box(g, w, h, 6); g.restore(); rr(g, -w / 2 + 12, h / 2 - 34, w - 24, 26, 6); g.fill(); g.stroke(); }],
    ['sandbox',  'Sandpit',       150, 150, (g, w, h) => { box(g, w, h, 4); g.save(); g.globalAlpha = .3; for (let i = 1; i < 6; i++) ln(g, -w / 2 + i * w / 6, -h / 2, -w / 2 + i * w / 6, h / 2); g.restore(); }],
    ['compost',  'Compost bin',    80,  80, (g, w, h) => { box(g, w, h, 4); g.save(); g.globalAlpha = .35; ci(g, 0, 0, w * .3); g.restore(); }],
    ['barrel',   'Rain barrel',    62,  62, (g, w) => G.rings(g, w, 2)],
    ['stepstone','Stepping stones',60, 240, (g, w, h) => { const n = Math.max(2, Math.round(h / 60)); for (let i = 0; i < n; i++) { g.save(); g.translate((i % 2 ? 1 : -1) * w * .16, -h / 2 + (i + .5) * h / n); g.beginPath(); g.ellipse(0, 0, w * .34, h / n * .3, 0, 0, 6.2832); g.fill(); g.stroke(); g.restore(); } }],
  ]],
  ['Garden extras', [
    ['gtable',  'Garden table',160, 95, (g, w, h) => { G.chairs(g, w, h, 2); G.chairs(g, w, h, 1, 'lr'); G.table(g, w, h); }],
    ['lounger', 'Lounger',      200, 72, (g, w, h) => { box(g, w, h, 8); g.save(); g.globalAlpha = .4; rr(g, -w / 2, -h / 2, w * .3, h, 6); g.fill(); g.restore(); }],
    ['loungeSet','Lounge set',  260, 230, (g, w, h) => { g.save(); g.setLineDash([8, 6]); box(g, w, h, 6); g.restore(); g.save(); g.globalAlpha = .45; rr(g, -w / 2 + 8, -h / 2 + 8, w - 16, 70, 6); g.fill(); rr(g, -w / 2 + 8, h / 2 - 78, w * .5, 70, 6); g.fill(); g.restore(); }],
    ['parasol', 'Parasol',      270, 270, (g, w) => { g.save(); g.globalAlpha = .22; ci(g, 0, 0, w / 2, 1); g.restore(); g.save(); g.setLineDash([7, 5]); ci(g, 0, 0, w / 2); g.restore(); ci(g, 0, 0, 8); }],
    ['bbq',     'BBQ',          120, 65, (g, w, h) => { box(g, w, h, 4); g.save(); g.globalAlpha = .4; for (let i = 1; i < 6; i++) ln(g, -w / 2 + i * w / 6, -h / 2 + 5, -w / 2 + i * w / 6, h / 2 - 5); g.restore(); }],
    ['bench',   'Bench',        160, 48, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .45; rr(g, -w / 2, -h / 2, w, 12, 2); g.fill(); g.restore(); }],
    ['tree',    'Tree',         420, 420, (g, w) => G.plant(g, w, 11)],
    ['treeS',   'Small tree',   240, 240, (g, w) => G.plant(g, w, 9)],
    ['shrub',   'Shrub',        120, 120, (g, w) => G.plant(g, w, 7)],
    ['hedge',   'Hedge',        300,  55, (g, w, h) => { g.save(); g.globalAlpha = .28; rr(g, -w / 2, -h / 2, w, h, h / 2); g.fill(); g.restore(); const n = Math.max(2, Math.round(w / 55)); for (let i = 0; i < n; i++) { ci(g, -w / 2 + (i + .5) * w / n, 0, h / 2); } }],
    ['planter', 'Planter',      110,  42, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .35; box(g, w - 12, h - 12, 2); g.restore(); }],
    ['bedPlant','Planting bed', 400, 150, (g, w, h) => { g.save(); g.globalAlpha = .2; box(g, w, h, 12); g.restore(); g.save(); g.setLineDash([10, 7]); rr(g, -w / 2, -h / 2, w, h, 12); g.stroke(); g.globalAlpha = .5; g.setLineDash([]); for (let i = 0; i < 7; i++) { const x = -w / 2 + (i + .5) * w / 7; ci(g, x, i % 2 ? -h * .18 : h * .18, Math.min(h, w / 7) * .22); } g.restore(); }],
    ['lawn',    'Lawn',         600, 400, (g, w, h) => { g.save(); g.globalAlpha = .18; box(g, w, h, 8); g.globalAlpha = .35; g.setLineDash([4, 14]); for (let i = 1; i < 12; i++) ln(g, -w / 2 + i * w / 12, -h / 2 + 6, -w / 2 + i * w / 12, h / 2 - 6); g.restore(); }],
    ['terrace', 'Terrace',      500, 350, (g, w, h) => { box(g, w, h, 2); g.save(); g.globalAlpha = .3; const s = 60; for (let x = -w / 2 + s; x < w / 2; x += s) ln(g, x, -h / 2, x, h / 2); for (let y = -h / 2 + s; y < h / 2; y += s) ln(g, -w / 2, y, w / 2, y); g.restore(); }],
    ['pool',    'Pool',         800, 400, (g, w, h) => { box(g, w, h, 25); g.save(); g.globalAlpha = .4; rr(g, -w / 2 + 14, -h / 2 + 14, w - 28, h - 28, 16); g.stroke(); g.restore(); }],
    ['tramp',   'Trampoline',   360, 360, (g, w) => { ci(g, 0, 0, w / 2); g.fill(); ci(g, 0, 0, w / 2); g.save(); g.globalAlpha = .45; ci(g, 0, 0, w / 2 - 22); g.restore(); }],
    ['shed',    'Shed',         300, 250, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .35; ln(g, -w / 2, -h / 2, w / 2, h / 2); g.restore(); }],
    ['pergola', 'Pergola',      400, 320, (g, w, h) => { g.save(); g.setLineDash([12, 8]); box(g, w, h, 2); g.restore(); g.save(); g.globalAlpha = .45; for (let i = 1; i < 7; i++) ln(g, -w / 2 + i * w / 7, -h / 2, -w / 2 + i * w / 7, h / 2); g.restore(); [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { g.save(); g.globalAlpha = .9; rr(g, a * w / 2 - (a > 0 ? 14 : 0), b * h / 2 - (b > 0 ? 14 : 0), 14, 14, 1); g.fill(); g.stroke(); g.restore(); }); }],
    ['fence',   'Fence',        400,  12, (g, w, h) => { box(g, w, h, 1); g.save(); g.globalAlpha = .5; const n = Math.max(1, Math.round(w / 40)); for (let i = 0; i <= n; i++) ci(g, -w / 2 + i * w / n, 0, Math.min(4, h / 2), 1); g.restore(); }],
    ['path',    'Path',         300,  90, (g, w, h) => { g.save(); g.globalAlpha = .2; box(g, w, h, 4); g.globalAlpha = .45; const s = 45; for (let x = -w / 2 + s; x < w / 2; x += s) ln(g, x, -h / 2, x, h / 2); g.restore(); }],
    ['bin',     'Wheelie bin',   70,  60, (g, w, h) => { box(g, w, h, 3); g.save(); g.globalAlpha = .35; ln(g, -w / 2, -h / 2 + 12, w / 2, -h / 2 + 12); g.restore(); }],
    ['bike',    'Bike',         180,  60, (g, w, h) => { ci(g, -w / 2 + 32, 0, 30); ci(g, w / 2 - 32, 0, 30); g.save(); g.globalAlpha = .6; ln(g, -w / 2 + 32, 0, w / 2 - 32, 0); g.restore(); }],
    ['car',     'Car',          450, 190, (g, w, h) => { box(g, w, h, 26); g.save(); g.globalAlpha = .35; rr(g, -w * .16, -h / 2 + 12, w * .42, h - 24, 14); g.fill(); g.restore(); }],
  ]],
];

export const GROUP_TONE: Record<string, string> = { Living: '#C7A44E', Dining: '#C7A44E', Bedroom: '#B08BB0', Kitchen: '#8FA9C4',
  Bathroom: '#6FA8B5', Structure: '#8C857A', Garden: '#7E9B5B', 'Garden extras': '#7E9B5B', Decoration: '#8FA98F' };
export const SWATCHES = ['#C7A44E', '#E4632C', '#B08BB0', '#8FA9C4', '#6FA8B5', '#7E9B5B', '#8C857A', '#D14B45', '#5E6B7E', '#A8794E'];
export const ROOM_SWATCHES = ['#E4DCC5', '#C6B9AA', '#D6C7B4', '#C9D3C0', '#BFCBD4', '#D8C5C5', '#DCDCDC', '#CFC7B8', '#C4CFCB', '#E2D6BC'];

export const CATALOG: { group: string; items: CatalogEntry[] }[] = RAW.map(([group, list]) => ({
  group,
  items: list.map(([kind, name, w, h, draw]) => ({ kind, name, w, h, draw, group })),
}));

export const CAT_BY_KIND: Record<string, CatalogEntry> = Object.fromEntries(
  CATALOG.flatMap(g => g.items.map(i => [i.kind, i])),
);

export const toneFor = (e?: CatalogEntry): string => (e && GROUP_TONE[e.group]) || '#8C857A';
