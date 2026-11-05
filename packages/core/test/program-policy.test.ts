/**
 * The agent policy (core agent-policy.ts): a process that serves trust `mcp` (the jobs worker, the MCP server, the
 * Studio server) runs no program named by a relative path or lying inside the workspace (any spelling, through a link
 * either way, a bare command found on PATH there), and passes Chromium only switches, none that loads code or files —
 * while a command a person types (policy off) keeps both. ffmpeg / ffprobe follow it wherever they are named.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_REFUSED_SWITCHES,
  agentArgProblem,
  agentArgsProblems,
  agentPolicyFolders,
  agentProgramProblem,
  ffmpegBin,
  ffprobeBin,
  loadWorkspaceConfig,
  policyArgsProblems,
  programProblem,
  useAgentPolicy,
  useWorkspaceFfmpeg,
  workspaceFolders,
} from '@retake/core';

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
afterEach(() => {
  useAgentPolicy(null);
  useWorkspaceFfmpeg(undefined);
});

describe('programs under the agent policy', () => {
  it('a program inside the workspace is refused under any spelling or link; one outside runs', () => {
    expect(agentProgramProblem(inWs, 'browser.executable', folders)).toMatch(/^browser\.executable \(.*\/ws\/bin\/tool\) lies inside the workspace .*: move the program out of the workspace and point browser\.executable at its new place$/);
    expect(agentProgramProblem(join(ws, 'projects', '..', 'bin', 'tool'), 'browser.executable', folders)).toMatch(/lies inside the workspace/);
    expect(agentProgramProblem(join(outside, 'bin', 'link-in'), '$RETAKE_CHROMIUM', folders)).toMatch(/^\$RETAKE_CHROMIUM .* lies inside the workspace/);
    expect(agentProgramProblem(join(ws, 'bin', 'link-out'), 'browser.executable', folders)).toMatch(/lies inside the workspace/);
    if (process.platform === 'darwin') expect(agentProgramProblem(inWs.toUpperCase(), 'browser.executable', folders)).toMatch(/lies inside the workspace/);
    expect(agentProgramProblem(outTool, 'browser.executable', folders)).toBeNull();
    expect(agentProgramProblem('/usr/bin/true', '$RETAKE_FFMPEG', folders)).toBeNull();
  });

  it('a relative path is refused; a bare command runs unless PATH finds it in the workspace or through a relative folder', () => {
    expect(agentProgramProblem('bin/tool', '$RETAKE_FFMPEG', folders)).toMatch(/^\$RETAKE_FFMPEG \(bin\/tool\) is a relative path — .*: give the absolute path of a program outside the workspace$/);
    expect(agentProgramProblem('./tool', 'browser.executable', folders)).toMatch(/is a relative path/);
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { path: [join(outside, 'bin'), join(ws, 'bin')].join(delimiter) })).toBeNull();
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { path: [join(ws, 'bin'), join(outside, 'bin')].join(delimiter) })).toMatch(/^ffmpeg \(tool\) is found on PATH at .*\/ws\/bin\/tool, inside the workspace .*: remove that folder from PATH/);
    expect(agentProgramProblem('tool', 'ffmpeg', folders, { path: ['bin', join(outside, 'bin')].join(delimiter), exists: (p) => p.endsWith('/bin/tool') })).toMatch(/is found through the relative PATH folder "bin"/);
    expect(agentProgramProblem('no-such-tool-anywhere', 'ffmpeg', folders, { path: join(ws, 'bin') })).toBeNull();
  });

  it('off in a command a person types: programProblem and policyArgsProblems say nothing until useAgentPolicy', () => {
    expect(agentPolicyFolders()).toBeNull();
    expect(programProblem(inWs, 'browser.executable')).toBeNull();
    expect(policyArgsProblems(['https://example.com/', '--user-data-dir=/x'])).toEqual([]);
    useAgentPolicy(workspaceFolders({ root: ws, projectsDir: join(ws, 'projects'), templatesDir: join(outside, 'templates') }));
    expect(agentPolicyFolders()).toEqual([ws, join(ws, 'projects'), join(outside, 'templates')]);
    expect(programProblem(inWs, 'browser.executable')).toMatch(/lies inside the workspace/);
    // The workspace's other folders count too (templates_dir outside the root).
    expect(programProblem(join(outside, 'templates', 'x'), 'browser.executable')).toMatch(/lies inside the workspace/);
    expect(policyArgsProblems(['--hide-scrollbars', 'https://example.com/'])).toEqual([{ index: 1, message: expect.stringMatching(/is not a switch/) }]);
    useAgentPolicy(null);
    expect(programProblem(inWs, 'browser.executable')).toBeNull();
  });

  it("ffmpeg and ffprobe: retake.yaml's or a variable's inside the workspace is refused under the policy, run by the CLI", async () => {
    writeFileSync(join(ws, 'retake.yaml'), 'ffmpeg: bin/tool\n');
    const cfg = await loadWorkspaceConfig(ws);
    useWorkspaceFfmpeg(cfg.ffmpeg);
    expect(ffmpegBin()).toBe(inWs);
    useAgentPolicy(workspaceFolders(cfg));
    expect(() => ffmpegBin()).toThrow(/^`ffmpeg:` of retake\.yaml \(.*\/ws\/bin\/tool\) lies inside the workspace/);
    expect(() => ffmpegBin(inWs)).toThrow(/^ffmpeg \(.*\) lies inside the workspace/);
    expect(ffmpegBin(outTool)).toBe(outTool);
    useWorkspaceFfmpeg(undefined);
    const saved = process.env.RETAKE_FFPROBE;
    process.env.RETAKE_FFPROBE = inWs;
    try {
      expect(() => ffprobeBin()).toThrow(/^\$RETAKE_FFPROBE \(.*\) lies inside the workspace .* point \$RETAKE_FFPROBE at its new place$/);
      useAgentPolicy(null);
      expect(ffprobeBin()).toBe(inWs);
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

  it('refuses the switches that load code or files, or open a debugging channel; keeps the others', () => {
    const refused = ['user-data-dir', 'load-extension', 'disable-extensions-except', 'register-pepper-plugins', 'js-flags', 'remote-allow-origins', 'allow-file-access-from-files', 'allow-file-access', 'enable-logging', 'log-file'];
    expect(Object.keys(AGENT_REFUSED_SWITCHES).sort()).toEqual([...refused].sort());
    for (const name of refused) {
      expect(agentArgProblem(`--${name}=/x`), name).toMatch(new RegExp(`^--${name} .* — .*remove it from browser\\.args`));
      expect(agentArgProblem(`--${name.toUpperCase()}`), name).not.toBeNull();
    }
    for (const a of ['--zygote-cmd-prefix=/bin/sh', '--renderer-cmd-prefix=x', '--ppapi-plugin-launcher=x', '--gpu-launcher', '--remote-debugging-pipe', '-remote-debugging-port=1']) expect(agentArgProblem(a), a).not.toBeNull();
    for (const a of ['--hide-scrollbars', '--lang=fr-FR', '--proxy-server=http://127.0.0.1:8080', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * 127.0.0.1', '--window-size=1280,800', '--force-device-scale-factor=2']) {
      expect(agentArgProblem(a), a).toBeNull();
    }
    expect(agentArgsProblems(['--lang=fr', '--user-data-dir=/tmp/p', 'x'])).toEqual([
      { index: 1, message: expect.stringMatching(/^--user-data-dir opens the browser on a profile folder/) },
      { index: 2, message: expect.stringMatching(/^"x" is not a switch/) },
    ]);
  });
});
