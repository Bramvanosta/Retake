/**
 * L4.5 part C: the Studio op `timeline_view` (ops.ts timelineOps) over HTTP — the engine's view plus the preview's two
 * capability URLs on the player origin:
 * - ⚑ the answer is path-free and plan-free (critique B4): no `plan` / `folders` key, no absolute path (workspace, home),
 *   no `ds-asset:` name, no product URL; the frame and plan URLs hold one capability of the player origin, and the plan
 *   they name is served there (its capture under the same capability);
 * - a re-read of the same take answers the same URLs (the engine's memo); an edit of the file publishes a new plan URL
 *   on the same frame URL and keeps every media URL (critique B6: no reload of the capture);
 * - part D: the file's text beside the view while switches can be written (undo restores those bytes);
 * - pinned arguments (a path, an extra key → 400); no capture → 404; a take the trust gates refuse → `blocked` with
 *   the command, and no capability URL;
 * - L4.5 fixes: ⚑ a workspace component is held out of the frame's bundle until `preview_allow` (the hash shown, this
 *   session; no MCP tool reaches it — review A H1 c); ⚑ the project's preview URLs are revoked when the last page
 *   holding a lease leaves (`timeline_leave`), a re-read gets new ones (review A L3).
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldDir } from '@retake/components';
import { TOOLS } from '@retake/mcp';
import { UI_OPS, startStudioServer } from '../src/index.js';
import type { StudioServer, TimelineViewAnswer } from '../src/index.js';
import { FRAME_URL_RE, previewUrls } from '../src/app/words/timeline-words.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { hasTool } from '../../editor/test/render-helpers.js';
import { raw } from './http.js';
import { takeWorkspace, writeTake } from './timeline-take.js';

const canRun = hasTool('ffmpeg') && hasTool('ffprobe');
const RUN = '20260101-120000-tl';
const TEXT = `video: Timeline
title: {text: Timeline}
intro: false
outro: false
scenes:
  - id: a
    page: app
    open: /
    caption: Every frame has its own number.
    steps:
      - hold: 1
  - card: {slots: {title: Chapter two}}
    id: c1
`;
let ws: string;
let dir: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MARK = 'MARKED-COMPONENT-5e2b';
const LEASE_A = 'leaseAAAAAAAAAAAAAAAAA';
const LEASE_B = 'leaseBBBBBBBBBBBBBBBBB';

const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
type Ok = Extract<TimelineViewAnswer, { frame_url: string }>;
async function viewOf(args: Record<string, unknown>): Promise<Ok> {
  const r = await call('timeline_view', args);
  expect(r.status, r.body.slice(0, 300)).toBe(200);
  const d = r.json<{ data: TimelineViewAnswer }>().data;
  if (!('frame_url' in d)) throw new Error(`no preview: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-timeline-ops-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  dir = await takeWorkspace(ws);
  const t = synthTimeline({
    duration: 3,
    entries: [
      { id: 'a', t_start: 0.5, t_end: 2.5, caption: { text: 'Every frame has its own number.' }, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] },
      { card: { id: 'c1', slots: { title: 'Chapter two' } } },
    ],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, template: 'editorial' },
  });
  await writeTake(dir, 'tl', { run: RUN, text: TEXT, timeline: t, codec: 'h264-x264', seconds: 3 });
  // A scenario without a capture, and one whose card loads a remote URL (the trust gates refuse it).
  await writeFile(join(dir, 'scenarios', 'nocap.yaml'), TEXT);
  const outside = TEXT.replace('{slots: {title: Chapter two}}', '{slots: {title: Chapter two, kicker: "https://example.com/tracker.png"}}');
  await writeTake(dir, 'out', { run: '20260101-120000-out', text: TEXT, timeline: structuredClone(t), codec: 'h264-x264', seconds: 3 });
  await writeFile(join(dir, 'scenarios', 'out.yaml'), outside);
  // A take whose card is a workspace component (review A H1 c: held until the person allows it).
  const comp = join(ws, 'components', 'acme', 'marked');
  await mkdir(comp, { recursive: true });
  await cp(scaffoldDir('card'), comp, { recursive: true });
  await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, 'id: acme/marked'));
  await writeFile(join(comp, 'index.tsx'), `import { AbsoluteFill } from 'remotion';\nexport default function M() { return <AbsoluteFill>{${JSON.stringify(MARK)}}</AbsoluteFill>; }\n`);
  const wcText = TEXT.replace('{slots: {title: Chapter two}}', '{component: acme/marked, slots: {title: Chapter two}}');
  const wct = synthTimeline({
    duration: 3,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }, { card: { id: 'c1', component: 'acme/marked', slots: { title: 'Chapter two' } } }],
    video: { title: { text: 'Timeline' }, intro: false, outro: false, template: 'editorial' },
  });
  await writeTake(dir, 'wc', { run: '20260101-120000-wc', text: wcText, timeline: wct, codec: 'h264-x264', seconds: 3 });
  studio = await startStudioServer({ root: ws, startWorker: false });
}, 120_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe.skipIf(!canRun)('timeline_view', () => {
  it('⚑ the view and the preview URLs, never the plan, its folders or a path; the plan is served on the player origin', async () => {
    expect(UI_OPS).toContain('timeline_view');
    const r = await call('timeline_view', { project: 'demo', name: 'tl' });
    expect(r.status).toBe(200);
    const d = r.json<{ data: Ok }>().data;
    expect(d).toMatchObject({ project: 'demo', scenario: 'tl', run_id: RUN, theme: 'editorial', hash: sha(TEXT), editable: true, source: { edit: 'scenario' }, runs: [RUN] });
    expect(d.model.segments.map((s) => s.id)).toEqual(['a', 'c1']);
    expect(d.capture).toMatchObject({ codec: 'h264', b_frames: true });
    // Part D: the file's text while switches can be written (what undo restores), the bytes of `hash`.
    expect(d.text).toBe(TEXT);
    expect(sha(d.text!)).toBe(d.hash);
    // The URLs: one capability of the player origin; previewUrls (the page's check) takes them.
    expect(d.frame_url.startsWith(`${studio.player.origin}/s/`)).toBe(true);
    expect(FRAME_URL_RE.test(d.frame_url)).toBe(true);
    expect(previewUrls(d.frame_url, d.plan_url)).toEqual({ frame: d.frame_url, plan: d.plan_url });
    // ⚑ No plan, no folders, no path, no asset map, no product URL.
    for (const k of ['plan', 'folders', 'memo', 'assets']) expect(Object.prototype.hasOwnProperty.call(d, k), k).toBe(false);
    for (const needle of [ws, homedir(), dir, 'ds-asset:', 'http://app.test', 'capture.mp4', '"file"']) expect(r.body.includes(needle), needle).toBe(false);
    // The plan is served on the player origin, with its capture under the same capability.
    const cap = /\/s\/([A-Za-z0-9_-]{43})\/frame$/.exec(d.frame_url)![1];
    const planPath = d.plan_url.slice(studio.player.origin.length);
    const p = await raw(studio.player.port, 'GET', planPath);
    expect(p.status).toBe(200);
    const plan = p.json<{ durationInFrames: number; source: { url: string } }>();
    expect(plan.durationInFrames).toBe(d.model.frames);
    expect(plan.source.url.startsWith(`${studio.player.origin}/m/${cap}/`)).toBe(true);
    const media = await raw(studio.player.port, 'GET', plan.source.url.slice(studio.player.origin.length), { range: 'bytes=0-15' });
    expect(media.status).toBe(206);
    // Nothing logged with the capability: the op's summary holds none either.
    expect(r.json<{ summary: string }>().summary).not.toContain(cap);
  });

  it('a re-read answers the same URLs; an edit publishes a new plan on the same frame, every media URL kept', async () => {
    const a = await viewOf({ project: 'demo', name: 'tl' });
    const b = await viewOf({ project: 'demo', name: 'tl', run: RUN });
    expect(b.frame_url).toBe(a.frame_url);
    expect(b.plan_url).toBe(a.plan_url);
    const planA = (await raw(studio.player.port, 'GET', a.plan_url.slice(studio.player.origin.length))).json<{ source: { url: string } }>();
    // A layout switch written to the file: a new plan, the same frame, the same capture URL.
    const file = join(dir, 'scenarios', 'tl.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('    open: /\n', '    open: /\n    frame: laptop\n'));
    const c = await viewOf({ project: 'demo', name: 'tl' });
    expect(c.frame_url).toBe(a.frame_url);
    expect(c.plan_url).not.toBe(a.plan_url);
    expect(c.model.segments[0].component.id).toBe('studio/layout-laptop');
    const planC = (await raw(studio.player.port, 'GET', c.plan_url.slice(studio.player.origin.length))).json<{ source: { url: string } }>();
    expect(planC.source.url).toBe(planA.source.url);
    await writeFile(file, TEXT);
  });

  it('pinned arguments; no capture → 404; a take the trust gates refuse → blocked with the command, no URL', async () => {
    for (const bad of [
      { project: 'demo', name: '../tl' },
      { project: 'demo', name: 'tl', run: '../x' },
      { project: 'demo', name: 'tl', theme: 'editorial' },
      { project: '/tmp', name: 'tl' },
      { project: 'demo' },
    ]) {
      expect((await call('timeline_view', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const none = await call('timeline_view', { project: 'demo', name: 'nocap' });
    expect(none.status).toBe(404);
    expect(none.json<{ error: { message: string } }>().error.message).toBe('nocap has no capture yet: a capture films the take its timeline shows (Capture from the status bar or Shoot)');
    const out = await call('timeline_view', { project: 'demo', name: 'out' });
    expect(out.status).toBe(200);
    const d = out.json<{ data: Record<string, unknown> }>().data;
    expect(d).toMatchObject({ blocked: { problems: [expect.stringMatching(/is a remote URL/)], command: expect.stringMatching(/ render demo out/) } });
    expect(d.frame_url).toBeUndefined();
    expect(d.plan_url).toBeUndefined();
    expect(out.body).not.toContain(studio.player.origin);
  });

  it("⚑ review A H1 c: a workspace component is held — not in the frame's bundle — until the person allows it (by hash, this session)", async () => {
    const frameBundle = async (frameUrl: string) => {
      const doc = await raw(studio.player.port, 'GET', new URL(frameUrl).pathname);
      expect(doc.status).toBe(200);
      const src = /<script src="(\/s\/[A-Za-z0-9_-]{43}\/b\.[0-9a-f]{16}\.js)" defer>/.exec(doc.body)![1];
      return (await raw(studio.player.port, 'GET', src)).body;
    };
    const a = await viewOf({ project: 'demo', name: 'wc' });
    expect(a.preview_held).toEqual([{ id: 'acme/marked', kind: 'card', hash: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    const hash = a.preview_held![0].hash;
    // Its code is not in the bundle the frame gets (built-ins are).
    const before = await frameBundle(a.frame_url);
    expect(before).not.toContain(MARK);
    expect(before).toContain('"acme/marked"');
    // Refused: another hash (its folder changed since it was shown), a built-in, a malformed id or hash; an extra key.
    const stale = await call('preview_allow', { id: 'acme/marked', hash: '0123456789abcdef' });
    expect(stale.status).toBe(409);
    expect(stale.json<{ error: { message: string } }>().error.message).toBe(`acme/marked changed since the timeline showed it (its folder is now ${hash}): look at it again, then allow it`);
    expect((await call('preview_allow', { id: 'studio/card-title', hash })).status).toBe(404);
    for (const bad of [
      { id: '../x', hash },
      { id: 'acme/marked', hash: 'ABC' },
      { id: 'acme/marked', hash, project: 'demo' },
    ])
      expect((await call('preview_allow', bad)).status, JSON.stringify(bad)).toBe(400);
    expect(studio.previewAllow.size).toBe(0);
    // ⚑ No MCP tool and no engine call reaches the allow-list: the op is the Studio's own.
    expect(TOOLS.map((t) => t.name)).not.toContain('preview_allow');
    expect(TOOLS.map((t) => t.name)).not.toContain('timeline_leave');
    // Allowed at the hash shown: the view holds nothing back, the frame's next bundle has the component.
    const ok = await call('preview_allow', { id: 'acme/marked', hash });
    expect(ok.status, ok.body).toBe(200);
    expect(studio.previewAllow.has('acme/marked', hash)).toBe(true);
    const b = await viewOf({ project: 'demo', name: 'wc' });
    expect(b.preview_held).toBeUndefined();
    expect(await frameBundle(b.frame_url)).toContain(MARK);
  }, 180_000);

  it("⚑ review A L3: the project's preview URLs live while a page holds a lease; the last one leaving revokes them, a re-read gets new ones", async () => {
    const plain = async (u: string) => (await raw(studio.player.port, 'GET', new URL(u).pathname, { range: 'bytes=0-15' })).status;
    const a = await viewOf({ project: 'demo', name: 'tl', lease: LEASE_A });
    const media = (await raw(studio.player.port, 'GET', new URL(a.plan_url).pathname)).json<{ source: { url: string } }>().source.url;
    for (const u of [a.frame_url, a.plan_url]) expect(await plain(u)).toBe(200);
    expect(await plain(media)).toBe(206);
    // A second page on the same project: the first one leaving keeps the URLs.
    await viewOf({ project: 'demo', name: 'tl', lease: LEASE_B });
    const left = await call('timeline_leave', { project: 'demo', lease: LEASE_A });
    expect(left.json<{ data: { revoked: boolean } }>().data.revoked).toBe(false);
    expect(await plain(a.frame_url)).toBe(200);
    // The last one leaving: frame, plan and media answer 404.
    const last = await call('timeline_leave', { project: 'demo', lease: LEASE_B });
    expect(last.json<{ data: { revoked: boolean } }>().data.revoked).toBe(true);
    for (const u of [a.frame_url, a.plan_url, media]) expect(await plain(u), u).toBe(404);
    // A page reading the view again gets a new capability, and it serves.
    const c = await viewOf({ project: 'demo', name: 'tl', lease: LEASE_A });
    expect(c.frame_url).not.toBe(a.frame_url);
    expect(await plain(c.frame_url)).toBe(200);
    expect(await plain(c.plan_url)).toBe(200);
    for (const bad of [{ project: 'demo', lease: 'short' }, { project: 'demo' }, { project: '../x', lease: LEASE_A }])
      expect((await call('timeline_leave', bad)).status, JSON.stringify(bad)).toBe(400);
    await call('timeline_leave', { project: 'demo', lease: LEASE_A });
  });
});
