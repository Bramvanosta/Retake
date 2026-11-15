/**
 * `fontsource:` font references (R-FLD-45): an open-licence font family published on the npm registry by the fontsource
 * project, named by its id (the family's slug: "Instrument Serif" → `instrument-serif`), an optional exact version and
 * one face — `fontsource:<id>[@<version>][:<weight>[italic]]`, weight 100 to 900 in hundreds (default 400).
 *
 * Pure: the grammar only. A reference is fetched once, by a person's own act (`retake theme fetch-font`) or after their
 * approval through MCP (`font_fetch`), into the workspace's font store (`.retake/fonts/fontsource/<id>@<version>/`);
 * a theme's create, update and the Studio read it from that store only, offline (engine brand/fontsource-store.ts).
 * Every part is a checked slug, version or number: a reference never carries free text, so a refusal can hand a person
 * the exact command to run.
 */

import { FONTSOURCE_ID_RE } from './id-grammar.js';

/** The scheme: a font reference starting with it is always a fontsource reference, never a path (any trust). */
export const FONTSOURCE_SCHEME = 'fontsource:';

/** An exact version (no range, no tag, no pre-release): "5.2.1". */
export const FONTSOURCE_VERSION_RE = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;

const REF_RE = /^fontsource:([^@:]*)(?:@([^:]*))?(?::(.*))?$/;
const FACE_RE = /^([1-9]00)(italic)?$/;

/** The licences a fetched package may declare (exact SPDX ids): both allow embedding a font in a video. */
export const FONTSOURCE_LICENCES = ['OFL-1.1', 'Apache-2.0'] as const;

export interface FontsourceRef {
  id: string;
  /** Absent: the newest version in the store (create) or on the registry (a fetch), resolved and recorded. */
  version?: string;
  weight: number;
  italic: boolean;
}

/** Whether a font reference uses the fontsource scheme (then it is one, or refused: never read as a path). */
export function isFontsourceRef(ref: string): boolean {
  return typeof ref === 'string' && ref.startsWith(FONTSOURCE_SCHEME);
}

/** Why a `fontsource:` reference is refused by its grammar, or null. */
export function fontsourceRefProblem(ref: string): string | null {
  const r = parseOrWhy(ref);
  return typeof r === 'string' ? r : null;
}

/** A parsed fontsource reference, or null when the text is none (fontsourceRefProblem says why). */
export function parseFontsourceRef(ref: string): FontsourceRef | null {
  const r = parseOrWhy(ref);
  return typeof r === 'string' ? null : r;
}

const GRAMMAR = 'fontsource:<id>[@<version>][:<weight>[italic]], e.g. fontsource:inter@5.2.1:600 or fontsource:inter:400italic';

function parseOrWhy(ref: string): FontsourceRef | string {
  if (typeof ref !== 'string' || ref.length > 120) return `a fontsource reference is ${GRAMMAR} (at most 120 characters)`;
  const m = REF_RE.exec(ref);
  if (!m) return `a fontsource reference is ${GRAMMAR}`;
  const [, id, version, face] = m;
  if (!FONTSOURCE_ID_RE.test(id)) return `fontsource id: lower-case letters, digits and "-" (the family's slug, e.g. instrument-serif) — ${GRAMMAR}`;
  if (version !== undefined && !FONTSOURCE_VERSION_RE.test(version)) return `fontsource version: an exact version such as 5.2.1 (no range, tag or pre-release) — ${GRAMMAR}`;
  let weight = 400;
  let italic = false;
  if (face !== undefined) {
    const f = FACE_RE.exec(face);
    if (!f) return `fontsource face: a weight 100 to 900 in hundreds, optionally followed by "italic" (e.g. 600, 400italic) — ${GRAMMAR}`;
    weight = Number(f[1]);
    italic = f[2] !== undefined;
  }
  return { id, ...(version !== undefined ? { version } : {}), weight, italic };
}

/** The canonical text of a reference: `fontsource:<id>[@<version>]:<weight>[italic]` (the weight always written). */
export function formatFontsourceRef(r: FontsourceRef): string {
  return `${FONTSOURCE_SCHEME}${r.id}${r.version !== undefined ? `@${r.version}` : ''}:${r.weight}${r.italic ? 'italic' : ''}`;
}

/** The npm package of a fontsource id. */
export function fontsourcePackage(id: string): string {
  return `@fontsource/${id}`;
}

/** Whether version a is newer than b (both exact versions). */
export function newerVersion(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
