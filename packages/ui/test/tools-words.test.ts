/**
 * The Tools' words (words/tools-words.ts) and the update's Tools step (shell/update.ts): every state's mark and word
 * (a state word beside every mark), the button's download total, the status bar's percent, the rows' figures, the
 * mismatch's digests, the queued job's sentence, a home set by RETAKE_HOME; the update's preparing state, its figure,
 * its step and the tools failure.
 */
import { describe, expect, it } from 'vitest';
import { megabytes as coreMegabytes } from '@retake/core/base';
import {
  cannotWords,
  downloadLabel,
  downloadingWords,
  etaWords,
  folderWords,
  megabytes,
  mismatchDetails,
  mismatchSentence,
  needsMissing,
  rowFigure,
  rowPercent,
  shortDigest,
  toolsBarWords,
  toolsPercent,
  toolsWord,
  waitingSentence,
} from '../src/app/words/tools-words.js';
import type { ToolView, ToolsView } from '../src/app/words/tools-words.js';
import { badgeWords, failureWords, installSteps, progressWords, toolsFigure } from '../src/app/shell/update.js';
import type { UpdateStatus } from '../src/app/shell/update.js';

const tool = (id: ToolView['id'], o: Partial<ToolView> = {}): ToolView => ({
  id,
  label: id === 'browser' ? 'Browser' : id === 'render-browser' ? 'Render browser' : 'Compositor',
  name: 'Fixture',
  version: '1.0.0',
  publisher: 'Fixture publisher',
  licence: 'Fixture licence',
  url: `https://storage.googleapis.com/x/${id}.zip`,
  bytes: 100_000_000,
  disk: 200_000_000,
  folder: `/h/tools/${id}`,
  state: 'missing',
  received: 0,
  licences: [],
  ...o,
});
const status = (o: Partial<ToolsView> = {}): ToolsView => ({
  available: true,
  state: 'needed',
  folder: '/h/tools',
  home_from_env: false,
  total_bytes: 315_000_000,
  received_bytes: 0,
  tools: [tool('render-browser'), tool('compositor'), tool('browser')],
  older: { folders: [], bytes: 0 },
  can: 'ok',
  running: false,
  checking: false,
  ...o,
});

describe("the Tools' words", () => {
  it('every state has a mark and a state word; the button says the download total', () => {
    const words = (['needed', 'downloading', 'paused', 'offline', 'mismatch', 'failed', 'damaged', 'ready', 'checkout'] as const).map((s) =>
      toolsWord(status({ state: s, received_bytes: 120_000_000 })),
    );
    expect(words.map((w) => w.word.split(/[ :·]/)[0])).toEqual(['Needed', 'Downloading', 'Paused', 'Stopped', 'Failed', 'Failed', 'Damaged', 'Ready', 'Not']);
    expect(words.map((w) => w.state)).toEqual(['warn', 'running', 'attention', 'warn', 'fail', 'fail', 'fail', 'ok', 'ok']);
    expect(downloadLabel(status())).toBe('Download · 315 MB');
    expect(downloadingWords(status({ state: 'downloading', received_bytes: 220_000_000, eta_s: 65 }))).toBe('Downloading · 220 of 315 MB · about 1 min left');
    expect(downloadingWords(status({ state: 'downloading', received_bytes: 5_000_000, by: { by: 'cli', pid: 1, version: '0.0.1' } }))).toBe('Downloading · 5.0 of 315 MB · by retake tools install');
    expect([etaWords(undefined), etaWords(30), etaWords(150), etaWords(7300)]).toEqual([null, 'less than a minute left', 'about 3 min left', 'about 2 h left']);
  });

  it('the status bar: the percent while it downloads, a stop, a failure, nothing once ready or in a checkout', () => {
    const s = status({ state: 'downloading', received_bytes: 120_000_000 });
    expect(toolsPercent(s)).toBe(38);
    expect(toolsBarWords(s)).toEqual({ state: 'running', text: 'Downloading tools · 38 %' });
    expect(toolsBarWords(status({ state: 'offline' }))?.text).toBe('Tools: download stopped');
    expect(toolsBarWords(status({ state: 'mismatch' }))?.text).toBe('Tools: download failed');
    expect(toolsBarWords(status({ state: 'needed' }))?.text).toBe('Tools needed: not downloaded yet');
    expect(toolsBarWords(status({ state: 'ready' }))).toBeNull();
    expect(toolsBarWords(status({ available: false, state: 'checkout' }))).toBeNull();
    expect(toolsBarWords(null)).toBeNull();
  });

  it('the rows: sizes before a download, then Checked / Next / the megabytes / Refused; a bar from the first byte', () => {
    expect(rowFigure(tool('browser'), 'needed')).toEqual({ text: '100 MB', tone: 'plain' });
    expect(rowPercent(tool('browser'), 'needed')).toBeNull();
    expect(rowFigure(tool('browser', { state: 'ready' }), 'downloading').text).toBe('Checked');
    expect(rowFigure(tool('browser', { state: 'waiting' }), 'downloading').text).toBe('Next');
    expect(rowFigure(tool('browser', { state: 'paused', received: 41_000_000 }), 'offline').text).toBe('41 MB');
    expect(rowPercent(tool('browser', { state: 'paused', received: 41_000_000 }), 'offline')).toBe(41);
    expect(rowFigure(tool('browser', { state: 'mismatch' }), 'mismatch')).toEqual({ text: 'Refused', tone: 'fail' });
  });

  it("megabytes: the CLI's and the installer's rule (core), decimal — the button's 315 MB is retake tools' 315 MB", () => {
    for (const n of [0, 999_999, 8_389_003, 10_000_000, 315_358_794, 2_000_000_000]) expect(megabytes(n), String(n)).toBe(coreMegabytes(n));
    expect(megabytes(315_358_794)).toBe('315 MB');
  });

  it('the mismatch: both digests short on screen, whole in what Copy copies, with the URL', () => {
    const t = tool('browser', { state: 'mismatch', expected: `9f2c${'0'.repeat(56)}41ab`, got: `03de${'1'.repeat(56)}77c0` });
    expect([shortDigest(t.expected), shortDigest(t.got)]).toEqual(['9f2c…41ab', '03de…77c0']);
    const d = mismatchDetails(t);
    expect(d).toContain(`Expected sha256: ${t.expected}`);
    expect(d).toContain(`Received sha256: ${t.got}`);
    expect(d).toContain(`From: ${t.url}`);
    // The extracted tree's digest: its own words (the archive was opened; its files were discarded).
    const tree = { ...t, mismatch: 'tree' as const };
    expect(mismatchSentence(tree)).toMatch(/^The browser's files, once extracted, are not the ones this version of Retake expects \(their tree digest differs\)\. They were discarded/);
    expect(mismatchSentence(t)).toMatch(/sha256 differs\)\. Nothing of it was kept or opened/);
    expect(mismatchDetails(tree)).toContain(`Expected tree digest: ${t.expected}`);
  });

  it('a queued job waits for what it needs; the folder says RETAKE_HOME chose its home; why a server cannot act', () => {
    const s = status({ state: 'downloading', received_bytes: 120_000_000, eta_s: 60 });
    expect(needsMissing(s, 'browser')).toBe(true);
    expect(needsMissing(status({ tools: [tool('render-browser', { state: 'ready' }), tool('compositor', { state: 'ready' }), tool('browser')] }), 'render')).toBe(false);
    expect(needsMissing(status({ state: 'ready' }), 'browser')).toBe(false);
    expect(waitingSentence(s, 'browser', 'This capture')).toBe(
      'This capture starts by itself once the browser is downloaded and checked (38 %, about 1 min left). It waits in the queue meanwhile; it fails only if you cancel it.',
    );
    expect(waitingSentence(status({ state: 'damaged' }), 'render', 'This render')).toBe(
      'This render starts by itself once the render tools are downloaded and checked (one is damaged: download it again). It waits in the queue meanwhile; it fails only if you cancel it.',
    );
    expect(waitingSentence(status({ state: 'paused' }), 'browser', 'This capture')).toContain('(the download is paused)');
    expect(folderWords(status({ home_from_env: true }))).toBe('/h/tools (the home RETAKE_HOME sets)');
    expect(cannotWords(status())).toBeNull();
    expect(cannotWords(status({ can: 'location' }))).toMatch(/^Move Retake to Applications/);
  });
});

describe("the update's Tools step", () => {
  const prep = (o: Partial<UpdateStatus> = {}): UpdateStatus => ({ available: true, state: 'preparing', current: '0.3.0', version: '0.4.0', ...o });
  it('preparing: the badge, the progress, the figure and the step under way (third)', () => {
    const t = {
      version: '0.4.0',
      state: 'preparing' as const,
      total: 200_000_000,
      received: 50_000_000,
      tools: [{ id: 'browser' as const, label: 'Browser', name: 'X', version: '1', bytes: 200_000_000, here: false }],
    };
    expect(badgeWords(prep({ tools: t }))).toBe('Downloading the Tools for v0.4.0 · 25 %');
    expect(toolsFigure(prep({ tools: t }))).toEqual({ percent: 25, text: '50 MB of 200 MB · 25 %' });
    expect(toolsFigure(prep({ tools: { ...t, total: 0, received: 0 } }))?.text).toBe('Tools: up to date');
    expect(progressWords(prep())?.title).toBe('Downloading the Tools for v0.4.0');
    const steps = installSteps(prep({ tools: t }))!;
    expect(steps.map((x) => [x.id, x.state])).toEqual([
      ['download', 'done'],
      ['signature', 'done'],
      ['tools', 'running'],
      ['jobs', 'next'],
      ['install', 'next'],
    ]);
    expect(steps[2]!.label).toBe('Download the Tools it needs · 200 MB');
  });
  it('the tools failure: its words, its step marked, the badge', () => {
    const f = prep({ state: 'failed', failure: 'tools', retry: true, untrusted: { tools: 'the update archive changed since it was verified' } });
    expect(failureWords('tools', '0.3.0')).toBe('The Tools the update needs could not be downloaded and checked: nothing was installed, Retake 0.3.0 was kept.');
    expect(progressWords(f)?.text).toContain('(the update archive changed since it was verified)');
    expect(installSteps(f)!.map((x) => x.state)).toEqual(['done', 'done', 'failed', 'next', 'next']);
    expect(badgeWords(f)).toBe('Update v0.4.0: its Tools did not download');
  });
});
