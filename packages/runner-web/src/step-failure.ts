/** A step that failed: the error the run aborts with, and the screenshot and DOM snippet written next to it. */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MissingTarget } from '@retake/core/run';
import { StepError, errorMessage } from './errors.js';
import type { Runtime } from './runtime.js';
import { fileSlug } from './util.js';

/**
 * DOM snippets written next to error screenshots (`error-<scene>-<step>.html`) are trimmed to this many characters
 * (docs/DESIGN.md §3.2): the failing element's outerHTML when known, else the body — enough to see the structure
 * around a missing target, small enough to read or hand to an agent.
 */
export const ERROR_DOM_MAX = 64 * 1024;

/** A non-optional step failed: the run aborts (teardown still runs). */
export class StepFailure extends Error {
  readonly scene: string;
  readonly step: number;
  readonly action: string;
  readonly screenshot?: string;
  readonly dom?: string;
  /** The target was not found: the scene's later targets missing from the page too (R-FLD-10). */
  readonly missing?: MissingTarget[];

  constructor(message: string, o: { scene: string; step: number; action: string; screenshot?: string | undefined; dom?: string | undefined; missing?: MissingTarget[] | undefined }) {
    super(message);
    this.scene = o.scene;
    this.step = o.step;
    this.action = o.action;
    this.screenshot = o.screenshot;
    this.dom = o.dom;
    this.missing = o.missing;
    this.name = 'StepFailure';
  }
}

const TRIM_NOTE = /\n<!-- … trimmed to \d+ of (\d+) chars -->$/;

/**
 * A DOM snippet cut to `max` characters after its last complete tag within the cap (a cut inside a tag would be
 * unreadable), with the kit's note on what was left out; a snippet the kit already trimmed keeps the original length.
 */
export function trimSnippet(html: string, max: number): string {
  const note = TRIM_NOTE.exec(html);
  const body = note ? html.slice(0, note.index) : html;
  if (body.length <= max) return html;
  let cut = body.lastIndexOf('>', max - 1) + 1;
  if (cut < max * 0.75) cut = max;
  return `${body.slice(0, cut)}\n<!-- … trimmed to ${cut} of ${note ? note[1] : body.length} chars -->`;
}

export async function errorArtifacts(rt: Runtime, scene: string, step: number, e: unknown): Promise<{ screenshot?: string; dom?: string }> {
  const base = join(rt.screenshotsDir, `error-${fileSlug(scene)}-${step}`);
  const out: { screenshot?: string; dom?: string } = await errorFiles(rt, scene, step, e, base);
  // Never a picture or the DOM of a sign-in page: a landing seen while they were taken removes them.
  if (rt.guard && guardFired(rt)) {
    await Promise.all([out.screenshot, out.dom].filter((f): f is string => !!f).map((f) => rm(f, { force: true }).catch(() => undefined)));
    return {};
  }
  return out;
}

/** Whether a filmed page is (or was) on a sign-in page: the landing is then recorded by the guard. */
export function guardFired(rt: Runtime): boolean {
  try {
    rt.assertSignedIn();
    return false;
  } catch {
    return true;
  }
}

async function errorFiles(rt: Runtime, scene: string, step: number, e: unknown, base: string): Promise<{ screenshot?: string; dom?: string }> {
  const out: { screenshot?: string; dom?: string } = {};
  try {
    await rt.page.screenshot({ path: `${base}.png`, timeout: 10_000 });
    out.screenshot = `${base}.png`;
  } catch (err) {
    rt.log('warn', `error screenshot failed: ${errorMessage(err)}`);
  }
  try {
    const ref = e instanceof StepError ? e.domRef : null;
    // Secret values are masked before the snippet is trimmed (a cut must not keep the start of one): the kit trims at
    // twice the size, the final cut is made here.
    const html = trimSnippet(rt.secrets.redactText(await rt.kit.snapshot(ref, ERROR_DOM_MAX * 2)), ERROR_DOM_MAX);
    const header = [
      '<!-- Retake step failure',
      `  scene: ${scene}  step: ${step}`,
      `  url: ${rt.secrets.redactText(rt.page.url())}`,
      `  error: ${rt.secrets.redactText(errorMessage(e)).replace(/--/g, '—')}`,
      '-->',
    ].join('\n');
    await writeFile(`${base}.html`, `${header}\n${html}\n`);
    out.dom = `${base}.html`;
  } catch (err) {
    rt.log('warn', `error DOM snapshot failed: ${errorMessage(err)}`);
  }
  return out;
}
