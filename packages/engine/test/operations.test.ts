/**
 * The engine's operations and `invoke` (L7.13, U7's first slice): one definition per operation, served by the shells
 * as these very objects — MCP's TOOLS entry is the engine's object, the Studio's table entry is that object or the
 * Studio's pinned arguments applied to it (pinArguments) — and one call for every shell (`invoke`): the shell must serve
 * the operation (before the parse, the engine never asked), the parse answers callTool's words, the operation's caller
 * rules run after the parse with the engine's caller and before the handler, and nothing it meets is thrown.
 * L7.17: the theme, component and library family joins them; an operation that declares `serialize` runs one call of a
 * key at a time per engine (after its caller rules), MCP's declare none, and theme_edit's caller rule refuses MCP.
 * L7.15: the submits and job controls join them; scenario_render runs on its scenario's key (the Studio's scenario chain).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPERATIONS, OPERATIONS_BY_NAME, callTool, catalogueOperation, defineOperation, invoke, operationChain, pinArguments, scenarioKey, servedBy, servedNames, studioPins } from '@retake/engine/contract';
import type { ToolDef } from '@retake/engine/contract';
import { TOOLS } from '@retake/mcp';
import { stubTools } from '../../ui/test/studio-tools.js';
import { EngineError, callerOf, createEngine, toEngineError } from '../src/index.js';
import type { Engine } from '../src/index.js';

const signal = new AbortController().signal;
const ELEVEN = ['engine_info', 'project_list', 'project_get', 'project_update_readme', 'scenario_validate', 'run_list', 'run_status', 'run_cancel', 'job_list', 'auth_status', 'auth_login'];
/** L7.14: the read-only queries of runs, renders, reviews and scenarios — MCP's (job_status waits: its answer is three tools' outputs still in MCP) and the Studio's. */
const QUERIES_MCP = ['scenario_get', 'plan_preview', 'render_status', 'review_get'];
const QUERIES_STUDIO = ['projects_overview', 'project_board', 'scenario_blocks', 'scenario_actions', 'run_thumbs', 'scenario_forms', 'scenario_sessions', 'scenario_renders', 'render_review', 'review_image'];
/** L7.17: the theme, component and library family (MCP's nine, the Studio's eleven). */
const THEMES_MCP = ['template_list', 'template_preview', 'template_from_site', 'template_create_from_brand', 'component_list', 'component_get', 'component_validate', 'component_preview', 'component_create'];
const THEMES_STUDIO = ['library_view', 'library_images', 'library_render', 'library_component', 'theme_list', 'theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list'];
/** L7.15: the submits and job controls (MCP's seven — job_status still waits for its recording answer — and the Studio's six). */
const JOBS_MCP = ['page_inspect', 'run_dry', 'run_capture', 'render', 'review', 'export', 'job_cancel'];
const JOBS_STUDIO = ['scenario_run', 'run_pause', 'sign_in_cancel', 'scenario_render', 'render_cancel', 'review_export'];

describe("the engine's operations: one definition, served by the shells as it is", () => {
  it('names operations of the catalogue, each served by MCP or the Studio, in catalogue order: the eleven both serve', () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(names.filter((n) => ELEVEN.includes(n))).toEqual(ELEVEN);
    expect([...names].sort()).toEqual([...ELEVEN, ...QUERIES_MCP, ...QUERIES_STUDIO, ...THEMES_MCP, ...THEMES_STUDIO, ...JOBS_MCP, ...JOBS_STUDIO].sort());
    for (const n of [...THEMES_MCP, ...JOBS_MCP]) expect([servedBy(catalogueOperation(n)!, 'mcp'), servedBy(catalogueOperation(n)!, 'studio')], n).toEqual([true, false]);
    for (const n of [...THEMES_STUDIO, ...JOBS_STUDIO]) expect([servedBy(catalogueOperation(n)!, 'mcp'), servedBy(catalogueOperation(n)!, 'studio')], n).toEqual([false, true]);
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

  it('names the read-only queries too (L7.14): MCP\'s four, then the Studio\'s ten, each a read served by one shell only', () => {
    const names = OPERATIONS.map((o) => o.name);
    // In catalogue order among the others (L7.17's theme family and L7.15's jobs left out: the test above holds them).
    const later = [...THEMES_MCP, ...THEMES_STUDIO, ...JOBS_MCP, ...JOBS_STUDIO];
    expect(names.filter((n) => !ELEVEN.includes(n) && !later.includes(n))).toEqual([...QUERIES_MCP, ...QUERIES_STUDIO]);
    for (const n of [...QUERIES_MCP, ...QUERIES_STUDIO]) {
      const op = catalogueOperation(n)!;
      expect(op.effect, n).toBe('read');
      expect(servedBy(op, 'mcp'), n).toBe(QUERIES_MCP.includes(n));
      expect(servedBy(op, 'studio'), n).toBe(QUERIES_STUDIO.includes(n));
      expect(OPERATIONS_BY_NAME[n as keyof typeof OPERATIONS_BY_NAME].annotations.readOnlyHint, n).toBe(true);
    }
    // job_status is still the MCP server's (its recording answer is scenario_record's, still defined there).
    expect(names).not.toContain('job_status');
    // The Studio's table holds its ten as these very objects (no pin), and MCP's TOOLS none of them.
    const table = stubTools();
    for (const n of QUERIES_STUDIO) expect(table.get(n), n).toBe(OPERATIONS_BY_NAME[n as keyof typeof OPERATIONS_BY_NAME]);
    for (const n of QUERIES_STUDIO) expect(TOOLS.some((t) => t.name === n), n).toBe(false);
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

describe('serialize: one call of a key at a time, per engine (L7.17)', () => {
  const engineA = { caller: callerOf('ui') } as unknown as Engine;
  const engineB = { caller: callerOf('ui') } as unknown as Engine;
  /** A probe on library_render's name (served by the Studio) whose run waits until released. */
  const gated = (log: string[], refuse?: (n: string) => boolean) => {
    const gates = new Map<string, () => void>();
    const op = defineOperation({
      name: 'library_render',
      title: 'probe',
      description: 'probe',
      input: z.strictObject({ key: z.string(), n: z.string() }),
      annotations: {},
      callers: (_c, a) => (refuse?.(a.n) ? new EngineError('refused', `no ${a.n}`) : undefined),
      serialize: (a) => a.key,
      async run(a) {
        log.push(`start ${a.n}`);
        await new Promise<void>((r) => gates.set(a.n, r));
        log.push(`end ${a.n}`);
        return { summary: a.n, data: {} };
      },
    });
    const release = async (n: string) => {
      for (let i = 0; i < 50 && !gates.has(n); i++) await new Promise((r) => setTimeout(r, 2));
      gates.get(n)!();
    };
    return { op, release };
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("MCP's operations declare none; the Studio's theme writes and library renders do, on their keys", () => {
    for (const o of OPERATIONS) if (servedBy(catalogueOperation(o.name)!, 'mcp')) expect(o.serialize, o.name).toBeUndefined();
    const keyed = OPERATIONS.filter((o) => o.serialize).map((o) => o.name);
    expect(keyed.sort()).toEqual(['library_render', 'scenario_render', 'theme_copy', 'theme_create', 'theme_edit']);
    const { theme_edit, theme_copy, theme_create, library_render, scenario_render } = OPERATIONS_BY_NAME;
    expect(theme_edit.serialize!({ theme: 'Mine', if_match: 'a'.repeat(64), edit: { kind: 'restore', text: '', text_hash: 'a'.repeat(64) } })).toBe('theme:mine');
    expect(theme_copy.serialize!({ from: 'editorial', name: 'mine' })).toBe('theme:mine');
    expect(theme_create.serialize!({ name: 'mine' } as never)).toBe('theme:mine');
    expect(library_render.serialize!({ project: 'p', items: [] } as never)).toBe('library:p');
    // L7.15: the Studio's scenario chain key (scenario_edit, thread_apply and record_save use it on the same chain).
    expect(scenario_render.serialize!({ project: 'p', name: 'quote', run: '20261017-120000-quote', expect_edit_sha256: 'a'.repeat(64) })).toBe('p\0quote');
    expect(scenario_render.serialize!({ project: 'p', name: 'quote', run: '20261017-120000-quote', expect_edit_sha256: 'a'.repeat(64) })).toBe(scenarioKey('p', 'quote'));
  });

  it('runs the calls of one key in order, one at a time; another key or another engine does not wait', async () => {
    const log: string[] = [];
    const { op, release } = gated(log);
    const call = (e: Engine, key: string, n: string) => invoke(op, e, { key, n }, { shell: 'studio', signal });
    const first = call(engineA, 'k', '1');
    const second = call(engineA, 'k', '2');
    const other = call(engineA, 'j', '3');
    const elsewhere = call(engineB, 'k', '4');
    await tick();
    expect(log.sort()).toEqual(['start 1', 'start 3', 'start 4']);
    await release('1');
    await tick();
    expect(log).toContain('start 2');
    for (const n of ['2', '3', '4']) await release(n);
    expect((await Promise.all([first, second, other, elsewhere])).map((r) => r.ok && r.output.summary)).toEqual(['1', '2', '3', '4']);
    expect(log.indexOf('end 1')).toBeLessThan(log.indexOf('start 2'));
    // The chain is the engine's (one per engine, the same object each time).
    expect(operationChain(engineA)).toBe(operationChain(engineA));
    expect(operationChain(engineA)).not.toBe(operationChain(engineB));
  });

  it("callTool (the deprecated alias) runs a serialize operation through the same chain: two theme_edit calls of a theme serialise", async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    // theme_edit as defined (its input and serialize), its handler a probe that waits until released.
    const edit = {
      ...OPERATIONS_BY_NAME.theme_edit,
      async run(a: { edit: { to?: unknown } }) {
        const n = String(a.edit.to);
        log.push(`start ${n}`);
        await new Promise<void>((r) => gates.set(n, r));
        log.push(`end ${n}`);
        return { summary: n, data: {} };
      },
    } as unknown as ToolDef;
    const args = (to: string, theme = 'mine') => ({ theme, if_match: 'a'.repeat(64), edit: { kind: 'set_field', field: 'colors.accent', to } });
    const release = async (n: string) => {
      for (let i = 0; i < 50 && !gates.has(n); i++) await new Promise((r) => setTimeout(r, 2));
      gates.get(n)!();
    };
    const get = async () => engineA;
    const first = callTool(edit, get, args('#111111'), { signal });
    const second = callTool(edit, get, args('#222222'), { signal });
    const other = callTool(edit, get, args('#333333', 'other'), { signal });
    await tick();
    expect(log.sort()).toEqual(['start #111111', 'start #333333']);
    // The alias and invoke share the engine's chain: an invoke of the key waits behind them too.
    const third = invoke(edit, engineA, args('#444444'), { shell: 'studio', signal });
    await release('#111111');
    await tick();
    expect(log).toContain('start #222222');
    expect(log).not.toContain('start #444444');
    for (const n of ['#222222', '#333333', '#444444']) await release(n);
    expect((await Promise.all([first, second, other, third])).map((r) => r.ok && r.output.summary)).toEqual(['#111111', '#222222', '#333333', '#444444']);
    expect(log.indexOf('end #111111')).toBeLessThan(log.indexOf('start #222222'));
    expect(log.indexOf('end #222222')).toBeLessThan(log.indexOf('start #444444'));
  });

  it('checks the caller rules before the chain: a refused call never waits for the key', async () => {
    const log: string[] = [];
    const { op, release } = gated(log, (n) => n === 'no');
    const engine = { caller: callerOf('ui') } as unknown as Engine;
    const held = invoke(op, engine, { key: 'k', n: '1' }, { shell: 'studio', signal });
    await tick();
    const refused = await invoke(op, engine, { key: 'k', n: 'no' }, { shell: 'studio', signal });
    expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual(['refused', 'no no']);
    expect(log).toEqual(['start 1']);
    await release('1');
    expect((await held).ok).toBe(true);
    // A failed call does not stop the next of its key.
    const failing = defineOperation({ name: 'library_render', title: 'x', description: 'x', input: z.strictObject({}), annotations: {}, serialize: () => 'k', run: async () => { throw new EngineError('conflict', 'changed'); } });
    expect((await invoke(failing, engine, {}, { shell: 'studio', signal })).ok).toBe(false);
    const after = invoke(op, engine, { key: 'k', n: '2' }, { shell: 'studio', signal });
    await release('2');
    expect((await after).ok).toBe(true);
  });
});

describe("theme_edit's caller rule (L7.17: editsThemes as the operation's callers)", () => {
  it('refuses the MCP client, after the parse and before the theme is read; every other caller passes', async () => {
    const op = OPERATIONS_BY_NAME.theme_edit;
    expect(op.callers!(callerOf('mcp'), {} as never)).toEqual(new EngineError('refused', 'themes are never edited through MCP: a person edits them in the Studio or by hand (template_create_from_brand makes new ones)'));
    for (const client of ['ui', 'cli', 'test'] as const) expect(op.callers!(callerOf(client), {} as never), client).toBeUndefined();
    // Through invoke on an engine that has no workspace: the parse first, then the refusal, nothing read.
    const engine = { caller: callerOf('mcp') } as unknown as Engine;
    const bad = await invoke(op, engine, { theme: '../x' }, { shell: 'studio', signal });
    expect(!bad.ok && bad.error.code).toBe('invalid');
    const valid = { theme: 'mine', if_match: 'a'.repeat(64), edit: { kind: 'set_field', field: 'colors.accent', to: '#123456' } };
    const refused = await invoke(op, engine, valid, { shell: 'studio', signal });
    expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual(['refused', 'themes are never edited through MCP: a person edits them in the Studio or by hand (template_create_from_brand makes new ones)']);
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
