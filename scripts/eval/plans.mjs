/** The fixture plans the sweep runs over, and the one piece of plumbing every
 *  other eval script needs to reach the engine.
 *
 *  Node 24 strips the types out of a .ts file on its own, but it will not
 *  resolve the extensionless specifiers those files use ('./geometry',
 *  '@engine/model') — so importing src/engine straight from a .mjs dies on the
 *  first hop. `registerHooks` is the whole fix: it rewrites a specifier only
 *  when the file it names does not exist and a .ts sibling does, and otherwise
 *  hands the request on untouched, so it cannot disturb Vitest's own resolver
 *  when this module is imported from a test.
 *
 *  Every eval script should reach the engine through `engine()` below rather
 *  than registering a second copy of the hook.
 */
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../../', import.meta.url);

const ALIAS = {
  '@engine': 'src/engine', '@shell': 'src/shell', '@state': 'src/state',
  '@data': 'src/data', '@server': 'src/server',
};

/** The file a specifier means, or null when it is already resolvable. TypeScript
 *  writes './model' for what is on disk as './model.ts', and a directory import
 *  for what is './index.ts'. */
function tsFileFor(spec, parentURL) {
  let s = spec;
  for (const [a, dir] of Object.entries(ALIAS)) {
    if (s === a || s.startsWith(`${a}/`)) s = new URL(`${dir}${s.slice(a.length)}`, ROOT).href;
  }
  if ((s.startsWith('./') || s.startsWith('../')) && parentURL) s = new URL(s, parentURL).href;
  if (!s.startsWith('file:')) return null;
  const p = fileURLToPath(s);
  if (existsSync(p) && !p.endsWith('.ts')) return null;
  for (const c of [p, `${p}.ts`, `${p}/index.ts`]) if (c.endsWith('.ts') && existsSync(c)) return c;
  return null;
}

registerHooks({
  resolve(spec, ctx, next) {
    const file = tsFileFor(spec, ctx.parentURL);
    /* `format` is not decoration: without it Node reparses every engine file as
       CommonJS first, fails, and prints a MODULE_TYPELESS_PACKAGE_JSON warning
       over the harness output for each one. */
    return file
      ? { url: pathToFileURL(file).href, format: 'module-typescript', shortCircuit: true }
      : next(spec, ctx);
  },
});

/** Import a module from src/engine, e.g. `await engine('frame.ts')`. */
export const engine = rel => import(new URL(`src/engine/${rel}`, ROOT).href);
/** Import anything else in the tree by repo-relative path, e.g. 'src/data/providers.ts'. */
export const fromRoot = rel => import(new URL(rel, ROOT).href);

const { parseProject } = await engine('io/serialize.ts');

const DIR = new URL('tests/fixtures/eval/', ROOT);

/** What each plan is in the set for. The sweep reports per plan, so a score that
 *  falls only on `openplan-tables` is a chair-counting regression and a score
 *  that falls only on `nl-ground-garden` is about unmapped rooms — which is the
 *  whole reason the set is ten hand-picked floors rather than one big one. */
export const PLANS = [
  { id: 'studio-26', catches: 'a 26 m² studio: one room doing every job at once, and a 4.4 m² bathroom small enough that a render likes to swallow it.' },
  { id: 'studio-souterrain', catches: 'a 43 m² souterrain studio with a straight staircase — the block a render turns into a corridor when the text does not name it.' },
  { id: 'nl-ground', catches: 'the real .fml ground floor of a Dutch terraced house: hal, keuken, woonkamer, toilet, and fifteen anonymous fitted blocks.' },
  { id: 'nl-ground-garden', catches: 'the same ground floor with the garden drawn, so the drawn rooms cover 54% of the footprint — just under the 55% planFacts asks for, which makes this the marginal mapped:false case.' },
  { id: 'nl-first', catches: 'three bedrooms, a bathroom and a toilet off one landing: six ranked rooms, which is where rank-decay should show first.' },
  { id: 'nl-second', catches: 'an attic floor whose two bedrooms are within 0.1 m² of each other — the rank order is decided by a hair.' },
  { id: 'openplan-tables', catches: 'one undivided 90 m² floor with four tables and twenty chairs: the count the model rounds up.' },
  { id: 'unmapped-open', catches: 'a 94 m² shell with one 4 m² berging drawn and everything else loose on the floor — the other mapped:false case, and the only plan where most objects belong to no room.' },
  { id: 'house-jaren30', catches: 'a jaren-30 house ground floor: five rooms, a staircase in the hall and a fireplace against the front wall.' },
  { id: 'house-unnamed', catches: 'four rooms drawn and none of them named, so the prompt lists no rooms at all and every sidecar rank is null.' },
];

/** The JSDoc types are load-bearing: these modules are imported from a strict
 *  .ts test, and an untyped export makes every callback in it an implicit any.
 *
 *  @typedef {{ id: string, catches: string,
 *              project: import('@engine/types').Project,
 *              floor: import('@engine/types').Floor }} Plan
 */

/** One plan, parsed through the app's own loader so the fixtures are proven to
 *  be real project files rather than something only the harness can read.
 *  @param {string} id @returns {Plan} */
export function loadPlan(id) {
  const entry = PLANS.find(p => p.id === id);
  if (!entry) throw new Error(`no eval fixture named ${id}`);
  const project = parseProject(readFileSync(new URL(`${id}.json`, DIR), 'utf8'));
  /* One floor per fixture: a plan is what gets framed and rendered, and a
     project with three floors is three plans wearing one name. */
  return { id, catches: entry.catches, project, floor: project.floors[0] };
}

/** @returns {Plan[]} */
export const plans = () => PLANS.map(p => loadPlan(p.id));
