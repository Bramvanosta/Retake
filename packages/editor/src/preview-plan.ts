/**
 * The plan the Studio's preview plays (L4.5, critique B4): the EditPlan with every `ds-asset:` URL swapped for the URL
 * the player origin serves the file at, and nothing that names a file of this Mac — no `assets` map, no `file` of the
 * capture, the page tracks or the music, no absolute path left in a slot (a theme's own file), no real local URL a
 * browser bar would hide (`hidden` entries keep their frame, lose their URL) — nor the planner's display table, notes
 * and warnings (they may name paths; the timeline view reports them). Pure.
 *
 * Refused (PreviewPlanError): a `ds-asset:` URL the plan's asset map does not name, a URL the caller's `urlFor` does not
 * give, and any string left that holds one of the folders the caller names (the project, the run, the theme, the
 * workspace, the home folder) or a `file:` URL.
 */
import { PLAN_ASSET_SCHEME } from './plan-types.js';
import type { EditPlan } from './plan-types.js';

export class PreviewPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewPlanError';
  }
}

export interface PreviewPlanOptions {
  /** The URL the player serves an asset at (`ds-asset:<name>` and its absolute file), or undefined (refused). */
  urlFor: (asset: string, file: string) => string | undefined;
  /** Folders whose paths must not reach the preview (checked on every string of the result). */
  forbid: readonly string[];
}

/** What reached the preview plan without its file paths. */
export type PreviewPlan = Omit<EditPlan, 'assets' | 'display' | 'notes' | 'warnings' | 'source' | 'tracks' | 'music'> & {
  source: Omit<EditPlan['source'], 'file'>;
  tracks?: Record<string, Omit<NonNullable<EditPlan['tracks']>[string], 'file'>>;
  music?: Omit<NonNullable<EditPlan['music']>, 'file'>;
};

/** A POSIX absolute path or a Windows one ("C:\…"), not a URL. */
const ABSOLUTE = /^(?:\/(?!\/)|[A-Za-z]:[\\/])/;

/** The preview plan of `plan` (see the module comment). */
export function previewPlan(plan: EditPlan, o: PreviewPlanOptions): PreviewPlan {
  const urls = new Map<string, string>();
  for (const [asset, file] of Object.entries(plan.assets)) {
    const url = o.urlFor(asset, file);
    if (url === undefined) throw new PreviewPlanError(`no preview URL for ${asset.slice(0, 80)}`);
    urls.set(asset, url);
  }
  const { assets: _a, display: _d, notes: _n, warnings: _w, ...rest } = plan;
  const out = structuredClone(rest) as Record<string, unknown>;
  const src = out.source as Record<string, unknown>;
  delete src.file;
  if (out.tracks) for (const t of Object.values(out.tracks as Record<string, Record<string, unknown>>)) delete t.file;
  if (out.music) delete (out.music as Record<string, unknown>).file;
  const walk = (v: unknown, key: string | undefined): unknown => {
    if (typeof v === 'string') {
      if (v.startsWith(PLAN_ASSET_SCHEME)) {
        const u = urls.get(v);
        if (u === undefined) throw new PreviewPlanError(`${key ?? 'a value'} names ${v.slice(0, 80)}, which the plan's assets do not serve`);
        return u;
      }
      // A theme's own file in a slot (studio/media's `file`): the component reads the media URL, never the path.
      if (ABSOLUTE.test(v)) return '';
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      // A local URL without a display one (`hidden`): the bar shows no address there — its real URL stays here.
      if (obj.hidden === true && typeof obj.url === 'string' && typeof obj.frame === 'number') return { ...obj, url: '' };
      const o2: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(obj)) o2[k] = walk(x, k);
      return o2;
    }
    return v;
  };
  const swapped = walk(out, undefined) as PreviewPlan;
  const forbid = o.forbid.filter((d) => d.length > 1);
  const scan = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/^file:/i.test(v)) throw new PreviewPlanError(`${path} is a file: URL`);
      for (const d of forbid) if (v.includes(d)) throw new PreviewPlanError(`${path} names a folder of this Mac`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${path}.${k}`);
  };
  scan(swapped, 'plan');
  return swapped;
}
