import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HookError } from '../errors.js';
import type { HookContext, HookLogLevel, HookPhase, RollbackAction } from '../types.js';

export interface KindEnv {
  ctx: HookContext;
  phase: HookPhase;
  /** Redacting logger. */
  log: (level: HookLogLevel, msg: string) => void;
}

export type RollbackEnv = Pick<KindEnv, 'ctx' | 'log'>;

/** A hook whose templates, files and security checks are resolved; nothing has run yet. */
export interface PreparedHook {
  /** Runtime description (templated, redacted, without the hook name). */
  description: string;
  /** Why the content that will run is destructive, or null (declared `destructive: true` is handled by the caller). */
  destructive: string | null;
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

/** Read a hook file relative to the project dir, with an error naming both paths. */
export async function readProjectFile(projectDir: string, rel: string, what: string): Promise<string> {
  const abs = resolve(projectDir, rel);
  try {
    return await readFile(abs, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new HookError(
      code === 'ENOENT' ? `${what} ${rel} not found (looked for ${abs})` : `cannot read ${what} ${rel}: ${(e as Error).message}`,
    );
  }
}

/** Logs that a rollback declared on a teardown/reset hook is ignored. */
export function ignoreRollback(k: KindEnv, declared: boolean): void {
  if (declared && k.phase !== 'setup') {
    k.log('debug', `rollback of a ${k.phase} hook is ignored (only setup hooks are rolled back)`);
  }
}
