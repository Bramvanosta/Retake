import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { BuildResult } from 'esbuild';
import type { LoadedTemplate } from '@retake/core/model';
import { RunnerError } from '../errors.js';
import type { CursorStyle, KitConfig } from './types.js';

export const DEFAULT_CURSOR_SIZE = 26;
export const DEFAULT_RIPPLE_COLOR = 'rgba(0,0,0,.25)';
export const CURSOR_STORAGE_KEY = 'retake:cursor';

/** Kit configuration from a template's cursor settings (arrow-dark, neutral ripple by default). */
export function kitConfigFor(template?: LoadedTemplate, override?: Partial<KitConfig['cursor']>): KitConfig {
  const c = template?.template.cursor;
  const style: CursorStyle = override?.style ?? c?.style ?? 'arrow-dark';
  return {
    cursor: {
      style,
      size: override?.size ?? c?.size ?? DEFAULT_CURSOR_SIZE,
      ripple_color: override?.ripple_color ?? c?.ripple_color ?? DEFAULT_RIPPLE_COLOR,
      ...(override?.hidden ? { hidden: true } : {}),
    },
    storage_key: CURSOR_STORAGE_KEY,
  };
}

/**
 * The kit's modules, src/kit/page (the package ships its sources): the same folder seen from src/kit (tests, tsx) and
 * from dist/kit (the built package).
 */
export const KIT_PAGE_DIR = fileURLToPath(new URL('../../src/kit/page/', import.meta.url));
/** Chromium only: the syntax of the package's own TypeScript build (ES2023), nothing lowered further. */
export const KIT_TARGET = 'es2023';

/**
 * Build the kit's page script from its modules: one immediately-invoked function (esbuild, in memory), not minified,
 * nothing but the modules of `dir` in it (a module that imported anything else would bring it into the page: refused).
 * Type-only imports are erased. The script reads its configuration from `__retakeKitConfig`, which `kitSource` defines.
 * A build that fails (a module that does not parse, a missing one) is a set-up error of the runner, worded as one.
 */
export function buildKitBundle(dir = KIT_PAGE_DIR): string {
  let out: BuildResult<{ write: false; metafile: true }>;
  try {
    out = build(dir);
  } catch (e) {
    throw new RunnerError(`the in-page kit was not built: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const outside = Object.keys(out.metafile.inputs).filter((f) => !/^[\w.-]+\.ts$/.test(f));
  if (outside.length) throw new RunnerError(`the in-page kit was not built: it imports ${outside.join(', ')} (its modules import only each other and types)`);
  return out.outputFiles[0].text;
}

function build(dir: string): BuildResult<{ write: false; metafile: true }> {
  return buildSync({
    absWorkingDir: dir,
    entryPoints: ['main.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: KIT_TARGET,
    charset: 'utf8',
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    tsconfigRaw: {},
  });
}

let bundle: string | undefined;

/** The kit's page script, built once per process (on first use; a failed build is not kept: the next use tries again). */
export function kitBundle(): string {
  return (bundle ??= buildKitBundle());
}

/** The in-page script: the kit's bundle, evaluated once per document with `config`. */
export function kitSource(config: KitConfig): string {
  return `(() => { const __retakeKitConfig = ${JSON.stringify(config)};\n${kitBundle()}})();`;
}
