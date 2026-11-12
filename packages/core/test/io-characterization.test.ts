/**
 * What core's loaders and its disk probes answer, pinned (golden/io-loaders.json): the workspace, project, scenario,
 * theme and sandbox readers on the fixture project and on a set of broken inputs, and the checks that look at the disk
 * (a file a scenario names, a file through a link out of the project, an env file, a SQL file a hook runs, a run made
 * by a newer Retake). Written before those readers moved to `@retake/core/io` and their probes behind the FileFacts
 * port: the same answers after the move. Paths are shown relative to the repository (`<repo>`) or to the scratch
 * folder (`<tmp>`); the fixture's contents are left out (the fixture changes with the product), except what ffprobe says
 * of its committed video files. The cases after the first commit (a synthetic sandbox's seed hash, the fixture's videos
 * probed and checked) were recorded against the code before the move and match it.
 *
 * Goldens are written only on request: `RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/io-characterization.test.ts`
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, destructiveReason, hookWriteReason, parseProjectYaml, parseSandboxYaml, parseScenario, parseTemplateYaml } from '@retake/core';
import { composeEnvFile, findWorkspaceRoot, listProjects, listScenarioNames, listTemplates, loadProject, loadProjectTemplate, loadScenario, loadTemplate, loadWorkspaceConfig, nodeFileFacts, fileFacts, readRunRecord, readScenarioSource, scenarioSinceRun, seedFileRefs, seedHash } from '@retake/core/io';
import type { HookStep } from '@retake/core';
import { STUDIO_CONFINEMENT } from './helpers.js';
import { AGENT_CONFINEMENT } from '@retake/core';

const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const GOLDEN = fileURLToPath(new URL('./golden/io-loaders.json', import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-io-char-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ffprobe names the demuxer it failed in with its address in memory (`[mov,mp4,… @ 0x…]`): left out.
const shown = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).split(tmp).join('<tmp>').split(REPO).join('<repo>').replace(/ @ 0x[0-9a-f]+\]/g, ' @ 0x…]'));
const issuesOf = (xs: ReadonlyArray<{ severity: string; path: unknown; message: string }> | undefined) => shown((xs ?? []).map((i) => [i.severity, i.path, i.message]));
async function outcome<T>(f: () => Promise<T> | T, keep: (v: T) => unknown = (v) => v): Promise<unknown> {
  try {
    return { ok: shown(keep(await f())) };
  } catch (e) {
    const err = e as Error & { issues?: Array<{ severity: string; path: unknown; message: string }> };
    return { error: err.name, message: shown(err.message), issues: issuesOf(err.issues) };
  }
}
const write = (rel: string, text: string): string => {
  const f = join(tmp, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
};

const got: Record<string, unknown> = {};
/** The FileFacts of a command a person types (no workspace ffmpeg, the agent policy off): what these readers looked at before. */
const work = fileFacts(PERSON_POLICY);

describe('core loaders and disk probes (characterization)', () => {
  it('the fixture workspace and project: what every reader answers', async () => {
    const fixtureDir = join(REPO, 'projects', 'northfield-fixture');
    got.findWorkspaceRoot = shown(findWorkspaceRoot(join(fixtureDir, 'scenarios')));
    got.workspace = await outcome(() => loadWorkspaceConfig(REPO));
    got.projects = await outcome(() => listProjects(REPO), (ps) => ps.filter((p) => p.slug === 'northfield-fixture'));
    const project = await loadProject('northfield-fixture', REPO);
    got.project = shown({
      slug: project.slug,
      dir: project.dir,
      root: project.root,
      readme: project.readme !== null,
      scenarios: project.scenarios,
      issues: issuesOf(project.issues),
      sandboxes: Object.fromEntries(Object.entries(project.sandboxes ?? {}).map(([k, s]) => [k, { file: s.file, dir: s.dir, issues: issuesOf(s.issues), secrets: s.secrets }])),
    });
    got.scenarioNames = await listScenarioNames(project.dir);
    const scenarios: Record<string, unknown> = {};
    for (const name of project.scenarios) {
      scenarios[name] = await outcome(() => loadScenario(project, name, { files: work }), (s) => ({ name: s.name, file: s.file, issues: issuesOf(s.issues) }));
    }
    got.scenarios = scenarios;
    got.scenarioSource = await outcome(() => readScenarioSource(project, 'quote'), (s) => ({ name: s.name, file: s.file, sha256: /^[0-9a-f]{64}$/.test(s.sha256) }));
    got.templates = await outcome(() => listTemplates(REPO));
    const themes: Record<string, unknown> = {};
    for (const name of ['default', 'editorial', 'motion']) themes[name] = await outcome(() => loadTemplate(name, REPO, { files: work }), (t) => ({ name: t.name, dir: t.dir, assets: t.assets }));
    got.themes = themes;
    got.projectTheme = await outcome(() => loadProjectTemplate(project, undefined, { files: work }), (t) => ({ name: t.name, dir: t.dir }));
    const seeds: Record<string, unknown> = {};
    for (const [env, s] of Object.entries(project.sandboxes ?? {})) seeds[env] = { refs: shown(await seedFileRefs(s)), hash: /^[0-9a-f]{64}$/.test(await seedHash(s)), envFile: shown(composeEnvFile(s) ?? null) };
    got.seeds = seeds;
  });

  it('broken inputs: what the readers refuse and the checks that look at the disk say', async () => {
    const broken: Record<string, unknown> = {};
    // Workspaces.
    write('ws-bad/retake.yaml', 'version: 1\nprojects_dir: [x]\n');
    broken.badWorkspace = await outcome(() => loadWorkspaceConfig(join(tmp, 'ws-bad')));
    write('ws-new/retake.yaml', 'version: 99\n');
    broken.newerWorkspace = await outcome(() => loadWorkspaceConfig(join(tmp, 'ws-new')));
    mkdirSync(join(tmp, 'ws-up', 'projects', 'p', 'scenarios'), { recursive: true });
    broken.findUpProjects = shown(findWorkspaceRoot(join(tmp, 'ws-up', 'projects', 'p', 'scenarios')));
    // Projects.
    write('ws/retake.yaml', 'version: 1\n');
    broken.noProject = await outcome(() => loadProject(join(tmp, 'ws', 'projects', 'none')));
    broken.unknownSlug = await outcome(() => loadProject('nortfield', join(tmp, 'ws')));
    write('ws/projects/p/project.yaml', 'version: 1\nname: P\nenvironments:\n  local: {app: "http://localhost:4990"}\nsandboxes:\n  sb: sandbox/sandbox.yaml\n');
    broken.missingSandbox = await outcome(() => loadProject('p', join(tmp, 'ws')));
    write('ws/projects/p/project.yaml', 'version: 1\nname: P\nenvironments:\n  local: {app: "http://localhost:4990"}\nhooks:\n  reset: {sql: hooks/missing.sql}\n');
    broken.missingHookFile = await outcome(() => loadProject('p', join(tmp, 'ws')), (p) => issuesOf(p.issues));
    broken.parseProjectMissingHook = issuesOf(parseProjectYaml(readFileSync(join(tmp, 'ws/projects/p/project.yaml'), 'utf8'), join(tmp, 'ws/projects/p/project.yaml'), nodeFileFacts).issues);
    write('ws/projects/p/project.yaml', 'version: 1\nname: P\nenvironments:\n  local: {app: "http://localhost:4990"}\n');
    write('ws/projects/p/README.md', '# P\n');
    const project = await loadProject('p', join(tmp, 'ws'));
    broken.plainProject = shown({ readme: project.readme, scenarios: project.scenarios, issues: issuesOf(project.issues) });
    // Scenarios: files a scenario names, checked on the disk.
    write('outside/secret.csv', 'a,b\n');
    write('ws/projects/p/data/rows.csv', 'a,b\n');
    symlinkSync(join(tmp, 'outside', 'secret.csv'), join(tmp, 'ws/projects/p/data/link.csv'));
    write('ws/projects/p/assets/logo.png', 'not a png');
    const scenarioText = (slot: string) => `version: 1\nvideo: s\nenv: local\nscenes:\n  - id: one\n    steps:\n      - open: "http://localhost:4990/"\n      - drop_file: {zone: {css: body}, path: "${slot}"}\n`;
    write('ws/projects/p/scenarios/missing.yaml', scenarioText('data/none.csv'));
    write('ws/projects/p/scenarios/present.yaml', scenarioText('data/rows.csv'));
    write('ws/projects/p/scenarios/link.yaml', scenarioText('data/link.csv'));
    write('ws/projects/p/scenarios/abs.yaml', scenarioText('/etc/hosts'));
    write('ws/projects/p/scenarios/image.yaml', 'version: 1\nvideo: s\nenv: local\noutro: {image: assets/logo.png, duration: 3}\nmusic: {file: assets/none.mp3}\nscenes:\n  - id: one\n    steps:\n      - open: "http://localhost:4990/"\n      - eval: {file: scenarios/none.js}\n');
    const p2 = await loadProject('p', join(tmp, 'ws'));
    for (const name of ['missing', 'present', 'link', 'abs', 'image']) {
      broken[`scenario:${name}`] = await outcome(() => loadScenario(p2, name, { files: work }), (s) => issuesOf(s.issues));
      for (const confined of ['mcp', 'studio'] as const) broken[`scenario:${name}:${confined}`] = await outcome(() => loadScenario(p2, name, { confined: { mcp: AGENT_CONFINEMENT, studio: STUDIO_CONFINEMENT }[confined], files: work }), (s) => issuesOf(s.issues));
    }
    const filesRead = new Set<string>();
    parseScenario(scenarioText('data/rows.csv'), { project: p2, filesRead, files: nodeFileFacts });
    broken.filesRead = shown([...filesRead].sort());
    broken.inferredProject = issuesOf(parseScenario(scenarioText('data/none.csv'), { file: join(tmp, 'ws/projects/p/scenarios/x.yaml'), files: nodeFileFacts }).issues);
    broken.noInferredProject = issuesOf(parseScenario(scenarioText('data/none.csv'), { file: join(tmp, 'ws/elsewhere/scenarios/x.yaml'), files: nodeFileFacts }).issues);
    broken.unknownScenario = await outcome(() => loadScenario(p2, 'nope', { files: work }));
    // Themes.
    write('ws/templates/t/template.yaml', 'version: 1\nlogo: logo.svg\n');
    broken.themeMissingAsset = await outcome(() => loadTemplate('t', join(tmp, 'ws'), { files: work }));
    mkdirSync(join(tmp, 'ws', 'templates', 'empty'), { recursive: true });
    broken.themeFolderWithoutFile = await outcome(() => loadTemplate('empty', join(tmp, 'ws'), { files: work }));
    broken.themeUnknown = await outcome(() => loadTemplate('defualt', join(tmp, 'ws'), { files: work }));
    broken.themeMedia = issuesOf(parseTemplateYaml('version: 1\ncomponents:\n  intro: {video: clip.mp4}\n  outro: {image: logo.svg}\n', { dir: join(tmp, 'ws', 'templates', 't'), files: fileFacts(PERSON_POLICY) }).issues);
    // Sandboxes.
    const sbFile = write('ws/projects/p/sandbox/sandbox.yaml', 'version: 1\nprovider: docker-compose\ncompose:\n  env_file: missing.env\n  files: [compose.yaml]\npages:\n  app: {url: "http://localhost:4991"}\n');
    broken.sandboxMissing = issuesOf(parseSandboxYaml(readFileSync(sbFile, 'utf8'), sbFile, { env: 'sb', project: { config: p2.config }, files: nodeFileFacts }).issues);
    write('ws/projects/p/sandbox/compose.yaml', 'services:\n  app: {image: "x"}\n');
    write('ws/projects/p/sandbox/.env', 'COMPOSE_PROFILES=all\n');
    const sbFile2 = write('ws/projects/p/sandbox/sandbox.yaml', 'version: 1\nprovider: docker-compose\ncompose:\n  files: [compose.yaml]\npages:\n  app: {url: "http://localhost:4991"}\n');
    broken.sandboxEnvProfiles = issuesOf(parseSandboxYaml(readFileSync(sbFile2, 'utf8'), sbFile2, { env: 'sb', project: { config: p2.config }, files: nodeFileFacts }).issues);
    const composeManifest = (compose: unknown) => ({ provider: 'docker-compose', compose }) as unknown as Parameters<typeof composeEnvFile>[0]['manifest'];
    broken.composeEnvFile = shown([composeEnvFile({ dir: dirname(sbFile2), manifest: composeManifest({ files: ['compose.yaml'] }) }) ?? null, composeEnvFile({ dir: dirname(sbFile2), manifest: composeManifest({ files: ['other/compose.yaml'] }) }) ?? null]);
    // Hooks whose SQL file is read from the project.
    write('ws/projects/p/hooks/wipe.sql', 'DELETE FROM quotes;\n');
    write('ws/projects/p/hooks/read.sql', 'SELECT 1;\n');
    const sql = (file: string) => ({ sql: file }) as unknown as HookStep;
    broken.destructive = shown([destructiveReason(sql('hooks/wipe.sql'), { projectDir: p2.dir, files: nodeFileFacts }), destructiveReason(sql('hooks/read.sql'), { projectDir: p2.dir, files: nodeFileFacts }), destructiveReason(sql('hooks/none.sql'), { projectDir: p2.dir, files: nodeFileFacts })]);
    broken.writes = shown([hookWriteReason(sql('hooks/wipe.sql'), { projectDir: p2.dir, files: nodeFileFacts }), hookWriteReason(sql('hooks/read.sql'), { projectDir: p2.dir, files: nodeFileFacts }), hookWriteReason(sql('hooks/none.sql'), { projectDir: p2.dir, files: nodeFileFacts })]);
    // Runs.
    write('ws/projects/p/runs/r1/run.json', '{"version": 99}');
    write('ws/projects/p/runs/r2/run.json', '{"version": 1}');
    // The refusal of a run.json a newer Retake wrote, as the one reader of run folders says it (L7.6a: readRunRecord).
    const newerRunMessage = async (dir: string) => {
      const r = await readRunRecord(join(dir, 'run.json'));
      return !r.ok && r.problem === 'newer-format' ? r.message : null;
    };
    broken.newerRun = shown([await newerRunMessage(join(tmp, 'ws/projects/p/runs/r1')), await newerRunMessage(join(tmp, 'ws/projects/p/runs/r2')), await newerRunMessage(join(tmp, 'ws/projects/p/runs/none'))]);
    write('ws/projects/p/runs/r2/scenario.yaml', scenarioText('data/old.csv'));
    broken.sinceRun = shown(scenarioSinceRun(p2, join(tmp, 'ws/projects/p/runs/r2'), 'present') ?? null);
    // The seed of a synthetic sandbox: the files it reads (its SQL steps, its seed folder) and their hash.
    write('ws/projects/p/seeded/seed/01-schema.sql', 'CREATE TABLE quotes (id int);\n');
    write('ws/projects/p/seeded/seed/rows/quotes.csv', 'id\n1\n');
    write('ws/projects/p/seeded/seed/.hidden', 'left out\n');
    write('ws/projects/p/seeded/extra.sql', 'INSERT INTO quotes VALUES (2);\n');
    const seeded = write('ws/projects/p/seeded/sandbox.yaml', 'version: 1\nprovider: process\nservices:\n  app: {command: [node, server.mjs], url: "http://localhost:4992", pages: {app: {url: "http://localhost:4992"}}}\nseed:\n  - sql: seed/01-schema.sql\n  - sql: {file: extra.sql, db: main}\ndatabases:\n  main: {url: "postgres://u:sandbox-pass-4992@localhost:4992/app"}\n');
    const seededManifest = parseSandboxYaml(readFileSync(seeded, 'utf8'), seeded, { env: 'seeded', project: { config: p2.config }, files: nodeFileFacts });
    const seededSandbox = { dir: dirname(seeded), manifest: seededManifest.manifest! };
    broken.seed = { issues: issuesOf(seededManifest.issues), refs: shown(await seedFileRefs(seededSandbox)), hash: await seedHash(seededSandbox), extra: await seedHash(seededSandbox, ['image:sha256:0']) };
    // The fixture's committed videos, probed (ffprobe of this machine) and checked as a scenario's intro and overlay.
    const fixtureAssets = join(REPO, 'projects', 'northfield-fixture', 'assets');
    copyFileSync(join(fixtureAssets, 'intro.mp4'), join(tmp, 'ws/projects/p/assets/clip.mp4'));
    copyFileSync(join(fixtureAssets, 'sparkle-burst.webm'), join(tmp, 'ws/projects/p/assets/burst.webm'));
    broken.videoProbe = await outcome(() => work.probeVideo(join(tmp, 'ws/projects/p/assets/clip.mp4')));
    broken.videoProbeWebm = await outcome(() => work.probeVideo(join(tmp, 'ws/projects/p/assets/burst.webm')));
    broken.videoProbeNotVideo = await outcome(() => work.probeVideo(join(tmp, 'ws/projects/p/assets/logo.png')));
    write('ws/projects/p/scenarios/video.yaml', 'version: 1\nvideo: s\nenv: local\nintro: {video: assets/clip.mp4, from: 0.5, to: 99, volume: 1, duration: 30}\noutro: {video: assets/logo.mp4}\nscenes:\n  - id: one\n    steps:\n      - open: "http://localhost:4990/"\n      - click: {text: Go}\n        overlay: {video: assets/clip.mp4}\n      - click: {text: Again}\n        overlay: {video: assets/burst.webm, loop: true, duration: 9}\n');
    copyFileSync(join(tmp, 'ws/projects/p/assets/logo.png'), join(tmp, 'ws/projects/p/assets/logo.mp4'));
    broken['scenario:video'] = await outcome(() => loadScenario(p2, 'video', { files: work }), (sc) => issuesOf(sc.issues));
    got.broken = broken;
  });

  it('matches the golden', () => {
    if (process.env.RETAKE_UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    if (!existsSync(GOLDEN)) throw new Error(`golden ${GOLDEN} is missing: run \`RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/io-characterization.test.ts\` and read it`);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
