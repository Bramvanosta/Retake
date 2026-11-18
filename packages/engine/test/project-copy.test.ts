/**
 * A project folder copied alone into another workspace (R-SHR-05 — the CI twin of the CLI's real acceptance,
 * packages/cli/test/project-copy-acceptance.test.ts): its run and its render are read where they now lie, never in the
 * workspace they were made in. No ffmpeg, no browser: the renderer draws a marker (the render use case for real, the
 * engine's by-id gate for real). What the review itself opens (the capture, the fonts) is the real acceptance's proof;
 * here: the readers and the gate.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, runRecordOnDisk } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { loadProject, readNamedRender, readRunFolder, readRunRecord } from '@retake/core/io';
import { RUN_ID, syntheticRunRecord, syntheticTimeline } from '@retake/test-support/render';
import { packageRegistries } from '@retake/compose';
import { systemClock } from '../src/clock.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { renderForWork } from '../src/renders.js';
import { renderWork } from '../src/render/work.js';
import type { Renderer } from '../src/render/renderer.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';

const place = { ws: { outputs: diskOutputs, reads: diskWorkspaceReads, registries: packageRegistries() }, clock: systemClock };

/** A renderer that writes a marker video where it is asked. */
function marker(): Renderer {
  const memory = new MemoryRenderer();
  return {
    async video(req) {
      mkdirSync(dirname(req.out), { recursive: true });
      writeFileSync(req.out, 'marker');
      return {
        file: req.out,
        size_bytes: 6,
        concurrency: 1,
        bundle: { hash: 'h', cached: true, ms: 1 },
        browser: { path: null, source: 'none' },
        bundle_ms: 1,
        render_ms: 1,
        warnings: [],
        renderPath: { gl: { asked: 'auto', source: 'default', resolved: 'software', used: 'software' }, encoder: { asked: 'auto', source: 'default', used: 'libx264' }, concurrency_source: 'default' },
        encoding: { encoder: 'libx264', crf: 16 },
      };
    },
    stills: (req) => memory.stills(req),
    previews: memory.previews,
    machine: memory.machine,
  };
}

let scratch: string;
let a: string;
let b: string;
let projectB: LoadedProject;
const workspace = (root: string) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'retake.yaml'), 'projects_dir: projects\n');
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'retake-project-copy-'));
  a = join(scratch, 'a');
  b = join(scratch, 'b');
  workspace(a);
  const dir = join(a, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  writeFileSync(join(runDir, 'timeline.json'), JSON.stringify(syntheticTimeline(), null, 2));
  writeFileSync(join(runDir, 'capture.mp4'), 'not a video');
  // run.json as the runner writes it (its paths relative to the run folder).
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runRecordOnDisk(syntheticRunRecord(runDir), dir), null, 2));
  const project = await loadProject('demo', a);
  await renderWork({ ...place, workPolicy: PERSON_POLICY, project, root: a, run: RUN_ID, renderer: marker() });
  // A version 1 record, as 0.3.0 wrote it in A: every path absolute (the record above, read: its paths resolved).
  const read = await readNamedRender(join(dir, 'renders', 'synthetic-v1.json'));
  if (!read.read.ok) throw new Error(read.read.problem);
  const abs = (p: string) => join(dir, 'renders', p);
  const v1 = { ...read.read.value, version: 1, id: 'synthetic-v2', render_version: 2, file: abs('synthetic-v2.mp4'), record: abs('synthetic-v2.json') };
  expect(JSON.stringify(v1)).toContain(join(a, 'projects', 'demo', 'runs'));
  writeFileSync(join(dir, 'renders', 'synthetic-v2.json'), JSON.stringify(v1, null, 2));
  writeFileSync(join(dir, 'renders', 'synthetic-v2.mp4'), 'marker');
  // The project folder alone, into a fresh workspace B; then A is made unreadable: nothing may reach back.
  workspace(b);
  cpSync(dir, join(b, 'projects', 'demo'), { recursive: true });
  chmodSync(join(a, 'projects'), 0o000);
  projectB = await loadProject('demo', b);
});
afterAll(() => {
  chmodSync(join(a, 'projects'), 0o755);
  rmSync(scratch, { recursive: true, force: true });
});

describe('a project folder copied alone into another workspace', () => {
  it('its run reads where it now lies: run.json says ".", the capture and the timeline are those of B', async () => {
    const runDir = join(projectB.dir, 'runs', RUN_ID);
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))).toMatchObject({ dir: '.', capture: 'capture.mp4', timeline: 'timeline.json' });
    const read = await readRunRecord(join(runDir, 'run.json'));
    expect(read.ok && [read.value.dir, (read.value as { capture?: string }).capture]).toEqual([runDir, join(runDir, 'capture.mp4')]);
    // The reader of a listing (latest, the lists) too.
    const listed = await readRunFolder(join(projectB.dir, 'runs'), RUN_ID);
    expect(listed.record.ok && (listed.record.value as { timeline?: string }).timeline).toBe(join(runDir, 'timeline.json'));
  });

  it('its version 2 render reads in B and passes the gate of work submitted through MCP; a v1 one of A is rebased and passes too', async () => {
    for (const id of ['synthetic-v1', 'synthetic-v2']) {
      const record = await renderForWork(diskOutputs.renders, projectB, id);
      for (const p of [record.file, record.record, record.run_dir, record.plan.source.file]) expect(p.startsWith(`${projectB.dir}/`), `${id}: ${p}`).toBe(true);
      expect(record.run_dir).toBe(join(projectB.dir, 'runs', RUN_ID));
    }
  });

  it('a render made in B from the copied run writes B relative paths and reads nothing of A', async () => {
    const record = await renderWork({ ...place, workPolicy: PERSON_POLICY, project: projectB, root: b, run: RUN_ID, renderer: marker() });
    expect(record.id).toBe('synthetic-v3');
    expect(record.run_dir).toBe(join(projectB.dir, 'runs', RUN_ID));
    const text = readFileSync(record.record, 'utf8');
    expect(text).not.toContain(scratch.replace(/^\/private/, ''));
    const back = await readNamedRender(record.record);
    expect(back.read.ok && back.read.value.plan?.source).toMatchObject({ file: join(projectB.dir, 'runs', RUN_ID, 'capture.mp4') });
  });

  it('a record naming a file outside the project is still refused through MCP: an absolute `/etc/hosts`, and a relative path that climbs out', async () => {
    const renders = join(projectB.dir, 'renders');
    const good = JSON.parse(readFileSync(join(renders, 'synthetic-v1.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(renders, 'hosts-v1.json'), JSON.stringify({ ...good, id: 'hosts-v1', scenario: 'hosts', version: 1, file: '/etc/hosts', record: join(renders, 'hosts-v1.json') }));
    writeFileSync(join(renders, 'climb-v1.json'), JSON.stringify({ ...good, id: 'climb-v1', scenario: 'climb', file: `${'../'.repeat(40)}etc/hosts`, record: 'climb-v1.json' }));
    const why = '(its record was edited by hand, or written elsewhere): through MCP the files of a render must lie in its project — render it again, or work on it at a terminal';
    await expect(renderForWork(diskOutputs.renders, projectB, 'hosts-v1')).rejects.toMatchObject({ code: 'refused', message: `the video of render hosts-v1 names a file outside its project ${why}`, details: { untrusted: { paths: ['/etc/hosts'] } } });
    // A relative path that leaves the project reads as none: never that file.
    await expect(renderForWork(diskOutputs.renders, projectB, 'climb-v1')).rejects.toMatchObject({ code: 'refused', message: `the video of render climb-v1 is no path Retake can read ${why}`, details: { untrusted: { paths: [''] } } });
  });
});
