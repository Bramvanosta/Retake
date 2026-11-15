import { doctorChecks as engineDoctorChecks, doctorSummary, machineProbes } from '@retake/engine/doctor';
import type { DoctorCheck, DoctorProbes } from '@retake/engine/doctor';
import type { EnginePorts, OpenedWorkspace } from '@retake/engine';
import { EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { retakeCommand } from './auth.js';

export type { CapturesProbe, CheckStatus, DoctorCheck, DoctorProbes, ExecResult, RendersProbe, SandboxProbe } from '@retake/engine/doctor';

/** The probes of this machine, with what the CLI's ports know of it (the capture browser, the render path, the sandboxes). */
export function systemProbes(ports: EnginePorts): DoctorProbes {
  return machineProbes(ports);
}

/** Every doctor check, in display order (the engine's), its hints' commands written the way this command line was (`-C <root>`). */
export function doctorChecks(probes: DoctorProbes, ws: OpenedWorkspace, opts: { project?: string; global?: Pick<GlobalOptions, 'root'>; ports: EnginePorts }): Promise<DoctorCheck[]> {
  return engineDoctorChecks(probes, ws, opts.ports, { ...(opts.project !== undefined ? { project: opts.project } : {}), retake: retakeCommand(opts.global ?? {}) });
}

export interface DoctorOptions {
  project?: string;
  json?: boolean;
}

/** `retake doctor [--project slug]`: check the machine, the workspace and optionally a project. Exit 1 on any FAIL. */
export async function doctorCommand(ui: Ui, global: GlobalOptions, opts: DoctorOptions, probes: DoctorProbes = systemProbes(global.ports)): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const checks = await doctorChecks(probes, ws, { project: opts.project, global, ports: global.ports });
  const { ok, failures: fails, warnings: warns } = doctorSummary(checks);
  if (opts.json) {
    ui.result(JSON.stringify({ ok, failures: fails, warnings: warns, checks }, null, 2));
  } else {
    const c = ui.c;
    const tag = { ok: c.green('OK  '), warn: c.yellow('WARN'), fail: c.red('FAIL') } as const;
    const width = Math.max(...checks.map((x) => x.name.length));
    ui.line(c.bold('retake doctor'));
    for (const x of checks) {
      ui.line(`  ${tag[x.status]}  ${x.name.padEnd(width)}  ${x.detail}`);
      if (x.hint && x.status !== 'ok') ui.line(`  ${' '.repeat(4)}  ${' '.repeat(width)}  ${c.dim(`→ ${x.hint}`)}`);
    }
    const summary = `${fails} failure${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`;
    if (fails) ui.error(summary);
    else ui.ok(summary);
  }
  return fails ? EXIT.failure : EXIT.ok;
}
