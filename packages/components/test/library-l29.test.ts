/**
 * L2.9 library: notifications, mails, documents, phone cards and the tap-open transition. Their tap targets (manifest
 * `anchor`, evaluated by the planner) match where they draw; they render captured media (`props.media`) and fall back
 * to scenario values; pure helpers (page selection, badge count, notification groups, mail dates).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LIBRARY_DIR, applyParamDefaults, evalAnchor, paramEnums, parseManifest } from '@retake/components';
import type { ComponentManifest, ComponentProps, LayoutRects, MediaValue } from '@retake/components';
import { NOTIFICATION_STYLES, layoutNotification, notificationBox, phoneCardGeometry } from '../src/kit/index.js';
import { DARK, LIGHT } from './helpers.js';

const frame = vi.hoisted(() => ({ current: 0 }));
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return { ...actual, useCurrentFrame: () => frame.current, Img: (props: Record<string, unknown>) => h('img', props) };
});

const IDS = ['notification', 'mail-notification', 'mail-view', 'document-pdf', 'phone-lockscreen', 'phone-home-badge', 'transition-tap-open'].map((n) => `studio/${n}`);
const dirOf = (id: string) => join(LIBRARY_DIR, ...id.split('/'));
const manifests: Record<string, ComponentManifest> = {};
const modules: Record<string, Record<string, unknown>> = {};
type Variant = 'landscape' | 'vertical' | 'square';
const SIZES: Record<Variant, [number, number]> = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] };

beforeAll(async () => {
  for (const id of IDS) {
    manifests[id] = parseManifest(readFileSync(join(dirOf(id), 'component.yaml'), 'utf8'), 'component.yaml', { folderId: id }).manifest!;
    modules[id] = (await import(join(dirOf(id), 'index.tsx'))) as Record<string, unknown>;
  }
});

function render(id: string, opts: { params?: Record<string, unknown>; slots?: Record<string, string>; media?: Record<string, MediaValue>; at?: number; variant?: Variant; extra?: Partial<ComponentProps> } = {}): string {
  const m = manifests[id];
  const variant = opts.variant ?? 'landscape';
  frame.current = opts.at ?? 60;
  const props: ComponentProps = {
    theme: LIGHT,
    slots: { ...(opts.slots ?? {}) },
    params: applyParamDefaults(m.params as never, opts.params ?? {}),
    unit: 1,
    width: SIZES[variant][0],
    height: SIZES[variant][1],
    fps: 30,
    durationInFrames: Math.round((m.duration?.default ?? 4) * 30),
    variant,
    ...(opts.media ? { media: opts.media } : {}),
    ...opts.extra,
  };
  return renderToString(createElement(modules[id].default as ComponentType<ComponentProps>, props));
}

const EMAIL: MediaValue = { kind: 'email', name: 'welcome', from: 'hello@northfield.example', from_name: 'Northfield', to: ['noa@cafe-lumen.example'], subject: 'Confirm your email', date: '2026-10-12T09:41:00.000Z', preview: 'Welcome aboard.', image: { url: 'http://a/email.png', width: 1200, height: 3000 } };
const DOC: MediaValue = { kind: 'document', name: 'quote', file_name: 'Quote.pdf', pages: [1, 2, 3].map((n) => ({ url: `http://a/p${n}.png`, width: 1587, height: 2245, width_pt: 595.28, height_pt: 841.89, number: n })) };
const NOTE: MediaValue = { kind: 'notification', name: 'quote-request', title: 'New quote request', body: 'Café Lumen asks for 3 bags', app: 'console.example', time: '2026-10-12T09:41:00.000Z', icon: { url: 'http://a/icon.png', width: 192, height: 192 } };

describe('tap targets (manifest anchor) match the drawing', () => {
  const screen: LayoutRects = { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, radius: 18 };
  it('notification / mail-notification: every style, place and format', () => {
    for (const id of ['studio/notification', 'studio/mail-notification']) {
      const m = manifests[id];
      for (const style of NOTIFICATION_STYLES) {
        for (const place of ['auto', 'frame', 'screen'] as const) {
          for (const variant of ['landscape', 'vertical', 'square'] as const) {
            const [w, h] = SIZES[variant];
            const rects = variant === 'landscape' ? screen : { screen: { x: 40, y: 200, w: w - 80, h: h - 600 }, frame: { x: 40, y: 200, w: w - 80, h: h - 600 }, radius: 18 };
            const content = id === 'studio/notification'
              ? { title: 'New quote request', body: 'Café Lumen asks for 10 × 5 kg of Selowa Ridge, delivered in January.', app: 'Atelier' }
              : { title: 'Northfield Roasters', subtitle: 'Confirm your email address', body: 'Welcome to Northfield! One click and your café account is ready.', app: 'Mail' };
            const layout = layoutNotification(style, content, LIGHT, 1);
            const box = notificationBox(layout, place, w, h, rects);
            const a = evalAnchor(m.anchor!, { style, place }, { enums: paramEnums(m.params), frame: { w, h }, screen: rects.screen });
            const where = `${id} ${style} ${place} ${variant}`;
            expect(a.x, where).toBeCloseTo(box.x, 0);
            expect(a.w, where).toBeCloseTo(box.w, 0);
            expect(Math.abs(a.y - box.y), where).toBeLessThanOrEqual(style === 'windows' ? 40 : 0.5);
            expect(Math.abs(a.h - box.h), where).toBeLessThanOrEqual(40);
          }
        }
      }
    }
  });

  it('phone cards: the newest lock-screen notification and the app icon', () => {
    for (const variant of ['landscape', 'vertical', 'square'] as const) {
      const [w, h] = SIZES[variant];
      for (const layout of ['center', 'left'] as const) {
        const g = phoneCardGeometry({ width: w, height: h, unit: 1, displayHeight: 880, layout, withText: true });
        const lm = manifests['studio/phone-lockscreen'];
        const a = evalAnchor(lm.anchor!, applyParamDefaults(lm.params as never, { layout }), { enums: paramEnums(lm.params), frame: { w, h } });
        expect(a.x, `${variant} ${layout}`).toBeCloseTo(g.display.x + Math.round(g.display.w * 0.04), 0);
        expect(a.y, `${variant} ${layout}`).toBeCloseTo(g.display.y + Math.round(g.display.h * 0.4), 0);
        const hm = manifests['studio/phone-home-badge'];
        const b = evalAnchor(hm.anchor!, applyParamDefaults(hm.params as never, { layout, row: 2, col: 3 }), { enums: paramEnums(hm.params), frame: { w, h } });
        const s = g.display.w * 0.155;
        const m = g.display.w * 0.075;
        const cg = (g.display.w - 2 * m - 4 * s) / 3;
        expect(b.x).toBeCloseTo(g.display.x + m + 3 * (s + cg), 1);
        expect(b.y).toBeCloseTo(g.display.y + g.display.h * 0.085 + 2 * (s + g.display.h * 0.052), 1);
        expect(b.w).toBeCloseTo(s, 1);
        // The lock screen draws its first card where the anchor says (left offset in the display).
        const html = render('studio/phone-lockscreen', { params: { layout, notifications: [{ app: 'Atelier', title: 'Hello', body: 'World' }], start: 0 }, variant, at: 60 });
        expect(html, `${variant} ${layout}`).toContain(`left:${g.display.w * 0.04}px;top:${Math.round(g.display.h * 0.4)}px`);
      }
    }
  });
});

describe('media and scenario values', () => {
  it('notification: the captured notification, scenario values winning', () => {
    const html = render('studio/notification', { media: { notification: NOTE }, at: 40 });
    expect(html).toContain('New quote request');
    expect(html).toContain('Café Lumen asks for 3 bags');
    expect(html).toContain('http://a/icon.png');
    const own = render('studio/notification', { media: { notification: NOTE }, slots: { title: 'Mine' }, at: 40 });
    expect(own).toContain('Mine');
    expect(own).not.toContain('New quote request');
  });

  it('mail-notification: sender, subject, preview from the email', () => {
    const html = render('studio/mail-notification', { media: { email: EMAIL }, at: 40 });
    for (const t of ['Northfield', 'Confirm your email', 'Welcome aboard.']) expect(html).toContain(t);
  });

  it('mail-view: the rendered email shows its top by default, scrolls with scroll: auto; text fallback without an image', () => {
    const early = render('studio/mail-view', { media: { email: EMAIL }, params: { scroll: 'auto' }, at: 10 });
    const late = render('studio/mail-view', { media: { email: EMAIL }, params: { scroll: 'auto' }, at: 150 });
    expect(early).toContain('http://a/email.png');
    expect(early).toContain('Confirm your email');
    const top = (h: string) => Number(/src="http:\/\/a\/email.png"[^>]*top:(-?[\d.]+)px/.exec(h)?.[1] ?? /top:(-?[\d.]+)px[^>]*src="http:\/\/a\/email.png"/.exec(h)?.[1]);
    expect(top(late)).toBeLessThan(top(early));
    // R-FLD-04 (L5.5): no scroll by default.
    const byDefault = render('studio/mail-view', { media: { email: EMAIL }, at: 150 });
    expect(top(byDefault)).toBe(top(early));
    const none = render('studio/mail-view', { media: { email: EMAIL }, params: { scroll: 'none' }, at: 150 });
    expect(top(none)).toBe(top(early));
    const text = render('studio/mail-view', { slots: { from: 'Ana', subject: 'Hi there', body: 'Plain words.' } });
    expect(text).toContain('Plain words.');
    expect(text).not.toContain('<img');
  });

  it('document-pdf: page selection per motion, a neutral sheet without a document', async () => {
    const { selectPages } = modules['studio/document-pdf'] as { selectPages: (s: string, n: number, m: string) => number[] };
    expect(selectPages('auto', 3, 'zoom')).toEqual([1]);
    expect(selectPages('auto', 3, 'scroll')).toEqual([1, 2, 3]);
    expect(selectPages('2-3', 3, 'static')).toEqual([2, 3]);
    expect(selectPages('3,1,9', 3, 'static')).toEqual([3, 1]);
    expect(selectPages('x', 3, 'static')).toEqual([1]);
    const scroll = render('studio/document-pdf', { media: { document: DOC }, params: { motion: 'scroll' } });
    for (const n of [1, 2, 3]) expect(scroll).toContain(`http://a/p${n}.png`);
    const spread = render('studio/document-pdf', { media: { document: DOC }, params: { motion: 'static', pages: '1-2' } });
    expect(spread).toContain('http://a/p2.png');
    expect(spread).not.toContain('http://a/p3.png');
    expect(render('studio/document-pdf')).not.toContain('<img');
  });

  it('phone-lockscreen: notifications arrive one by one, grouped by app; the captured email arrives last', () => {
    const { groupsAfter } = modules['studio/phone-lockscreen'] as { groupsAfter: (items: Array<{ app: string }>, k: number) => Array<{ app: string; items: number[] }> };
    const items = [{ app: 'A' }, { app: 'Mail' }, { app: 'A' }];
    expect(groupsAfter(items, 1)).toEqual([{ app: 'A', items: [0] }]);
    expect(groupsAfter(items, 2)).toEqual([{ app: 'Mail', items: [1] }, { app: 'A', items: [0] }]);
    expect(groupsAfter(items, 3)).toEqual([{ app: 'A', items: [0, 2] }, { app: 'Mail', items: [1] }]);
    const params = { notifications: [{ app: 'Atelier', title: 'First one', body: 'x' }], start: 0.5, interval: 1 };
    expect(render('studio/phone-lockscreen', { params, at: 5 })).not.toContain('First one');
    expect(render('studio/phone-lockscreen', { params, at: 30 })).toContain('First one');
    const withMail = render('studio/phone-lockscreen', { params, media: { email: EMAIL }, at: 30 });
    expect(withMail).not.toContain('Confirm your email');
    expect(render('studio/phone-lockscreen', { params, media: { email: EMAIL }, at: 70 })).toContain('Confirm your email');
  });

  it('phone-home-badge: the badge counts from → to, one step per interval', () => {
    const { badgeCount } = modules['studio/phone-home-badge'] as { badgeCount: (t: number, p: Record<string, number>) => { count: number } };
    const p = { from: 0, to: 3, start: 1, interval: 0.5 };
    expect([0, 1, 1.4, 1.5, 2, 9].map((t) => badgeCount(t, p).count)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(render('studio/phone-home-badge', { params: { from: 0, to: 3 }, at: 0 })).not.toMatch(/>\d<\/div>/);
    expect(render('studio/phone-home-badge', { params: { from: 0, to: 3 }, at: 90 })).toMatch(/>3<\/div>/);
    expect(render('studio/phone-home-badge', { slots: { app: 'Northfield' } })).toContain('Northfield');
  });

  it('tap-open: the entering box grows from the anchor to the full frame', () => {
    const anchor = { x: 1470, y: 20, w: 430, h: 110 };
    const at = (f: number) => render('studio/transition-tap-open', { at: f, extra: { direction: 'entering', anchor, screen: createElement('i', { id: 's' }) } });
    expect(at(1)).not.toContain('<i id="s">');
    const mid = at(12);
    const end = at(23);
    const box = (h: string) => /left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px/.exec(h)!.slice(1).map(Number);
    const [, , w1] = box(mid);
    const [x2, y2, w2] = box(end);
    expect(w1).toBeGreaterThan(anchor.w);
    expect(w2).toBeGreaterThan(w1);
    expect(x2).toBeLessThan(anchor.x);
    expect(y2).toBeLessThan(20);
    expect(render('studio/transition-tap-open', { at: 3, extra: { direction: 'exiting', anchor, screen: createElement('i', { id: 's' }) } })).toContain('border-radius:50%');
  });

  it('render in dark themes and every format', () => {
    frame.current = 20;
    for (const id of IDS) for (const variant of ['landscape', 'vertical', 'square'] as const) {
      const html = renderToString(createElement(modules[id].default as ComponentType<ComponentProps>, { theme: DARK, direction: 'exiting', screen: createElement('i'), slots: {}, params: applyParamDefaults(manifests[id].params as never, {}), unit: 1, width: SIZES[variant][0], height: SIZES[variant][1], fps: 30, durationInFrames: 120, variant, media: { email: EMAIL, document: DOC, notification: NOTE } } as ComponentProps));
      expect(html.length, `${id} ${variant}`).toBeGreaterThan(100);
    }
  });
});

describe('mail-view mailbox label (L5.6, R-FLD-15)', () => {
  it('a mail waited for in a persona\'s mailbox labels the mailbox after it; the `mailbox` slot wins; else "Inbox"', () => {
    expect(render('studio/mail-view', { media: { email: { ...EMAIL, persona: 'buyer' } }, at: 40 })).toContain('Inbox · Buyer');
    expect(render('studio/mail-view', { media: { email: { ...EMAIL, persona: 'head-roaster' } }, at: 40 })).toContain('Inbox · Head roaster');
    expect(render('studio/mail-view', { media: { email: { ...EMAIL, persona: 'buyer' } }, slots: { mailbox: 'Orders' }, at: 40 })).toContain('Orders');
    const plain = render('studio/mail-view', { media: { email: EMAIL }, at: 40 });
    expect(plain).toContain('Inbox');
    expect(plain).not.toContain('Inbox ·');
  });
});
