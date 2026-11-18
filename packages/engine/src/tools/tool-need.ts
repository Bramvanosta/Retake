/**
 * What a queued job needs of the app's downloaded Tools now: its kind's need (jobs/job-input.ts JOB_TOOLS), except that
 * a job whose project launches a browser of its own — `browser.executable`, an installed channel (`chrome`) — needs no
 * Tool, and one on the headless shell (`headless-shell`, headless) needs the render browser (core launchTool: runner-web
 * launchTarget's rule). The project's `browser:` (the workspace's folded in) is read only while the browser is missing
 * (the gate says so), through the reader its engine hands the queue (JobQueue.useTools: the WorkspaceReads port), at
 * most once per `ttlMs` per project; a project that cannot be read, or a queue handed no reader, keeps its kind's need
 * (the job then says why itself).
 */
import { launchTool, toolNeedOf } from '@retake/core/io';
import type { ToolNeed } from '@retake/core/io';
import type { BrowserConfig } from '@retake/core/project';
import { jobNeeds } from '../jobs/job-input.js';
import type { ProjectBrowser } from '../jobs/job-queue.js';

export type { ProjectBrowser } from '../jobs/job-queue.js';

/** A queue handed no reader: the kind's need. */
export const NO_PROJECT_BROWSER: ProjectBrowser = async () => null;

/** Whether the browser a job launches is headless: a recording opens a window, a sign-in too unless it is automated. */
function jobHeadless(input: Record<string, unknown>, b: BrowserConfig): boolean {
  if (input.kind === 'record') return false;
  if (input.kind === 'auth_login') return input.mode === 'auto';
  return b.headless ?? true;
}

/** The need of a job (its kind and input) while `missing` are the needs missing now (tools/gate.ts). */
export async function jobToolNeed(rec: { kind: string; input: unknown }, missing: ReadonlySet<ToolNeed>, browserOf: ProjectBrowser): Promise<ToolNeed | null> {
  const base = jobNeeds(rec.kind);
  if (base !== 'browser' || !missing.has('browser')) return base;
  const input = (rec.input ?? {}) as Record<string, unknown>;
  if (typeof input.project !== 'string') return base;
  const b = await browserOf(input.project);
  return b === null ? base : toolNeedOf(launchTool(b, jobHeadless(input, b)));
}

/** `load` (a project's `browser:`, or a throw) read again only after `ttlMs` per project; a throw reads as null. */
export function cachedProjectBrowsers(load: (project: string) => Promise<BrowserConfig | undefined>, ttlMs = 2_000): ProjectBrowser {
  const seen = new Map<string, { at: number; b: BrowserConfig | null }>();
  return async (project) => {
    const now = performance.now();
    const hit = seen.get(project);
    if (hit && now - hit.at < ttlMs) return hit.b;
    let b: BrowserConfig | null;
    try {
      b = (await load(project)) ?? {};
    } catch {
      b = null;
    }
    seen.set(project, { at: now, b });
    return b;
  };
}
