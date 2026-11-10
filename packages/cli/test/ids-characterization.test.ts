/**
 * Run ids and job ids as the terminal's commands read them (L7.5): the run `latest` names for `retake plan`, and the
 * refusal of a job id that is not one. Hand-made run folders in a temp project; nothing is planned.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; the mark names the decision.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';
import { resolveRun } from '../src/commands/plan.js';

let tmp: string;
let n = 0;

async function project(): Promise<LoadedProject> {
  const dir = join(tmp, `p${++n}`);
  await mkdir(join(dir, 'runs'), { recursive: true });
  return { slug: 'p', dir, root: tmp, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(dir, 'project.yaml') } as unknown as LoadedProject;
}
async function run(p: LoadedProject, id: string, mode: 'capture' | 'dry' = 'capture'): Promise<void> {
  await mkdir(join(p.dir, 'runs', id), { recursive: true });
  await writeFile(join(p.dir, 'runs', id, 'timeline.json'), JSON.stringify({ mode }));
}
const latest = (p: LoadedProject, scenario?: string): string => {
  try {
    return resolveRun(p, 'latest', scenario).id;
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
    await run(p, '20261016-090000-quote');
    await run(p, '20261017-142233-quote');
    await run(p, '20261018-090000-quote', 'dry');
    await run(p, '20261019-090000-mobile-quote');
    expect(latest(p, 'quote')).toBe('20261017-142233-quote');
    expect(latest(p, 'mobile-quote')).toBe('20261019-090000-mobile-quote');
    expect(latest(p)).toBe('20261019-090000-mobile-quote');
    expect(latest(p, 'catalogue')).toBe('no capture run of scenario "catalogue"');
    // Every folder that ends in -<scenario> is considered here, by name order alone.
    await run(p, 'my-take-quote');
    expect(latest(p, 'quote')).toBe('my-take-quote');
    await run(p, 'zz-quote');
    expect(latest(p, 'quote')).toBe('zz-quote');
    expect(latest(p)).toBe('zz-quote');
  });

  it('a folder whose name starts with a dot or a dash', async () => {
    const p = await project();
    await run(p, '20261017-142233-quote');
    await run(p, '.tmp-quote');
    await run(p, '-quote');
    expect(latest(p, 'quote')).toBe('20261017-142233-quote');
    expect(latest(p)).toBe('20261017-142233-quote');
    const q = await project();
    await run(q, '.tmp-quote');
    expect(latest(q, 'quote')).toBe('.tmp-quote');
  });

  it('a stamped folder whose part after the stamp is empty or holds a line break is a run of no scenario', async () => {
    const p = await project();
    await run(p, '20261017-142233-');
    await run(p, '20261017-142234-a\n-quote');
    expect(latest(p, 'mobile-quote')).toBe('no capture run of scenario "mobile-quote"');
    // L7.5 D-7: a stamped folder is never matched by the end of its name.
    expect(latest(p, '142233-')).toBe('no capture run of scenario "142233-"'); // D-7
    expect(latest(p, 'quote')).toBe('no capture run of scenario "quote"'); // D-7
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
