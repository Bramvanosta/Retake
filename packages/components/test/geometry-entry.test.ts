/**
 * `@retake/components/geometry`, the components without a renderer: every module it reaches at run time (value imports
 * and re-exports, read from the sources) is a module of this package that imports no package and no Node module, so
 * the planner and the review load it without React, Remotion or esbuild and the compositions' bundles take it into a
 * browser page. Its frame helpers are the kit's own (the same functions), and the package root keeps its names.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '@retake/components';
import * as geometry from '@retake/components/geometry';
import * as kit from '@retake/components/kit';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** The value imports and re-exports of a module (type-only ones load nothing at run time). */
function valueSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push((st.moduleSpecifier as import('typescript').StringLiteral).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      out.push((st.moduleSpecifier as import('typescript').StringLiteral).text);
    }
  }
  return out;
}

/** The modules reached at run time from `start`, with the bare specifiers they load. */
function walk(start: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare: string[] = [];
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const s of valueSpecifiers(file)) {
      if (!s.startsWith('.')) {
        bare.push(`${relative(SRC, file)} → ${s}`);
        continue;
      }
      const base = resolve(dirname(file), s.replace(/\.js$/, ''));
      const found = [`${base}.ts`, `${base}.tsx`].find((f) => {
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
  return { files: [...seen].map((f) => relative(SRC, f).split('\\').join('/')).sort(), bare };
}

describe('@retake/components/geometry (the renderer-free entry)', () => {
  const { files, bare } = walk(join(SRC, 'geometry-entry.ts'));

  it('reaches only pure modules of this package: no package, no Node module, no React module, nothing of the registry or the compile check', () => {
    expect(bare).toEqual([]);
    expect(files.filter((f) => f.endsWith('.tsx'))).toEqual([]);
    expect(files).toContain('kit/frame-geometry.ts');
    expect(files).toContain('geometry.ts');
    expect(files).toContain('kit/fit-text.ts');
    for (const f of ['index.ts', 'kit/index.ts', 'compile.ts', 'registry.ts', 'manifest.ts', 'kit/renderer.ts']) expect(files).not.toContain(f);
  });

  it('its frame helpers are the kit’s own functions, and the package root keeps every name it had', () => {
    for (const n of [
      'autoFit',
      'AUTO_COVER_MIN_SHARE',
      'insetPhoneEdge',
      'captionBandBox',
      'safeAreaRect',
      'loupeLens',
      'stepBadgeBox',
      'shortcutPlateBox',
      'shortcutPlateLayout',
      'shortcutPlateMetrics',
      'CAMERA_EASINGS',
      'cubicBezier',
      'CAPTION_BAND_PAD_X',
      'captionMaxLines',
      'fitText',
      'estimateTextWidth',
    ]) {
      expect((geometry as Record<string, unknown>)[n], n).toBeDefined();
      expect((kit as Record<string, unknown>)[n], n).toBe((geometry as Record<string, unknown>)[n]);
    }
    for (const n of [
      'GEOMETRY_KEYS',
      'ANCHOR_KEYS',
      'evalAnchor',
      'evalLayoutGeometry',
      'isMultiPaneGeometry',
      'paramEnums',
      'fillSlots',
      'themeTokens',
      'fontFileFace',
      'parseCsv',
      'ARTEFACT_SLOT_TYPES',
      'CAMERA_EASINGS',
      'cubicBezier',
      'captionBandBox',
      'CAPTION_BAND_PAD_X',
      'captionMaxLines',
      'fitText',
      'estimateTextWidth',
    ]) {
      expect((root as Record<string, unknown>)[n], n).toBe((geometry as Record<string, unknown>)[n]);
    }
    expect(root.COMPONENT_KINDS.length).toBeGreaterThan(5);
    expect(root.GEOMETRY_KEYS).toEqual({ landscape: 'geometry', vertical: 'geometry_vertical', square: 'geometry_square' });
  });

  it('a font file’s face reads the last part of its path as basename does', () => {
    for (const file of ['Inter-SemiBold.ttf', 'fonts/Inter-BoldItalic.woff2', '/abs/fonts/Display-Light.otf', 'fonts/Body-Medium.ttf/', 'a/b.c/Heavy', 'x/Thin.Italic.ttf', 'Black', '', '/']) {
      expect(geometry.fontFileFace(file), file).toEqual(geometry.fontFileFace(basename(file)));
    }
    expect(geometry.fontFileFace('fonts/Inter-SemiBold.ttf')).toEqual({ weight: 600, style: 'normal' });
    expect(geometry.fontFileFace('x/semibold/Body-Regular.ttf')).toEqual({ weight: 400, style: 'normal' });
  });
});
