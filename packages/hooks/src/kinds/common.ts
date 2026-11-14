import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { collectSandboxRefs, collectSecretRefs } from '@retake/core/base';
import { projectFileProblem, secretRefsProblem } from '@retake/core/scenario';
import { nodeFileFacts } from '@retake/core/io';
import { HookError, HookSecurityError } from '../errors.js';
import { journalsRollback } from '../types.js';
import type { ShownAction } from '../shown.js';
import type { HookContext, HookLogLevel, HookPhase, RollbackAction } from '../types.js';

export interface KindEnv {
  ctx: HookContext;
  phase: HookPhase;
  /** Redacting logger. */
  log: (level: HookLogLevel, msg: string) => void;
  /**
   * Trust `mcp`: the hook was written by the agent (RunHooksOptions.agentWritten, or a hook rendered with the variables
   * the agent wrote — HookContext.agentVars). A shell one is plain words joined by ` && ` and
   * follows the rules of core agentShellProblems (kinds/shell.ts checkAgentShell).
   */
  agentWritten?: boolean;
}

export type RollbackEnv = Pick<KindEnv, 'ctx' | 'log'> & {
  /** The replay runs on a read-only environment (the entry's own, L1.7): SQL runs in a read-only transaction. */
  readOnly?: boolean;
  /**
   * The environment the hook ran in (the journal entry's): a sql rollback reaches that environment's databases (a
   * sandbox's own, L1.8), not the command's. Undefined: the context's.
   */
  env?: string;
  /**
   * L5.14: the entry was not signed by this Retake home (a person said yes to it in a terminal): a shell rollback runs
   * with a bare environment (PATH, HOME, the locale and Retake's own variables), not the rest of the terminal's.
   */
  unsigned?: boolean;
};

/** The folder hook files and shell working directories are relative to: `ctx.baseDir`, else the project dir. */
export function baseDirOf(ctx: HookContext): string {
  return ctx.baseDir ?? ctx.project.dir;
}

/** A hook whose templates, files and security checks are resolved; nothing has run yet. */
export interface PreparedHook {
  /** Runtime description (templated, redacted, without the hook name). */
  description: string;
  /** What runs, field by field, templated (not redacted yet: the caller redacts): what an approval shows in full. */
  shown: ShownAction;
  /** Why the content that will run is destructive, or null (declared `destructive: true` is handled by the caller). */
  destructive: string | null;
  /**
   * Trust `mcp`: a text the hook loads and renders — an sql file, its rollback's, its database URL — uses a variable the
   * agent wrote (HookContext.agentVars): the hook then counts as the agent's, as one whose own templates do.
   */
  agentVars?: true;
  /** Why it writes (refused on a read-only run, L1.7), or null: its templated request / SQL, its rollback included. */
  writes: string | null;
  /**
   * The hosts it contacts (its URL, its database, the hosts its shell command names; a js hook: none — its tab
   * guards its requests): a hook that writes to a host of another, read-only environment is refused in every run.
   */
  hosts?: string[];
  /**
   * Its rollback (setup only), for an approval: templated description (redacted) and why it needs a human through MCP
   * (destructive, or a shell / js rollback — the caller only asks with trust `mcp`), else null.
   */
  rollback?: { description: string; reason: string | null; shown: ShownAction };
  execute(): Promise<ExecutedHook>;
}

export interface ExecutedHook {
  /** Short outcome for logs and results. */
  message: string;
  /** Setup phase only. */
  rollback?: RollbackAction;
  /** The hook ran but its rollback could not be prepared (e.g. a {{response.json.x}} that is missing). */
  rollbackError?: string;
}

/** Read a hook file relative to the project dir (or a sandbox's folder), with an error naming both paths. */
export async function readProjectFile(projectDir: string, rel: string, what: string): Promise<string> {
  const abs = resolve(projectDir, rel);
  try {
    return await readFile(abs, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new HookError(code === 'ENOENT' ? `${what} ${rel} not found (looked for ${abs})` : `cannot read ${what} ${rel}: ${(e as Error).message}`);
  }
}

/**
 * Read a file a hook runs (its SQL, its JS): readProjectFile, and with trust `mcp` (work submitted through MCP) only a
 * file of the project folder that an agent cannot write, without secret references (core agent-trust).
 */
export async function readHookFile(ctx: HookContext, baseDir: string, rel: string, what: string): Promise<string> {
  if (ctx.trust === 'mcp') {
    const problem = projectFileProblem(ctx.project.dir, rel, { baseDir, code: true, files: nodeFileFacts });
    if (problem) throw new HookSecurityError(`${what}: ${problem}`, 'mcp');
  }
  const text = ctx.trustedFiles ? await readTrustedFile(ctx, baseDir, rel, what) : await readProjectFile(baseDir, rel, what);
  if (ctx.trust === 'mcp') {
    const secrets = secretRefsProblem([...collectSecretRefs(text), ...collectSandboxRefs(text)], `${what} ${rel}`);
    if (secrets) throw new HookSecurityError(secrets, 'mcp');
  }
  return text;
}

/**
 * L7.39: a hook file read under a person's check (HookContext.trustedFiles): its bytes, read once, must be the ones
 * bound as code — other bytes, or a file that was not bound, are refused before any of it runs.
 */
async function readTrustedFile(ctx: HookContext, baseDir: string, rel: string, what: string): Promise<string> {
  const abs = resolve(baseDir, rel);
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new HookError(code === 'ENOENT' ? `${what} ${rel} not found (looked for ${abs})` : `cannot read ${what} ${rel}: ${(e as Error).message}`);
  }
  const key = relative(ctx.project.dir, abs).split(sep).join('/');
  const code = ctx.trustedFiles?.code ?? {};
  const bound = Object.hasOwn(code, key) ? code[key] : undefined;
  if (bound !== createHash('sha256').update(bytes).digest('hex')) {
    throw new HookSecurityError(
      `${what} ${rel} is not as you checked it before the run (${bound === undefined ? 'it was not among the files checked' : 'its bytes changed since'}) — run again to be asked about it`,
      'trust',
    );
  }
  return bytes.toString('utf8');
}

/** Logs that a rollback declared on a teardown/reset hook is ignored. */
export function ignoreRollback(k: KindEnv, declared: boolean): void {
  if (declared && !journalsRollback(k.phase)) {
    k.log('debug', `rollback of a ${k.phase} hook is ignored (only setup and step hooks are rolled back)`);
  }
}
