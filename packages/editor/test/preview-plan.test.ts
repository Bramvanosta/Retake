/**
 * L4.5 part A, the preview's plan (editor preview-plan.ts `previewPlan`, critique B4): what the Studio's player plays
 * names no file of this Mac — every `ds-asset:` URL swapped for the player's URL, the asset map, the capture / track /
 * music files, the display table, the notes and warnings gone, an absolute path in a slot blanked, a hidden local URL
 * without its address — and refuses (⚑) a `ds-asset:` URL the plan does not serve, an asset without a player URL, and
 * any string left that names one of the folders the caller forbids. On real fixture plans (quote; live-quote: tracks
 * and hidden URLs).
 */
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { PLAN_ASSET_SCHEME, PreviewPlanError, planEdit, previewPlan } from '@retake/editor';
import type { ClipSegment, EditPlan } from '@retake/editor';
import type { Timeline } from '@retake/core';
import { FIXTURES, REPO, fixtureProject, template } from './helpers.js';

const RUN = '/virtual/runs/r';
let registry: ComponentRegistry;
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
async function plan(name: string): Promise<EditPlan> {
  return planEdit({ timeline: load(name), template: await template('editorial'), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4` });
}
const CAP = 'http://127.0.0.1:47999/m/Zm9vYmFy';
const urlFor = (asset: string, file: string) => `${CAP}/${Buffer.from(asset).toString('hex').slice(0, 12)}/${file.split('/').pop()}`;
const FORBID = [REPO.replace(/\/$/, ''), RUN, '/virtual', homedir()];

/** Every string of a value with its path. */
function strings(v: unknown, path = 'plan', out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
}

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('previewPlan (critique B4)', () => {
  it('quote: every asset URL swapped for the player\'s, no file, path, display table, note or warning left', async () => {
    const p = await plan('quote');
    expect(Object.keys(p.assets).length).toBeGreaterThan(3);
    const out = previewPlan(p, { urlFor, forbid: FORBID });
    for (const k of ['assets', 'display', 'notes', 'warnings']) expect(out, k).not.toHaveProperty(k);
    expect(out.source).not.toHaveProperty('file');
    expect(out.source.url).toBe(urlFor(p.source.url, p.assets[p.source.url]));
    const all = strings(out);
    expect(all.filter(([, v]) => v.startsWith(PLAN_ASSET_SCHEME))).toEqual([]);
    expect(all.filter(([, v]) => /^\/(?!\/)/.test(v) || FORBID.some((d) => v.includes(d)))).toEqual([]);
    for (const file of Object.values(p.assets)) expect(JSON.stringify(out)).not.toContain(file);
    // Fonts and the logo now load from the player origin.
    expect(out.brand.fonts.display.url.startsWith(CAP)).toBe(true);
    expect(out.brand.logo.url.startsWith(CAP)).toBe(true);
    // The plan itself is untouched (the render still serves it).
    expect(p.source.file).toBe(`${RUN}/capture.mp4`);
  });

  it('live-quote: page tracks lose their files, a hidden local URL keeps its frame but not its address', async () => {
    const p = await plan('live-quote');
    expect(Object.keys(p.tracks ?? {}).length).toBe(2);
    const hidden = (p.segments as ClipSegment[]).flatMap((s) => (s.kind === 'clip' ? [...s.urls, ...(s.panes ?? []).flatMap((x) => x.urls)] : [])).filter((u) => u.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    const out = previewPlan(p, { urlFor, forbid: FORBID });
    for (const t of Object.values(out.tracks ?? {})) {
      expect(t).not.toHaveProperty('file');
      expect(t.url.startsWith(CAP)).toBe(true);
    }
    const urls = (out.segments as ClipSegment[]).flatMap((s) => (s.kind === 'clip' ? [...s.urls, ...(s.panes ?? []).flatMap((x) => x.urls)] : []));
    expect(urls.filter((u) => u.hidden).every((u) => u.url === '')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('localhost:4401');
  });

  it('⚑ refuses a ds-asset URL the plan does not serve, an asset without a player URL, a forbidden folder left in any string', async () => {
    const p = await plan('quote');
    const unknown = structuredClone(p);
    unknown.segments[0].component.slots.logo = `${PLAN_ASSET_SCHEME}secret-key`;
    expect(() => previewPlan(unknown, { urlFor, forbid: FORBID })).toThrow(PreviewPlanError);
    expect(() => previewPlan(unknown, { urlFor, forbid: FORBID })).toThrow(/which the plan's assets do not serve/);
    expect(() => previewPlan(p, { urlFor: (a, f) => (f.endsWith('.mp4') ? undefined : urlFor(a, f)), forbid: FORBID })).toThrow(/no preview URL for ds-asset:/);
    const leaked = structuredClone(p);
    leaked.captions[0].text = `see ${RUN}/notes.txt`;
    expect(() => previewPlan(leaked, { urlFor, forbid: FORBID })).toThrow(/names a folder of this Mac/);
    const fileUrl = structuredClone(p);
    fileUrl.segments[0].component.slots.extra = 'file:///etc/hosts';
    expect(() => previewPlan(fileUrl, { urlFor, forbid: FORBID })).toThrow(/is a file: URL/);
    // An absolute path in a slot (a theme's own file) is blanked: the component reads the media URL.
    const own = structuredClone(p);
    own.segments[0].component.slots.file = `${homedir()}/themes/acme/intro.mp4`;
    expect(previewPlan(own, { urlFor, forbid: FORBID }).segments[0].component.slots.file).toBe('');
  });
});
