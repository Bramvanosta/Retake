/** The preview's state, the seek loop, the transport and the frame's messages (the timeline screen's hooks). */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TimelineViewAnswer } from '../../server/ops.js';
import type { PreviewConnection } from '../../player/parent.js';
import type { FrameMessage } from '../../player/protocol.js';
import type { FrameNote } from './EditNotes.js';
import { canPlay } from '../words/timeline-words.js';
import type { CodecProbe } from '../words/timeline-words.js';

export type Ready = Extract<TimelineViewAnswer, { run_id: string; model: unknown }>;
/** Frame notes kept (warnings and errors the frame posted). */
const NOTES_MAX = 20;

/** What the browser can say about a codec (no element made: MediaSource, else Media Capabilities). */
function codecProbe(): CodecProbe {
  // Typed by what is read: either constructor may be missing (ManagedMediaSource is Safari's only).
  const w: { MediaSource?: { isTypeSupported?(t: string): boolean }; ManagedMediaSource?: { isTypeSupported?(t: string): boolean } } = window;
  const ms = w.MediaSource ?? w.ManagedMediaSource;
  const mc = navigator.mediaCapabilities;
  return {
    ...(ms?.isTypeSupported ? { isTypeSupported: (t: string) => ms.isTypeSupported!(t) } : {}),
    ...(mc ? { decodingInfo: (cfg: Parameters<NonNullable<CodecProbe['decodingInfo']>>[0]) => mc.decodingInfo(cfg) } : {}),
  };
}

/** The proposal a timeline previews (the thread and the reply holding it). */
export interface PreviewedProposal {
  comment_id: string;
  entry_id: string;
}

/** The preview's state and the refs the seek loop and the frame's messages read. */
export function usePreviewState() {
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  /** The frame whose `settled` the loading state waits for ('any': after a pause), or null. */
  const [waiting, setWaiting] = useState<number | 'any' | null>(0);
  const waitingRef = useRef<number | 'any' | null>(0);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [muted, setMuted] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [rate, setRate] = useState<0.5 | 1 | 2>(1);
  const [missing, setMissing] = useState<string[]>([]);
  const [notes, setNotes] = useState<FrameNote[]>([]);
  const [stopped, setStopped] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const [zoom, setZoom] = useState<'fit' | 'zoom'>('fit');
  const [playable, setPlayable] = useState<boolean | null>(null);
  const conn = useRef<PreviewConnection | null>(null);
  /** The sound the person asked for: a new load remounts the Player muted, so an unmuted preview is unmuted again. */
  const wantSound = useRef(false);
  const pending = useRef<number | null>(null);
  const raf = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  return {
    frame,
    setFrame,
    frameRef,
    waiting,
    setWaiting,
    waitingRef,
    playing,
    setPlaying,
    playingRef,
    muted,
    setMuted,
    buffering,
    setBuffering,
    rate,
    setRate,
    missing,
    setMissing,
    notes,
    setNotes,
    stopped,
    setStopped,
    restart,
    setRestart,
    zoom,
    setZoom,
    playable,
    setPlayable,
    conn,
    wantSound,
    pending,
    raf,
    scroller,
  };
}
export type PreviewState = ReturnType<typeof usePreviewState>;

/** The seek loop and the transport: show and wait, the codec probe, seek (one per animation frame), play, pause. */
export function usePlayback(p: PreviewState, v: Ready, last: number) {
  const { setFrame, frameRef, setWaiting, waitingRef, playingRef, setPlayable, conn, pending, raf } = p;
  const m = v.model;
  // Stable (refs and setters only): the callbacks below keep their identity.
  const wait = useCallback(
    (w: number | 'any' | null) => {
      waitingRef.current = w;
      setWaiting(w);
    },
    [waitingRef, setWaiting],
  );
  const show = useCallback(
    (f: number) => {
      frameRef.current = f;
      setFrame(f);
    },
    [frameRef, setFrame],
  );

  // The capture's codec: a browser that cannot play it gets the message, no frame.
  useEffect(() => {
    let live = true;
    setPlayable(null);
    void canPlay(v.capture.codec, codecProbe(), { width: m.width, height: m.height, fps: m.fps }).then((ok) => live && setPlayable(ok));
    return () => {
      live = false;
    };
  }, [v.capture.codec, m.width, m.height, m.fps, setPlayable]);

  // A shorter plan (a switch, a file changed): the playhead stays inside it.
  useEffect(() => {
    if (frameRef.current > last) show(last);
  }, [last, show, frameRef]);

  const flush = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const f = pending.current;
    pending.current = null;
    if (f !== null) conn.current?.send({ type: 'seek', frame: f });
  }, [raf, pending, conn]);

  const seek = useCallback(
    (to: number) => {
      const f = Math.min(last, Math.max(0, Math.round(to)));
      show(f);
      // A seek pauses the preview and shows that exact frame once settled.
      if (conn.current?.connected) wait(f);
      pending.current = f;
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    },
    [last, flush, show, wait, conn, pending, raf],
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), [raf]);

  const play = useCallback(() => {
    const c = conn.current;
    if (!c?.connected) return;
    // A seek still waiting for its animation frame goes first (it pauses: after the play, it would stop it).
    flush();
    if (frameRef.current >= last) {
      show(0);
      c.send({ type: 'seek', frame: 0 });
    }
    wait(null);
    c.send({ type: 'play' });
  }, [last, flush, show, wait, conn, frameRef]);
  const pause = useCallback(() => {
    const c = conn.current;
    if (!c?.connected) return;
    flush();
    wait('any');
    c.send({ type: 'pause' });
  }, [flush, wait, conn]);
  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [play, pause, playingRef]);
  return { wait, show, seek, toggle };
}

/** The frame's messages and the connection's life (a hello, a stop, a new plan loading into the same frame). */
export function useFrameHandlers(p: PreviewState, wait: (w: number | 'any' | null) => void, show: (f: number) => void, plan: string | undefined) {
  const { frameRef, waitingRef, setPlaying, playingRef, setMuted, setBuffering, setMissing, setNotes, setStopped, conn, wantSound } = p;
  const onMessage = useCallback(
    (msg: FrameMessage) => {
      switch (msg.type) {
        case 'loaded':
          if (wantSound.current) conn.current?.send({ type: 'mute', muted: false });
          setMissing(msg.missing);
          if (msg.warnings.length) setNotes((n) => [...n, ...msg.warnings.map((message) => ({ type: 'warning' as const, message }))].slice(-NOTES_MAX));
          return;
        case 'frame':
          if (playingRef.current || waitingRef.current === 'any') show(msg.frame);
          return;
        case 'settled': {
          const w = waitingRef.current;
          if (w === 'any') show(msg.frame);
          if (w === 'any' || w === msg.frame) wait(null);
          return;
        }
        case 'state':
          playingRef.current = msg.playing;
          setPlaying(msg.playing);
          setBuffering(msg.buffering);
          setMuted(msg.muted);
          return;
        case 'ended':
          playingRef.current = false;
          setPlaying(false);
          return;
        case 'warning':
        case 'error':
          setNotes((n) => [...n, { type: msg.type, message: msg.message }].slice(-NOTES_MAX));
          return;
      }
    },
    [show, wait, wantSound, conn, setMissing, setNotes, playingRef, waitingRef, setPlaying, setBuffering, setMuted],
  );
  const onHello = useCallback(() => {
    // A load is on its way (PreviewFrame sent it): loading until the frame asked is settled.
    setMissing([]);
    playingRef.current = false;
    setPlaying(false);
    wait(frameRef.current);
  }, [wait, setMissing, playingRef, setPlaying, frameRef]);
  const onStop = useCallback(
    (reason: string) => {
      playingRef.current = false;
      setPlaying(false);
      wait(null);
      setStopped(reason);
    },
    [wait, playingRef, setPlaying, setStopped],
  );
  const onConnection = useCallback(
    (c: PreviewConnection | null) => {
      conn.current = c;
    },
    [conn],
  );

  // A new plan (a switch, the file changed) loads into the same frame (PreviewFrame sends it): loading until settled.
  // (A layout effect: no paint shows the new view as already settled.)
  const planSeen = useRef(plan);
  useLayoutEffect(() => {
    if (plan === planSeen.current) return;
    planSeen.current = plan;
    if (!conn.current?.connected) return;
    playingRef.current = false;
    setPlaying(false);
    wait(frameRef.current);
  }, [plan, wait, conn, playingRef, setPlaying, frameRef]);
  return { onMessage, onHello, onStop, onConnection };
}
