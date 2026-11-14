/**
 * Whether the Studio is done following a run: it finished (core `isFinishedRunStatus`: succeeded, failed, cancelled or
 * interrupted) or its status is a text Retake never writes (`unknown`: nothing moves it on). The front end imports
 * types only, so the words are listed here; packages/ui/test/run-ended.test.ts holds them to core's.
 */
import type { ViewRunStatus } from '@retake/engine';

const ENDED: ReadonlySet<string> = new Set<ViewRunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

export function runEnded(status: string): boolean {
  return ENDED.has(status);
}
