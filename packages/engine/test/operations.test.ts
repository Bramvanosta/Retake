/**
 * The engine's operations and `invoke` (L7.13, U7's first slice): one definition per operation, served by the shells
 * as these very objects — MCP's TOOLS entry is the engine's object, the Studio's table entry is that object or the
 * Studio's pinned arguments applied to it (pinArguments) — and one call for every shell (`invoke`): the shell must serve
 * the operation (before the parse, the engine never asked), the parse answers callTool's words, the operation's caller
 * rules run after the parse with the engine's caller and before the handler, and nothing it meets is thrown.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPERATIONS, OPERATIONS_BY_NAME, callTool, catalogueOperation, defineOperation, invoke, pinArguments, servedBy, servedNames, studioPins } from '@retake/engine/contract';
import type { ToolDef } from '@retake/engine/contract';
import { TOOLS } from '@retake/mcp';
import { stubTools } from '../../ui/test/studio-tools.js';
import { EngineError, callerOf, createEngine, toEngineError } from '../src/index.js';
import type { Engine } from '../src/index.js';

const signal = new AbortController().signal;
const ELEVEN = ['engine_info', 'project_list', 'project_get', 'project_update_readme', 'scenario_validate', 'run_list', 'run_status', 'run_cancel', 'job_list', 'auth_status', 'auth_login'];

describe("the engine's operations: one definition, served by the shells as it is", () => {
  it('names operations of the catalogue, each served by MCP or the Studio, in catalogue order: the eleven both serve', () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(names).toEqual(ELEVEN);
    for (const n of names) {
      const op = catalogueOperation(n);
      expect(op, n).toBeDefined();
      expect(servedBy(op!, 'mcp') || servedBy(op!, 'studio'), n).toBe(true);
    }
    // Catalogue order: the order of the shells' own lists.
    const order = [...servedNames('mcp'), ...servedNames('studio')];
    expect([...names].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(names);
    expect(Object.keys(OPERATIONS_BY_NAME)).toEqual(names);
    for (const o of OPERATIONS) expect(OPERATIONS_BY_NAME[o.name as keyof typeof OPERATIONS_BY_NAME]).toBe(o);
  });

  it("MCP's TOOLS entry of an engine operation is that very object, at its place in tools/list", () => {
    const byName = OPERATIONS_BY_NAME as unknown as Record<string, ToolDef>;
    const served = TOOLS.filter((t) => t.name in byName);
    expect(served.map((t) => t.name)).toEqual(OPERATIONS.filter((o) => servedBy(catalogueOperation(o.name)!, 'mcp')).map((o) => o.name));
    TOOLS.forEach((t, i) => {
      if (t.name in byName) expect(TOOLS[i], t.name).toBe(byName[t.name]);
    });
  });

  it("the Studio's table entry is the engine's object, or the Studio's pinned arguments applied to it", () => {
    const table = stubTools();
    for (const o of OPERATIONS) {
      if (!servedBy(catalogueOperation(o.name)!, 'studio')) continue;
      const entry = table.get(o.name)!;
      const pins = studioPins(o.name);
      if (!pins.length) {
        expect(entry, o.name).toBe(o);
        continue;
      }
      // pinArguments of it: the same handler, words and hints; its input the engine's with the pins.
      expect(entry, o.name).not.toBe(o);
      expect(entry.run, o.name).toBe(o.run);
      for (const k of ['name', 'title', 'description', 'annotations'] as const) expect(entry[k], `${o.name}.${k}`).toBe(o[k]);
      expect(z.toJSONSchema(entry.input, { io: 'input' }), o.name).toEqual(z.toJSONSchema(pinArguments(o as ToolDef<z.ZodObject>, pins).input, { io: 'input' }));
    }
    expect(OPERATIONS.filter((o) => studioPins(o.name).length).map((o) => o.name)).toEqual(['run_status', 'auth_login']);
  });
});

describe('invoke', () => {
  const engine = { caller: callerOf('mcp') } as unknown as Engine;
  let asked = 0;
  const getter = async () => {
    asked++;
    return engine;
  };

  it('refuses a shell that does not serve the operation, before the parse and without the engine', async () => {
    asked = 0;
    // engine_info has no CLI command (the catalogue's cli facet is a reason).
    const r = await invoke(OPERATIONS_BY_NAME.engine_info, getter, { not: 'parsed' }, { shell: 'cli', signal });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(EngineError);
    expect(r.error.code).toBe('not_found');
    expect(r.error.message).toBe('engine_info is not an operation the cli serves');
    expect(asked).toBe(0);
    // An operation the catalogue does not know at all.
    const probe = { name: 'no_such_op', title: 'x', description: 'x', input: z.strictObject({}), annotations: {}, run: async () => ({ summary: 'ran', data: {} }) };
    for (const shell of ['mcp', 'studio', 'cli'] as const) {
      const p = await invoke(probe, getter, {}, { shell, signal });
      expect(!p.ok && p.error.code).toBe('not_found');
    }
    expect(asked).toBe(0);
    // Served: it runs (job_list is served by all three shells).
    const served = await invoke({ ...OPERATIONS_BY_NAME.job_list, run: async () => ({ summary: 'ran', data: {} }) }, getter, {}, { shell: 'cli', signal });
    expect(served.ok).toBe(true);
  });

  it("answers callTool's words on arguments it refuses (code, message, details)", async () => {
    for (const [op, args] of [
      [OPERATIONS_BY_NAME.run_list, { project: '../x', limit: 0, extra: 1 }],
      [OPERATIONS_BY_NAME.engine_info, { verbose: true }],
      [OPERATIONS_BY_NAME.auth_login, { project: 'p', mode: 'fast' }],
      [OPERATIONS_BY_NAME.project_update_readme, {}],
    ] as Array<[ToolDef, unknown]>) {
      const a = await invoke(op, getter, args, { shell: 'mcp', signal });
      const b = await callTool(op, getter, args, { signal });
      expect(a.ok || b.ok, op.name).toBe(false);
      if (a.ok || b.ok) continue;
      expect({ code: a.error.code, message: a.error.message, details: a.error.details }, op.name).toEqual({ code: b.error.code, message: b.error.message, details: b.error.details });
      expect(a.error.message, op.name).toMatch(new RegExp(`^invalid arguments for ${op.name}:\n`));
    }
  });

  it("runs the operation's caller rules after the parse, with the engine's caller, and nothing after a refusal", async () => {
    const seen: string[] = [];
    const ruled = defineOperation({
      name: 'job_list',
      title: 'probe',
      description: 'probe',
      input: z.strictObject({ n: z.number().int().default(1) }),
      annotations: {},
      callers(c, args) {
        seen.push(`callers ${c.client} ${c.trust} ${args.n}`);
        return c.client === 'mcp' && args.n > 1 ? new EngineError('refused', 'not for an agent') : undefined;
      },
      async run(args) {
        seen.push(`run ${args.n}`);
        return { summary: 'ran', data: { n: args.n } };
      },
    });
    expect((await invoke(ruled, getter, { n: 'x' }, { shell: 'mcp', signal })).ok).toBe(false);
    expect(seen).toEqual([]);
    const refused = await invoke(ruled, getter, { n: 2 }, { shell: 'mcp', signal });
    expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual(['refused', 'not for an agent']);
    expect(seen).toEqual(['callers mcp mcp 2']);
    const ok = await invoke(ruled, getter, {}, { shell: 'mcp', signal });
    expect(ok.ok && ok.output.data).toEqual({ n: 1 });
    expect(seen).toEqual(['callers mcp mcp 2', 'callers mcp mcp 1', 'run 1']);
    // The engine's own caller decides, whoever the shell is: a person's engine passes the same call.
    const person = { caller: callerOf('cli') } as unknown as Engine;
    expect((await invoke(ruled, person, { n: 2 }, { shell: 'cli', signal })).ok).toBe(true);
  });

  it('hands the handler the engine, the signal, and progress and approver only when given', async () => {
    let ctxKeys: string[] = [];
    const probe = { ...OPERATIONS_BY_NAME.job_list, run: async (_a: unknown, ctx: object) => ((ctxKeys = Object.keys(ctx).sort()), { summary: 's', data: {} }) } as ToolDef;
    await invoke(probe, engine, {}, { shell: 'mcp', signal });
    expect(ctxKeys).toEqual(['engine', 'signal']);
    await invoke(probe, engine, {}, { shell: 'mcp', signal, progress: () => undefined, approver: { approve: async () => ({ approved: false }) as never } });
    expect(ctxKeys).toEqual(['approver', 'engine', 'progress', 'signal']);
  });

  it('never throws: a handler that throws anything, caller rules that throw, an engine getter that fails', async () => {
    const thrower = (f: () => never): ToolDef => ({ ...OPERATIONS_BY_NAME.job_list, run: async () => f() }) as ToolDef;
    const a = await invoke(thrower(() => { throw 'a string'; }), engine, {}, { shell: 'studio', signal });
    expect(!a.ok && [a.error.code, a.error.message]).toEqual(['internal', 'a string']);
    const b = await invoke(thrower(() => { throw new EngineError('conflict', 'changed'); }), engine, {}, { shell: 'studio', signal });
    expect(!b.ok && b.error.code).toBe('conflict');
    const c = await invoke({ ...OPERATIONS_BY_NAME.job_list, callers: () => { throw new Error('rule broke'); } } as ToolDef, engine, {}, { shell: 'studio', signal });
    expect(!c.ok && [c.error.code, c.error.message]).toEqual(['internal', 'rule broke']);
    const d = await invoke(OPERATIONS_BY_NAME.job_list, () => Promise.reject(new EngineError('unavailable', 'no engine')), {}, { shell: 'studio', signal });
    expect(!d.ok && d.error.code).toBe('unavailable');
    // Values String() cannot show (review fix): an object without a prototype, a throwing toString, an Error whose
    // message getter throws.
    const bare = Object.create(null) as never;
    const loud = { toString: () => { throw new Error('no text'); } } as never;
    const sly = Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('no message'); } }) as never;
    for (const [label, v] of [['no prototype', bare], ['throwing toString', loud], ['throwing message', sly]] as const) {
      const r = await invoke(thrower(() => { throw v; }), engine, {}, { shell: 'studio', signal });
      expect(!r.ok && r.error.code, label).toBe('internal');
      const c2 = await callTool(thrower(() => { throw v; }), async () => engine, {}, { signal });
      expect(!c2.ok && c2.error.code, label).toBe('internal');
    }
    expect(toEngineError(bare).message).toBe('a value that cannot be shown as text was thrown');
  });
});

describe('Engine.caller', () => {
  const root = mkdtempSync(join(tmpdir(), 'retake-engine-caller-'));
  writeFileSync(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is the caller of the client the engine was made for (read-only: the workspace's policy is opened from it)", async () => {
    for (const client of ['cli', 'mcp', 'ui', 'test'] as const) {
      const e = await createEngine({ root, client, autoStartWorker: false });
      expect(e.caller, client).toEqual(callerOf(client));
      // Read-only (review fix): the member cannot be written or redefined, the caller itself is frozen.
      const before = e.caller;
      expect(() => { (e as { caller: unknown }).caller = callerOf('cli'); }, client).toThrow(TypeError);
      expect(() => Object.defineProperty(e, 'caller', { value: callerOf('cli') }), client).toThrow(TypeError);
      expect(() => { (e.caller as { trust: string }).trust = 'author'; }, client).toThrow(TypeError);
      expect(e.caller, client).toBe(before);
      expect(e.caller, client).toEqual(callerOf(client));
      expect(Object.isFrozen(e.caller), client).toBe(true);
    }
  });
});
