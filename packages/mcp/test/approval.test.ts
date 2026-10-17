/** The elicitation approver (L3.1, R-MCP-35): only `accept` with `approve: true` approves; everything else refuses. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import type { HookStep } from '@demo-studio/core';
import { preflightHooks } from '@demo-studio/engine';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalRequest } from '@demo-studio/engine';
import { APPROVAL_TIMEOUT_MS, approvalMessage, approvalTimeoutMs, elicitationApprover } from '../src/index.js';
import type { ElicitAnswer } from '../src/server.js';

const REQ: ApprovalRequest = {
  what: 'hooks reset',
  project: 'p',
  env: { name: 'local', production: false, access: 'read-write' },
  items: [{ fingerprint: 'f'.repeat(64), phase: 'reset', index: 0, name: 'wipe', kind: 'sql', description: 'wipe: sql "DELETE FROM quotes" on main', reason: 'SQL DELETE' }],
  fix: 'studio -C /ws hooks run p reset',
};

const answering = (a: ElicitAnswer | Error) => async () => {
  if (a instanceof Error) throw a;
  return a;
};

describe('elicitationApprover', () => {
  it('maps the answers: accept + approve → approved; accept unchecked / decline → declined; cancel → cancelled', async () => {
    expect(elicitationApprover(undefined)).toBeUndefined();
    const outcome = (a: ElicitAnswer | Error) => elicitationApprover(answering(a), 1000)!.approve(REQ);
    expect(await outcome({ action: 'accept', content: { approve: true } })).toEqual({ approved: true });
    expect(await outcome({ action: 'accept', content: { approve: false } })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'accept' })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'decline' })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'cancel' })).toEqual({ approved: false, reason: 'cancelled' });
    expect(await outcome(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))).toEqual({ approved: false, reason: 'timeout' });
    expect(await outcome(new Error('Connection closed'))).toEqual({ approved: false, reason: 'error', message: 'Connection closed' });
  });

  it('asks with an explicit timeout (10 min unless overridden) and a form that names each hook and the terminal command', async () => {
    let seen: { message: string; timeoutMs: number } | undefined;
    await elicitationApprover(async (form, o) => ((seen = { message: form.message, timeoutMs: o.timeoutMs }), { action: 'decline' }))!.approve(REQ);
    expect(seen?.timeoutMs).toBe(APPROVAL_TIMEOUT_MS);
    expect(seen?.message).toContain('1. reset hook 1 "wipe": wipe: sql "DELETE FROM quotes" on main — SQL DELETE');
    expect(seen?.message).toContain('environment local, read-write');
    expect(seen?.message).toContain('studio -C /ws hooks run p reset');
    expect(approvalTimeoutMs({ DEMO_STUDIO_MCP_APPROVAL_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(approvalTimeoutMs({ DEMO_STUDIO_MCP_APPROVAL_TIMEOUT_MS: 'x' })).toBe(APPROVAL_TIMEOUT_MS);
  });

  it('the form shows each rollback an approval also approves (it runs later without asking): destructive, shell, js', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-mcp-rollbacks-'));
    try {
      await writeFile(join(dir, 'project.yaml'), 'name: X\nenvironments:\n  staging:\n    app: http://127.0.0.1:9\n');
      const project = await loadProject(dir);
      const hooks: HookStep[] = [
        { name: 'seed', shell: { run: 'echo seeded', rollback: 'rm -rf "$HOME/important"' } },
        { name: 'arm', http: { method: 'POST', url: '{{app}}/api/x', rollback: { method: 'DELETE', url: '{{app}}/api/all' } } },
        { name: 'q', sql: { query: 'SELECT 1', db: 'postgres://u@127.0.0.1:9/db', rollback: 'DROP TABLE customers' } },
        { name: 'plain', http: { method: 'POST', url: '{{app}}/api/y', rollback: { method: 'POST', url: '{{app}}/api/y/undo' } } },
      ];
      const pre = await preflightHooks(project, [{ phase: 'setup', hooks }], { env: 'staging', journalFile: join(dir, 'j.json') });
      expect(pre.items.map((i) => i.reason)).toEqual(['a shell command (runs local code); its rollback: a shell command (runs local code)', 'its rollback: HTTP DELETE', 'its rollback: SQL DROP']);
      const msg = approvalMessage({ what: 'the capture', project: 'p', env: pre.env, items: pre.items, fix: 'studio run p x' });
      expect(msg).toContain('1. setup hook 1 "seed": seed: shell "echo seeded"; rollback: shell "rm -rf "$HOME/important"" — a shell command');
      expect(msg).toContain('2. setup hook 2 "arm": arm: http POST http://127.0.0.1:9/api/x; rollback: http DELETE http://127.0.0.1:9/api/all — its rollback: HTTP DELETE');
      expect(msg).toContain('; rollback: sql "DROP TABLE customers" on postgres://u@127.0.0.1:9/db — its rollback: SQL DROP');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
