import type { Project } from '@engine/types';
import { mergeEntries, type LibraryEntry } from '@data/library';
import {
  fetchCloudPlan, listCloudPlans, removeAllCloudPlans, removeCloudPlan, unsyncable,
} from '@data/sync';
import { clearLibrary, deleteProject, loadProject, putProject, readIndex, writeIndex } from './storage';

/** The library, as the UI is allowed to see it: one list, whether or not there
 *  is an account behind it.
 *
 *  Everything here is async because the remote half is, and nothing here waits
 *  on the network when it does not have to — the local copy answers first and
 *  the account is only asked when it might know something this browser does not.
 *  In local mode every cloud call below returns empty or does nothing, so these
 *  are four thin wrappers over exactly the synchronous code that was here
 *  before. */

/** Both halves, merged, newest first — and written back to the local index, so
 *  the synchronous readers (the top bar's count, boot's saved/dirty decision)
 *  see the account's plans too rather than half a library.
 *
 *  Never throws: a library that is briefly missing its cloud half is survivable,
 *  a modal that explodes on open is not. Offline is indistinguishable from an
 *  empty account here, and that is fine — the local rows are still right. */
export async function libraryList(): Promise<LibraryEntry[]> {
  const local = readIndex();
  const cloud = await listCloudPlans();
  if (!cloud.length) return local;
  const merged = mergeEntries(local, cloud);
  /* A plan the account holds an old copy of, whose current version is too big to
     push, is not synced — and it is the one plan where believing the badge loses
     work, because signing out clears the local copy that has the newer version.
     `listCloudPlans` cannot know this; only the pusher that gave up does. */
  const stuck = unsyncable();
  const marked = stuck.size ? merged.map(e => (stuck.has(e.id) ? { ...e, synced: false } : e)) : merged;
  writeIndex(marked);
  return marked;
}

/** One document. The local blob wins unless the index — the merged one
 *  `libraryList` wrote — says the account holds something newer, which is the
 *  only case that costs a round trip. No account, offline, or a plan that only
 *  ever lived here: never touches the network.
 *
 *  A copy fetched from the account is cached on the way through, so the second
 *  open is instant and so closing the laptop lid does not take the plan with it. */
export async function openPlan(id: string): Promise<Project | null> {
  const local = loadProject(id);
  const known = readIndex().find(x => x.id === id);
  if (local && !(known && known.updatedAt > local.updatedAt)) return local;

  const remote = await fetchCloudPlan(id);
  if (!remote) return local;
  try { putProject(remote); } catch { /* quota — it still opens, it is just not cached */ }
  return remote;
}

/** Gone from this browser and gone from the account. The local delete happens
 *  first and synchronously: the row has to leave the list even if the tombstone
 *  never lands, otherwise a delete looks like it failed and gets pressed twice. */
export async function removePlan(id: string): Promise<void> {
  deleteProject(id);
  await removeCloudPlan(id);
}

export async function wipeLibrary(): Promise<void> {
  clearLibrary();
  await removeAllCloudPlans();
}
