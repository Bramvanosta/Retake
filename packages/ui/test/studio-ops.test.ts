/**
 * L6.12: the app's typed operation client. StudioOps (data/ops.ts) is derived from the Studio's op table (server
 * studio.ts StudioTools: each op's input and answer types, kept by the operation contract's ToolDef<S, D, N>) — L6.12–
 * L6.13 fixes: no generated file, no hand-written result but the NARROWED ones, each with its reason; it names exactly
 * the ops the catalogue says the Studio serves; and the type checker refuses a call with an op the Studio does not
 * serve, arguments its input refuses or a result read as another type (a check file compiled with the app's options —
 * the test sources are not type-checked by the build — and its mutations).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CATALOGUE, servedBy, servedNames } from '@retake/engine/catalogue';
import { UI_OPS } from '../src/server/studio.js';

const UI = fileURLToPath(new URL('..', import.meta.url));
const OPS = join(UI, 'src/app/data/ops.ts');

/** The ops whose arguments and result the app holds narrower than the op's own (data/ops.ts `Narrowed`): a ratchet. */
const NARROWED = ['run_status'];

/**
 * The check file: calls the type checker must accept, and one `@ts-expect-error` per mistake it must refuse — an op the
 * Studio does not serve, an unknown or missing argument, a wrong type or enum value, a pinned argument's other value,
 * a result read as another type — through `call` and through a data module's function and read.
 */
const CHECKS = `import { call } from '../api.js';
import type { OpArgs, OpResult } from '../api.js';
import { projectGet, runStatus, threadWrite, useEngineInfo, useThemeList } from './projects-and-more.js';

export async function good(slug: string): Promise<string> {
  const p = await call('project_get', { project: slug });
  const runs = await call('run_list', { project: slug, limit: 5 });
  const info = await call('engine_info');
  const v = await projectGet({ project: slug });
  const st = await runStatus({ project: slug, run_id: 'r' }, { signal: new AbortController().signal });
  const a: OpArgs<'scenario_run'> = { project: slug, name: 'n', mode: 'dry' };
  const r: OpResult<'theme_copy'>['name'] = 'x';
  const jobs = await call('job_list', { project: slug, state: ['queued', 'running'] as const });
  const reply = await threadWrite('thread_reply', { project: slug, comment_id: 'c', text: 'ok' });
  return [p.slug, runs.runs.length, info.version, v.name, st.status, st.duration_s, st.files.dir, a.mode, r, jobs.jobs.length, typeof reply].join();
}

export function Reads({ slug }: { slug: string }): number {
  const [list] = useThemeList({ project: slug }, slug);
  // A read of an op that takes no argument: with or without them (as a call).
  const [info] = useEngineInfo('info');
  const [same] = useEngineInfo({}, 'info');
  return list.state === 'ready' ? list.data.themes.length : info.state === 'ready' && same.state === 'ready' ? info.data.version.length : 0;
}

export async function bad(slug: string): Promise<void> {
  // @ts-expect-error an op the Studio does not serve (MCP only)
  await call('scenario_save', { project: slug, name: 'n', yaml: '' });
  // @ts-expect-error not an op at all
  await call('project_gte', { project: slug });
  // @ts-expect-error an argument its input does not have
  await call('project_get', { project: slug, path: '/etc' });
  // @ts-expect-error a required argument missing
  await call('project_get', {});
  // @ts-expect-error no arguments where some are required
  await call('project_get');
  // @ts-expect-error an argument of the wrong type
  await call('run_list', { project: slug, limit: '5' });
  // @ts-expect-error an enum value its input refuses
  await call('scenario_run', { project: slug, name: 'n', mode: 'live' });
  // @ts-expect-error a pinned argument's other value (the Studio's run_status never waits)
  await call('run_status', { project: slug, run_id: 'r', wait_s: 5 });
  // @ts-expect-error a result read as another type
  const n: number = await call('project_get', { project: slug });
  // @ts-expect-error an argument where the op takes none
  await call('engine_info', { verbose: true });
  // @ts-expect-error the Studio reads the compact run status only (NARROWED: never detail full)
  await call('run_status', { project: slug, run_id: 'r', detail: 'full' });
  const compact = await call('run_status', { project: slug, run_id: 'r' });
  // @ts-expect-error a field of the full run status, not in the compact answer the Studio gets
  void compact.outputs;
  // @ts-expect-error a thread reply without its text
  await threadWrite('thread_reply', { project: slug, comment_id: 'c' });
  // @ts-expect-error a data function's wrong argument
  await projectGet({ slug });
  // @ts-expect-error a data function's result read as another type
  const s: string = await runStatus({ project: slug, run_id: 'r' });
  // @ts-expect-error a read's arguments without its project
  useThemeList({}, slug);
  // @ts-expect-error a read without its arguments where the op needs some
  useThemeList(slug);
  void n;
  void s;
}
`;
/** The check file's own data module (the real ones, re-exported: a function and a read of three features). */
const CHECKS_DATA = `export { projectGet } from './projects.js';\nexport { runStatus } from './shoot.js';\nexport { useThemeList } from './themes.js';\nexport { threadWrite } from './comments.js';\nexport { useEngineInfo } from './projects.js';\n`;

/** A check file naming every op the Studio serves (an exact record of StudioOp) and none it does not serve. */
function namesCheck(served: readonly string[], notServed: readonly string[]): string {
  return [
    "import type { StudioOp } from './ops.js';",
    `export const all: { [K in StudioOp]: true } = { ${served.map((o) => `${o}: true`).join(', ')} };`,
    `export const none: [Extract<StudioOp, ${notServed.map((o) => `'${o}'`).join(' | ')}>] extends [never] ? true : false = true;`,
    '',
  ].join('\n');
}

/** The op names a source's `interface <name> { … }` declares (its top-level keys). */
function interfaceKeys(text: string, name: string): string[] {
  const src = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of src.statements) {
    if (!ts.isInterfaceDeclaration(st) || st.name.text !== name) continue;
    for (const m of st.members) if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.push(m.name.text);
  }
  return out;
}

/** The app's compiler options, a host whose parsed files are kept between checks, and the last program (reused). */
let checker: { options: ts.CompilerOptions; files: Map<string, ts.SourceFile>; last?: ts.Program } | undefined;

/** Type-checks `checks` (a module beside data/ops.ts) with the app's compiler options: its diagnostics, one line each. */
function typeErrors(checks: string, data = CHECKS_DATA): string[] {
  const file = join(UI, 'src/app/data/__typecheck__.ts');
  const extra = join(UI, 'src/app/data/projects-and-more.ts');
  if (!checker) {
    const config = ts.getParsedCommandLineOfConfigFile(join(UI, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
    checker = {
      options: { ...config.options, noEmit: true, composite: false, declaration: false, declarationMap: false, sourceMap: false, incremental: false, tsBuildInfoFile: undefined },
      files: new Map(),
    };
  }
  const { options, files } = checker;
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (f) => (f === file ? checks : f === extra ? data : read(f));
  const exists = host.fileExists.bind(host);
  host.fileExists = (f) => f === file || f === extra || exists(f);
  const get = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v, onError, fresh) => {
    if (f === file || f === extra) return ts.createSourceFile(f, f === file ? checks : data, v, true);
    let sf = files.get(f);
    if (!sf) {
      sf = get(f, v, onError, fresh);
      if (sf) files.set(f, sf);
    }
    return sf;
  };
  const program = ts.createProgram({ rootNames: [file, extra], options, host, ...(checker.last ? { oldProgram: checker.last } : {}) });
  checker.last = program;
  return [program.getSourceFile(file)!, program.getSourceFile(extra)!]
    .flatMap((sf) => [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)])
    .map((d) => `${d.file!.fileName === file ? '' : 'data: '}${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

describe('L6.12: the typed operation client', () => {
  it('StudioOps is derived from the op table, types only: data/ops.ts imports nothing at run time, holds no generated file and no hand-written result but the NARROWED ones (each with its reason)', () => {
    const text = readFileSync(OPS, 'utf8');
    const src = ts.createSourceFile(OPS, text, ts.ScriptTarget.Latest, true);
    const imports = src.statements.filter(ts.isImportDeclaration);
    expect(imports.length).toBeGreaterThan(1);
    expect(imports.every((i) => i.importClause?.isTypeOnly)).toBe(true);
    expect(imports.map((i) => (i.moduleSpecifier as ts.StringLiteral).text)).toContain('../../server/studio.js');
    expect(readdirSync(join(UI, 'src/app/data')).filter((f) => /gen/.test(f))).toEqual([]);
    // The ratchet: the narrowed ops are exactly NARROWED, each named with its reason in the list's comment.
    expect(interfaceKeys(text, 'Narrowed')).toEqual(NARROWED);
    for (const op of NARROWED) expect(text).toMatch(new RegExp(`^ \\* - ${op}: .{40,}`, 'm'));
    // No interface of results by op is declared by hand any more (the results are ToolData of each op).
    expect(interfaceKeys(text, 'StudioOpResults')).toEqual([]);
    expect(text).toMatch(/result: ToolData<StudioTools\[K\]>/);
  });

  it('StudioOps names exactly the ops the Studio serves: each in the catalogue, its `studio` entry a serve (not a reason), in the allow-list (UI_OPS)', () => {
    expect([...UI_OPS]).toEqual(servedNames('studio'));
    for (const op of UI_OPS) {
      const entry = CATALOGUE.find((o) => o.name === op);
      expect(entry, op).toBeDefined();
      expect(servedBy(entry!, 'studio'), op).toBe(true);
    }
    const notServed = CATALOGUE.filter((o) => !servedBy(o, 'studio')).map((o) => o.name);
    expect(notServed.length).toBeGreaterThan(5);
    // An exact record of StudioOp compiles with UI_OPS as its keys, and no op the Studio does not serve is in it.
    expect(typeErrors(namesCheck(UI_OPS, notServed))).toEqual([]);
    // The mutations: an op left out, an op not served added, an op not served in StudioOp.
    expect(typeErrors(namesCheck(UI_OPS.slice(1), notServed)).join()).toMatch(/engine_info/);
    expect(typeErrors(namesCheck([...UI_OPS, 'scenario_save'], notServed)).join()).toMatch(/scenario_save/);
    expect(typeErrors(namesCheck(UI_OPS, [...notServed, 'project_get'])).length).toBeGreaterThan(0);
  });

  it("⚑ the type checker refuses a call of an op the Studio does not serve, wrong or missing arguments, a pinned argument's other value and a result read as another type (through call, a data function and a read); each mistake alone is an error", () => {
    // Every good call compiles and every mistake is refused (an unused @ts-expect-error would be an error too).
    expect(typeErrors(CHECKS)).toEqual([]);
    // Each mistake is an error on its own: without its directive, its line is reported.
    const lines = CHECKS.split('\n');
    const directives = lines.flatMap((l, i) => (l.includes('@ts-expect-error') ? [i] : []));
    expect(directives.length).toBe(17);
    for (const i of directives) {
      const errors = typeErrors(lines.filter((_, j) => j !== i).join('\n'));
      expect(errors.length, lines[i].trim()).toBeGreaterThan(0);
      expect(
        errors.every((e) => Number(e.split(':')[0]) === i + 1),
        `${lines[i].trim()}: ${errors.join(' | ')}`,
      ).toBe(true);
    }
    // The mutation: the untyped client of before L6.12 (any op name, any arguments, a result of the caller's choosing)
    // accepts every mistake — each directive is then unused.
    const untyped = CHECKS.replace(
      "import { call } from '../api.js';\nimport type { OpArgs, OpResult } from '../api.js';",
      "import type { OpArgs, OpResult } from '../api.js';\ndeclare function call<T = any>(op: string, args?: Record<string, unknown>, o?: { signal?: AbortSignal }): Promise<T>;",
    );
    expect(untyped).not.toBe(CHECKS);
    const unused = typeErrors(untyped).filter((e) => /Unused '@ts-expect-error' directive/.test(e));
    expect(unused.length).toBe(12);
  });
});
