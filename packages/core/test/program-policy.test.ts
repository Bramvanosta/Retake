/**
 * The agent policy (core agent-policy.ts): a process that serves trust `mcp` (the jobs worker, the MCP server, the
 * Studio server) runs no program named by a relative path or lying inside the workspace (any spelling, through a link
 * either way, a bare command found on PATH there) and starts the one it checked by its real path; it passes Chromium
 * only switches of an allow-list — while a command a person types (policy off) keeps both. ffmpeg / ffprobe follow it
 * wherever they are named.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ALLOWED_SWITCHES, AGENT_REFUSED_FEATURES, PERSON_POLICY, agentArgProblem, agentArgsProblems, agentPolicy, agentProgram, agentProgramProblem, policyArgsProblems, policyProgram, programProblem, workspaceFolders } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { ffmpegBin, ffprobeBin, loadWorkspaceConfig, nodeFileFacts as files } from '@retake/core/io';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-program-policy-')));
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
// A link outside the workspace to a program inside it, and one inside to a program outside.
symlinkSync(inWs, join(outside, 'bin', 'link-in'));
symlinkSync(outTool, join(ws, 'bin', 'link-out'));
const folders = [ws];

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/** The policy the rules below run under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;
beforeEach(() => {
  policy = PERSON_POLICY;
});

describe('programs under the agent policy', () => {
  it('a program inside the workspace is refused under any spelling or link; one outside runs', () => {
    expect(agentProgramProblem(inWs, 'browser.executable', folders, { files })).toMatch(/^browser\.executable \(.*\/ws\/bin\/tool\) lies inside the workspace .*: move the program out of the workspace and point browser\.executable at its new place$/);
    expect(agentProgramProblem(join(ws, 'projects', '..', 'bin', 'tool'), 'browser.executable', folders, { files })).toMatch(/lies inside the workspace/);
    expect(agentProgramProblem(join(outside, 'bin', 'link-in'), '$RETAKE_CHROMIUM', folders, { files })).toMatch(/^\$RETAKE_CHROMIUM .* lies inside the workspace/);
    expect(agentProgramProblem(join(ws, 'bin', 'link-out'), 'browser.executable', folders, { files })).toMatch(/lies inside the workspace/);
    if (process.platform === 'darwin') expect(agentProgramProblem(inWs.toUpperCase(), 'browser.executable', folders, { files })).toMatch(/lies inside the workspace/);
    expect(agentProgramProblem(outTool, 'browser.executable', folders, { files })).toBeNull();
    expect(agentProgramProblem('/usr/bin/true', '$RETAKE_FFMPEG', folders, { files })).toBeNull();
  });

  it('a relative path is refused; a bare command runs unless PATH finds it in the workspace or through a relative folder', () => {
    expect(agentProgramProblem('bin/tool', '$RETAKE_FFMPEG', folders, { files })).toMatch(/^\$RETAKE_FFMPEG \(bin\/tool\) is a relative path — .*: give the absolute path of a program outside the workspace$/);
    expect(agentProgramProblem('./tool', 'browser.executable', folders, { files })).toMatch(/is a relative path/);
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { files, path: [join(outside, 'bin'), join(ws, 'bin')].join(delimiter) })).toBeNull();
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { files, path: [join(ws, 'bin'), join(outside, 'bin')].join(delimiter) })).toMatch(/^ffmpeg \(tool\) is found on PATH at .*\/ws\/bin\/tool, inside the workspace .*: remove that folder from PATH/);
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { files, path: ['bin', join(outside, 'bin')].join(delimiter), exists: (p) => p.endsWith('/bin/tool') })).toMatch(/is found through the relative PATH folder "bin"/);
    expect(agentProgramProblem('no-such-tool-anywhere', 'ffmpeg', folders, { files, path: join(ws, 'bin') })).toBeNull();
  });

  it('off in a command a person types: programProblem and policyArgsProblems say nothing until useAgentPolicy', () => {
    expect(policy.agentFolders).toBeNull();
    expect(programProblem(policy, inWs, 'browser.executable', { files })).toBeNull();
    expect(policyArgsProblems(policy, ['https://example.com/', '--user-data-dir=/x'])).toEqual([]);
    policy = agentPolicy(workspaceFolders({ root: ws, projectsDir: join(ws, 'projects'), templatesDir: join(outside, 'templates') }), policy.ffmpeg);
    expect(policy.agentFolders).toEqual([ws, join(ws, 'projects'), join(outside, 'templates')]);
    expect(programProblem(policy, inWs, 'browser.executable', { files })).toMatch(/lies inside the workspace/);
    // The workspace's other folders count too (templates_dir outside the root).
    expect(programProblem(policy, join(outside, 'templates', 'x'), 'browser.executable', { files })).toMatch(/lies inside the workspace/);
    expect(policyArgsProblems(policy, ['--hide-scrollbars', 'https://example.com/'])).toEqual([{ index: 1, message: expect.stringMatching(/is not a switch/) }]);
    policy = agentPolicy(null, policy.ffmpeg);
    expect(programProblem(policy, inWs, 'browser.executable', { files })).toBeNull();
  });

  it('the program to start is the real path that was checked (a link outside, a bare command on PATH); the policy off gives it back as it is', () => {
    expect(agentProgram(join(outside, 'bin', 'link-out-of-ws'), 'browser.executable', folders, { files })).toEqual({ program: join(outside, 'bin', 'link-out-of-ws'), problem: null });
    symlinkSync(outTool, join(outside, 'bin', 'link-to-out'));
    expect(agentProgram(join(outside, 'bin', 'link-to-out'), 'browser.executable', folders, { files })).toEqual({ program: outTool, problem: null });
    expect(agentProgram('link-to-out', 'ffmpeg', folders, { files, path: join(outside, 'bin') })).toEqual({ program: outTool, problem: null });
    expect(agentProgram('no-such-tool-anywhere', 'ffmpeg', folders, { files, path: join(outside, 'bin') })).toEqual({ program: 'no-such-tool-anywhere', problem: null });
    expect(agentProgram(join(outside, 'bin', 'link-in'), 'browser.executable', folders, { files })).toEqual({ program: join(outside, 'bin', 'link-in'), problem: expect.stringMatching(/lies inside the workspace/) });
    expect(policyProgram(policy, join(outside, 'bin', 'link-to-out'), 'browser.executable', { files })).toEqual({ program: join(outside, 'bin', 'link-to-out'), problem: null });
    policy = agentPolicy(folders, policy.ffmpeg);
    expect(policyProgram(policy, join(outside, 'bin', 'link-to-out'), 'browser.executable', { files })).toEqual({ program: outTool, problem: null });
    expect(policyProgram(policy, inWs, 'browser.executable', { files }).problem).toMatch(/lies inside the workspace/);
  });

  it("ffmpeg and ffprobe: retake.yaml's or a variable's inside the workspace is refused under the policy, run by the CLI", async () => {
    writeFileSync(join(ws, 'retake.yaml'), 'ffmpeg: bin/tool\n');
    const cfg = await loadWorkspaceConfig(ws);
    policy = agentPolicy(policy.agentFolders, cfg.ffmpeg);
    expect(ffmpegBin(policy)).toBe(inWs);
    policy = agentPolicy(workspaceFolders(cfg), policy.ffmpeg);
    expect(() => ffmpegBin(policy)).toThrow(/^`ffmpeg:` of retake\.yaml \(.*\/ws\/bin\/tool\) lies inside the workspace/);
    expect(() => ffmpegBin(policy, inWs)).toThrow(/^ffmpeg \(.*\) lies inside the workspace/);
    expect(ffmpegBin(policy, outTool)).toBe(outTool);
    // Started by the real path that was checked: a link changed afterwards starts nothing else.
    symlinkSync(outTool, join(outside, 'bin', 'ff-link'));
    expect(ffmpegBin(policy, join(outside, 'bin', 'ff-link'))).toBe(outTool);
    policy = agentPolicy(policy.agentFolders, undefined);
    const saved = process.env.RETAKE_FFPROBE;
    process.env.RETAKE_FFPROBE = inWs;
    try {
      expect(() => ffprobeBin(policy)).toThrow(/^\$RETAKE_FFPROBE \(.*\) lies inside the workspace .* point \$RETAKE_FFPROBE at its new place$/);
      policy = agentPolicy(null, policy.ffmpeg);
      expect(ffprobeBin(policy)).toBe(inWs);
    } finally {
      if (saved === undefined) delete process.env.RETAKE_FFPROBE;
      else process.env.RETAKE_FFPROBE = saved;
    }
  });
});

describe('browser.args under the agent policy', () => {
  it('refuses an argument that is not a switch (a page or a file Chromium would open), and everything after --', () => {
    for (const a of ['https://example.com/', 'file:///etc/hosts', 'page.html', '--', '---x', '--name value', '']) expect(agentArgProblem(a), a).toMatch(/is not a switch \(Chromium opens such an argument as a page or a file\) — .*: remove it from browser\.args/);
  });

  it('an allow-list: the switches of AGENT_ALLOWED_SWITCHES pass (any case, with a value); every other switch is refused', () => {
    for (const name of AGENT_ALLOWED_SWITCHES) {
      expect(agentArgProblem(`--${name}`), name).toBeNull();
      expect(agentArgProblem(`--${name.toUpperCase()}=1`), name).toBeNull();
    }
    for (const a of ['--hide-scrollbars', '--lang=fr-FR', '--proxy-server=http://127.0.0.1:8080', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * 127.0.0.1', '--window-size=1280,800', '--force-device-scale-factor=2', '--disable-features=Translate', '--use-angle=metal']) {
      expect(agentArgProblem(a), a).toBeNull();
    }
    // Switches that load code or a profile, write logs, dumps or traces, trust other certificates, open a page or a
    // debugging channel — none is on the list, nor any switch Chromium may add later.
    const refused = [
      '--user-data-dir=/x', '--load-extension=/x', '--disable-extensions-except=/x', '--register-pepper-plugins=/x', '--js-flags=--allow-natives-syntax',
      '--remote-allow-origins=*', '--allow-file-access-from-files', '--allow-file-access', '--enable-logging', '--log-file=/x', '--v=1', '--vmodule=*=3',
      '--ssl-key-log-file=/x', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=x', '--user-agent=x', '--homepage=https://example.com/',
      '--app=https://example.com/', '--disk-cache-dir=/x', '--crash-dumps-dir=/x', '--enable-crash-reporter', '--trace-startup', '--trace-startup-file=/x',
      '--enable-net-benchmarking', '--net-log-capture-mode=Everything', '--log-net-log=/x', '--zygote-cmd-prefix=/bin/sh', '--ppapi-plugin-launcher=x',
      '--remote-debugging-pipe', '-remote-debugging-port=1', '--use-fake-ui-for-media-stream', '--unsafely-treat-insecure-origin-as-secure=http://x.example', '--a-switch-of-a-later-chromium',
    ];
    for (const a of refused) expect(agentArgProblem(a), a).toMatch(/^--\S+ is not one of the switches these jobs may pass — .*: remove it from browser\.args \(a run typed in a terminal keeps it\)$/);
    expect(agentArgsProblems(['--lang=fr', '--user-data-dir=/tmp/p', 'x'])).toEqual([
      { index: 1, message: expect.stringMatching(/^--user-data-dir is not one of the switches these jobs may pass/) },
      { index: 2, message: expect.stringMatching(/^"x" is not a switch/) },
    ]);
  });

  it('a feature list may not take the network service out of its sandbox (any case, `-` / `_`, a trial group after `<` or `:`)', () => {
    expect(AGENT_REFUSED_FEATURES).toEqual({ enable: ['NetworkServiceInProcess', 'NetworkServiceInProcess2'], disable: ['NetworkServiceSandbox'] });
    for (const a of ['--disable-features=Translate,NetworkServiceSandbox', '--disable-features=network_service_sandbox<Trial', '--enable-features=NetworkServiceInProcess', '--ENABLE-FEATURES=x,*networkserviceinprocess2:p/1']) {
      expect(agentArgProblem(a), a).toMatch(/takes Chromium's network service out of its sandbox — /);
    }
    for (const a of ['--enable-features=NetworkServiceSandbox', '--disable-features=NetworkServiceInProcess', '--enable-features=Vulkan', '--disable-features=Translate,MediaRouter']) expect(agentArgProblem(a), a).toBeNull();
  });
});
