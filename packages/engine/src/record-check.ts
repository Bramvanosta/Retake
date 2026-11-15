/** After a recording (record.ts): the dry replay of its fresh draft, up to the step before its first write. */
import type { RunOutputs } from './outputs/outputs.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYaml, errorMessage } from '@retake/core/base';
import { parseScenario } from '@retake/core/scenario';
import type { LoadedProject } from '@retake/core/project';
import type { LoadedScenario } from '@retake/core/scenario';
import type { WorkPolicy } from '@retake/core/policy';
import type { RunRecord } from '@retake/core/run';
import { fileFacts } from '@retake/core/io';
import { EngineError } from './errors.js';
import type { RecordCheck, RecordPorts } from './record-types.js';

export const isCancel = (e: unknown) => e instanceof Error && (e.name === 'CancelledError' || (e instanceof EngineError && e.code === 'cancelled'));

/** The dry replay of a fresh draft (see the module comment). Never throws: a failure is the check's result. */
export async function checkReplay(o: {
  project: LoadedProject;
  /** Where an in-memory runner writes the check's run (its workspace's Outputs port). */
  runs: RunOutputs;
  policy: WorkPolicy;
  envName: string;
  dir: string;
  draftFile: string;
  yaml: string;
  firstWrite: { scene: string; step: number } | null;
  pacing: Record<string, unknown>;
  ports: RecordPorts;
}): Promise<RecordCheck> {
  const { project, ports } = o;
  const value = parseYaml(o.yaml).value as { scenes: Array<{ id: string; steps: unknown[] }> };
  const flat = value.scenes.flatMap((s) => s.steps.map((_, i) => ({ scene: s.id, step: i })));
  // The check never writes twice: it stops before the first step a write that went through followed (a read-only
  // environment's guard stops the others again, in the replay too).
  let until: string | undefined;
  if (o.firstWrite) {
    const k = flat.findIndex((x) => x.scene === o.firstWrite!.scene && x.step === o.firstWrite!.step);
    if (k <= 0) return { status: 'skipped', scope: 'until_write', reason: 'first_step_writes', steps_passed: 0, steps_total: 0 };
    until = `${flat[k - 1].scene}.${flat[k - 1].step}`;
  }
  const total = until ? flat.findIndex((x) => `${x.scene}.${x.step}` === until) + 1 : flat.length;
  const scope = until ? 'until_write' : 'all';
  // Replayed at inspection pacing (a check, not a take); the saved draft is unchanged.
  const text = `${o.yaml.endsWith('\n') ? o.yaml : `${o.yaml}\n`}pacing: ${JSON.stringify(o.pacing)}\n`;
  const { scenario, issues } = parseScenario(text, { files: fileFacts(o.policy), project, file: o.draftFile, env: o.envName, ...(until ? { until } : {}) });
  if (!scenario) return { status: 'skipped', scope: null, reason: 'invalid_draft', steps_passed: 0, steps_total: total };
  const loaded: LoadedScenario = { name: 'record-check', file: o.draftFile, text, scenario, issues };
  let record: RunRecord;
  try {
    record = await ports.capture.run({
      resolveSecret: (ref) => ports.secrets.resolve(ref),
      runs: o.runs,
      policy: o.policy,
      project,
      scenario: loaded,
      mode: 'dry',
      env: o.envName,
      ...(until ? { until } : {}),
      runsDir: o.dir,
      runId: 'check',
      ...(ports.hookTrust ? { hookTrust: ports.hookTrust } : {}),
      ...(ports.loginCommand ? { loginCommand: ports.loginCommand } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
      ...(ports.onCheckProgress ? { onProgress: ports.onCheckProgress } : {}),
      hookRunner: ports.hooks,
    });
  } catch (e) {
    return { status: isCancel(e) ? 'cancelled' : 'failed', scope, ...(until ? { until } : {}), steps_passed: 0, steps_total: total, untrusted: { error: errorMessage(e) } };
  }
  const checkDir = join(o.dir, 'check');
  await rm(join(checkDir, 'screenshots'), { recursive: true, force: true }).catch(() => undefined);
  const status = record.status === 'succeeded' ? 'passed' : record.status === 'cancelled' ? 'cancelled' : 'failed';
  const err = record.error;
  return {
    status,
    scope,
    ...(until ? { until } : {}),
    steps_passed: status === 'passed' ? total : Math.max(0, record.steps_done - (err?.step !== undefined ? 1 : 0)),
    steps_total: total,
    ...(err?.scene !== undefined && err.step !== undefined ? { failed_at: { scene: err.scene, step: err.step, action: err.action ?? '?' } } : {}),
    dir: checkDir,
    ...(err && status !== 'passed' ? { untrusted: { error: err.message } } : {}),
  };
}
