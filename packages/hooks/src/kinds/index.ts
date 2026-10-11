import type { HookKind, HookStep, HttpHookSpec, JsHookSpec, ShellHookSpec, SqlHookSpec } from '@demo-studio/core';
import type { RollbackAction } from '../types.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';
import { prepareHttp, rollbackHttp } from './http.js';
import { prepareJs, rollbackJs } from './js.js';
import { prepareShell, rollbackShell } from './shell.js';
import { prepareSql, rollbackSql } from './sql.js';

export type { ExecutedHook, KindEnv, PreparedHook, RollbackEnv } from './common.js';

/** Template, read files, check the allow-list; nothing runs. */
export function prepareHook(hook: HookStep, kind: HookKind, k: KindEnv): Promise<PreparedHook> {
  switch (kind) {
    case 'http':
      return prepareHttp((hook as { http: HttpHookSpec }).http, k);
    case 'sql':
      return prepareSql((hook as { sql: string | SqlHookSpec }).sql, k);
    case 'shell':
      return prepareShell((hook as { shell: string | ShellHookSpec }).shell, k);
    case 'js':
      return prepareJs((hook as { js: string | JsHookSpec }).js, k);
  }
}

/** Run a journaled rollback action; resolves to a short outcome message. */
export function executeRollback(action: RollbackAction, r: RollbackEnv): Promise<string> {
  switch (action.kind) {
    case 'http':
      return rollbackHttp(action, r);
    case 'sql':
      return rollbackSql(action, r);
    case 'shell':
      return rollbackShell(action, r);
    case 'js':
      return rollbackJs(action, r);
  }
}
