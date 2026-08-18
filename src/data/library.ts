import type { Project } from '@engine/types';

/** One row of the plan list — the small, cheap summary the library modal and the
 *  top bar's count read, so that showing twelve plans does not mean parsing
 *  twelve documents.
 *
 *  Every field is a pure derivation of the document. Nothing here is independent
 *  state, which is what lets the same six values be localStorage's index, the
 *  `plans` table's denormalised columns, and the merge key between them without
 *  any of the three being able to disagree about a plan. */

export interface LibraryEntry {
  id: string;
  name: string;
  address: string;
  url: string;
  updatedAt: number;
  nf: number;
  /** true once this plan exists in the account, not only in this browser. The
   *  library shows it, because "saved" meaning two different things depending on
   *  whether you are online is exactly the ambiguity that loses someone's work. */
  synced?: boolean;
}

export function entryOf(p: Project): LibraryEntry {
  return {
    id: p.id,
    name: p.name,
    address: p.source?.address ?? '',
    url: p.source?.url ?? '',
    updatedAt: p.updatedAt,
    nf: p.floors.length,
  };
}

/** Newest first, one entry per id, the newer `updatedAt` winning.
 *
 *  This is the whole conflict-resolution policy in one function, and it is
 *  last-write-wins by the client clock. Two devices editing one plan means the
 *  later save replaces the earlier one wholesale — there is no merge, and the
 *  loser's edits are gone. That is a deliberate trade for an editor that never
 *  blocks on the network; it is not a bug to be fixed by tie-breaking harder. */
export function mergeEntries(...lists: LibraryEntry[][]): LibraryEntry[] {
  const best = new Map<string, LibraryEntry>();
  for (const list of lists) {
    for (const e of list) {
      const prev = best.get(e.id);
      if (!prev) { best.set(e.id, e); continue; }
      const winner = e.updatedAt > prev.updatedAt ? e : prev;
      /* `synced` is not a property of a version, it is a property of the plan —
         so it survives whichever copy loses on the timestamp. */
      best.set(e.id, { ...winner, synced: prev.synced || e.synced });
    }
  }
  return [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
