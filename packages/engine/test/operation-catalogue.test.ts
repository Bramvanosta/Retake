/**
 * The operation catalogue as data (@retake/engine/catalogue, re-exported by @retake/engine/contract): each operation
 * once, its facets (effect, job, code run, serving), and for each shell either the service or a one-line reason; the
 * Studio's pins and statuses only where the Studio serves it; the facets' hints (the table the shells' annotations are
 * held to); the counts pinned (a new operation is a deliberate change of this file). The shells' own lists are held to
 * it by their own tests: packages/mcp/test/, packages/ui/test/ and packages/cli/test/operation-catalogue.test.ts. The
 * catalogue's entry imports nothing at run time (a page may import it). The use cases served under more than one name
 * (S2, L7.20: linked, nothing renamed) are counted and named here, one name per shell, the Studio's narrowings marked.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as catalogueEntry from '@retake/engine/catalogue';
import {
  ADMISSION_RULES,
  CATALOGUE,
  CODE_RUNS,
  EFFECTS,
  SHELLS,
  annotationProblem,
  capUntrusted,
  catalogueOperation,
  cliCommandsOf,
  defineTool,
  facetProblem,
  hintsOf,
  invoke,
  pinArguments,
  servedBy,
  servedNames,
  studioPins,
  studioStatus,
  useCaseGroups,
  useCaseProblem,
} from '@retake/engine/contract';
import type { Facets, NotServed, Operation, StudioServe } from '@retake/engine/contract';
import { ENGINE_ERROR_CODES, EngineError, SUBMIT_RULES } from '../src/index.js';

const R0 = { effect: 'read', job: false, code: 'none' } as const;
const why = (v: unknown): string | undefined => (v && typeof v === 'object' && 'why' in v ? (v as NotServed).why : undefined);

describe('the operation catalogue', () => {
  it('names each operation once, with a name the Studio route accepts, and known facets that hold together', () => {
    const names = CATALOGUE.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const o of CATALOGUE) {
      expect(o.name, o.name).toMatch(/^[a-z][a-z_]{0,63}$/);
      expect(EFFECTS, o.name).toContain(o.effect);
      expect(typeof o.job, o.name).toBe('boolean');
      expect(CODE_RUNS, o.name).toContain(o.code);
      for (const r of o.admission ?? []) expect(ADMISSION_RULES, o.name).toContain(r);
      expect(facetProblem(o), o.name).toBeUndefined();
    }
  });

  it('facetProblem bites on each facet that contradicts another', () => {
    const op: Operation = { name: 'x', effect: 'read', job: false, code: 'none', cli: ['run'], mcp: true, studio: {} };
    expect(facetProblem(op)).toBeUndefined();
    expect(facetProblem({ ...op, job: true })).toMatch(/a read queues no job/);
    expect(facetProblem({ ...op, code: 'project' })).toMatch(/a read queues no job/);
    expect(facetProblem({ ...op, effect: 'write', job: true, mcp: { why: 'none' }, studio: { why: 'none' } })).toMatch(/a job is queued by MCP or the Studio/);
    expect(facetProblem({ ...op, effect: 'write', serves: true })).toMatch(/a serving command/);
    expect(facetProblem({ ...op, effect: 'write', serves: true, mcp: { why: 'none' }, studio: { why: 'none' } })).toBeUndefined();
    expect(facetProblem({ ...op, effect: 'destructive', serves: true, mcp: { why: 'none' }, studio: { why: 'none' } })).toMatch(/a serving command/);
    expect(facetProblem({ ...op, effect: 'write', admission: ['export_cap'] })).toMatch(/admission rules belong/);
    expect(facetProblem({ ...op, effect: 'write', job: true, admission: ['export_cap'] })).toBeUndefined();
    // A destructive operation says what it removes or replaces, and only it does.
    expect(facetProblem({ ...op, effect: 'destructive' })).toMatch(/says what it removes/);
    expect(facetProblem({ ...op, effect: 'destructive', removes: ' ' })).toMatch(/says what it removes/);
    expect(facetProblem({ ...op, effect: 'destructive', removes: 'the runs it prunes' })).toBeUndefined();
    expect(facetProblem({ ...op, effect: 'write', removes: 'the runs it prunes' })).toMatch(/and only it does/);
    // An operation held to admission rules adds a run, a render or an export: never destructive.
    expect(facetProblem({ ...op, effect: 'destructive', removes: 'x', job: true, code: 'project', admission: ['one_run_per_scenario'] })).toMatch(/never destructive/);
    expect(facetProblem({ ...op, effect: 'write', job: true, code: 'project', admission: ['one_run_per_scenario'] })).toBeUndefined();
  });

  it('destructive is narrow: what removes or replaces data as its purpose (or in one of its cases), without if_match, and says what', () => {
    const removes = Object.fromEntries(CATALOGUE.filter((o) => o.effect === 'destructive').map((o) => [o.name, o.removes]));
    for (const [name, what] of Object.entries(removes)) {
      expect(what, name).toBeTypeOf('string');
      expect(what!.length, name).toBeGreaterThan(10);
      expect(what, name).not.toMatch(/\n/);
    }
    // job_cancel discards a recording whose window is open; run_cancel stops a run (its teardown still runs).
    expect(catalogueOperation('job_cancel')?.effect).toBe('destructive');
    expect(catalogueOperation('run_cancel')?.effect).toBe('write');
    // A run, a render or an export adds; its hooks or sandbox reset are its `code`, not its effect.
    for (const name of ['run_dry', 'run_capture', 'scenario_run']) expect(catalogueOperation(name), name).toMatchObject({ effect: 'write', code: 'project' });
    // A replace bound to the version read (if_match) is a write.
    for (const name of ['scenario_save', 'project_update_readme', 'scenario_edit', 'theme_edit', 'thread_apply']) expect(catalogueOperation(name)?.effect, name).toBe('write');
    expect(CATALOGUE.filter((o) => o.removes !== undefined).map((o) => o.name)).toEqual(Object.keys(removes));
  });

  it('the facets decide two hints, as this table says: read-only exactly for a read, destructive exactly for destructive', () => {
    // Every combination of facets: job and code never change the hints (a dry run writes and may run hooks).
    const table: Array<[Facets['effect'], boolean, boolean]> = [
      ['read', true, false],
      ['write', false, false],
      ['destructive', false, true],
    ];
    for (const [effect, readOnlyHint, destructiveHint] of table) {
      for (const job of [false, true]) {
        for (const code of CODE_RUNS) {
          const f: Facets = { effect, job, code };
          expect(hintsOf(f), `${effect} ${job} ${code}`).toEqual({ readOnlyHint, destructiveHint });
          expect(annotationProblem(f, { readOnlyHint, destructiveHint })).toBeUndefined();
          expect(annotationProblem(f, { readOnlyHint: !readOnlyHint, destructiveHint })).toBeDefined();
          expect(annotationProblem(f, { readOnlyHint, destructiveHint: !destructiveHint })).toBeDefined();
        }
      }
    }
    // An absent hint is false.
    expect(annotationProblem({ effect: 'write' }, {})).toBeUndefined();
    expect(annotationProblem({ effect: 'read' }, {})).toMatch(/readOnlyHint/);
    expect(annotationProblem({ effect: 'destructive' }, { readOnlyHint: false })).toMatch(/destructiveHint/);
  });

  it("each operation's admission rules are the rules the engine's submit it goes through holds (SUBMIT_RULES)", () => {
    // The submit of each admitted operation (engine runs.submit, renders.submit, exports.submit), and its mode.
    const SUBMIT: Record<string, { submit: keyof typeof SUBMIT_RULES; dry?: boolean }> = {
      run_dry: { submit: 'run', dry: true },
      run_capture: { submit: 'run' },
      scenario_run: { submit: 'run' },
      render: { submit: 'render' },
      scenario_render: { submit: 'render' },
      export: { submit: 'export' },
      review_export: { submit: 'export' },
    };
    expect(CATALOGUE.filter((o) => o.admission).map((o) => o.name).sort()).toEqual(Object.keys(SUBMIT).sort());
    for (const o of CATALOGUE.filter((x) => x.admission)) {
      const { submit, dry } = SUBMIT[o.name]!;
      // A dry run meets every rule of the run submit but the capture's sessions acknowledgement.
      const want = (SUBMIT_RULES[submit] as readonly string[]).filter((r) => !(dry && r === 'sessions_ack'));
      expect(o.admission, o.name).toEqual(want);
    }
    // Every rule is held by some submit.
    expect([...new Set(Object.values(SUBMIT_RULES).flat())].sort()).toEqual([...ADMISSION_RULES].sort());
  });

  it('the operations that queue a run, a render or an export name the admission rules the engine holds them to', () => {
    const rules = Object.fromEntries(CATALOGUE.filter((o) => o.admission).map((o) => [o.name, o.admission]));
    expect(rules).toEqual({
      run_dry: ['one_run_per_scenario'],
      run_capture: ['one_run_per_scenario', 'sessions_ack'],
      render: ['one_render_per_scenario'],
      export: ['export_cap'],
      scenario_run: ['one_run_per_scenario', 'sessions_ack'],
      scenario_render: ['one_render_per_scenario'],
      review_export: ['export_cap'],
    });
  });

  it('the catalogue entry is browser-safe: it and what it imports import nothing at run time', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(src, file), 'utf8');
      for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+'([^']+)'/gm)) {
        if (m[2]) continue; // a type-only import is erased
        expect(m[3], `${file} imports ${m[3]} at run time`).toMatch(/^\.\//);
        visit(m[3]!.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
      }
      expect(text, file).not.toMatch(/\bimport\s*\(|\brequire\s*\(|^\s*import\s+'/m);
    };
    visit('catalogue.ts');
    expect([...seen]).toEqual(['catalogue.ts']);
    // The entry is the catalogue itself (functions and data, no class or engine).
    expect(Object.keys(catalogueEntry).sort()).toEqual(['ADMISSION_RULES', 'CATALOGUE', 'CODE_RUNS', 'EFFECTS', 'SHELLS', 'annotationProblem', 'catalogueOperation', 'cliCommandsOf', 'facetProblem', 'hintsOf', 'servedBy', 'servedNames', 'studioPins', 'studioStatus', 'useCaseGroups', 'useCaseProblem']);
  });

  it('gives every shell that does not serve an operation a one-line reason, and some shell serves each one', () => {
    for (const o of CATALOGUE) {
      expect(SHELLS.some((s) => servedBy(o, s)), o.name).toBe(true);
      for (const s of SHELLS) {
        if (servedBy(o, s)) continue;
        const reason = why(o[s]);
        expect(reason, `${o.name} ${s}`).toBeTypeOf('string');
        expect(reason!.trim().length, `${o.name} ${s}`).toBeGreaterThan(10);
        expect(reason, `${o.name} ${s}`).not.toMatch(/\n/);
        expect(reason!.length, `${o.name} ${s}`).toBeLessThanOrEqual(240);
      }
      // A served shell carries no reason: `mcp` is `true`, `cli` a list of paths, `studio` its service.
      if (servedBy(o, 'mcp')) expect(o.mcp).toBe(true);
      if (servedBy(o, 'cli')) expect((o.cli as readonly string[]).length, o.name).toBeGreaterThan(0);
    }
  });

  it('names CLI commands by their paths (a word, or a group and a word)', () => {
    for (const p of cliCommandsOf()) expect(p).toMatch(/^[a-z][a-z-]*( [a-z][a-z-]*)?$/);
  });

  it("pins arguments and maps statuses only where the Studio serves the operation, to valid values", () => {
    const codes = new Set<string>(ENGINE_ERROR_CODES);
    for (const o of CATALOGUE) {
      if (!servedBy(o, 'studio')) {
        expect(studioPins(o.name), o.name).toEqual([]);
        continue;
      }
      const s = o.studio as StudioServe;
      for (const p of s.pins ?? []) {
        expect(p.arg, o.name).toMatch(/^[a-z][a-z_]*$/);
        expect(['optional', 'default'], o.name).toContain(p.absent);
        expect(p.description.length, o.name).toBeGreaterThan(10);
      }
      for (const [code, status] of Object.entries(s.status ?? {})) {
        expect(codes.has(code), `${o.name} ${code}`).toBe(true);
        expect(status, `${o.name} ${code}`).toBeGreaterThanOrEqual(400);
        expect(status, `${o.name} ${code}`).toBeLessThan(600);
      }
    }
    expect(studioPins('run_status').map((p) => [p.arg, p.value, p.absent])).toEqual([['wait_s', 0, 'optional']]);
    expect(studioPins('auth_login').map((p) => [p.arg, p.value, p.absent])).toEqual([['mode', 'headed', 'default'], ['wait_s', 0, 'default']]);
    expect(studioStatus('render_frame', 'busy')).toBe(429);
    expect(studioStatus('render_frame', 'invalid')).toBeUndefined();
    expect(studioStatus('run_capture', 'busy')).toBeUndefined();
    expect(CATALOGUE.filter((o) => servedBy(o, 'studio') && ((o.studio as StudioServe).pins?.length || (o.studio as StudioServe).status)).map((o) => o.name)).toEqual(['run_status', 'auth_login', 'render_frame']);
  });

  it('counts 124 operations: 45 MCP tools, 76 Studio ops, 56 served by 46 CLI commands; 56 read, 57 write, 11 destructive; 20 jobs; 9 run project code, 8 workspace code; 3 serve', () => {
    expect(CATALOGUE).toHaveLength(124);
    expect(servedNames('mcp')).toHaveLength(45);
    expect(servedNames('studio')).toHaveLength(76);
    expect(servedNames('cli')).toHaveLength(56);
    expect(cliCommandsOf()).toHaveLength(46);
    const count = (f: (o: Operation) => boolean) => CATALOGUE.filter(f).length;
    expect(Object.fromEntries(EFFECTS.map((e) => [e, count((o) => o.effect === e)]))).toEqual({ read: 56, write: 57, destructive: 11 });
    expect(Object.fromEntries(CODE_RUNS.map((c) => [c, count((o) => o.code === c)]))).toEqual({ none: 107, project: 9, workspace: 8 });
    expect(CATALOGUE.filter((o) => o.job).map((o) => o.name)).toEqual([
      'page_inspect', 'scenario_record', 'run_dry', 'run_capture', 'render', 'review', 'export', 'template_preview', 'template_from_site', 'component_preview',
      'hooks_run', 'env_reset', 'auth_login', 'sandbox_up', 'sandbox_reset', 'scenario_run', 'scenario_render', 'review_export', 'library_render', 'record_start',
    ]);
    expect(CATALOGUE.filter((o) => o.code === 'project').map((o) => o.name)).toEqual(['run_dry', 'run_capture', 'hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset', 'scenario_run', 'hooks_rollback', 'sandbox_down']);
    expect(CATALOGUE.filter((o) => o.effect === 'destructive').map((o) => o.name)).toEqual([
      'project_prune', 'template_create_from_brand', 'job_cancel', 'hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset', 'record_discard', 'setup_cli_remove', 'hooks_rollback', 'sandbox_down',
    ]);
    expect(CATALOGUE.filter((o) => o.serves).map((o) => o.name)).toEqual(['mcp_serve', 'studio_serve', 'worker_run']);
    // Served by all three, by two, by one.
    const by = (n: number) => CATALOGUE.filter((o) => SHELLS.filter((s) => servedBy(o, s)).length === n).length;
    expect([by(3), by(2), by(1)]).toEqual([5, 43, 76]);
  });

  it('links 18 use cases served under two names (S2, L7.20: nothing renamed), one name per shell, and names each', () => {
    expect(useCaseProblem()).toBeUndefined();
    const groups = useCaseGroups();
    expect(groups).toEqual({
      'scenario.read': ['scenario_get', 'scenario_blocks'],
      'scenario.save': ['scenario_save', 'scenario_edit'],
      'scenario.run': ['run_capture', 'scenario_run'],
      'plan.view': ['plan_preview', 'timeline_view'],
      'render.queue': ['render', 'scenario_render'],
      'render.status': ['render_status', 'scenario_renders'],
      'review.read': ['review_get', 'render_review'],
      'export.queue': ['export', 'review_export'],
      'comments.list': ['comments_list', 'threads_list'],
      'comments.reply': ['comment_reply', 'thread_reply'],
      'comments.resolve': ['comment_resolve', 'thread_resolve'],
      'themes.list': ['template_list', 'theme_list'],
      'themes.create': ['template_create_from_brand', 'theme_create'],
      'themes.preview': ['template_preview', 'theme_preview'],
      'components.list': ['component_list', 'library_view'],
      'components.get': ['component_get', 'library_component'],
      'components.preview': ['component_preview', 'library_render'],
      'recording.start': ['scenario_record', 'record_start'],
    });
    // Every linked name is an operation of the catalogue, and each group is an MCP tool and a Studio op (one each).
    for (const [key, names] of Object.entries(groups)) {
      for (const n of names) expect(catalogueOperation(n), `${key} ${n}`).toBeDefined();
      expect(names.map((n) => [servedBy(catalogueOperation(n)!, 'mcp'), servedBy(catalogueOperation(n)!, 'studio')]), key).toEqual([[true, false], [false, true]]);
    }
    // Not linked on purpose: a shell's split of one use case by an argument (a use case holds one name per shell).
    for (const n of ['run_dry', 'job_cancel', 'render_cancel', 'sign_in_cancel', 'template_from_site', 'site_list', 'theme_view', 'review_image', 'library_images']) expect(catalogueOperation(n)?.useCase, n).toBeUndefined();
  });

  it('marks the three Studio narrowings of an MCP tool, each with why they stay apart (a later lot may merge them)', () => {
    const narrowings = CATALOGUE.filter((o) => o.narrows).map((o) => [o.name, o.narrows!.of]);
    expect(narrowings).toEqual([['thread_reply', 'comment_reply'], ['thread_resolve', 'comment_resolve'], ['theme_create', 'template_create_from_brand']]);
    for (const o of CATALOGUE.filter((x) => x.narrows)) {
      expect(catalogueOperation(o.narrows!.of)?.useCase, o.name).toBe(o.useCase);
      expect(o.narrows!.apart, o.name).toMatch(/^[^\n]{40,320}$/);
    }
    // The reasons name what differs: the answer, the chain, and for the theme the effect.
    expect(catalogueOperation('thread_reply')!.narrows!.apart).toMatch(/threadKey/);
    expect(catalogueOperation('thread_resolve')!.narrows!.apart).toMatch(/latest/);
    expect(catalogueOperation('theme_create')!.narrows!.apart).toMatch(/destructive/);
    expect([catalogueOperation('template_create_from_brand')!.effect, catalogueOperation('theme_create')!.effect]).toEqual(['destructive', 'write']);
  });

  it('useCaseProblem bites on each rule: a key, two names, one name per shell, a narrowing of its own use case', () => {
    const op = (name: string, more: Partial<Operation>): Operation => ({ name, ...R0, cli: { why: 'none' }, mcp: { why: 'none' }, studio: { why: 'none' }, ...more });
    const mcp = op('a_tool', { mcp: true, useCase: 'x.read', cli: ['x'] });
    const studio = op('a_op', { studio: {}, useCase: 'x.read', cli: ['x'] });
    expect(useCaseProblem([mcp, studio])).toBeUndefined();
    expect(useCaseProblem([{ ...mcp, useCase: 'X read' }, { ...studio, useCase: 'X read' }])).toMatch(/family\.verb/);
    expect(useCaseProblem([mcp])).toMatch(/one operation \(a_tool\) is no other name/);
    expect(useCaseProblem([mcp, { ...studio, mcp: true }])).toMatch(/mcp serves a_tool and a_op: one name per shell/);
    expect(useCaseProblem([{ ...mcp, studio: {} }, studio])).toMatch(/studio serves a_tool and a_op/);
    expect(useCaseProblem([mcp, { ...studio, cli: ['y'] }])).toMatch(/the CLI serves it under x and y/);
    expect(useCaseProblem([mcp, { ...studio, cli: { why: 'none' } }])).toBeUndefined();
    const apart = 'their answers differ, and the Studio chains its writes';
    expect(useCaseProblem([mcp, { ...studio, narrows: { of: 'a_tool', apart } }])).toBeUndefined();
    expect(useCaseProblem([mcp, { ...studio, narrows: { of: 'nope', apart } }])).toMatch(/does not hold/);
    expect(useCaseProblem([mcp, studio, op('c', { studio: {}, narrows: { of: 'a_tool', apart } })])).toMatch(/of its own use case/);
    expect(useCaseProblem([mcp, { ...studio, narrows: { of: 'a_op', apart } }])).toMatch(/of its own use case/);
    // A narrowing of an MCP tool of another use case.
    expect(useCaseProblem([mcp, studio, op('b_tool', { mcp: true, useCase: 'y.read' }), op('b_op', { studio: {}, useCase: 'y.read', narrows: { of: 'a_tool', apart } })])).toMatch(/b_op narrows a_tool: a narrowing names another operation of its own use case/);
    expect(useCaseProblem([{ ...mcp, narrows: { of: 'a_op', apart } }, studio])).toMatch(/a Studio op of an MCP operation/);
    expect(useCaseProblem([mcp, { ...studio, narrows: { of: 'a_tool', apart: 'short' } }])).toMatch(/why they stay apart/);
    expect(useCaseProblem([mcp, { ...studio, narrows: { of: 'a_tool', apart: `${apart}\nmore` } }])).toMatch(/why they stay apart/);
  });

  it('looks operations up by name; servedBy reads a reason as not served', () => {
    expect(catalogueOperation('run_capture')).toMatchObject({ effect: 'write', job: true, code: 'project' });
    expect(catalogueOperation('nope')).toBeUndefined();
    const op: Operation = { name: 'x', effect: 'read', job: false, code: 'none', cli: { why: 'none' }, mcp: { why: 'none' }, studio: {} };
    expect(SHELLS.map((s) => servedBy(op, s))).toEqual([false, false, true]);
    expect(servedBy({ ...op, studio: { why: 'none' } }, 'studio')).toBe(false);
    expect(servedBy({ ...op, cli: ['run'] }, 'cli')).toBe(true);
    expect(cliCommandsOf([{ ...op, cli: ['run'] }, { ...op, cli: ['run', 'still'] }])).toEqual(['run', 'still']);
  });
});

describe('the operation contract', () => {
  const tool = defineTool({
    name: 'probe',
    title: 'Probe',
    description: 'A probe.',
    input: z.object({ project: z.string(), wait_s: z.number().int().min(0).max(25).default(5), mode: z.enum(['headed', 'auto']).default('auto') }).strict(),
    annotations: { readOnlyHint: true },
    run: async (args) => ({ summary: 'ok', data: { args, untrusted: { text: 'x'.repeat(2100) } } }),
  });
  const engine = async () => ({}) as never;

  it('pinArguments: a pinned argument accepts its one value only, absent or (default) filled in; the others stay', () => {
    const t = pinArguments(tool, [
      { arg: 'wait_s', value: 0, absent: 'optional', description: 'Always 0 here.' },
      { arg: 'mode', value: 'headed', absent: 'default', description: 'Always headed here.' },
    ]);
    expect(t.input.parse({ project: 'p' })).toEqual({ project: 'p', mode: 'headed' });
    expect(t.input.parse({ project: 'p', wait_s: 0, mode: 'headed' })).toEqual({ project: 'p', wait_s: 0, mode: 'headed' });
    expect(t.input.safeParse({ project: 'p', wait_s: 25 }).success).toBe(false);
    expect(t.input.safeParse({ project: 'p', mode: 'auto' }).success).toBe(false);
    expect(t.input.safeParse({ wait_s: 0 }).success).toBe(false);
    expect(t.input.safeParse({ project: 'p', other: 1 }).success).toBe(false);
    expect(z.toJSONSchema(t.input, { io: 'input' }).properties).toMatchObject({ wait_s: { const: 0, description: 'Always 0 here.' }, mode: { const: 'headed', default: 'headed', description: 'Always headed here.' } });
    expect(tool.input.parse({ project: 'p' })).toEqual({ project: 'p', wait_s: 5, mode: 'auto' });
    expect(pinArguments(tool, []).input.parse({ project: 'p', wait_s: 25 })).toMatchObject({ wait_s: 25 });
  });

  it('invoke: arguments named per problem as an invalid EngineError; a handler error typed; never throws (L7.21: was callTool)', async () => {
    // The probe under a catalogue name the CLI serves (invoke refuses a name the catalogue does not hold).
    const probe = { ...tool, name: 'job_list' as const };
    const o = { shell: 'cli' as const, signal: new AbortController().signal };
    const bad = await invoke(probe, engine, { wait_s: 99, extra: 1 }, o);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBeInstanceOf(EngineError);
    expect(bad.error.code).toBe('invalid');
    expect(bad.error.message).toMatch(/^invalid arguments for job_list:\n/);
    expect(bad.error.details?.arguments).toEqual(expect.arrayContaining(['project: Invalid input: expected string, received undefined', '(arguments): unknown argument extra']));
    const thrown = await invoke({ ...probe, run: async () => { throw new EngineError('conflict', 'changed'); } }, engine, { project: 'p' }, o);
    expect(!thrown.ok && thrown.error.code).toBe('conflict');
    const ok = await invoke(probe, engine, { project: 'p' }, o);
    expect(ok.ok && ok.output.data.args).toEqual({ project: 'p', wait_s: 5, mode: 'auto' });
  });

  it('capUntrusted truncates strings under untrusted keys only, at any depth', () => {
    const long = 'y'.repeat(2100);
    const v = capUntrusted({ summary: long, untrusted: { a: [long], b: { c: long } }, list: [{ untrusted: long }] });
    expect(v.summary).toBe(long);
    expect(v.untrusted.a[0]).toBe(`${'y'.repeat(2000)}… (100 more characters)`);
    expect(v.untrusted.b.c).toHaveLength(2000 + '… (100 more characters)'.length);
    expect(v.list[0]!.untrusted).toMatch(/… \(100 more characters\)$/);
  });
});
