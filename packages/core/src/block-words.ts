/** The words of a scenario's blocks (blocks.ts): an action's badge and label, a step's chips and summary, a hook's summary. */
import type { Chip, MediaFileRef, StepCategory } from './blocks-model.js';
import { hookKind, sqlSource } from './destructive.js';
import { stepActionKeys } from './steps.js';
import { pickTarget, plainTarget } from './targets.js';
import type { ActionName } from './types/language.js';
import type { HookKind } from './types/hooks.js';

// ── Words ───────────────────────────────────────────────────────────────────

/** The badge of an action (R-UI-09). Exhaustive: a new action fails the build until it has one. */
export function actionCategory(action: ActionName): StepCategory {
  switch (action) {
    case 'open':
    case 'new_tab':
    case 'switch_page':
      return 'navigation';
    case 'click':
    case 'double_click':
      return 'click';
    case 'hover':
      return 'hover';
    case 'type':
    case 'press':
    case 'date':
      return 'type';
    case 'select':
      return 'select';
    case 'pick':
      return 'pick';
    case 'menu':
      return 'menu';
    case 'scroll':
      return 'scroll';
    case 'drag':
      return 'drag';
    case 'drop_file':
      return 'drop_file';
    case 'wait':
    case 'wait_for':
    case 'wait_for_email':
      return 'wait';
    case 'hold':
      return 'hold';
    case 'assert':
    case 'screenshot':
    case 'capture_text':
      return 'check';
    case 'eval':
    case 'emit':
    case 'notify':
      return 'script';
    case 'cursor':
      return 'cursor';
    case 'download':
      return 'download';
    case 'hook':
      return 'hook';
    default: {
      const unknown: never = action;
      return unknown;
    }
  }
}

/** "double_click" → "double click". */
export function actionLabel(action: ActionName): string {
  return action.replace(/_/g, ' ');
}

/**
 * A URL's `user:password@` (or `user@`) left out, wherever URLs appear in a text — up to the authority's LAST `@` (a
 * password may hold one: `https://u:p@ss@host/` → `https://host/`).
 */
export function stripUrlUserinfo(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1');
}

/** Every string of a value with stripUrlUserinfo (arrays and objects copied). */
export function stripDeep(v: unknown): unknown {
  if (typeof v === 'string') return stripUrlUserinfo(v);
  if (Array.isArray(v)) return v.map(stripDeep);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x)]));
  return v;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const q = (s: string) => `“${s}”`;

/** The first line of a text, at most `max` characters (… when cut). */
export function oneLine(s: string, max = 160): string {
  const first = s
    .replace(/^\s*\n/, '')
    .split('\n')[0]
    .trim();
  const cut = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return s.trim().includes('\n') && cut === first ? `${cut} …` : cut;
}

export function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function seconds(n: number): string {
  return `${n} s`;
}

export function captionOf(v: unknown): { kicker?: string; text: string } | undefined {
  if (typeof v === 'string') return { text: v };
  if (isObj(v) && typeof v.text === 'string') return { ...(typeof v.kicker === 'string' ? { kicker: v.kicker } : {}), text: v.text };
  return undefined;
}

/** A tutorial switch in words: "on", "off", "spotlight off, steps on". */
export function tutorialWords(v: unknown): string | undefined {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (!isObj(v)) return undefined;
  const parts = Object.entries(v).map(([k, x]) => `${k} ${x === false ? 'off' : x === true ? 'on' : typeof x === 'string' ? x : 'custom'}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** A transition in words: its kind or its component id. */
export function transitionWords(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.component === 'string') return v.component;
  return undefined;
}

export function mediaFile(v: Record<string, unknown>): MediaFileRef | undefined {
  for (const kind of ['video', 'image', 'lottie'] as const) if (typeof v[kind] === 'string') return { kind, path: v[kind] as string };
  return undefined;
}

/** The modifier chips of a raw step (R-UI-10); `sceneIrreversible`: its scene is irreversible. */
export function stepChips(step: unknown, o: { sceneIrreversible?: boolean } = {}): Chip[] {
  if (!isObj(step)) return [];
  const chips: Chip[] = [];
  const holdIsAction = stepActionKeys(step).includes('hold');
  const camera = step.camera;
  if (isObj(camera) && num(camera.zoom) !== undefined) chips.push({ kind: 'zoom', label: `zoom ×${camera.zoom}` });
  if (!holdIsAction && num(step.hold) !== undefined) chips.push({ kind: 'hold', label: `hold ${seconds(step.hold as number)}` });
  if (str(step.mark) !== undefined) chips.push({ kind: 'mark', label: `mark ${step.mark}` });
  const caption = captionOf(step.caption);
  if (caption) chips.push({ kind: 'caption', label: `caption ${q(shorten(caption.kicker ?? caption.text, 40))}` });
  if (num(step.speed) !== undefined) chips.push({ kind: 'speed', label: `speed ×${step.speed}` });
  if (step.irreversible === true) chips.push({ kind: 'irreversible', label: 'irreversible' });
  else if (o.sceneIrreversible) chips.push({ kind: 'irreversible', label: 'irreversible (scene)' });
  if (step.optional === true) chips.push({ kind: 'optional', label: 'optional' });
  if (step.park === true) chips.push({ kind: 'park', label: 'park' });
  else if (num(step.park) !== undefined) chips.push({ kind: 'park', label: `park ${seconds(step.park as number)}` });
  if (isObj(step.overlay)) {
    const file = mediaFile(step.overlay);
    const what = str(step.overlay.component) ?? (file ? `${file.kind} file` : undefined);
    chips.push({ kind: 'overlay', label: what ? `overlay ${what}` : 'overlay' });
  }
  const tutorial = tutorialWords(step.tutorial);
  if (tutorial) chips.push({ kind: 'tutorial', label: `tutorial ${tutorial}` });
  if (str(step.on) !== undefined) chips.push({ kind: 'page', label: `on ${step.on}` });
  if (num(step.timeout) !== undefined) chips.push({ kind: 'timeout', label: `timeout ${seconds(step.timeout as number)}` });
  return chips;
}

/** A field named by its label or given as a target, in plain words. */
export function fieldWords(v: unknown): string | undefined {
  if (typeof v === 'string') return `field ${q(v)}`;
  if (isObj(v)) return plainTarget(v);
  return undefined;
}

/** What a wait_for / assert waits for or checks, in one line (its `target` / `gone` is the block's target). */
export function conditionWords(a: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (str(a.text) !== undefined) parts.push(`text ${q(a.text as string)}`);
  if (str(a.not_text) !== undefined) parts.push(`text ${q(a.not_text as string)} gone`);
  if (a.target !== undefined && a.gone !== undefined) parts.push(`${plainTarget(a.gone)} gone`);
  else if (a.gone !== undefined) parts.push('gone');
  if (str(a.url) !== undefined) parts.push(`URL ${a.url}`);
  if (str(a.title) !== undefined) parts.push(`title ${q(a.title as string)}`);
  if (isObj(a.count)) parts.push(`${String(a.count.equals)} × ${plainTarget(a.count.target)}`);
  if (a.network_idle === true) parts.push('network idle');
  if (num(a.timeout) !== undefined) parts.push(`up to ${seconds(a.timeout as number)}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** The non-empty parts, joined by commas (undefined when none). */
function joinWords(...parts: Array<string | undefined | false>): string | undefined {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(', ') || undefined;
}

/** A scroll step's target and summary (describeStep). */
function scrollWords(a: Record<string, unknown>): { target?: string; summary?: string } {
  const to = a.to;
  const target = isObj(to) || (typeof to === 'string' && to !== 'top' && to !== 'bottom') ? plainTarget(to) : undefined;
  const where = typeof to === 'number' ? `to ${to} px` : to === 'top' || to === 'bottom' ? `to the ${to}` : num(a.by) !== undefined ? `by ${a.by} px` : undefined;
  return {
    target: target !== undefined && a.in !== undefined ? `${target} in ${plainTarget(a.in)}` : target,
    summary: joinWords(where, num(a.duration) !== undefined && seconds(a.duration as number)),
  };
}

/** A cursor step's target and summary (describeStep). */
function cursorWords(a: Record<string, unknown>): { target?: string; summary?: string } {
  const mode = str(a.mode);
  if (mode === 'move') return { target: a.to !== undefined ? plainTarget(a.to) : undefined, summary: joinWords('move', num(a.duration) !== undefined && seconds(a.duration as number)) };
  if (mode === 'set') return { target: a.to !== undefined ? plainTarget(a.to) : undefined, summary: 'set (no travel)' };
  return { summary: mode };
}

/** The target in plain words and the one-line summary of a normalised step (tolerant of malformed arguments). */
export function describeStep(action: ActionName, args: unknown): { target?: string; summary?: string } {
  const a = isObj(args) ? args : {};
  switch (action) {
    case 'open':
      return { summary: joinWords(str(a.url), str(a.page) && `on page ${a.page}`) };
    case 'click':
    case 'double_click': {
      const mods = Array.isArray(a.modifiers) ? a.modifiers.filter((m): m is string => typeof m === 'string') : [];
      return { target: plainTarget(pickTarget(a)), summary: joinWords(str(a.button) && a.button !== 'left' && `${a.button} button`, mods.length > 0 && `with ${mods.join('+')}`) };
    }
    case 'hover':
      return { target: plainTarget(pickTarget(a)), summary: num(a.ms) !== undefined ? `${a.ms} ms` : undefined };
    case 'type':
      return {
        target: a.into !== undefined ? plainTarget(a.into) : 'the focused field',
        summary: joinWords(str(a.text) !== undefined && q(oneLine(a.text as string)), a.clear === true && 'clears first', a.enter === true && 'then Enter'),
      };
    case 'press':
      return { summary: str(a.key) !== undefined ? `${a.key}${num(a.times) !== undefined && (a.times as number) > 1 ? ` × ${a.times}` : ''}` : undefined };
    case 'select':
      return {
        target: a.combobox !== undefined ? plainTarget(a.combobox) : fieldWords(a.field),
        summary: joinWords(str(a.option) !== undefined && `option ${q(a.option as string)}`, str(a.search) !== undefined && `search ${q(a.search as string)}`),
      };
    case 'pick': {
      const options = typeof a.option === 'string' ? [a.option] : Array.isArray(a.option) ? a.option.filter((o): o is string => typeof o === 'string') : [];
      return {
        target: fieldWords(a.field),
        summary: joinWords(options.length > 0 && `${options.length > 1 ? 'options' : 'option'} ${options.map(q).join(', ')}`, str(a.search) !== undefined && `search ${q(a.search as string)}`),
      };
    }
    case 'menu':
      return {
        target: a.trigger !== undefined ? plainTarget(a.trigger) : typeof a.row === 'string' ? `the row containing ${q(a.row)}` : isObj(a.row) ? plainTarget(a.row) : undefined,
        summary: joinWords(str(a.item) !== undefined && `item ${q(a.item as string)}`, typeof a.confirm === 'string' ? `confirm ${q(a.confirm)}` : a.confirm === true && 'confirm'),
      };
    case 'date': {
      const days = typeof a.day === 'string' ? [a.day] : Array.isArray(a.day) ? a.day.filter((d): d is string => typeof d === 'string') : [];
      return { target: a.field !== undefined ? fieldWords(a.field) : 'the open calendar', summary: days.length ? `${days.length > 1 ? 'days' : 'day'} ${days.map(q).join(' → ')}` : undefined };
    }
    case 'scroll':
      return scrollWords(a);
    case 'drag':
      return { target: a.from !== undefined ? plainTarget(a.from) : undefined, summary: a.to !== undefined ? `to ${plainTarget(a.to)}` : undefined };
    case 'drop_file': {
      const file = str(a.name) ?? str(a.path);
      return { target: a.zone !== undefined ? plainTarget(a.zone) : undefined, summary: file !== undefined ? `file ${q(file)}${a.fake === true ? ' (placeholder)' : ''}` : undefined };
    }
    case 'wait':
    case 'hold':
      return { summary: num(a.seconds) !== undefined ? seconds(a.seconds as number) : undefined };
    case 'wait_for':
    case 'assert':
      return { target: a.target !== undefined ? plainTarget(a.target) : a.gone !== undefined ? plainTarget(a.gone) : undefined, summary: conditionWords(a) };
    case 'screenshot':
      return { summary: str(a.name) !== undefined ? `${q(a.name as string)}${a.full_page === true ? ', full page' : ''}` : undefined };
    case 'new_tab':
      return { target: a.target !== undefined ? plainTarget(a.target) : undefined, summary: joinWords(str(a.href), str(a.as) && `as ${a.as}`) };
    case 'switch_page':
      return { summary: joinWords(str(a.to) && `to ${a.to}`, a.close_current === true && 'closes the current page') };
    case 'eval':
      return { summary: str(a.file) ?? (str(a.js) !== undefined ? oneLine(a.js as string) : undefined) };
    case 'notify':
      return { summary: str(a.message) !== undefined ? (str(a.title) !== undefined ? `${a.title}: ${a.message}` : (a.message as string)) : undefined };
    case 'emit':
      return { summary: str(a.name) };
    case 'cursor':
      return cursorWords(a);
    case 'wait_for_email':
      return {
        summary: joinWords(
          str(a.to) !== undefined && `to ${q(a.to as string)}`,
          str(a.from) !== undefined && `from ${q(a.from as string)}`,
          str(a.subject) !== undefined && `subject ${q(a.subject as string)}`,
          str(a.as) && `as ${a.as}`,
        ),
      };
    case 'download':
      return { target: a.click !== undefined ? plainTarget(pickTarget(isObj(a.click) ? a.click : {})) : undefined, summary: str(a.as) && `as ${a.as}` };
    case 'capture_text':
      return { target: a.target !== undefined ? plainTarget(a.target) : undefined, summary: joinWords(str(a.as) && `as ${a.as}`, str(a.pattern) && `pattern ${a.pattern}`) };
    case 'hook':
      return { target: str(a.name) !== undefined ? `hook ${q(a.name as string)}` : undefined, summary: 'off camera: cut from the video' };
    default: {
      const unknown: never = action;
      return unknown;
    }
  }
}

/** A hook's one-line summary and its rollback's (http method + URL, sql file or first line, shell / js first line). */
export function hookSummary(hook: unknown): { kind?: HookKind; summary: string; rollback?: string } {
  if (!isObj(hook)) return { summary: 'not a hook' };
  let kind: HookKind;
  try {
    if (!['http', 'sql', 'shell', 'js'].some((k) => hook[k] !== undefined)) return { summary: 'unknown hook' };
    kind = hookKind(hook);
  } catch {
    return { summary: 'unknown hook' };
  }
  const spec = hook[kind];
  const sqlWords = (v: unknown): string | undefined => {
    if (typeof v !== 'string' && !isObj(v)) return undefined;
    const { file, query } = typeof v === 'string' ? sqlSource(v) : { file: str(v.file), query: str(v.query) };
    return file ?? (query !== undefined ? oneLine(query, 120) : undefined);
  };
  switch (kind) {
    case 'http': {
      if (!isObj(spec)) return { kind, summary: 'http' };
      const rb = isObj(spec.rollback) ? spec.rollback : undefined;
      return {
        kind,
        summary: `${str(spec.method) ?? 'GET'} ${stripUrlUserinfo(str(spec.url) ?? '')}`.trim(),
        ...(rb ? { rollback: `${str(rb.method) ?? 'GET'} ${stripUrlUserinfo(str(rb.url) ?? '')}`.trim() } : {}),
      };
    }
    case 'sql': {
      const own = sqlWords(spec) ?? 'sql';
      const db = isObj(spec) ? str(spec.db) : undefined;
      const rb = isObj(spec) ? sqlWords(spec.rollback) : undefined;
      return { kind, summary: db !== undefined ? `${own} (database ${db})` : own, ...(rb !== undefined ? { rollback: rb } : {}) };
    }
    case 'shell': {
      const run = typeof spec === 'string' ? spec : isObj(spec) ? str(spec.run) : undefined;
      const rb = isObj(spec) ? str(spec.rollback) : undefined;
      return { kind, summary: run !== undefined ? stripUrlUserinfo(oneLine(run, 120)) : 'shell', ...(rb !== undefined ? { rollback: stripUrlUserinfo(oneLine(rb, 120)) } : {}) };
    }
    case 'js': {
      const code = typeof spec === 'string' ? spec : isObj(spec) ? str(spec.code) : undefined;
      const file = isObj(spec) ? str(spec.file) : undefined;
      const page = isObj(spec) ? str(spec.page) : undefined;
      const rb = isObj(spec) ? str(spec.rollback) : undefined;
      const own = file ?? (code !== undefined ? oneLine(code, 120) : 'js');
      return { kind, summary: page !== undefined ? `${own} (on page ${page})` : own, ...(rb !== undefined ? { rollback: oneLine(rb, 120) } : {}) };
    }
  }
}
