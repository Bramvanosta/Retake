// L7.25: the lock file (TakeLock and its parts) is an OS utility of core's io side (core/src/io/lock.ts), re-exported
// here for this package's modules and users.
export { BREAKER_STALE_MS, TakeLock, breakStale, createExclusive, describeLock, lockAlive, readLock } from '@retake/core/io';
export type { LockRecord } from '@retake/core/io';
