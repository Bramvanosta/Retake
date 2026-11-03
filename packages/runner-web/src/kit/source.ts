import type { LoadedTemplate } from '@retake/core';
import { demoKit } from './kit.js';
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
 * The in-page script: evaluates `demoKit(config)` once per document.
 * `__name` is shimmed because some TS transpilers (esbuild keepNames) wrap inner functions with it.
 */
export function kitSource(config: KitConfig): string {
  return `(() => { var __name = (f) => f; (${demoKit.toString()})(${JSON.stringify(config)}); })();`;
}
