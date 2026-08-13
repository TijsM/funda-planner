import type { Fml } from '@engine/io/funda';
import { FML_BASE, fmlToProject, parseFundaSource } from '@engine/io/funda';
import { ed } from '@state/store';

/** Network access, kept out of the engine. This is the first thing that moves
 *  to a server route: it removes the third-party proxy and the per-user rate
 *  limit, and lets the derived geometry be cached. */

const READER = 'https://r.jina.ai/';

export interface Step { t: string; d?: string; k?: '' | 'run' | 'ok' | 'err' }

export async function readListing(url: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch(READER + url, { headers: { 'x-respond-with': 'html' } });
  } catch {
    throw new Error(
      'The browser blocked the request to the reader proxy'
      + (location.protocol === 'file:'
        ? ' — this page is open as a file://. Serve it over http instead, or use "Paste page source" below.'
        : ' (network or CORS). Use "Paste page source" below.'),
    );
  }
  if (r.status === 429) {
    throw new Error('The reader proxy is rate-limiting (HTTP 429). Wait a minute, or use "Paste page source".');
  }
  if (!r.ok) throw new Error(`Reader proxy returned HTTP ${r.status}. Try "Paste page source" instead.`);
  const txt = await r.text();
  if (txt.length < 2000) throw new Error('Reader proxy returned an almost-empty page. Try "Paste page source".');
  return txt;
}

export async function fetchFml(projectId: number): Promise<Fml> {
  const r = await fetch(`${FML_BASE}${projectId}.fml`);
  if (!r.ok) throw new Error(`Floorplanner project ${projectId} not public (HTTP ${r.status})`);
  return (await r.json()) as Fml;
}

/** Drives the whole import, reporting each stage so a failure says which part
 *  broke and what to do instead. */
export async function importFromUrl(url: string, onSteps: (s: Step[]) => void): Promise<boolean> {
  const steps: Step[] = [
    { t: 'Reading the listing page', k: 'run' },
    { t: 'Locating the Floorplanner project' },
    { t: 'Downloading vector geometry' },
    { t: 'Building the editable plan' },
  ];
  onSteps([...steps]);

  let html: string;
  try {
    html = await readListing(url);
  } catch (e) {
    steps[0] = { t: 'Reading the listing page', k: 'err', d: (e as Error).message };
    onSteps([...steps]);
    return false;
  }
  steps[0] = { t: 'Listing page read', k: 'ok', d: `${(html.length / 1024).toFixed(0)} KB via r.jina.ai` };
  steps[1].k = 'run';
  onSteps([...steps]);

  const meta = { ...parseFundaSource(html), url };
  if (!meta.projectId) {
    steps[1] = {
      t: 'No Floorplanner project on this listing', k: 'err',
      d: 'This listing has no interactive floor plan. Drop the floor-plan image instead and trace it.',
    };
    onSteps([...steps]);
    return false;
  }
  steps[1] = {
    t: `Found project ${meta.projectId}`, k: 'ok',
    d: meta.plans.length ? `${meta.plans.length} plan(s): ${meta.plans.map(p => p.name).filter(Boolean).join(', ')}` : '',
  };
  steps[2].k = 'run';
  onSteps([...steps]);

  let fml: Fml;
  try {
    fml = await fetchFml(meta.projectId);
  } catch (e) {
    steps[2] = { t: 'Downloading vector geometry', k: 'err', d: (e as Error).message };
    onSteps([...steps]);
    return false;
  }
  steps[2] = {
    t: 'Vector geometry downloaded', k: 'ok',
    d: `${(fml.floors ?? []).length} floor(s) · ${(JSON.stringify(fml).length / 1024).toFixed(0)} KB`,
  };
  steps[3].k = 'run';
  onSteps([...steps]);

  try {
    const p = fmlToProject(fml, meta);
    const nw = p.floors.reduce((s, f) => s + f.walls.length, 0);
    const no = p.floors.reduce((s, f) => s + f.walls.reduce((t, w) => t + w.openings.length, 0), 0);
    const nf = p.floors.reduce((s, f) => s + f.items.length, 0);
    steps[3] = {
      t: 'Ready', k: 'ok',
      d: `${p.floors.length} floors · ${nw} walls · ${no} doors/windows · ${nf} fitted objects`,
    };
    onSteps([...steps]);
    setTimeout(() => {
      ed().setProject(p);
      ed().patch({ modal: null });
      ed().toast(`Imported ${p.floors.length} floor(s) from Funda — everything is editable.`, 'ok');
    }, 420);
    return true;
  } catch (e) {
    steps[3] = { t: 'Building the editable plan', k: 'err', d: (e as Error).message };
    onSteps([...steps]);
    return false;
  }
}

/** the fallback when the proxy is unusable: the user pastes the page source */
export async function importFromSource(src: string, onSteps: (s: Step[]) => void): Promise<boolean> {
  onSteps([{ t: 'Parsing pasted source', k: 'run' }]);
  const meta = parseFundaSource(src);
  if (!meta.projectId) {
    onSteps([{
      t: 'No Floorplanner project found in that source', k: 'err',
      d: 'Make sure you copied the full HTML of the listing detail page.',
    }]);
    return false;
  }
  onSteps([{ t: `Found project ${meta.projectId}`, k: 'ok' }, { t: 'Downloading vector geometry', k: 'run' }]);
  try {
    const fml = await fetchFml(meta.projectId);
    const p = fmlToProject(fml, meta);
    onSteps([
      { t: `Found project ${meta.projectId}`, k: 'ok' },
      { t: `Ready — ${p.floors.length} floor(s)`, k: 'ok' },
    ]);
    setTimeout(() => {
      ed().setProject(p);
      ed().patch({ modal: null });
      ed().toast('Imported from pasted source.', 'ok');
    }, 380);
    return true;
  } catch (e) {
    onSteps([{ t: 'Download failed', k: 'err', d: (e as Error).message }]);
    return false;
  }
}
