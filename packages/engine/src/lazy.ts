/**
 * The engine's lazy imports of the heavy packages, one each: loaded on first use, so a command that needs neither never
 * pays for them. Each adapter's loader is used in its home only (the import-rules ratchet's `loader-use`): `hooks` in
 * hook-run/ (the HookRunner port's package adapter), `review` and `thumbs` in review/ (the Reviewer's).
 */

/** Lazy: @retake/editor pulls in Remotion's renderer and bundler (its planner and render records too). */
export const editor = () => import('@retake/editor');

/** Lazy: @retake/review pulls in sharp and the editor. */
export const review = () => import('@retake/review');

/** Lazy: the review's thumbnail entry — sharp and one ffmpeg process, never the editor (≈ 350 ms and ≈ 90 MB less). */
export const thumbs = () => import('@retake/review/thumbs');

/** Lazy: @retake/hooks pulls in the database driver (pg) and the hook kinds. */
export const hooks = () => import('@retake/hooks');
