/**
 * What the runner opens in the browser (core navigationProblem): every navigation it starts — a scene's `open`, a
 * multi-page scene's `pages[].open`, an `open` step, a `new_tab` step (its `href`, or the clicked link's when the click
 * opened no page) and the prewarm visits — is checked on its final URL, once templated and resolved, before any page is
 * created or loaded. The browser's last resort against `file:` (armFileGuard) is in session.ts.
 */
import { showHiddenChars } from '@retake/core/base';
import { canonicalOrigin, navigationProblem } from '@retake/core/policy';
import type { Confinement } from '@retake/core/model';

/** The rule of one run: the scheme rule always; under agent trust, the environment's origins for URLs the scenario wrote. */
export interface NavigationRule {
  /** The origins of the environment's pages (core pageOrigins): set for work submitted through MCP or the Studio. */
  origins?: readonly string[];
  envName?: string;
  via?: Confinement;
}

/** Where a URL comes from: the scenario (its text, templated), or a page (a link's href, with the page that holds it). */
export type NavigationSource = { from: 'scenario' } | { from: 'page'; opener: string };

const SCENARIO: NavigationSource = { from: 'scenario' };

/**
 * Why the runner may not open `url` (null when it may). A URL the scenario wrote follows core navigationProblem with
 * the rule's origins; a URL a page provides (a link's href) the scheme rule only — the page may link to any http(s) site —
 * and a `blob:` URL of the page's own origin (a document the page made, such as a PDF it opens in a tab) is followed.
 * Text that does not parse as an absolute URL is refused, whoever wrote it.
 */
export function openProblem(url: string, rule: NavigationRule = {}, source: NavigationSource = SCENARIO): string | null {
  // What the runner opens is always resolved: text that is not an absolute URL is never handed to the browser.
  if (!URL.canParse(url)) return `${shownText(url)} is not an absolute URL a browser can read — write the http(s) URL of the page, or a path of an environment page (\`/…\`)`;
  if (source.from === 'page') {
    if (isOwnBlob(url, source.opener)) return null;
    const problem = navigationProblem(url);
    return problem && `the clicked link's href is not followed: ${problem} (as the step's \`href\`)`;
  }
  return navigationProblem(url, rule);
}

/** A `blob:` URL whose origin is the opener's (http or https). */
function isOwnBlob(url: string, opener: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'blob:') return false;
  const own = canonicalOrigin(opener);
  return own !== null && canonicalOrigin(u.origin) === own;
}

/** Text that is not a URL, as a message shows it: without anything that looks like sign-in details, hidden characters written out, cut. */
function shownText(text: string): string {
  const v = showHiddenChars(text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1')).replace(/[\n\r\t]/g, ' ');
  return `"${v.length > 120 ? `${v.slice(0, 117)}…` : v}"`;
}
