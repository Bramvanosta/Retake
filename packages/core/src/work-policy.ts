/** The agent policy of agent-policy.ts: the work an agent can shape, the programs and the browser switches it may name. */
import { delimiter, isAbsolute, resolve } from 'node:path';
import { agentArgsProblems } from './browser-switches.js';
import { isUnder } from './client-path.js';
import { needFiles } from './file-facts.js';
import type { FileFacts } from './file-facts.js';
import { showHiddenChars } from './printable.js';
import { realPathOf } from './real-path.js';
import type { RenderSettings } from './render-settings.js';

// ── Agent policy: the work an agent can shape ─────────────────────────────────────────────────────────────────────

/**
 * What a piece of work runs under, as the workspace it belongs to says: the agent policy and the workspace's own tool
 * settings. The engine builds it each time it opens a workspace (workPolicy) and passes it to every adapter that starts
 * a program, a browser or ffmpeg — there is no process-wide policy.
 */
export interface WorkPolicy {
  /**
   * The folders of the workspace whose jobs an agent can shape (workspaceFolders), or null. Set where the work serves
   * trust `mcp`: the jobs worker and its job processes (they run every job alike, whoever submitted it — the Studio's
   * and the desktop app's included), the MCP server and the Studio server. Null in a command a person types (the CLI).
   */
  readonly agentFolders: readonly string[] | null;
  /** retake.yaml `ffmpeg` (absolute when it names a path): the ffmpeg this work runs before `$RETAKE_FFMPEG`. */
  readonly ffmpeg?: string;
  /** retake.yaml `render:` (core render-settings.ts): the workspace's render settings. */
  readonly render?: RenderSettings;
}

/** The policy of work outside any workspace's settings that a person runs: the agent policy off, no workspace ffmpeg or render settings. */
export const PERSON_POLICY: WorkPolicy = Object.freeze({ agentFolders: null });

/**
 * The policy of the work of a workspace: `agent` turns the agent policy on for its folders (workspaceFolders); its
 * retake.yaml `ffmpeg` and `render:` come along (an empty `render:` is none).
 */
export function workPolicy(ws: { root: string; projectsDir?: string; templatesDir?: string; componentsDir?: string; ffmpeg?: string; render?: RenderSettings }, o: { agent: boolean }): WorkPolicy {
  return workPolicyFrom(o.agent ? workspaceFolders(ws) : null, ws.ffmpeg, ws.render);
}

/**
 * A WorkPolicy from its parts: the agent folders (resolved, each once) — or null, a person's policy (the agent policy
 * off) — and the workspace's ffmpeg and render settings.
 */
export function workPolicyFrom(folders: readonly string[] | null, ffmpeg?: string, render?: RenderSettings): WorkPolicy {
  const ff = ffmpeg?.trim() || undefined;
  return Object.freeze({
    agentFolders: folders ? Object.freeze([...new Set(folders.map((f) => resolve(f)))]) : null,
    ...(ff ? { ffmpeg: ff } : {}),
    ...(render && Object.keys(render).length ? { render: Object.freeze({ ...render }) } : {}),
  });
}

/** The folders an agent can write in a workspace: its root and its projects, templates and components folders. */
export function workspaceFolders(ws: { root: string; projectsDir?: string; templatesDir?: string; componentsDir?: string }): string[] {
  return [...new Set([ws.root, ws.projectsDir, ws.templatesDir, ws.componentsDir].filter((f): f is string => !!f).map((f) => resolve(f)))];
}

/** The file a bare command name runs, read from `path` as a spawn does: the first entry holding an executable file. */
function onPath(name: string, path: string, exists: (p: string) => boolean): { file: string; entry: string } | null {
  for (const raw of path.split(delimiter)) {
    // An empty entry is the current folder (POSIX).
    const entry = raw === '' ? '.' : raw;
    const file = resolve(entry, name);
    if (exists(file)) return { file, entry };
  }
  return null;
}

export interface ProgramPolicyOptions {
  /** The PATH a bare command name is looked up in (this process's: `@retake/core/io` programLookup()). */
  path: string;
  /** Whether a file is an executable file (default: the file system's answer, FileFacts.isExecutable). */
  exists?: (p: string) => boolean;
  /** How the file system is looked at (core FileFacts): real paths, executable files. */
  files: FileFacts;
}

/**
 * Why the program `program`, named by `what` (`browser.executable`, `$RETAKE_FFMPEG`, …), may not run for a job of a
 * workspace whose folders are `folders` (null when it may): a relative path (it names another file in each process's
 * folder), or a path inside one of the folders, under any spelling or through a link — an agent writes files there.
 * A bare command name is looked up in the PATH: the folder that holds it may not be relative or inside the workspace
 * either. An absolute path elsewhere, or a command found elsewhere on the PATH, may.
 */
export function agentProgramProblem(program: string, what: string, folders: readonly string[], o: ProgramPolicyOptions): string | null {
  return agentProgram(program, what, folders, o).problem;
}

/**
 * agentProgramProblem, and the file to start when it says nothing: the real path of the program it checked (for a bare
 * command name, of the file the PATH finds), links followed — so a link changed after the check starts nothing else.
 * A bare name the PATH does not find, and a refused program, are given back as they are.
 */
export function agentProgram(program: string, what: string, folders: readonly string[], o: ProgramPolicyOptions): { program: string; problem: string | null } {
  const p = program.trim();
  const refused = (problem: string) => ({ program, problem });
  if (!p) return { program, problem: null };
  const shown = showHiddenChars(p);
  const runs = 'jobs the Studio, the desktop app or an MCP client start run programs from outside the workspace only (an agent can write files in it)';
  if (!isAbsolute(p)) {
    if (p.includes('/')) return refused(`${what} (${shown}) is a relative path — ${runs}: give the absolute path of a program outside the workspace`);
    const files = needFiles(o.files, 'agentProgram');
    const found = onPath(p, o.path, o.exists ?? ((f) => files.isExecutable(f)));
    if (!found) return { program, problem: null };
    if (!isAbsolute(found.entry))
      return refused(
        `${what} (${shown}) is found through the relative PATH folder "${showHiddenChars(found.entry)}" — ${runs}: remove that folder from PATH, or give the absolute path of a program outside the workspace`,
      );
    const inside = folders.find((f) => isUnder(found.file, f, files));
    if (inside)
      return refused(
        `${what} (${shown}) is found on PATH at ${showHiddenChars(found.file)}, inside the workspace (${inside}) — ${runs}: remove that folder from PATH, or give the absolute path of a program outside the workspace`,
      );
    return { program: realPathOf(found.file, files), problem: null };
  }
  const files = needFiles(o.files, 'agentProgram');
  const inside = folders.find((f) => isUnder(p, f, files));
  if (inside) return refused(`${what} (${shown}) lies inside the workspace (${inside}) — ${runs}: move the program out of the workspace and point ${what} at its new place`);
  return { program: realPathOf(p, files), problem: null };
}

/** agentProgramProblem under a work's agent policy: null when the policy is off (a command a person types). */
export function programProblem(policy: WorkPolicy, program: string, what: string, o: ProgramPolicyOptions): string | null {
  return policy.agentFolders ? agentProgramProblem(program, what, policy.agentFolders, o) : null;
}

/**
 * agentProgram under a work's agent policy: the real path to start, or the refusal. Policy off (a command a person
 * types): the program as given, never refused.
 */
export function policyProgram(policy: WorkPolicy, program: string, what: string, o: ProgramPolicyOptions): { program: string; problem: string | null } {
  return policy.agentFolders ? agentProgram(program, what, policy.agentFolders, o) : { program, problem: null };
}

/** agentArgsProblems under a work's agent policy: none when the policy is off. */
export function policyArgsProblems(policy: WorkPolicy, args: readonly string[]): Array<{ index: number; message: string }> {
  return policy.agentFolders ? agentArgsProblems(args) : [];
}
