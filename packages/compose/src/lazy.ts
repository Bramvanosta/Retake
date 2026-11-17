/**
 * The product's lazy imports of the heavy packages, one each: loaded on first use, so a command that needs neither never
 * pays for them. The composition package is the only one that loads an adapter package's code: the package adapters
 * beside this file use them, and `editor` and `components` are bound into the engine (ports.ts bindProduct), whose
 * render and registries folders hand their work on.
 */

/** Lazy: @retake/editor pulls in Remotion's renderer and bundler (its planner and render records too). */
export const editor = () => import('@retake/editor');

/** Lazy: @retake/review pulls in sharp and the editor. */
export const review = () => import('@retake/review');

/** Lazy: the review's thumbnail entry — sharp and one ffmpeg process, never the editor (≈ 350 ms and ≈ 90 MB less). */
export const thumbs = () => import('@retake/review/thumbs');

/** Lazy: @retake/hooks pulls in the database driver (pg) and the hook kinds. */
export const hooks = () => import('@retake/hooks');

/** Lazy: @retake/runner-web pulls in Playwright, the capture's encoder and its in-page kit. */
export const runnerWeb = () => import('@retake/runner-web');

/** Lazy: @retake/runner-ios drives the iOS Simulator (its runs only: a web run never loads it). */
export const runnerIos = () => import('@retake/runner-ios');

/** Lazy: @retake/sandbox pulls in the database driver (pg) and the process and docker-compose providers. */
export const sandbox = () => import('@retake/sandbox');

/** Lazy: @retake/components pulls in esbuild (a component's compile check) and the registry's readers. */
export const components = () => import('@retake/components');
