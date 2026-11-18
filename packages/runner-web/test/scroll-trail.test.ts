/**
 * The recorder's scroll trail (kit/record-script.ts scrollTrail): a scroll baseline is where a container was before the
 * input's time stamp, not where it is when the listener runs. A passive wheel listener runs after the compositor
 * scrolled, so that read lost a wheel scroll from rest. The browser half is record-session.test.ts ("a wheel scroll
 * from rest is the person's …").
 */
import { describe, expect, it } from 'vitest';
import { scrollTrail } from '../src/kit/record-script.js';

type Listener = (e: { target: object; timeStamp: number }) => void;

function page() {
  let listener: Listener = () => undefined;
  const win = { addEventListener: (type: string, fn: Listener) => type === 'scroll' && (listener = fn) };
  const docEl = { scrollLeft: 0, scrollTop: 0 };
  const doc = { scrollingElement: docEl, documentElement: docEl };
  const trail = scrollTrail(win as never, doc as never);
  const scroll = (target: object, c: { scrollLeft: number; scrollTop: number }, y: number, t: number) => {
    c.scrollTop = y;
    listener({ target: target === doc ? doc : target, timeStamp: t });
  };
  return { trail, doc, docEl, scroll };
}

describe("the recorder's scroll trail", () => {
  it('⚑ the baseline of an input is the position before its time stamp, even once the page has scrolled', () => {
    const { trail, doc, docEl, scroll } = page();
    // The wheel at t=100; the compositor scrolled the document at t=115, before the wheel's listener ran.
    scroll(doc, docEl, 900, 115);
    expect(trail.before(doc as never, 100)).toEqual({ x: 0, y: 0 });
    // A later input starts from where the page was left.
    expect(trail.before(doc as never, 200)).toEqual({ x: 0, y: 900 });
    scroll(doc, docEl, 0, 250);
    expect(trail.before(doc as never, 240)).toEqual({ x: 0, y: 900 });
    expect(trail.before(doc as never, 260)).toEqual({ x: 0, y: 0 });
  });

  it('an element is followed on its own; one no scroll event moved is at its origin', () => {
    const { trail, doc, docEl, scroll } = page();
    const list = { scrollLeft: 0, scrollTop: 0 };
    expect(trail.before(list as never, 50)).toEqual({ x: 0, y: 0 });
    scroll(list, list, 300, 60);
    scroll(doc, docEl, 40, 70);
    expect(trail.before(list as never, 80)).toEqual({ x: 0, y: 300 });
    expect(trail.before(doc as never, 65)).toEqual({ x: 0, y: 0 });
  });
});
