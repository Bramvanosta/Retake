import type { IssuePath } from './issues.js';
import { interpolateAt } from './templating.js';
import type { TemplateContext } from './templating.js';
import type { SceneEntry, TimelineVideo } from './types.js';

/*
 * Scenario templating (R-RUN-16): every string of a scene entry is interpolated when the runner reaches it — step
 * arguments and targets, captions, overlays, page labels, cards and interstitials — so the timeline records values,
 * never tokens. The paths below are relative to a scene entry: ['steps', 3, 'type', 'text'].
 */

const isStep = (rel: IssuePath): boolean => rel[0] === 'steps' && typeof rel[1] === 'number';

/**
 * Names the runner uses as written, never templated: an `emit` event name (recorded as is in the timeline) and a
 * `screenshot` file name. `value` tells the shorthand (`emit: name`) from the object form at ['steps', j, 'emit'].
 */
export function isLiteralPath(rel: IssuePath, value: unknown): boolean {
  if (!isStep(rel) || (rel[2] !== 'emit' && rel[2] !== 'screenshot')) return false;
  return rel.length === 3 ? typeof value === 'string' : rel.length === 4 && rel[3] === 'name';
}

const SCENE_TEXT = new Set(['caption', 'tutorial', 'card', 'interstitial', 'transition']);
const STEP_TEXT = new Set(['caption', 'tutorial']);

/**
 * Text the edited video shows: captions, tutorial switches, cards, interstitials, scene transitions (a component's
 * params), page labels and the slots and params of step overlays (not their `target`: an element of the real page). A
 * secret reference there is a validation error: it would be burnt into the video and kept in clear in timeline.json.
 */
export function isEditTextPath(rel: IssuePath): boolean {
  const [a, b, c] = rel;
  if (typeof a === 'string' && SCENE_TEXT.has(a)) return true;
  if (a === 'pages') return rel.length === 3 && b !== undefined && c === 'label';
  if (isStep(rel) && c === 'overlay') return rel[3] === 'slots' || rel[3] === 'params';
  return isStep(rel) && typeof c === 'string' && STEP_TEXT.has(c);
}

/**
 * A scene entry (scene, card or interstitial) with every string interpolated, except `note`s, `eval` (templated
 * when it runs, its file included) and the literal names (isLiteralPath). Throws a TemplateError naming the string
 * ("scenes[2].steps[3].type.text: unknown template key …"). `editCtx` (L1.7), when given, templates the text the
 * video shows (isEditTextPath: captions, cards, overlays, page labels…) — its `pages` are the display URLs, so
 * `{{shop}}` in a caption reads `https://shop.example.com` while `open: "{{shop}}/x"` still navigates the real URL.
 */
export function templateSceneEntry<T extends SceneEntry>(entry: T, index: number, ctx: TemplateContext, editCtx?: TemplateContext): T {
  const skip = (path: IssuePath, value: unknown): boolean => {
    const rel = path.slice(2);
    return rel[rel.length - 1] === 'note' || (isStep(rel) && rel[2] === 'eval') || isLiteralPath(rel, value);
  };
  return interpolateAt(entry, ctx, ['scenes', index], skip, editCtx ? (path) => (isEditTextPath(path.slice(2)) ? editCtx : ctx) : undefined);
}

/**
 * The video's title, intro, outro and tutorial switches with their strings interpolated (timeline `video`). All of it
 * is text the video shows: the runner passes the edit context (display URLs, L1.7).
 */
export function templateVideo(video: TimelineVideo, ctx: TemplateContext): TimelineVideo {
  const out: TimelineVideo = { ...video };
  if (out.title !== undefined) out.title = interpolateAt(out.title, ctx, ['title']);
  if (out.intro !== undefined) out.intro = interpolateAt(out.intro, ctx, ['intro']);
  if (out.outro !== undefined) out.outro = interpolateAt(out.outro, ctx, ['outro']);
  if (out.tutorial !== undefined) out.tutorial = interpolateAt(out.tutorial, ctx, ['tutorial']);
  return out;
}
