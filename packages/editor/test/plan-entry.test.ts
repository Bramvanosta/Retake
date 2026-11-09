/**
 * `@retake/editor/plan`, the planner without the renderer: every module it reaches (relative imports, value and type,
 * read from the sources) stays out of the renderer and the compositions and imports no renderer, Remotion, React or
 * file-system module; the packages it reaches are the ones listed here (a new one is a decision, not a drift). The
 * package root re-exports all of it. The render record's listing reads through the functions it is given.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '@retake/editor';
import * as entry from '@retake/editor/plan';
import { readRenderRecords } from '@retake/editor/plan';
import type { RenderRecordReader } from '@retake/editor/plan';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ENTRY = join(SRC, 'plan-entry.ts');
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** A specifier no module of the planner may import: the renderer's, Remotion's, React's, the file system's, processes'. */
const FORBIDDEN = /^(node:)?(fs|fs\/promises|child_process|net|tls|http|https|http2|os|worker_threads|module|stream|zlib)$|^(react|react-dom|remotion|@remotion\/|playwright|playwright-core|esbuild|sharp)(\/|$)/;
/** The packages the planner's modules import (each is the planner's own decision). */
const PACKAGES = ['@retake/components', '@retake/components/kit', '@retake/core', 'node:path'];

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

describe('readRenderRecords', () => {
  const rec = (id: string, at: string) => JSON.stringify({ version: 1, id, created_at: at, plan: { version: 1 } });

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
    };
    const read: string[] = [];
    const io: RenderRecordReader = {
      list: async () => Object.keys(files),
      read: async (f) => {
        read.push(f);
        if (f.endsWith('gone.json')) throw new Error('ENOENT');
        return files[f.slice(f.lastIndexOf('/') + 1)];
      },
    };
    expect((await readRenderRecords('/p/renders', io)).map((r) => r.id)).toEqual(['b-v1', 'a-v1', 'c-v1']);
    expect(read).toContain('/p/renders/b-v1.json');
    expect(read.some((f) => f.includes('.hidden') || f.endsWith('.txt'))).toBe(false);
  });

  it('holds none when the folder cannot be listed', async () => {
    expect(await readRenderRecords('/nowhere', { list: async () => Promise.reject(new Error('ENOENT')), read: async () => '' })).toEqual([]);
  });
});
