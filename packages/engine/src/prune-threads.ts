/** What prune's comment threads keep (prune.ts): the renders and takes they name, and what stays because some do not read. */
import type { LoadedProject } from '@retake/core/project';
import { parseRenderId, runIdOfScenario } from '@retake/core/ids';
import { projectRef } from '@retake/core/project';
import { listCommentsAndUnread } from './comments/views.js';
import type { Outputs } from './outputs/outputs.js';
import type { ProjectStores } from './store/store.js';

/** What prune reads and deletes through: the outputs port, and the stores port's folders (the threads' scenario text). */
export interface PrunePorts {
  outputs: Outputs;
  stores: Pick<ProjectStores, 'folder'>;
}

/** What the comment threads keep: the renders and takes they name, and what stays because some do not read. */
export interface ThreadFacts {
  /** The render each thread was made (or resolved) on. */
  threadRenders: Set<string>;
  /** That render's take. */
  threadRuns: Set<string>;
  /** Every render and take stays (the threads are not listed, or not all read). */
  keepAll: boolean;
  /** Why the threads are not listed at all (the result's sentence). */
  notListed?: string;
  /** The scenarios whose threads are not all read. */
  keepOf: string[];
}

/** Comment threads: the render each was made (or resolved) on, and that render's take. */
export async function threadFacts(ports: PrunePorts, project: LoadedProject): Promise<ThreadFacts> {
  const { outputs } = ports;
  const f: ThreadFacts = { threadRenders: new Set(), threadRuns: new Set(), keepAll: false, keepOf: [] };
  try {
    const { list, unread } = await listCommentsAndUnread({ renders: outputs.renders, stores: ports.stores }, project, { status: 'all' });
    for (const t of list.threads) {
      f.threadRenders.add(t.render_id);
      f.threadRuns.add(t.run_id);
      if (t.resolution?.render_id) f.threadRenders.add(t.resolution.render_id);
    }
    // Not "no thread" either: a file or a folder that does not read as threads may hold one of its scenario.
    if (unread.all) f.keepAll = true;
    else f.keepOf.push(...unread.scenarios);
  } catch (e) {
    // Not "no threads": what a thread could keep is unknown, so every render and every take stays.
    const why = (e as NodeJS.ErrnoException | null)?.code;
    f.keepAll = true;
    f.notListed = `the comment threads of ${project.slug} cannot be listed${typeof why === 'string' && /^[A-Z0-9_]{1,40}$/.test(why) ? ` (${why})` : ''}: every render and take is kept (make ${projectRef('comments')}/ of the project readable, then prune again)`;
  }
  return f;
}

/**
 * Whether an unread thread may name this render or take: one of a scenario whose threads are not all read — by the
 * scenario its record names or by the one its id names, without regard to case (a folder of comments/ on a disk that
 * ignores case may differ from its scenario by case only). `held`: the unread scenarios something stays for.
 */
export function unreadJudge(f: ThreadFacts) {
  const { keepAll, keepOf } = f;
  const held = new Set<string>();
  const unreadBy = (...is: Array<(s: string) => boolean>): boolean => {
    let any = keepAll;
    for (const s of keepOf) {
      if (is.some((g) => g(s))) {
        held.add(s);
        any = true;
      }
    }
    return any;
  };
  const sameName = (a: unknown, s: string): boolean => typeof a === 'string' && a.toLowerCase() === s.toLowerCase();
  const unreadRender = (r: { id: string; scenario: string }) =>
    unreadBy(
      (s) => sameName(r.scenario, s),
      (s) => sameName(parseRenderId(r.id)?.scenario, s),
    );
  const unreadRun = (r: { id: string; scenario: string }) =>
    unreadBy(
      (s) => sameName(r.scenario, s),
      (s) => runIdOfScenario(r.id, s),
    );
  return { held, unreadRender, unreadRun };
}
