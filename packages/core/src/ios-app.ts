/**
 * The app of an iOS environment as a run installs it (agent-policy.ts): a bundle id, or the real path of a simulator
 * build, under the work's agent policy.
 */
import { isAbsolute, normalize, resolve } from 'node:path';
import { isUnder } from './client-path.js';
import { iosAppError, iosAppKind } from './env.js';
import type { FileFacts } from './file-facts.js';
import { pathInside } from './path-inside.js';
import { showHiddenChars } from './printable.js';
import { realPathOf } from './real-path.js';
import type { WorkPolicy } from './work-policy.js';

/** What an iOS environment's `app` names once checked: an installed app's bundle id, or the real path of a `.app`. */
export type IosAppTarget = { kind: 'bundle'; bundleId: string } | { kind: 'path'; path: string };

/** What iosAppTarget reads: the project the path is relative to, the work's policy, the file system. */
export interface IosAppOptions {
  /** The project folder (`app` is relative to it). */
  projectDir: string;
  policy: WorkPolicy;
  files: FileFacts;
}

/**
 * The app a run on an iOS environment installs, or why it may not: a bundle id is taken as it is; a path is resolved
 * against the project folder and its links followed — a relative path that leaves the project (by `..` or through a
 * link) is refused for every run (an absolute path is the person's own choice). Under the agent policy (work the
 * Studio, the desktop app or an MCP client starts) a build inside the workspace is refused: an agent can write files
 * there, and an installed app runs its code — a bundle id, or a build outside the workspace, may.
 */
export function iosAppTarget(app: string, o: IosAppOptions): { target: IosAppTarget; problem: null } | { target: null; problem: string } {
  const a = app.trim();
  const shown = showHiddenChars(a);
  const refused = (problem: string) => ({ target: null, problem }) as const;
  const kind = iosAppKind(a);
  if (kind === null) return refused(`app "${shown}": ${iosAppError(a)}`);
  if (kind === 'bundle') return { target: { kind: 'bundle', bundleId: a }, problem: null };
  const absolute = isAbsolute(a);
  if (!absolute && normalize(a).split(/[\\/]/)[0] === '..') return refused(`app "${shown}" leaves the project folder: write its path relative to the project (inside it), or an absolute path`);
  const path = absolute ? a : resolve(o.projectDir, a);
  const real = realPathOf(path, o.files);
  if (!absolute && !pathInside(real, realPathOf(resolve(o.projectDir), o.files))) {
    return refused(`app "${shown}" leaves the project folder through a link (it is ${showHiddenChars(real)}): write the absolute path of the build, or move it into the project`);
  }
  const folders = o.policy.agentFolders;
  const inside = folders?.find((f) => isUnder(real, f, o.files) || isUnder(path, f, o.files));
  if (inside) {
    return refused(
      `app "${shown}" lies inside the workspace (${inside}) — jobs the Studio, the desktop app or an MCP client start install an app from outside the workspace only (an agent can write files in it): ` +
        'name the bundle id of an app installed on the device, or give the absolute path of a build outside the workspace',
    );
  }
  return { target: { kind: 'path', path: real }, problem: null };
}
