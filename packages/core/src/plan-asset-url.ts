/**
 * The URL scheme of the files a plan serves (the capture, the logo, the wordmark, the fonts, the music):
 * `retake-asset:<name>`. The planner is pure and does not know where the renderer serves files, so every such URL of a
 * plan uses this scheme and `EditPlan.assets` maps it to its absolute file; the renderer serves the files and swaps the
 * URLs.
 *
 * A render record keeps the plan it rendered, and a plan written before the scheme took its present spelling holds the
 * earlier one: both are read (served, checked, signed alike), only the present one is written.
 */

/** The scheme every plan is written with. */
export const PLAN_ASSET_SCHEME = 'retake-asset:';

/** The scheme's earlier spelling, read in the plans of render records made before it changed; never written. */
export const EARLIER_PLAN_ASSET_SCHEME = 'ds-asset:'; // old-name: the spelling older render records hold

/** Every spelling a plan's asset URL is read in (the present one first). */
export const PLAN_ASSET_SCHEMES: readonly string[] = [PLAN_ASSET_SCHEME, EARLIER_PLAN_ASSET_SCHEME];

/** Whether a value is a plan asset URL, in either spelling. */
export function isPlanAssetUrl(value: string): boolean {
  return PLAN_ASSET_SCHEMES.some((s) => value.startsWith(s));
}

/** A plan asset URL's name (`logo.svg`), in either spelling; any other value as it is. */
export function planAssetName(url: string): string {
  const scheme = PLAN_ASSET_SCHEMES.find((s) => url.startsWith(s));
  return scheme === undefined ? url : url.slice(scheme.length);
}

/** Whether a slot value is already a URL the renderer loads as it is (http(s), data, or a plan asset URL), not a project file. */
export function isLoadedUrl(value: string): boolean {
  return /^(?:https?:|data:)/.test(value) || isPlanAssetUrl(value);
}

/**
 * A plan's JSON text in the present spelling of its generated names: asset URLs and the theme's font family names
 * (`retake-<theme>-display` / `-body`). A plan's signature is taken on it, so the record of a render made before the
 * names changed still matches the same plan made today.
 */
export function planTextInPresentSpelling(json: string): string {
  return json
    .replaceAll(`"${EARLIER_PLAN_ASSET_SCHEME}`, `"${PLAN_ASSET_SCHEME}`) // old-name: the earlier scheme read
    .replace(/"ds-([a-z0-9]+(?:-[a-z0-9]+)*)-(display|body)"/g, '"retake-$1-$2"'); // old-name: the earlier font family names read
}
