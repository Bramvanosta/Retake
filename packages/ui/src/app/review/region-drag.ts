/**
 * The region drag on the viewer's frame: a drag draws a region (pointer capture; Esc cancels and the region before it
 * stays; a click makes none; a cancelled pointer cancels like Esc). The frame element holds the handlers.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FrameAnswer } from '../data/ops.js';
import { pointIn, regionOfDrag } from '../words/comment-words.js';
import type { Region } from '../words/comment-words.js';

/** The drag's state and the frame's pointer handlers; `draft` is the region being drawn (null when none). */
export function useRegionDrag({ drawing, image, region, setRegion }: { drawing: boolean; image: FrameAnswer | null; region: Region | null; setRegion: (r: Region | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: { x: number; y: number }; before: Region | null } | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);
  const [dragging, setDragging] = useState(false);
  // Esc cancels a drag (the region before it stays).
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      const el = box.current;
      if (el?.hasPointerCapture(drag.current.id)) el.releasePointerCapture(drag.current.id);
      drag.current = null;
      setDraft(null);
      setDragging(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  const rect = () => box.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing || !image || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, from: pointIn(rect(), e.clientX, e.clientY), before: region };
    setDraft(null);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setDraft(regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY)));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    setDraft(null);
    // A click (no drag) makes no region: the one before stays.
    const r = regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY));
    if (r) setRegion(r);
  };
  // A cancelled pointer (a system gesture took it, the capture was lost) cancels like Esc: the region before it stays.
  const onCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDraft(null);
    setDragging(false);
  };
  return { box, draft, onDown, onMove, onUp, onCancel };
}
