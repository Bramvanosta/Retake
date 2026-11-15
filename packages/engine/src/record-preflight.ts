/** Before a recording's window opens (record.ts): the persona's session, as a run would see it. */
import { errorMessage } from '@retake/core/base';
import type { LoadedProject } from '@retake/core/project';
import type { ResolvedEnvironment } from '@retake/core/environment';
import type { ResolvedPersona } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import { EngineError } from './errors.js';
import { isCancel } from './record-check.js';
import type { RecordPorts } from './record-types.js';

/**
 * The persona's session as a run would see it: valid, else signed in by its login steps (headless), else refused with
 * the command that signs it in.
 */
export async function preflight(project: LoadedProject, env: ResolvedEnvironment, persona: ResolvedPersona, ports: RecordPorts, policy: WorkPolicy): Promise<void> {
  // The runner loaded before the check (a load that fails is not the session's state).
  await ports.capture.load();
  const { sessions } = ports.capture;
  const log = ports.log ?? (() => undefined);
  const command = (ports.loginCommand ?? ((p) => `retake login ${p.project} --env ${p.env}${p.persona ? ` --persona ${p.persona}` : ''}`))({
    project: project.slug,
    env: env.name,
    persona: persona.name,
  });
  let status: string;
  let detail = '';
  try {
    const r = await sessions.check({ project, policy, env, persona, log, ...(ports.signal ? { signal: ports.signal } : {}) });
    status = r.status;
    detail = r.detail;
  } catch (e) {
    if (isCancel(e) || ports.signal?.aborted) throw new EngineError('cancelled', 'recording cancelled before the window opened');
    status = 'missing';
    detail = errorMessage(e);
  }
  if (status === 'valid' || status === 'unchecked') return;
  if (!persona.login?.length) {
    throw new EngineError('refused', `persona ${persona.name} is not signed in on ${env.name} (${detail || status}): sign it in first — ${command}`, { fix: command });
  }
  log('info', `persona ${persona.name}: session ${status} — signing in with its login steps (headless)`);
  try {
    const r = await sessions.signIn({ resolveSecret: (ref) => ports.secrets.resolve(ref), project, policy, env, persona, mode: 'auto', log, ...(ports.signal ? { signal: ports.signal } : {}) });
    if (r.check.status !== 'valid' && r.check.status !== 'unchecked') {
      throw new EngineError('refused', `persona ${persona.name} could not be signed in by its login steps (${r.check.detail}): sign it in by hand — ${command}`, { fix: command });
    }
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (isCancel(e) || ports.signal?.aborted) throw new EngineError('cancelled', 'recording cancelled before the window opened');
    throw new EngineError('refused', `persona ${persona.name} could not be signed in by its login steps: ${errorMessage(e)} — or sign it in by hand: ${command}`, { fix: command });
  }
}
