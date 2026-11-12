/**
 * Authoring, recording, project writes and job_status (L7.18's family), characterized through their shells before they
 * became the engine's operations: MCP's scenario_save, scenario_from_script, scenario_record, project_create,
 * project_prune and job_status through `retake mcp` over stdio (from the sources, the SDK's client; three clients: one
 * that cannot be asked, one that declines, one that accepts), and the Studio's scenario_edit and its seven record_* ops
 * through its `POST /v1/call/<op>` — each shell on its own copy of one workspace: the fixture project (with a scenario
 * to edit) and three projects of prune's layouts (core/test/fixtures/records: a render to prune, an older capture to
 * prune, nothing to prune). The test process holds each workspace's worker lock, so a submit finds a live worker and
 * none is started (asserted: no worker.log): every recording stays queued and no window opens.
 *
 * In it: scenario_save new / without if_match / a stale if_match / the right one / errors / the agent rule; the script
 * table read (a draft, no table, issues, an unknown environment); project_create (made, a taken slug, the hosts check
 * against the fixture's production pages, a default_env outside the environments, an unknown theme, a bad slug);
 * project_prune's dry list, then dry_run: false answered by each client (needs_approval, declined, approved: deleted)
 * and the list after; scenario_record's refusals, a queued recording, a second one, job_status of each and of a
 * cancelled one; job_status of four recording jobs written by hand (a refused sign-in, nothing recorded, a saved draft
 * with its folder, a taken name whose folder is gone); scenario_edit's text, a stale hash, two edits of one hash at once
 * (one 409: the scenario chain), a restore with a wrong hash, a stale step guard, a field the entry does not take, the
 * agent rule; the Record screen's start form, a pinned start (400s), one window at a time (409), the view before the
 * folder and `since`, annotate / save before there is a draft, stop and discard, two starts at once (one 409: the
 * recordings' chain); and ops of the other shell. Then the order of the Record screen's refusals through `invoke` with
 * an MCP and a CLI engine on the Studio's ops (the caller rule before any load).
 *
 * Normalised: the workspace, repository and home paths, ISO stamps, job and recording ids by order of appearance (per
 * shell), the records' versions, the default draft name (a date), sizes, pids, the host name as a whole word, the Node
 * binary, the repository's address, Node's and Retake's versions, the display flag (a Linux machine without one).
 * Held against fixtures/authoring-ops.json, recorded on the commit before the move (RETAKE_WRITE_SNAPSHOTS=1 on this
 * file records it again: review the diff); the test also holds that the fixture names nothing of this machine.
 *
 * Not here: a recording that a window records (the worker is held off: stdio-record and ui record-ops play one with
 * Playwright, headless), record_save of a real draft (record-ops), the façade's own caller rules (engine record-studio).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RETAKE_REPOSITORY, RETAKE_VERSION } from '@retake/core';
import { FileJobQueue, WorkerLock, createEngine, newRecordId, selfIdentity, systemClock, workersDir } from '@retake/engine';
import type { EngineClient, JobRecord } from '@retake/engine';
import { invoke } from '@retake/engine/contract';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';
import { buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import { startStudioServer } from '../../ui/src/index.js';
import type { StudioServer } from '../../ui/src/index.js';
import { raw } from '../../ui/test/http.js';
import { stubTools } from '../../ui/test/studio-tools.js';

const FILE = fileURLToPath(new URL('./fixtures/authoring-ops.json', import.meta.url));
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const P = 'northfield-fixture';
const posix = process.platform !== 'win32';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const plain = (video: string, extra = '') => [`video: ${video}`, ...(extra ? [extra] : []), 'scenes:', '  - id: a', '    page: console', '    open: /', '    steps:', '      - hold: 1', ''].join('\n');
const EDIT_ME = plain('edit-me');
const EDITED = plain('edited', 'title: {text: Edited}');
/** A scenario file is agent-writable: its shell hook must be plain words (no redirection). */
const LOUD = `setup:\n  - name: loud\n    shell: "echo loud >> loud-marker.txt"\n${plain('loud')}`;
const NONE = `j_${'0'.repeat(26)}`;
const SCRIPT = [
  '| time | scene | action | caption |',
  '|---|---|---|---|',
  '| 0:00 | Catalogue | Open the catalogue | Every product in one place |',
  '| 0:05 | Quote | Request a quote | A quote in one click |',
  '| 0:12 | Quote | Send it | Sent |',
  '',
].join('\n');
const SCRIPT_ISSUES = ['| time | scene | action | caption |', '|---|---|---|---|', '| soon | Catalogue | Open it | One |', '| 0:05 | Quote | Ask | Two |', ''].join('\n');

type State = Record<string, string>;
type Answer = 'none' | 'decline' | 'accept';
interface Call {
  op: string;
  args: Record<string, unknown> | ((s: State) => Record<string, unknown>);
  keep?: Record<string, RegExp>;
  twice?: true;
  client?: Answer;
}
const JOB = /\b(j_[0-9A-HJKMNP-TV-Z]{26})\b/;
const REC = /\b(rec_[0-9A-HJKMNP-TV-Z]{26})\b/;
const HASH = /"hash":"([0-9a-f]{64})"/;
const VERSION = /"version":"([0-9a-f]{16})"/;

const MCP: Call[] = [
  // scenario_save
  { op: 'scenario_save', args: { project: P, name: 'fresh', yaml: plain('fresh'), if_match: null }, keep: { freshHash: HASH } },
  { op: 'scenario_save', args: { project: P, name: 'fresh', yaml: plain('fresh') } },
  { op: 'scenario_save', args: { project: P, name: 'fresh', yaml: plain('fresh'), if_match: 'a'.repeat(64) } },
  { op: 'scenario_save', args: (s) => ({ project: P, name: 'fresh', yaml: EDITED, if_match: s.freshHash! }) },
  { op: 'scenario_save', args: { project: P, name: 'broken', yaml: 'video: broken\nscenes:\n  - id: a\n    steps:\n      - nonsense: 1\n' } },
  { op: 'scenario_save', args: { project: P, name: 'loud', yaml: LOUD } },
  { op: 'scenario_save', args: { project: P, name: '../escape', yaml: plain('x') } },
  { op: 'scenario_save', args: { project: 'no-such-project', name: 'x', yaml: plain('x') } },
  // scenario_from_script
  { op: 'scenario_from_script', args: { project: P, script_markdown: SCRIPT, name: 'from-script' } },
  { op: 'scenario_from_script', args: { project: P, script_markdown: 'No table here, only words.\n' } },
  { op: 'scenario_from_script', args: { project: P, script_markdown: SCRIPT_ISSUES } },
  { op: 'scenario_from_script', args: { project: P, script_markdown: SCRIPT, env: 'nowhere' } },
  // project_create
  {
    op: 'project_create',
    args: {
      name: 'Made Here',
      environments: { staging: { app: 'https://app.staging.example.com', site: { url: 'https://www.staging.example.com', display: 'www.example.com' } } },
      default_env: 'staging',
    },
  },
  { op: 'project_create', args: { name: 'Made Here' } },
  { op: 'project_create', args: { name: 'Near Production', slug: 'near-production', environments: { local: { console: 'http://localhost:4401' } } } },
  { op: 'project_create', args: { name: 'Wrong Default', slug: 'wrong-default', environments: { staging: { app: 'https://app.staging.example.com' } }, default_env: 'elsewhere' } },
  { op: 'project_create', args: { name: 'No Theme', slug: 'no-theme', template: 'nowhere' } },
  { op: 'project_create', args: { name: 'Bad Slug', slug: '../up' } },
  { op: 'project_create', args: { name: 'Readme', slug: 'with-readme', readme: '# With a README\n\nWritten by the caller.\n' } },
  // project_prune: the dry list, then each client's answer to dry_run: false
  { op: 'project_prune', args: { project: 'p-c4' } },
  { op: 'project_prune', args: { project: 'p-c4', dry_run: false } },
  { op: 'project_prune', args: { project: 'p-c4', dry_run: false }, client: 'decline' },
  { op: 'project_prune', args: { project: 'p-c4', keep_renders: 1 } },
  { op: 'project_prune', args: { project: 'p-ctl', dry_run: false }, client: 'accept' },
  { op: 'project_prune', args: { project: 'p-ctl' } },
  { op: 'project_prune', args: { project: 'p-a1', dry_run: false }, client: 'accept' },
  { op: 'project_prune', args: { project: 'no-such-project' } },
  { op: 'project_prune', args: { project: 'p-c4', keep_renders: 0 } },
  // scenario_record (queued: the worker is held off)
  { op: 'scenario_record', args: { project: P, page: 'shop', allow_writes: true } },
  { op: 'scenario_record', args: { project: P, url: 'http://elsewhere.example/' } },
  { op: 'scenario_record', args: { project: P, page: 'shop', path: '/{{env:HOME}}' } },
  { op: 'scenario_record', args: { project: P, page: 'nowhere' } },
  { op: 'scenario_record', args: { project: P, page: 'shop', scenario: '../x' } },
  { op: 'scenario_record', args: { project: P, page: 'shop', path: '/record-lab', scenario: 'rec-one' }, keep: { recJob: JOB } },
  { op: 'scenario_record', args: { project: P, env: 'production', page: 'console', check: false }, keep: { recJob2: JOB } },
  // job_status of each kind of recording answer
  { op: 'job_status', args: (s) => ({ job_id: s.recJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.recJob2! }) },
  { op: 'job_cancel', args: (s) => ({ job_id: s.recJob2! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.recJob2! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.failedJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.nothingJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.savedJob! }) },
  { op: 'job_status', args: (s) => ({ job_id: s.takenJob!, detail: 'full' }) },
  { op: 'job_status', args: { job_id: NONE } },
  { op: 'job_status', args: { job_id: 'j_nope' } },
  // The Studio's ops are not MCP tools.
  { op: 'scenario_edit', args: { project: P, name: 'quote', hash: 'a'.repeat(64), edit: { kind: 'replace_text', text: plain('x') } } },
  { op: 'record_start', args: { project: P } },
  { op: 'record_view', args: { project: P, rec_id: newRecordId() } },
  { op: 'job_list', args: {} },
];

const STUDIO: Call[] = [
  // scenario_edit
  { op: 'scenario_edit', args: { project: P, name: 'edit-me', hash: sha(EDIT_ME), edit: { kind: 'replace_text', text: EDITED } }, keep: { edited: HASH } },
  { op: 'scenario_edit', args: { project: P, name: 'edit-me', hash: sha(EDIT_ME), edit: { kind: 'replace_text', text: plain('again') } } },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'restore', text: EDIT_ME, text_hash: 'b'.repeat(64) } }) },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'delete_step', at: { scene: 'a', index: 0, guard: '0'.repeat(16) } } }) },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'set_field', at: { entry: 'top' }, field: 'transition', to: 'fade' } }) },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'replace_text', text: 'video: x\nscenes: 3\n' } }) },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'replace_text', text: LOUD } }) },
  { op: 'scenario_edit', args: (s) => ({ project: P, name: 'edit-me', hash: s.edited!, edit: { kind: 'replace_text', text: plain('twice') } }), twice: true },
  { op: 'scenario_edit', args: { project: P, name: 'no-such-scenario', hash: 'a'.repeat(64), edit: { kind: 'replace_text', text: plain('x') } } },
  { op: 'scenario_edit', args: { project: P, name: 'edit-me', hash: 'a'.repeat(64), edit: { kind: 'replace_text', text: plain('x') }, author: 'claude' } },
  // the Record screen
  { op: 'record_options', args: { project: P } },
  { op: 'record_options', args: { project: 'no-such-project' } },
  { op: 'record_start', args: { project: P, page: 'shop', url: 'http://elsewhere.example/' } },
  { op: 'record_start', args: { project: P, page: 'shop', allow_writes: true } },
  { op: 'record_start', args: { project: P, page: 'shop', check: false } },
  { op: 'record_start', args: { project: P, page: 'shop', path: 'no-slash' } },
  { op: 'record_start', args: { project: P, page: 'nowhere' } },
  { op: 'record_start', args: { project: P, page: 'shop', path: '/record-lab', name: 'studio-rec' }, keep: { recId: REC, recJob: JOB } },
  { op: 'record_start', args: { project: P, page: 'console' } },
  { op: 'record_options', args: { project: P } },
  { op: 'record_view', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob! }), keep: { version: VERSION } },
  { op: 'record_view', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob!, since: s.version! }) },
  { op: 'record_view', args: (s) => ({ project: P, rec_id: s.recId! }) },
  { op: 'record_view', args: { project: P, rec_id: newRecordId() } },
  { op: 'record_annotate', args: (s) => ({ project: P, rec_id: s.recId!, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 } } }) },
  { op: 'record_save', args: (s) => ({ project: P, rec_id: s.recId!, name: 'saved-early', rev: 0, draft: 'a'.repeat(64) }) },
  { op: 'record_discard', args: { project: P, rec_id: newRecordId() } },
  { op: 'record_stop', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob! }) },
  { op: 'record_stop', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob! }) },
  { op: 'record_view', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob! }) },
  { op: 'record_discard', args: (s) => ({ project: P, rec_id: s.recId!, job: s.recJob! }) },
  { op: 'record_start', args: { project: P, page: 'shop', name: 'at-once' }, twice: true, keep: { recId2: REC, recJob2: JOB } },
  { op: 'record_discard', args: (s) => ({ project: P, rec_id: s.recId2!, job: s.recJob2! }) },
  { op: 'record_options', args: { project: P } },
  // MCP's tools are not Studio ops.
  { op: 'scenario_save', args: { project: P, name: 'x', yaml: plain('x') } },
  { op: 'scenario_record', args: { project: P } },
  { op: 'project_create', args: { name: 'X' } },
  { op: 'project_prune', args: { project: P } },
  { op: 'job_status', args: { job_id: NONE } },
];

/** The Record screen's ops and scenario_edit called through invoke on engines that are not the Studio's. */
const INVOKED: Array<{ client: EngineClient; op: string; args: Record<string, unknown> }> = [
  ...(['mcp', 'cli'] as const).flatMap((client) => [
    { client, op: 'record_options', args: { project: P } },
    { client, op: 'record_options', args: { project: 'no-such-project' } },
    { client, op: 'record_view', args: { project: P, rec_id: `rec_${'0'.repeat(26)}` } },
    { client, op: 'record_view', args: { project: 'no-such-project', rec_id: `rec_${'0'.repeat(26)}` } },
    { client, op: 'record_annotate', args: { project: 'no-such-project', rec_id: `rec_${'0'.repeat(26)}`, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } } },
    { client, op: 'record_stop', args: { project: 'no-such-project', rec_id: `rec_${'0'.repeat(26)}` } },
    { client, op: 'record_discard', args: { project: 'no-such-project', rec_id: `rec_${'0'.repeat(26)}` } },
    { client, op: 'record_save', args: { project: 'no-such-project', rec_id: `rec_${'0'.repeat(26)}`, name: 'x', rev: 0, draft: 'a'.repeat(64) } },
    // The parse first: an invalid argument is refused before the caller rule.
    { client, op: 'record_view', args: { project: P, rec_id: '../x' } },
  ]),
];

/** A finished recording job written by hand (claimed, then closed as a worker would). */
async function finishedRecording(
  ws: string,
  o: { rec_id: string; env?: string; persona?: string; state: 'succeeded' | 'failed'; result?: Record<string, unknown>; error?: { code: string; message: string; fix?: string } },
): Promise<string> {
  const q = new FileJobQueue(ws, 'retake', systemClock);
  const job = await q.enqueue({
    version: 1,
    kind: 'record',
    project: P,
    rec_id: o.rec_id,
    ...(o.env ? { env: o.env } : {}),
    ...(o.persona ? { persona: o.persona } : {}),
    source: { page: 'shop', path: '/' },
    check: true,
    submitted_by: 'mcp',
  });
  const me = await selfIdentity();
  expect(await q.claim(job.id, me)).toBe(true);
  const rec = (await q.get(job.id)) as JobRecord;
  const at = '2026-01-02T10:00:00.000Z';
  await q.write({
    ...rec,
    state: o.state,
    started_at: at,
    finished_at: at,
    worker: { ...me, host: hostname() },
    ...(o.result ? { result: o.result } : {}),
    ...(o.error ? { error: o.error } : {}),
  } as JobRecord);
  return job.id;
}

/** A recording's result as the worker writes it, with what the case changes. */
function recordResult(dir: string, rec: string, o: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'record',
    rec_id: rec,
    dir,
    draft: join(dir, 'draft.yaml'),
    name: 'recorded-by-hand',
    saved: null,
    env: 'local',
    persona: null,
    access: 'read-write',
    stop: 'closed',
    ms: 83_000,
    window: { width: 1400, height: 1000 },
    capture: { width: 1920, height: 1080 },
    counts: { events: 12, actions: 4, writes: 1, redacted: 1, dropped: {} },
    stats: { scenes: 1, steps: 4, actions: 4, noise: 0, secrets: 1, fallbacks: 0 },
    issues: { error: 0, warning: 1, info: 1, codes: ['secret_field', 'fallback_target'] },
    warnings: ['the window was resized while recording'],
    writes: { total: 1, by_steps: 1, ambient: 0 },
    check: { status: 'passed', scope: 'until_write', steps_passed: 2, steps_total: 4 },
    untrusted: {
      scenes: [{ id: 'record-lab', steps: 4, opens: true }],
      issues: [{ severity: 'warning', code: 'secret_field', message: 'a password field', scene: 'record-lab', step: 1 }],
      check: { until: 'record-lab.2' },
    },
    ...o,
  };
}

/** The workspace: the fixture project (a scenario to edit), three prune layouts, the worker lock held; for MCP, four finished recordings. */
async function workspace(name: string, recordings: boolean): Promise<{ ws: string; home: string; lock: WorkerLock; state: State }> {
  const ws = await mkdtemp(join(tmpdir(), `retake-authoring-ops-${name}-`));
  const home = join(ws, '.home');
  await fixtureWorkspace(ws);
  const project = join(ws, 'projects', P);
  await writeFile(join(project, 'scenarios', 'edit-me.yaml'), EDIT_ME);
  for (const id of ['C4', 'ctl', 'A1']) buildLayout(ws, id);
  const state: State = {};
  if (recordings) {
    const failed = newRecordId();
    state.failedJob = await finishedRecording(ws, {
      rec_id: failed,
      env: 'signed-in',
      persona: 'supplier',
      state: 'failed',
      error: { code: 'refused', message: 'persona supplier is not signed in (env signed-in): sign it in first', fix: `retake -C ${ws} login ${P} --env signed-in --persona supplier` },
    });
    const nothing = newRecordId();
    state.nothingJob = await finishedRecording(ws, {
      rec_id: nothing,
      state: 'succeeded',
      result: {
        ...recordResult(join(project, '.retake', 'records', nothing), nothing, {}),
        dir: null,
        draft: null,
        not_saved: 'nothing_recorded',
        counts: { events: 1, actions: 0, writes: 0, redacted: 0, dropped: {} },
        check: { status: 'skipped', scope: null, reason: 'nothing_recorded', steps_passed: 0, steps_total: 0 },
      },
    });
    const saved = newRecordId();
    const savedDir = join(project, '.retake', 'records', saved);
    await mkdir(savedDir, { recursive: true });
    await writeFile(join(savedDir, 'draft.yaml'), `${plain('recorded-by-hand')}# typed: two bags of the washed lot\n`);
    state.savedJob = await finishedRecording(ws, {
      rec_id: saved,
      state: 'succeeded',
      result: recordResult(savedDir, saved, { saved: { file: 'scenarios/recorded-by-hand.yaml', path: join(project, 'scenarios', 'recorded-by-hand.yaml'), hash: sha('saved') } }),
    });
    const taken = newRecordId();
    const takenDir = join(project, '.retake', 'records', taken);
    state.takenJob = await finishedRecording(ws, {
      rec_id: taken,
      state: 'succeeded',
      result: recordResult(takenDir, taken, {
        name: 'quote',
        not_saved: 'name_taken',
        access: 'read-only',
        stop: 'max_duration',
        check: { status: 'failed', scope: 'all', steps_passed: 1, steps_total: 4 },
        untrusted: { scenes: [], issues: [], check: { failed_at: { scene: 'record-lab', step: 1, action: 'click' }, error: 'no element "Send"' } },
      }),
    });
  }
  // This process holds the worker lock: a submit finds a live worker, so none is started and every job stays queued.
  const lock = await WorkerLock.acquire(ws, 'b1', systemClock);
  expect(lock).not.toBeNull();
  return { ws, home, lock: lock!, state };
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The answer with what changes between runs replaced: paths, stamps, ids by order (per shell), sizes, pids, versions. */
function normalise(v: unknown, o: { paths: Array<[string, string]>; ids: Map<string, string> }): unknown {
  const { ids } = o;
  const byOrder = (kind: string) => (id: string) => {
    if (!ids.has(id)) ids.set(id, `<${kind}-${[...ids.values()].filter((x) => x.startsWith(`<${kind}-`)).length + 1}>`);
    return ids.get(id)!;
  };
  const text = (s: string): string => {
    let t = s;
    for (const [from, to] of o.paths) t = t.split(from).join(to);
    t = t.split(process.execPath).join('<node-bin>').split(RETAKE_REPOSITORY).join('<repository>');
    t = t.replace(new RegExp(`(?<![\\w.-])${escaped(hostname())}(?![\\w-])`, 'g'), '<host>');
    t = t.split(`/blob/v${RETAKE_VERSION}/`).join('/blob/v<version>/').split(RETAKE_VERSION).join('<version>');
    t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<at>');
    t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('job'));
    t = t.replace(/\brec_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('rec'));
    t = t.replace(/\brecorded-\d{8}-\d{4}\b/g, 'recorded-<date>');
    t = t.replace(/\b\d+(?:\.\d+)? (?:B|kB|MB|GB)\b/g, '<size>');
    return t.replace(/\bpid \d+\b/g, 'pid <pid>');
  };
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === 'string' && ((key === 'host' && x === hostname()) || (key === 'node' && x === process.versions.node))) return `<${key}>`;
    // A recording's version (and record_view's `since`): a hash of its files, its stamps and ids included.
    if (typeof x === 'string' && (key === 'version' || key === 'since') && /^[0-9a-f]{16}$/.test(x)) return byOrder('version')(x);
    if (typeof x === 'string') return text(x);
    if (typeof x === 'number' && (key === 'pid' || key === 'ppid')) return '<pid>';
    if (typeof x === 'number' && key === 'bytes') return '<bytes>';
    if (typeof x === 'boolean' && key === 'display') return '<display>';
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [text(k), walk(y, k)]));
    return x;
  };
  return walk(v);
}

/** The paths of a workspace, longest first (its real path too: macOS /var → /private/var), with their placeholders. */
async function pathsOf(ws: string, home: string): Promise<Array<[string, string]>> {
  const pairs: Array<[string, string]> = [
    [home, '<home>'],
    [await realpath(home).catch(() => home), '<home>'],
    [ws, '<ws>'],
    [await realpath(ws), '<ws>'],
    [REPO.replace(/\/$/, ''), '<repo>'],
    [process.cwd(), '<cwd>'],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

type Answers = Array<{ op: string; args: unknown; answer: unknown; client?: Answer; asked?: unknown }>;

let mcpAnswers: Answers = [];
let studioAnswers: Answers = [];
let invokedAnswers: Answers = [];
const workerLogs: boolean[] = [];
const protocolErrors: Error[] = [];
const cleanup: Array<() => Promise<void>> = [];

function kept(c: Call, rawText: string, state: State): void {
  for (const [k, re] of Object.entries(c.keep ?? {})) {
    const m = re.exec(rawText);
    if (m && state[k] === undefined) state[k] = m[1]!;
  }
}

const byOutcome = <T>(pair: T[], failed: (a: T) => boolean): T[] => [...pair].sort((a, b) => Number(failed(a)) - Number(failed(b)));

async function viaMcp(): Promise<Answers> {
  const { ws, home, lock, state } = await workspace('mcp', true);
  cleanup.push(async () => {
    lock.release();
    await rm(ws, { recursive: true, force: true });
  });
  const clients = new Map<Answer, { client: Client; asked: Array<{ message: string; requestedSchema: unknown }> }>();
  const connect = async (answer: Answer) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=source', '--import', 'tsx', BIN, '--root', ws, 'mcp'],
      cwd: REPO,
      env: testChildEnv({ RETAKE_HOME: home, RETAKE_DISK_WARN: 'off' }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: answer === 'none' ? {} : { elicitation: { form: {} } } });
    const asked: Array<{ message: string; requestedSchema: unknown }> = [];
    if (answer !== 'none') {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const p = req.params as { message: string; requestedSchema: unknown };
        asked.push({ message: p.message, requestedSchema: p.requestedSchema });
        return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
      });
    }
    client.onerror = (e) => protocolErrors.push(e);
    await client.connect(transport);
    cleanup.unshift(() => client.close());
    return { client, asked };
  };
  const out: Answers = [];
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  type One = { isError: boolean; text?: string; data?: unknown } | { protocolError: string };
  for (const c of MCP) {
    const who = c.client ?? 'none';
    if (!clients.has(who)) clients.set(who, await connect(who));
    const { client, asked } = clients.get(who)!;
    const before = asked.length;
    const one = async (op: string, args: Record<string, unknown>): Promise<One> => {
      const called = await client.callTool({ name: op, arguments: args }, undefined, { timeout: 60_000 }).catch((e: unknown) => ({ protocolError: e instanceof Error ? e.message : String(e) }));
      if ('protocolError' in called) return { protocolError: String(called.protocolError) };
      const r = called as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
      return { isError: r.isError ?? false, text: r.content[0]?.text, data: r.structuredContent };
    };
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    const a = await one(c.op, args);
    kept(c, JSON.stringify(a), state);
    out.push({
      op: c.op,
      ...(c.client ? { client: c.client } : {}),
      args: normalise(args, n),
      answer: normalise(a, n),
      ...(asked.length > before ? { asked: normalise(asked.slice(before), n) } : {}),
    });
  }
  workerLogs.push(existsSync(join(workersDir(ws), 'worker.log')));
  return out;
}

async function viaStudio(): Promise<Answers> {
  const { ws, home, lock } = await workspace('studio', false);
  cleanup.push(async () => {
    lock.release();
    await rm(ws, { recursive: true, force: true });
  });
  const saved = process.env.RETAKE_HOME;
  process.env.RETAKE_HOME = home;
  cleanup.push(async () => {
    if (saved === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = saved;
  });
  const studio: StudioServer = await startStudioServer({ root: ws });
  cleanup.unshift(() => studio.close());
  const out: Answers = [];
  const state: State = {};
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  const one = async (op: string, args: Record<string, unknown>) => {
    const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
    return { status: r.status, ...(r.headers['retry-after'] !== undefined ? { retry_after: r.headers['retry-after'] } : {}), body: r.json() };
  };
  for (const c of STUDIO) {
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    if (c.twice) {
      const pair = byOutcome(await Promise.all([one(c.op, args), one(c.op, args)]), (a) => a.status !== 200);
      for (const a of pair) kept(c, JSON.stringify(a), state);
      out.push({ op: c.op, args: normalise(args, n), answer: normalise({ twice: pair }, n) });
      continue;
    }
    const a = await one(c.op, args);
    kept(c, JSON.stringify(a), state);
    out.push({ op: c.op, args: normalise(args, n), answer: normalise(a, n) });
  }
  workerLogs.push(existsSync(join(workersDir(ws), 'worker.log')));
  return out;
}

async function viaInvoke(): Promise<Answers> {
  const { ws, home, lock } = await workspace('invoke', false);
  const saved = process.env.RETAKE_HOME;
  process.env.RETAKE_HOME = home;
  cleanup.push(async () => {
    lock.release();
    await rm(ws, { recursive: true, force: true });
    if (saved === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = saved;
  });
  const tools = stubTools();
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  const engines = new Map<EngineClient, Awaited<ReturnType<typeof createEngine>>>();
  const out: Answers = [];
  for (const c of INVOKED) {
    if (!engines.has(c.client)) engines.set(c.client, await createEngine({ root: ws, client: c.client, autoStartWorker: false }));
    const r = await invoke(tools.get(c.op)!, engines.get(c.client)!, c.args, { shell: 'studio', signal: new AbortController().signal });
    const answer = r.ok
      ? { ok: true, data: r.output.data }
      : { ok: false, error: { code: r.error.code, message: r.error.message, ...(r.error.fix ? { fix: r.error.fix } : {}), ...(r.error.details ? { details: r.error.details } : {}) } };
    out.push({ op: `${c.client}: ${c.op}`, args: normalise(c.args, n), answer: normalise(answer, n) });
  }
  return out;
}

beforeAll(async () => {
  if (!posix) return;
  mcpAnswers = await viaMcp();
  studioAnswers = await viaStudio();
  invokedAnswers = await viaInvoke();
}, 300_000);

afterAll(async () => {
  for (const f of cleanup) await f().catch(() => undefined);
});

describe.skipIf(!posix)('authoring, recording, project writes and job_status through their shells (characterization)', () => {
  it('answer as fixtures/authoring-ops.json says, through MCP stdio, the Studio and invoke', () => {
    const text = `${JSON.stringify({ mcp: mcpAnswers, studio: studioAnswers, invoke: invokedAnswers }, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(mcpAnswers.map((a) => a.op)).toEqual(MCP.map((c) => c.op));
    expect(studioAnswers.map((a) => a.op)).toEqual(STUDIO.map((c) => c.op));
    expect(protocolErrors).toEqual([]);
    // No worker was started: every recording stayed queued, and no window opened.
    expect(workerLogs).toEqual([false, false]);
    const ok = (a: { answer: unknown }) => {
      const x = a.answer as { isError?: boolean; status?: number; twice?: Array<{ isError?: boolean; status?: number }> };
      return x.twice ? x.twice.some((y) => y.isError === false || y.status === 200) : x.isError === false || x.status === 200;
    };
    for (const op of ['scenario_save', 'scenario_from_script', 'scenario_record', 'project_create', 'project_prune', 'job_status'])
      expect(
        mcpAnswers.some((a) => a.op === op && ok(a)),
        op,
      ).toBe(true);
    for (const op of ['scenario_edit', 'record_options', 'record_start', 'record_view', 'record_stop', 'record_discard'])
      expect(
        studioAnswers.some((a) => a.op === op && ok(a)),
        op,
      ).toBe(true);
    // The approval was asked of the two clients that can answer, and only them.
    expect(mcpAnswers.filter((a) => a.asked).map((a) => a.client)).toEqual(['decline', 'accept']);
    // Two calls at once on one key: one answered, one 409 (the scenario chain; the recordings' chain).
    for (const a of studioAnswers.filter((x) => (x.answer as { twice?: unknown }).twice))
      expect(
        (a.answer as { twice: Array<{ status: number }> }).twice.map((y) => y.status),
        a.op,
      ).toEqual([200, 409]);
  });

  it('the fixture names nothing of this machine: no host name, account, home, temp folder or repository path', () => {
    const text = readFileSync(FILE, 'utf8');
    const words = [hostname(), userInfo().username, homedir(), tmpdir(), REPO.replace(/\/$/, ''), process.execPath, RETAKE_REPOSITORY, `"${process.versions.node}"`].filter((w) => w.length >= 3);
    for (const w of words) expect(text.includes(w), `the fixture holds ${JSON.stringify(w)}`).toBe(false);
    expect(text).not.toMatch(/\/(?:Users|home|private|var\/folders)\//);
  });
});
