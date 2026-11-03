/**
 * L2.9 planner: artefact slots (`email`, `document`, `notification`) resolved into `media` with ds-asset images, a
 * notification overlay placed when the notification showed, overlays cut by the clip end keeping their own length,
 * transitions as components on scenes and cards, and the tap target (`anchor`) a transition opens from — on the real
 * signup / quote timelines of the fixture (runs 20261012-015003-signup, 20261012-015606-quote) with the built-in
 * library.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry, DocumentMedia, EmailMedia, NotificationMedia } from '@retake/components';
import { PLAN_ASSET_SCHEME, planEdit } from '@retake/editor';
import type { CardSegment, ClipSegment, EditPlan } from '@retake/editor';
import type { Timeline } from '@retake/core';
import { FIXTURES, REPO, fixtureProject, template } from './helpers.js';

const RUN = '/virtual/runs/r';
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
let registry: ComponentRegistry;

async function plan(timeline: Timeline, overrides = {}): Promise<EditPlan> {
  return planEdit({ timeline, template: await template('editorial'), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4`, overrides });
}
const card = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as CardSegment;
const clipOf = (p: EditPlan, id: string) => p.segments.find((s) => s.id === id) as ClipSegment;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('artefact slots → media', () => {
  it('a captured email feeds the mail-view card and the mail-notification overlay, its image a plan asset', async () => {
    const p = await plan(load('signup'));
    const inbox = card(p, 'inbox');
    expect(inbox.component.id).toBe('studio/mail-view');
    const e = inbox.component.media?.email as EmailMedia;
    expect(e).toMatchObject({ kind: 'email', name: 'welcome', from: 'hello@northfield.example', from_name: 'Northfield', to: ['noa@cafe-lumen.example'] });
    expect(e.subject).toMatch(/^Confirm your email/);
    expect(e.image?.url).toBe(`${PLAN_ASSET_SCHEME}artefact-email-welcome.png`);
    expect(p.assets[e.image!.url]).toBe(`${RUN}/artefacts/emails/welcome.png`);
    const overlay = clipOf(p, 'signup').overlays[0];
    expect(overlay.component.id).toBe('studio/mail-notification');
    expect((overlay.component.media?.email as EmailMedia).name).toBe('welcome');
    expect(card(p, 'lockscreen').component.media?.email?.kind).toBe('email');
    expect(p.warnings).toEqual([]);
  });

  it('the persona a mail was waited for in (to: persona:<name>, L5.6) reaches the mail card', async () => {
    const tl = load('signup');
    for (const a of tl.artefacts ?? []) if (a.kind === 'email') a.persona = 'buyer';
    const e = card(await plan(tl), 'inbox').component.media?.email as EmailMedia;
    expect(e.persona).toBe('buyer');
    expect((card(await plan(load('signup')), 'inbox').component.media?.email as EmailMedia).persona).toBeUndefined();
  });

  it('a downloaded PDF feeds the document card page by page', async () => {
    const p = await plan(load('quote-artefacts'));
    const d = card(p, 'quote-pdf').component.media?.document as DocumentMedia;
    expect(d).toMatchObject({ kind: 'document', name: 'quote' });
    expect(d.file_name).toMatch(/^Northfield_Quote_Q-\d+\.pdf$/);
    expect(d.pages).toHaveLength(1);
    expect(d.pages[0]).toMatchObject({ number: 1, url: `${PLAN_ASSET_SCHEME}artefact-document-quote-p1.png` });
    expect(d.pages[0].width / d.pages[0].height).toBeCloseTo(595.28 / 841.89, 2);
    expect(p.assets[d.pages[0].url]).toBe(`${RUN}/artefacts/documents/quote/page-1.png`);
  });

  it('a captured web notification feeds the overlay, which shows when the notification showed', async () => {
    const tl = load('quote-artefacts');
    const p = await plan(tl);
    const request = clipOf(p, 'request');
    const o = request.overlays.find((x) => x.component.id === 'studio/notification')!;
    const n = o.component.media?.notification as NotificationMedia;
    // The app names the page's host as the video shows it (L1.7): a local host without a display URL never shows —
    // the theme's brand name instead; with the run's display table, the display host.
    expect(n).toMatchObject({ kind: 'notification', name: 'quote-request', title: 'New quote request', app: 'Atelier' });
    const displayed = await plan({ ...tl, environment: { name: 'local', access: 'read-write', display: [{ page: 'console', url: 'http://localhost:4401', display: 'https://console.northfield.example' }] } });
    const n2 = clipOf(displayed, 'request').overlays.find((x) => x.component.id === 'studio/notification')!.component.media?.notification as NotificationMedia;
    expect(n2.app).toBe('console.northfield.example');
    expect(n.icon?.url).toBe(`${PLAN_ASSET_SCHEME}artefact-notification-quote-request-icon.png`);
    expect(o.component.slots.app).toBe('Northfield console');
    // It starts at the notification's capture time (mapped to output), not at the end of its step (the hold).
    const shown = tl.artefacts!.find((a) => a.kind === 'notification')!.t;
    const hold = tl.events.find((e) => e.scene === 'request' && e.action === 'hold')!;
    const srcAt = (k: number) => request.srcFrames[k] / tl.capture.fps;
    expect(srcAt(o.from)).toBeCloseTo(shown, 0);
    expect(srcAt(o.from)).toBeLessThan(hold.t_end);
    expect(p.notes.join('\n')).toMatch(/starts when notification "quote-request" showed/);
  });

  it('notification events are not step provenance', async () => {
    const p = await plan(load('quote-artefacts'));
    for (const c of p.segments.filter((s): s is ClipSegment => s.kind === 'clip')) expect(c.steps.every((s) => s.action !== 'notification')).toBe(true);
  });

  it('an unknown artefact is a warning; the component keeps its scenario values', async () => {
    const tl = load('signup');
    const scenes = tl.scenes.map((s) => (s.id === 'inbox' ? { ...s, card: { ...s.card, slots: { email: 'nope', subject: 'Hello' } } } : s));
    const p = await plan({ ...tl, scenes });
    expect(card(p, 'inbox').component.media).toBeUndefined();
    expect(card(p, 'inbox').component.slots.subject).toBe('Hello');
    expect(p.warnings.join('\n')).toMatch(/card "inbox": email "nope" was not captured by run 20261012-015003-signup \(captured: welcome\)/);
  });

  it('notifications are found by index too', async () => {
    const tl = load('quote-artefacts');
    const events = tl.events.map((e) => (e.overlay?.component === 'studio/notification' ? { ...e, overlay: { ...e.overlay, slots: { notification: '1' } } } : e));
    const p = await plan({ ...tl, events });
    const o = clipOf(p, 'request').overlays.find((x) => x.component.id === 'studio/notification')!;
    expect(o.component.media?.notification?.name).toBe('quote-request');
  });
});

describe('overlays cut by the clip end, transitions as components, anchors', () => {
  it('a cut overlay keeps its own length (no exit animation before the cut)', async () => {
    const p = await plan(load('signup'));
    const o = clipOf(p, 'signup').overlays[0];
    expect(o.componentFrames).toBe(Math.round(4.5 * p.fps));
    expect(o.from + o.durationInFrames).toBe(clipOf(p, 'signup').durationInFrames);
  });

  it('scene and card transitions name components; tap-open opens from the outgoing tap target', async () => {
    const p = await plan(load('signup'));
    const inbox = card(p, 'inbox');
    expect(inbox.transition?.component?.id).toBe('studio/transition-tap-open');
    expect(inbox.transition?.kind).toBe('crossfade');
    expect(inbox.transition?.frames).toBe(Math.round(0.8 * p.fps));
    // From the macOS mail notification still showing at the end of the clip: top right of the frame.
    expect(inbox.transition?.anchor).toEqual({ x: 1920 - 20 - 430, y: 20, w: 430, h: 113 });
    // Into the welcome clip from the home screen's app icon (row 1, col 2; phone left of the text).
    const welcome = clipOf(p, 'welcome');
    expect(welcome.transition?.component?.id).toBe('studio/transition-tap-open');
    const a = welcome.transition!.anchor!;
    expect(a.w).toBeCloseTo(Math.round(880 * 0.462) * 0.155, 1);
    expect(a.x).toBeGreaterThan(300);
    expect(a.x + a.w).toBeLessThan(900);
    expect(a.y).toBeGreaterThan(80);
  });

  it('anchors follow the output format (vertical: the frame is 1080 × 1920)', async () => {
    const p = await plan(load('signup'), { variant: 'vertical' });
    const a = card(p, 'inbox').transition!.anchor!;
    expect(a).toEqual({ x: 1080 - 20 - 430, y: 20, w: 430, h: 113 });
  });
});
