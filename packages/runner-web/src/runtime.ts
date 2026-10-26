import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { LOADING_CUT_MIN_S, displayPages, isDesktopViewport, resolvePageUrl } from '@demo-studio/core';
import type {
  ResolvedScenePage,
  ResolvedViewport,
  BBox,
  CaptureSettings,
  CursorEffect,
  LoadedProject,
  NormalizedStep,
  Pacing,
  PointSpec,
  ResolvedEnvironment,
  RunMode,
} from '@demo-studio/core';
import type { TemplateContext } from '@demo-studio/core';
import type { BrowserSession, KitClient } from './session.js';
import type { CursorEffectPayload } from './kit/types.js';
import { HOLD_MAX_MS } from './hold.js';
import { ScreencastRecorder } from './recorder.js';
import type { StreamEncoder } from './stream.js';
import { TrackBuilder } from './timeline.js';
import type { TimelineBuilder } from './timeline.js';
import { Pointer } from './pointer.js';
import type { RunSecrets } from './secrets.js';
import type { Jitter } from './motion.js';
import { RunnerError, StepError } from './errors.js';
import type { LoginPageError } from './errors.js';
import type { LoginGuard } from './auth.js';
import { INSPECT_PAUSE_CAP_S } from './inspect.js';
import { fileSlug, throwIfAborted } from './util.js';
import { sleep } from './util.js';
import { ArtefactStore } from './artefacts/store.js';
import type { PendingPopup } from './actions/click.js';
import type { Acted } from './park.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeInit {
  /** The in-page cursor is hidden (raw export): moving it changes nothing on screen. */
  cursorHidden?: boolean;
  session: BrowserSession;
  timeline: TimelineBuilder;
  pacing: Pacing;
  capture: CaptureSettings;
  mode: RunMode;
  signal: AbortSignal;
  project: LoadedProject;
  env: ResolvedEnvironment;
  runDir: string;
  screenshotsDir: string;
  template: TemplateContext;
  /** The run's secret values (resolved up front, redacted where the run writes). */
  secrets: RunSecrets;
  recorder: ScreencastRecorder | null;
  log: (level: LogLevel, message: string) => void;
  /** Watches the filmed pages for a sign-in page (L1.6; null: the environment has no sign-in to watch). */
  guard?: LoginGuard | null;
  /** The persona each page id is planned with (core planPersonas): a page created in another one is reported. */
  plannedPersonas?: ReadonlyMap<string, string | null>;
  /**
   * Work submitted through MCP (L3.1, core HookTrust `mcp`): the files a step reads (drop_file.path, eval.file) stay in
   * the project folder, an eval file is not one an agent can write and names no secret (core agent-trust).
   */
  agentTrust?: boolean;
  /**
   * The run replays a scenario for an inspection (L3.3, RunOptions.inspect): no per-step dry-run screenshots, and the
   * pauses (`hold`, `wait`, a step's `hold:`, a scene's still) last at most INSPECT_PAUSE_CAP_S.
   */
  inspecting?: boolean;
  /** `defaults.timeout_s` of the scenario, else the project's (L5.6): the timeout of every step that sets none. */
  defaultTimeoutS?: number;
  /**
   * The encoder a page track of a capture is fed to during the take (L5.7): `horizon` reads its recorder's. Absent (or
   * null): the track keeps its frames only.
   */
  encoderFor?: (o: { out: string; width: number; height: number; horizon: () => number }) => StreamEncoder | null;
}

/** Longest wait for flowing frames after a scroll (Runtime.awaitFreshFrame). */
export const FRESH_FRAME_TIMEOUT_MS = 900;
/** Frames count as flowing after this many probes in a row answered within FRESH_FRAME_QUICK_MS. */
const FRESH_FRAME_PROBES = 3;
const FRESH_FRAME_QUICK_MS = 50;
const FRESH_FRAME_PROBE_GAP_MS = 40;
/** A frame stamped up to this long before a move's dispatch may already show it (stamps vs dispatch, a few ms). */
const CAUGHT_UP_SLACK_MS = 20;
/**
 * How long after an input the capture is given to show it. Stalls that ended by themselves did within ≈ 0.15–0.36 s
 * (L1.3 Mac runs); the longer ones only ended with the next input (a mousedown), so waiting longer only adds a
 * motionless pause.
 */
const STALL_GIVE_UP_MS = 450;

/** A page's own track (multi-page scenes, L2.11): its timeline part and its screencast (none in a dry run). */
export interface PageTrack {
  builder: TrackBuilder;
  recorder: ScreencastRecorder | null;
  /** Its capture-<page>.mp4, encoded during the take (L5.7). */
  encoder: StreamEncoder | null;
  started: boolean;
  viewport: ResolvedViewport;
}

/** A page of the multi-page scene running now: its page, viewport and own cursor. */
export interface ScenePane {
  id: string;
  page: Page;
  viewport: ResolvedViewport;
  pointer: Pointer;
}

/** Long-lived state of one run, shared by every action. */
export class Runtime {
  /** The cursor of single-page scenes (it follows the active page, as the main capture does). */
  readonly mainPointer: Pointer;
  readonly session: BrowserSession;
  readonly timeline: TimelineBuilder;
  readonly pacing: Pacing;
  readonly capture: CaptureSettings;
  readonly mode: RunMode;
  readonly signal: AbortSignal;
  readonly project: LoadedProject;
  readonly env: ResolvedEnvironment;
  readonly runDir: string;
  readonly screenshotsDir: string;
  readonly template: TemplateContext;
  readonly secrets: RunSecrets;
  readonly log: (level: LogLevel, message: string) => void;
  recorder: ScreencastRecorder | null;
  readonly guard: LoginGuard | null;
  private readonly plannedPersonas: ReadonlyMap<string, string | null> | undefined;
  /** Captured emails, documents and web notifications (runs/<id>/artefacts/). */
  readonly artefacts: ArtefactStore;
  readonly cursorHidden: boolean;
  /** Work submitted through MCP: see RuntimeInit.agentTrust. */
  readonly agentTrust: boolean;
  /** An inspection's replay: see RuntimeInit.inspecting. */
  readonly inspecting: boolean;
  /** See RuntimeInit.defaultTimeoutS. */
  readonly defaultTimeoutS: number | undefined;
  private readonly encoderFor: RuntimeInit['encoderFor'];
  /** Clicks still watched for an effect (R-FLD-12, actions/effects.ts): the next acting step closes them. */
  readonly effectChecks = new Set<{ close: () => Promise<void> }>();
  /** The scene and step being executed (notifications are attributed to them). */
  current: { scene: string; scene_index: number; step: number } | null = null;
  /** The last plain click of the scene, while the popup it may open late is not ruled out (settleLatePopup). */
  pendingPopup: PendingPopup | null = null;
  /** Some step of the scenario parks the cursor (R-CHO-18/21): acting steps record what changes on the page. */
  parkWatch = false;
  /** The element the last acting step used (parking keeps clear of it). */
  lastActed: Acted | null = null;
  private tabSeq = 1;
  private readonly tracked = new WeakSet<Page>();
  /** Per-page tracks of multi-page scenes, by page id (kept for the whole run). */
  readonly tracks = new Map<string, PageTrack>();
  /** Per recorder, the holds it had ended when the runner last revealed the cursor after one (awaitLoaded). */
  private readonly revealedAt = new WeakMap<ScreencastRecorder, number>();
  /** Every page filmed by a multi-page scene so far, with its own cursor (kept across scenes). */
  private readonly panes = new Map<string, ScenePane>();
  /** The pages of the multi-page scene running now (null: a single-page scene). */
  private scenePageIds: string[] | null = null;
  /** The main capture paused for a multi-page scene: the next `activate` resumes it. */
  private mainPaused = false;
  /** What each page of a multi-page scene was declared with (a later scene listing it by id inherits it). */
  readonly declaredPages = new Map<string, { page?: string; viewport: ResolvedViewport; label?: string }>();

  /**
   * The template context of the text the video shows — captions, cards, overlays, page labels (L1.7): `{{page}}` reads
   * the page's display URL. Made per use: the setup hooks' saved results land in `template` after the runtime exists.
   */
  get editTemplate(): TemplateContext {
    return { ...this.template, pages: displayPages(this.env) };
  }

  constructor(init: RuntimeInit) {
    this.session = init.session;
    this.timeline = init.timeline;
    this.pacing = init.pacing;
    this.capture = init.capture;
    this.mode = init.mode;
    this.signal = init.signal;
    this.project = init.project;
    this.env = init.env;
    this.runDir = init.runDir;
    this.screenshotsDir = init.screenshotsDir;
    this.template = init.template;
    this.secrets = init.secrets;
    this.recorder = init.recorder;
    this.cursorHidden = init.cursorHidden === true;
    this.agentTrust = init.agentTrust === true;
    this.inspecting = init.inspecting === true;
    this.defaultTimeoutS = init.defaultTimeoutS;
    this.encoderFor = init.encoderFor;
    this.log = init.log;
    this.guard = init.guard ?? null;
    this.plannedPersonas = init.plannedPersonas;
    this.artefacts = new ArtefactStore(init.runDir, (m) => this.warn(m));
    // What each page's cursor shows (icon, press, ripple; L2.13) goes with the capture that films that page.
    this.session.onCursorEffect = (page, p) => this.cursorEffect(page, p);
    this.mainPointer = new Pointer({
      page: () => this.page,
      kit: () => this.kit,
      timeline: this.timeline,
      pacing: this.pacing,
      signal: this.signal,
      scale: this.capture.scale,
      beforePress: () => this.awaitCaughtUp(this.page, this.mainPointer),
      afterPress: () => this.recorderFor(this.page)?.pressed(),
    });
  }

  /**
   * A cursor effect reported by a page's kit (L2.13): on that page's track while it records (multi-page scenes), on
   * the main capture's timeline when that page is the one recorded there.
   */
  private cursorEffect(page: Page, p: CursorEffectPayload): void {
    const id = this.session.idOf(page);
    if (!id || typeof p?.time !== 'number' || !['icon', 'press', 'release', 'ripple'].includes(p.type)) return;
    const e: CursorEffect = { t: this.timeline.clock.at(p.time), type: p.type };
    if (p.type === 'icon') {
      if (p.icon !== 'arrow' && p.icon !== 'hand' && p.icon !== 'ibeam') return;
      e.icon = p.icon;
    }
    if (p.type === 'ripple' && typeof p.x === 'number' && typeof p.y === 'number') {
      e.x = p.x;
      e.y = p.y;
    }
    const track = this.tracks.get(id);
    if (track?.builder.recordingNow) track.builder.cursorEffect(e);
    if (!this.scenePageIds && this.session.activeId === id) this.timeline.cursorEffect(e);
  }

  /** The icon a page's cursor shows right now, as an effect of the capture that starts filming it. */
  private async currentIcon(page: Page, to: { cursorEffect(e: CursorEffect): void }): Promise<void> {
    const st = await this.session.kit(page).cursorState().catch(() => null);
    if (st?.kind) to.cursorEffect({ t: this.now(), type: 'icon', icon: st.kind });
  }

  /** The cursor of the acting page: its own in a multi-page scene, else the main one. */
  get pointer(): Pointer {
    if (this.scenePageIds && this.session.activeId) {
      const pane = this.panes.get(this.session.activeId);
      if (pane) return pane.pointer;
    }
    return this.mainPointer;
  }

  /** The recorder filming the acting page: its own track in a multi-page scene, else the main capture. */
  get filming(): ScreencastRecorder | null {
    if (this.scenePageIds && this.session.activeId) return this.tracks.get(this.session.activeId)?.recorder ?? null;
    return this.recorder;
  }

  /**
   * After a scroll, the frames showing newly exposed content can stop for 0.26–0.43 s a moment later (a Mac, L1.5): a
   * cursor glide started meanwhile freezes, then jumps. Probe the capture with 1 px nudges of the resting cursor (back
   * and forth) until FRESH_FRAME_PROBES of them in a row show up within FRESH_FRAME_QUICK_MS — at most
   * FRESH_FRAME_TIMEOUT_MS, and a probe no frame answers within STALL_GIVE_UP_MS ends it — so the next glide starts on
   * a flowing capture. A no-op without a recorder (dry run) or a drawn cursor (raw export without it: a nudge changes
   * nothing on screen).
   */
  async awaitFreshFrame(): Promise<void> {
    const rec = this.filming;
    const pointer = this.pointer;
    // A held page load (R-ISS-08) writes no frame however the cursor moves.
    if (!rec || rec.holding || this.cursorHidden || !pointer.known || !pointer.visible) return;
    const home = pointer.pos();
    const dx = home.x + 1 < this.viewport.width ? 1 : -1;
    const deadline = Date.now() + FRESH_FRAME_TIMEOUT_MS;
    let quick = 0;
    for (let i = 0; quick < FRESH_FRAME_PROBES && Date.now() < deadline; i++) {
      const t = Date.now();
      await pointer.moveTo({ x: home.x + (i % 2 === 0 ? dx : 0), y: home.y }, { ms: 0 });
      if (!(await rec.waitFrameAfter(t, Math.min(STALL_GIVE_UP_MS, Math.max(0, deadline - Date.now()))))) {
        this.log('debug', `scroll: no frame ${Date.now() - t} ms after a probe; going on (the next move resumes the capture)`);
        break;
      }
      quick = Date.now() - t <= FRESH_FRAME_QUICK_MS ? quick + 1 : 0;
      if (quick < FRESH_FRAME_PROBES) await this.sleep(FRESH_FRAME_PROBE_GAP_MS);
    }
    if (pointer.pos().x !== home.x) await pointer.moveTo(home, { ms: 0 });
  }

  /**
   * Before a press: when no captured frame shows the cursor's last move yet (the capture stopped — the page rendering
   * a hover effect, L1.3: a frame showing a move is stamped after its dispatch), wait for one until STALL_GIVE_UP_MS
   * after that move, so the press and its ripple are filmed rather than frozen. Free when the capture keeps up.
   */
  async awaitCaughtUp(page: Page, pointer: Pointer): Promise<void> {
    if (this.cursorHidden || !pointer.visible) return;
    const moved = pointer.lastMoveAt;
    const rec = this.recorderFor(page);
    if (!rec || rec.holding || moved === 0 || rec.lastFrameAt >= moved - CAUGHT_UP_SLACK_MS) return;
    const left = moved + STALL_GIVE_UP_MS - Date.now();
    if (left <= 0 || !(await rec.waitFrameAfter(moved - CAUGHT_UP_SLACK_MS, left))) {
      this.log('debug', `press: no frame since the cursor's last move ${Date.now() - moved} ms ago; pressing (the press resumes the capture)`);
    }
  }

  /** The recorder filming `page` right now: the main capture, or that page's track (none in a dry run). */
  recorderFor(page: Page): ScreencastRecorder | null {
    if (this.recorder?.recordingPage === page) return this.recorder;
    return [...this.tracks.values()].find((t) => t.recorder?.recordingPage === page)?.recorder ?? null;
  }

  /**
   * Never act on, or open a scene still on, a page whose load the capture is holding (R-ISS-08): wait until it painted
   * (at most HOLD_MAX_MS and a second; a cancelled run stops waiting). A fresh tab's about:blank is not waited for:
   * only a step or the scene can open a page there (its frames stay held until then). After a hold, the page's cursor
   * is revealed — the kit draws a cursor restored on a new document only once the page painted content of its own (its
   * SVG would count as the page's first paint), and a page that never paints content (no text, image or SVG) gets it
   * here. Free when nothing is held.
   */
  async awaitLoaded(page: Page = this.page): Promise<void> {
    const rec = this.recorderFor(page);
    if (!rec) return;
    if (rec.holding && rec.holdKind !== 'blank') {
      const ended = await rec.waitLoaded(HOLD_MAX_MS + 1000, this.signal);
      throwIfAborted(this.signal);
      if (!ended) this.log('debug', 'a page load is still held; going on');
    }
    if (this.revealedAt.get(rec) === rec.holdsEnded) return;
    this.revealedAt.set(rec, rec.holdsEnded);
    await this.session.kit(page).cursorReveal().catch(() => undefined);
  }

  /**
   * `awaitLoaded` for every page the edit shows now: each page of the multi-page scene running now (a load held on one
   * page is cut from all of them — no page may act meanwhile; one may start loading while another is waited for), else
   * the active page.
   */
  async awaitShownLoaded(): Promise<void> {
    const panes = this.scenePanes;
    if (panes.length === 0) return this.awaitLoaded();
    const held = () => panes.some((p) => this.recorderFor(p.page)?.holdKind === 'navigation');
    for (let round = 0; round < 3; round++) {
      for (const pane of panes) await this.awaitLoaded(pane.page);
      if (!held()) return;
    }
  }

  /** Ms of page loads the capture of `page` held since wall time `sinceWall` (only those the edit cuts: ≥ LOADING_CUT_MIN_S). */
  heldMs(page: Page, sinceWall: number): number {
    return this.recorderFor(page)?.heldSince(sinceWall, LOADING_CUT_MIN_S * 1000) ?? 0;
  }

  /** Viewport (CSS px) of the acting page: a multi-page scene's page has its own, else the capture size. */
  get viewport(): { width: number; height: number } {
    if (this.scenePageIds && this.session.activeId) {
      const pane = this.panes.get(this.session.activeId);
      if (pane) return { width: pane.viewport.width, height: pane.viewport.height };
    }
    return { width: this.capture.width, height: this.capture.height };
  }

  /** The pages of the multi-page scene running now (empty outside one). */
  get scenePanes(): ScenePane[] {
    return (this.scenePageIds ?? []).map((id) => this.panes.get(id)!).filter(Boolean);
  }

  /**
   * Start a multi-page scene (L2.11): every page exists (created blank when new) with its viewport, the main capture
   * pauses and each page is recorded on its own track, at the same time, on the capture clock; each page gets its own
   * cursor (taking over where the page already shows one). The first page acts.
   */
  async enterPages(pages: readonly ResolvedScenePage[]): Promise<void> {
    if (this.scenePageIds) await this.leavePages(pages.map((p) => p.id));
    if (this.recorder && !this.mainPaused) {
      await this.recorder.pause();
      this.mainPaused = true;
    }
    const capture = { width: this.capture.width, height: this.capture.height };
    for (const pg of pages) {
      const page = await this.session.page(pg.id);
      this.track(pg.id, page);
      const known = this.tracks.get(pg.id);
      if (known && (known.viewport.width !== pg.viewport.width || known.viewport.height !== pg.viewport.height || known.viewport.mobile !== pg.viewport.mobile)) {
        throw new StepError(
          `page "${pg.id}" was filmed at ${known.viewport.width}×${known.viewport.height} and is now asked at ${pg.viewport.width}×${pg.viewport.height}: ` +
            'a page keeps one viewport for the whole run (give the other viewport its own page id)',
        );
      }
      if (!isDesktopViewport(pg.viewport, capture) || this.session.emulated(page)) await this.session.emulate(page, pg.viewport);
      let pane = this.panes.get(pg.id);
      if (!pane || pane.page !== page) {
        const id = pg.id;
        const pointer: Pointer = new Pointer({
          page: () => page,
          kit: () => this.session.kit(page),
          timeline: this.timeline,
          pacing: this.pacing,
          signal: this.signal,
          scale: this.capture.scale,
          sample: (s) => this.tracks.get(id)?.builder.sampleCursor(s),
          beforePress: (): Promise<void> => this.awaitCaughtUp(page, pointer),
          afterPress: () => this.recorderFor(page)?.pressed(),
        });
        pane = { id, page, viewport: pg.viewport, pointer };
        this.panes.set(id, pane);
      }
      let track = this.tracks.get(pg.id);
      if (!track) {
        const slug = fileSlug(pg.id);
        const builder = new TrackBuilder(
          {
            id: pg.id,
            file: `capture-${slug}.mp4`,
            frames_file: `frames-${slug}.jsonl`,
            width: pg.viewport.width,
            height: pg.viewport.height,
            scale: this.capture.scale,
            fps: this.capture.fps,
            ...(pg.viewport.mobile ? { mobile: true } : {}),
            ...(pg.viewport.touch ? { touch: true } : {}),
            ...(pg.viewport.preset ? { preset: pg.viewport.preset } : {}),
          },
          this.timeline.clock,
        );
        this.timeline.tracks.push(builder);
        let recorder: ScreencastRecorder | null = null;
        const encoder =
          this.mode === 'capture'
            ? (this.encoderFor?.({
                out: join(this.runDir, `capture-${slug}.mp4`),
                width: pg.viewport.width * this.capture.scale,
                height: pg.viewport.height * this.capture.scale,
                horizon: () => recorder?.horizon() ?? 0,
              }) ?? null)
            : null;
        encoder?.start();
        recorder =
          this.mode === 'capture'
            ? new ScreencastRecorder({
                framesDir: join(this.runDir, `frames-${slug}`),
                indexFile: join(this.runDir, `frames-${slug}.jsonl`),
                format: this.capture.format,
                quality: this.capture.quality,
                width: pg.viewport.width,
                height: pg.viewport.height,
                scale: this.capture.scale,
                mobile: pg.viewport.mobile,
                clock: this.timeline.clock,
                onError: (m) => this.timeline.warn(`page ${pg.id}: ${m}`),
                pageId: () => pg.id,
                keepFrames: this.capture.keep_frames,
                ...(encoder ? { sink: encoder } : {}),
              })
            : null;
        track = { builder, recorder, encoder, started: false, viewport: pg.viewport };
        this.tracks.set(pg.id, track);
      }
      if (track.recorder) {
        if (!track.started) await track.recorder.start(page);
        else await track.recorder.switchTo(page);
      }
      track.started = true;
      track.builder.start(page.url());
      await this.currentIcon(page, track.builder);
      // The page may already show a cursor (filmed by an earlier scene): this page's cursor takes over from there.
      if (!pane.pointer.known) {
        const st = await this.session.kit(page).cursorState().catch(() => null);
        if (st?.known) pane.pointer.adopt(st);
      }
    }
    for (const pg of pages) this.declaredPages.set(pg.id, { ...(pg.page !== undefined ? { page: pg.page } : {}), viewport: pg.viewport, ...(pg.label !== undefined ? { label: pg.label } : {}) });
    this.scenePageIds = pages.map((p) => p.id);
    await this.session.activate(pages[0].id);
  }

  /**
   * End a multi-page scene: its pages' tracks pause (hold their last frame) — except `keep`, the pages of a next
   * multi-page scene that films them too; the main capture resumes on the next `activate`.
   */
  async leavePages(keep: readonly string[] = []): Promise<void> {
    if (!this.scenePageIds) return;
    for (const id of this.scenePageIds) {
      if (keep.includes(id)) continue;
      const t = this.tracks.get(id);
      if (!t) continue;
      await t.recorder?.pause();
      t.builder.stop();
    }
    this.scenePageIds = null;
  }

  /** Inside a multi-page scene: the page the next steps act on (its cursor moves; the others rest). */
  async act(id: string): Promise<Page> {
    if (!this.scenePageIds?.includes(id)) throw new StepError(`page "${id}" is not filmed by this scene (${(this.scenePageIds ?? []).join(', ')})`);
    return this.session.activate(id);
  }

  get page(): Page {
    return this.session.active;
  }

  get kit(): KitClient {
    return this.session.kit();
  }

  get activeId(): string | null {
    return this.session.activeId;
  }

  now(): number {
    return this.timeline.now();
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms, this.signal);
  }

  /** A scenario's pause of `seconds` (`hold`, `wait`, a step's `hold:`): capped during an inspection's replay. */
  pause(seconds: number): Promise<void> {
    return this.sleep(Math.min(seconds, this.inspecting ? INSPECT_PAUSE_CAP_S : seconds) * 1000);
  }

  warn(message: string): void {
    this.timeline.warn(message);
    this.log('warn', message);
  }

  nextTabId(): string {
    let id: string;
    do id = `tab${++this.tabSeq}`;
    while (this.session.has(id));
    return id;
  }

  /** The run's sign-in landing (L1.6), once a filmed page landed on a sign-in page. */
  loginGuardError(): LoginPageError | null {
    return this.guard?.error ?? null;
  }

  /**
   * Never go on — act, take a screenshot, start a still — on a sign-in page (L1.6): every filmed page's current URL is
   * checked (a landing the navigation event did not report yet, a tab that opened on one); the landing is thrown.
   */
  assertSignedIn(): void {
    if (!this.guard) return;
    for (const [id, page] of this.session.pages) {
      if (page.isClosed()) continue;
      const e = this.guard.check(id, page);
      if (e) throw e;
    }
    const e = this.guard.error;
    if (e) throw e;
  }

  /** Track URL changes of a page for the timeline page segments (and the sign-in guard, L1.6). */
  private track(id: string, page: Page): void {
    if (this.tracked.has(page)) return;
    this.tracked.add(page);
    if (this.plannedPersonas?.has(id)) {
      const planned = this.plannedPersonas.get(id) ?? '';
      const actual = this.session.realmName(page);
      if (actual !== undefined && actual !== planned) {
        // The static plan (core planPersonas) and the run walked the scenario differently: a bug worth a report.
        this.log('warn', `page ${id} is filmed ${actual ? `as persona ${actual}` : 'without a persona'} but was planned ${planned ? `as ${planned}` : 'without one'} (the persona plan missed a page switch)`);
      }
    }
    this.guard?.check(id, page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      // A filmed page landing on a sign-in page fails the run at once (same-document routes included).
      this.guard?.check(this.session.idOf(page) ?? id, page, frame.url());
      if (this.session.pages.get(id) !== page) return;
      // A page of a multi-page scene: its own track's URL segments; otherwise the main capture's.
      const t = this.tracks.get(id);
      if (t?.builder.recordingNow) t.builder.pageSegment(frame.url());
      if (!this.scenePageIds && this.session.activeId === id) this.timeline.pageSegment(id, frame.url());
    });
  }

  /** Switch the active (recorded) page: screencast, timeline segment and cursor follow. */
  async activate(id: string, page?: Page): Promise<Page> {
    if (this.scenePageIds) await this.leavePages();
    if (page) this.session.register(id, page);
    const prev = this.session.activeId;
    const p = await this.session.activate(id);
    this.track(id, p);
    const t = this.tracks.get(id);
    if (t && !isDesktopViewport(t.viewport, { width: this.capture.width, height: this.capture.height })) {
      throw new StepError(
        `page "${id}" has a ${t.viewport.width}×${t.viewport.height} viewport: a single-page scene films the capture size — film it in a multi-page scene (\`pages\`)`,
      );
    }
    const resumed = this.mainPaused;
    if (resumed) {
      this.mainPaused = false;
      // The page's own cursor (multi-page scene) is where the main cursor continues.
      const pane = this.panes.get(id);
      if (pane) this.mainPointer.adopt(pane.pointer);
    }
    if (prev !== id || !this.timeline.pages.length || resumed) {
      if (this.recorder) await this.recorder.switchTo(p);
      this.timeline.pageSegment(id, p.url());
      if (prev !== id) await this.pointer.syncPage();
      if (prev !== id || resumed) await this.currentIcon(p, this.timeline);
    }
    return p;
  }

  /**
   * Base URL used to resolve a relative path on page `id`: its environment page — for a page id declared by a
   * multi-page scene (`pages:`), the environment page it was declared on, as its `open:` resolves —, else the current
   * URL.
   */
  resolveUrl(pathOrUrl: string, id: string | null = this.session.activeId): string {
    const envKey = id !== null && !Object.hasOwn(this.env.pages, id) ? this.declaredPages.get(id)?.page : id;
    const envBase = envKey ? this.env.pages[envKey] : undefined;
    if (envBase) return resolvePageUrl(envBase, pathOrUrl);
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
    const cur = id && this.session.has(id) ? this.session.pages.get(id)!.url() : '';
    if (cur && /^https?:/.test(cur)) return new URL(pathOrUrl, cur).toString();
    throw new RunnerError(
      `cannot resolve relative URL "${pathOrUrl}": page "${id ?? '(none)'}" is not an environment page (${Object.keys(this.env.pages).join(', ')}) and has no http(s) URL`,
    );
  }

  /**
   * Resolve once the active page has painted the current DOM state (two animation frames; at most 150 ms when the
   * page does not render). Used before a scene's still so its first frames already show the cursor in place. The kit
   * waits on the timers and frames it captured when it started (L1.7: whatever the page does to its globals since).
   */
  async painted(page: Page = this.page): Promise<void> {
    await page
      .evaluate(() => {
        const g = globalThis as unknown as { __demoStudio?: { afterPaint?: () => Promise<void> } };
        if (typeof g.__demoStudio?.afterPaint === 'function') return g.__demoStudio.afterPaint();
        return new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 150);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      })
      .catch(() => undefined);
  }

  /** Wait for load, then for network idle up to settle_ms. */
  async settle(page: Page = this.page): Promise<void> {
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
    if (this.pacing.settle_ms > 0) {
      await page.waitForLoadState('networkidle', { timeout: this.pacing.settle_ms }).catch(() => undefined);
    }
  }
}

/**
 * Role of a pointer interaction inside a step: the click that opens the widget (trigger; also the only click of a
 * plain click, the drop of a drop_file, the press of a drag), an option of a listbox/popover, a menu item, the
 * confirmation button, a click outside that closes a popover, a click into a popover's search field, a calendar's
 * month button (nav) or one of its days (day).
 */
export type ClickRole = 'trigger' | 'option' | 'item' | 'confirm' | 'outside' | 'search' | 'nav' | 'day';

/** One recorded pointer interaction inside a step. */
export interface ClickRecord {
  role: ClickRole;
  /** Capture time of the press. */
  t: number;
  point: PointSpec;
  desc: string;
  bbox?: BBox;
  strategy?: string;
  popup_opened?: boolean;
  /** ms from the press to the evidence that a popup opened. */
  popup_ms?: number;
}

/** Per-step context passed to every action. */
export interface StepContext {
  rt: Runtime;
  scene: { id: string; index: number };
  step: NormalizedStep;
  /** Step timeout in ms (step.timeout, else defaults.timeout_s, else 15 s). */
  timeoutMs: number;
  jitter: Jitter;
  /** Pointer interactions performed by the step, in order. */
  clicks: ClickRecord[];
}
