/**
 * The draft generator: a recording's events → a draft scenario. Pure (no I/O, no clock): the CLI, the `record` job and
 * any later source of events (BL-25) share it. The event model is recording-events.ts.
 */
import { Document, isMap, isPair, isScalar, isSeq, visit } from 'yaml';
import { applyChoices, applyInserts, elementsBySeq } from './recording-annotate.js';
import type { LateIssue } from './recording-annotate.js';
import { RECORD_WRITE_WINDOW_MS } from './recording-draft.js';
import type { DraftContext, DraftIssue, DraftPlaceholder, DraftScene, DraftSource, DraftWrite, El, EvOf, KeptScenes, Raised, RecordingDraft, Step, Walked } from './recording-draft.js';
import { RECORDING_VERSION } from './recording-events.js';
import type { RecordedEvent } from './recording-events.js';
import { TEMPLATE, hidden, pathUnderPage, recordedAlternatives, sceneIdOf } from './recording-targets.js';
import { EventWalk } from './recording-walk.js';
import type { RecordAnnotations, RecordInsert } from './record-annotations.js';
import { parseScenario } from './scenario.js';

export {
  RECORDED_KEYS,
  RECORDED_SHORTCUT_KEY_RE,
  RECORDING_VERSION,
  RECORD_TEXT_MAX,
  RecordedElementSchema,
  RecordedEventSchema,
  SECRET_FIELD_KINDS,
} from './recording-events.js';
export type { RecordedElement, RecordedEvent, SecretFieldKind } from './recording-events.js';
export { RECORD_NAV_WINDOW_MS, RECORD_SCROLL_MIN_PX, RECORD_SECRET_PLACEHOLDER, RECORD_WAIT_GAP_MS, RECORD_WRITE_WINDOW_MS } from './recording-draft.js';
export type { DraftContext, DraftIssue, DraftPlaceholder, DraftSource, DraftWrite, RecordingDraft } from './recording-draft.js';
export { pathUnderPage, recordedAlternatives } from './recording-targets.js';

/**
 * Turn a recording's events (core RecordedEvent, in `seq` order) into a draft scenario: click, type (always with
 * `into`; clear / enter), press, select, pick (closed by escape / outside / none), menu (with its confirm), drop_file
 * (a placeholder file), scroll (to the next target when it moved at least RECORD_SCROLL_MIN_PX), a `wait_for` on the
 * next target when it appeared after a pause; scenes split where the page changed (`open:` only when the address bar
 * or nothing the person did changed it); presses on nothing dropped; captions empty; no holds; secret fields typed as
 * `{{vars.<kind>_N}}`. A recorded string holding `{{` (typed text, a name, an option) never reaches the draft: its step
 * is left out (`template_text`); nor one holding a hidden character (`hidden_text`: the set no Studio write adds).
 * Every event's page text is untrusted; issue messages never quote it. Issues come in the order they were raised, each
 * with its scene and step.
 *
 * Studio annotations (record-annotations.ts), optional — without them (or empty) the draft is exactly the
 * recorder's:
 * - target choices: every fold and merge decision compares the recorded targets; a pick replaces the step's main target
 *   only when the draft is emitted (the latest of the step's target events that has a choice wins), and the
 *   generator's own `wait_for` / `scroll` before that action follow it;
 * - inserts at an event position: a hold or wait_for step goes before the first action whose latest event is after the
 *   position — after that action's helpers that ended at or before the position (a scroll made before the insert), before
 *   the others — else at the end of the scene current at it; one placed after the recorder's wait (`row: 'wait'`) goes
 *   right after that wait, one placed after another insert (`after_insert`) right after it; a caption, mark or camera
 *   goes on the action step — pending while the recording goes on, on the last action with `insert_moved` once it is
 *   over (`final`: by default, the events hold a `stop`).
 * Two typing events on the same field with nothing between them (a visit to the Studio blurred the window) are one
 * typing step — a secret one keeps one placeholder — unless an insert was placed between them; a write that follows
 * either part is the step's. `aliases: false` (every Studio recording's draft): no YAML anchor or alias — a target
 * shared by a helper and its action is written twice, so the block editor can delete or duplicate a helper.
 */
export function draftFromRecording(events: readonly RecordedEvent[], ctx: DraftContext, annotations?: RecordAnnotations | null, opts: { final?: boolean; aliases?: boolean } = {}): RecordingDraft {
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const final = opts.final ?? evs.some((e) => e.kind === 'stop');
  const choices = annotations?.choices ?? {};
  const inserts: readonly RecordInsert[] = annotations?.inserts ?? [];
  const writes = evs.filter((e): e is EvOf<'write'> => e.kind === 'write');
  const stream = evs.filter((e) => e.kind !== 'write');
  // 1. The event walk: scenes and their steps, each step's sources, the issues raised on the way.
  const walk = new EventWalk(ctx, stream, inserts);
  walk.run();
  if (walk.scene !== null) walk.flushScroll(stream.at(-1) ?? evs[0], null);
  const d: Walked = walk;
  const elAt = elementsBySeq(evs);
  // 2. The Studio annotations: target picks, then inserts.
  applyChoices(d, choices, elAt);
  const { pending, late } = applyInserts(d, inserts, final);
  // 3. The scenes kept, their ids, where each step is.
  const kept = keepScenes(d, ctx);
  // 4. Every write to the step that caused it; 5. the issues, located.
  const { writes: outWrites, firstWrite, steps } = attributeWrites(d, kept, writes);
  const issues = locateIssues(d, kept, late);
  // 6. The scenario, its YAML (checked), where each step came from, the secret placeholders.
  const value = scenarioOf(ctx, d.vars, kept);
  d.stats.scenes = kept.scenes.length;
  d.stats.steps = steps;
  const yaml = draftYaml(value, { annotated: inserts.length > 0 || Object.keys(choices).length > 0, aliases: opts.aliases !== false });
  for (const x of parseScenario(yaml).issues) {
    if (x.severity === 'error') issues.push(draftInvalidIssue(x, kept.ids, 'the draft does not validate (a recorder bug)'));
  }
  const sources = sourcesOf(d, kept, elAt);
  const placeholders = d.secretSteps.flatMap((x): DraftPlaceholder[] => {
    const at = kept.where.get(x.step);
    return at ? [{ name: x.name, kind: x.kind, project_var: x.project_var, ...at }] : [];
  });
  return { scenario: value, yaml, issues, writes: outWrites, firstWrite, stats: d.stats, sources, pending, placeholders };
}

/** Empty scenes go (a page opened and left without an action), except a lone one; the ids, unique; where each step is. */
function keepScenes(d: Walked, ctx: DraftContext): KeptScenes {
  const { scenes } = d;
  let kept = scenes.filter((s) => s.steps.length > 0);
  if (kept.length === 0 && scenes.length > 0) kept = [scenes[0]];
  const used = new Map<string, number>();
  const ids = kept.map((s) => {
    const base = sceneIdOf(s.open?.split(/[?#]/)[0] ?? pathUnderPage(s.path, s.page, ctx.pages));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
  const where = new Map<Step, { scene: string; step: number }>();
  kept.forEach((s, si) => s.steps.forEach((x, k) => where.set(x.step, { scene: ids[si], step: k })));
  return { scenes: kept, ids, where, all: scenes };
}

/**
 * Every write (any host), to the step that caused it (the last one that ended within the window: its note); the first
 * step followed by a write that went through — however long after — bounds the check replay. A write no step caused
 * raises an issue. The draft's step count with it.
 */
function attributeWrites(d: Walked, kept: KeptScenes, writes: readonly EvOf<'write'>[]): { writes: DraftWrite[]; firstWrite: RecordingDraft['firstWrite']; steps: number } {
  const flat = kept.scenes.flatMap((s, si) => s.steps.map((x, k) => ({ ...x, scene: kept.ids[si], index: k })));
  const outWrites: DraftWrite[] = [];
  let firstWrite: RecordingDraft['firstWrite'] = null;
  for (const w of writes) {
    let prev: (typeof flat)[number] | undefined;
    for (const s of flat) if (s.t1 <= w.t && d.meta.get(s.step)?.role !== 'insert') prev = s;
    // A merged typing step ended at each of its parts: the window counts from the latest one before the write.
    const end = prev ? Math.max(...(prev.tw ?? [prev.t1]).filter((t) => t <= w.t)) : 0;
    const by = prev && w.t - end <= RECORD_WRITE_WINDOW_MS ? prev : undefined;
    const through = w.outcome !== 'blocked' && w.outcome !== 'mocked';
    if (through && prev && !firstWrite) firstWrite = { scene: prev.scene, step: prev.index };
    outWrites.push({ label: w.label, outcome: w.outcome, scene: by?.scene ?? null, step: by?.index ?? null });
    if (!by) {
      d.raised.push({
        issue: { severity: 'info', code: 'ambient_write', message: 'the page sent a write no action caused within 2 s (a poll, telemetry, a slow answer): not attributed to a step' },
        t: w.t,
        ...(prev ? { at: { scene: prev.scene, step: prev.index + 1 } } : { scene: null, after: null }),
      });
      continue;
    }
    const label = hidden(w.label) ? 'a request whose address holds a hidden character' : w.label.replaceAll(TEMPLATE, '%7B%7B');
    const what = w.outcome === 'blocked' ? `${label} (stopped: read-only)` : w.outcome === 'mocked' ? `${label} (answered by a mock: read-only)` : label;
    const before = typeof by.step.note === 'string' ? `${by.step.note}; ` : '';
    by.step.note = `${before}sends ${what}`;
  }
  return { writes: outWrites, firstWrite, steps: flat.length };
}

/** The issues, in the order they were raised, each located; then the late ones (inserts). */
function locateIssues(d: Walked, kept: KeptScenes, late: readonly LateIssue[]): DraftIssue[] {
  const { ids, where, all: scenes } = kept;
  const ks = kept.scenes;
  const issues: DraftIssue[] = [];
  const keptIndex = (s: DraftScene | null | undefined): number => (s ? ks.indexOf(s) : -1);
  const locate = (r: Raised): { scene: string; step: number } | null => {
    if (r.at) return r.at;
    if (r.step) return where.get(r.step) ?? null;
    if (ks.length === 0) return null;
    if (!r.scene) return { scene: ids[0], step: 0 };
    let si = keptIndex(r.scene);
    if (si >= 0) {
      const k = r.after ? ks[si].steps.findIndex((x) => x.step === r.after) : -1;
      return { scene: ids[si], step: r.after ? (k >= 0 ? k + 1 : ks[si].steps.length) : 0 };
    }
    // An empty scene (dropped): the next kept one's start, else the end of the last one before it.
    const from = scenes.indexOf(r.scene);
    si = ks.findIndex((s) => scenes.indexOf(s) > from);
    if (si >= 0) return { scene: ids[si], step: 0 };
    return { scene: ids[ks.length - 1], step: ks[ks.length - 1].steps.length };
  };
  d.raised.sort((a, b) => a.t - b.t);
  for (const r of d.raised) {
    // A step's issue whose step is not in the draft (it was left out) goes with it.
    if (r.step && !where.has(r.step)) continue;
    const at = locate(r);
    issues.push({ ...r.issue, ...(at ?? {}) });
  }
  for (const l of late) {
    const at = l.step ? where.get(l.step) : undefined;
    issues.push({ ...l.issue, ...(at ?? {}) });
  }
  return issues;
}

/** The scenario value: its name, env, vars, and each kept scene (its page, `open:`, a first scene's persona, its steps). */
function scenarioOf(ctx: DraftContext, vars: Record<string, string>, kept: KeptScenes): Record<string, unknown> {
  const { scenes, ids } = kept;
  const value: Record<string, unknown> = { version: RECORDING_VERSION, video: ctx.name };
  if (!ctx.envIsDefault) value.env = ctx.env;
  if (Object.keys(vars).length) value.vars = vars;
  value.scenes = scenes.map((s, si) => {
    const out: Record<string, unknown> = { id: ids[si] };
    if (si === 0 || s.open !== undefined) {
      if (si === 0 || s.page !== scenes[si - 1].page) out.page = s.page;
      if (s.open !== undefined) out.open = s.open;
    }
    if (si === 0) {
      const def = ctx.defaultPersonas?.[s.page];
      if (def !== undefined && (ctx.persona ?? null) !== def) out.persona = ctx.persona ?? 'none';
    }
    out.steps = s.steps.map((x) => x.step);
    return out;
  });
  return value;
}

/**
 * The draft's YAML: its header comment (arranged in the Studio when it was `annotated`), each step's maps and lists in
 * flow style. A Studio recording's draft holds no anchor or alias (`aliases: false`): the shared targets are written twice.
 */
function draftYaml(value: Record<string, unknown>, o: { annotated: boolean; aliases: boolean }): string {
  const doc = new Document(value, { aliasDuplicateObjects: o.aliases });
  doc.commentBefore = (
    !o.annotated
      ? [' Recorded with retake record: a draft. Captions are empty and nothing is held — add them, check the steps flagged', " in the recording's report (page_inspect), then run_dry."]
      : [" Recorded with retake record and arranged in the Studio: a draft. Check the steps flagged in the recording's", ' report (page_inspect), then run_dry.']
  ).join('\n');
  visit(doc, {
    Pair(_, pair) {
      if (!isPair(pair) || !isScalar(pair.key) || pair.key.value !== 'steps' || !isSeq(pair.value)) return;
      for (const item of pair.value.items) {
        if (!isMap(item)) continue;
        for (const p of item.items) if (isPair(p) && (isMap(p.value) || isSeq(p.value))) p.value.flow = true;
      }
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Where each step of the draft came from, in draft order (DraftSource). */
function sourcesOf(d: Walked, kept: KeptScenes, elAt: (seq: number) => El | null): DraftSource[] {
  const sources: DraftSource[] = [];
  kept.scenes.forEach((sc, si) =>
    sc.steps.forEach(({ step }, k) => {
      const m = d.meta.get(step)!;
      const targets = m.site && m.targetSeqs ? [...m.targetSeqs] : undefined;
      const offer = targets ? [...targets].sort((x, y) => y - x).find((q) => recordedAlternatives(elAt(q)).length > 0) : undefined;
      const helper = m.role === 'helper' ? ('wait_for' in step ? 'wait' : 'scroll') : undefined;
      sources.push({
        scene: kept.ids[si],
        step: k,
        seqs: [m.seqs[0], m.seqs[1]],
        role: m.role,
        ...(helper ? { helper } : {}),
        row: m.role === 'insert' ? `i:${m.insert}` : helper === 'wait' ? `w${m.seqs[1]}` : helper === 'scroll' ? `s${m.seqs[0]}` : `a${m.seqs[0]}`,
        ...(targets ? { target_seqs: targets } : {}),
        ...(offer !== undefined ? { target_seq: offer } : {}),
        ...(m.chosen ? { chosen: { ...m.chosen } } : {}),
        ...(m.insert !== undefined ? { insert: m.insert } : {}),
        ...(m.modifiers?.length ? { modifiers: [...m.modifiers] } : {}),
      });
    }),
  );
  return sources;
}

/**
 * Where a step of the recorder's own draft (the one the check replays: no picks, no inserts) is on screen: the row of
 * `shown` (the draft with the Studio's annotations) that came from the same events in the same role, or null when it
 * is not there any more (a wait an insert replaced).
 */
export function shownStep(bare: readonly DraftSource[], shown: readonly DraftSource[], at: { scene: string; step: number }): { scene: string; step: number } | null {
  const b = bare.find((x) => x.scene === at.scene && x.step === at.step);
  const s = b ? shown.find((x) => x.row === b.row) : undefined;
  return s ? { scene: s.scene, step: s.step } : null;
}

/**
 * An `invalid` issue from a validation error of a draft: a fixed message with its line and, from its path, its scene
 * and step — never the validator's own message (it may quote the draft's page text).
 */
export function draftInvalidIssue(x: { path: Array<string | number>; line?: number }, sceneIds: readonly string[], what: string): DraftIssue {
  const si = x.path[0] === 'scenes' && typeof x.path[1] === 'number' ? x.path[1] : -1;
  const k = si >= 0 && x.path[2] === 'steps' && typeof x.path[3] === 'number' ? x.path[3] : -1;
  const scene = si >= 0 ? sceneIds[si] : undefined;
  return {
    severity: 'error',
    code: 'invalid',
    message: `${what}${x.line !== undefined ? ` (line ${x.line})` : ''}: run validate on the draft to see why`,
    ...(scene !== undefined ? { scene, ...(k >= 0 ? { step: k } : {}) } : {}),
  };
}
