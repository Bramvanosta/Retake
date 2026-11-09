/**
 * The operation catalogue as data (@retake/engine/catalogue, re-exported by @retake/engine/contract): each operation
 * once, its facets (effect, job, code run, serving), and for each shell either the service or a one-line reason; the
 * Studio's pins and statuses only where the Studio serves it; the facets' hints (the table the shells' annotations are
 * held to); the counts pinned (a new operation is a deliberate change of this file). The shells' own lists are held to
 * it by their own tests: packages/mcp/test/, packages/ui/test/ and packages/cli/test/operation-catalogue.test.ts. The
 * catalogue's entry imports nothing at run time (a page may import it).
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
  callTool,
  capUntrusted,
  catalogueOperation,
  cliCommandsOf,
  facetProblem,
  hintsOf,
  pinArguments,
  servedBy,
  servedNames,
  studioPins,
  studioStatus,
} from '@retake/engine/contract';
import type { Facets, NotServed, Operation, StudioServe, ToolDef } from '@retake/engine/contract';
import { ENGINE_ERROR_CODES, EngineError } from '../src/index.js';

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
    expect(Object.keys(catalogueEntry).sort()).toEqual(['ADMISSION_RULES', 'CATALOGUE', 'CODE_RUNS', 'EFFECTS', 'SHELLS', 'annotationProblem', 'catalogueOperation', 'cliCommandsOf', 'facetProblem', 'hintsOf', 'servedBy', 'servedNames', 'studioPins', 'studioStatus']);
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

  it('counts 123 operations: 45 MCP tools, 76 Studio ops, 55 served by 45 CLI commands; 56 read, 57 write, 10 destructive; 20 jobs; 9 run project code, 8 workspace code; 3 serve', () => {
    expect(CATALOGUE).toHaveLength(123);
    expect(servedNames('mcp')).toHaveLength(45);
    expect(servedNames('studio')).toHaveLength(76);
    expect(servedNames('cli')).toHaveLength(55);
    expect(cliCommandsOf()).toHaveLength(45);
    const count = (f: (o: Operation) => boolean) => CATALOGUE.filter(f).length;
    expect(Object.fromEntries(EFFECTS.map((e) => [e, count((o) => o.effect === e)]))).toEqual({ read: 56, write: 57, destructive: 10 });
    expect(Object.fromEntries(CODE_RUNS.map((c) => [c, count((o) => o.code === c)]))).toEqual({ none: 106, project: 9, workspace: 8 });
    expect(CATALOGUE.filter((o) => o.job).map((o) => o.name)).toEqual([
      'page_inspect', 'scenario_record', 'run_dry', 'run_capture', 'render', 'review', 'export', 'template_preview', 'template_from_site', 'component_preview',
      'hooks_run', 'env_reset', 'auth_login', 'sandbox_up', 'sandbox_reset', 'scenario_run', 'scenario_render', 'review_export', 'library_render', 'record_start',
    ]);
    expect(CATALOGUE.filter((o) => o.code === 'project').map((o) => o.name)).toEqual(['run_dry', 'run_capture', 'hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset', 'scenario_run', 'hooks_rollback', 'sandbox_down']);
    expect(CATALOGUE.filter((o) => o.effect === 'destructive').map((o) => o.name)).toEqual([
      'project_prune', 'template_create_from_brand', 'hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset', 'record_discard', 'setup_cli_remove', 'hooks_rollback', 'sandbox_down',
    ]);
    expect(CATALOGUE.filter((o) => o.serves).map((o) => o.name)).toEqual(['mcp_serve', 'studio_serve', 'worker_run']);
    // Served by all three, by two, by one.
    const by = (n: number) => CATALOGUE.filter((o) => SHELLS.filter((s) => servedBy(o, s)).length === n).length;
    expect([by(3), by(2), by(1)]).toEqual([5, 43, 75]);
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
  const tool: ToolDef = {
    name: 'probe',
    title: 'Probe',
    description: 'A probe.',
    input: z.object({ project: z.string(), wait_s: z.number().int().min(0).max(25).default(5), mode: z.enum(['headed', 'auto']).default('auto') }).strict(),
    annotations: { readOnlyHint: true },
    run: async (args) => ({ summary: 'ok', data: { args, untrusted: { text: 'x'.repeat(2100) } } }),
  };
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

  it('callTool: arguments named per problem as an invalid EngineError; a handler error typed; never throws', async () => {
    const bad = await callTool(tool, engine, { wait_s: 99, extra: 1 }, { signal: new AbortController().signal });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBeInstanceOf(EngineError);
    expect(bad.error.code).toBe('invalid');
    expect(bad.error.message).toMatch(/^invalid arguments for probe:\n/);
    expect(bad.error.details?.arguments).toEqual(expect.arrayContaining(['project: Invalid input: expected string, received undefined', '(arguments): unknown argument extra']));
    const thrown = await callTool({ ...tool, run: async () => { throw new EngineError('conflict', 'changed'); } }, engine, { project: 'p' }, { signal: new AbortController().signal });
    expect(!thrown.ok && thrown.error.code).toBe('conflict');
    const ok = await callTool(tool, engine, { project: 'p' }, { signal: new AbortController().signal });
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
