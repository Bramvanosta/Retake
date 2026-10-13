import type { z } from 'zod';
import type { IssuePath } from '../issues.js';
import { extraKeyCandidates, keyedUnionInfo } from '../schemas/keyed.js';
import type { KeyedUnionInfo } from '../schemas/keyed.js';
import type { LocatedIssue } from './located.js';
import { didYouMean, suggestion } from './suggest.js';

type ZIssue = z.core.$ZodIssue;

/** Side information captured while zod builds its issues (zod strips schema refs from final issues). */
interface SideInfo {
  /** `unrecognized_keys.keys` array → keys the object accepts. */
  known: WeakMap<object, readonly string[]>;
  /** `invalid_union.errors` array → keyed-union info. */
  keyed: WeakMap<object, KeyedUnionInfo>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

export function describeValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'an empty value';
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 57) + '...' : v);
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'a mapping';
  return String(v);
}

const TYPE_LABELS: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  int: 'an integer',
  boolean: 'true or false',
  object: 'a mapping',
  record: 'a mapping',
  array: 'a list',
  tuple: 'a list',
  null: 'null',
  undefined: 'nothing',
};

function typeLabel(expected: string): string {
  return TYPE_LABELS[expected] ?? `a ${expected}`;
}

function fmtValue(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function joinOr(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? 'a valid value';
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

function rangeMessage(iss: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig, v: unknown): string {
  const small = iss.code === 'too_small';
  const bound = Number(small ? (iss as z.core.$ZodIssueTooSmall).minimum : (iss as z.core.$ZodIssueTooBig).maximum);
  const inclusive = iss.inclusive !== false;
  switch (iss.origin) {
    case 'string':
      if (small && bound === 1) return 'must not be empty';
      return `must be ${small ? 'at least' : 'at most'} ${bound} characters long`;
    case 'array':
    case 'set': {
      const items = `${bound} item${bound === 1 ? '' : 's'}`;
      if (iss.exact) return `must contain exactly ${items}`;
      return `must contain ${small ? 'at least' : 'at most'} ${items}`;
    }
    default: {
      const op = small ? (inclusive ? '≥' : '>') : inclusive ? '≤' : '<';
      return `must be ${op} ${bound}, got ${describeValue(v)}`;
    }
  }
}

class Converter {
  /** "missing required key X" issues, dropped when an unknown key at the same place suggests X. */
  private readonly missing = new Map<LocatedIssue, string>();
  private readonly suggested = new Set<string>();

  constructor(
    private readonly side: SideInfo,
    private readonly out: LocatedIssue[],
  ) {}

  /** The issues, minus "missing key" errors already explained by a "did you mean" on a typo. */
  result(): LocatedIssue[] {
    return this.out.filter((i) => {
      const key = this.missing.get(i);
      return key === undefined || !this.suggested.has(JSON.stringify([i.path, key]));
    });
  }

  private error(path: IssuePath, message: string, loc?: LocatedIssue['loc']): void {
    this.out.push(loc ? { severity: 'error', path, message, loc } : { severity: 'error', path, message });
  }

  /** `value` is the data at `base`; issue paths are relative to it. */
  convert(issues: readonly ZIssue[], base: IssuePath, value: unknown, ignoreRootKeys?: ReadonlySet<string>): void {
    for (const iss of issues) this.one(iss, base, value, ignoreRootKeys);
  }

  private one(iss: ZIssue, base: IssuePath, value: unknown, ignoreRootKeys?: ReadonlySet<string>): void {
    const rel = iss.path as PropertyKey[];
    const path: IssuePath = [...base, ...rel.map((p) => (typeof p === 'number' ? p : String(p)))];
    const v = getAt(value, rel);
    switch (iss.code) {
      case 'unrecognized_keys': {
        const known = this.side.known.get(iss.keys) ?? [];
        const present = isObj(v) ? Object.keys(v) : [];
        for (const k of iss.keys) {
          if (rel.length === 0 && ignoreRootKeys?.has(k)) continue;
          const candidates = known.filter((c) => !present.includes(c));
          const s = didYouMean(k, candidates);
          if (s !== undefined) this.suggested.add(JSON.stringify([path, s]));
          const hint = s === undefined ? '' : ` (did you mean "${s}"?)`;
          this.error(path, `unknown key "${k}"${hint}`, { path: [...path, k], key: true });
        }
        return;
      }
      case 'invalid_type': {
        const last = path[path.length - 1];
        if (v === undefined && typeof last === 'string') {
          const parent = path.slice(0, -1);
          this.error(parent, `missing required key "${last}"`, { path: parent });
          this.missing.set(this.out[this.out.length - 1], last);
          return;
        }
        let msg = `expected ${typeLabel(iss.expected)}, got ${describeValue(v)}`;
        if (iss.expected === 'string' && (typeof v === 'number' || typeof v === 'boolean')) {
          msg += ` (quote it to use it as text: "${String(v)}")`;
        }
        this.error(path, msg);
        return;
      }
      case 'invalid_value': {
        const values = iss.values as unknown[];
        const strings = values.filter((x): x is string => typeof x === 'string');
        const expected = values.length === 1 ? fmtValue(values[0]) : `one of ${values.map(fmtValue).join(', ')}`;
        const hint = typeof v === 'string' ? suggestion(v, strings) : '';
        this.error(path, `expected ${expected}, got ${describeValue(v)}${hint}`);
        return;
      }
      case 'too_small':
      case 'too_big':
        this.error(path, rangeMessage(iss, v));
        return;
      case 'not_multiple_of':
        this.error(path, `must be a multiple of ${String(iss.divisor)}, got ${describeValue(v)}`);
        return;
      case 'invalid_union': {
        const info = this.side.keyed.get(iss.errors);
        if (info) this.keyed(iss.errors, info, path, v);
        else this.union(iss.errors, path, v);
        return;
      }
      case 'invalid_key':
      case 'invalid_element':
        this.convert(iss.issues, path, v);
        return;
      default:
        // invalid_format (every format check in our schemas carries a precise message) and custom.
        this.error(path, iss.message);
    }
  }

  /** Does a union branch fail on the TYPE of the value itself (rather than on its contents)? */
  private rootMismatch(branch: readonly ZIssue[]): boolean {
    return branch.some(
      (i) =>
        i.path.length === 0 &&
        (i.code === 'invalid_type' ||
          i.code === 'invalid_value' ||
          (i.code === 'invalid_union' && i.errors.length > 0 && i.errors.every((b) => this.rootMismatch(b)))),
    );
  }

  private expectations(branches: readonly (readonly ZIssue[])[], types: Set<string>, values: unknown[]): void {
    for (const b of branches) {
      for (const i of b) {
        if (i.path.length !== 0) continue;
        if (i.code === 'invalid_type') types.add(typeLabel(i.expected));
        else if (i.code === 'invalid_value') values.push(...(i.values as unknown[]));
        else if (i.code === 'invalid_union') this.expectations(i.errors, types, values);
      }
    }
  }

  private union(branches: readonly (readonly ZIssue[])[], path: IssuePath, v: unknown): void {
    const applicable = branches.filter((b) => !this.rootMismatch(b));
    if (applicable.length === 0) {
      const types = new Set<string>();
      const values: unknown[] = [];
      this.expectations(branches, types, values);
      const parts: string[] = [];
      if (values.length === 1) parts.push(fmtValue(values[0]));
      else if (values.length > 1) parts.push(`one of ${values.map(fmtValue).join(', ')}`);
      parts.push(...types);
      const hint =
        typeof v === 'string' ? suggestion(v, values.filter((x): x is string => typeof x === 'string')) : '';
      this.error(path, `expected ${joinOr(parts)}, got ${describeValue(v)}${hint}`);
      return;
    }
    // Prefer the branch that recognises most of the given keys, then the one with fewest issues.
    const inputKeys = isObj(v) ? Object.keys(v).length : 0;
    const matched = (b: readonly ZIssue[]) =>
      inputKeys -
      b.reduce((n, i) => n + (i.code === 'unrecognized_keys' && i.path.length === 0 ? i.keys.length : 0), 0);
    let best = applicable[0];
    for (const b of applicable.slice(1)) {
      const d = matched(b) - matched(best);
      if (d > 0 || (d === 0 && b.length < best.length)) best = b;
    }
    this.convert(best, path, v);
  }

  private keyed(branches: readonly (readonly ZIssue[])[], info: KeyedUnionInfo, path: IssuePath, v: unknown): void {
    if (!isObj(v)) {
      const msg =
        typeof v === 'string' && info.keys.includes(v)
          ? `"${v}" needs a value: write "${v}: …"`
          : info.fallback !== undefined
            ? `expected ${/^[aeiou]/i.test(info.noun) ? 'an' : 'a'} ${info.noun} mapping (${info.example}), got ${describeValue(v)}`
            : `expected a mapping with one ${info.label} key (${info.example}), got ${describeValue(v)}`;
      this.error(path, msg);
      return;
    }
    const keys = Object.keys(v);
    // A key that is both discriminating and common (`hold`) only discriminates when alone.
    let present = info.keys.filter((k) => keys.includes(k));
    const proper = present.filter((k) => !info.common.includes(k));
    if (proper.length > 0) present = proper;
    if (present.length === 0) {
      if (info.fallback !== undefined) {
        const issues = branches[info.fallback];
        const moved = info.misplaced;
        const hit = new Set<string>();
        const rest = moved
          ? issues.filter((i) => {
              const k = i.path.length > 0 ? String(i.path[0]) : '';
              if (!moved.keys.includes(k)) return true;
              hit.add(k);
              return false;
            })
          : issues;
        for (const k of hit) this.error([...path, k], moved!.message(k, path), { path: [...path, k], key: true });
        this.convert(rest, path, v);
        return;
      }
      let explained = false;
      for (const k of keys) {
        if (info.common.includes(k)) continue;
        const s = didYouMean(k, info.keys);
        if (s !== undefined) {
          this.error(path, `unknown ${info.label} "${k}" (did you mean "${s}"?)`, { path: [...path, k], key: true });
          explained = true;
        } else {
          const others = info.common.filter((c) => !keys.includes(c));
          this.error(path, `unknown key "${k}"${suggestion(k, others)}`, { path: [...path, k], key: true });
        }
      }
      if (!explained) {
        this.error(path, `a ${info.noun} needs exactly one ${info.label} key: ${info.keys.join(', ')}`);
      }
      // Problems with the common modifiers are the same in every branch: report them once.
      const common = (branches[0] ?? []).filter((i) => i.path.length > 0 && info.common.includes(String(i.path[0])));
      this.convert(common, path, v);
      return;
    }
    const first = info.branchOf.get(present[0])!;
    if (present.length > 1) {
      this.error(
        path,
        `several ${info.label}s in one ${info.noun} (${present.join(', ')}): split them into separate ${info.noun}s`,
        { path: [...path, present[1]], key: true },
      );
      this.convert(branches[first], path, v, new Set(present));
      for (const k of present.slice(1)) {
        this.convert(
          branches[info.branchOf.get(k)!].filter((i) => i.path[0] === k),
          path,
          v,
        );
      }
      return;
    }
    this.convert(branches[first], path, v);
  }
}

/**
 * Validate `value` (the data found at `base` in the document) and convert zod issues into
 * precise, located messages. Returns [] when valid.
 */
export function zodIssues(schema: z.ZodType, value: unknown, base: IssuePath = []): LocatedIssue[] {
  const side: SideInfo = { known: new WeakMap(), keyed: new WeakMap() };
  const result = schema.safeParse(value, {
    error: (raw) => {
      if (raw.code === 'unrecognized_keys') {
        const inst = raw.inst as { _zod?: { def?: { shape?: Record<string, unknown> } } } | undefined;
        side.known.set(raw.keys, [...Object.keys(inst?._zod?.def?.shape ?? {}), ...extraKeyCandidates(raw.inst)]);
      } else if (raw.code === 'invalid_union') {
        const info = keyedUnionInfo(raw.inst);
        if (info) side.keyed.set(raw.errors, info);
      }
      return undefined;
    },
  });
  if (result.success) return [];
  const converter = new Converter(side, []);
  converter.convert(result.error.issues, base, value);
  return converter.result();
}
