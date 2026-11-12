import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, nestedShellScript, shellCommands, shellWords } from '@retake/core/base';
import { hookFileRefs, projectFileProblem } from '@retake/core/scenario';
import type { HookStep, ShellHookSpec } from '@retake/core/model';
import { nodeFileFacts } from '@retake/core/io';
import type { HookPhase } from './types.js';

/** Where a hook stands when its approval is asked for and checked: its list, its position, its environment. */
export interface HookPlace {
  phase: HookPhase;
  /** Position in its list (0-based). */
  index: number;
  /** The environment it runs on. */
  env: string;
  /**
   * The project files the hook references (hookFiles: its sql / js files, the files its shell command names), as
   * project-relative ref → sha256 of their bytes: a change to one of them is a change to the hook.
   */
  files?: Record<string, string>;
}

/**
 * The fingerprint a human approval is bound to (L3.1, R-MCP-35): sha256 of the raw hook as its file declares it — its
 * templates unresolved, so a dry preflight and the real run agree whatever `{{run.id}}` or a saved response holds —
 * with its phase, position and environment, and the sha256 of each project file it references (`place.files`). Any
 * change to the hook or to one of those files, or the same hook moved or run elsewhere, gives another fingerprint: the
 * approval no longer applies.
 */
export function hookFingerprint(hook: HookStep, place: HookPlace): string {
  const files = place.files && Object.keys(place.files).length ? place.files : undefined;
  return createHash('sha256')
    .update(canonicalJson({ v: 1, phase: place.phase, index: place.index, env: place.env, hook, ...(files ? { files } : {}) }))
    .digest('hex');
}

function sha256File(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Words of a shell command that may name a file: each word, and the value of `--opt=value`. */
function shellFileWords(run: string): string[] {
  const out: string[] = [];
  for (const { args } of shellCommands(shellWords(run))) {
    args.forEach((w, i) => {
      const nested = nestedShellScript(args, i);
      if (nested !== undefined) out.push(...shellFileWords(nested));
      if (i === 0 && !w.includes('/')) return; // a command looked up on PATH
      out.push(w);
      const eq = w.indexOf('=');
      if (w.startsWith('-') && eq > 0) out.push(w.slice(eq + 1));
    });
  }
  return out.filter((w) => w && !w.includes('{{') && !w.startsWith('-') && !isAbsolute(w) && !w.startsWith('~'));
}

/**
 * The project files a hook references, for work submitted through MCP (trust `mcp`): its sql file (and its rollback's)
 * and js file, and every relative word of its shell command (and rollback) that names an existing file under its working
 * directory — `./seed.sh`, `node scripts/x.mjs`, `psql -f reset.sql`. Each one's sha256 goes into the hook's
 * fingerprint (`files`); `problems` lists those it may not use (core projectFileProblem: outside the project folder, or
 * run as code from a file an agent can write). Files of a shell command outside the project are not followed.
 * `agentWritten` (a hook the agent wrote): the words of its shell command still bind the files they name, but are not
 * judged here — core agentShellProblems refuses every path of it through a folder an agent can write (kinds/shell.ts).
 */
export function hookFiles(hook: HookStep, o: { projectDir: string; baseDir?: string; agentWritten?: boolean }): { files: Record<string, string>; problems: string[] } {
  const baseDir = o.baseDir ?? o.projectDir;
  const files: Record<string, string> = {};
  const problems: string[] = [];
  for (const { ref, what } of hookFileRefs(hook)) {
    const problem = projectFileProblem(o.projectDir, ref, { baseDir, code: true, files: nodeFileFacts });
    if (problem) problems.push(`${what}: ${problem}`);
    else files[ref] = sha256File(resolve(baseDir, ref));
  }
  if (hook && typeof hook === 'object' && 'shell' in hook) {
    const spec = (hook as { shell: string | ShellHookSpec }).shell;
    const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
    const cwd = typeof s.cwd === 'string' && !s.cwd.includes('{{') ? resolve(baseDir, s.cwd) : baseDir;
    for (const run of [s.run, s.rollback]) {
      if (typeof run !== 'string') continue;
      for (const w of shellFileWords(run)) {
        const abs = resolve(cwd, w);
        if (!isFile(abs)) continue;
        const ref = s.cwd && cwd !== baseDir ? `${s.cwd}/${w}` : w;
        if (Object.hasOwn(files, ref)) continue;
        const problem = projectFileProblem(o.projectDir, w, { baseDir: cwd, code: true, files: nodeFileFacts });
        // A file the command names outside the project (a system tool by a relative path) is not the project's to bind.
        if (problem && /resolves outside the project folder/.test(problem)) continue;
        if (problem && o.agentWritten) continue;
        if (problem) problems.push(`shell command: ${problem}`);
        else files[ref] = sha256File(abs);
      }
    }
  }
  return { files, problems };
}
