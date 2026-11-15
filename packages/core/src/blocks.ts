/**
 * A scenario read as blocks (R-UI-08..10, R-UI-14): the video header, the setup / teardown hooks, the scenes
 * with their steps, the cards and the interstitials, in file order — what the Studio's scenario screen shows, and what
 * the Studio's two-way editor edits (each block keeps its source range and the comment above it).
 *
 * Pure and tolerant: `scenarioBlocks` never throws. A YAML syntax error gives no blocks (the issues and the text still
 * show); an entry or a step it cannot read becomes an `unknown` block carrying the issues whose path points into it.
 * Every string is as written in the file — a templated `{{shop}}` or `{{env:…}}` stays a reference, never resolved, so
 * no secret value can reach a block —, except that a URL's `user:password@` is left out of what is shown. Values come
 * from core parseYaml (aliases bounded by `maxAliasCount`, a recursive alias refused); the walker never resolves an
 * alias itself: a block written as an alias (`- *step`) is `aliased`, carries the alias's range and no comment, and is
 * never edited through.
 */
import { isMap } from 'yaml';
import { childAt, commentOf, rangeOf, topCommentWords } from './block-nodes.js';
import type { At, Src } from './block-nodes.js';
import {
  actionCategory,
  actionLabel,
  captionOf,
  describeStep,
  hookSummary,
  isObj,
  mediaFile,
  num,
  stepChips,
  str,
  stripDeep,
  stripUrlUserinfo,
  transitionWords,
  tutorialWords,
} from './block-words.js';
import type { EndCardBlock, EntryBlock, HookBlock, HookFlag, ScenarioBlocks, ScenarioBlocksOptions, ScenePageBlock, StepBlock, VideoBlock } from './blocks-model.js';
import type { Node } from 'yaml';
import { destructiveReason, hookApprovalReason } from './destructive.js';
import type { IssuePath } from './issues.js';
import { scenePageEntries } from './pages.js';
import { stepGuard, stepsDashWhy, stepsLockedWhy } from './step-edits.js';
import { stepFormValues } from './step-forms.js';
import type { StepFormValues } from './step-forms.js';
import { parseScenario } from './scenario.js';
import { isSceneValue, scenarioIdentityOfValue } from './step-match.js';
import type { SceneIdentity } from './step-match.js';
import { normalizeStep, stepActionKeys } from './steps.js';
import { plainTarget } from './targets.js';
import type { ScenePages } from './types/language.js';
import type { HookStep } from './types/hooks.js';
import type { ValidationIssue } from './issues.js';
import { parseYaml } from './validation/yaml-source.js';
import { errorMessage } from './util.js';

export { topCommentWords } from './block-nodes.js';
export * from './blocks-model.js';
export { actionCategory, actionLabel, hookSummary, stepChips, stripUrlUserinfo } from './block-words.js';

// ── scenarioBlocks ──────────────────────────────────────────────────────────

function emptyVideo(): VideoBlock {
  return { intro: { mode: 'theme' }, outro: { mode: 'theme' } };
}

function endCard(v: unknown, outro: boolean): EndCardBlock {
  if (v === false) return { mode: 'off' };
  if (!isObj(v)) return { mode: 'theme' };
  const file = mediaFile(v);
  const out: EndCardBlock = {
    mode: 'custom',
    ...(str(v.component) !== undefined ? { component: v.component as string } : {}),
    ...(file ? { file } : {}),
    ...(num(v.duration) !== undefined ? { duration: v.duration as number } : {}),
    ...(outro && str(v.tagline) !== undefined ? { tagline: v.tagline as string } : {}),
    ...(outro && str(v.url) !== undefined ? { url: stripUrlUserinfo(v.url as string) } : {}),
  };
  return Object.keys(out).length === 1 ? { mode: 'theme' } : out;
}

function videoBlock(sc: Record<string, unknown>, src: Src): VideoBlock {
  const v = emptyVideo();
  if (str(sc.video) !== undefined) v.name = sc.video as string;
  if (isObj(sc.title))
    v.title = { ...(str(sc.title.kicker) !== undefined ? { kicker: sc.title.kicker as string } : {}), ...(str(sc.title.text) !== undefined ? { text: sc.title.text as string } : {}) };
  if (str(sc.env) !== undefined) v.env = sc.env as string;
  if (str(sc.template) !== undefined) v.template = sc.template as string;
  if (str(sc.frame) !== undefined) v.frame = sc.frame as string;
  v.intro = endCard(sc.intro, false);
  v.outro = endCard(sc.outro, true);
  if (isObj(sc.music)) {
    const m = sc.music;
    v.music = {
      ...(str(m.file) !== undefined ? { file: m.file as string } : {}),
      ...(num(m.volume) !== undefined ? { volume: m.volume as number } : {}),
      ...(num(m.duck) !== undefined ? { duck: m.duck as number } : {}),
      ...(typeof m.loop === 'boolean' ? { loop: m.loop } : {}),
    };
  }
  const tutorial = tutorialWords(sc.tutorial);
  if (tutorial) v.tutorial = tutorial;
  if (sc.clock === false) v.clock = 'off';
  else if (typeof sc.clock === 'string') v.clock = sc.clock;
  else if (isObj(sc.clock) && str(sc.clock.at) !== undefined) v.clock = `${sc.clock.at}${sc.clock.freeze === true ? ' (frozen)' : ''}`;
  if (isObj(sc.capture)) {
    const c = sc.capture;
    const capture = {
      ...(num(c.width) !== undefined ? { width: c.width as number } : {}),
      ...(num(c.height) !== undefined ? { height: c.height as number } : {}),
      ...(num(c.fps) !== undefined ? { fps: c.fps as number } : {}),
      ...(num(c.scale) !== undefined ? { scale: c.scale as number } : {}),
      ...(typeof c.keep_frames === 'boolean' ? { keep_frames: c.keep_frames } : {}),
    };
    if (Object.keys(capture).length) v.capture = capture;
  }
  if (isObj(sc.pacing) && Object.keys(sc.pacing).length) v.pacing = Object.keys(sc.pacing);
  if (isObj(sc.vars) && Object.keys(sc.vars).length) v.vars = Object.keys(sc.vars);
  if (Array.isArray(sc.mocks)) v.mocks = sc.mocks.length;
  // The file's top comment: the document's own, or (no blank line before the first key) that key's.
  const doc = src.yaml.doc;
  const first = isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  const ownTop = typeof doc.commentBefore === 'string' && doc.commentBefore !== '';
  const top = ownTop ? doc.commentBefore : first && typeof first === 'object' ? (first as Node).commentBefore : undefined;
  if (typeof top === 'string' && top !== '') {
    const words = topCommentWords(top);
    if (words !== undefined) v.comment = words;
    // Its lines in the file (the editor edits the comment as written): from line 1 to the line before the first key.
    const firstStart = first && typeof first === 'object' ? (first as Node).range?.[0] : undefined;
    const lc = src.yaml.lineCounter;
    const end = firstStart !== undefined ? lc.linePos(firstStart).line - 1 : top.split('\n').length;
    if (end >= 1) v.comment_lines = { line: 1, end_line: end };
  }
  return v;
}

/** The named hooks (`hooks:`): each entry of each name, in the file's order, as a block of phase `step`. */
function namedHookBlocks(map: unknown, at: At, src: Src, o: ScenarioBlocksOptions): HookBlock[] {
  if (!isObj(map)) return [];
  return Object.entries(map).flatMap(([name, v]) => {
    const one = childAt(at, name);
    // One entry (not a list): its block has the range of the name's value.
    const range = rangeOf(one, src);
    const blocks = Array.isArray(v) ? hookBlocks('step', v, one, src, o) : hookBlocks('step', [v], { aliased: one.aliased }, src, o).map((b) => ({ ...b, ...(range ? { range } : {}) }));
    return blocks.map((b) => ({ ...b, hook: name, name: b.name ?? name }));
  });
}

function hookBlocks(phase: 'setup' | 'teardown' | 'step', list: unknown, seq: At, src: Src, o: ScenarioBlocksOptions): HookBlock[] {
  if (!Array.isArray(list)) return [];
  return list.map((hook, index) => {
    const at = childAt(seq, index);
    const { kind, summary, rollback } = hookSummary(hook);
    const h = isObj(hook) ? hook : {};
    const flags: HookFlag[] = [];
    let destructive: string | null = null;
    try {
      destructive = kind ? destructiveReason(hook as HookStep, o.hookFiles ?? {}) : null;
    } catch {
      /* malformed: validation reports it */
    }
    if (destructive) flags.push({ kind: 'destructive', label: `destructive: ${destructive}` });
    if (rollback !== undefined) flags.push({ kind: 'rollback', label: 'with rollback' });
    if (h.confirm === true) flags.push({ kind: 'confirm', label: 'confirm' });
    if (h.optional === true) flags.push({ kind: 'optional', label: 'optional' });
    if (h.writes === false) flags.push({ kind: 'reads_only', label: 'reads only (writes: false)' });
    // Every hook of a scenario file counts as the agent's for work it submits (trust `mcp`).
    const needs = kind ? hookApprovalReason(hook as HookStep, phase, { ...(o.hookFiles ?? {}), agentWritten: true }) : null;
    const comment = commentOf(seq, at, index);
    const range = rangeOf(at, src);
    return {
      phase,
      index,
      ...(kind ? { kind } : {}),
      ...(str(h.name) !== undefined ? { name: h.name as string } : {}),
      summary,
      ...(rollback !== undefined ? { rollback } : {}),
      ...(needs ? { needs_person: needs } : {}),
      flags,
      ...(comment !== undefined ? { comment } : {}),
      ...(range ? { range } : {}),
      ...(at.aliased ? { aliased: true as const } : {}),
      issues: [],
    };
  });
}

/** A step's form values as a block field (absent when a form does not edit it). */
function withForm(raw: unknown): { form?: StepFormValues } {
  const form = stepFormValues(raw);
  return form ? { form } : {};
}

/** What every step of one scene shares: its id, its steps' node, the source, whether it is irreversible, why its steps are locked. */
interface StepBlockScene {
  sceneId: string;
  seq: At;
  src: Src;
  sceneIrreversible: boolean;
  stepsLocked: string | undefined;
}

function stepBlock(raw: unknown, index: number, scene: StepBlockScene): StepBlock {
  const { sceneId, seq, src, sceneIrreversible, stepsLocked } = scene;
  const at = childAt(seq, index);
  const comment = commentOf(seq, at, index);
  const range = rangeOf(at, src);
  const locked = stepsLocked ?? (at.aliased ? 'written as a YAML alias: edit it in the YAML view' : undefined);
  const base = {
    key: `${sceneId}.${index}`,
    index,
    chips: stepChips(raw, { sceneIrreversible }),
    occurrence: 0,
    ...(range ? { range } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(at.aliased ? { aliased: true as const } : {}),
    guard: stepGuard(raw),
    ...(locked !== undefined ? { locked } : {}),
    ...withForm(raw),
    issues: [] as ValidationIssue[],
  };
  if (!isObj(raw)) return { ...base, category: 'unknown', label: 'not a step (a step is a mapping with one action)' };
  const id = str(raw.id);
  const keys = stepActionKeys(raw);
  if (keys.length !== 1) {
    return { ...base, ...(id !== undefined ? { id } : {}), category: 'unknown', label: keys.length ? `several actions (${keys.join(', ')})` : 'no action' };
  }
  const action = keys[0];
  let args: unknown;
  let words: { target?: string; summary?: string } = {};
  try {
    args = normalizeStep(raw as Parameters<typeof normalizeStep>[0], index).args;
    words = describeStep(action, args);
  } catch {
    /* malformed arguments: validation reports them; the step still shows its action */
  }
  return {
    ...base,
    ...(id !== undefined ? { id } : {}),
    action,
    category: actionCategory(action),
    label: actionLabel(action),
    ...(words.target !== undefined ? { target: stripUrlUserinfo(words.target) } : {}),
    ...(words.summary !== undefined ? { summary: stripUrlUserinfo(words.summary) } : {}),
    ...(args !== undefined ? { args: stripDeep(args) } : {}),
  };
}

function pagesOf(pages: unknown): ScenePageBlock[] | undefined {
  if (pages === undefined || pages === null) return undefined;
  if (!Array.isArray(pages) && !isObj(pages)) return undefined;
  let entries: ReturnType<typeof scenePageEntries>;
  try {
    entries = scenePageEntries(pages as ScenePages);
  } catch {
    return undefined;
  }
  return entries.map(({ id, spec }) => {
    const s = isObj(spec) ? spec : {};
    const viewport = typeof s.viewport === 'string' ? s.viewport : isObj(s.viewport) ? `${String(s.viewport.width)} × ${String(s.viewport.height)}` : undefined;
    return {
      id: String(id),
      ...(str(s.page) !== undefined ? { page: s.page as string } : {}),
      ...(str(s.open) !== undefined ? { open: stripUrlUserinfo(s.open as string) } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
      ...(str(s.label) !== undefined ? { label: s.label as string } : {}),
      ...(str(s.persona) !== undefined ? { persona: s.persona as string } : {}),
    };
  });
}

function entryBlock(entry: unknown, index: number, scenes: At, src: Src, page: string | undefined): EntryBlock {
  const at = childAt(scenes, index);
  const comment = commentOf(scenes, at, index);
  const range = rangeOf(at, src);
  const where = {
    index,
    ...(comment !== undefined ? { comment } : {}),
    ...(range ? { range } : {}),
    ...(at.aliased ? { aliased: true as const } : {}),
    issues: [] as ValidationIssue[],
  };
  if (!isObj(entry)) return { type: 'unknown', ...where };
  const id = str(entry.id);
  if (entry.interstitial !== undefined) {
    const s = isObj(entry.interstitial) ? entry.interstitial : {};
    const file = mediaFile(s);
    return {
      type: 'interstitial',
      ...where,
      id: id ?? `interstitial-${index}`,
      ...(str(s.text) !== undefined ? { text: s.text as string } : {}),
      ...(str(s.kicker) !== undefined ? { kicker: s.kicker as string } : {}),
      ...(num(s.duration) !== undefined ? { duration: s.duration as number } : {}),
      ...(str(s.component) !== undefined ? { component: s.component as string } : {}),
      ...(file ? { file } : {}),
    };
  }
  if (entry.card !== undefined) {
    const s = isObj(entry.card) ? entry.card : {};
    const file = mediaFile(s);
    const slots = isObj(s.slots)
      ? Object.fromEntries(
          Object.entries(s.slots)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, stripUrlUserinfo(v as string)]),
        )
      : undefined;
    const transition = transitionWords(s.transition);
    return {
      type: 'card',
      ...where,
      id: id ?? `card-${index}`,
      ...(str(s.component) !== undefined ? { component: s.component as string } : {}),
      ...(slots && Object.keys(slots).length ? { slots } : {}),
      ...(s.params !== undefined ? { params: stripDeep(s.params) } : {}),
      ...(file ? { file } : {}),
      ...(num(s.duration) !== undefined ? { duration: s.duration as number } : {}),
      ...(transition !== undefined ? { transition } : {}),
    };
  }
  if (!isSceneValue(entry)) return { type: 'unknown', ...where };
  const sceneId = entry.id;
  const irreversible = entry.irreversible === true;
  const stepsAt = childAt(at, 'steps');
  const stepsLocked = stepsLockedWhy(stepsAt.node, stepsAt.aliased) ?? stepsDashWhy(src.text, stepsAt.node);
  const stepScene: StepBlockScene = { sceneId, seq: stepsAt, src, sceneIrreversible: irreversible, stepsLocked };
  const steps = (Array.isArray(entry.steps) ? entry.steps : []).map((raw, i) => stepBlock(raw, i, stepScene));
  const pages = pagesOf(entry.pages);
  const open = str(entry.open);
  const caption = captionOf(entry.caption);
  const cursor = entry.cursor === undefined ? undefined : typeof entry.cursor === 'string' && (entry.cursor === 'auto' || entry.cursor === 'keep') ? entry.cursor : plainTarget(entry.cursor);
  const transition = transitionWords(entry.transition);
  const tutorial = tutorialWords(entry.tutorial);
  const multi = pages !== undefined;
  return {
    type: 'scene',
    ...where,
    id: sceneId,
    ...(!multi && page !== undefined ? { page } : {}),
    ...(!multi && page !== undefined && str(entry.page) === undefined ? { page_inherited: true as const } : {}),
    ...(pages ? { pages } : {}),
    ...(open !== undefined ? { open: stripUrlUserinfo(open) } : {}),
    continues: multi ? pages.every((p) => p.open === undefined) : open === undefined,
    ...(str(entry.persona) !== undefined ? { persona: entry.persona as string } : {}),
    ...(caption ? { caption } : {}),
    ...(num(entry.speed) !== undefined ? { speed: entry.speed as number } : {}),
    ...(num(entry.still) !== undefined ? { still: entry.still as number } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(transition !== undefined ? { transition } : {}),
    ...(str(entry.frame) !== undefined ? { frame: entry.frame as string } : {}),
    ...(tutorial !== undefined ? { tutorial } : {}),
    ...(irreversible ? { irreversible: true as const } : {}),
    ...(entry.skip === true ? { skip: true as const } : {}),
    ...(entry.offscreen === true ? { offscreen: true as const } : {}),
    ...(str(entry.note) !== undefined ? { note: entry.note as string } : {}),
    context: '',
    steps,
    ...(stepsLocked !== undefined ? { steps_locked: stepsLocked } : {}),
  };
}

/** Put each issue on the block its path points into (a step, an entry, a hook), else on the scenario. */
function attachIssues(b: ScenarioBlocks, issues: readonly ValidationIssue[]): void {
  for (const issue of issues) {
    const p: IssuePath = Array.isArray(issue.path) ? issue.path : [];
    if (p[0] === 'scenes' && typeof p[1] === 'number' && b.entries[p[1]]) {
      const entry = b.entries[p[1]];
      if (entry.type === 'scene' && p[2] === 'steps' && typeof p[3] === 'number' && entry.steps[p[3]]) entry.steps[p[3]].issues.push(issue);
      else entry.issues.push(issue);
      continue;
    }
    if ((p[0] === 'setup' || p[0] === 'teardown') && typeof p[1] === 'number' && b.hooks[p[0]][p[1]]) {
      b.hooks[p[0]][p[1]].issues.push(issue);
      continue;
    }
    if (p[0] === 'hooks' && typeof p[1] === 'string') {
      const named = b.hooks.named.filter((h) => h.hook === p[1]);
      const h = named[typeof p[2] === 'number' ? p[2] : 0];
      if (h) {
        h.issues.push(issue);
        continue;
      }
    }
    b.issues.push(issue);
  }
}

/**
 * A scenario's text as blocks (see the file's comment). Never throws: an unexpected failure gives no blocks and an
 * issue saying so.
 */
export function scenarioBlocks(text: string, o: ScenarioBlocksOptions = {}): ScenarioBlocks {
  const empty = (issues: ValidationIssue[]): ScenarioBlocks => ({ parsed: false, video: emptyVideo(), hooks: { setup: [], teardown: [], named: [] }, entries: [], step_count: 0, issues });
  try {
    const parsed = parseYaml(text);
    const issues = o.issues ? [...o.issues] : parseScenario(text).issues;
    if (parsed.value === undefined) {
      // Syntax errors (they are among the validation issues; when the caller's are not, the parser's own say it).
      return empty(issues.length ? issues : parsed.issues.map((i) => ({ severity: i.severity, path: i.path, message: i.message, ...(i.line !== undefined ? { line: i.line, col: i.col } : {}) })));
    }
    const src: Src = { yaml: parsed.source, text };
    const root: At = { node: parsed.source.doc.contents as Node | undefined, aliased: false };
    const sc = isObj(parsed.value) ? parsed.value : {};
    const scenes = new Map<number, { page: string | undefined; identity: SceneIdentity }>();
    scenarioIdentityOfValue(sc, (i, page, identity) => scenes.set(i, { page, identity }));
    const scenesAt = childAt(root, 'scenes');
    const entries = (Array.isArray(sc.scenes) ? sc.scenes : []).map((entry, i) => entryBlock(entry, i, scenesAt, src, scenes.get(i)?.page));
    let stepCount = 0;
    entries.forEach((e, i) => {
      const id = scenes.get(i)?.identity;
      if (e.type !== 'scene' || !id) return;
      stepCount += e.steps.length;
      e.context = id.context;
      e.steps.forEach((s, j) => {
        const x = id.steps[j];
        if (x?.fp) s.fingerprint = x.fp;
        if (x?.picture) s.picture = x.picture;
        s.occurrence = x?.n ?? 0;
      });
    });
    const out: ScenarioBlocks = {
      parsed: true,
      video: videoBlock(sc, src),
      hooks: {
        setup: hookBlocks('setup', sc.setup, childAt(root, 'setup'), src, o),
        teardown: hookBlocks('teardown', sc.teardown, childAt(root, 'teardown'), src, o),
        named: namedHookBlocks(sc.hooks, childAt(root, 'hooks'), src, o),
      },
      entries,
      step_count: stepCount,
      issues: [],
    };
    attachIssues(out, issues);
    return out;
  } catch (e) {
    return empty([{ severity: 'error', path: [], message: `the scenario could not be read as blocks: ${errorMessage(e)}` }]);
  }
}
