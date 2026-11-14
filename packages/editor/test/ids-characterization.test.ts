/**
 * Run ids as the editor reads them from a project's folders (L7.5): which capture `latest` picks and how an export
 * names its render. The versions of renders/ are the engine's (engine/test/render-versions.test.ts).
 * Hand-made folders and files in a temp project; nothing is planned or rendered.
 *
 * A row marked `D-<n>` or `G` is an outcome a decision of the lot changed; the mark names it (G: the version bound).
 * Since L7.6a a run is a run of the scenario its record names (`L7.6a D-5`), and `latest` takes a capture that
 * succeeded with its timeline and its film (`L7.6a D-1`, `D-3`): each folder below is written with a record, and the
 * rows those decisions moved are marked so.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { exportRender, findRun } from '../src/index.js';
import { noRerender, syntheticRunRecord } from '@retake/test-support/render';

let tmp: string;
let n = 0;
const a = (k: number, ch = 'a') => ch.repeat(k);
const short = (s: string) => s.replace(/(.)\1{30,}/g, (m, ch: string) => `<${m.length} ${ch}>`);

/** A project folder (no file of its own: these calls read runs/ and renders/ only). */
async function project(): Promise<LoadedProject> {
  const dir = join(tmp, `p${++n}`);
  await mkdir(join(dir, 'runs'), { recursive: true });
  await mkdir(join(dir, 'renders'), { recursive: true });
  return { slug: 'p', dir, root: tmp, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(dir, 'project.yaml') } as unknown as LoadedProject;
}

/**
 * runs/<id>/ as a capture of `scenario` that succeeded — its record, its timeline (a capture's, a dry run's, or none)
 * and its film. `scenario: null`: no run.json (a folder assembled by hand).
 */
async function run(p: LoadedProject, id: string, scenario: string | null, mode: 'capture' | 'dry' | 'none' = 'capture'): Promise<void> {
  const dir = join(p.dir, 'runs', id);
  await mkdir(dir, { recursive: true });
  const named = scenario ?? 'quote';
  if (scenario !== null) await writeFile(join(dir, 'run.json'), JSON.stringify({ ...syntheticRunRecord(dir, { id, scenario, project: 'p' }), mode: mode === 'dry' ? 'dry' : 'capture' }));
  if (mode !== 'none')
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ version: 1, run_id: id, project: 'p', scenario: named, mode, capture: { file: mode === 'dry' ? '' : 'capture.mp4' } }));
  if (mode !== 'dry') await writeFile(join(dir, 'capture.mp4'), 'not really a video');
}

const latest = async (p: LoadedProject, scenario?: string): Promise<string> => {
  try {
    return short((await findRun(p, 'latest', scenario)).id);
  } catch (e) {
    return (e as Error).message.replace(/ in .*$/, '');
  }
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-ids-editor-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the run `latest` names', () => {
  it('the newest stamped capture of the scenario; a folder named to sort last is never preferred to it', async () => {
    const p = await project();
    await run(p, '20261017-142233-quote', 'quote');
    await run(p, '20261018-090000-quote', 'quote', 'dry');
    await run(p, '20261019-090000-quote', 'quote', 'none');
    await run(p, '20261016-090000-quote', 'quote');
    await run(p, '20261020-090000-mobile-quote', 'mobile-quote');
    await run(p, 'zz-quote', 'quote');
    await run(p, 'my-take-quote', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-quote');
    expect(await latest(p, 'mobile-quote')).toBe('20261020-090000-mobile-quote');
    expect(await latest(p)).toBe('20261020-090000-mobile-quote');
    expect(await latest(p, 'catalogue')).toBe('no capture run of scenario "catalogue"');
  });

  it('without a stamped capture: the other folders that end in -<scenario>, the last by name first', async () => {
    const p = await project();
    await run(p, 'my-take-quote', 'quote');
    await run(p, 'zz-quote', 'quote');
    await run(p, '2026101-142233-quote', 'quote'); // seven digits: not a stamp
    expect(await latest(p, 'quote')).toBe('zz-quote');
    expect(await latest(p)).toBe('zz-quote');
    // L7.6a D-5: the name's ending says nothing — a folder of any name is a run of its record's scenario.
    await run(p, 'zzz-final', 'quote');
    expect(await latest(p, 'quote')).toBe('zzz-final');
  });

  it('a stamped run is a run of the scenario whose lower-cased name follows the stamp', async () => {
    // What the tool makes: the folder of a capture of `Quote` ends in -quote and its record says `Quote`.
    const p = await project();
    await run(p, '20261017-142233-quote', 'Quote');
    expect(await latest(p, 'Quote')).toBe('20261017-142233-quote');
    // L7.6a D-5: the record names the scenario, not the folder (before: this folder was a run of `quote` too).
    expect(await latest(p, 'quote')).toBe('no capture run of scenario "quote"');
    // L7.6a D-5: a folder renamed by hand stays a run of its record's scenario (before: of none — "no capture run").
    await run(p, '20261017-142234-Quote', 'quote');
    await run(p, '20261017-142235-quote.bak', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142235-quote.bak');
    await run(p, '20261017-142236-quote-', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142236-quote-');
    expect(await latest(p)).toBe('20261017-142236-quote-');
  });

  it('only folders whose name is a run id of at most 200 characters are considered', async () => {
    const p = await project();
    await run(p, '.tmp-quote', 'quote');
    await run(p, '-quote', 'quote');
    await run(p, `20261017-142233-${a(185)}`, a(185)); // 201 characters
    await run(p, `${a(195, 'z')}-quote`, 'quote'); // 201 characters
    await run(p, '20261017-142242-quote\n', 'quote');
    expect(await latest(p, 'quote')).toBe('no capture run of scenario "quote"');
    expect(await latest(p)).toBe('no capture run');
    await run(p, `${a(194, 'z')}-quote`, 'quote'); // 200 characters
    expect(await latest(p, 'quote')).toBe('<194 z>-quote');
    await run(p, `20261017-142233-${a(184)}`, a(184)); // 200 characters
    expect(await latest(p)).toBe('20261017-142233-<184 a>');
  });

  it('a stamped folder with nothing after its stamp is a run of no scenario', async () => {
    const p = await project();
    await run(p, '20261017-142233-', null);
    // L7.6a D-3: without a record it is the latest of nothing (before: of "any scenario"); the sentence counts it.
    expect(await latest(p)).toBe('no capture run');
    expect(await latest(p, 'quote')).toBe('no capture run of scenario "quote"');
    // L7.5 D-7: it is a run of no scenario.
    expect(await latest(p, '142233-')).toBe('no capture run of scenario "142233-"'); // D-7
    // L7.6a D-5: with a record it is a run of the scenario the record names, whatever its name lacks.
    await run(p, '20261017-142233-', 'quote');
    expect(await latest(p, 'quote')).toBe('20261017-142233-');
    expect(await latest(p)).toBe('20261017-142233-');
  });
});

describe("an export under an agent's trust names its render by its id", () => {
  it('a name that is not one is refused before anything is read', async () => {
    const p = await project();
    const failedRecord = (id: string) =>
      writeFile(
        join(p.dir, 'renders', `${id}.json`),
        JSON.stringify({ version: 1, id, scenario: 'quote', status: 'failed', file: join(p.dir, 'renders', `${id}.mp4`), run_dir: join(p.dir, 'runs', 'r'), plan: {} }),
      );
    await failedRecord('quote-v1');
    await failedRecord('final');
    await mkdir(join(p.dir, 'runs', 'r'), { recursive: true });
    const exported = async (render: string) => {
      try {
        await exportRender({ project: p, render, trust: 'mcp', workPolicy: PERSON_POLICY, rerender: noRerender });
        return 'exported';
      } catch (e) {
        return (e as Error).message.split(p.dir).join('<project>');
      }
    };
    const notId = (render: string) => `render "${render}": through MCP a render is named by its id`;
    expect(await exported('../x')).toBe(notId('../x'));
    expect(await exported('a.b-v1')).toBe(notId('a.b-v1'));
    expect(await exported('')).toBe(notId(''));
    // Past the name: the record is read, and a failed render has nothing to export.
    expect(await exported('quote-v1')).toBe('render quote-v1 failed: nothing to export');
    // L7.5 D-4: a name without a version is not a render id, whether a record of that name exists or not.
    expect(await exported('final')).toBe(notId('final')); // D-4
    expect(await exported('quote')).toBe(notId('quote')); // D-4
    expect(await exported('quote-v1000000')).toBe(notId('quote-v1000000'));
    expect(existsSync(join(p.dir, 'exports'))).toBe(false);
  });
});
