/**
 * toEngineError, the one mapping of an error to what a client outside the CLI is told (code, message, details): a table
 * of every error class the packages raise on purpose, message cases included, so moving the mapping onto the classes
 * (each states its error kind) changed nothing. An error the tool did not raise on purpose is `internal`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessError, ClockError, ConfigError, DOCS_BASE_URL, ERROR_KINDS, EnvironmentError, HostRefusedError, RETAKE_REPOSITORY, RETAKE_VERSION, SandboxConfigError, ScenarioChangedError, ScenarioError, StepError as ScenarioStepError, TemplateError, WriteRefusedError, docsUrl, errorKindOf } from '@retake/core';
import { BundleError, H264EncoderError } from '@retake/core/io';
import type { ValidationIssue } from '@retake/core';
import { ComponentError } from '@retake/components';
import { ExportError, PlanError, PlanTrustError, RenderCancelledError, RenderDiskFullError, RenderError } from '@retake/editor';
import { HookError, HookSecurityError, JournalError } from '@retake/hooks';
import { ReviewCancelledError, ReviewError } from '@retake/review';
import { CancelledError, EncodeError, LoginPageError, PreflightError, RunnerError, StepError } from '@retake/runner-web';
import { SandboxError } from '@retake/sandbox';
import { ENGINE_ERROR_CODES, EngineError, HooksSourceError, RunOptionError, SandboxTakeError, toEngineError } from '../src/index.js';
import { scenarioChangedConflict } from '../src/errors.js';

const ISSUE: ValidationIssue = { severity: 'error', path: ['scenes', 0], message: 'm', line: 1, col: 1 } as ValidationIssue;
const PROJECT = { config: { name: 'shop', allow_hosts: ['staging.example.com'] } } as never;

/** [what, error, code, message (default: the error's own), details] */
const TABLE: [string, unknown, string, string?, Record<string, unknown>?][] = [
  ['ScenarioError, not found', new ScenarioError('scenario "x" not found in /p (available: none)'), 'not_found'],
  ['ScenarioError, does not exist', new ScenarioError('scenarios/x.yaml does not exist'), 'not_found'],
  ['ScenarioError, no such (any case)', new ScenarioError('No such scenario'), 'not_found'],
  ['ScenarioError, not found but issues', new ScenarioError('step not found: invalid', [ISSUE]), 'invalid', undefined, { issues: [ISSUE] }],
  ['ScenarioError, invalid', new ScenarioError('scenario x is invalid', [ISSUE]), 'invalid', undefined, { issues: [ISSUE] }],
  ['ScenarioError, invalid without issues', new ScenarioError('bad yaml'), 'invalid'],
  ['ScenarioChangedError', new ScenarioChangedError('/p/scenarios/q.yaml', 'a'.repeat(64), 'b'.repeat(64), 'scenarios/q.yaml'), 'conflict', `scenarios/q.yaml changed: its bytes have sha256 ${'b'.repeat(64)}, expected ${'a'.repeat(64)}: submit it again`],
  ['ConfigError, not found', new ConfigError('project "x" not found in /p/projects (available: none)'), 'not_found'],
  ['ConfigError, invalid', new ConfigError('project.yaml is invalid', [ISSUE]), 'invalid', undefined, { issues: [ISSUE] }],
  ['SandboxConfigError, invalid', new SandboxConfigError('sandbox.yaml is invalid', [ISSUE], '/p/sandbox.yaml', 'local'), 'invalid', undefined, { issues: [ISSUE] }],
  ['SandboxConfigError, not found', new SandboxConfigError('seed file not found', [], '/p/sandbox.yaml', 'local'), 'not_found'],
  ['EnvironmentError, not found', new EnvironmentError('environment "x" not found (available: staging)'), 'not_found'],
  ['EnvironmentError, invalid', new EnvironmentError('environment staging has no pages'), 'invalid'],
  ['TemplateError (a message with "not found" stays invalid)', new TemplateError('variable x not found'), 'invalid'],
  ['ClockError', new ClockError('clock: bad date'), 'invalid'],
  ['core StepError', new ScenarioStepError('unknown step', 3), 'invalid'],
  ['runner StepError', new StepError('target not found'), 'invalid'],
  ['RenderError', new RenderError('render failed: not found'), 'invalid'],
  ['RenderCancelledError', new RenderCancelledError(), 'cancelled'],
  ['RenderDiskFullError', new RenderDiskFullError('ENOSPC'), 'internal'],
  ['PlanError', new PlanError('no scene'), 'invalid'],
  ['PlanTrustError', new PlanTrustError(['music.mp3 lies outside']), 'refused'],
  ['ComponentError, exists', new ComponentError('component "x" already exists'), 'conflict'],
  ['ComponentError, exists with issues', new ComponentError('component "x" already exists', [{ severity: 'error', message: 'm' } as never]), 'conflict', undefined, { issues: [{ severity: 'error', message: 'm' }] }],
  ['ComponentError, not found', new ComponentError('component "x" not found'), 'not_found'],
  ['ComponentError, not found with issues', new ComponentError('import not found', [{ severity: 'error', message: 'm' } as never]), 'invalid', undefined, { issues: [{ severity: 'error', message: 'm' }] }],
  ['ComponentError, invalid', new ComponentError('bad manifest'), 'invalid'],
  ['AccessError', new AccessError('production is read-only'), 'refused'],
  ['HookSecurityError', new HookSecurityError('host refused', 'host'), 'refused'],
  ['WriteRefusedError', new WriteRefusedError(['POST /x'], 'staging'), 'refused'],
  ['HostRefusedError', new HostRefusedError(['evil.example'], PROJECT), 'refused'],
  ['runner CancelledError', new CancelledError(), 'cancelled'],
  ['ReviewCancelledError', new ReviewCancelledError(), 'cancelled'],
  ['ReviewError, not found', new ReviewError('render "x" not found'), 'not_found'],
  ['ReviewError, invalid', new ReviewError('bad record'), 'invalid'],
  ['ExportError, not found', new ExportError('no such render'), 'not_found'],
  ['ExportError, invalid', new ExportError('cannot read the render record'), 'invalid'],
  ['RunOptionError', new RunOptionError('--until x: not found'), 'invalid'],
  ['HookError', new HookError('hook failed'), 'invalid'],
  ['JournalError', new JournalError('journal unreadable', '/j.json'), 'invalid'],
  ['HooksSourceError, usage', new HooksSourceError('"x" is not a hooks source', true), 'invalid'],
  ['HooksSourceError, nothing to run', new HooksSourceError('no reset hooks', false), 'not_found'],
  ['SandboxError busy', new SandboxError('the sandbox is busy', 'busy'), 'busy'],
  ['SandboxError busy (code first)', new SandboxError('unknown sandbox', 'busy'), 'busy'],
  ['SandboxError down', new SandboxError('the sandbox is down', 'down'), 'unavailable'],
  ['SandboxError interrupted', new SandboxError('seed: interrupted', 'interrupted'), 'cancelled'],
  ['SandboxError unknown', new SandboxError('unknown sandbox "x"'), 'not_found'],
  ['SandboxError, "unknown" not first', new SandboxError('a step of unknown kind'), 'internal'],
  ['SandboxError has no sandbox', new SandboxError('environment local has no sandbox', 'failed'), 'not_found'],
  ['SandboxError not a sandbox', new SandboxError('x is not a sandbox', 'port'), 'not_found'],
  ['SandboxError port', new SandboxError('port 5544 is used', 'port'), 'internal'],
  ['SandboxError failed', new SandboxError('seed failed', 'seed'), 'internal'],
  ['SandboxTakeError busy', new SandboxTakeError('busy', false, 'busy'), 'busy'],
  ['SandboxTakeError down', new SandboxTakeError('down', false, 'down'), 'unavailable'],
  ['SandboxTakeError interrupted', new SandboxTakeError('stopped', true, 'interrupted'), 'cancelled'],
  ['SandboxTakeError unknown', new SandboxTakeError('unknown sandbox', false, 'failed'), 'not_found'],
  ['SandboxTakeError other', new SandboxTakeError('seed failed', false, 'seed'), 'unavailable'],
  ['SandboxTakeError without code', new SandboxTakeError('take failed', false), 'unavailable'],
  ['RunnerError', new RunnerError('browser crashed'), 'internal'],
  ['PreflightError', new PreflightError('session expired'), 'internal'],
  ['LoginPageError', new LoginPageError('landed on a sign-in page'), 'internal'],
  ['EncodeError', new EncodeError('ffmpeg failed'), 'internal'],
  ['BundleError', new BundleError('bundle.json: not found'), 'internal'],
  ['H264EncoderError', new H264EncoderError('no encoder'), 'internal'],
  ['a plain Error', new Error('boom: not found'), 'internal'],
  ['a plain Error with issues', Object.assign(new Error('x is invalid'), { issues: [ISSUE] }), 'internal'],
  ['a TypeError', new TypeError('x is not a function'), 'internal'],
  ['not an Error', 'just text', 'internal', 'just text'],
  ['an EngineError', new EngineError('busy', 'held', { fix: 'wait', details: { a: 1 } }), 'busy', 'held', { a: 1 }],
];

describe('toEngineError: the mapping, class by class', () => {
  it.each(TABLE)('%s', (_what, e, code, message, details) => {
    const got = toEngineError(e);
    expect(got).toBeInstanceOf(EngineError);
    expect(got.code).toBe(code);
    expect(got.message).toBe(message ?? (e as Error).message);
    expect(got.details).toEqual(details);
    if (e instanceof EngineError) expect(got).toBe(e);
    else expect(got.fix).toBeUndefined();
  });
});

describe('error kinds: stated by the classes', () => {
  it('each class of the table states the kind toEngineError gives (an EngineError: its code; a bug: none)', () => {
    for (const [what, e, code] of TABLE) {
      const plain = !(e instanceof Error) || ['a plain Error', 'a plain Error with issues', 'a TypeError'].includes(what);
      expect(errorKindOf(e), what).toBe(plain ? undefined : code);
    }
    expect(errorKindOf(Object.assign(new Error('x'), { errorKind: 'nonsense' }))).toBeUndefined();
    expect(ENGINE_ERROR_CODES).toBe(ERROR_KINDS);
  });

  it('the guide page a class names reaches the EngineError as its documentation URL, and exists', () => {
    const repo = resolve(__dirname, '../../..');
    let named = 0;
    for (const [what, e] of TABLE) {
      const docs = (e as { errorDocs?: string }).errorDocs;
      expect(toEngineError(e).docs, what).toBe(e instanceof EngineError || docs === undefined ? undefined : `${DOCS_BASE_URL}${docs}`);
      if (docs === undefined) continue;
      named++;
      expect(docs, what).toMatch(/^docs\/guide\/[a-z-]+\.md$/);
      expect(existsSync(resolve(repo, docs)), `${what}: ${docs}`).toBe(true);
    }
    expect(named).toBeGreaterThan(40);
    expect(toEngineError(new SandboxError('busy', 'busy')).docs).toBe(`${DOCS_BASE_URL}docs/guide/sandbox.md`);
    expect(toEngineError(new SandboxConfigError('x', [], '/s.yaml', 'local')).docs).toBe(`${DOCS_BASE_URL}docs/guide/sandbox.md`);
    expect(toEngineError(new RunnerError('x')).docs).toBeUndefined();
    expect(docsUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('the documentation URL is the repository of the root package.json at this version\'s release tag (one source of each)', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as { version: string; repository: { type: string; url: string } };
    expect(pkg.repository.type).toBe('git');
    const web = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    expect(web).toMatch(/^https:\/\/[^/]+\/[^/]+\/[^/]+$/);
    expect(RETAKE_REPOSITORY).toBe(web);
    expect(DOCS_BASE_URL).toBe(`${web}/blob/v${pkg.version}/`);
    expect(RETAKE_VERSION).toBe(pkg.version);
  });
});

describe('errors from another module copy', () => {
  it('an EngineError of another copy keeps its code, message, fix, details and docs', async () => {
    // A second instance of the module (the query makes it one): its class is not this one.
    // @ts-expect-error — the query makes a second module instance at run time; the compiler has no file of that name
    const other = (await import('../src/errors.js?another-copy')) as typeof import('../src/errors.js');
    expect(other.EngineError).not.toBe(EngineError);
    const e = new other.EngineError('needs_approval', 'approve it', { fix: 'retake hooks approve x', details: { hooks: ['a'] }, docs: `${DOCS_BASE_URL}docs/guide/security.md` });
    expect(e).not.toBeInstanceOf(EngineError);
    const got = toEngineError(e);
    expect(got).toBeInstanceOf(EngineError);
    expect({ code: got.code, message: got.message, fix: got.fix, details: got.details, docs: got.docs }).toEqual({ code: 'needs_approval', message: 'approve it', fix: 'retake hooks approve x', details: { hooks: ['a'] }, docs: `${DOCS_BASE_URL}docs/guide/security.md` });
    // Without options: none invented.
    const bare = toEngineError(new other.EngineError('busy', 'held'));
    expect({ fix: bare.fix, details: bare.details, docs: bare.docs }).toEqual({ fix: undefined, details: undefined, docs: undefined });
    // Another class's own `details` (a step error's) is not an EngineError's: not copied.
    expect(toEngineError(new StepError('target not found', { scene: 's' } as never)).details).toBeUndefined();
  });

  it('a changed scenario is a conflict with both hashes, read from its kind and fields (any module copy), not its name', async () => {
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    const mapped = scenarioChangedConflict(new ScenarioChangedError('/p/q.yaml', a, b), 'q changed') as EngineError;
    expect(mapped).toBeInstanceOf(EngineError);
    expect({ code: mapped.code, message: mapped.message, details: mapped.details }).toEqual({ code: 'conflict', message: 'q changed', details: { submitted: a, current: b } });
    // @ts-expect-error — the query makes a second module instance at run time; the compiler has no file of that name
    const core = (await import('../../core/src/scenario.js?another-copy')) as typeof import('../../core/src/scenario.js');
    expect(core.ScenarioChangedError).not.toBe(ScenarioChangedError);
    expect((scenarioChangedConflict(new core.ScenarioChangedError('/p/q.yaml', a, b), 'q changed') as EngineError).details).toEqual({ submitted: a, current: b });
    // Only the name: not a changed scenario. A conflict without the hashes, an EngineError: unchanged.
    const named = Object.assign(new Error('x'), { name: 'ScenarioChangedError', expected: a, actual: b });
    expect(scenarioChangedConflict(named, 'm')).toBe(named);
    const engine = new EngineError('conflict', 'if_match');
    expect(scenarioChangedConflict(engine, 'm')).toBe(engine);
    const other = new ComponentError('component "x" already exists');
    expect(scenarioChangedConflict(other, 'm')).toBe(other);
    // A conflict whose hashes are not both strings is not a changed scenario: unchanged, whatever else it carries.
    for (const [expected, actual] of [[1, 2], [a, undefined], [undefined, b], [a, { sha: b }], [null, null]] as const) {
      const odd = Object.assign(new Error('x'), { errorKind: 'conflict', expected, actual });
      expect(scenarioChangedConflict(odd, 'm'), JSON.stringify([expected, actual])).toBe(odd);
    }
    // Any error of kind `conflict` with both hashes reads as one (by kind and fields: the class name is not looked at).
    const kinded = Object.assign(new Error('x'), { errorKind: 'conflict', expected: a, actual: b });
    expect((scenarioChangedConflict(kinded, 'm') as EngineError).details).toEqual({ submitted: a, current: b });
  });
});
