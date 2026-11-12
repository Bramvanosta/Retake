/**
 * `@retake/editor/plan`, the planner without the renderer: every module it reaches (relative imports, value and type,
 * read from the sources) stays out of the renderer and the compositions and imports no renderer, Remotion, React or
 * file-system module; the packages it reaches are the ones listed here (a new one is a decision, not a drift). The
 * package root re-exports all of it. At run time (the built entry imported by a Node process tracing every module it
 * resolves), it loads none of the renderer's packages and reaches the components only through their geometry entry.
 * The render records of a folder (L7.6b: core's one reader of renders/ and its rules; the editor's own listing and test
 * of a record are gone) read through the file system they are given.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '@retake/editor';
import * as entry from '@retake/editor/plan';
import { renderRecordsOf } from '@retake/core';
import { readRendersFolder } from '@retake/core/io';
import type { RenderFolderOptions } from '@retake/core/io';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ENTRY = join(SRC, 'plan-entry.ts');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** A specifier no module of the planner may import: the renderer's, Remotion's, React's, the file system's, processes'. */
const FORBIDDEN = /^(node:)?(fs|fs\/promises|child_process|net|tls|http|https|http2|os|worker_threads|module|stream|zlib)$|^(react|react-dom|remotion|@remotion\/|playwright|playwright-core|esbuild|sharp)(\/|$)/;
/** The packages the planner's modules import (each is the planner's own decision; core by its entries since L7.35). */
const PACKAGES = ['@retake/components/geometry', '@retake/core/base', '@retake/core/environment', '@retake/core/language', '@retake/core/model', '@retake/core/render', '@retake/core/theme', 'node:path'];

/** The editor modules reachable from `start` and the specifiers they import, read with the compiler's pre-processor. */
function walk(start: string): { files: string[]; specs: Map<string, string[]> } {
  const seen = new Set<string>();
  const specs = new Map<string, string[]>();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const imported = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((x) => x.fileName);
    specs.set(file, imported);
    for (const s of imported) {
      if (!s.startsWith('.')) continue;
      const base = resolve(dirname(file), s.replace(/\.js$/, ''));
      const found = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((f) => {
        try {
          readFileSync(f);
          return true;
        } catch {
          return false;
        }
      });
      if (!found) throw new Error(`${relative(SRC, file)}: cannot find ${s}`);
      queue.push(found);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')).sort(), specs };
}

describe('@retake/editor/plan (the planner entry)', () => {
  const { files, specs } = walk(ENTRY);

  it('reaches the planner, its steps and the frame geometry, and nothing of the renderer or the compositions', () => {
    expect(files).toContain('plan.ts');
    expect(files).toContain('planner/segments.ts');
    expect(files).toContain('remotion/frames.ts');
    expect(files.filter((f) => f.startsWith('planner/')).length).toBeGreaterThanOrEqual(15);
    const outside = files.filter((f) => f.startsWith('render/') || f.endsWith('.tsx') || ['inputs.ts', 'preview.ts', 'preview-plan.ts', 'index.ts', 'remotion/preview-mode.ts'].includes(f));
    expect(outside).toEqual([]);
  });

  it('imports no renderer, Remotion, React, file-system or process module, and only the packages it is meant to', () => {
    const bad: string[] = [];
    const packages = new Set<string>();
    for (const [file, list] of specs) {
      for (const s of list) {
        if (FORBIDDEN.test(s)) bad.push(`${relative(SRC, file)} → ${s}`);
        if (!s.startsWith('.')) packages.add(s);
      }
    }
    expect(bad).toEqual([]);
    expect([...packages].sort()).toEqual(PACKAGES);
  });

  it('is re-exported by the package root, value for value', () => {
    const names = Object.keys(entry);
    expect(names.length).toBeGreaterThan(100);
    for (const n of names) expect((root as Record<string, unknown>)[n], n).toBe((entry as Record<string, unknown>)[n]);
    for (const n of ['renderVideo', 'listRenders', 'probeMedia', 'ensureBundle', 'planInputFiles']) {
      expect(n in root).toBe(true);
      expect(n in entry).toBe(false);
    }
  });
});

/** A resolved module of a renderer package (its own folder under node_modules, pnpm's store included). */
const RENDERER_URL = /\/node_modules\/(react|react-dom|remotion|@remotion\/[^/]+|esbuild|sharp)\//;
/** A bare specifier of a renderer package. */
const RENDERER_SPEC = /^(react|react-dom|remotion|@remotion\/|esbuild|sharp)(\/|$)/;

/**
 * Every module a fresh Node process resolves while it imports `file`, as [specifier, url] (a resolve hook registered
 * before the import appends each one to a file).
 */
function loadTrace(file: string): Array<[string, string]> {
  const dir = mkdtempSync(join(tmpdir(), 'retake-plan-trace-'));
  try {
    const out = join(dir, 'trace.jsonl');
    const hooks = [
      "import { appendFileSync } from 'node:fs';",
      'let out;',
      'export function initialize(data) { out = data.out; }',
      'export async function resolve(spec, context, next) {',
      '  const r = await next(spec, context);',
      "  appendFileSync(out, JSON.stringify([spec, r.url]) + '\\n');",
      '  return r;',
      '}',
    ].join('\n');
    const main = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)}, { data: { out: ${JSON.stringify(out)} } });`,
      `await import(pathToFileURL(${JSON.stringify(file)}).href);`,
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', main], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as [string, string]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('@retake/editor/plan at run time (the built entry, every module it loads traced)', () => {
  const built = fileURLToPath(new URL('../dist/plan-entry.js', import.meta.url));

  it('loads no renderer, React, Remotion, esbuild or sharp module, and the components only through their geometry entry', () => {
    expect(existsSync(built), 'packages/editor/dist/plan-entry.js is missing: run pnpm build first').toBe(true);
    const trace = loadTrace(built);
    const urls = trace.map(([, url]) => url);
    // The trace works: it saw the entry's own modules and the components' geometry entry.
    expect(urls.some((u) => u.endsWith('/editor/dist/planner/segments.js'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/components/dist/geometry-entry.js'))).toBe(true);
    const bad = trace.filter(([spec, url]) => RENDERER_SPEC.test(spec) || RENDERER_URL.test(url)).map(([spec, url]) => `${spec} → ${url}`);
    expect(bad).toEqual([]);
    const components = urls.filter((u) => /\/components\/dist\/(index|kit\/index|compile)\.js$/.test(u));
    expect(components).toEqual([]);
    expect(urls.some((u) => /\/editor\/dist\/(render\/|remotion\/(?!frames\.js))/.test(u))).toBe(false);
  });
});

describe('the render records of a folder (core readRendersFolder + renderRecordsOf)', () => {
  const rec = (id: string, at: string) => JSON.stringify({ version: 1, id, scenario: id.replace(/-v\d+$/, ''), status: 'succeeded', created_at: at, plan: { version: 1 } });

  it('keeps the render records of a folder, oldest first (then by id), and skips dot files, other JSON and unreadable files', async () => {
    const files: Record<string, string> = {
      'b-v1.json': rec('b-v1', '2026-10-11T10:00:00.000Z'),
      'c-v1.json': rec('c-v1', '2026-10-11T11:00:00.000Z'),
      'a-v1.json': rec('a-v1', '2026-10-11T11:00:00.000Z'),
      '.hidden-v1.json': rec('hidden-v1', '2026-10-11T09:00:00.000Z'),
      'notes.txt': rec('txt-v1', '2026-10-11T09:00:00.000Z'),
      'other.json': '{"version": 1, "id": "x"}',
      'old.json': '{"version": 2, "id": "y", "plan": {}}',
      'broken.json': '{',
      'gone.json': '',
      // A copy of a record (its id is not its file's name) is no record of the folder's (D-10).
      'b-v1 copy.json': rec('b-v1', '2026-10-11T12:00:00.000Z'),
    };
    const read: string[] = [];
    const fs: NonNullable<RenderFolderOptions['fs']> = {
      names: async () => Object.keys(files),
      text: async (f) => {
        read.push(f);
        if (f.endsWith('gone.json')) return { ok: false, problem: 'missing', link: false };
        return { ok: true, text: files[f.slice(f.lastIndexOf('/') + 1)]!, link: false };
      },
    };
    expect(renderRecordsOf(await readRendersFolder('/p/renders', { fs })).map((r) => r.id)).toEqual(['b-v1', 'a-v1', 'c-v1']);
    expect(read).toContain('/p/renders/b-v1.json');
    expect(read.some((f) => f.includes('.hidden') || f.endsWith('.txt'))).toBe(false);
  });

  it('holds none when the folder cannot be listed', async () => {
    expect(await readRendersFolder('/nowhere', { fs: { names: async () => Promise.reject(new Error('ENOENT')), text: async () => ({ ok: false, problem: 'missing', link: false }) } })).toEqual([]);
  });
});
