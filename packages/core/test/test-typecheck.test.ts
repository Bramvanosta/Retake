/**
 * The type check of the test files (tsconfig.test.json, `pnpm typecheck`, the CI's guards), kept from rotting. The
 * configuration is read the way the compiler reads it (its own parser: `extends` resolved, the file list globbed), not
 * as JSON held against a list of forbidden keys: it emits nothing and is no part of the build; the files it checks are
 * the test files on disk, all of them; its resolved options are a package's, with no check switched off here or in the
 * base configuration; its `paths` are vitest's aliases, one for one and each to the same file — a test that resolves
 * under vitest resolves the same way under the compiler; vitest runs no file the check does not read; and no test
 * file switches its own check off. vitest.config.ts is parsed, never imported: it makes temp folders when it loads.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
type Node = import('typescript').Node;
type Expression = import('typescript').Expression;

type TestConfig = {
  extends?: string;
  compilerOptions: Record<string, unknown> & { paths?: Record<string, string[]> };
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: { path: string }[];
};

function readConfig(file: string): TestConfig {
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(join(REPO, file), 'utf8'));
  if (parsed.error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`);
  return parsed.config as TestConfig;
}

/** A configuration as the compiler resolves it: options after `extends`, the files its patterns match on this disk. */
function resolved(file: string): import('typescript').ParsedCommandLine {
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d: import('typescript').Diagnostic) => {
      throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(join(REPO, file), {}, host);
  if (!parsed) throw new Error(`${file}: not read`);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  return parsed;
}

/** The options the test configuration sets itself — this list and no other key (an allow-list: a new one is a decision here). */
const OWN_OPTIONS = ['noEmit', 'composite', 'declaration', 'declarationMap', 'sourceMap', 'jsx', 'paths'];
/** What a package sets for its build output, and what the parser adds about the file it read: no part of the comparison. */
const NOT_COMPARED = [...OWN_OPTIONS, 'outDir', 'rootDir', 'tsBuildInfoFile', 'configFilePath', 'pathsBasePath'];
/** The checks `strict` turns on: none may be turned off one by one. */
const STRICT_FAMILY = ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'strictBuiltinIteratorReturn', 'useUnknownInCatchVariables', 'alwaysStrict'];
/** Options that make the compiler look at less: off everywhere. */
const LOOKS_AWAY = ['noCheck', 'noResolve', 'noLib', 'allowJs', 'checkJs'];

const rel = (file: string): string => relative(REPO, file).split('\\').join('/');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The repository-relative file a vitest alias points at, from the three forms the alias block uses. */
function vitestAliases(): Record<string, string> {
  const file = join(REPO, 'vitest.config.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  /** `fileURLToPath(new URL('<text>', import.meta.url))` → its text (a template's `${name}` kept as written). */
  const urlText = (e: Expression): string | null => {
    if (!ts.isCallExpression(e) || e.expression.getText(sf) !== 'fileURLToPath' || e.arguments.length !== 1) return null;
    const u = e.arguments[0]!;
    if (!ts.isNewExpression(u) || u.expression.getText(sf) !== 'URL' || u.arguments?.length !== 2 || u.arguments[1]!.getText(sf) !== 'import.meta.url') return null;
    const first = u.arguments[0]!;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    if (ts.isTemplateExpression(first)) return first.getText(sf).slice(1, -1);
    return null;
  };
  // The top-level constants the block uses: `pkg` (a function of the package's name) and plain paths such as `kit`.
  const consts = new Map<string, string>();
  let pkgTemplate: string | null = null;
  let alias: import('typescript').ObjectLiteralExpression | null = null;
  const visit = (n: Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (ts.isArrowFunction(n.initializer) && n.name.text === 'pkg' && n.initializer.parameters.length === 1 && !ts.isBlock(n.initializer.body)) {
        const t = urlText(n.initializer.body);
        const param = n.initializer.parameters[0]!.name.getText(sf);
        if (t !== null && t.includes(`\${${param}}`)) pkgTemplate = t.replace(`\${${param}}`, '<name>');
      } else {
        const t = urlText(n.initializer);
        if (t !== null) consts.set(n.name.text, t);
      }
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'alias' && ts.isObjectLiteralExpression(n.initializer)) alias = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!alias) throw new Error('vitest.config.ts: no resolve.alias object literal');
  const out: Record<string, string> = {};
  for (const p of (alias as import('typescript').ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name)) throw new Error(`vitest.config.ts: an alias that is not 'name': value — ${p.getText(sf)}`);
    const v = p.initializer;
    let target: string | null = null;
    if (ts.isCallExpression(v) && v.expression.getText(sf) === 'pkg' && v.arguments.length === 1 && ts.isStringLiteral(v.arguments[0]!) && pkgTemplate !== null) {
      target = (pkgTemplate as string).replace('<name>', (v.arguments[0] as import('typescript').StringLiteral).text);
    } else if (ts.isIdentifier(v) && consts.has(v.text)) target = consts.get(v.text)!;
    else target = urlText(v);
    if (target === null || target.includes('${')) throw new Error(`vitest.config.ts: alias ${p.name.text} has a form this test does not read — ${v.getText(sf)}`);
    if (p.name.text in out) throw new Error(`vitest.config.ts: alias ${p.name.text} twice`);
    out[p.name.text] = relative(REPO, resolve(REPO, target)).split('\\').join('/');
  }
  return out;
}

/** How many expected-error directives the test folders hold (2026-11-10). */
const EXPECT_ERRORS = 29;

describe('the type check of the test files (tsconfig.test.json)', () => {
  const config = readConfig('tsconfig.test.json');

  it('the test configuration emits nothing, is not referenced by the build, and matches every test folder on disk with no exclusion', () => {
    const own = resolved('tsconfig.test.json');
    expect(config.extends).toBe('./tsconfig.base.json');
    expect(own.options.noEmit).toBe(true);
    expect(own.options.composite).toBe(false);
    expect(own.options.declaration).toBe(false);
    // The build never sees it, and it reads the packages the build makes: the same references as the root's.
    const root = readConfig('tsconfig.json');
    expect(root.references!.map((r) => r.path)).not.toContain('tsconfig.test.json');
    expect(JSON.stringify(root)).not.toContain('tsconfig.test');
    expect(config.references).toEqual(root.references);
    expect((own.projectReferences ?? []).map((r) => rel(r.path))).toEqual(root.references!.map((r) => r.path));
    for (const r of root.references!) expect(JSON.stringify(readConfig(`${r.path}/tsconfig.json`)), r.path).not.toContain('tsconfig.test');
    // No exclusion, no file list: the patterns alone say what is checked, and nothing outside the test folders (the
    // sources are the build's). The base configuration carries options only — an `exclude` there would be inherited.
    expect(Object.keys(config).sort()).toEqual(['compilerOptions', 'extends', 'include', 'references']);
    expect(Object.keys(readConfig('tsconfig.base.json'))).toEqual(['compilerOptions']);
    expect(own.raw.exclude).toBeUndefined();
    expect(own.raw.files).toBeUndefined();
    expect(config.include!.length).toBeGreaterThan(0);
    for (const i of config.include!) expect(i).toMatch(/^packages\/\*\/test\//);
    // Every package on disk that has a test folder: the root's references, one for one. (A new package with no test
    // folder turns this red on purpose: it gets one, or this line says why not.)
    const packages = readdirSync(join(REPO, 'packages')).filter((p) => existsSync(join(REPO, 'packages', p, 'test')) && statSync(join(REPO, 'packages', p, 'test')).isDirectory());
    expect(packages.length).toBeGreaterThan(9);
    expect(packages.sort()).toEqual(root.references!.map((r) => r.path.replace(/^packages\//, '')).sort());
    // The files the compiler checks are the TypeScript files on disk under those folders: none missed (a dot folder
    // and node_modules are skipped by the compiler's `**`: a test file there would be run and not checked), none extra.
    const onDisk = packages.flatMap((p) => {
      const files = filesUnder(join(REPO, 'packages', p, 'test')).map(rel).filter((f) => /\.(?:ts|mts|cts|tsx)$/.test(f));
      expect(files.length, p).toBeGreaterThan(0);
      return files;
    });
    expect(onDisk.length).toBeGreaterThan(400);
    expect(own.fileNames.map(rel).sort()).toEqual(onDisk.sort());
  });

  it('the compiler resolves it as strictly as the packages: its own options are a short list, none switches a check off, here or in the base configuration', () => {
    const own = resolved('tsconfig.test.json');
    // Its own options: this list exactly. Anything else (`noCheck`, `skipLibCheck`, a loosened strict flag, `types`,
    // `lib`, `module`…) is the base's, shared with every package.
    expect(Object.keys(config.compilerOptions).sort()).toEqual([...OWN_OPTIONS].sort());
    // Resolved, whatever file set it: strict, every check of the strict family left on, nothing that looks away.
    expect(own.options.strict).toBe(true);
    for (const k of STRICT_FAMILY) expect(own.options[k], k).not.toBe(false);
    for (const k of LOOKS_AWAY) expect(own.options[k] ?? false, k).toBe(false);
    expect(own.options.jsx).toBe(ts.JsxEmit.ReactJSX);
    // And equal to a package's on every other key: the test files are checked with the options the sources are built with.
    const root = readConfig('tsconfig.json');
    const compared = (o: import('typescript').CompilerOptions, skip: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !skip.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
    expect(root.references!.map((r) => r.path)).toContain('packages/core');
    for (const r of root.references!) {
      const pkg = resolved(`${r.path}/tsconfig.json`);
      // A package's own options (its build output; the CLI's `moduleDetection`) are its own; the strict family is not.
      const ownKeys = Object.keys((pkg.raw as TestConfig).compilerOptions ?? {});
      expect(ownKeys.filter((k) => k === 'strict' || STRICT_FAMILY.includes(k) || LOOKS_AWAY.includes(k)), r.path).toEqual([]);
      expect(compared(own.options, [...NOT_COMPARED, ...ownKeys]), r.path).toEqual(compared(pkg.options, [...NOT_COMPARED, ...ownKeys]));
      expect(pkg.options.strict, r.path).toBe(true);
    }
    // packages/core sets nothing but its build output: the comparison with it is over every option.
    expect(Object.keys(readConfig('packages/core/tsconfig.json').compilerOptions).sort()).toEqual(['outDir', 'rootDir', 'tsBuildInfoFile']);
    expect(Object.keys(compared(own.options, NOT_COMPARED)).length).toBeGreaterThan(8);
  });

  it('vitest runs only files the check reads: its include patterns stay inside the test folders, TypeScript only', () => {
    const file = join(REPO, 'vitest.config.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const includes: string[][] = [];
    const visit = (n: Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'test' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) {
          if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== 'include') continue;
          if (!ts.isArrayLiteralExpression(p.initializer) || !p.initializer.elements.every((e) => ts.isStringLiteral(e))) throw new Error(`vitest.config.ts: test.include has a form this test does not read — ${p.initializer.getText(sf)}`);
          includes.push(p.initializer.elements.map((e) => (e as import('typescript').StringLiteral).text));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(includes).toHaveLength(1);
    expect(includes[0]!.length).toBeGreaterThan(0);
    for (const pattern of includes[0]!) expect(pattern).toMatch(/^packages\/\*\/test\/\*\*\/\*\.test\.tsx?$/);
    // No second list of tests elsewhere in the file (projects, a workspace): one `include`, the one read above.
    expect(readFileSync(file, 'utf8')).not.toMatch(/\b(?:projects|workspace)\s*:/);
    // Each pattern's files are the check's: the same folders, a suffix its patterns hold.
    const own = new Set(resolved('tsconfig.test.json').fileNames.map(rel));
    const tests = [...own].filter((f) => /\.test\.tsx?$/.test(f));
    expect(tests.length).toBeGreaterThan(300);
    for (const p of readdirSync(join(REPO, 'packages'))) {
      const dir = join(REPO, 'packages', p, 'test');
      if (!existsSync(dir)) continue;
      for (const f of filesUnder(dir).map(rel).filter((x) => /\.test\.tsx?$/.test(x))) expect(own.has(f), f).toBe(true);
    }
  });

  it('no test file switches its own check off: no file-wide or line-wide ignore, every expected error with its reason, at the count of the day', () => {
    // Spelt in pieces: this file is a test file too.
    const NOCHECK = '@ts-' + 'nocheck';
    const IGNORE = '@ts-' + 'ignore';
    const EXPECT = '@ts-' + 'expect-error';
    const directive = new RegExp(`^\\s*(?://+|/\\*+|\\*+)\\s*${EXPECT}(.*)$`);
    const files = resolved('tsconfig.test.json').fileNames;
    const without: string[] = [];
    let count = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // The words themselves, wherever they stand: a file-wide switch type-checks clean whatever the file holds, and
      // an ignore hides an error without saying which.
      expect(text.includes(NOCHECK), `${rel(file)}: ${NOCHECK}`).toBe(false);
      expect(text.includes(IGNORE), `${rel(file)}: ${IGNORE}`).toBe(false);
      text.split('\n').forEach((line, i) => {
        const m = directive.exec(line);
        if (!m) return;
        count += 1;
        // A reason on the directive's line: what is wrong on purpose below it.
        if (!/[A-Za-z]{3}/.test(m[1]!.replace(/\*\/\s*$/, ''))) without.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(without).toEqual([]);
    // Held at the number of the day (17 of the 29 are packages/ui/test/studio-ops.test.ts's check file, whose point they
    // are): one more is a decision, written here in the commit that adds it; one fewer lowers the number.
    expect(count).toBe(EXPECT_ERRORS);
  });

  it('its paths are the vitest aliases, one for one, roots and sub-paths, each to the same file', () => {
    const aliases = vitestAliases();
    const paths = config.compilerOptions.paths ?? {};
    expect(Object.keys(aliases).length).toBeGreaterThan(15);
    expect(Object.keys(paths).sort()).toEqual(Object.keys(aliases).sort());
    for (const [name, targets] of Object.entries(paths)) {
      expect(targets, name).toHaveLength(1);
      expect(relative(REPO, resolve(REPO, targets[0]!)).split('\\').join('/'), name).toBe(aliases[name]);
      expect(existsSync(join(REPO, aliases[name]!)), name).toBe(true);
      expect(name).not.toContain('*');
    }
    // Roots and sub-paths both: a root alias lets a test import a package its own package does not declare.
    expect(Object.keys(aliases).filter((k) => k.split('/').length === 2).length).toBeGreaterThan(8);
    expect(Object.keys(aliases).filter((k) => k.split('/').length === 3).length).toBeGreaterThan(6);
  });

  it('pnpm typecheck builds the packages, then checks the test files', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.typecheck).toBe('tsc -b && tsc -p tsconfig.test.json');
    expect(scripts.build).toBe('tsc -b');
  });
});
