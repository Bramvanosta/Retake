/**
 * The FileFacts port (core file-facts.ts): the pure rules learn what they need of the disk through it — a rule that
 * needs the disk and is given none throws, never reads as "no file there" — and memoryFileFacts answers from a table
 * (links followed, folders above every entry), so a file rule runs without a disk.
 */
import { describe, expect, it } from 'vitest';
import { FileFactsMissingError, MediaProbeError, PERSON_POLICY, destructiveReason, memoryFileFacts, parseScenario, parseTemplateYaml } from '@retake/core';
import type { HookStep, LoadedProject } from '@retake/core';
import { fileFacts, nodeFileFacts } from '@retake/core/io';
import { AGENT_CONFINEMENT } from '@retake/core';

const DIR = '/p';
const project = {
  slug: 'p',
  dir: DIR,
  root: '/',
  file: `${DIR}/project.yaml`,
  issues: [],
  readme: null,
  scenarios: [],
  config: { name: 'P', environments: { local: { app: 'http://localhost:4990' } }, capture: {}, frame: 'card', template: 'default' },
} as unknown as LoadedProject;
const scenario = (path: string) =>
  `version: 1\nvideo: s\nenv: local\nscenes:\n  - id: one\n    steps:\n      - open: "http://localhost:4990/"\n      - drop_file: {zone: {css: body}, path: "${path}"}\n`;
/** A scenario whose intro shows the video file assets/clip.mp4. */
const INTRO = 'version: 1\nvideo: s\nenv: local\nintro: {video: assets/clip.mp4}\nscenes:\n  - id: one\n    steps:\n      - open: "http://localhost:4990/"\n';
const errors = (r: { issues: Array<{ severity: string; message: string }> }) => r.issues.filter((i) => i.severity === 'error').map((i) => i.message);

describe('FileFacts: the disk a pure rule looks at', () => {
  it('a rule that needs the disk without a FileFacts throws (never "not found"); one that needs none runs without it', () => {
    // @ts-expect-error — no FileFacts beside a place on purpose (the type refuses it, L7.34): the run-time refusal is held
    expect(() => parseScenario(scenario('data/a.csv'), { project })).toThrow(FileFactsMissingError);
    // @ts-expect-error — no FileFacts beside a place on purpose (the type refuses it, L7.34): the run-time refusal is held
    expect(() => parseScenario(scenario('data/a.csv'), { file: `${DIR}/scenarios/s.yaml` })).toThrow(/the project of a scenario file needs a FileFacts/);
    // @ts-expect-error — no FileFacts beside a place on purpose (the type refuses it, L7.34): the run-time refusal is held
    expect(() => destructiveReason({ sql: 'hooks/x.sql' } as unknown as HookStep, { projectDir: DIR })).toThrow(FileFactsMissingError);
    // @ts-expect-error — no FileFacts beside a place on purpose (the type refuses it, L7.34): the run-time refusal is held
    expect(() => parseTemplateYaml('version: 1\ncomponents:\n  intro: {video: clip.mp4}\n', { dir: '/t' })).toThrow(FileFactsMissingError);
    // No project, no file: nothing to look at.
    expect(errors(parseScenario(scenario('data/a.csv')))).toEqual([]);
  });

  it('the checks answer from a table as they do from the disk: a file there, missing, a folder, a link out of the project (refused for agent work)', () => {
    const files = memoryFileFacts({ [`${DIR}/data/a.csv`]: 'a,b\n', [`${DIR}/data/dir/x`]: 'x', '/outside/secret.csv': 's', [`${DIR}/data/link.csv`]: { link: '/outside/secret.csv' } });
    expect(errors(parseScenario(scenario('data/a.csv'), { project, files }))).toEqual([]);
    expect(errors(parseScenario(scenario('data/none.csv'), { project, files }))).toEqual(['file "data/none.csv" not found in the project']);
    expect(errors(parseScenario(scenario('data/dir'), { project, files }))).toEqual(['file "data/dir" not found in the project']);
    expect(errors(parseScenario(scenario('data/link.csv'), { project, files }))).toEqual([]);
    expect(errors(parseScenario(scenario('data/link.csv'), { project, files, confined: AGENT_CONFINEMENT }))).toEqual(['file "data/link.csv" not found in the project']);
  });

  it('memoryFileFacts: kinds, real paths through links (a folder link too), texts, first bytes, executables', () => {
    const f = memoryFileFacts({ '/a/b.txt': 'hello', '/l': { link: '/a' }, '/a/run': '#!/bin/sh\n' }, { executables: ['/a/run'] });
    expect([f.kind('/a'), f.kind('/a/b.txt'), f.kind('/l/b.txt'), f.kind('/nope')]).toEqual(['directory', 'file', 'file', undefined]);
    expect([f.ignoresCase, memoryFileFacts({}, { ignoresCase: true }).ignoresCase]).toEqual([false, true]);
    expect(f.realpath('/l/b.txt')).toBe('/a/b.txt');
    expect(f.nativeRealpath('/nope')).toBeUndefined();
    expect(f.readText('/l/b.txt')).toBe('hello');
    expect(() => f.readText('/a')).toThrow(/ENOENT/);
    expect(f.readHead('/a/b.txt', 2).toString('utf8')).toBe('he');
    expect(f.readHead('/nope', 2).length).toBe(0);
    expect([f.isExecutable('/a/run'), f.isExecutable('/a/b.txt')]).toEqual([true, false]);
  });

  it("nodeFileFacts is the disk only (a video is probed under a work's policy): a video check given it throws; fileFacts(policy) probes", () => {
    expect('probeVideo' in nodeFileFacts).toBe(false);
    expect(nodeFileFacts.ignoresCase).toBe(process.platform === 'darwin' || process.platform === 'win32');
    const files = memoryFileFacts({ [`${DIR}/assets/clip.mp4`]: 'x' });
    const { probeVideo: _, ...diskOnly } = files;
    expect(() => parseScenario(INTRO, { project, files: diskOnly })).toThrow(
      /^a video file check needs a VideoProber \(core file-facts\.ts\) to probe a video: pass fileFacts\(policy\) of @retake\/core\/io$/,
    );
    expect(() => parseScenario(INTRO, { project, files: diskOnly })).toThrow(FileFactsMissingError);
    expect(errors(parseScenario(INTRO, { project, files }))).toEqual(['"assets/clip.mp4" is not a video the renderer can read: /p/assets/clip.mp4 not found']);
    expect(() => fileFacts(PERSON_POLICY).probeVideo('/nope.mp4')).toThrow(/not found/);
  });

  it('a video check reports what ffprobe cannot say (MediaProbeError) and throws anything else', () => {
    const at = `${DIR}/assets/clip.mp4`;
    const disk = memoryFileFacts({ [at]: 'x' });
    const probing = (probeVideo: (file: string) => never) => ({ ...disk, probeVideo });
    expect(
      errors(
        parseScenario(INTRO, {
          project,
          files: probing(() => {
            throw new MediaProbeError('ffprobe cannot read it (moov atom not found)', 'unreadable');
          }),
        }),
      ),
    ).toEqual(['"assets/clip.mp4" is not a video the renderer can read: ffprobe cannot read it (moov atom not found)']);
    const missing = parseScenario(INTRO, {
      project,
      files: probing(() => {
        throw new MediaProbeError('ffprobe is not available (ENOENT): install ffmpeg', 'no-ffprobe');
      }),
    });
    expect(missing.issues.map((i) => [i.severity, i.message])).toContainEqual([
      'warning',
      'cannot check "assets/clip.mp4": ffprobe is not available (ENOENT): install ffmpeg (the render needs it too)',
    ]);
    expect(() =>
      parseScenario(INTRO, {
        project,
        files: probing(() => {
          throw new TypeError('a bug');
        }),
      }),
    ).toThrow(TypeError);
  });
});
