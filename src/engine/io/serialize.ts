import type { Project } from '../types';
import { migrate } from '../model';
import { uid } from '../geometry';

export const slug = (s: string) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'plan';

/** Accepts anything claiming to be a project and either returns a usable one
 *  or throws — the caller decides how to tell the user. */
export function parseProject(raw: string): Project {
  const p = JSON.parse(raw) as Project;
  if (!p || !Array.isArray(p.floors)) throw new Error('not a Plattegrond Studio project');
  p.id = p.id || uid();
  return migrate(p);
}

export const serializeProject = (p: Project) => JSON.stringify(p, null, 1);
