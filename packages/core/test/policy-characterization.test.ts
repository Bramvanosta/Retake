/**
 * What the agent policy decides, pinned (golden/policy-decisions.json): for a command a person types (policy off) and
 * for work an agent can shape (policy on, the workspace's folders), the programs a job may start (inside the workspace,
 * a relative path, outside, through a link either way, a bare name found on a PATH folder inside, outside or relative,
 * a bare name not found), ffmpeg / ffprobe as the workspace names them, the browser switches, the environment of the
 * programs a job starts, and the workspace's render settings. Written while the policy was process-wide state, before
 * it became a value the engine passes on (core WorkPolicy): the same decisions after — `decide` builds the policy a
 * process opening that workspace had, and asks each rule under it.
 *
 * Added since (recorded against the process-wide code and matching it): ffmpeg / ffprobe named by $RETAKE_FFMPEG /
 * $RETAKE_FFPROBE, the paths of an agent-written shell command (a project's agent-writable folders, one beside it, `~`,
 * a link into them), and — on a file system that ignores case — a program or a PATH entry spelt in another case.
 *
 * Goldens are written only on request: `RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/policy-characterization.test.ts`
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agentShellCwdProblems, agentShellProblems, agentWritablePath, childEnv, policyArgsProblems, policyChildEnv, policyProgram, programProblem, workPolicyFrom, workspaceFolders } from '@retake/core';
import type { RenderSettings, WorkPolicy } from '@retake/core';
import { ffmpegBin, ffprobeBin, nodeFileFacts } from '@retake/core/io';

const GOLDEN = fileURLToPath(new URL('./golden/policy-decisions.json', import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-policy-char-')));
const ws = join(tmp, 'ws');
const outside = join(tmp, 'outside');
for (const d of [join(ws, 'bin'), join(ws, 'projects'), join(outside, 'bin')]) mkdirSync(d, { recursive: true });
const exe = (p: string) => {
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};
const inWs = exe(join(ws, 'bin', 'tool'));
const outTool = exe(join(outside, 'bin', 'tool'));
exe(join(ws, 'bin', 'ffprobe'));
exe(join(outside, 'bin', 'ffprobe'));
exe(join(outside, 'bin', 'ffmpeg'));
symlinkSync(inWs, join(outside, 'bin', 'link-in'));
symlinkSync(outTool, join(ws, 'bin', 'link-out'));
const folders = workspaceFolders({ root: ws, projectsDir: join(ws, 'projects'), templatesDir: join(outside, 'templates') });

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const files = nodeFileFacts;

const shown = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).split(tmp).join('<tmp>'));
const attempt = (f: () => unknown): unknown => {
  try {
    return { ok: shown(f()) };
  } catch (e) {
    return { error: (e as Error).name, message: shown((e as Error).message) };
  }
};

/**
 * A row's PATH (name, program, PATH): a bare name gives the PATH it is looked up on; every other row names a path and
 * needs none. A bare name without one would be looked up in the current folder (an empty PATH entry is `.`) and the
 * table would characterise this machine, not the policy: refused.
 */
const pathOf = (program: string, path: string | undefined): string => {
  if (path === undefined && program.trim() !== '' && !/[\\/]/.test(program)) throw new Error(`the row for "${program}" is a bare name: give its PATH`);
  return path ?? '';
};
const PROGRAMS: Array<[string, string, string?]> = [
  ['inside', inWs],
  ['inside, another spelling', join(ws, 'projects', '..', 'bin', 'tool')],
  ['relative', 'bin/tool'],
  ['outside', outTool],
  ['link out to in', join(outside, 'bin', 'link-in')],
  ['link in to out', join(ws, 'bin', 'link-out')],
  ['bare, PATH inside', 'tool', join(ws, 'bin')],
  ['bare, PATH outside', 'tool', join(outside, 'bin')],
  ['bare, PATH relative', 'tool', 'bin'],
  ['bare, not found', 'no-such-tool', join(outside, 'bin')],
  ['empty', '  '],
];
const ARGS = [['--hide-scrollbars', 'https://example.com/'], ['--no-sandbox'], ['--user-data-dir=/x'], ['--headless=new', '--lang=fr'], ['--enable-features=SitePerProcess'], []];
const SOURCE = { PATH: [join(ws, 'bin'), join(outside, 'bin'), 'bin', '/usr/bin'].join(delimiter), HOME: '/home/x', TOKEN: 's3cret', DATABASE_URL: 'postgres://x', DOCKER_HOST: 'unix:///x', DOCKER_PASSWORD: 'p', NODE_OPTIONS: '--require x' };
const FFMPEG: Array<[string, string | undefined, string | undefined]> = [
  ['none', undefined, undefined],
  ['retake.yaml inside', join(ws, 'bin', 'tool'), undefined],
  ['retake.yaml outside', join(outside, 'bin', 'tool'), undefined],
  ['retake.yaml bare', 'ffmpeg', undefined],
  ['explicit inside', undefined, inWs],
  ['explicit outside', undefined, outTool],
];

/** $RETAKE_FFMPEG / $RETAKE_FFPROBE as the worker's environment names them (retake.yaml names none). */
const FFMPEG_ENV: Array<[string, Record<string, string>]> = [
  ['$RETAKE_FFMPEG inside', { RETAKE_FFMPEG: inWs }],
  ['$RETAKE_FFMPEG outside', { RETAKE_FFMPEG: outTool }],
  ['$RETAKE_FFMPEG relative', { RETAKE_FFMPEG: 'bin/tool' }],
  ['$RETAKE_FFMPEG bare', { RETAKE_FFMPEG: 'ffmpeg' }],
  ['$RETAKE_FFMPEG through a link in', { RETAKE_FFMPEG: join(outside, 'bin', 'link-in') }],
  ['$RETAKE_FFPROBE inside, $RETAKE_FFMPEG outside', { RETAKE_FFMPEG: outTool, RETAKE_FFPROBE: inWs }],
];

/** Every decision, for a process whose agent policy is `on` (the workspace's folders) or off. */
function decisions(on: boolean): Record<string, unknown> {
  // ffmpeg and ffprobe by name: the PATH of this test only (never this machine's own tools).
  const saved = { PATH: process.env.PATH, RETAKE_FFMPEG: process.env.RETAKE_FFMPEG, RETAKE_FFPROBE: process.env.RETAKE_FFPROBE };
  process.env.PATH = join(outside, 'bin');
  delete process.env.RETAKE_FFMPEG;
  delete process.env.RETAKE_FFPROBE;
  try {
    return decide(on);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

function decide(on: boolean): Record<string, unknown> {
  const at = (ffmpeg?: string, render?: RenderSettings): WorkPolicy => workPolicyFrom(on ? folders : null, ffmpeg, render);
  const policy = at();
  const out: Record<string, unknown> = { folders: shown(policy.agentFolders) };
  for (const [name, program, path] of PROGRAMS) {
    const o = { path: pathOf(program, path), files };
    out[`program: ${name}`] = shown({ problem: programProblem(policy, program, 'browser.executable', o), policy: policyProgram(policy, program, '$RETAKE_CHROMIUM', o) });
  }
  out.args = shown(ARGS.map((a) => policyArgsProblems(policy, a)));
  // `childEnv`: what a caller under this policy gets with its folders (hooks' unsigned rollbacks), as the process-wide default gave.
  out.env = shown({ plain: policyChildEnv(policy, SOURCE, { pass: ['DATABASE_URL', 'NODE_OPTIONS'], files }), docker: policyChildEnv(policy, SOURCE, { docker: true, files }), childEnv: childEnv(SOURCE, { folders: policy.agentFolders ?? [], files }), childEnvFolders: childEnv(SOURCE, { folders: [outside], files }) });
  for (const [name, configured, explicit] of FFMPEG) {
    const p = at(configured);
    out[`ffmpeg: ${name}`] = { ffmpeg: attempt(() => ffmpegBin(p, explicit)), ffprobe: attempt(() => ffprobeBin(p, explicit)) };
  }
  for (const [name, vars] of FFMPEG_ENV) {
    Object.assign(process.env, vars);
    try {
      out[`ffmpeg: ${name}`] = { ffmpeg: attempt(() => ffmpegBin(policy)), ffprobe: attempt(() => ffprobeBin(policy)) };
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  }
  out.render = shown(at(undefined, { gl: 'gpu', concurrency: 2 }).render);
  out.renderEmpty = shown(at(undefined, {}).render);
  return out;
}

/** A project of the workspace (and one beside it) whose agent-writable folders a shell command's paths may lead through. */
const project = join(ws, 'projects', 'p');
for (const d of [join(project, 'runs', 'r1'), join(project, 'scenarios'), join(project, 'hooks'), join(ws, 'projects', 'q', 'runs')]) mkdirSync(d, { recursive: true });
symlinkSync(join(project, 'runs'), join(project, 'tools'));
symlinkSync(join(project, 'runs', 'r1'), join(outside, 'into-runs'));
const SHELL_PATHS = ['runs/r1/a.sh', './scenarios/../hooks/a.sh', 'hooks/a.sh', 'README.md', 'RUNS/r1/a.sh', '../q/runs/a.sh', '../q/hooks/a.sh', 'tools/a.sh', join(outside, 'into-runs', 'a.sh'), `file://${project}/README.md`, '~/x.sh', '~', '/etc/hosts', 'missing/deeper/a.sh'];
const SHELL_COMMANDS = ['sh runs/r1/a.sh', 'cat README.md && ls', 'node scenarios/x.js', 'bash hooks/a.sh', 'sh tools/a.sh', 'sh ../q/runs/a.sh', 'psql -f runs/r1/x.sql', 'cp a b; rm c', 'echo $HOME', 'node -e 1', 'npx something', 'ls /etc'];
const SHELL_CWDS = ['.', 'runs', 'hooks', 'tools/r1', '../q/runs', 'two words'];

/** The paths and commands of an agent-written shell hook (the same with the policy on or off: these rules are for agent text). */
function shell(): Record<string, unknown> {
  const o = { projectDir: project, home: outside, files };
  return {
    paths: shown(Object.fromEntries(SHELL_PATHS.map((p) => [p.split(tmp).join('<tmp>'), agentWritablePath(p, o)]))),
    pathsFromRuns: shown(Object.fromEntries(SHELL_PATHS.map((p) => [p.split(tmp).join('<tmp>'), agentWritablePath(p, { ...o, cwd: join(project, 'runs') })]))),
    commands: shown(Object.fromEntries(SHELL_COMMANDS.map((c) => [c, agentShellProblems(c, o)]))),
    cwds: shown(Object.fromEntries(SHELL_CWDS.map((c) => [c, agentShellCwdProblems(c, o)]))),
  };
}

/** On a file system that ignores case: the workspace's programs and PATH entries spelt in another case (after the scratch folder). */
function caseFolded(): Record<string, unknown> {
  const policy = workPolicyFrom(folders);
  const other = (...parts: string[]) => join(tmp, ...parts);
  const programs: Array<[string, string, string?]> = [
    ['inside, upper case', other('WS', 'BIN', 'TOOL')],
    ['inside, mixed case', other('Ws', 'bin', 'Tool')],
    ['inside, missing, other case', other('WS', 'bin', 'not-there')],
    ['bare, PATH inside in other case', 'tool', other('WS', 'BIN')],
    ['outside, upper case', other('OUTSIDE', 'BIN', 'TOOL')],
  ];
  const out: Record<string, unknown> = {};
  for (const [name, program, path] of programs) {
    const o = { path: pathOf(program, path), files };
    out[`program: ${name}`] = shown({ problem: programProblem(policy, program, 'browser.executable', o), policy: policyProgram(policy, program, '$RETAKE_CHROMIUM', o) });
  }
  const source = { PATH: [other('WS', 'BIN'), other('Ws', 'projects', 'missing'), other('OUTSIDE', 'bin'), '/usr/bin'].join(delimiter) };
  out.env = shown(childEnv(source, { folders: policy.agentFolders ?? [], files }));
  out.folders = shown(programProblem(workPolicyFrom([other('WS')]), inWs, 'browser.executable', { files, path: '' }));
  return out;
}

describe('agent policy decisions (characterization)', () => {
  it('a command a person types and work an agent can shape: every decision as pinned', () => {
    const got: Record<string, unknown> = { person: decisions(false), agent: decisions(true), afterOff: decisions(false), shell: shell() };
    // Case-folded spellings only where the file system ignores case (the golden is recorded on one).
    if (process.platform === 'darwin') got.caseFolded = caseFolded();
    if (process.env.RETAKE_UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    if (!existsSync(GOLDEN)) throw new Error(`golden ${GOLDEN} is missing: run \`RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/policy-characterization.test.ts\` and read it`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    if (process.platform !== 'darwin') delete golden.caseFolded;
    expect(got).toEqual(golden);
  });
});
