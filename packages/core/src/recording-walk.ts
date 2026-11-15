/** The event walk of the draft generator (recording.ts): the recording's events → scenes, steps, their sources and issues. */
import { sameTarget } from './inspect.js';
import { RECORD_NAV_WINDOW_MS, RECORD_SCROLL_MIN_PX, RECORD_SECRET_PLACEHOLDER, RECORD_WAIT_GAP_MS } from './recording-draft.js';
import type { DraftContext, DraftScene, El, Ev, EvOf, PendingScroll, Raised, Raw, RecordingDraft, SecretStep, Step, StepMeta, Walked } from './recording-draft.js';
import { RECORD_TEXT_MAX, SECRET_FIELD_KINDS } from './recording-events.js';
import type { SecretFieldKind } from './recording-events.js';
import {
  ACTION_KINDS,
  CONFIRM_WORD,
  CONTAINER_ROLES,
  HIDDEN_MESSAGE,
  MASK,
  PLACEHOLDER_RE,
  TEMPLATE,
  TEMPLATE_MESSAGE,
  bare,
  clean,
  hasHidden,
  hasMask,
  hasTemplate,
  hidden,
  inList,
  isClickOn,
  isClosingPress,
  itemName,
  openOf,
  pathUnderPage,
  sameEl,
  siteOf,
  targetOf,
  unsafe,
} from './recording-targets.js';
import type { RecordInsert } from './record-annotations.js';
import { normalizeTarget } from './targets.js';
import type { TargetSpec } from './types/language.js';

/**
 * The walk over the recording's events (writes aside), in `seq` order: the scenes and their steps, each step's sources
 * (StepMeta), the secret placeholders, the counts and the issues raised — see draftFromRecording.
 */
export class EventWalk implements Walked {
  readonly scenes: DraftScene[] = [];
  readonly meta = new Map<Step, StepMeta>();
  readonly secretSteps: SecretStep[] = [];
  readonly stats: RecordingDraft['stats'] = { scenes: 0, steps: 0, actions: 0, noise: 0, secrets: 0, fallbacks: 0 };
  readonly vars: Record<string, string> = {};
  readonly raised: Raised[] = [];
  /** The scene steps go to now. */
  scene: DraftScene | null = null;
  private readonly secretCount = new Map<string, number>();
  private readonly projectVars: Record<string, string>;
  /** The time of the event read now (issues are ordered by it). */
  private now = 0;
  private lastActionT = -Infinity;
  /** The next action is the first after a document load (everything on the page counts as appeared there). */
  private afterLoad = true;
  /** Actions are not recorded until the window is back on an environment page. */
  private away: 'sign_in' | 'foreign' | null = null;
  private scroll: PendingScroll | null = null;
  private otpMerged = false;

  constructor(
    private readonly ctx: DraftContext,
    private readonly stream: readonly Ev[],
    private readonly inserts: readonly RecordInsert[],
  ) {
    this.projectVars = ctx.projectVars ?? {};
  }

  /** Read every event: what the window did (navigation, a stop, dropped events, a new tab), then the person's actions. */
  run(): void {
    const { stream } = this;
    for (let i = 0; i < stream.length; i++) {
      const e = stream[i];
      this.now = e.t;
      if (this.notice(e)) continue;
      if (this.away !== null) continue;
      i = this.action(e, i);
    }
  }

  private note(step: Step, issue: Raw): void {
    this.raised.push({ issue, t: this.now, step });
  }

  /** Something that happened here, between steps. */
  private raise(issue: Raw): void {
    this.raised.push({ issue, t: this.now, scene: this.scene, after: this.scene?.steps.at(-1)?.step ?? null });
  }

  /** A step replaced by another (a click folded into the typing that followed it): its issues follow. */
  private moved(from: Step, to: Step): void {
    for (const r of this.raised) {
      if (r.step === from) r.step = to;
      if (r.after === from) r.after = to;
    }
    for (const m of this.meta.values()) if (m.group === from) m.group = to;
  }

  /** Helpers (a wait_for, a scroll) pushed for `action`. */
  private group(helpers: ReadonlyArray<Step | null>, action: Step): void {
    for (const h of helpers) {
      const m = h ? this.meta.get(h) : undefined;
      if (m) {
        m.role = 'helper';
        m.group = action;
      }
    }
  }

  private newScene(seq: number, page: string, path: string, open?: string): DraftScene {
    const s: DraftScene = { page, path, ...(open !== undefined ? { open } : {}), seq, steps: [] };
    this.scenes.push(s);
    this.scene = s;
    return s;
  }

  private current(e: Ev): DraftScene {
    const { pages } = this.ctx;
    return this.scene ?? this.newScene(e.seq, Object.keys(pages)[0] ?? 'page', e.path || '/', e.path ? pathUnderPage(e.path, Object.keys(pages)[0] ?? '', pages) : '/');
  }

  /** Add a step — never one holding a recorded template (left out, `template_text`). False when left out. */
  private push(e: Ev, step: Step, t0: number, t1 = t0, m: Partial<StepMeta> = {}): boolean {
    this.current(e);
    if (JSON.stringify(step).replace(PLACEHOLDER_RE, '').includes(TEMPLATE)) {
      this.raise({ severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE });
      return false;
    }
    if (hasHidden(step)) {
      this.raise({ severity: 'warning', code: 'hidden_text', message: HIDDEN_MESSAGE });
      return false;
    }
    this.current(e).steps.push({ step, t0, t1 });
    this.meta.set(step, { seqs: [e.seq, e.seq], role: 'action', ...m });
    this.stats.steps++;
    return true;
  }

  private checkOpen(open: string): void {
    if (open.includes(MASK))
      this.raise({
        severity: 'warning',
        code: 'secret_path',
        message: 'a page address held a value that looks like a token or an e-mail address: it is masked (•••) in `open:` — put a demo value back by hand',
      });
  }

  private lastStep(): Step | undefined {
    return this.scene?.steps.at(-1)?.step;
  }

  /** A pending scroll before the action on `target` (or by its amount when there is no target): the step pushed, if any. */
  flushScroll(e: Ev, target: TargetSpec | null): Step | null {
    const s = this.scroll;
    this.scroll = null;
    if (!s || Math.abs(s.dy) < RECORD_SCROLL_MIN_PX) return null;
    const container = s.container === 'element' ? targetOf(s.el) : null;
    const step: Step = target !== null ? { scroll: { to: target, ...(container !== null ? { in: container } : {}) } } : { scroll: { by: s.dy, ...(container !== null ? { in: container } : {}) } };
    return this.push(e, step, e.t, e.t, { seqs: [...s.seqs] }) ? step : null;
  }

  /** Before an action on `el`: the scroll that led to it, and a wait when it appeared after a pause (the steps pushed). */
  private before(e: Ev, el: El | null, target: TargetSpec | null): Array<Step | null> {
    const gap = e.t - this.lastActionT;
    let wait: Step | null = null;
    if (target !== null && el?.appeared && !this.afterLoad && Number.isFinite(gap) && gap >= RECORD_WAIT_GAP_MS) {
      const step: Step = { wait_for: { target, timeout: Math.max(15, Math.ceil((2 * gap) / 1000)) } };
      if (this.push(e, step, e.t)) wait = step;
    }
    return [wait, this.flushScroll(e, target)];
  }

  private acted(t: number, n = 1): void {
    this.lastActionT = t;
    this.afterLoad = false;
    this.stats.actions += n;
  }

  /** The target a press is replayed on: the verified one, else a fallback from its own text (warned), else null. */
  private pressTarget(el: El, step: () => Step): TargetSpec | null {
    const t = targetOf(el);
    if (t !== null) {
      if (el.fragile.includes('nth') || el.fragile.includes('css')) {
        const s = step();
        this.note(s, {
          severity: 'info',
          code: 'fragile_target',
          message: `the recorded target depends on ${el.fragile.includes('nth') ? 'its position among look-alikes' : 'a CSS selector'}: check it with page_inspect`,
        });
      }
      return t;
    }
    const text = clean(el.name) || clean(el.text);
    if (hasMask(el.target) || hasTemplate(el.target) || unsafe(text)) return null;
    if (!text || text.length > 80 || (el.role !== null && CONTAINER_ROLES.has(el.role))) return null;
    return { text, ...(el.in !== 'page' && el.in !== 'row' ? { in: el.in } : {}) };
  }

  private nextAction(from: number): number {
    const { stream } = this;
    for (let j = from; j < stream.length; j++) {
      const k = stream[j].kind;
      if (ACTION_KINDS.has(k) || k === 'navigation' || k === 'stop') return j;
    }
    return stream.length;
  }

  private dropFile(zone: TargetSpec, names: readonly string[]): Step {
    const name = unsafe(names[0]) ? 'file.csv' : names[0];
    const step: Step = { drop_file: { zone, name, fake: true } };
    this.note(step, {
      severity: 'info',
      code: 'fake_file',
      message: `drop_file uses a placeholder file with the chosen file's name${names.length > 1 ? ` (the first of ${names.length})` : ''}: give it a real file under the project (path:) if the product reads its content`,
    });
    return step;
  }

  /** What the window did rather than the person (a page change, the end, dropped events, a new tab): true when `e` was one. */
  private notice(e: Ev): boolean {
    switch (e.kind) {
      case 'navigation':
        this.navigation(e);
        return true;
      case 'stop':
        if (e.reason === 'max_duration') this.raise({ severity: 'warning', code: 'max_duration', message: 'the recording reached its maximum duration and stopped: what came after is missing' });
        return true;
      case 'dropped':
        this.raise({
          severity: e.reason === 'invalid' ? 'info' : 'warning',
          code: 'dropped',
          message:
            e.reason === 'sign_in'
              ? `${e.count} action(s) on a sign-in page were not recorded`
              : e.reason === 'frame'
                ? `${e.count} action(s) inside a frame were not recorded (frames are not recorded)`
                : `${e.count} event(s) the recorder could not read were dropped`,
        });
        return true;
      case 'new_page':
        this.raise({ severity: 'warning', code: 'new_page', message: 'the page opened a tab or a popup: tabs and popups are not recorded — what was done there is missing' });
        return true;
      default:
        return false;
    }
  }

  /** A page change: a scene starts where the page changed (`open:` only when the address bar or nothing done changed it). */
  private navigation(e: EvOf<'navigation'>): void {
    const { ctx } = this;
    if (e.where !== 'environment' || e.page_key === null) {
      if (this.away !== e.where) {
        this.away = e.where === 'environment' ? 'foreign' : e.where;
        this.raise(
          this.away === 'sign_in'
            ? {
                severity: 'warning',
                code: 'signed_out',
                message: `the window reached a sign-in page${ctx.persona ? ` (persona ${ctx.persona} signed out)` : ''}: nothing done there was recorded — sign the persona in (retake login / auth_login) and record that part again`,
              }
            : { severity: 'warning', code: 'foreign_page', message: "the window left the environment's pages (another site): nothing done there was recorded" },
        );
      }
      if (this.scroll) this.scroll = null;
      return;
    }
    const wasAway = this.away !== null;
    this.away = null;
    const path = e.path || '/';
    const rel = pathUnderPage(path, e.page_key, ctx.pages);
    if (e.cause === 'start') {
      this.newScene(e.seq, e.page_key, path, openOf(rel));
      this.checkOpen(rel);
      this.afterLoad = true;
      return;
    }
    if (!this.scene) {
      const open = openOf(rel + (e.cause === 'typed' && e.query ? e.query : ''));
      this.newScene(e.seq, e.page_key, path, open);
      this.checkOpen(open);
      this.afterLoad = true;
      return;
    }
    const cur: DraftScene = this.scene;
    if (path === cur.path && e.same_document) return;
    if (this.scroll && Math.abs(this.scroll.dy) >= RECORD_SCROLL_MIN_PX) this.flushScroll(e, null);
    this.scroll = null;
    const caused = e.t - this.lastActionT <= RECORD_NAV_WINDOW_MS;
    const byAddress = wasAway || (!e.same_document && !caused && ['typed', 'reload', 'other'].includes(e.cause));
    if (byAddress) {
      const open = openOf(rel + (e.cause === 'typed' && e.query ? e.query : ''));
      if (cur.steps.length === 0) {
        cur.page = e.page_key;
        cur.path = path;
        cur.open = open;
        cur.seq = e.seq;
      } else this.newScene(e.seq, e.page_key, path, open);
      this.checkOpen(open);
      if (!wasAway)
        this.raise({ severity: 'info', code: 'opened_by_address', message: 'a scene opens its page by address: the address bar, a reload or a script changed the page with no action before it' });
    } else if (cur.steps.length > 0) {
      if (e.page_key !== cur.page)
        this.raise({
          severity: 'warning',
          code: 'page_changed',
          message: `an action led to another environment page (${e.page_key}) in the same window: the scene continues on page ${cur.page} — check the replay`,
        });
      this.newScene(e.seq, cur.page, path);
    } else {
      cur.path = path;
      cur.seq = e.seq;
    }
    if (!e.same_document) this.afterLoad = true;
  }

  /** One of the person's actions at stream index `i`: the index of the last event it took. */
  private action(e: Ev, i: number): number {
    switch (e.kind) {
      case 'scroll':
        this.scrolled(e);
        return i;
      case 'pointer':
        return this.pointer(e, i);
      case 'dblclick':
        return i; // after its two presses (handled with the first), or alone: nothing to add
      case 'type':
        this.typed(e, i);
        return i;
      case 'select_native':
        this.selectNative(e);
        return i;
      case 'file':
        this.file(e);
        return i;
      case 'key':
        this.key(e);
        return i;
      default:
        return i;
    }
  }

  /** Scrolling, summed until the next action (one container at a time). */
  private scrolled(e: EvOf<'scroll'>): void {
    if (!this.scroll || this.scroll.container !== e.container || (e.container === 'element' && !sameEl(this.scroll.el, e.el))) {
      this.scroll = { dy: 0, dx: 0, container: e.container, el: e.el, seqs: [e.seq, e.seq] };
    }
    this.scroll.seqs[1] = e.seq;
    this.scroll.dy += e.dy;
    this.scroll.dx += e.dx;
  }

  /** A press: a double click, a list's choice, a row's menu, a file zone, else a click. */
  private pointer(e: EvOf<'pointer'>, i: number): number {
    const el = e.el;
    if (el === null) {
      this.stats.noise++;
      return i;
    }
    if (e.button === 'middle') {
      this.raise({ severity: 'info', code: 'middle_click', message: 'a middle click (a new tab) was not recorded' });
      return i;
    }
    const j1 = this.nextAction(i + 1);
    const done = this.doubleClick(e, el, j1) ?? this.listChoice(e, el, j1) ?? this.rowMenu(e, el, j1) ?? this.fileZone(e, el, i, j1);
    if (done !== null) return done;
    this.press(e, el);
    return i;
  }

  /** A double click: this press, a second one on the same element, then `dblclick`. Null when it is not one. */
  private doubleClick(e: EvOf<'pointer'>, el: El, j1: number): number | null {
    const n1 = this.stream[j1];
    const n2 = this.stream[this.nextAction(j1 + 1)];
    if (!(n1?.kind === 'pointer' && n1.el && sameEl(n1.el, el) && n2?.kind === 'dblclick')) return null;
    let step: Step = {};
    const t = this.pressTarget(el, () => step);
    if (t === null) return this.nextAction(j1 + 1);
    const hs = this.before(e, el, t);
    step = { double_click: t };
    if (this.push(e, step, e.t, n2.t, { seqs: [e.seq, n2.seq], ...siteOf(el, t, [e.seq], 'double_click') })) this.group(hs, step);
    this.acted(n2.t, 2);
    return this.nextAction(j1 + 1);
  }

  /** A list (Radix / Base UI select, a multi-select popover): options chosen in the listbox it opened. Null when it is not one. */
  private listChoice(e: EvOf<'pointer'>, el: El, j1: number): number | null {
    const { stream } = this;
    if (!inList(stream[j1])) return null;
    let j = j1;
    let search: string | undefined;
    const options: string[] = [];
    let tEnd = e.t;
    let sEnd = e.seq;
    while (j < stream.length) {
      const x = stream[j];
      if (x.kind === 'type' && options.length === 0 && !x.secret && x.text !== undefined && (x.el?.in === 'listbox' || x.el?.in === 'popover')) {
        search = x.text;
        tEnd = x.t;
        sEnd = x.seq;
      } else if (x.kind === 'pointer' && x.el?.in === 'listbox' && x.el.role === 'option' && itemName(x.el) && !unsafe(itemName(x.el))) {
        options.push(itemName(x.el));
        tEnd = x.t;
        sEnd = x.seq;
      } else if (x.kind === 'pointer' && (x.el?.in === 'listbox' || x.el?.in === 'popover') && x.el.role !== 'option' && options.length === 0) {
        // a press in the list that is not an option (a search box): part of the choice
        tEnd = x.t;
        sEnd = x.seq;
      } else break;
      j = this.nextAction(j + 1);
    }
    if (options.length === 0) return null;
    const after = stream[j];
    let close: 'escape' | 'outside' | 'none' | null = null;
    if (after?.kind === 'key' && after.key === 'Escape' && after.modifiers.length === 0) close = 'escape';
    else if (isClosingPress(after)) close = 'outside';
    const hint = el.action.kind === 'select' && el.action.field ? el.action.field : null;
    const trigger = targetOf(el);
    if (hint === null && trigger === null) return null;
    const label = hint ?? (clean(el.label) && !unsafe(clean(el.label)) ? clean(el.label) : null);
    const hs = this.before(e, el, trigger);
    let step: Step;
    let m: Partial<StepMeta> = {};
    if (options.length === 1 && (hint !== null || close === null)) {
      step = { select: { ...(hint !== null ? { field: hint } : { combobox: trigger }), option: options[0], ...(search !== undefined ? { search } : {}) } };
      if (hint === null) m = siteOf(el, trigger, [e.seq], 'select');
    } else {
      const field: unknown = label ?? (el.target ? { ...el.target } : null);
      step = {
        pick: { field, option: options.length === 1 ? options[0] : options, ...(search !== undefined ? { search } : {}), close: close ?? (after && ACTION_KINDS.has(after.kind) ? 'outside' : 'none') },
      };
    }
    if (!this.push(e, step, e.t, close !== null ? after!.t : tEnd, { seqs: [e.seq, close !== null ? after!.seq : sEnd], ...m })) this.stats.noise++;
    else this.group(hs, step);
    this.acted(close !== null ? after!.t : tEnd, options.length + 1);
    return close !== null ? j : j - 1;
  }

  /** A row's action menu: trigger → item (→ the confirmation dialog's button). Null when it is not one. */
  private rowMenu(e: EvOf<'pointer'>, el: El, j1: number): number | null {
    const n1 = this.stream[j1];
    if (!(el.action.kind === 'menu' && n1?.kind === 'pointer' && n1.el?.in === 'menu' && itemName(n1.el) && !unsafe(itemName(n1.el)))) return null;
    const item = itemName(n1.el);
    const j2 = this.nextAction(j1 + 1);
    const c = this.stream[j2];
    let confirm: string | undefined;
    if (c?.kind === 'pointer' && c.el && c.el.in === 'dialog' && c.el.appeared && c.el.role === 'button' && c.t - n1.t <= 10_000) {
      const name = itemName(c.el);
      const a = name.toLowerCase();
      const b = item.toLowerCase();
      if (name && !unsafe(name) && (a === b || a.startsWith(`${b} `) || CONFIRM_WORD.test(name))) confirm = name;
    }
    const trigger = targetOf(el);
    const row = el.action.row && !unsafe(el.action.row) ? el.action.row : null;
    if (row === null && trigger === null) return null;
    const hs = this.before(e, el, trigger);
    const end = confirm !== undefined ? c!.t : n1.t;
    const step: Step = { menu: { ...(row !== null ? { row } : { trigger }), item, ...(confirm !== undefined ? { confirm } : {}) } };
    if (this.push(e, step, e.t, end, { seqs: [e.seq, confirm !== undefined ? c!.seq : n1.seq] })) this.group(hs, step);
    this.acted(end, confirm !== undefined ? 3 : 2);
    return confirm !== undefined ? j2 : j1;
  }

  /** A file zone: the file chosen in the chooser it opened (or dropped on it). Null when it is not one, or no step came of it. */
  private fileZone(e: EvOf<'pointer'>, el: El, i: number, j1: number): number | null {
    if (el.action.kind !== 'drop_file') return null;
    const n1 = this.stream[j1];
    if (n1?.kind !== 'file') {
      this.raise({ severity: 'info', code: 'file_cancelled', message: 'a file zone was pressed and no file was chosen: not recorded' });
      return i;
    }
    const zone = targetOf(el) ?? targetOf(n1.el);
    if (zone === null || n1.names.length === 0) return null;
    const hs = this.before(e, el, zone);
    const step = this.dropFile(zone, n1.names);
    const own = targetOf(el) !== null;
    if (this.push(e, step, e.t, n1.t, { seqs: [e.seq, n1.seq], ...siteOf(own ? el : n1.el, zone, [own ? e.seq : n1.seq], 'drop_file') })) this.group(hs, step);
    this.acted(n1.t, 2);
    return j1;
  }

  /** A click (a right click keeps its button); a press the recorder could not name is dropped and said. */
  private press(e: EvOf<'pointer'>, el: El): void {
    const step: Step = {};
    const t = this.pressTarget(el, () => step);
    if (t === null) {
      this.stats.noise++;
      const own = clean(el.name) || clean(el.text);
      const secret = hasMask(bare(el));
      const templated = !secret && (hasTemplate(el.target) || own.includes(TEMPLATE));
      const hid = !secret && !templated && (hasHidden(el.target) || hidden(own));
      this.raise({
        severity: 'warning',
        code: secret ? 'secret_target' : templated ? 'template_text' : hid ? 'hidden_text' : 'unresolved_press',
        message: secret
          ? 'a press on an element whose text holds a secret value was not recorded'
          : templated
            ? TEMPLATE_MESSAGE
            : hid
              ? HIDDEN_MESSAGE
              : 'a press the recorder could not name was dropped: add it by hand if it mattered (page_inspect)',
      });
      return;
    }
    const hs = this.before(e, el, t);
    const opts = e.button === 'right' ? { button: 'right' } : {};
    const obj = typeof t === 'string' ? { text: t } : t;
    step.click = Object.keys(opts).length ? { ...obj, ...opts } : t;
    if (!this.push(e, step, e.t, e.t, siteOf(el, t, [e.seq], 'click'))) {
      this.stats.noise++;
      return;
    }
    this.group(hs, step);
    this.acted(e.t);
    if (!el.target) {
      this.stats.fallbacks++;
      this.note(step, {
        severity: 'warning',
        code: 'fallback_target',
        message: 'no verified target for this press (it was still appearing, or the page was too large): the target is guessed from its text — check it with page_inspect',
      });
    }
  }

  /** Typing (always with `into`; clear / enter); a secret field's as a placeholder; the press that focused the field folded in. */
  private typed(e: EvOf<'type'>, i: number): void {
    if (!e.secret && (e.text ?? '').includes(TEMPLATE)) {
      // Typed text a scenario would resolve as a template: left out (the click that focused the field stays).
      this.current(e);
      this.raise({ severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE });
      return;
    }
    if (!e.secret && hidden(e.text ?? '')) {
      // Typed or pasted text with a hidden character: left out too (never quoted).
      this.current(e);
      this.raise({ severity: 'warning', code: 'hidden_text', message: HIDDEN_MESSAGE });
      return;
    }
    const into = targetOf(e.el);
    const secretKind = e.secret ? ((SECRET_FIELD_KINDS as readonly string[]).includes(e.field_kind) ? e.field_kind : 'secret') : undefined;
    if (this.mergeTyping(e, i, into, secretKind)) return;
    // The press that focused the field is the type's `into` (its issues follow it).
    let folded: Step | null = null;
    if (into !== null && isClickOn(this.lastStep(), into)) {
      folded = this.scene!.steps.pop()!.step;
      this.stats.steps--;
    }
    const fm = folded ? this.meta.get(folded) : undefined;
    const typeMeta = (): Partial<StepMeta> => ({ seqs: [fm?.seqs[0] ?? e.seq, e.seq], ...siteOf(e.el, into, [...(fm?.targetSeqs ?? []), e.seq], 'type') });
    if (e.secret) {
      this.secretTyping(e, i, into, folded, typeMeta);
      return;
    }
    const text = e.text ?? '';
    const step: Step = { type: { ...(into !== null ? { into } : {}), text, ...(e.clear ? { clear: true } : {}), ...(e.enter ? { enter: true } : {}) } };
    const hs = this.before(e, e.el, into);
    if (this.push(e, step, e.t, e.t, { ...typeMeta(), ...(into !== null && !e.enter ? { typeIdx: i } : {}) })) this.group(hs, step);
    if (folded) this.moved(folded, step);
    this.acted(e.t);
    if (into === null)
      this.note(step, { severity: 'warning', code: 'fallback_target', message: 'the field typed into has no verified target: the step types into the focused element — add `into` (page_inspect)' });
    if (e.field_kind === 'contenteditable')
      this.note(step, { severity: 'info', code: 'contenteditable', message: 'typed into a rich text editor: its text is recorded as it shows, formatting aside — check the replay' });
  }

  /**
   * The same field typed again with nothing between (a visit to the Studio blurred the window and committed the first
   * part): one typing step — a secret one keeps its one placeholder — unless an insert was placed between them, or the
   * text would make a template or pass the longest recorded text. The step keeps the time of each part: a write that
   * follows either is attributed to it. True when merged.
   */
  private mergeTyping(e: EvOf<'type'>, i: number, into: TargetSpec | null, secretKind: string | undefined): boolean {
    const prevStep = this.lastStep();
    const pm = prevStep ? this.meta.get(prevStep) : undefined;
    if (
      !(
        prevStep &&
        pm?.typeIdx !== undefined &&
        pm.target !== undefined &&
        pm.secretKind === secretKind &&
        !e.clear &&
        into !== null &&
        sameTarget(normalizeTarget(pm.target), normalizeTarget(into)) &&
        this.stream.slice(pm.typeIdx + 1, i).every((x) => x.kind === 'scroll') &&
        (this.scroll === null || Math.abs(this.scroll.dy) < RECORD_SCROLL_MIN_PX) &&
        !this.inserts.some((x) => x.after_seq >= pm.seqs[1] && x.after_seq < e.seq)
      )
    ) {
      return false;
    }
    const ty = prevStep.type as { text: string; enter?: boolean };
    const merged = secretKind !== undefined ? ty.text : ty.text + (e.text ?? '');
    if (!(secretKind !== undefined || (!merged.includes(TEMPLATE) && merged.length <= RECORD_TEXT_MAX))) return false;
    ty.text = merged;
    if (e.enter) ty.enter = true;
    const last = this.scene!.steps.at(-1)!;
    last.tw = [...(last.tw ?? [last.t1]), e.t];
    pm.seqs[1] = e.seq;
    pm.targetSeqs?.push(e.seq);
    pm.typeIdx = e.enter ? undefined : i;
    this.acted(e.t);
    return true;
  }

  /** A secret field's typing: `{{vars.<kind>_N}}` (project.yaml's var when it has one); one-time-code boxes merged into the first. */
  private secretTyping(e: EvOf<'type'>, i: number, into: TargetSpec | null, folded: Step | null, typeMeta: () => Partial<StepMeta>): void {
    const { projectVars } = this;
    const kind = (SECRET_FIELD_KINDS as readonly string[]).includes(e.field_kind) ? e.field_kind : 'secret';
    const prev = this.lastStep();
    if (kind === 'one_time_code' && prev && typeof prev.type === 'object' && String((prev.type as { text?: string }).text ?? '').startsWith('{{vars.one_time_code_')) {
      // One-time-code boxes: one typing step on the first box (the app must move to the next box by itself).
      if (!this.otpMerged) {
        this.note(prev, {
          severity: 'warning',
          code: 'one_time_code',
          message: 'one-time-code boxes were typed one by one: merged into one typing step on the first box — it replays only if the app moves to the next box by itself',
        });
        this.otpMerged = true;
      }
      const last2 = this.scene!.steps.at(-1)!;
      last2.t1 = e.t;
      const m2 = this.meta.get(last2.step);
      if (m2) m2.seqs[1] = e.seq;
      if (folded) this.moved(folded, last2.step);
      this.acted(e.t);
      return;
    }
    const n = (this.secretCount.get(kind) ?? 0) + 1;
    this.secretCount.set(kind, n);
    const name = `${kind}_${n}`;
    const text = `{{vars.${name}}}`;
    if (!Object.hasOwn(projectVars, name)) this.vars[name] = RECORD_SECRET_PLACEHOLDER;
    this.stats.secrets++;
    const step: Step = { type: { ...(into !== null ? { into } : {}), text, ...(e.clear ? { clear: true } : {}), ...(e.enter ? { enter: true } : {}) } };
    const hs = this.before(e, e.el, into);
    if (this.push(e, step, e.t, e.t, { ...typeMeta(), ...(into !== null && !e.enter ? { typeIdx: i } : {}), secretKind: kind })) {
      this.group(hs, step);
      this.secretSteps.push({ step, name, kind: kind as SecretFieldKind, project_var: Object.hasOwn(projectVars, name) });
    }
    if (folded) this.moved(folded, step);
    this.acted(e.t);
    this.note(step, {
      severity: 'warning',
      code: e.autofill ? 'autofill' : 'secret_field',
      message: Object.hasOwn(projectVars, name)
        ? `a secret field (${kind}) was typed: its value was never recorded — the draft types project.yaml's vars.${name}`
        : `a secret field (${kind})${e.autofill ? ' was filled by the browser' : ' was typed'}: its value was never recorded — set vars.${name} to a showable demo value (a real secret only as {{env:…}}, by hand, which makes the scenario CLI-only)`,
    });
  }

  /** A native `<select>`'s choice (the press that opened it folded in). */
  private selectNative(e: EvOf<'select_native'>): void {
    const t = targetOf(e.el);
    const field = e.el ? clean(e.el.label) : '';
    if (t === null && (!field || unsafe(field))) {
      this.raise({ severity: 'warning', code: 'unresolved_press', message: 'a choice in a list the recorder could not name was dropped: add it by hand (page_inspect)' });
      return;
    }
    if (unsafe(e.option)) {
      this.raise(
        e.option.includes(MASK)
          ? { severity: 'warning', code: 'secret_target', message: 'a choice whose text holds a secret value was not recorded' }
          : e.option.includes(TEMPLATE)
            ? { severity: 'warning', code: 'template_text', message: TEMPLATE_MESSAGE }
            : { severity: 'warning', code: 'hidden_text', message: HIDDEN_MESSAGE },
      );
      return;
    }
    let folded: Step | null = null;
    if (t !== null && isClickOn(this.lastStep(), t)) {
      folded = this.scene!.steps.pop()!.step;
      this.stats.steps--;
    }
    const hs = this.before(e, e.el, t);
    const step: Step = { select: { ...(t !== null ? { combobox: t } : { field }), option: e.option } };
    const fm = folded ? this.meta.get(folded) : undefined;
    if (this.push(e, step, e.t, e.t, { seqs: [fm?.seqs[0] ?? e.seq, e.seq], ...siteOf(e.el, t, [...(fm?.targetSeqs ?? []), e.seq], 'select') })) this.group(hs, step);
    if (folded) this.moved(folded, step);
    this.acted(e.t);
  }

  /** A file chosen in a file field (a placeholder file of its name). */
  private file(e: EvOf<'file'>): void {
    const zone = targetOf(e.el);
    if (zone === null || e.names.length === 0) {
      this.raise({ severity: 'warning', code: 'unresolved_press', message: 'a file was chosen in a field the recorder could not name: add a drop_file step by hand' });
      return;
    }
    const hs = this.before(e, e.el, zone);
    const step = this.dropFile(zone, e.names);
    if (this.push(e, step, e.t, e.t, siteOf(e.el, zone, [e.seq], 'drop_file'))) this.group(hs, step);
    this.acted(e.t);
  }

  /** A key press (with its modifiers; Shift only with a named key). */
  private key(e: EvOf<'key'>): void {
    const key = e.key === ' ' ? 'Space' : e.key;
    const combo = [...e.modifiers.filter((m) => m !== 'Shift' || key.length > 1), key].join('+');
    const h = this.flushScroll(e, null);
    const step: Step = { press: combo };
    if (this.push(e, step, e.t)) this.group([h], step);
    this.acted(e.t);
  }
}

/** The element an event at `seq` recorded (null: none, or no such event). */
