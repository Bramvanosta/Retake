/** The Studio's annotations on a walked draft (recording.ts): target picks, then inserted steps and modifiers. */
import { sameTarget } from './inspect.js';
import type { DraftScene, El, Ev, Raw, Step, StepMeta, Walked } from './recording-draft.js';
import { TEMPLATE, recordedAlternatives } from './recording-targets.js';
import type { RecordInsert } from './record-annotations.js';
import { normalizeTarget } from './targets.js';
import type { TargetSpec } from './types/language.js';

export function elementsBySeq(evs: readonly Ev[]): (seq: number) => El | null {
  const bySeq = new Map(evs.map((e) => [e.seq, e] as const));
  return (seq) => {
    const e = bySeq.get(seq);
    return e && 'el' in e ? e.el : null;
  };
}

export const sameSpec = (a: TargetSpec, b: TargetSpec) => sameTarget(normalizeTarget(a), normalizeTarget(b));

/**
 * Picks, substituted now that every fold and merge decision compared the recorded targets: the latest of a
 * step's target events that has a choice wins; the generator's own wait_for / scroll before that action follow it.
 */
export function applyChoices(d: Walked, choices: Record<string, number>, elAt: (seq: number) => El | null): void {
  if (Object.keys(choices).length === 0) return;
  const { meta } = d;
  for (const sc of d.scenes) {
    for (const { step } of sc.steps) {
      const m = meta.get(step);
      if (!m?.site || !m.targetSeqs || m.target === undefined) continue;
      for (const seq of [...m.targetSeqs].sort((x, y) => y - x)) {
        if (!Object.hasOwn(choices, String(seq))) continue;
        const index = choices[String(seq)];
        const alt = index === 0 ? null : recordedAlternatives(elAt(seq)).find((x) => x.index === index);
        if (alt === undefined) continue;
        m.chosen = { seq, index };
        if (alt === null) break;
        writeTarget(step, m.site, alt.target);
        for (const [h, hm] of meta) if (hm.group === step && hm.role === 'helper') retarget(h, m.target, alt.target);
        m.emitted = alt.target;
        break;
      }
    }
  }
}

/** An action with the helpers the recorder put before it (contiguous, in scene order: helpers first). */
export interface StepGroup {
  head: Step;
  scene: DraftScene;
  steps: Step[];
  max: number;
}

/** An issue raised once the walk is over (inserts): after the walk's own, located by its step when it has one. */
export interface LateIssue {
  issue: Raw;
  step?: Step;
}

/** An insert placed as a step of its own (a hold or a wait_for). */
type StepInsert = Extract<RecordInsert, { kind: 'hold' | 'wait_for' }>;

/** Where the inserts go while they are placed (applyInserts), and what they raised. */
interface InsertPlacing {
  scenes: readonly DraftScene[];
  meta: Map<Step, StepMeta>;
  groups: StepGroup[];
  beforeStep: Map<Step, Step[]>;
  afterStep: Map<Step, Step[]>;
  atEnd: Map<DraftScene, Step[]>;
  /** Where each step insert went (an insert placed after it goes right after it), and the action it comes before. */
  placedAt: Map<string, { list: Step[]; step: Step; g?: StepGroup }>;
  removed: Set<Step>;
  applied: Map<Step, Map<string, string>>;
  pending: string[];
  late: LateIssue[];
  final: boolean;
}

/**
 * Inserts (see draftFromRecording): hold / wait_for steps where their anchor says, caption / mark / camera on the action
 * they come before. The ids of the inserts waiting for the next action, and the issues they raised.
 */
export function applyInserts(d: Walked, inserts: readonly RecordInsert[], final: boolean): { pending: string[]; late: LateIssue[] } {
  const pending: string[] = [];
  const late: LateIssue[] = [];
  if (inserts.length === 0) return { pending, late };
  const { scenes, meta } = d;
  const { groups, groupOf } = stepGroups(scenes, meta);
  const p: InsertPlacing = {
    scenes,
    meta,
    groups,
    beforeStep: new Map(),
    afterStep: new Map(),
    atEnd: new Map(),
    placedAt: new Map(),
    removed: new Set(),
    applied: new Map(),
    pending,
    late,
    final,
  };
  const order = inserts.map((x, k) => ({ x, k })).sort((p, q) => p.x.after_seq - q.x.after_seq || p.k - q.k);
  for (const { x } of order) {
    if (JSON.stringify(x).includes(TEMPLATE)) continue; // never a template (the annotations' schema refuses it too)
    // The anchor: after another insert (when it is still placed), after the recorder's wait before an action, else
    // the position — the action whose latest event comes after it. The row it was made on is gone: the position.
    const ref = x.after_insert !== undefined ? p.placedAt.get(x.after_insert) : undefined;
    const wait = ref ? undefined : x.row === 'wait' ? waitAt(p, x.after_seq) : undefined;
    const g = ref ? ref.g : wait ? groupOf.get(wait) : groups.find((y) => y.max > (x.row === 'wait' ? x.after_seq - 1 : x.after_seq));
    if (x.kind === 'hold' || x.kind === 'wait_for') placeStep(p, x, { ref, wait, g });
    else placeModifier(p, x, g);
  }
  spliceInserts(scenes, p);
  return { pending, late };
}

/** The scene current at event position `a`. */
function sceneAt(scenes: readonly DraftScene[], a: number): DraftScene | undefined {
  let at: DraftScene | undefined;
  for (const sc of scenes) if (sc.seq <= a) at = sc;
  return at ?? scenes[0];
}

/** The recorder's wait before the action at event `seq` (`row: 'wait'`: an insert placed right after it). */
function waitAt(p: InsertPlacing, seq: number): Step | undefined {
  for (const g of p.groups) {
    for (const st of g.steps) {
      const m = p.meta.get(st)!;
      if (st !== g.head && m.role === 'helper' && 'wait_for' in st && m.seqs[1] === seq) return st;
    }
  }
  return undefined;
}

function listIn<K>(map: Map<K, Step[]>, k: K): Step[] {
  let l = map.get(k);
  if (!l) map.set(k, (l = []));
  return l;
}

/** The step a hold / wait_for insert becomes (a wait for the next target replaces the recorder's own one). */
function insertedStep(p: InsertPlacing, x: StepInsert, g: StepGroup | undefined): Step {
  const { meta, removed, late } = p;
  let step: Step;
  if (x.kind === 'hold') step = { hold: x.seconds };
  else if (x.until === 'idle') step = { wait_for: { network_idle: true } };
  else if (x.until === 'text') step = { wait_for: { text: x.text } };
  else {
    const hm = g ? meta.get(g.head) : undefined;
    const t = hm?.emitted ?? hm?.target ?? (g ? fieldTarget(g.head) : undefined);
    if (!g || t === undefined) {
      step = { wait_for: { network_idle: true } };
      late.push({
        step,
        issue: {
          severity: 'info',
          code: 'insert_wait_idle',
          message: 'a wait for the next target you inserted: the next action has no target (or there is none yet), so the step waits for the page to be idle',
        },
      });
    } else {
      // The recorder's own wait for that target before the action: replaced by this one (its timeout kept).
      const auto = g.steps.find((st) => {
        const ym = meta.get(st);
        const w = st.wait_for as { target?: TargetSpec } | undefined;
        return st !== g.head && ym?.role === 'helper' && !removed.has(st) && w?.target !== undefined && sameSpec(w.target, t);
      });
      const timeout = auto ? (auto.wait_for as { timeout?: number }).timeout : undefined;
      step = { wait_for: { target: JSON.parse(JSON.stringify(t)) as TargetSpec, ...(timeout !== undefined ? { timeout } : {}) } };
      if (auto) {
        removed.add(auto);
        late.push({ step, issue: { severity: 'info', code: 'insert_replaced', message: 'the wait you inserted replaces the one the recorder put before this action (same target)' } });
      }
    }
  }
  return step;
}

/** A hold / wait_for insert, placed where its anchor says (another insert, the recorder's wait, an action, a scene's end). */
function placeStep(p: InsertPlacing, x: StepInsert, at: { ref: { list: Step[]; step: Step } | undefined; wait: Step | undefined; g: StepGroup | undefined }): void {
  const { meta } = p;
  const { ref, wait, g } = at;
  const step = insertedStep(p, x, g);
  meta.set(step, { seqs: [x.after_seq, x.after_seq], role: 'insert', insert: x.id });
  let list: Step[];
  if (ref) {
    list = ref.list;
    list.splice(list.indexOf(ref.step) + 1, 0, step);
  } else if (wait) {
    list = listIn(p.afterStep, wait);
    list.push(step);
  } else if (g) {
    // After the action's helpers that ended at or before the position (a scroll made before the insert), before
    // the others (the recorder's wait, made with the action).
    let anchor: Step | undefined;
    for (const st of g.steps) if (st !== g.head && meta.get(st)!.role === 'helper' && meta.get(st)!.seqs[1] <= x.after_seq) anchor = st;
    list = anchor ? listIn(p.afterStep, anchor) : listIn(p.beforeStep, g.steps[0]);
    list.push(step);
  } else {
    const sc = sceneAt(p.scenes, x.after_seq);
    if (!sc) {
      p.late.push({ issue: { severity: 'warning', code: 'insert_unplaced', message: `a ${x.kind} you inserted has no scene to go in (nothing was recorded): left out` } });
      return;
    }
    list = listIn(p.atEnd, sc);
    list.push(step);
  }
  p.placedAt.set(x.id, { list, step, ...(g ? { g } : {}) });
}

/** A caption, mark or camera insert: on the action it comes before (pending while the recording goes on). */
function placeModifier(p: InsertPlacing, x: Exclude<RecordInsert, StepInsert>, g: StepGroup | undefined): void {
  const { late } = p;
  let head = g?.head;
  if (head === undefined) {
    if (!p.final) {
      p.pending.push(x.id);
      return;
    }
    head = p.groups.at(-1)?.head;
    if (head === undefined) {
      late.push({ issue: { severity: 'warning', code: 'insert_unplaced', message: `a ${x.kind} you inserted has no step to go on (nothing was recorded): left out` } });
      return;
    }
    late.push({ step: head, issue: { severity: 'info', code: 'insert_moved', message: `a ${x.kind} you inserted for the next action had no action after it: it is on the last action` } });
  }
  const kinds = p.applied.get(head) ?? new Map<string, string>();
  p.applied.set(head, kinds);
  if (kinds.has(x.kind)) late.push({ step: head, issue: { severity: 'info', code: 'insert_replaced', message: `a later ${x.kind} you inserted replaces an earlier one on this step` } });
  kinds.set(x.kind, x.id);
  head[x.kind] = x.kind === 'caption' ? (x.kicker !== undefined ? { kicker: x.kicker, text: x.text } : x.text) : x.kind === 'mark' ? x.name : { zoom: x.zoom, until: x.until };
  p.meta.get(head)!.modifiers = [...kinds.values()];
}

/** The actions of the scenes, each with the helpers the recorder put before it; the group of each step. */
export function stepGroups(scenes: readonly DraftScene[], meta: Map<Step, StepMeta>): { groups: StepGroup[]; groupOf: Map<Step, StepGroup> } {
  const inScene = new Set(scenes.flatMap((sc) => sc.steps.map((x) => x.step)));
  const groups: StepGroup[] = [];
  const byHead = new Map<Step, StepGroup>();
  const groupOf = new Map<Step, StepGroup>();
  for (const sc of scenes) {
    for (const { step } of sc.steps) {
      const m = meta.get(step)!;
      const head = m.role === 'helper' && m.group && inScene.has(m.group) ? m.group : step;
      let g = byHead.get(head);
      if (!g) {
        g = { head, scene: sc, steps: [], max: -1 };
        byHead.set(head, g);
        groups.push(g);
      }
      g.steps.push(step);
      groupOf.set(step, g);
      g.max = Math.max(g.max, m.seqs[1]);
    }
  }
  return { groups, groupOf };
}

/** The inserted steps put in their scenes (before or after a step, at a scene's end); the recorder's waits they replace removed. */
export function spliceInserts(scenes: readonly DraftScene[], at: { beforeStep: Map<Step, Step[]>; afterStep: Map<Step, Step[]>; atEnd: Map<DraftScene, Step[]>; removed: Set<Step> }): void {
  for (const sc of scenes) {
    const out: DraftScene['steps'] = [];
    for (const x of sc.steps) {
      for (const step of at.beforeStep.get(x.step) ?? []) out.push({ step, t0: x.t0, t1: x.t0 });
      if (!at.removed.has(x.step)) out.push(x);
      for (const step of at.afterStep.get(x.step) ?? []) out.push({ step, t0: x.t0, t1: x.t0 });
    }
    const end = sc.steps.at(-1)?.t1 ?? 0;
    for (const step of at.atEnd.get(sc) ?? []) out.push({ step, t0: end, t1: end });
    sc.steps = out;
  }
}

/** The field a select or pick step names, as a target (a wait for the next target before it). */
export function fieldTarget(step: Step): TargetSpec | undefined {
  const of = (v: unknown) => (v !== null && typeof v === 'object' ? (v as { field?: unknown }).field : undefined);
  const f = of(step.select) ?? of(step.pick);
  if (typeof f === 'string') return { label: f };
  if (f !== null && typeof f === 'object') return JSON.parse(JSON.stringify(f)) as TargetSpec;
  return undefined;
}

/** Write a picked target where the step's main target is (a right click keeps its button). */
export function writeTarget(step: Step, site: NonNullable<StepMeta['site']>, t: TargetSpec): void {
  if (site === 'click') {
    const c = step.click;
    const button = c !== null && typeof c === 'object' && 'button' in c ? (c as { button: unknown }).button : undefined;
    step.click = button !== undefined ? { ...(typeof t === 'string' ? { text: t } : t), button } : t;
  } else if (site === 'double_click') step.double_click = t;
  else if (site === 'type') (step.type as Record<string, unknown>).into = t;
  else if (site === 'select') (step.select as Record<string, unknown>).combobox = t;
  else (step.drop_file as Record<string, unknown>).zone = t;
}

/** A helper's target (a wait_for, a scroll to) that was its action's recorded target: the pick instead. */
export function retarget(h: Step, from: TargetSpec, to: TargetSpec): void {
  const same = (a: TargetSpec) => sameTarget(normalizeTarget(a), normalizeTarget(from));
  const w = h.wait_for as { target?: TargetSpec } | undefined;
  if (w !== null && typeof w === 'object' && w.target !== undefined && same(w.target)) w.target = to;
  const s = h.scroll as { to?: TargetSpec } | undefined;
  if (s !== null && typeof s === 'object' && s.to !== undefined && same(s.to)) s.to = to;
}
