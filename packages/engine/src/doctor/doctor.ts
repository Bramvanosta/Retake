/**
 * `retake doctor`'s checks, in display order: the machine, the app, the workspace, then a `--project`. The probes read
 * the machine (types.ts DoctorProbes: the product's are machine-probes.ts `machineProbes(ports)`); the ports give the
 * time, the personas' sessions and where a docker binary is looked for. A shell prints the lines and turns a FAIL into
 * its exit code; nothing here prints.
 */
import type { EnginePorts } from '../ports.js';
import type { OpenedWorkspace } from '../workspace.js';
import { appBundleCheck, appChecks } from './app-checks.js';
import {
  agentJobsCheck,
  captureEncoderCheck,
  chromiumCheck,
  chromiumSandboxCheck,
  compositorCheck,
  displayCheck,
  dockerCheck,
  gpuCheck,
  mediaTool,
  nodeCheck,
  notifyCheck,
  renderBrowserCheck,
  rendersCheck,
  secretsCheck,
  toolsCheck,
  unsafeTestResolveCheck,
  npmTestRegistryCheck,
} from './machine-checks.js';
import { iosEnvironmentChecks, iosNeedOf, iosSimulatorCheck } from './ios-check.js';
import { composeSandboxOf, projectChecks } from './project-checks.js';
import type { DoctorCheck, DoctorProbes } from './types.js';
import { capturesCheck, mcpCheck, workspaceChecks } from './workspace-checks.js';

/** The ports the checks read beside the probes. */
export type DoctorPorts = Pick<EnginePorts, 'clock' | 'capture' | 'sandboxes'>;

export interface DoctorRequest {
  /** A project's lines too (its slug or folder). */
  project?: string;
  /** How the hints' commands start: `retake` (default), or `retake -C <root>` when the command line named the root. */
  retake?: string;
}

/** Every doctor check, in display order. */
export async function doctorChecks(probes: DoctorProbes, ws: OpenedWorkspace, ports: DoctorPorts, req: DoctorRequest = {}): Promise<DoctorCheck[]> {
  const now = ports.clock.now();
  const out: DoctorCheck[] = [nodeCheck(probes)];
  const bundle = appBundleCheck(probes);
  if (bundle) out.push(bundle);
  out.push(...appChecks(probes, now));
  const tools = toolsCheck(probes);
  if (tools) out.push(tools);
  const chromium = await probes.chromium(ws.browser, ws.policy);
  out.push(chromiumCheck(chromium, ws.browser, probes.bundle, probes.tools?.()));
  const sandbox = chromiumSandboxCheck(chromium);
  if (sandbox) out.push(sandbox);
  const render = await renderBrowserCheck(probes);
  if (render) out.push(render);
  const compositor = compositorCheck(probes);
  if (compositor) out.push(compositor);
  const gpu = gpuCheck(chromium, ws.browser);
  if (gpu) out.push(gpu);
  if (probes.renders) out.push(rendersCheck(await probes.renders(ws.policy)));
  const ffmpeg = await mediaTool(probes, 'ffmpeg', ws.ffmpeg);
  out.push(ffmpeg);
  out.push(await mediaTool(probes, 'ffprobe', ws.ffmpeg));
  const encoder = ffmpeg.status === 'ok' ? await captureEncoderCheck(probes, ws.ffmpeg) : null;
  if (encoder) out.push(encoder);
  out.push(displayCheck(probes), secretsCheck(probes), notifyCheck(probes));
  const resolve = unsafeTestResolveCheck(probes);
  if (resolve) out.push(resolve);
  const registry = npmTestRegistryCheck(probes);
  if (registry) out.push(registry);
  // Docker: a failure only when the --project's default sandbox is a docker-compose one.
  const need = req.project ? await composeSandboxOf(ws, req.project) : null;
  out.push(await dockerCheck(probes, (home) => ports.sandboxes.dockerPlaces(home), need));
  // The iOS Simulator: a failure only when the --project's default environment is an iOS one.
  const ios = req.project ? await iosNeedOf(ws, req.project) : null;
  const simulator = await iosSimulatorCheck(probes, ios);
  if (simulator) out.push(simulator.line);
  if (ios && simulator?.line.status === 'ok') out.push(...(await iosEnvironmentChecks(probes, ios, simulator.runtime)));
  out.push(...(await workspaceChecks(probes, ws)));
  const jobs = agentJobsCheck(probes.env, ws, ws.browser);
  if (jobs) out.push(jobs);
  out.push(await mcpCheck(probes, ws));
  if (probes.captures) out.push(capturesCheck(await probes.captures(ws.root)));
  if (req.project) out.push(...(await projectChecks(probes, ws, req.project, req.retake ?? 'retake', { now, sessions: ports.capture.sessions })));
  return out;
}

/** How many lines fail and warn, and whether none fails. */
export function doctorSummary(checks: readonly DoctorCheck[]): { ok: boolean; failures: number; warnings: number } {
  const failures = checks.filter((c) => c.status === 'fail').length;
  return { ok: failures === 0, failures, warnings: checks.filter((c) => c.status === 'warn').length };
}
