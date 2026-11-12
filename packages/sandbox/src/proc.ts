// L7.25: process identity and groups are an OS utility of core's io side (core/src/io/proc.ts), re-exported here for
// this package's modules and users.
export {
  START_TOLERANCE_MS,
  PS_TIMEOUT_MS,
  bootTime,
  groupMembers,
  groupTree,
  identify,
  killGroupSync,
  parseBootTime,
  parseLstart,
  parseProcessTable,
  processStart,
  processStartSync,
  processTable,
  processTableSync,
  signalState,
  stopGroup,
} from '@retake/core/io';
export type { Known, Member, ProcInfo, StopResult } from '@retake/core/io';
