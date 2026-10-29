/**
 * The preview frame (L4.5, DESIGN §4g): DemoVideo in a Remotion Player, inside `<iframe sandbox="allow-scripts">` on the
 * player origin (an opaque origin: no storage, no cookie, no access to the Studio page), under the frame's strict CSP,
 * after boot.ts removed WebRTC. It displays only: every control lives in the Studio page, which talks to it over the
 * MessageChannel of protocol.ts.
 *
 * - On load it posts one `hello` (with the channel's port) to its parent — the origin `location.ancestorOrigins` names
 *   when it is one of the Studio origins the frame document lists, else each of them (only the matching one delivers).
 * - `load {plan_url, frame}`: fetches the preview plan (a capability URL of this player origin, refused otherwise), loads
 *   the plan's components — each lazily, its own `import()` (critique B3): one that throws at load or is not in the
 *   bundle is `missing` (its kind's scaffold draws, a warning says so) — then mounts the Player, muted, at `frame`.
 * - `settled {frame}` once paused at a frame with nothing pending: no delayRender handle, every video ready and not
 *   seeking, fonts and images loaded, for two polls in a row (critique B8: the Player itself waits for nothing).
 * - Preview mode (PreviewContext): a theme font that fails is a warning, never a blank preview.
 * - A workspace component the person has not allowed in this Studio session is not in the bundle at all (`held`, review
 *   A H1 c): its uses draw their kind's stand-in, and the warning says it was not run.
 * - L4.7: a served `{format: 'component-preview', spec}` (the theme editor's live previews) plays the ComponentPreview
 *   composition instead, looping: the same checks (every URL of the spec one of this frame's), the same lazy component
 *   loads (held / missing → the kind's stand-in, said in `loaded.warnings`), the same messages.
 * - It starts only in the frame document (review A L2): its own capability path (boot.js runs first there), framed
 *   directly by the Studio page — never in a child frame or another page that loads it.
 */
import { createElement as h, useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { ComponentPreview, DemoVideo, ModulesContext, PreviewContext, usedComponentIds } from 'ds:composition';
import { bundle, defaults, held, loaders, scaffolds } from 'ds:modules';
import { latest } from './frame-store.js';
import { LIST_MAX, PROTOCOL_VERSION, clip, isPreviewDisplayText, parseParentMessage } from './protocol.js';
import type { FrameMessage, ParentMessage } from './protocol.js';

type Out = FrameMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

interface PlanShape {
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  segments: unknown[];
  source?: { url?: unknown };
  music?: { url?: unknown };
}

interface Mounted {
  gen: number;
  /** The size and length of what plays (a plan, or a component preview's spec). */
  plan: PlanShape;
  Video: ComponentType<Record<string, unknown>>;
  /** The composition's props: `{plan}` or `{preview}`. */
  props: Record<string, unknown>;
  /** A component preview loops. */
  loop: boolean;
  frame: number;
}

/** A component preview spec as the frame checks it (editor ComponentPreviewSpec). */
interface PreviewShape {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  frame: number;
  main?: { id?: unknown };
  scene?: { layout?: { id?: unknown }; caption?: { id?: unknown } };
  incoming?: { id?: unknown };
}

/** The `format` of a served component preview (server player.ts COMPONENT_PREVIEW_FORMAT). */
const COMPONENT_PREVIEW = 'component-preview';
/** A string naming a resource by a scheme (or scheme-relative): in a component preview, one of this frame's URLs only. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:file|blob|data|javascript|about|filesystem|mailto):)/i;

const here = new URL(location.href);
const capMatch = /^\/s\/([A-Za-z0-9_-]{43})\/frame$/.exec(here.pathname);
/** Every URL this frame may load starts with it. */
const MEDIA = capMatch ? `${here.origin}/m/${capMatch[1]}/` : null;
const PLAN_PREFIX = MEDIA ? `${MEDIA}plan/` : null;
/**
 * The frame document and nothing else (review A L2): the capability path (its own document, which boot.js always
 * precedes), a direct child of the Studio page (top). A srcdoc / about:blank child or another page that loads this
 * script gets nothing.
 */
const IN_FRAME = (() => {
  try {
    return capMatch !== null && window.parent !== window && window.parent === window.top;
  } catch {
    return false;
  }
})();
const HELD = new Set<string>(held);
/** Errors and warnings posted per loaded plan. */
const REPORTS_MAX = 8;

let port: MessagePort | null = null;
let player: PlayerRef | null = null;
let generation = 0;
let reports = 0;
let rate: 0.5 | 1 | 2 = 1;
let mounted: Mounted | null = null;
/** What the Player shows (frame-store.ts: a plan mounted before the tree subscribed is kept). */
const shown = latest<Mounted | null>(null);
let settleTarget: number | null = null;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let settledStreak = 0;
let lastFrameSent = -1;
let framePending = false;

const send = (m: Out) => port?.postMessage({ v: PROTOCOL_VERSION, ...m });
const report = (type: 'warning' | 'error', message: string) => {
  if (reports >= REPORTS_MAX) return;
  reports++;
  send({ type, message: clip(message) });
};

const previewMode = { warn: (message: string) => report('warning', message) };

window.addEventListener('error', (e) => report('error', e.message || 'a script error'));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: unknown } | undefined;
  report('error', typeof r?.message === 'string' ? r.message : String(e.reason));
});

// ── loading a plan ───────────────────────────────────────────────────────────

type Module = { component: unknown; defaults: Record<string, unknown> };
let scaffoldModules: Promise<Record<string, Module>> | undefined;

function loadScaffolds(): Promise<Record<string, Module>> {
  scaffoldModules ??= (async () => {
    const out: Record<string, Module> = {};
    await Promise.all(
      Object.entries(scaffolds).map(async ([kind, s]) => {
        try {
          const mod = await s.load();
          if (mod.default) out[kind] = { component: mod.default, defaults: s.defaults };
        } catch {
          // A scaffold that does not load leaves its kind without a stand-in (DemoVideo says so).
        }
      }),
    );
    return out;
  })();
  return scaffoldModules;
}

/** Every URL the plan loads media from (the capture, its pages, the music) is one of this frame's. */
function planProblem(plan: unknown): string | undefined {
  const p = plan as PlanShape | null;
  if (!p || typeof p !== 'object') return 'the plan is not an object';
  if (!Number.isInteger(p.durationInFrames) || p.durationInFrames < 1 || !(p.fps > 0) || !(p.width > 0) || !(p.height > 0) || !Array.isArray(p.segments)) return 'the plan has no video size';
  const urls = [p.source?.url, p.music?.url, ...Object.values((plan as { tracks?: Record<string, { url?: unknown }> }).tracks ?? {}).map((t) => t?.url)];
  for (const u of urls) if (u !== undefined && (typeof u !== 'string' || !MEDIA || !u.startsWith(MEDIA))) return 'the plan names media this preview does not serve';
  return undefined;
}

/** A component preview's spec has a size and length, and every URL in it is one of this frame's. */
function previewProblem(spec: unknown): string | undefined {
  const p = spec as PreviewShape | null;
  if (!p || typeof p !== 'object') return 'the preview is not an object';
  if (!Number.isInteger(p.durationInFrames) || p.durationInFrames < 1 || !(p.fps > 0) || !(p.width > 0) || !(p.height > 0) || !Number.isInteger(p.frame)) return 'the preview has no video size';
  let bad = false;
  const scan = (v: unknown, path: string, depth: number): void => {
    if (bad || depth > 32) return;
    if (typeof v === 'string') {
      // Display text (drawn, never loaded): the same fixed paths as the server's scan, array indices included.
      if (URL_LIKE.test(v) && (!MEDIA || !v.startsWith(MEDIA)) && !isPreviewDisplayText(path, v, spec)) bad = true;
    } else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`, depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${path}.${k}`, depth + 1);
  };
  scan(spec, 'spec', 0);
  return bad ? 'the preview names media this frame does not serve' : undefined;
}

/** The component ids a preview spec renders (the component, its scene's layout and caption, the incoming card). */
function previewComponentIds(spec: PreviewShape): string[] {
  const ids = [spec.main?.id, spec.scene?.layout?.id, spec.scene?.caption?.id, spec.incoming?.id].filter((x): x is string => typeof x === 'string');
  return [...new Set(ids)].sort();
}

async function load(m: Extract<ParentMessage, { type: 'load' }>): Promise<void> {
  const gen = ++generation;
  reports = 0;
  if (!PLAN_PREFIX || !m.plan_url.startsWith(PLAN_PREFIX)) return report('error', 'the plan URL is not one of this preview');
  let doc: unknown;
  try {
    const r = await fetch(m.plan_url, { credentials: 'omit', cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    doc = await r.json();
  } catch (e) {
    if (gen === generation) report('error', `the preview plan could not be loaded (${e instanceof Error ? e.message : 'error'})`);
    return;
  }
  // L4.7: a component preview (the theme editor), played by ComponentPreview, looping.
  const isPreview = !!doc && typeof doc === 'object' && (doc as { format?: unknown }).format === COMPONENT_PREVIEW;
  let plan: PlanShape;
  let ids: string[];
  let props: Record<string, unknown>;
  if (isPreview) {
    const spec = (doc as { spec?: unknown }).spec;
    const problem = previewProblem(spec);
    if (problem) return report('error', problem);
    const p = spec as PreviewShape;
    plan = { durationInFrames: p.durationInFrames, fps: p.fps, width: p.width, height: p.height, segments: [] };
    ids = previewComponentIds(p);
    props = { preview: spec };
  } else {
    plan = doc as PlanShape;
    const problem = planProblem(plan);
    if (problem) return report('error', problem);
    ids = usedComponentIds(plan);
    props = { plan };
  }
  const components: Record<string, Module> = {};
  const missing: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const loader = Object.prototype.hasOwnProperty.call(loaders, id) ? loaders[id] : undefined;
      try {
        const mod = loader ? await loader() : undefined;
        if (!mod?.default) throw new Error('missing');
        components[id] = { component: mod.default, defaults: defaults[id] ?? {} };
      } catch {
        missing.push(id);
      }
    }),
  );
  const scaffoldsLoaded = await loadScaffolds();
  if (gen !== generation) return;
  missing.sort();
  const modules = { components, scaffolds: scaffoldsLoaded };
  const Composition = isPreview ? ComponentPreview : DemoVideo;
  const Video = (vp: Record<string, unknown>) => h(ModulesContext.Provider, { value: modules }, h(PreviewContext.Provider, { value: previewMode }, h(Composition, vp)));
  const frame = Math.min(m.frame, plan.durationInFrames - 1);
  mounted = { gen, plan, Video, props, loop: isPreview, frame };
  shown.set(mounted);
  send({
    type: 'loaded',
    frames: plan.durationInFrames,
    missing: missing.slice(0, LIST_MAX).map((id) => clip(id, 128)),
    warnings: missing
      .slice(0, LIST_MAX)
      .map((id) => clip(HELD.has(id) ? `workspace component ${id} is not run in the preview until you allow it in the Studio: its kind's stand-in draws instead` : `component ${id} is not in the preview: its kind's stand-in draws instead`)),
  });
  settle(frame);
}

// ── settled ──────────────────────────────────────────────────────────────────

function quiet(): boolean {
  const w = window as unknown as { remotion_delayRenderHandles?: unknown[] };
  if ((w.remotion_delayRenderHandles?.length ?? 0) > 0) return false;
  if (document.fonts.status !== 'loaded') return false;
  for (const v of Array.from(document.querySelectorAll('video'))) if (v.readyState < 2 || v.seeking) return false;
  for (const i of Array.from(document.images)) if (!i.complete) return false;
  return true;
}

function settle(frame: number): void {
  settleTarget = frame;
  settledStreak = 0;
  clearTimeout(settleTimer);
  const poll = () => {
    if (settleTarget === null || !player) {
      settleTimer = setTimeout(poll, 30);
      return;
    }
    if (player.isPlaying()) {
      settleTarget = null;
      return;
    }
    settledStreak = player.getCurrentFrame() === settleTarget && quiet() ? settledStreak + 1 : 0;
    if (settledStreak >= 2) {
      send({ type: 'settled', frame: settleTarget });
      settleTarget = null;
      return;
    }
    settleTimer = setTimeout(poll, 30);
  };
  settleTimer = setTimeout(poll, 30);
}

// ── messages from the Studio page ────────────────────────────────────────────

function onParent(data: unknown): void {
  const m = parseParentMessage(data);
  if (!m) return;
  switch (m.type) {
    case 'load':
      void load(m);
      return;
    case 'seek':
      if (!mounted) return;
      player?.pause();
      player?.seekTo(Math.min(m.frame, mounted.plan.durationInFrames - 1));
      settle(Math.min(m.frame, mounted.plan.durationInFrames - 1));
      return;
    case 'play':
      settleTarget = null;
      player?.play();
      return;
    case 'pause':
      player?.pause();
      if (player) settle(player.getCurrentFrame());
      return;
    case 'rate':
      rate = m.rate;
      if (mounted) shown.set({ ...mounted });
      return;
    case 'mute':
      if (m.muted) player?.mute();
      else player?.unmute();
      return;
    case 'clear':
      generation++;
      mounted = null;
      shown.set(null);
      return;
  }
}

// ── the Player ───────────────────────────────────────────────────────────────

const attached = new WeakSet<object>();
let buffering = false;

function sendState(ref: PlayerRef): void {
  send({ type: 'state', playing: ref.isPlaying(), buffering, muted: ref.isMuted() });
}

function attach(ref: PlayerRef | null): void {
  player = ref;
  if (!ref || attached.has(ref)) return;
  attached.add(ref);
  ref.addEventListener('frameupdate', (e) => {
    lastFrameSent = e.detail.frame;
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      send({ type: 'frame', frame: lastFrameSent });
    });
  });
  ref.addEventListener('play', () => sendState(ref));
  ref.addEventListener('pause', () => sendState(ref));
  ref.addEventListener('mutechange', () => sendState(ref));
  ref.addEventListener('waiting', () => {
    buffering = true;
    sendState(ref);
  });
  ref.addEventListener('resume', () => {
    buffering = false;
    sendState(ref);
  });
  ref.addEventListener('ended', () => send({ type: 'ended' }));
  ref.addEventListener('error', (e) => report('error', e.detail.error?.message ?? 'the preview failed'));
  // The preview starts muted (critique B17): the page shows it, and unmutes on a person's click.
  sendState(ref);
}

function App() {
  // Read again once subscribed: a `load` the Studio answered before this tree's first effects still mounts (L5.2).
  const m = useSyncExternalStore(shown.subscribe, shown.get);
  if (!m) return null;
  return h(Player, {
    key: m.gen,
    ref: attach,
    component: m.Video,
    inputProps: m.props,
    durationInFrames: m.plan.durationInFrames,
    fps: m.plan.fps,
    compositionWidth: m.plan.width,
    compositionHeight: m.plan.height,
    initialFrame: m.frame,
    initiallyMuted: true,
    playbackRate: rate,
    controls: false,
    clickToPlay: false,
    doubleClickToFullscreen: false,
    spaceKeyToPlayOrPause: false,
    moveToBeginningWhenEnded: false,
    loop: m.loop,
    acknowledgeRemotionLicense: true,
    style: { width: '100%', height: '100%' },
  });
}

// ── hello ────────────────────────────────────────────────────────────────────

function parentOrigins(): string[] {
  const meta = document.querySelector('meta[name="ds-parent"]');
  return (meta?.getAttribute('content') ?? '').split(/\s+/).filter((o) => /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(o));
}

function hello(): void {
  const allowed = parentOrigins();
  const ancestor = location.ancestorOrigins?.[0];
  const targets = ancestor !== undefined ? allowed.filter((o) => o === ancestor) : allowed;
  const channels: MessageChannel[] = [];
  for (const target of targets) {
    const ch = new MessageChannel();
    channels.push(ch);
    ch.port1.onmessage = (e) => {
      if (port !== ch.port1) {
        // The parent answered on this channel: it is the one; the others are dropped.
        for (const other of channels) if (other !== ch) other.port1.close();
        port = ch.port1;
      }
      onParent(e.data);
    };
    window.parent.postMessage({ v: PROTOCOL_VERSION, type: 'hello', bundle }, target, [ch.port2]);
  }
  // A single candidate (Chrome, Safari) is the port at once: the frame can report before the parent's first message.
  if (channels.length === 1) port = channels[0].port1;
}

const root = document.getElementById('root');
if (IN_FRAME) {
  if (root) createRoot(root).render(h(App));
  // After the document loaded: the parent re-arms its hello listener on the frame's load event (parent.ts).
  window.addEventListener('load', hello);
}
