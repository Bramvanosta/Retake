/** Job ids: "j_" + a ULID (core `ulid`: 10 Crockford base32 characters of milliseconds, 16 random), sortable by creation time. */
import { newUlidId } from '@retake/core';

/** A new job id; ids made in the same millisecond by this process still sort in creation order. */
export function newJobId(now: number = Date.now()): string {
  return newUlidId('job', now);
}
