/**
 * The theme editor's hooks that call no op: the live re-reads on a theme event, the live frame's own state (what the
 * sandboxed Player said), and the random lease the preview holds.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ThemeEditView } from '@retake/engine';
import type { PreviewConnection } from '../../player/parent.js';
import type { FrameMessage } from '../../player/protocol.js';
import { useEvents } from '../events.js';
import { themeEventAction } from '../words/theme-words.js';
import type { ThemeHistory } from '../words/theme-words.js';

/** A random lease id (22 base64url characters) for theme_preview / timeline_leave. */
export function newLease(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Live re-reads: this theme changed on disk (another window, Claude, a person), a component, a reconnection. */
export function useThemeRereads(
  slug: string,
  theme: string,
  load: () => Promise<ThemeEditView | null>,
  { busyRef, history, rerender }: { busyRef: { current: boolean }; history: { current: ThemeHistory }; rerender: (f: (n: number) => number) => void },
) {
  const timer = useRef<number | null>(null);
  useEvents((e) => {
    if (!themeEventAction(e, slug, theme) || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (busyRef.current) return;
      void load().then((d) => {
        if (d) history.current.sync(d.sha256);
        rerender((n) => n + 1);
      });
    }, 250);
  });
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
}

/**
 * The live frame's state: the still's moment it settles on, loading / settled / stopped, Play, the frame's notes, a
 * restart count, the component being allowed, and the frame's channel. A new plan (a write, a draft) loads into the
 * same frame: loading until it settles.
 */
export function useLiveFrameState(frame: number | undefined, plan: string | undefined) {
  const frameRef = useRef(0);
  if (frame !== undefined) frameRef.current = frame;
  const [state, setState] = useState<'loading' | 'settled' | 'stopped'>('loading');
  const [settles, setSettles] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [restart, setRestart] = useState(0);
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const conn = useRef<PreviewConnection | null>(null);
  const heldId = useId();
  const onMessage = useCallback((m: FrameMessage) => {
    switch (m.type) {
      case 'loaded':
        setNotes(m.warnings.slice(0, 4));
        return;
      case 'settled':
        setState('settled');
        setSettles((n) => n + 1);
        return;
      case 'state':
        setPlaying(m.playing);
        return;
      case 'warning':
      case 'error':
        setNotes((n) => [...n, m.message].slice(-4));
        return;
    }
  }, []);
  const onHello = useCallback(() => {
    setState('loading');
    setPlaying(false);
  }, []);
  const onStop = useCallback((reason: string) => {
    setState('stopped');
    setNotes((n) => [...n, reason].slice(-4));
  }, []);
  const onConnection = useCallback((c: PreviewConnection | null) => {
    conn.current = c;
  }, []);
  // A new plan (a write, a draft) loads into the same frame: loading until it settles.
  const planSeen = useRef(plan);
  useLayoutEffect(() => {
    if (plan === planSeen.current) return;
    planSeen.current = plan;
    if (!conn.current?.connected) return;
    setPlaying(false);
    setState('loading');
  }, [plan]);
  return { frameRef, state, setState, settles, playing, notes, restart, setRestart, allowing, setAllowing, allowError, setAllowError, conn, heldId, onMessage, onHello, onStop, onConnection };
}
