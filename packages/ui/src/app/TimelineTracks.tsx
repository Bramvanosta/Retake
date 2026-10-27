/**
 * The timeline's tracks (L4.5 part C, R-UI-23 / R-UI-24): segments, captions, steps, camera zooms, speed with its cuts,
 * markers and comment pins, each a labelled row of buttons placed by frame (a percentage of the video: the fit and the
 * zoomed level are one layout at two widths). Every item carries its words (kind, label, times) — colour and pattern
 * only repeat them — and activating one seeks there. Text the scenario or the filmed product wrote (captions, step
 * labels, marker names, comment text) comes from the view's `untrusted` part and is only ever a text node or a title.
 * A comment pin seeks to its frame; its tooltip opens its thread on the Comments screen (L4.6). A segment is also selected by its click (part D: the
 * inspector shows its switches; `aria-pressed` says which). Memoised: the playhead is drawn by the screen, so a playing
 * preview re-renders none of this.
 */
import { memo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { TimelineView } from '@demo-studio/engine';
import { Txt, plural } from './bits.js';
import { hrefTo } from './route.js';
import { cutWords, landingOf, segmentWords, timecode } from './timeline-words.js';

type Model = TimelineView['model'];

/** Left and width of a span of frames, as percentages of the video. */
function place(from: number, to: number, frames: number): CSSProperties {
  const n = Math.max(1, frames);
  const a = Math.min(Math.max(0, from), n);
  const b = Math.min(Math.max(a, to), n);
  return { left: `${(a / n) * 100}%`, width: `${((b - a) / n) * 100}%` };
}
const at = (frame: number, frames: number): CSSProperties => ({ left: `${(Math.min(Math.max(0, frame), frames) / Math.max(1, frames)) * 100}%` });

/** The last part of a component id ("studio/layout-card" → "layout-card"). */
const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const SPEED = (s: number) => `${Number(s.toFixed(2))}×`;

function Row({ name, testId, count, children }: { name: string; testId: string; count: number; children: ReactNode }) {
  return (
    <div className="tl-row" role="group" aria-label={`${name}: ${plural(count, 'item')}`} data-testid={testId}>
      <span className="tl-label" aria-hidden="true">
        {name}
      </span>
      <ul className="tl-lane">{children}</ul>
    </div>
  );
}

export interface TracksProps {
  view: TimelineView;
  onSeek(frame: number): void;
  /** The segment the inspector shows (its id), or null. */
  selected: string | null;
  /** A segment clicked: select it and seek to its first frame. */
  onSelect(id: string, from: number): void;
  /** The project and scenario (L4.6: a pin's tooltip opens its thread on the Comments screen). */
  at?: { slug: string; scenario: string };
}

function TracksImpl({ view, onSeek, selected, onSelect, at: where }: TracksProps) {
  const m: Model = view.model;
  const u = view.untrusted;
  const fps = m.fps;
  const span = (from: number, to: number) => `${timecode(from, fps)} to ${timecode(to, fps)}`;
  const stepLabel = (key: string, action: string) => u.steps[key] ?? action;
  return (
    <div className="tl-tracks" data-testid="tracks">
      <Row name="Segments" testId="track-segments" count={m.segments.length}>
        {m.segments.map((s) => {
          const comp = `${s.component.id}${s.component.missing ? ' (missing: its stand-in draws)' : ''}`;
          const into = s.transition ? `, ${s.transition.kind === 'cut' ? 'a cut' : `${s.transition.kind} of ${s.transition.frames} frames`} into it` : s.joined ? ', continues the previous scene' : '';
          const words = `${segmentWords(s)}, ${comp}${into}, ${span(s.from, s.to)}`;
          return (
            <li key={`${s.index}`} className={`tl-item tl-seg tl-seg-${s.kind}${s.component.missing ? ' is-missing' : ''}${s.joined ? ' is-joined' : ''}${selected === s.id ? ' is-selected' : ''}`} style={place(s.from, s.to, m.frames)}>
              <button type="button" data-testid="tl-segment" data-id={s.id} data-from={s.from} aria-label={words} aria-pressed={selected === s.id} title={words} onClick={() => onSelect(s.id, landingOf(s))}>
                <span className="tl-seg-name">
                  <Txt text={s.kind === 'clip' ? s.id : segmentWords(s)} />
                </span>
                <span className="tl-seg-comp">
                  <Txt text={shortId(s.component.id)} />
                </span>
              </button>
              {s.transition && s.transition.kind !== 'cut' && <span className="tl-trans" aria-hidden="true" style={{ width: `${(s.transition.frames / Math.max(1, s.to - s.from)) * 100}%` }} />}
            </li>
          );
        })}
      </Row>
      <Row name="Captions" testId="track-captions" count={m.captions.length}>
        {m.captions.map((c) => {
          const text = u.captions[c.i] ? `${u.captions[c.i].kicker ? `${u.captions[c.i].kicker} — ` : ''}${u.captions[c.i].text}` : '';
          return (
            <li key={c.i} className="tl-item tl-caption" style={place(c.from, c.to, m.frames)}>
              <button type="button" data-testid="tl-caption" data-from={c.from} aria-label={`Caption of scene ${c.scene}: ${text}, ${span(c.from, c.to)}`} title={text} onClick={() => onSeek(c.from)}>
                <Txt text={text} />
              </button>
            </li>
          );
        })}
      </Row>
      <Row name="Steps" testId="track-steps" count={m.steps.length}>
        {m.steps.map((s, i) => {
          const label = s.step < 0 ? 'the page before its steps' : `step ${s.step + 1} ${stepLabel(s.key, s.action)}`;
          return (
            <li key={`${s.key}:${i}`} className={`tl-item tl-step${s.step < 0 ? ' is-still' : ''}`} style={place(s.from, s.to, m.frames)}>
              <button type="button" data-testid="tl-step" data-key={s.key} data-from={s.from} aria-label={`Scene ${s.scene}, ${label}, ${span(s.from, s.to)}`} title={label} onClick={() => onSeek(s.from)}>
                <Txt text={s.step < 0 ? s.scene : String(s.step + 1)} />
              </button>
            </li>
          );
        })}
      </Row>
      <Row name="Camera" testId="track-camera" count={m.camera.length}>
        {m.camera.map((z, i) => {
          const words = `Zoom ${SPEED(z.zoom)} on step ${z.step + 1} of ${z.scene}${z.requested_zoom !== undefined && z.requested_zoom !== z.zoom ? ` (asked ${SPEED(z.requested_zoom)})` : ''}${z.source === 'theme' ? ', the theme’s' : ''}, ${span(z.from, z.to)}`;
          return (
            <li key={`${z.key}:${i}`} className="tl-item tl-cam" style={place(z.from, z.to, m.frames)}>
              <button type="button" data-testid="tl-zoom" data-from={z.from} aria-label={words} title={words} onClick={() => onSeek(z.from)}>
                <span className="tl-ramp" style={{ width: `${((z.in_to - z.from) / Math.max(1, z.to - z.from)) * 100}%` }} aria-hidden="true" />
                {SPEED(z.zoom)}
              </button>
            </li>
          );
        })}
      </Row>
      <Row name="Speed" testId="track-speed" count={m.speed.length + m.cuts.length}>
        {m.speed.map((s, i) => {
          const held = s.speed === 0 && s.to_speed === 0;
          const words = held
            ? `The last frame of scene ${s.scene} held (under the transition), ${span(s.from, s.to)}`
            : `Speed ${SPEED(s.speed)}${s.to_speed !== s.speed ? ` to ${SPEED(s.to_speed)}` : ''} in scene ${s.scene}${s.protected ? ' (kept at its pace: a step that must read)' : ''}, ${span(s.from, s.to)}`;
          return (
            <li key={`s${i}`} className={`tl-item tl-speed${held ? ' is-held' : s.speed !== 1 || s.to_speed !== 1 ? ' is-fast' : ''}`} style={place(s.from, s.to, m.frames)}>
              <button type="button" data-testid="tl-speed" data-from={s.from} aria-label={words} title={words} onClick={() => onSeek(s.from)}>
                {held ? 'held' : SPEED(s.speed)}
                {!held && s.to_speed !== s.speed ? `→${SPEED(s.to_speed)}` : ''}
              </button>
            </li>
          );
        })}
        {m.cuts.map((c, i) => {
          const words = cutWords(c, fps);
          return (
            <li key={`c${i}`} className={`tl-tick tl-cut tl-cut-${c.reason}`} style={at(c.at, m.frames)}>
              <button type="button" data-testid="tl-cut" data-at={c.at} aria-label={words} title={words} onClick={() => onSeek(c.at)}>
                <span aria-hidden="true">✂</span>
              </button>
            </li>
          );
        })}
      </Row>
      <Row name="Markers" testId="track-markers" count={m.markers.length}>
        {m.markers.map((k) => {
          const name = u.markers[k.i] ?? '';
          const words = `Marker ${name} at ${timecode(k.frame, fps)}${k.done !== undefined ? `, done at ${timecode(k.done, fps)}` : ''}`;
          return (
            <li key={k.i} className="tl-tick tl-marker" style={at(k.frame, m.frames)}>
              <button type="button" data-testid="tl-marker" data-frame={k.frame} aria-label={words} title={words} onClick={() => onSeek(k.frame)}>
                <span aria-hidden="true">◆</span>
              </button>
            </li>
          );
        })}
      </Row>
      <Row name="Comments" testId="track-comments" count={view.pins.placed.length}>
        {view.pins.placed.map((p) => {
          const t = u.threads[p.id];
          const words = `Comment, ${p.status}, at ${timecode(p.frame, fps)}${t ? ` by ${t.author}: ${t.text}` : ''}`;
          return (
            <li key={p.id} className={`tl-tick tl-pin is-${p.status}`} style={at(p.frame, m.frames)}>
              <button type="button" data-testid="tl-pin" data-id={p.id} data-frame={p.frame} data-status={p.status} aria-label={words} onClick={() => onSeek(p.frame)}>
                <span aria-hidden="true">{p.status === 'open' ? '●' : '○'}</span>
              </button>
              <span className="tl-tip">
                <span className="tl-tip-head" aria-hidden="true">
                  {p.status} · {timecode(p.frame, fps)}
                  {t ? ' · ' : ''}
                  {t && <Txt text={t.author} />}
                </span>
                {t && (
                  <span aria-hidden="true">
                    <Txt text={t.text} />
                  </span>
                )}
                {where && (
                  <a className="tl-tip-link" href={hrefTo({ name: 'comments', slug: where.slug, scenario: where.scenario, thread: p.id })} data-testid="pin-open-thread" aria-label={`Open the thread of the comment at ${timecode(p.frame, fps)}`}>
                    Open thread
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </Row>
    </div>
  );
}

export const Tracks = memo(TracksImpl);
