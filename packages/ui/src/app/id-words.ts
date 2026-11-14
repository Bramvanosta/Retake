/**
 * The ids of the domain as the app reads them (L7.5): the one mirror of core's id grammar (core `id-grammar.ts`).
 * The app imports types only from the workspace's packages, so the patterns and caps it needs are written again here
 * — and nowhere else in the app; `test/id-words.test.ts` holds each of them equal to core's, source for source and
 * cap for cap, and the two readings equal on a table of strings.
 *
 * Pure: no React, no call, no import.
 */

/** A run id (core RUN_ID_RE): a folder name of runs/, never a path. No length here: RUN_ID_MAX beside it. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Longest run id (core RUN_ID_MAX). */
export const RUN_ID_MAX = 200;

/** A render id's shape (core RENDER_ID_RE): `<scenario>-v<n>`, a variant suffix. No length and no bound on the version. */
export const RENDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*-v\d+(?:-vertical|-square)?$/;
/** Longest render id (core RENDER_ID_MAX). */
export const RENDER_ID_MAX = 200;
/**
 * Whether `s` has a render id's shape and length: what an address of the app may hold. Not core's isRenderId: the
 * published shape has no bound on the version (the server refuses such an id; the app only routes it).
 */
export const okRenderIdShape = (s: unknown): s is string => typeof s === 'string' && s.length <= RENDER_ID_MAX && RENDER_ID.test(s);

/** The name of a theme that exists (core ANY_THEME_NAME_RE). */
export const ANY_THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Longest name of a theme that exists (core ANY_THEME_NAME_MAX). */
export const ANY_THEME_NAME_MAX = 100;
/** A NEW theme's name (core NEW_THEME_NAME_RE; also the grammar of a project slug): lower-case letters, digits, "-". */
export const NEW_THEME_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Longest name a new theme takes, whatever creates it (core NEW_THEME_NAME_MAX). */
export const NEW_THEME_NAME_MAX = 60;
/** A project slug (core PROJECT_SLUG_RE): the grammar of a new theme's name, the same object (core holds the two equal). */
export const PROJECT_SLUG = NEW_THEME_NAME;

/** Whether `n` is a name a new theme may take (core isNewThemeName): the lower-case grammar, at most 60 characters. */
export const okNewThemeName = (n: unknown): n is string => typeof n === 'string' && n.length <= NEW_THEME_NAME_MAX && NEW_THEME_NAME.test(n);

/** The last "-v<digits>[-vertical|-square]" a string ends in (core renderSuffix: any string, no cap, no bound). */
const RENDER_SUFFIX = /-v(\d+)(?:-(vertical|square))?$/;

/** "v3" of "quote-v3", "v3 vertical" of "quote-v3-vertical" — the digits as written; the id itself when it ends in no version. */
export function renderVersionWords(id: string): string {
  const m = RENDER_SUFFIX.exec(id);
  return m ? `v${m[1]}${m[2] ? ` ${m[2]}` : ''}` : id;
}
