/**
 * The engine's lazy imports of the heavy packages, one each: loaded on first use, so a command that needs neither never
 * pays for them.
 */

/** Lazy: @retake/editor pulls in Remotion's renderer and bundler (its planner and render records too). */
export const editor = () => import('@retake/editor');

/** Lazy: @retake/review pulls in sharp and the editor. */
export const review = () => import('@retake/review');
