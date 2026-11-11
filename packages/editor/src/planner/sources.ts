/** Steps of `planEdit`: the display addresses of the browser bars, then the plan's assets, sources and theme tokens. */
import { dirname, extname, join, relative } from 'node:path';
import { displayRows, displayUrl as displayedUrl, editDisplayTable, isLocalUrl, resolveEnvironment } from '@retake/core';
import type { DisplayEntry, TimelineTrack } from '@retake/core';
import { themeTokens } from '@retake/components/geometry';
import { PLAN_ASSET_SCHEME } from '../plan-types.js';
import type { PlanSource } from '../plan-types.js';
import type { PlanAddresses, PlanContext, PlanSources } from './scope.js';

/**
 * Display URLs (L1.7, R-ENV-01): what the browser bars and notification overlays show instead of the real URLs. They
 * are edit-time data: project.yaml's current pages of the run's environment (runs captured before L1.7 included: the
 * environment of run.json) win over the table the run recorded, so a display URL added since applies on this render.
 */
export function planAddresses(c: PlanContext): PlanAddresses {
  const { timeline, input, project, warnings } = c;
  const envName = timeline.environment?.name ?? input.env;
  let currentRows: DisplayEntry[] | undefined;
  if (envName !== undefined && Object.hasOwn(project.config.environments ?? {}, envName)) currentRows = displayRows(resolveEnvironment(project, envName));
  const displayTable: DisplayEntry[] = editDisplayTable(timeline.environment?.display, currentRows);
  const addresses = new Map<string, { url: string; hidden?: true }>();
  const addressOf = (url: string) => {
    let e = addresses.get(url);
    if (!e) addresses.set(url, (e = addressEntry(url, displayTable)));
    return e;
  };
  /**
   * A local URL a browser bar of the video would show: one warning per page (its address is left empty). The local
   * origin is named in parentheses only (the review masks it: a report never names a local host).
   */
  const warnHiddenUrl = (url: string): void => {
    let page: string | undefined;
    let best = -1;
    for (const row of currentRows ?? []) {
      const b = row.url;
      if ((url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`)) && b.length > best) {
        page = row.page;
        best = b.length;
      }
    }
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      /* keep the URL */
    }
    // A sandbox's pages are declared in its sandbox.yaml (L1.8: services.<service>.pages), not in project.yaml.
    const sandbox = envName !== undefined ? project.sandboxes?.[envName] : undefined;
    const manifest = sandbox ? relative(project.dir, sandbox.file) : 'project.yaml';
    const service = sandbox && page !== undefined ? Object.entries(sandbox.manifest.services).find(([, svc]) => Object.hasOwn(svc.pages ?? {}, page))?.[0] : undefined;
    const where = sandbox ? `services.${service ?? '<service>'}.pages.${page}` : `environments.${envName}.${page}`;
    warnings.add(
      page !== undefined
        ? `page "${page}" has no display URL (${origin}): the browser bar shows no address for it — add display: to ${where} in ${manifest} and render again (${sandbox ? 'docs/guide/sandbox.md' : 'docs/guide/environments.md'})`
        : `a local URL outside the pages of environment ${envName ?? '(unknown)'} has no display URL (${origin}): the browser bar shows no address for it — declare it as a page with a display: in ${sandbox ? `${manifest} (services.<service>.pages)` : 'project.yaml'} and render again (${sandbox ? 'docs/guide/sandbox.md' : 'docs/guide/environments.md'})`,
    );
  };
  return { displayTable, addressOf, warnHiddenUrl };
}

/**
 * A URL as the video's browser bars show it (L1.7, R-ENV-01): mapped through the run's display table; a URL still
 * local afterwards (localhost, a private address…) is kept `hidden` — urlAt / paneUrlAt never return it, the bar shows
 * no address — so a local URL is never drawn, and the navigation it marks stays visible to the review.
 */
function addressEntry(url: string, table: readonly DisplayEntry[]): { url: string; hidden?: true } {
  const shown = displayedUrl(url, table);
  return isLocalUrl(shown) ? { url: shown, hidden: true } : { url: shown };
}

/** The plan's assets (`ds-asset:` URLs → files): the capture, the page tracks, the theme's logo, wordmark and fonts. */
export function planSources(c: PlanContext): PlanSources {
  const { input, timeline, template, cap, srcFps, cssW, cssH, srcFrameCount, variant, outFps, width, height, unit } = c;
  const assets: Record<string, string> = {};
  const asset = (name: string, file: string): string => {
    const url = `${PLAN_ASSET_SCHEME}${name}${extname(file).toLowerCase()}`;
    assets[url] = file;
    return url;
  };
  const captureUrl = asset('capture', input.captureFile);
  // Per-page tracks of multi-page scenes (L2.11): every one CFR on the capture's frame grid.
  const trackDir = input.runDir ?? dirname(input.captureFile);
  const trackSources: Record<string, PlanSource> = {};
  const timelineTracks = new Map<string, TimelineTrack>((timeline.tracks ?? []).map((tr) => [tr.id, tr]));
  for (const tr of timeline.tracks ?? []) {
    const file = join(trackDir, tr.file);
    const name = `track-${tr.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    trackSources[tr.id] = {
      url: asset(name, file),
      file,
      width: Math.round(tr.width * tr.scale),
      height: Math.round(tr.height * tr.scale),
      cssWidth: tr.width,
      cssHeight: tr.height,
      scale: tr.scale,
      fps: tr.fps,
      frames: srcFrameCount,
      ...(tr.mobile ? { mobile: true } : {}),
    };
  }
  const mainSource: PlanSource = {
    url: captureUrl,
    file: input.captureFile,
    width: Math.round(cssW * cap.scale),
    height: Math.round(cssH * cap.scale),
    cssWidth: cssW,
    cssHeight: cssH,
    scale: cap.scale,
    fps: srcFps,
    frames: srcFrameCount,
  };
  const planShape = { tracks: trackSources, source: mainSource, variant, fps: outFps, width, height, unit };
  const logoUrl = asset('logo', template.assets.logo);
  const wordmarkUrl = template.assets.wordmark ? asset('wordmark', template.assets.wordmark) : undefined;
  const displayUrl = asset('font-display', template.assets.display);
  const bodyUrls = template.assets.body.map((f, i) => asset(`font-body-${i}`, f));
  const tokens = themeTokens(template, { logo: logoUrl, wordmark: wordmarkUrl, fonts: { display: displayUrl, body: bodyUrls } });
  return { assets, asset, trackSources, timelineTracks, mainSource, planShape, logoUrl, wordmarkUrl, displayUrl, bodyUrls, tokens };
}
