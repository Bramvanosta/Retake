/**
 * The operation catalogue as data (@retake/engine/contract): each operation once, a kind, and for each shell either the
 * service or a one-line reason; the Studio's pins and statuses only where the Studio serves it; the counts pinned (a
 * new operation is a deliberate change of this file). The shells' own lists are held to it by their own tests:
 * packages/mcp/test/, packages/ui/test/ and packages/cli/test/operation-catalogue.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATALOGUE, OPERATION_KINDS, SHELLS, callTool, capUntrusted, catalogueOperation, cliCommandsOf, pinArguments, servedBy, servedNames, studioPins, studioStatus } from '@retake/engine/contract';
import type { NotServed, Operation, StudioServe, ToolDef } from '@retake/engine/contract';
import { ENGINE_ERROR_CODES, EngineError } from '../src/index.js';

const why = (v: unknown): string | undefined => (v && typeof v === 'object' && 'why' in v ? (v as NotServed).why : undefined);

describe('the operation catalogue', () => {
  it('names each operation once, with a name the Studio route accepts, and a known kind', () => {
    const names = CATALOGUE.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const o of CATALOGUE) {
      expect(o.name, o.name).toMatch(/^[a-z][a-z_]{0,63}$/);
      expect(OPERATION_KINDS, o.name).toContain(o.kind);
    }
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

  it('counts 122 operations: 45 MCP tools, 76 Studio ops, 54 served by 44 CLI commands; by kind 55 read, 37 write, 18 job, 8 runs code, 4 destructive', () => {
    expect(CATALOGUE).toHaveLength(122);
    expect(servedNames('mcp')).toHaveLength(45);
    expect(servedNames('studio')).toHaveLength(76);
    expect(servedNames('cli')).toHaveLength(54);
    expect(cliCommandsOf()).toHaveLength(44);
    const byKind = Object.fromEntries(OPERATION_KINDS.map((k) => [k, CATALOGUE.filter((o) => o.kind === k).length]));
    expect(byKind).toEqual({ read: 55, write: 37, job: 18, runs_code: 8, destructive: 4 });
    // Served by all three, by two, by one.
    const by = (n: number) => CATALOGUE.filter((o) => SHELLS.filter((s) => servedBy(o, s)).length === n).length;
    expect([by(3), by(2), by(1)]).toEqual([5, 43, 74]);
  });

  it('looks operations up by name; servedBy reads a reason as not served', () => {
    expect(catalogueOperation('run_capture')?.kind).toBe('job');
    expect(catalogueOperation('nope')).toBeUndefined();
    const op: Operation = { name: 'x', kind: 'read', cli: { why: 'none' }, mcp: { why: 'none' }, studio: {} };
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
