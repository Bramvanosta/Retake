/**
 * The Studio's run-ended words (app/run-ended.ts) are core's finished rule plus `unknown`: the front end imports types
 * only, so this test holds its list to core's `isFinishedRunStatus` over every view status.
 */
import { describe, expect, it } from 'vitest';
import { RUN_VIEW_STATUSES, isFinishedRunStatus } from '@retake/core/run';
import { runEnded } from '../src/app/run-ended.js';

describe('runEnded', () => {
  it.each(RUN_VIEW_STATUSES)('%s: as core says it is finished', (s) => expect(runEnded(s)).toBe(isFinishedRunStatus(s)));

  it('a status Retake never writes is no longer followed; any other text is', () => {
    expect(runEnded('unknown')).toBe(true);
    expect(runEnded('paused')).toBe(false);
  });
});
