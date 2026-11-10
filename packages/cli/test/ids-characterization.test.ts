/**
 * Run ids and job ids as the terminal's commands read them (L7.5): the run `latest` names for `retake plan`, and the
 * refusal of a job id that is not one. Hand-made run folders in a temp project; nothing is planned.
 *
 * A row marked `D-<n>` is an outcome a decision of L7.5 changed; the mark names the decision. Since L7.6a the plan
 * command has no rule of its own: `latest` is the editor's findRun (the newest usable capture, its scenario by its
 * record, dated runs first) — each folder here is a whole capture (record, timeline, film), and a row marked `L7.6a`
 * says what it answered under the plan command's old rule.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';
import { findRunOf } from '@retake/engine';
import { syntheticRunRecord } from '../../editor/test/render-helpers.js';

let tmp: string;
let n = 0;

async function project(): Promise<LoadedProject> {
  const dir = join(tmp, `p${++n}`);
  await mkdir(join(dir, 'runs'), { recursive: true });
  return { slug: 'p', dir, root: tmp, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(dir, 'project.yaml') } as unknown as LoadedProject;
}
/** A run folder: its record (of `scenario`), its timeline's head and its film. */
async function run(p: LoadedProject, id: string, scenario: string, mode: 'capture' | 'dry' = 'capture'): Promise<void> {
  const dir = join(p.dir, 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify({ ...syntheticRunRecord(dir, { id, scenario, project: 'p' }), mode }));
  await writeFile(join(dir, 'timeline.json'), JSON.stringify({ version: 1, run_id: id, project: 'p', scenario, mode, capture: { file: mode === 'dry' ? '' : 'capture.mp4' } }));
  if (mode === 'capture') await writeFile(join(dir, 'capture.mp4'), 'film');
}
const latest = async (p: LoadedProject, scenario?: string): Promise<string> => {
  try {
    return (await findRunOf(p, 'latest', scenario)).id;
  } catch (e) {
    return (e as Error).message.replace(/ in .*$/s, '');
  }
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-ids-cli-'));
  await writeFile(join(tmp, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the run `latest` names for the plan command', () => {
  it('the capture of the scenario whose folder name sorts last', async () => {
    const p = await project();
    await run(p, '20261016-090000-quote', 'quote');
    await run(p, '20261017-142233-quote', 'quote');
    await run(p, '20261018-090000-quote', 'quote', 'dry');
    await run(p, '20261019-090000-mobile-quote', 'mobile-quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-quote');
    expect(await latest(p, 'mobile-quote')).toBe('20261019-090000-mobile-quote');
    expect(await latest(p)).toBe('20261019-090000-mobile-quote');
    expect(await latest(p, 'catalogue')).toBe('no capture run of scenario "catalogue"');
    // L7.6a (one order of runs): a dated run is before a folder named by hand, whatever its name sorts as.
    await run(p, 'my-take-quote', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-quote'); // L7.6a: was my-take-quote
    await run(p, 'zz-quote', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-quote'); // L7.6a: was zz-quote
    expect(await latest(p)).toBe('20261019-090000-mobile-quote'); // L7.6a: was zz-quote
    // Alone, a folder named by hand is the latest capture of the scenario its record names.
    const q = await project();
    await run(q, 'my-take-quote', 'quote');
    await run(q, 'zz-quote', 'quote');
    expect([await latest(q, 'quote'), await latest(q)]).toEqual(['zz-quote', 'zz-quote']);
  });

  it('a folder whose name starts with a dot or a dash', async () => {
    const p = await project();
    await run(p, '20261017-142233-quote', 'quote');
    await run(p, '.tmp-quote', 'quote');
    await run(p, '-quote', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-quote');
    expect(await latest(p)).toBe('20261017-142233-quote');
    const q = await project();
    await run(q, '.tmp-quote', 'quote');
    // L7.6a: such a name is no run id — never `latest` (the plan command's own rule took it).
    expect(await latest(q, 'quote')).toBe('no capture run of scenario "quote"'); // L7.6a: was .tmp-quote
  });

  it('a stamped folder whose part after the stamp is empty or holds a line break is a run of no scenario', async () => {
    const p = await project();
    await run(p, '20261017-142233-', 'other');
    await run(p, '20261017-142234-a\n-quote', 'quote');
    expect(await latest(p, 'mobile-quote')).toBe('no capture run of scenario "mobile-quote"');
    // L7.5 D-7: a stamped folder is never matched by the end of its name.
    expect(await latest(p, '142233-')).toBe('no capture run of scenario "142233-"'); // D-7
    expect(await latest(p, 'quote')).toBe('no capture run of scenario "quote"'); // D-7
    // L7.6a: a run is of the scenario its record names, whatever its folder is called.
    expect(await latest(p, 'other')).toBe('20261017-142233-');
  });
});

describe('retake jobs status / cancel', () => {
  async function retake(...args: string[]) {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', tmp, '--no-color', ...args], io);
    return { code, err: io.stderr() };
  }

  it('an id that is not a job id is a usage error that names the shape', async () => {
    const BODY = '01K8AB1CDE2FGH3JKM4NPQ5RST';
    for (const id of ['j_x', `j_${BODY}0`, `j_${BODY.toLowerCase()}`, `p_${BODY}`, `../j_${BODY}`]) {
      for (const verb of ['status', 'cancel']) {
        const r = await retake('jobs', verb, id);
        expect([r.code, r.err.includes(`"${id}" is not a job id (j_ followed by 26 characters: retake jobs lists them)`)], `${verb} ${id}`).toEqual([EXIT.usage, true]);
      }
    }
    const missing = await retake('jobs', 'status', `j_${BODY}`);
    expect(missing.err).not.toContain('is not a job id');
  });
});
