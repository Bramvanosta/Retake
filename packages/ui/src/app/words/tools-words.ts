/**
 * The app's downloaded Tools in the Studio — their words (DESIGN §4p, docs/reference/studio-ui.md; the approved
 * mockup's): the Set-up sheet's item "Browser and render tools", the status bar's control, Welcome's card, the Tools
 * page, the Run screen's waiting words and the "not downloaded yet" states of previews. Data: tools_status (ui
 * tools-ops.ts, data/tools.ts). Pure: every rule here is a unit test. Shared words (words/): the shell and the
 * features (Welcome, the Tools page, Shoot, the library, comments) show them.
 */
import { APP_NAME } from '../brand.js';
import type { ToolView, ToolsView } from '../data/ops.js';
import type { MarkState } from '../ui-kit/index.js';

export type { ToolView, ToolsView };

/**
 * "152 MB" (one decimal under 10 MB): decimal megabytes, the rule of core's `megabytes` that `retake tools` and the
 * installer use (the page imports no core code: tools-words.test.ts pins the two to one figure).
 */
export function megabytes(n: number): string {
  const mb = n / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "220 of 315 MB": both in megabytes, the unit once. */
export function ofMegabytes(part: number, whole: number): string {
  return `${megabytes(part).replace(/ MB$/, '')} of ${megabytes(whole)}`;
}

/** The item's title (the Set-up sheet, Welcome's card). */
export const TOOLS_TITLE = 'Browser and render tools';

/** What each Tool is for, as the rows say it. */
export const TOOL_USE: Record<ToolView['id'], string> = { browser: 'captures', 'render-browser': 'renders', compositor: 'renders' };

/** The overall state's mark and word (a state word: the colour-only rule). */
export function toolsWord(s: ToolsView): { state: MarkState; word: string } {
  switch (s.state) {
    case 'ready':
      return { state: 'ok', word: 'Ready' };
    case 'downloading':
      return { state: 'running', word: downloadingWords(s) };
    case 'paused':
      return { state: 'attention', word: `Paused · ${ofMegabytes(s.received_bytes, s.total_bytes)} kept` };
    case 'offline':
      return { state: 'warn', word: 'Stopped: no connection' };
    case 'mismatch':
      return { state: 'fail', word: 'Failed: a file did not check' };
    case 'failed':
      return { state: 'fail', word: 'Failed: the download stopped' };
    case 'damaged':
      return { state: 'fail', word: 'Damaged: a Tool changed on disk' };
    case 'checkout':
      return { state: 'ok', word: 'Not needed: a checkout' };
    default:
      return { state: 'warn', word: 'Needed: not downloaded yet' };
  }
}

/** "about 1 min left", "less than a minute left"; null without an estimate. */
export function etaWords(eta: number | undefined): string | null {
  if (eta === undefined || !Number.isFinite(eta) || eta < 0) return null;
  if (eta < 60) return 'less than a minute left';
  const min = Math.round(eta / 60);
  return min >= 120 ? `about ${Math.round(min / 60)} h left` : `about ${min} min left`;
}

/** "Downloading · 220 of 315 MB · about 1 min left" (by another process: said). */
export function downloadingWords(s: ToolsView): string {
  const eta = etaWords(s.eta_s);
  const by = s.by && s.by.by === 'cli' ? ' · by retake tools install' : s.by && s.by.by === 'update' ? ' · for the update' : '';
  return `Downloading · ${ofMegabytes(s.received_bytes, s.total_bytes)}${eta ? ` · ${eta}` : ''}${by}`;
}

/** The whole percent of the download (0 – 100). */
export function toolsPercent(s: ToolsView): number {
  if (s.total_bytes <= 0) return 0;
  return Math.min(100, Math.floor((Math.min(s.received_bytes, s.total_bytes) * 100) / s.total_bytes));
}

/** The download's total for the button: the Tools not ready yet ("Download · 315 MB"). */
export function downloadLabel(s: ToolsView): string {
  return `Download · ${megabytes(s.total_bytes)}`;
}

/** The status bar's words, or null (nothing to say: ready, a checkout). */
export function toolsBarWords(s: ToolsView | null): { state: MarkState; text: string } | null {
  if (!s?.available) return null;
  switch (s.state) {
    case 'ready':
    case 'checkout':
      return null;
    case 'downloading':
      return { state: 'running', text: `Downloading tools · ${toolsPercent(s)} %` };
    case 'paused':
      return { state: 'attention', text: 'Tools: download paused' };
    case 'offline':
      return { state: 'warn', text: 'Tools: download stopped' };
    case 'mismatch':
    case 'failed':
      return { state: 'fail', text: 'Tools: download failed' };
    case 'damaged':
      return { state: 'fail', text: 'Tools: damaged' };
    default:
      return { state: 'warn', text: 'Tools needed: not downloaded yet' };
  }
}

/** One row's figure on the right: Checked, Next, Refused, the megabytes so far, or its size before any download. */
export function rowFigure(t: ToolView, overall: ToolsView['state']): { text: string; tone: 'ok' | 'fail' | 'plain' } {
  if (t.state === 'ready') return { text: 'Checked', tone: 'ok' };
  if (t.state === 'mismatch') return { text: 'Refused', tone: 'fail' };
  if (t.state === 'checking' || t.state === 'extracting') return { text: 'Checking', tone: 'plain' };
  if (t.state === 'waiting') return { text: 'Next', tone: 'plain' };
  if (t.received > 0) return { text: megabytes(t.received), tone: 'plain' };
  return { text: overall === 'needed' ? megabytes(t.bytes) : 'Next', tone: 'plain' };
}

/** A row's bar (0 – 100), or null before any download (the needed state shows the sizes instead). */
export function rowPercent(t: ToolView, overall: ToolsView['state']): number | null {
  if (overall === 'needed' || overall === 'ready' || overall === 'checkout') return null;
  if (t.state === 'ready') return 100;
  if (t.bytes <= 0) return 0;
  return Math.min(100, Math.floor((Math.min(t.received, t.bytes) * 100) / t.bytes));
}

/** A digest as the mismatch shows it: its first and last four characters. */
export function shortDigest(d: string | undefined): string {
  if (!d) return '—';
  return d.length > 12 ? `${d.slice(0, 4)}…${d.slice(-4)}` : d;
}

/** A URL without its scheme, cut after its folder (the mismatch's From). */
export function shortUrl(u: string): string {
  const s = u.replace(/^https:\/\//, '');
  const i = s.lastIndexOf('/');
  return i > 0 && s.length > 60 ? `${s.slice(0, i)}/…` : s;
}

/** The mismatch's sentence for the Tool refused (by its label): its archive (sha256), or its extracted files (tree digest). */
export function mismatchSentence(t: ToolView): string {
  if (t.mismatch === 'tree') {
    return `The ${t.label.toLowerCase()}'s files, once extracted, are not the ones this version of ${APP_NAME} expects (their tree digest differs). They were discarded: nothing was installed. Try again; if it fails again, install ${APP_NAME} again from its disk image, or tell us.`;
  }
  return `The ${t.label.toLowerCase()}'s file is not the one this version of ${APP_NAME} expects (sha256 differs). Nothing of it was kept or opened. Try again; if it fails again, the server sent another file: install ${APP_NAME} again from its disk image, or tell us.`;
}

/** What "Copy the details" copies: the Tool, the URL, the digests expected and received (the archive's or the tree's). */
export function mismatchDetails(t: ToolView): string {
  const what = t.mismatch === 'tree' ? 'tree digest' : 'sha256';
  return [`${t.label}: ${t.name} ${t.version}`, `From: ${t.url}`, `Expected ${what}: ${t.expected ?? '?'}`, `Received ${what}: ${t.got ?? '?'}`].join('\n');
}

/** The offline callout's sentence: what arrived is kept, where Resume goes on from. */
export function offlineSentence(s: ToolsView): string {
  return `What arrived is kept: Resume goes on from ${megabytes(s.received_bytes)}. ${APP_NAME} tried again for a while before it stopped.`;
}

/** The folder line: the Tools folder, and whether $RETAKE_HOME chose the home it is in. */
export function folderWords(s: ToolsView): string {
  return s.home_from_env ? `${s.folder} (the home RETAKE_HOME sets)` : s.folder;
}

/** Why this server cannot act on the Tools, or null (it can). */
export function cannotWords(s: ToolsView): string | null {
  switch (s.can) {
    case 'ok':
      return null;
    case 'location':
      return `Move ${APP_NAME} to Applications, then open it again: it downloads its Tools from there.`;
    case 'not_bundled':
      return `This ${APP_NAME} runs from a repository checkout: it uses Playwright's cache and node_modules.`;
    default:
      return `The ${APP_NAME} app downloads its Tools: open it, or run retake tools install in a terminal.`;
  }
}

/** The Tools a kind of work needs are not ready (a capture: the browser; a render, a still, a preview: the render tools). */
export function needsMissing(s: ToolsView | null, need: 'browser' | 'render'): boolean {
  if (!s?.available || s.state === 'ready') return false;
  const ids = need === 'browser' ? ['browser'] : ['render-browser', 'compositor'];
  return s.tools.some((t) => ids.includes(t.id) && t.state !== 'ready');
}

/** "the browser" / "the render tools". */
export const NEED_WORDS: Record<'browser' | 'render', string> = { browser: 'the browser', render: 'the render tools' };

/** A screen's "not downloaded yet" sentence for work that needs `need` (a preview, a still, a comment's frame). */
export function neededSentence(need: 'browser' | 'render', what: string): string {
  return `${what} needs ${NEED_WORDS[need]}, which ${APP_NAME} has not downloaded yet.`;
}

/** A queued job's sentence: it starts by itself once its Tools are here ("(38 %, about 1 min left)" while downloading). */
export function waitingSentence(s: ToolsView, need: 'browser' | 'render', what: string): string {
  const eta = etaWords(s.eta_s);
  const where =
    s.state === 'downloading'
      ? ` (${toolsPercent(s)} %${eta ? `, ${eta}` : ''})`
      : s.state === 'needed'
        ? ': download them first'
        : s.state === 'damaged'
          ? ' (one is damaged: download it again)'
          : ` (the download is ${s.state === 'paused' ? 'paused' : 'stopped'})`;
  return `${what} starts by itself once ${NEED_WORDS[need]} ${need === 'browser' ? 'is' : 'are'} downloaded and checked${where}. It waits in the queue meanwhile; it fails only if you cancel it.`;
}

/** "Older versions · 586 MB" (null: none). */
export function olderWords(s: ToolsView): string | null {
  if (s.older.folders.length === 0) return null;
  return `Older versions · ${megabytes(s.older.bytes)}`;
}

/** "Today 09:12, every file matches" — the last Check again (null: none this session). */
export function checkedWords(s: ToolsView, now = new Date()): string | null {
  const c = s.checked;
  if (!c) return null;
  const at = new Date(c.at);
  const day = at.toDateString() === now.toDateString() ? 'Today' : at.toLocaleDateString(undefined, { dateStyle: 'medium' });
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const bad = c.tools.filter((t) => t.state !== 'ready');
  return `${day} ${time}, ${bad.length === 0 ? 'every file matches' : `${bad.map((t) => t.id).join(', ')} did not match`}`;
}
