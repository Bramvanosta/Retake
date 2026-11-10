/**
 * Which driver a use case renders with: the one it was handed, or — when its caller names none — this package's own.
 * The one place that decides it, for renderVideo, renderStill, exportRender and the component previews.
 *
 * The rule is read from the options' `renderer` key, not from its value:
 * - no `renderer` key: the caller renders standalone, on this package's own driver (Remotion). That is this package's
 *   tests and scripts, and the CLI's `components preview` command, which still renders with the editor itself;
 *   the engine never comes this way — its render work always names a renderer (engine render/work.ts);
 * - a `renderer` key: that driver renders, or the work is refused. A key that holds nothing, or something that cannot
 *   render this work, is a caller that lost its renderer on the way: falling back to Remotion there would hide it.
 *   And the options of this package's own driver (`cacheDir`, `seams`, a preview `backend`) are refused beside it:
 *   a handed driver was made with its own, so they would be accepted and ignored.
 */
import type { RenderDriver } from './driver-types.js';
import { RenderError } from './types.js';

const PART_IS = { video: 'function', stills: 'function', previews: 'object' } as const;
/** Options of this package's own driver: they say how it is made, so they mean nothing beside a driver already made. */
const OWN_DRIVER_OPTIONS = ['cacheDir', 'seams', 'backend'] as const;

/** The driver `opts` hands for `part`, undefined when it names none (the caller then builds this package's own). */
export function handedDriver<K extends keyof RenderDriver>(work: string, opts: object, part: K): Pick<RenderDriver, K> | undefined {
  if (!Object.hasOwn(opts, 'renderer')) return undefined;
  const o = opts as Record<string, unknown>;
  const r = o.renderer;
  const p = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)[part] : undefined;
  if (p === undefined || p === null || typeof p !== PART_IS[part]) {
    throw new RenderError(`${work}: a renderer was named but none was handed (nothing to render ${part} with)`);
  }
  const own = OWN_DRIVER_OPTIONS.filter((k) => o[k] !== undefined);
  if (own.length > 0) {
    throw new RenderError(`${work}: ${own.join(', ')} ${own.length > 1 ? 'are options' : 'is an option'} of the editor's own renderer and cannot go with a renderer that is handed`);
  }
  return r as Pick<RenderDriver, K>;
}
