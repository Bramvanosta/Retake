/**
 * `@retake/hooks/describe`, a hook as words without running it: every module it reaches (relative imports, value and
 * type, read from the sources) is one of the describing modules and imports no Node module and no package but core.
 * The package root re-exports all of it, value for value. It is a domain entry (scripts/audit/lib.mjs DOMAIN_ENTRIES):
 * the engine uses its values, a shell its types.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '@retake/hooks';
import * as entry from '@retake/hooks/describe';
// @ts-expect-error — a plain .mjs script without types
import * as rules from '../../../scripts/audit/lib.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = join(SRC, 'describe-entry.ts');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** The modules the entry may reach: the words, the shown fields, the hooks' errors and the types (core's, re-exported). */
const PURE = ['describe-entry.ts', 'describe.ts', 'errors.ts', 'shown.ts', 'types.ts', 'util.ts'];
/** The side that runs, reads, connects or signs: never reached. */
const RUNNING = ['index.ts', 'run.ts', 'journal.ts', 'approval.ts', 'record.ts', 'secrets.ts', 'template.ts', 'allow-list.ts', 'db-url.ts', 'kinds/index.ts'];

/** Every specifier of a module, type imports, `import()` and `require()` included (the ratchet's reader). */
const specifiers = (file: string): string[] => rules.specifiersOf(ts, file, readFileSync(file, 'utf8')) as string[];

function walk(start: string): { files: string[]; specs: Map<string, string[]> } {
  const seen = new Set<string>();
  const specs = new Map<string, string[]>();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const list = specifiers(file);
    specs.set(relative(SRC, file).split('\\').join('/'), list);
    for (const s of list) {
      if (!s.startsWith('.')) continue;
      const base = resolve(dirname(file), s.replace(/\.js$/, ''));
      const found = [`${base}.ts`, join(base, 'index.ts')].find((f) => existsSync(f));
      if (!found) throw new Error(`${relative(SRC, file)}: cannot find ${s}`);
      queue.push(found);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')).sort(), specs };
}

describe('@retake/hooks/describe (the pure entry)', () => {
  const all = walk(ENTRY);

  it('reaches the describing modules only, nothing that runs a hook, reads a journal or a secret', () => {
    expect(all.files).toEqual(PURE);
    for (const f of RUNNING) {
      expect(existsSync(join(SRC, f)), f).toBe(true);
      expect(all.files, f).not.toContain(f);
    }
  });

  it('imports no Node module and no package but core', () => {
    const packages = new Set<string>();
    for (const [file, list] of all.specs) {
      for (const s of list) {
        if (s.startsWith('.')) continue;
        packages.add(s);
        expect(s.startsWith('node:') || createRequire(import.meta.url)('node:module').isBuiltin(s), `${file} → ${s}`).toBe(false);
      }
    }
    expect([...packages].sort()).toEqual(['@retake/core']);
    for (const f of all.files) expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/\bcreateRequire\b|\bgetBuiltinModule\b|\bimport\(|\brequire\(/);
  });

  it('is re-exported by the package root, value for value, and is a domain entry of the ratchet', () => {
    const names = Object.keys(entry).sort();
    expect(names).toEqual(['actionLines', 'declaredHookLines', 'describeHook', 'describeRollback', 'fieldLines', 'hookKindOf', 'rollbackActionLines', 'visible']);
    for (const n of names) expect((root as Record<string, unknown>)[n], n).toBe((entry as Record<string, unknown>)[n]);
    for (const n of ['runHooks', 'Journal', 'hookFingerprint', 'hookFiles']) {
      expect(n in root, n).toBe(true);
      expect(n in entry, n).toBe(false);
    }
    expect(rules.DOMAIN_ENTRIES).toContain('@retake/hooks/describe');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/hooks/package.json'), 'utf8')) as { exports: Record<string, { source: string }> };
    expect(pkg.exports['./describe']?.source).toBe('./src/describe-entry.ts');
  });

  it('shows a journaled rollback in full as before it moved (its templates filled, a secret left as written)', () => {
    const lines = entry.rollbackActionLines({ kind: 'shell', run: 'rm -f {{vars.file}}', description: 'remove it', data: { vars: { file: 'a.txt' } } });
    expect(lines).toEqual(['kind: shell', 'run: rm -f a.txt']);
    const secret = entry.rollbackActionLines({ kind: 'shell', run: 'curl -H "x: {{env:TOKEN}}" {{vars.u}}', description: 'd', data: { vars: { u: 'http://h.test' } } });
    expect(secret).toEqual(['kind: shell', 'run: curl -H "x: {{env:TOKEN}}" {{vars.u}}']);
  });
});
