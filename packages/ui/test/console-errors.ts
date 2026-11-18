/**
 * The console errors a Studio e2e file asserts empty (a test helper). A "Failed to load resource" line never counts
 * (a status the test provokes, a request a navigation cuts: the test checks its own statuses). Neither does one race of
 * the preview frame: the frame is a sandboxed, out-of-process iframe, so when the Studio page removes it (the timeline
 * or the theme editor left) it may still be fetching its theme fonts or its plan; the page gives its lease back
 * (timeline_leave), the player revokes the capability at once and answers 404 with no CORS header (both pinned: ⚑
 * player-characterization, timeline-ops, theme-ops) — and Chrome reports that 404 of a CORS fetch as a CORS error.
 * Such an error counts unless, when it came, no iframe of the capability its URL names was on the page and one had
 * left it (the browser's clock on both sides, so the order in which the messages reach the test does not matter). A
 * frame on the page whose request is refused is still an error — a capability two frames shared included.
 */
import type { BrowserContext, ConsoleMessage } from 'playwright-core';

/** The marker the init script logs when an iframe joins or leaves the Studio page: `<marker> in|out <time> <src>`. */
const MARK = 'retake-test:frame';
const CAP = '[A-Za-z0-9_-]{43}';
/** A CORS error of a player URL (`/m/<capability>/…`): its capability. */
const PLAYER_CORS = new RegExp(
  `^Access to \\w+ at 'http://127\\.0\\.0\\.1:\\d+/m/(${CAP})/[^']*' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`,
);
/** A preview frame's URL (`/s/<capability>/frame`): its capability. */
const FRAME = new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/(${CAP})/frame$`);

export interface ConsoleError {
  text: string;
  /** Browser time (ms since the epoch). */
  at: number;
}

export interface FrameMove {
  /** `in`: an iframe with this `src` joined the page (added, or its src set); `out`: it left (removed, or src changed). */
  move: 'in' | 'out';
  src: string;
  /** Browser time (ms since the epoch). */
  at: number;
}

/** The errors that count: every one but a player CORS error that came when its capability's frames had all left the page. */
export function countedErrors(errors: readonly ConsoleError[], moves: readonly FrameMove[]): string[] {
  const excused = (e: ConsoleError): boolean => {
    const cap = PLAYER_CORS.exec(e.text)?.[1];
    if (cap === undefined) return false;
    let present = 0;
    let left = false;
    for (const m of moves) {
      if (m.at > e.at || FRAME.exec(m.src)?.[1] !== cap) continue;
      present += m.move === 'in' ? 1 : -1;
      if (m.move === 'out') left = true;
    }
    return left && present <= 0;
  };
  return errors.filter((e) => !excused(e)).map((e) => e.text);
}

/** A page's console errors: `watch` the context before its page opens, `add` every console message, `list` the ones that count. */
export class ConsoleErrors {
  private readonly errors: ConsoleError[] = [];
  private readonly moves: FrameMove[] = [];

  /** The Studio page (the top window) logs every iframe that joins or leaves it, with its src. */
  async watch(context: BrowserContext): Promise<void> {
    await context.addInitScript((marker: string) => {
      if (window.top !== window) return;
      const log = (move: 'in' | 'out', src: string | null) => {
        if (src) console.debug(`${marker} ${move} ${Date.now()} ${src}`);
      };
      const frames = (n: Node) => (n instanceof HTMLIFrameElement ? [n] : n instanceof Element ? [...n.querySelectorAll('iframe')] : []);
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes') {
            if (!(r.target instanceof HTMLIFrameElement)) continue;
            const now = r.target.getAttribute('src');
            if (r.oldValue === now) continue;
            log('out', r.oldValue);
            log('in', now);
            continue;
          }
          for (const n of r.removedNodes) for (const f of frames(n)) log('out', f.getAttribute('src'));
          for (const n of r.addedNodes) for (const f of frames(n)) log('in', f.getAttribute('src'));
        }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'], attributeOldValue: true });
    }, MARK);
  }

  add(m: ConsoleMessage): void {
    const text = m.text();
    if (text.startsWith(`${MARK} `)) {
      const [, move, at, src] = /^\S+ (in|out) (\d+) (.*)$/.exec(text) ?? [];
      if (src !== undefined) this.moves.push({ move: move as FrameMove['move'], src, at: Number(at) });
      return;
    }
    if (m.type() === 'error' && !/Failed to load resource/.test(text)) this.errors.push({ text, at: m.timestamp() });
  }

  /** The errors that count (countedErrors). */
  list(): string[] {
    return countedErrors(this.errors, this.moves);
  }

  /** Every error seen, with its time (tests of this helper). */
  seen(): readonly ConsoleError[] {
    return this.errors;
  }

  /** Every iframe that joined or left the page, with its time (tests of this helper). */
  frameMoves(): readonly FrameMove[] {
    return this.moves;
  }
}
