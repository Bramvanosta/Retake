/**
 * `@retake/engine/doctor`: the checks of `retake doctor` — the machine, the installed app, the workspace and a project —
 * as lines (status, name, detail, hint), and the product's probes of this machine (`machineProbes(ports)`). A shell
 * prints the lines and turns a FAIL into its exit code.
 */
export { doctorChecks, doctorSummary } from './doctor/doctor.js';
export type { DoctorPorts, DoctorRequest } from './doctor/doctor.js';
export { machineProbes } from './doctor/machine-probes.js';
export { appChecks, launchUpdates, lockText, pastePath, updateCheck } from './doctor/app-checks.js';
export {
  HOST_TIMEOUT_MS,
  MIN_COMPOSE,
  MIN_FFMPEG,
  MIN_NODE_MAJOR,
  agentJobsCheck,
  captureEncoderCheck,
  chromiumSandboxCheck,
  dockerCheck,
  gpuCheck,
  rendersCheck,
  unsafeTestResolveCheck,
} from './doctor/machine-checks.js';
export { capturesCheck } from './doctor/workspace-checks.js';
export type { CapturesProbe, CheckStatus, DockerNeed, DoctorCheck, DoctorProbes, ExecResult, RendersProbe, SandboxProbe, WorkerProbe } from './doctor/types.js';
