/** Where the timeline screen opens (a step, a proposal's pin, the report's Show in Edit), its keys and the zoomed scroll. */
import { useEffect, useRef, useState } from 'react';
import { commentKey } from '../words/comment-words.js';
import { takeEditSeek } from './edit-handoff.js';
import type { EditSeek } from './edit-handoff.js';
import type { useRenders } from '../review/Renders.js';
import { versionNote, versionWords } from '../words/render-words.js';
import { hrefTo } from '../route.js';
import { keyAction, landingOf, targetFrame } from '../words/timeline-words.js';
import type { KeyTarget } from '../words/timeline-words.js';
import type { PreviewedProposal, PreviewState, Ready } from './timeline-preview.js';

function keyTarget(t: EventTarget | null): KeyTarget {
  const el = t instanceof Element ? t : null;
  return {
    tag: el?.tagName ?? 'body',
    ...(el instanceof HTMLInputElement ? { type: el.type } : {}),
    ...(el instanceof HTMLElement && el.isContentEditable ? { editable: true } : {}),
    ...(el?.closest('[role="radiogroup"]') ? { inRadioGroup: true } : {}),
  };
}

/**
 * Where the screen opens: a step's first frame (Show in timeline), a proposal's comment pin, or the Review report's
 * Show in Edit; each once. Returns the note said when that render was made from another version, or null.
 */
export function useArrivalSeek({
  slug,
  name,
  v,
  step,
  proposal,
  renders,
  shownVersion,
  seek,
}: {
  slug: string;
  name: string;
  v: Ready;
  step: string | undefined;
  proposal: PreviewedProposal | undefined;
  renders: ReturnType<typeof useRenders>;
  shownVersion: Parameters<typeof versionNote>[1];
  seek: (to: number) => void;
}): string | null {
  const m = v.model;
  // Show in timeline (a step of the scenario screen): its first frame, once.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!step || shown.current === step) return;
    shown.current = step;
    const first = m.steps.filter((s) => s.key === step).sort((a, b) => a.from - b.from)[0];
    if (first) seek(first.from);
  }, [step, m.steps, seek]);

  // Preview change: the proposal's comment pin, once (where the change was asked).
  const pinned = useRef(false);
  useEffect(() => {
    if (!proposal || pinned.current) return;
    const pin = v.pins.placed.find((p) => p.id === proposal.comment_id);
    if (!pin) return;
    pinned.current = true;
    seek(pin.frame);
  }, [proposal, v.pins.placed, seek]);

  // The Review report's Show in Edit — the finding's frame only when its render shows this version (the same plan
  // and theme files: its frame f is the preview's frame f); else its step. The note "made from
  // another version" only when the render is found AND differs — a finding with no frame on this version (the video's
  // length) goes to its step or stays, saying nothing; a render no longer listed goes to the step, no frame trusted.
  const [handoff] = useState<EditSeek | null>(() => (proposal ? null : takeEditSeek(slug, name)));
  const handled = useRef(false);
  const [seekNote, setSeekNote] = useState<string | null>(null);
  useEffect(() => {
    if (!handoff || handled.current || renders.loaded.state !== 'ready') return;
    handled.current = true;
    const r = renders.loaded.data.renders.find((x) => x.render_id === handoff.render_id);
    const differs = r !== undefined && !versionNote(r, shownVersion).same;
    if (r && !differs && handoff.frame !== undefined) {
      seek(handoff.frame);
      return;
    }
    const first = handoff.step ? m.steps.filter((s) => s.key === handoff.step).sort((a, b) => a.from - b.from)[0] : undefined;
    if (first) seek(first.from);
    if (differs)
      setSeekNote(`${versionWords(handoff.render_id)} was made from another version of the edit: its frame is not this preview's${first ? ', so the preview shows the step it points at' : ''}.`);
  }, [handoff, renders.loaded, shownVersion, m.steps, seek]);
  return seekNote;
}

/** The screen's keys: C comments the playhead's frame, the transport and segment keys (timeline-words keyAction). */
export function useTimelineKeys({
  slug,
  name,
  m,
  commentOn,
  frameRef,
  toggle,
  seek,
  setSelected,
}: {
  slug: string;
  name: string;
  m: Ready['model'];
  commentOn: string | null;
  frameRef: PreviewState['frameRef'];
  toggle: () => void;
  seek: (to: number) => void;
  setSelected: (id: string) => void;
}) {
  const commentRef = useRef<string | null>(null);
  commentRef.current = commentOn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control handled the key (the transport's toolbar roves with the arrows, Home and End): its own.
      if (e.defaultPrevented) return;
      // C: comment the frame at the playhead on the render of this version (when there is one).
      if (commentKey(e, keyTarget(e.target))) {
        if (commentRef.current === null) return;
        e.preventDefault();
        location.hash = hrefTo({ name: 'comments', slug, scenario: name, at: { render: commentRef.current, frame: frameRef.current } });
        return;
      }
      const a = keyAction(e, keyTarget(e.target));
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'toggle') return toggle();
      const to = targetFrame(a, frameRef.current, m);
      seek(to);
      // [ / ]: the segment the playhead lands on is the inspector's.
      if (a.kind === 'segment') {
        const at = m.segments.filter((s) => landingOf(s) === to).at(-1);
        if (at) setSelected(at.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, m, slug, name, frameRef, setSelected]);
}

/** The zoomed level: the playhead stays on screen while playing (an instant scroll). */
export function useFollowPlayhead(scroller: PreviewState['scroller'], zoom: 'fit' | 'zoom', playing: boolean, frame: number, frames: number) {
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom !== 'zoom' || !playing) return;
    const labelW = el.querySelector<HTMLElement>('.k-track-label')?.offsetWidth ?? 96;
    const lane = el.scrollWidth - labelW;
    const x = labelW + (frame / Math.max(1, frames)) * lane;
    if (x < el.scrollLeft + labelW || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, x - labelW - 40);
  }, [frame, zoom, playing, frames, scroller]);
}
