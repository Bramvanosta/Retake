/**
 * The shell's own state (AppShell.tsx): what a take holds, the centre pane's top on a new screen, the slots a screen
 * fills and the inspector's toggle, the polite line a command answers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { HeldWork } from '@retake/engine';
import type { EngineInfoAnswer } from '../data/ops.js';
import { useEvents } from '../events.js';
import type { SlotHost, SlotName } from './slots.js';
import { setSay } from './say.js';

/** How long a polite line stays (ms). */
const SAID_MS = 6000;

/**
 * What a filming take holds of this workspace's jobs — engine_info's `held`, then each jobs
 * event's (the server says it with every change of a job, a hold included: the job stream's signature has it).
 */
export function useHeld(info: EngineInfoAnswer | null): HeldWork | null {
  const [v, set] = useState<HeldWork | null>(null);
  useEffect(() => {
    if (info && info.held !== undefined) set(info.held ?? null);
  }, [info]);
  useEvents((e) => {
    if (e.type === 'jobs' && e.held !== undefined) set(e.held ?? null);
  });
  return v;
}

/** The centre pane back at the top when the screen changes, and the focus on it when the old screen took it away. */
export function useScreenTop(main: RefObject<HTMLElement | null>, key: string): void {
  const firstScreen = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the screen key is the trigger: the pane scrolls to the top when the screen changes
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    // A new screen whose old one took the focused control with it (a link, a palette command): the focus lands on the
    // centre pane, not the document. The first screen of a load leaves it alone (Tab starts at the top).
    if (!document.activeElement || document.activeElement === document.body) main.current?.focus({ preventScroll: true });
  }, [key]);
}

/** The panes a screen fills (slots), the browser a screen hides, and the inspector's toggle. */
export function useSlots(main: RefObject<HTMLElement | null>) {
  const [targets, setTargets] = useState<Partial<Record<SlotName, HTMLElement | null>>>({});
  const [claims, setClaims] = useState<Record<SlotName, number>>({ inspector: 0, context: 0, actions: 0, browser: 0 });
  const claim = useCallback((name: SlotName) => {
    setClaims((c) => ({ ...c, [name]: c[name] + 1 }));
    return () => setClaims((c) => ({ ...c, [name]: c[name] - 1 }));
  }, []);
  // One stable ref callback per slot (a new function each render would detach and re-attach it every time).
  const slotRefs = useMemo(() => {
    const at = (name: SlotName) => (el: HTMLElement | null) => setTargets((t) => (t[name] === el ? t : { ...t, [name]: el }));
    return { inspector: at('inspector'), context: at('context'), actions: at('actions'), browser: at('browser') };
  }, []);
  // A screen that hides the browser pane while mounted (Edit, the Review report).
  const [collapsed, setCollapsed] = useState(0);
  const collapseBrowser = useCallback(() => {
    setCollapsed((n) => n + 1);
    return () => setCollapsed((n) => n - 1);
  }, []);
  const hasInspector = claims.inspector > 0;
  const [inspectorOff, setInspectorOff] = useState(false);
  const inspectorShown = hasInspector && !inspectorOff;
  const host = useMemo<SlotHost>(() => ({ targets, claim, collapseBrowser, hidden: { inspector: inspectorOff } }), [targets, claim, collapseBrowser, inspectorOff]);
  const inspector = useRef<HTMLElement>(null);
  /** Shows or hides the inspector; hiding it with the focus inside moves the focus to the centre pane. */
  const toggleInspector = useCallback(() => {
    if (inspector.current?.contains(document.activeElement)) main.current?.focus({ preventScroll: true });
    setInspectorOff((v) => !v);
  }, [main]);
  return { claims, slotRefs, collapsed, hasInspector, inspectorOff, inspectorShown, host, inspector, toggleInspector };
}

/**
 * What a command answers (a polite line in the status bar): one line at a time — a new one replaces it —, gone after
 * SAID_MS (announced once anyway) and when the screen changes ("queued" never stays beside the run's own
 * state). Said as text (Txt: engine and project words).
 */
export function useSaid(keyNow: RefObject<string>, saidKey: string) {
  const [said, setSaid] = useState('');
  const saidFor = useRef<string | null>(null);
  const saidTimer = useRef<number | null>(null);
  const say = useCallback(
    (s: string) => {
      if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
      setSaid('');
      saidFor.current = keyNow.current;
      saidTimer.current = window.setTimeout(() => {
        setSaid(s);
        saidTimer.current = window.setTimeout(() => {
          saidTimer.current = null;
          setSaid('');
        }, SAID_MS);
      }, 30);
    },
    [keyNow],
  );
  useEffect(() => setSay(say), [say]);
  useEffect(() => {
    if (saidFor.current === null || saidFor.current === saidKey) return;
    if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    saidTimer.current = null;
    saidFor.current = null;
    setSaid('');
  }, [saidKey]);
  useEffect(
    () => () => {
      if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    },
    [],
  );
  return { said, say };
}
