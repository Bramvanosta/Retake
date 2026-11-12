/**
 * The Studio timeline's view of a scenario's take (L4.5, R-UI-23 / R-UI-24; plan D5, critique B4 / B7 / B13 / B14):
 * the take planned as a render would plan it (trust `mcp`, the L5.5 edit source: today's file re-planned on the run
 * while its filmed part is unchanged), its tracks (editor timelineOf), the comment pins placed on them, the inspector's
 * choices with each option usable or disabled with why, whether the file takes edits from the Studio, and the capture's
 * codec and keyframe spacing (a long GOP makes scrubbing slow).
 *
 * - Path-free and plan-free: the view holds no absolute path, no `ds-asset:` map and no plan; text the scenario or the
 *   filmed product wrote (captions, markers, step and page labels, warnings, notes, comment text) is only under
 *   `untrusted`. The plan itself goes beside the view (`plan`, `folders`) for the in-process caller that serves the
 *   preview (Part B's player origin), never into a result.
 * - Memo (critique B13): one view per key — the scenario file's sha256, the run, its timeline.json (size, mtime), the
 *   scenario's comment folder (size, mtime: a thread added or answered), project.yaml (size, mtime), the workspace's
 *   components (their folders' mtimes) — so a click's write and the scenario event it raises re-plan once; and what
 *   only the planning names, checked again on every hit (review B H3): the theme folder's files (names, sizes,
 *   mtimes) and every file the plan serves (size, mtime) — a template.yaml or a logo changed re-plans;
 *   concurrent reads of one key share one planning; the registry is reused while its folders are unchanged and the
 *   music bed is measured once per file (size, mtime).
 * - `plan_sha256` and `theme_sha256`: the plan's signature and the theme folder's content hash, the ones a render
 *   record carries (renders.ts): a render shows "this version" only when both match (Studio "from this version",
 *   findings that seek the preview, comment pins at their own frame); the record is read by the one reader of
 *   renders/ (versionMatches).
 * - A trust refusal (a file outside the project, a remote slot) is the view's `blocked`, with the `retake render`
 *   command a person types — never an exception the screen cannot show.
 */
import { constants as fsConstants, closeSync, fstatSync, openSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseYaml } from '@retake/core/base';
import { COMMENT_ENTRY_ID_RE, COMMENT_ID_RE, isRenderId } from '@retake/core/ids';
import { projectPath, scenarioRef } from '@retake/core/project';
import { isTemplatePath, parseScenario, scenarioBlocks, stepGuard } from '@retake/core/scenario';
import { locateAnchorStep } from '@retake/core/comments';
import { ffprobePackets, packetsArgs, readFfprobeJson, renderOfFile, sameRender } from '@retake/core/render';
import { listTemplates, readListedRender, readPlainFile, ffprobeBin, fileFacts, startMediaTool } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import type { FieldAt, FieldValue } from '@retake/core/scenario';
import type { RenderEntry } from '@retake/core/render';
import type { ComponentRegistry } from '@retake/components';
import type { EditPlan, PlacedPin, TimelineModel } from '@retake/editor';
import { listComments, proposalForPreview } from './comments.js';
import type { ProposalPreview } from './comments.js';
import { components } from './components.js';
import { EngineError } from './errors.js';
import { entryOf, fieldOptions } from './field-options.js';
import type { FieldOption } from './field-options.js';
import { openProjectBySlug } from './projects.js';
import { planSignature } from './renders.js';
import { checkProjectSlug, checkRunId, checkScenarioName } from './refs.js';
import { planRenderRequest } from './jobs/render-job.js';
import { editor } from './lazy.js';
import type { RenderEditSource } from './jobs/render-job.js';
import { getScenario, scenarioEditBlocker } from './scenarios.js';
import { sha256Hex } from './storage.js';
import { themeUnusable } from './templates.js';
import type { OpenedWorkspace } from './workspace.js';
import type { AgentChannel } from './caller.js';

export interface TimelineViewRequest {
  project: string;
  scenario: string;
  /** A capture run of the scenario (default: its latest capture). */
  run_id?: string;
  /**
   * Preview a thread's proposal (L4.6, critique B9): the take planned from the proposed text in memory, on the
   * commented run — checked on every call (open thread, newest pending proposal, today's file its base, the Studio's
   * full write checks), nothing written, the text never a version the Studio may restore; switches off.
   */
  proposal?: { comment_id: string; entry_id: string };
}

/** One field the inspector switches: where, what the file says now, the values offered (field-options.ts). */
export interface FieldChoice {
  at: FieldAt;
  field: string;
  /** What the file says there (absent: not written — the theme's default). */
  current?: FieldValue;
  editable: true | { why: string };
  options: FieldOption[];
  /** Numbers (speed, duration): the range `set_field` takes. */
  range?: { min_exclusive: number; max: number };
}

export interface TimelineCaptureInfo {
  codec?: string;
  b_frames?: boolean;
  /** Seconds between keyframes (the largest gap seen in its first 30 s); `at_least` when a single keyframe was seen. */
  keyframe_interval_s?: number;
  at_least?: true;
  /** Set when scrubbing will be slow: keyframes more than a second apart (critique B14). */
  slow_scrub?: string;
}

export interface TimelineView {
  project: string;
  scenario: string;
  run_id: string;
  theme: string;
  /** sha256 of today's scenario file: the `hash` of a `scenario_edit` (absent: no file). */
  hash?: string;
  /** Where the edit comes from (L5.5) and the sha256 of the file it was planned from. */
  source: RenderEditSource & { edit_sha256?: string };
  /** Whether switches can be written now, else why (a filmed change pending, a file the Studio does not edit…). */
  editable: true | { why: string };
  model: Omit<TimelineModel, 'untrusted'>;
  pins: { placed: PlacedPin[]; elsewhere: string[] };
  /** The video's switches, then each segment's by segment id. */
  choices: { video: FieldChoice[]; segments: Record<string, FieldChoice[]> };
  capture: TimelineCaptureInfo;
  /** Captures of the scenario, newest first (the run picker). */
  runs: string[];
  /** The memo key of this view (the same key: the same view). */
  key: string;
  /** The plan's signature (renders.ts planSignature) and the theme folder's content hash: what a render must match. */
  plan_sha256: string;
  theme_sha256: string;
  /** Milliseconds: planning the take, and the whole view. */
  ms: { planning: number; total: number };
  /**
   * A proposal previewed (L4.6): which, the sha256 of its text, and whether the plan shows it (`shown` false: the take
   * came out as captured — the change cannot be previewed on this take).
   */
  proposal?: { comment_id: string; entry_id: string; result_sha256: string; shown: boolean };
  untrusted: TimelineModel['untrusted'] & { warnings: string[]; notes: string[]; threads: Record<string, { text: string; author: string }> };
}

/** A view, or why the take cannot be planned through the trust gates. */
export type TimelineViewResult =
  | {
      view: TimelineView;
      plan: EditPlan;
      folders: { project: string; run: string; theme: string };
      /**
       * The file's text (the view's `hash`), while switches can be written — beside the view, like the plan: the Studio's
       * undo restores it byte for byte (L4.3 `restore`), as the scenario screen's scenario_blocks gives it.
       */
      text?: string;
      /** Served from the memo (no planning). */ memo?: true;
    }
  | { blocked: { problems: string[]; command?: string }; run_id?: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Memo (critique B13) ─────────────────────────────────────────────────────

const VIEW_MEMO_MAX = 4;
const viewMemo = new Map<string, Promise<TimelineViewResult>>();
/** What a memoised view's planning read beyond its key, and its signature then (checked again on each hit). */
const viewDeps = new Map<string, { sig: string; now: () => string }>();
/** Theme folders' content hashes, by folder and its files' signature. */
const themeHashMemo = new Map<string, string>();
let registryMemo: { sig: string; registry: Promise<ComponentRegistry> } | undefined;
const musicMemo = new Map<string, number | undefined>();
const captureMemo = new Map<string, Promise<TimelineCaptureInfo>>();

/** A cheap signature of the workspace's components: each component folder's and manifest's mtime (two levels). */
function componentsSignature(dir: string): string {
  const parts: string[] = [];
  const mt = (p: string) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  let ns: string[] = [];
  try {
    ns = readdirSync(dir).sort();
  } catch {
    return 'none';
  }
  for (const n of ns) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, n)).sort();
    } catch {
      continue;
    }
    for (const c of names) parts.push(`${n}/${c}:${mt(join(dir, n, c))}:${mt(join(dir, n, c, 'component.yaml'))}`);
  }
  return sha256Hex(parts.join('\n')).slice(0, 16);
}

/** The workspace's component registry, reused while its components' folders are unchanged (timeline views, set_field). */
export async function memoRegistry(ws: OpenedWorkspace): Promise<{ sig: string; registry: ComponentRegistry }> {
  const sig = componentsSignature(ws.componentsDir);
  if (!registryMemo || registryMemo.sig !== sig) {
    const c = await components();
    registryMemo = { sig, registry: c.loadComponentRegistry({ root: ws.root }) };
    registryMemo.registry.catch(() => (registryMemo = undefined));
  }
  return { sig, registry: await registryMemo.registry };
}

const statKey = (file: string): string => {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'missing';
  }
};

/** The ffprobe a work runs, for a memo's key (its refusal's words when the work's policy refuses it): another ffprobe's answer is not this one's. */
const ffprobeKey = (policy: WorkPolicy): string => {
  try {
    return ffprobeBin(policy);
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
};

async function musicLength(file: string, policy: WorkPolicy): Promise<number | undefined> {
  const key = `${file}|${statKey(file)}|${ffprobeKey(policy)}`;
  if (musicMemo.has(key)) return musicMemo.get(key);
  const ed = await editor();
  const probe = await ed.probeMedia(file, policy);
  const length = probe && probe.duration_s > 0 ? probe.duration_s : undefined;
  if (musicMemo.size > 32) musicMemo.delete(musicMemo.keys().next().value!);
  musicMemo.set(key, length);
  return length;
}

/** Forget every memoised view (tests). */
export function clearTimelineViewMemo(): void {
  viewMemo.clear();
  viewDeps.clear();
  themeHashMemo.clear();
  registryMemo = undefined;
  musicMemo.clear();
  captureMemo.clear();
}

// ── The capture's codec and keyframes (critique B14) ────────────────────────

/** Keyframes further apart than this make scrubbing slow (each seek decodes from the previous keyframe). */
export const SLOW_SCRUB_KEYFRAME_S = 1;

/**
 * The capture's codec, B-frames and keyframe spacing over its first 30 s: ffprobe reads the packets (no decoding) from
 * a descriptor opened without following a link — ffprobe opens no path. Empty when ffprobe is missing or fails.
 */
export async function captureInfo(file: string, o: { ffprobe?: string; timeoutMs?: number; policy: WorkPolicy }): Promise<TimelineCaptureInfo> {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return {};
  }
  try {
    if (!fstatSync(fd).isFile()) return {};
    const tool = startMediaTool(ffprobeBin(o.policy, o.ffprobe), packetsArgs(30), { stdio: ['ignore', 'pipe', 'ignore', fd], timeoutMs: o.timeoutMs ?? 10_000, timeoutSignal: 'SIGKILL' });
    let text = '';
    tool.child.stdout!.on('data', (d: Buffer) => {
      if (text.length < 8_000_000) text += d.toString('utf8');
    });
    const end = await tool.exited;
    if (end.error || end.code !== 0) return {};
    const j = ffprobePackets(readFfprobeJson(text));
    const s = j.stream;
    const info: TimelineCaptureInfo = {};
    if (typeof s?.codec_name === 'string' && /^[a-z0-9_]{1,20}$/.test(s.codec_name)) info.codec = s.codec_name;
    if (typeof s?.has_b_frames === 'number') info.b_frames = s.has_b_frames > 0;
    const times = (j.packets ?? []).map((p) => Number(p.pts_time)).filter((t) => Number.isFinite(t));
    const keys = (j.packets ?? [])
      .filter((p) => p.flags?.startsWith('K'))
      .map((p) => Number(p.pts_time))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    if (keys.length >= 2) {
      let gap = 0;
      for (let i = 1; i < keys.length; i++) gap = Math.max(gap, keys[i] - keys[i - 1]);
      info.keyframe_interval_s = Math.round(gap * 100) / 100;
    } else if (keys.length === 1 && times.length) {
      info.keyframe_interval_s = Math.round((Math.max(...times) - keys[0]) * 100) / 100;
      info.at_least = true;
    }
    if (info.keyframe_interval_s !== undefined && info.keyframe_interval_s > SLOW_SCRUB_KEYFRAME_S) {
      info.slow_scrub = `scrubbing is slow on this take (keyframes ${info.at_least ? 'at least ' : ''}every ${info.keyframe_interval_s.toFixed(1)} s): a take encoded with the Mac's hardware encoder seeks fast`;
    }
    return info;
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}

function memoCapture(file: string, policy: WorkPolicy): Promise<TimelineCaptureInfo> {
  const key = `${file}|${statKey(file)}|${ffprobeKey(policy)}`;
  let p = captureMemo.get(key);
  if (!p) {
    p = captureInfo(file, { policy });
    if (captureMemo.size > 16) captureMemo.delete(captureMemo.keys().next().value!);
    captureMemo.set(key, p);
  }
  return p;
}

// ── Choices ─────────────────────────────────────────────────────────────────

const SPEED_RANGE = { min_exclusive: 0, max: 16 };
const DURATION_RANGE = { min_exclusive: 0, max: 600 };

/** What the switch of an intro / outro map leaves alone: its component and duration (the other keys are its content). */
const SWITCH_KEYS = new Set(['component', 'duration']);

/**
 * What the file says at a field (`true` for an intro / outro written as a map), or `map` when a map is written there;
 * `content`: an intro / outro map's keys beyond component and duration (its title, tagline, files…).
 */
function currentAt(entry: Obj | undefined, field: string): { value?: FieldValue; map?: true; content?: string[] } {
  let v: unknown = entry;
  for (const k of field.split('.')) v = isObj(v) ? v[k] : undefined;
  if (v === undefined || v === null) return {};
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { value: v };
  if ((field === 'intro' || field === 'outro') && isObj(v)) {
    const content = Object.keys(v).filter((k) => !SWITCH_KEYS.has(k));
    return { value: true, ...(content.length ? { content } : {}) };
  }
  return { map: true };
}

/** The themes the scenario's `template` switch offers: the workspace's listed names, and the project's own. */
interface ThemeChoices {
  names: string[];
  /** Listed themes that cannot be used (why), offered disabled (review B L4). */
  unusable: Record<string, string>;
  project?: string;
}

async function choicesOf(registry: ComponentRegistry, root: unknown, plan: EditPlan, editable: true | { why: string }, themes: ThemeChoices): Promise<TimelineView['choices']> {
  const make = async (at: FieldAt, field: string, range?: FieldChoice['range']): Promise<FieldChoice> => {
    const entry = entryOf(root, at);
    const cur = currentAt(entry, field);
    // Review B H2: "Theme default" or "Off" would drop an intro / outro's own text and files — the YAML view changes it.
    const content = cur.content?.filter((k) => /^[a-z_]{1,40}$/.test(k)).slice(0, 6);
    const why =
      editable !== true
        ? editable
        : cur.map
          ? { why: `${field} is written with params here: change it in the YAML view` }
          : cur.content
            ? { why: `the ${field} has its own ${content?.length ? content.join(', ') : 'content'} here: turn it off or back to the theme's in the YAML view (a switch would drop it)` }
            : true;
    return { at, field, ...(cur.value !== undefined ? { current: cur.value } : {}), editable: why, options: await fieldOptions(registry, root, at, field), ...(range ? { range } : {}) };
  };
  // L4.7 (critique B1): the scenario's theme — the project's (the key removed) or a theme the workspace lists, by name.
  const theme = await make({ entry: 'top' }, 'template');
  theme.options = [
    { value: null, label: themes.project !== undefined && !isTemplatePath(themes.project) ? `The project's theme (${themes.project})` : "The project's theme", usable: true },
    ...themes.names.map((n): FieldOption => ({ value: n, label: n, usable: themes.unusable[n] === undefined ? true : { why: `this theme cannot be used: ${themes.unusable[n]}` } })),
  ];
  const video = [await make({ entry: 'top' }, 'caption_component'), await make({ entry: 'top' }, 'frame'), theme];
  const segments: Record<string, FieldChoice[]> = {};
  const scenes = isObj(root) && Array.isArray(root.scenes) ? root.scenes : [];
  for (const s of plan.segments) {
    if (s.kind === 'intro' || s.kind === 'outro') {
      segments[s.id] = [await make({ entry: 'top' }, `${s.kind}.component`), await make({ entry: 'top' }, s.kind), await make({ entry: 'top' }, `${s.kind}.duration`, DURATION_RANGE)];
      continue;
    }
    const type = s.kind === 'clip' ? 'scene' : s.kind;
    const k = scenes.findIndex((e, i) => {
      if (!isObj(e)) return false;
      const t = e.card !== undefined ? 'card' : e.interstitial !== undefined ? 'interstitial' : 'scene';
      const id = typeof e.id === 'string' ? e.id : t === 'scene' ? undefined : `${t}-${i}`;
      return t === type && id === s.id;
    });
    if (k < 0) continue;
    const at = { entry: type, id: s.id, guard: stepGuard(scenes[k]) } as FieldAt;
    if (type === 'scene') segments[s.id] = [await make(at, 'frame'), await make(at, 'transition'), await make(at, 'speed', SPEED_RANGE)];
    else if (type === 'card') segments[s.id] = [await make(at, 'card.component'), await make(at, 'card.duration', DURATION_RANGE), await make(at, 'card.transition')];
    else segments[s.id] = [await make(at, 'interstitial.component'), await make(at, 'interstitial.duration', DURATION_RANGE)];
  }
  return { video, segments };
}

// ── The view ────────────────────────────────────────────────────────────────

/**
 * A filmed change in a person's words (review B: "step coffees.1" read as the second step): core filmedChangesOf names
 * steps by their 0-based key (what page_inspect takes); the timeline says "step 2", 1-based.
 */
export function filmedChangeWords(change: string): string {
  const m = /^scene ([a-z0-9][a-z0-9_-]*): (.*)$/.exec(change);
  if (!m) return change;
  const name = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `scene ${m[1]}: ${m[2].replace(new RegExp(`\\b${name}\\.(\\d+)\\b`, 'g'), (_x, k: string) => String(Number(k) + 1))}`;
}

/** A theme folder's content hash, memoised by its files' signature (names, sizes, mtimes). */
function themeHash(ed: Awaited<ReturnType<typeof editor>>, dir: string): string {
  const key = `${dir}|${ed.themeStatSignature(dir)}`;
  let h = themeHashMemo.get(key);
  if (h === undefined) {
    h = ed.themeContentHash(dir);
    if (themeHashMemo.size > 16) themeHashMemo.delete(themeHashMemo.keys().next().value!);
    themeHashMemo.set(key, h);
  }
  return h;
}

/**
 * Which of the renders `asked` (by id, as each was when a comment was made on it) show this version — `true` at the
 * same index: renders/<id>.json read through the one reader of renders/ under a listing's rules — a background read,
 * not a render someone named: its own file, never through a link, within the listing's cap (core/io
 * readListedRender) —, a record of its own file (D-10, core renderOfFile) that succeeded, the same render as the one asked
 * (core sameRender: its id and its creation time), with its plan, this plan's signature and this theme's hash.
 */
export async function versionMatches(projectDir: string, planSha: string, themeSha: string, asked: ReadonlyArray<{ id: string; created_at: string }>): Promise<boolean[]> {
  const read = new Map<string, Promise<RenderEntry>>();
  const out: boolean[] = [];
  for (const a of asked) {
    if (!isRenderId(a.id)) {
      out.push(false);
      continue;
    }
    let entry = read.get(a.id);
    if (!entry) read.set(a.id, (entry = readListedRender(projectPath(projectDir, 'renders'), a.id)));
    const record = renderOfFile(await entry);
    out.push(record !== null && record.status === 'succeeded' && sameRender(record, a) && record.template_sha256 === themeSha && record.plan !== undefined && planSignature(record.plan) === planSha);
  }
  return out;
}

/** Step labels ("click Request a quote") of a scenario text, by "<scene>.<index>". */
function stepLabels(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === undefined) return out;
  const b = scenarioBlocks(text);
  for (const e of b.entries) {
    if (e.type !== 'scene') continue;
    for (const st of e.steps) out[st.key] = `${st.label}${st.target ? ` ${st.target}` : ''}`.slice(0, 200);
  }
  return out;
}

async function buildView(
  ws: OpenedWorkspace,
  cli: string,
  project: LoadedProject,
  req: TimelineViewRequest,
  file: { hash?: string; yaml?: string; blocked?: string },
  t0: number,
  themes: ThemeChoices,
  proposal?: ProposalPreview,
  /** The take shown is the default one (none was asked for): it is among the choices even when the list ends before it. */
  defaulted = false,
): Promise<TimelineViewResult> {
  const { registry } = await memoRegistry(ws);
  let planned;
  let source: RenderEditSource;
  try {
    ({ planned, source } = await planRenderRequest(
      ws,
      cli,
      { project: req.project, scenario: req.scenario, ...(req.run_id ? { run_id: req.run_id } : {}) },
      { registry, musicLength: (file) => musicLength(file, ws.policy), ...(proposal ? { editText: proposal.text } : {}) },
    ));
  } catch (e) {
    if (e instanceof EngineError && e.code === 'refused') {
      const problems = Array.isArray((e.details as { problems?: unknown } | undefined)?.problems) ? (e.details as { problems: string[] }).problems : [e.message];
      return { blocked: { problems, ...(e.fix ? { command: e.fix } : {}) }, ...(req.run_id ? { run_id: req.run_id } : {}) };
    }
    throw e;
  }
  const planMs = Math.round(performance.now() - t0);
  const ed = await editor();
  const plan = planned.plan;
  const fromScenario = planned.edit.from === 'scenario';
  // Labels from the file the plan matches: the text it was planned from, else the run's snapshot.
  const snap = readPlainFile(join(planned.run.dir, 'scenario.yaml'), 2 * 1024 * 1024);
  const labelText = fromScenario ? planned.editText : snap.ok ? snap.bytes.toString('utf8') : undefined;
  const model = ed.timelineOf(plan, { labels: stepLabels(labelText), timeline: planned.timeline });
  // Comment pins (read-only, L3.6 threads): the scenario's last 50.
  const threads = await listComments(project, { scenario: req.scenario, status: 'all', limit: 50 }).catch(() => undefined);
  // (A plan this version made always has a signature; '' would match no record.)
  const planSha = planSignature(plan) ?? '';
  const themeSha = themeHash(ed, planned.template.dir);
  // A thread made on a render of this very version (the same plan and theme files) is pinned at its own frame (review
  // B M5); any other only at the step, marker or segment it pointed at.
  const onTake = (threads?.threads ?? []).filter((t) => t.run_id === planned.run.id);
  const matched = await versionMatches(
    project.dir,
    planSha,
    themeSha,
    onTake.map((t) => ({ id: t.render_id, created_at: t.render_created_at })),
  );
  const thisVersion = new Set(onTake.filter((_t, i) => matched[i]).map((t) => t.id));
  const pinThreads = (threads?.threads ?? []).map((t) => ({
    id: t.id,
    status: t.status,
    run_id: t.run_id,
    anchor: { segment: t.anchor.segment, ...(t.anchor.scene !== undefined ? { scene: t.anchor.scene } : {}), ...(t.anchor.step !== undefined ? { step: t.anchor.step } : {}) },
    ...(t.marker !== undefined ? { marker: t.marker } : {}),
    // A proposal previewed: each step where it is in the proposed text (the pin of its thread at its step there).
    ...(proposal && t.anchor.scene !== undefined && t.anchor.step !== undefined
      ? { step_now: locateAnchorStep(proposal.text, t.anchor) ?? null }
      : t.step_now !== undefined
        ? { step_now: t.step_now }
        : {}),
    ...(thisVersion.has(t.id) ? { frame: t.frame } : {}),
  }));
  const pins = ed.placePins(model, pinThreads, { run_id: planned.run.id, edit: planned.edit.from });
  let editable: true | { why: string } = true;
  if (proposal) editable = { why: 'Previewing a proposal: apply it to edit' };
  else if (file.hash === undefined) editable = { why: `${scenarioRef(req.scenario)} is not there: nothing to switch` };
  else if (file.blocked) editable = { why: file.blocked };
  else if (planned.edit.scenario_changed) {
    editable = {
      why: `The scenario's filmed part changed since this take (${(planned.edit.filmed_changes ?? ['the file no longer reads as YAML']).slice(0, 4).map(filmedChangeWords).join('; ')}): the preview shows the take as captured — capture again to see edits on it.`,
    };
  } else if (!fromScenario) editable = { why: planned.edit.reason ?? 'the preview shows the take as captured: there is no scenario snapshot to re-plan the edit on' };
  // The choices read the file as it is now (the same text the plan came from when the edit is today's).
  const shownText = proposal ? proposal.text : file.yaml;
  const root = shownText !== undefined ? parseYaml(shownText).value : undefined;
  const choices = await choicesOf(registry, root, plan, editable, themes);
  const capture = await memoCapture(planned.captureFile, ws.policy);
  // The takes to choose from: the scenario's newest captures of any status, in the one order of runs.
  const runs = (await (await import('./runs.js')).listRuns(project, { scenario: req.scenario, mode: 'capture', limit: 20 })).map((r) => r.id);
  if (defaulted && !runs.includes(planned.run.id)) runs.unshift(planned.run.id);
  const { untrusted, ...shape } = model;
  const view: TimelineView = {
    project: project.slug,
    scenario: req.scenario,
    run_id: planned.run.id,
    theme: planned.template.name,
    ...(file.hash !== undefined ? { hash: file.hash } : {}),
    source: { ...source, ...(planned.edit.sha256 ? { edit_sha256: planned.edit.sha256 } : {}) },
    editable,
    model: shape,
    pins,
    choices,
    capture,
    runs,
    key: '',
    plan_sha256: planSha,
    theme_sha256: themeSha,
    ms: { planning: planMs, total: Math.round(performance.now() - t0) },
    ...(proposal
      ? { proposal: { comment_id: proposal.comment_id, entry_id: proposal.entry, result_sha256: proposal.result_sha256, shown: fromScenario && planned.edit.sha256 === proposal.result_sha256 } }
      : {}),
    untrusted: {
      ...untrusted,
      warnings: plan.warnings,
      notes: plan.notes,
      threads: Object.fromEntries((threads?.threads ?? []).map((t) => [t.id, { text: t.untrusted.text.slice(0, 300), author: t.untrusted.author.slice(0, 80) }])),
    },
  };
  // The file's text for undo, never a proposal's (critique B9 b: a proposed text is not a version the Studio restores).
  return {
    view,
    plan,
    folders: { project: project.dir, run: planned.run.dir, theme: planned.template.dir },
    ...(!proposal && editable === true && file.yaml !== undefined ? { text: file.yaml } : {}),
  };
}

/** What a planned view read beyond its memo key: the theme folder's files and every file the plan serves (signature). */
function depsOf(ed: Awaited<ReturnType<typeof editor>>, r: TimelineViewResult): (() => string) | undefined {
  if (!('view' in r)) return undefined;
  const theme = r.folders.theme;
  const files = [...new Set(Object.values(r.plan.assets))].sort();
  return () => sha256Hex(`${ed.themeStatSignature(theme)}\n${files.map((f) => `${f}:${statKey(f)}`).join('\n')}`).slice(0, 16);
}

/**
 * The timeline view of a scenario's take (see the module comment). The same key (file, run, timeline, components)
 * returns the memoised view: a click's write and the event it raises plan once.
 */
export async function timelineView(ws: OpenedWorkspace, cli: string, req: TimelineViewRequest, o: { agent: boolean; via: AgentChannel }): Promise<TimelineViewResult> {
  const t0 = performance.now();
  checkProjectSlug(req.project);
  checkScenarioName(req.scenario);
  if (req.run_id !== undefined) checkRunId(req.run_id);
  const project = await openProjectBySlug(ws, req.project);
  let file: { hash?: string; yaml?: string; blocked?: string } = {};
  try {
    const text = await getScenario(project, req.scenario);
    const parsed = text.utf8 ? parseScenario(text.yaml, { files: fileFacts(ws.policy), file: text.path, project }).scenario : undefined;
    const blocked = scenarioEditBlocker(project, text, parsed, o);
    file = { hash: text.hash, yaml: text.yaml, ...(blocked ? { blocked: blocked.why } : {}) };
  } catch (e) {
    if (!(e instanceof EngineError && e.code === 'not_found')) throw e;
  }
  // A proposal (critique B9 d): its state and every write check run on each call, before the memo — a proposal applied,
  // superseded or gone stale since the last view is refused, never served from the memo.
  let proposal: ProposalPreview | undefined;
  if (req.proposal !== undefined) {
    const pr = req.proposal;
    if (!pr || typeof pr !== 'object' || typeof pr.comment_id !== 'string' || !COMMENT_ID_RE.test(pr.comment_id) || typeof pr.entry_id !== 'string' || !COMMENT_ENTRY_ID_RE.test(pr.entry_id)) {
      throw new EngineError('invalid', 'proposal is {comment_id: c_…, entry_id: r_…}: the thread and the reply holding the proposal', { details: { argument: 'proposal' } });
    }
    proposal = await proposalForPreview(project, req.scenario, pr, { registry: async () => (await memoRegistry(ws)).registry, files: fileFacts(ws.policy) });
    if (req.run_id !== undefined && req.run_id !== proposal.run_id) {
      throw new EngineError('invalid', `a proposal is previewed on the take its comment was made on (run ${proposal.run_id})`, { details: { argument: 'run_id' } });
    }
  }
  // The run the view shows: asked, else `latest` — the newest capture an edit can work on, by the rule every reader of
  // runs shares, over every run folder (no window): the take the scenario view names as Render's (`capture`), which
  // asks the same rule the same way (scenario-view.ts captureOf). Its timeline.json's size and mtime are in the key.
  const asked = proposal?.run_id ?? req.run_id;
  const runId = asked ?? (await (await import('./runs.js')).latestCapture(project, req.scenario)).take?.run;
  const timelineStat = runId ? statKey(projectPath(project.dir, 'runs', runId, 'timeline.json')) : 'none';
  // The scenario's comment folder (its mtime moves when a thread is added or rewritten: an entry is a rename): new pins.
  const commentsStat = statKey(projectPath(project.dir, 'comments', req.scenario));
  const projectStat = statKey(join(project.dir, 'project.yaml'));
  // The themes the scenario's theme switch offers (a theme copied or created since: a new view).
  const listed = await listTemplates(project.root);
  const unusable: Record<string, string> = {};
  const reg = (await memoRegistry(ws)).registry;
  for (const t of listed) {
    const why = await themeUnusable(t.dir, reg, ws.root, fileFacts(ws.policy));
    if (why !== null) unusable[t.name] = why;
  }
  const themes: ThemeChoices = { names: listed.map((t) => t.name), unusable, ...(typeof project.config.template === 'string' ? { project: project.config.template } : {}) };
  const key = sha256Hex(
    canonicalJson([
      project.dir,
      req.scenario,
      file.hash ?? null,
      file.blocked ?? null,
      runId ?? null,
      // The default take is put among its choices when the list ends before it: a view of its own.
      asked === undefined,
      timelineStat,
      commentsStat,
      projectStat,
      componentsSignature(ws.componentsDir),
      themes.names,
      themes.unusable,
      proposal ? [proposal.comment_id, proposal.entry, proposal.result_sha256] : null,
    ]),
  ).slice(0, 24);
  let p = viewMemo.get(key);
  // A hit whose theme files or served files changed since its planning plans again (review B H3).
  const deps = viewDeps.get(key);
  if (p && deps && deps.now() !== deps.sig) {
    viewMemo.delete(key);
    viewDeps.delete(key);
    p = undefined;
  }
  const hit = p !== undefined;
  if (!p) {
    const built = buildView(ws, cli, project, { ...req, ...(runId ? { run_id: runId } : {}) }, file, t0, themes, proposal, asked === undefined);
    p = built;
    viewMemo.set(key, built);
    if (viewMemo.size > VIEW_MEMO_MAX) {
      const oldest = viewMemo.keys().next().value!;
      viewMemo.delete(oldest);
      viewDeps.delete(oldest);
    }
    built.catch(() => viewMemo.delete(key));
    const ed = await editor();
    void built.then(
      (r) => {
        const now = depsOf(ed, r);
        if (now && viewMemo.get(key) === built) viewDeps.set(key, { sig: now(), now });
      },
      () => undefined,
    );
  }
  const r = await p;
  if ('view' in r) return { ...r, view: { ...r.view, key }, ...(hit ? { memo: true as const } : {}) };
  return r;
}
