/**
 * L5.16c (critique M6): the workspace's jobs worker runs another copy of Retake — its jobs run with that copy's browsers
 * and tools. The Welcome inspector's Worker row (engine_info `untrusted.worker_other_copy`) and the Studio's own run /
 * render submits (review c B-M2: scenario_run / scenario_render `untrusted.other_copy`) say it; the copy's version and
 * folder are the worker lock's text, so they are shown as text (Txt) only.
 */
import { APP_NAME } from './brand.js';

export interface OtherCopy {
  version: string;
  engine?: string;
}

function isOtherCopy(v: unknown): v is OtherCopy {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.version === 'string' && (o.engine === undefined || typeof o.engine === 'string');
}

/** The other copy an answer names under `untrusted` (`key`: its field there), or undefined. */
export function otherCopyOf(answer: unknown, key: 'other_copy' | 'worker_other_copy'): OtherCopy | undefined {
  const u = (answer as { untrusted?: Record<string, unknown> } | null | undefined)?.untrusted;
  const v = u?.[key];
  return isOtherCopy(v) ? v : undefined;
}

/** The Worker row's addition: ` — another copy of Retake (0.1.0, /Applications/Old Retake.app): jobs run with its tools`. */
export function otherCopyWords(o: OtherCopy | undefined): string {
  return o ? ` — another copy of ${APP_NAME} (${o.version}${o.engine ? `, ${o.engine}` : ''}): jobs run with its tools` : '';
}

/** What a submit's "queued" line adds when another copy's worker takes the job (empty otherwise). */
export function submitNotice(o: OtherCopy | undefined): string {
  return o
    ? `. It runs in another copy of ${APP_NAME} (${o.version}${o.engine ? `, ${o.engine}` : ''}), with that copy's browsers and tools: to use this one, let that worker finish (it stops a minute after its last job) and start it again`
    : '';
}
