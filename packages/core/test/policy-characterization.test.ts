/**
 * What the agent policy decides, pinned (golden/policy-decisions.json): for a command a person types (policy off) and
 * for work an agent can shape (policy on, the workspace's folders), the programs a job may start (inside the workspace,
 * a relative path, outside, through a link either way, a bare name found on a PATH folder inside, outside or relative,
 * a bare name not found), ffmpeg / ffprobe as the workspace names them, the browser switches, the environment of the
 * programs a job starts, and the workspace's render settings. Written while the policy was process-wide state, before
 * it became a value the engine passes on (core WorkPolicy): the same decisions after — `decide` builds the policy a
 * process opening that workspace had, and asks each rule under it.
 *
 * Goldens are written only on request: `RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/policy-characterization.test.ts`
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agentPolicy, childEnv, policyArgsProblems, policyChildEnv, policyProgram, programProblem, workspaceFolders } from '@retake/core';
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
  const at = (ffmpeg?: string, render?: RenderSettings): WorkPolicy => agentPolicy(on ? folders : null, ffmpeg, render);
  const policy = at();
  const out: Record<string, unknown> = { folders: shown(policy.agentFolders) };
  for (const [name, program, path] of PROGRAMS) {
    const o = path === undefined ? { files } : { path, files };
    out[`program: ${name}`] = shown({ problem: programProblem(policy, program, 'browser.executable', o), policy: policyProgram(policy, program, '$RETAKE_CHROMIUM', o) });
  }
  out.args = shown(ARGS.map((a) => policyArgsProblems(policy, a)));
  // `childEnv`: what a caller under this policy gets with its folders (hooks' unsigned rollbacks), as the process-wide default gave.
  out.env = shown({ plain: policyChildEnv(policy, SOURCE, { pass: ['DATABASE_URL', 'NODE_OPTIONS'], files }), docker: policyChildEnv(policy, SOURCE, { docker: true, files }), childEnv: childEnv(SOURCE, { folders: policy.agentFolders ?? [], files }), childEnvFolders: childEnv(SOURCE, { folders: [outside], files }) });
  for (const [name, configured, explicit] of FFMPEG) {
    const p = at(configured);
    out[`ffmpeg: ${name}`] = { ffmpeg: attempt(() => ffmpegBin(p, explicit)), ffprobe: attempt(() => ffprobeBin(p, explicit)) };
  }
  out.render = shown(at(undefined, { gl: 'gpu', concurrency: 2 }).render);
  out.renderEmpty = shown(at(undefined, {}).render);
  return out;
}

describe('agent policy decisions (characterization)', () => {
  it('a command a person types and work an agent can shape: every decision as pinned', () => {
    const got = { person: decisions(false), agent: decisions(true), afterOff: decisions(false) };
    if (process.env.RETAKE_UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    if (!existsSync(GOLDEN)) throw new Error(`golden ${GOLDEN} is missing: run \`RETAKE_UPDATE_GOLDEN=1 npx vitest run packages/core/test/policy-characterization.test.ts\` and read it`);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
