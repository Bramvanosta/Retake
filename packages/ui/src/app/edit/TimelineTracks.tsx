/**
 * The timeline's tracks (L4.5 part C, R-UI-23 / R-UI-24; L5.12a: on the kit's Track / TrackItem, R-UI-45): segments,
 * captions, steps, camera zooms, speed with its cuts, markers and comment pins, each a labelled row of buttons placed by
 * frame (a percentage of the video: the fit and the zoomed level are one layout at two widths). Every item carries its
 * words (kind, label, times) — a pattern or a weight only repeats them — and activating one seeks there. Text the scenario
 * or the filmed product wrote (captions, step labels, marker names, comment text) comes from the view's `untrusted` part
 * and is only ever a text node or a title. A comment pin seeks to its frame; its tip opens its thread on the Comments
 * screen (L4.6). A segment is also selected by its click (the inspector shows its switches; `aria-pressed` says which).
 * Memoised, and the playhead is not a prop: it is drawn by the screen over the lanes, so a playing preview (or a 1,200-step
 * take) re-renders none of this.
 */
import { memo } from 'react';
import type { TimelineView } from '@retake/engine';
import { Txt } from '../bits.js';
import { hrefTo } from '../route.js';
import { cutWords, landingOf, segmentWords, timecode } from '../words/timeline-words.js';
import { Track, TrackItem } from '../ui-kit/index.js';

type Model = TimelineView['model'];

/** The last part of a component id ("studio/layout-card" → "layout-card"). */
const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const SPEED = (s: number) => `${Number(s.toFixed(2))}×`;

export interface TracksProps {
  view: TimelineView;
  onSeek(frame: number): void;
  /** The segment the inspector shows (its id), or null. */
  selected: string | null;
  /** A segment clicked: select it and seek to its first frame. */
  onSelect(id: string, from: number): void;
  /** The project and scenario (L4.6: a pin's tip opens its thread on the Comments screen). */
  at?: { slug: string; scenario: string };
}

function TracksImpl({ view, onSeek, selected, onSelect, at: where }: TracksProps) {
  const m: Model = view.model;
  const u = view.untrusted;
  const fps = m.fps;
  const n = m.frames;
  const span = (from: number, to: number) => `${timecode(from, fps)} to ${timecode(to, fps)}`;
  const stepLabel = (key: string, action: string) => u.steps[key] ?? action;
  return (
    <div className="ed-track-rows" data-testid="tracks">
      <Track name="Segments" testId="track-segments" count={m.segments.length}>
        {m.segments.map((s) => {
          const comp = `${s.component.id}${s.component.missing ? ' (missing: its stand-in draws)' : ''}`;
          const into = s.transition ? `, ${s.transition.kind === 'cut' ? 'a cut' : `${s.transition.kind} of ${s.transition.frames} frames`} into it` : s.joined ? ', continues the previous scene' : '';
          const words = `${segmentWords(s)}, ${comp}${into}, ${span(s.from, s.to)}`;
          return (
            <TrackItem
              key={`${s.index}`}
              variant="segment"
              place={{ from: s.from, to: s.to }}
              frames={n}
              label={words}
              title={words}
              states={[s.kind, ...(s.component.missing ? ['missing'] : []), ...(s.joined ? ['joined'] : [])]}
              pressed={selected === s.id}
              {...(s.transition && s.transition.kind !== 'cut' ? { band: s.transition.frames / Math.max(1, s.to - s.from) } : {})}
              testId="tl-segment"
              data={{ id: s.id, from: s.from }}
              onActivate={() => onSelect(s.id, landingOf(s))}
            >
              <Txt text={s.kind === 'clip' ? s.id : segmentWords(s)} />
              <span className="ed-seg-comp">
                {' · '}
                <Txt text={shortId(s.component.id)} />
              </span>
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Captions" testId="track-captions" count={m.captions.length}>
        {m.captions.map((c) => {
          const text = u.captions[c.i] ? `${u.captions[c.i].kicker ? `${u.captions[c.i].kicker} — ` : ''}${u.captions[c.i].text}` : '';
          return (
            <TrackItem key={c.i} variant="caption" place={{ from: c.from, to: c.to }} frames={n} label={`Caption of scene ${c.scene}: ${text}, ${span(c.from, c.to)}`} title={text} testId="tl-caption" data={{ from: c.from }} onActivate={() => onSeek(c.from)}>
              <Txt text={text} />
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Steps" testId="track-steps" count={m.steps.length}>
        {m.steps.map((s, i) => {
          const label = s.step < 0 ? 'the page before its steps' : `step ${s.step + 1} ${stepLabel(s.key, s.action)}`;
          return (
            <TrackItem
              key={`${s.key}:${i}`}
              variant="step"
              place={{ from: s.from, to: s.to }}
              frames={n}
              label={`Scene ${s.scene}, ${label}, ${span(s.from, s.to)}`}
              title={label}
              {...(s.step < 0 ? { states: ['still'] } : {})}
              testId="tl-step"
              data={{ key: s.key, from: s.from }}
              onActivate={() => onSeek(s.from)}
            >
              <Txt text={s.step < 0 ? s.scene : String(s.step + 1)} />
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Camera" testId="track-camera" count={m.camera.length}>
        {m.camera.map((z, i) => {
          const words = `Zoom ${SPEED(z.zoom)} on step ${z.step + 1} of ${z.scene}${z.requested_zoom !== undefined && z.requested_zoom !== z.zoom ? ` (asked ${SPEED(z.requested_zoom)})` : ''}${z.source === 'theme' ? ', the theme’s' : ''}, ${span(z.from, z.to)}`;
          return (
            <TrackItem key={`${z.key}:${i}`} variant="camera" place={{ from: z.from, to: z.to }} frames={n} label={words} title={words} band={(z.in_to - z.from) / Math.max(1, z.to - z.from)} testId="tl-zoom" data={{ from: z.from }} onActivate={() => onSeek(z.from)}>
              <Txt text={SPEED(z.zoom)} />
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Speed" testId="track-speed" count={m.speed.length + m.cuts.length}>
        {m.speed.map((s, i) => {
          const held = s.speed === 0 && s.to_speed === 0;
          const words = held
            ? `The last frame of scene ${s.scene} held (under the transition), ${span(s.from, s.to)}`
            : `Speed ${SPEED(s.speed)}${s.to_speed !== s.speed ? ` to ${SPEED(s.to_speed)}` : ''} in scene ${s.scene}${s.protected ? ' (kept at its pace: a step that must read)' : ''}, ${span(s.from, s.to)}`;
          return (
            <TrackItem key={`s${i}`} variant="speed" place={{ from: s.from, to: s.to }} frames={n} label={words} title={words} {...(held ? { states: ['held'] } : s.speed !== 1 || s.to_speed !== 1 ? { states: ['fast'] } : {})} testId="tl-speed" data={{ from: s.from }} onActivate={() => onSeek(s.from)}>
              <Txt text={held ? 'held' : `${SPEED(s.speed)}${s.to_speed !== s.speed ? `→${SPEED(s.to_speed)}` : ''}`} />
            </TrackItem>
          );
        })}
        {m.cuts.map((c, i) => {
          const words = cutWords(c, fps);
          return (
            <TrackItem key={`c${i}`} variant="cut" place={{ at: c.at }} frames={n} label={words} title={words} states={[c.reason]} testId="tl-cut" data={{ at: c.at }} onActivate={() => onSeek(c.at)}>
              <span aria-hidden="true">✂</span>
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Markers" testId="track-markers" count={m.markers.length}>
        {m.markers.map((k) => {
          const name = u.markers[k.i] ?? '';
          const words = `Marker ${name} at ${timecode(k.frame, fps)}${k.done !== undefined ? `, done at ${timecode(k.done, fps)}` : ''}`;
          return (
            <TrackItem key={k.i} variant="marker" place={{ at: k.frame }} frames={n} label={words} title={words} testId="tl-marker" data={{ frame: k.frame }} onActivate={() => onSeek(k.frame)}>
              <span aria-hidden="true">◆</span>
            </TrackItem>
          );
        })}
      </Track>
      <Track name="Comments" testId="track-comments" count={view.pins.placed.length}>
        {view.pins.placed.map((p) => {
          const t = u.threads[p.id];
          const words = `Comment, ${p.status}, at ${timecode(p.frame, fps)}${t ? ` by ${t.author}: ${t.text}` : ''}`;
          return (
            <TrackItem
              key={p.id}
              variant="pin"
              place={{ at: p.frame }}
              frames={n}
              label={words}
              states={[p.status]}
              testId="tl-pin"
              data={{ id: p.id, frame: p.frame, status: p.status }}
              onActivate={() => onSeek(p.frame)}
              tip={
                <>
                  <span aria-hidden="true">
                    <Txt text={`${p.status} · ${timecode(p.frame, fps)}`} />
                    {t ? ' · ' : ''}
                    {t && <Txt text={t.author} />}
                  </span>
                  {t && (
                    <span aria-hidden="true">
                      <Txt text={t.text} />
                    </span>
                  )}
                  {where && (
                    <a href={hrefTo({ name: 'comments', slug: where.slug, scenario: where.scenario, thread: p.id })} data-testid="pin-open-thread" aria-label={`Open the thread of the comment at ${timecode(p.frame, fps)}`}>
                      Open thread
                    </a>
                  )}
                </>
              }
            >
              <span aria-hidden="true">{p.status === 'open' ? '●' : '○'}</span>
            </TrackItem>
          );
        })}
      </Track>
    </div>
  );
}

export const Tracks = memo(TracksImpl);
