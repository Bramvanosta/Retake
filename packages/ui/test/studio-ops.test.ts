/**
 * L6.12: the app's typed operation client. src/app/data/studio-ops.gen.ts (every op's arguments, generated from the
 * Studio's op table: studio-ops-gen.ts) is held byte for byte to its generator; StudioOps (data/ops.ts) names exactly the
 * ops the catalogue says the Studio serves; and the type checker refuses a call with an op the Studio does not serve,
 * arguments its input refuses or a result read as another type (a check file compiled with the app's options — the
 * test sources are not type-checked by the build — and its mutations).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CATALOGUE, servedBy, servedNames } from '@retake/engine/catalogue';
import { UI_OPS } from '../src/server/studio.js';
import { studioOpsSource, typeOf } from './studio-ops-gen.js';

const UI = fileURLToPath(new URL('..', import.meta.url));
const GEN = join(UI, 'src/app/data/studio-ops.gen.ts');
const OPS = join(UI, 'src/app/data/ops.ts');

/**
 * The check file: calls the type checker must accept, and one `@ts-expect-error` per mistake it must refuse — an op the
 * Studio does not serve, an unknown or missing argument, a wrong type or enum value, a pinned argument's other value,
 * a result read as another type — through `call` and through a data module's function and read.
 */
const CHECKS = `import { call } from '../api.js';
import type { OpArgs, OpResult } from '../api.js';
import { projectGet, runStatus, useThemeList } from './projects-and-more.js';

export async function good(slug: string): Promise<string> {
  const p = await call('project_get', { project: slug });
  const runs = await call('run_list', { project: slug, limit: 5 });
  const info = await call('engine_info');
  const v = await projectGet({ project: slug });
  const st = await runStatus({ project: slug, run_id: 'r' }, { signal: new AbortController().signal });
  const a: OpArgs<'scenario_run'> = { project: slug, name: 'n', mode: 'dry' };
  const r: OpResult<'theme_copy'> = { name: 'x' };
  return [p.slug, runs.runs.length, info.version, v.name, st.status, a.mode, r.name].join();
}

export function Reads({ slug }: { slug: string }): number {
  const [list] = useThemeList({ project: slug }, slug);
  return list.state === 'ready' ? list.data.themes.length : 0;
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
  // @ts-expect-error a data function's wrong argument
  await projectGet({ slug });
  // @ts-expect-error a data function's result read as another type
  const s: string = await runStatus({ project: slug, run_id: 'r' });
  // @ts-expect-error a read's arguments without its project
  useThemeList({}, slug);
  void n;
  void s;
}
`;
/** The check file's own data module (the real ones, re-exported: a function and a read of three features). */
const CHECKS_DATA = `export { projectGet } from './projects.js';\nexport { runStatus } from './shoot.js';\nexport { useThemeList } from './themes.js';\n`;

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
    checker = { options: { ...config.options, noEmit: true, composite: false, declaration: false, declarationMap: false, sourceMap: false, incremental: false, tsBuildInfoFile: undefined }, files: new Map() };
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
  it('data/studio-ops.gen.ts is its generator\'s text byte for byte: every op the Studio serves, with its arguments as /v1/call parses them', () => {
    const text = studioOpsSource();
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(GEN, text);
    expect(readFileSync(GEN, 'utf8')).toBe(text);
    // The generator's own cases: a strict empty input takes no key, optional keys, unions, records, arrays, literals.
    expect(typeOf({ type: 'object', properties: {}, additionalProperties: false })).toBe('Record<string, never>');
    expect(typeOf({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'], additionalProperties: false })).toBe('{\n  a: string;\n  b?: number;\n}');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] })).toBe('string | number | boolean');
    expect(typeOf({ type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } })).toBe('{ [key: string]: number }');
    expect(typeOf({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('readonly ("a" | "b")[]');
    expect(typeOf({ type: 'string', const: 'top' })).toBe('"top"');
    // A keyword it does not know fails loudly rather than widening a type.
    expect(() => typeOf({ type: 'object', patternProperties: {} })).toThrow(/patternProperties is not handled/);
    expect(() => typeOf({ type: 'tuple' })).toThrow(/type "tuple" is not handled/);
  });

  it('StudioOps names exactly the ops the Studio serves: each in the catalogue, its `studio` entry a serve (not a reason), in the allow-list (UI_OPS)', () => {
    const args = interfaceKeys(readFileSync(GEN, 'utf8'), 'StudioOpArgs');
    expect(args).toEqual([...UI_OPS]);
    expect(args).toEqual(servedNames('studio'));
    for (const op of args) {
      const entry = CATALOGUE.find((o) => o.name === op);
      expect(entry, op).toBeDefined();
      expect(servedBy(entry!, 'studio'), op).toBe(true);
    }
    // The results the app types (data/ops.ts): ops of StudioOps only.
    const results = interfaceKeys(readFileSync(OPS, 'utf8'), 'StudioOpResults');
    expect(results.length).toBeGreaterThan(40);
    expect(results.filter((op) => !args.includes(op))).toEqual([]);
    // Every catalogue operation the Studio does not serve is absent (the mutation: one of them named in the map).
    const notServed = CATALOGUE.filter((o) => !servedBy(o, 'studio')).map((o) => o.name);
    expect(notServed.length).toBeGreaterThan(5);
    expect(notServed.filter((op) => args.includes(op))).toEqual([]);
  });

  it('⚑ the type checker refuses a call of an op the Studio does not serve, wrong or missing arguments, a pinned argument\'s other value and a result read as another type (through call, a data function and a read); each mistake alone is an error', () => {
    // Every good call compiles and every mistake is refused (an unused @ts-expect-error would be an error too).
    expect(typeErrors(CHECKS)).toEqual([]);
    // Each mistake is an error on its own: without its directive, its line is reported.
    const lines = CHECKS.split('\n');
    const directives = lines.flatMap((l, i) => (l.includes('@ts-expect-error') ? [i] : []));
    expect(directives.length).toBe(12);
    for (const i of directives) {
      const errors = typeErrors(lines.filter((_, j) => j !== i).join('\n'));
      expect(errors.length, lines[i].trim()).toBeGreaterThan(0);
      expect(errors.every((e) => Number(e.split(':')[0]) === i + 1), `${lines[i].trim()}: ${errors.join(' | ')}`).toBe(true);
    }
    // The mutation: the untyped client of before L6.12 (any op name, any arguments, a result of the caller's choosing)
    // accepts every mistake — each directive is then unused.
    const untyped = CHECKS.replace("import { call } from '../api.js';\nimport type { OpArgs, OpResult } from '../api.js';", "import type { OpArgs, OpResult } from '../api.js';\ndeclare function call<T = any>(op: string, args?: Record<string, unknown>, o?: { signal?: AbortSignal }): Promise<T>;");
    expect(untyped).not.toBe(CHECKS);
    const unused = typeErrors(untyped).filter((e) => /Unused '@ts-expect-error' directive/.test(e));
    expect(unused.length).toBe(9);
  });
});
