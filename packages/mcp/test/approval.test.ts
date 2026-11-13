/** The elicitation approver (L3.1, R-MCP-35): only `accept` with `approve: true` approves; everything else refuses. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSiteUrl, siteApprovalFingerprint, PERSON_POLICY } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { HookStep } from '@retake/core';
import { PRUNE_FORM_MAX_LINES, enginePorts, packageHookRunner, preflightHooks, pruneApprovalRequest, runnerWebCapture } from '@retake/engine';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalRequest, PruneItem, PruneResult, SiteApprovalRequest } from '@retake/engine';
import { APPROVAL_TIMEOUT_MS, approvalMessage, approvalTimeoutMs, elicitationApprover, pruneApprovalForm, pruneApprovalMessage, siteApprovalMessage } from '../src/index.js';
import type { ElicitAnswer } from '../src/server.js';

const REQ: ApprovalRequest = {
  what: 'hooks reset',
  project: 'p',
  env: { name: 'local', production: false, access: 'read-write' },
  items: [
    {
      fingerprint: 'f'.repeat(64),
      phase: 'reset',
      index: 0,
      name: 'wipe',
      kind: 'sql',
      description: 'wipe: sql "DELETE FROM quotes" on main',
      reason: 'SQL DELETE',
      lines: ['db: main (127.0.0.1:5432/app)', 'query: DELETE FROM quotes'],
    },
  ],
  fix: 'retake -C /ws hooks run p reset',
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
    expect(seen?.message).toContain('1. reset hook 1 "wipe" (sql) — SQL DELETE\n   db: main (127.0.0.1:5432/app)\n   query: DELETE FROM quotes\n');
    expect(seen?.message).toContain('environment local, read-write');
    expect(seen?.message).toContain('retake -C /ws hooks run p reset');
    expect(approvalTimeoutMs({ RETAKE_MCP_APPROVAL_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(approvalTimeoutMs({ RETAKE_MCP_APPROVAL_TIMEOUT_MS: 'x' })).toBe(APPROVAL_TIMEOUT_MS);
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
      const pre = await preflightHooks(project, [{ phase: 'setup', hooks }], {
        secrets: enginePorts().secrets,
        policy: PERSON_POLICY,
        env: 'staging',
        journalFile: join(dir, 'j.json'),
        hooks: packageHookRunner(),
        pages: runnerWebCapture().hookPages,
      });
      expect(pre.items.map((i) => i.reason)).toEqual(['a shell command (runs local code); its rollback: a shell command (runs local code)', 'its rollback: HTTP DELETE', 'its rollback: SQL DROP']);
      const msg = approvalMessage({ what: 'the capture', project: 'p', env: pre.env, items: pre.items, fix: 'retake run p x' });
      expect(msg).toContain(
        '1. setup hook 1 "seed" (shell) — a shell command (runs local code); its rollback: a shell command (runs local code)\n   run: echo seeded\n   rollback run: rm -rf "$HOME/important"\n',
      );
      expect(msg).toContain(
        '2. setup hook 2 "arm" (http) — its rollback: HTTP DELETE\n   method: POST\n   url: http://127.0.0.1:9/api/x\n   rollback method: DELETE\n   rollback url: http://127.0.0.1:9/api/all\n',
      );
      expect(msg).toContain(
        '3. setup hook 3 "q" (sql) — its rollback: SQL DROP\n   db: postgres://u@127.0.0.1:9/db\n   query: SELECT 1\n   rollback db: postgres://u@127.0.0.1:9/db\n   rollback query: DROP TABLE customers\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the form shows every hook in full', () => {
  it('each field on its own line, templated: shell run / cwd / env, http method / URL / headers / body, sql statement and database, js code and page, each rollback; secrets as ***; the name once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retake-mcp-full-'));
    const saved = process.env.RETAKE_TEST_FORM_TOKEN;
    process.env.RETAKE_TEST_FORM_TOKEN = 'form-secret-value';
    try {
      await writeFile(join(dir, 'project.yaml'), 'name: X\nvars: {sku: abc}\ndatabases: {main: {url: "postgres://u@127.0.0.1:9/app"}}\nenvironments:\n  staging:\n    app: http://127.0.0.1:9\n');
      await mkdir(join(dir, 'scripts'));
      const project = await loadProject(dir);
      const long = `echo ${'x'.repeat(300)} {{vars.sku}}`;
      const hooks: HookStep[] = [
        { name: 'seed', shell: { run: long, cwd: 'scripts', env: { TOKEN: '{{env:RETAKE_TEST_FORM_TOKEN}}', MODE: 'demo' }, rollback: 'echo undo {{vars.sku}}' } },
        { name: 'free', http: { method: 'DELETE', url: '{{app}}/api/x/{{vars.sku}}', headers: { authorization: 'Bearer {{env:RETAKE_TEST_FORM_TOKEN}}' }, json: { all: true } } },
        { name: 'wipe', sql: { query: "DELETE FROM quotes WHERE sku = '{{vars.sku}}'" } },
        { name: 'tick', js: { page: 'app', code: 'window.sku = "{{vars.sku}}"', rollback: 'delete window.sku' } },
      ];
      const pre = await preflightHooks(project, [{ phase: 'setup', hooks }], {
        secrets: enginePorts().secrets,
        policy: PERSON_POLICY,
        env: 'staging',
        journalFile: join(dir, 'j.json'),
        hooks: packageHookRunner(),
        pages: runnerWebCapture().hookPages,
      });
      const msg = approvalMessage({ what: 'the capture', project: 'p', env: pre.env, items: pre.items, fix: 'retake run p x' });
      expect(msg).toContain(
        [
          '1. setup hook 1 "seed" (shell) — a shell command (runs local code); its rollback: a shell command (runs local code)',
          `   run: echo ${'x'.repeat(300)} abc`,
          '   cwd: scripts',
          '   env TOKEN: ***',
          '   env MODE: demo',
          '   rollback run: echo undo abc',
          '   rollback cwd: scripts',
          '   rollback env TOKEN: ***',
          '   rollback env MODE: demo',
          '2. setup hook 2 "free" (http) — HTTP DELETE',
          '   method: DELETE',
          '   url: http://127.0.0.1:9/api/x/abc',
          '   header authorization: Bearer ***',
          '   json: {"all":true}',
          '3. setup hook 3 "wipe" (sql) — SQL DELETE',
          '   db: main (127.0.0.1:9/app)',
          "   query: DELETE FROM quotes WHERE sku = 'abc'",
          '4. setup hook 4 "tick" (js) — its rollback: JavaScript run in the page',
          '   page: app',
          '   code: window.sku = "abc"',
          '   rollback page: app',
          '   rollback code: delete window.sku',
          'Approve to run them now',
        ].join('\n'),
      );
      expect(msg).not.toContain('form-secret-value');
      expect(msg).not.toContain('…');
      expect(msg.match(/seed/g)).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.RETAKE_TEST_FORM_TOKEN;
      else process.env.RETAKE_TEST_FORM_TOKEN = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a name or a key of several lines stays on its line: the heading and the field names are written out too', () => {
    const item = {
      fingerprint: 'f'.repeat(64),
      phase: 'setup' as const,
      index: 0,
      name: 'seed\n   run: pnpm run seed',
      kind: 'shell',
      description: 'd',
      reason: 'a shell command (runs local code)',
      lines: ['run: echo ok'],
    };
    const msg = approvalMessage({ what: 'the capture', project: 'p', env: { name: 'local', production: false, access: 'read-write' }, items: [item], fix: 'retake run p x' });
    expect(msg).toContain('1. setup hook 1 "seed\\u{a}   run: pnpm run seed" (shell) — a shell command (runs local code)\n   run: echo ok\n');
    expect(msg).not.toMatch(/^ {3}run: pnpm run seed/m);
  });

  it('hidden characters are written out, and a value of several lines never reads as another hook or field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retake-mcp-hidden-'));
    try {
      await writeFile(join(dir, 'project.yaml'), 'name: X\nenvironments:\n  staging:\n    app: http://127.0.0.1:9\n');
      const project = await loadProject(dir);
      const hooks: HookStep[] = [{ name: 'a\u202eb', shell: { run: 'echo ok\u200b\u001b[2J\n2. setup hook 9 "fake" (http) — nothing\nrun: true' } }];
      const pre = await preflightHooks(project, [{ phase: 'setup', hooks }], {
        secrets: enginePorts().secrets,
        policy: PERSON_POLICY,
        env: 'staging',
        journalFile: join(dir, 'j.json'),
        hooks: packageHookRunner(),
        pages: runnerWebCapture().hookPages,
      });
      const msg = approvalMessage({ what: 'the capture', project: 'p', env: pre.env, items: pre.items, fix: 'retake run p x' });
      expect(msg).toContain(
        '1. setup hook 1 "a\\u{202e}b" (shell) — a shell command (runs local code)\n   run: echo ok\\u{200b}\\u{1b}[2J\n     | 2. setup hook 9 "fake" (http) — nothing\n     | run: true\n',
      );
      expect(msg).not.toMatch(/^2\. /m);
      expect(msg).not.toMatch(/^ {3}run: true$/m);
      expect(msg).not.toMatch(/[\u202e\u200b\u001b]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the site approval (L3.5)', () => {
  const parsed = parseSiteUrl('https://bücher.example.net/%20safe%20approve%20this', new Map());
  if (!parsed.ok) throw new Error(parsed.problem);
  const req: SiteApprovalRequest = { what: 'site extraction', ...parsed.url, fingerprint: siteApprovalFingerprint(parsed.url.href), fix: `retake -C /ws theme from-site ${parsed.url.href}` };

  it('shows the canonical href (percent-encoded, punycode) and the Unicode host on its own line, never the decoded path', () => {
    const msg = siteApprovalMessage(req);
    expect(msg).toMatch(/^URL: https:\/\/xn--bcher-kva\.example\.net\/%20safe%20approve%20this$/m);
    expect(msg).toMatch(/^Host: bücher\.example\.net \(written xn--bcher-kva\.example\.net\)$/m);
    expect(msg).not.toContain(' safe approve this');
    expect(msg).toContain('theme from-site https://xn--bcher-kva.example.net/');
  });

  it('only accept with approve: true approves a site; a client without elicitation cannot be asked', async () => {
    expect(elicitationApprover(undefined)).toBeUndefined();
    const outcome = (a: ElicitAnswer | Error) => elicitationApprover(answering(a), 1000)!.approveSite!(req);
    expect(await outcome({ action: 'accept', content: { approve: true } })).toEqual({ approved: true });
    expect(await outcome({ action: 'accept', content: { approve: false } })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'decline' })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'cancel' })).toEqual({ approved: false, reason: 'cancelled' });
    expect((await outcome(new Error('boom'))).approved).toBe(false);
  });
});

describe("the prune approval (an agent's project_prune {dry_run: false})", () => {
  const item = (kind: PruneItem['kind'], id: string, bytes: number, reason = 'failed take'): PruneItem => ({ kind, id, reason, bytes, paths: [] });
  const listed = (items: PruneItem[]): PruneResult => ({
    project: 'p',
    dry_run: true,
    keep_renders: 3,
    items,
    bytes: items.reduce((n, i) => n + i.bytes, 0),
    kept: { runs: 1, renders: 0, reviews: 0 },
    problems: [],
  });

  it('shows the count, the size, the size of each kind, each item and the terminal command', () => {
    const req = pruneApprovalRequest(
      listed([
        item('run', '20261020-100000-quote', 40_000_000),
        item('run', '20261020-110000-quote', 2_000_000, 'dry run'),
        item('render', 'quote-v1', 12_000_000, 'older render'),
        item('review', 'orphan\u202e1', 3000, 'review of a deleted render'),
      ]),
      'retake -C /ws prune p --yes',
    );
    const msg = pruneApprovalMessage(req);
    expect(msg).toContain("the agent asks to delete 4 items from project p's runs/, renders/ and review/, freeing 54 MB: 2 takes (42 MB), 1 render (12 MB), 1 review (3 kB).");
    expect(msg).toContain(
      '\n- take 20261020-100000-quote — failed take, 40 MB\n- take 20261020-110000-quote — dry run, 2 MB\n- render quote-v1 — older render, 12 MB\n- review orphan\\u{202e}1 — review of a deleted render, 3 kB\n',
    );
    expect(msg).not.toContain('\u202e');
    expect(msg).toContain('the last 3 renders of each scenario and variant');
    expect(msg).toContain('Decline to refuse: nothing is deleted.');
    expect(msg).toMatch(/Instead, you can run it yourself in a terminal: retake -C \/ws prune p --yes$/);
    expect(pruneApprovalForm(req).requestedSchema).toEqual({
      type: 'object',
      properties: { approve: { type: 'boolean', title: 'Delete these 4 items', description: expect.any(String), default: false } },
      required: ['approve'],
    });
  });

  it('a long list: the first 20 lines, then how many more, the totals covering all', () => {
    const many = Array.from({ length: 27 }, (_, i) => item('run', `20261020-1${String(i).padStart(5, '0')}-quote`, 1_000_000));
    const req = pruneApprovalRequest(listed(many), 'retake prune p --yes');
    const msg = pruneApprovalMessage(req);
    expect(msg.split('\n').filter((l) => l.startsWith('- take '))).toHaveLength(PRUNE_FORM_MAX_LINES);
    expect(msg).toContain('The first 20 of the 27 items:');
    expect(msg).toContain('… and 7 more, not listed here (counted in the totals above).');
    // Approving deletes them all: the form says so.
    expect(msg).toContain('Approve to delete all 27 items now — the 20 listed and the 7 more: only these, as they are now');
    expect(msg).toContain("delete 27 items from project p's runs/, renders/ and review/, freeing 27 MB: 27 takes (27 MB).");
    expect(msg).not.toContain('20261020-100020-quote');
  });

  it('only accept with approve: true approves a prune; a client without elicitation cannot be asked', async () => {
    const req = pruneApprovalRequest(listed([item('run', '20261020-100000-quote', 1000)]), 'retake prune p --yes');
    expect(elicitationApprover(undefined)).toBeUndefined();
    let seen: { message: string; timeoutMs: number } | undefined;
    await elicitationApprover(async (form, o) => ((seen = { message: form.message, timeoutMs: o.timeoutMs }), { action: 'decline' }))!.approvePrune!(req);
    expect(seen?.message).toBe(pruneApprovalMessage(req));
    expect(seen?.timeoutMs).toBe(APPROVAL_TIMEOUT_MS);
    const outcome = (a: ElicitAnswer | Error) => elicitationApprover(answering(a), 1000)!.approvePrune!(req);
    expect(await outcome({ action: 'accept', content: { approve: true } })).toEqual({ approved: true });
    expect(await outcome({ action: 'accept', content: { approve: false } })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'decline' })).toEqual({ approved: false, reason: 'declined' });
    expect(await outcome({ action: 'cancel' })).toEqual({ approved: false, reason: 'cancelled' });
    expect(await outcome(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))).toEqual({ approved: false, reason: 'timeout' });
  });
});
