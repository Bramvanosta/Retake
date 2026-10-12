/**
 * Layout geometry that follows params (DESIGN-phase2 §1.3, "Geometry expressions").
 *
 * A layout manifest declares its rects in the design space (1920×1080, 1080×1920 for `geometry_vertical`, 1080×1080 for `geometry_square`). Each
 * value is a number or an arithmetic EXPRESSION over the component's numeric params, the geometry's own `vars`
 * (evaluated in order) and the built-in `aspect` (the capture's width / height; 16/9 when unknown, e.g. previews):
 *
 *   geometry:
 *     vars: {w: "min(width, round(878 * aspect))", h: "min(round(width / aspect), 878)"}
 *     screen: {x: "round((1920 - w) / 2)", y: 40, w: w, h: h}
 *
 * Grammar: numbers, identifiers, + - * / %, unary minus, parentheses and min(a, …), max(a, …), round(a), floor(a),
 * ceil(a), abs(a). Booleans params count as 1 / 0. Nothing else (no strings, no member access, no calls of anything
 * else): a manifest stays data — the planner, the review, the Studio UI and the validator evaluate it without running
 * component code. The planner evaluates the geometry with the resolved params of each use, so a theme's `width`
 * moves the card AND the caption / brand mark rects; the composition hands the evaluated rects to the layout
 * component (`props.rects`), so the component draws exactly where the planner placed captions and overlays.
 */
import type { LayoutGeometry, LayoutGeometrySpec, Rect1920 } from './types.js';

export type GeometryValue = number | string;

/** Built-in identifiers of geometry expressions. */
export const GEOMETRY_BUILTINS = ['aspect'] as const;
/** Functions of geometry expressions. */
export const GEOMETRY_FUNCTIONS = ['min', 'max', 'round', 'floor', 'ceil', 'abs'] as const;
/** Default capture aspect (previews, validation). */
export const DEFAULT_CAPTURE_ASPECT = 16 / 9;

export class GeometryExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly index?: number,
  ) {
    super(message);
    this.name = 'GeometryExpressionError';
  }
}

type Node =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string; at: number }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '%'; a: Node; b: Node }
  | { t: 'call'; fn: (typeof GEOMETRY_FUNCTIONS)[number]; args: Node[]; at: number };

type Token = { k: 'num'; v: number; at: number } | { k: 'id'; v: string; at: number } | { k: 'op'; v: string; at: number };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    if ('+-*/%(),'.includes(c)) {
      out.push({ k: 'op', v: c, at: i });
      i++;
      continue;
    }
    throw new GeometryExpressionError(`unexpected character "${c}" at ${i + 1}`, src, i);
  }
  return out;
}

/** Parse an expression (throws GeometryExpressionError with the position of the problem). */
export function parseGeometryExpression(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const fail = (msg: string, at = peek()?.at ?? src.length): never => {
    throw new GeometryExpressionError(`${msg} at ${at + 1}`, src, at);
  };
  const expect = (v: string) => {
    const t = peek();
    if (!t || t.k !== 'op' || t.v !== v) fail(`expected "${v}"`);
    p++;
  };
  function primary(): Node {
    const t = peek();
    if (!t) return fail('unexpected end of expression');
    if (t.k === 'num') {
      p++;
      return { t: 'num', v: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      p++;
      const e = sum();
      expect(')');
      return e;
    }
    if (t.k === 'op' && t.v === '-') {
      p++;
      return { t: 'neg', a: primary() };
    }
    if (t.k === 'op' && t.v === '+') {
      p++;
      return primary();
    }
    if (t.k === 'id') {
      p++;
      const next = peek();
      if (next && next.k === 'op' && next.v === '(') {
        if (!(GEOMETRY_FUNCTIONS as readonly string[]).includes(t.v)) fail(`unknown function "${t.v}" (known: ${GEOMETRY_FUNCTIONS.join(', ')})`, t.at);
        p++;
        const args: Node[] = [];
        if (!(peek()?.k === 'op' && peek()?.v === ')')) {
          args.push(sum());
          while (peek()?.k === 'op' && peek()?.v === ',') {
            p++;
            args.push(sum());
          }
        }
        expect(')');
        const fn = t.v as (typeof GEOMETRY_FUNCTIONS)[number];
        const arity = fn === 'min' || fn === 'max' ? args.length >= 1 : args.length === 1;
        if (!arity) fail(`${fn}() takes ${fn === 'min' || fn === 'max' ? 'at least one argument' : 'one argument'}`, t.at);
        return { t: 'call', fn, args, at: t.at };
      }
      return { t: 'id', name: t.v, at: t.at };
    }
    return fail(`unexpected "${t.v}"`, t.at);
  }
  function product(): Node {
    let a = primary();
    for (let t = peek(); t && t.k === 'op' && (t.v === '*' || t.v === '/' || t.v === '%'); t = peek()) {
      p++;
      a = { t: 'bin', op: t.v as '*' | '/' | '%', a, b: primary() };
    }
    return a;
  }
  function sum(): Node {
    let a = product();
    for (let t = peek(); t && t.k === 'op' && (t.v === '+' || t.v === '-'); t = peek()) {
      p++;
      a = { t: 'bin', op: t.v as '+' | '-', a, b: product() };
    }
    return a;
  }
  const node = sum();
  if (p < tokens.length) fail(`unexpected "${tokens[p].v}"`);
  return node;
}

/** Identifiers an expression refers to (functions excluded). */
export function expressionIdentifiers(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node): void => {
    if (n.t === 'id') out.add(n.name);
    else if (n.t === 'neg') walk(n.a);
    else if (n.t === 'bin') {
      walk(n.a);
      walk(n.b);
    } else if (n.t === 'call') n.args.forEach(walk);
  };
  walk(parseGeometryExpression(src));
  return [...out];
}

function evalNode(n: Node, scope: Readonly<Record<string, number>>, src: string): number {
  switch (n.t) {
    case 'num':
      return n.v;
    case 'id': {
      const v = scope[n.name];
      if (v === undefined) throw new GeometryExpressionError(`unknown name "${n.name}" at ${n.at + 1}`, src, n.at);
      return v;
    }
    case 'neg':
      return -evalNode(n.a, scope, src);
    case 'bin': {
      const a = evalNode(n.a, scope, src);
      const b = evalNode(n.b, scope, src);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        default:
          return a % b;
      }
    }
    case 'call': {
      const args = n.args.map((x) => evalNode(x, scope, src));
      switch (n.fn) {
        case 'min':
          return Math.min(...args);
        case 'max':
          return Math.max(...args);
        case 'round':
          return Math.round(args[0]);
        case 'floor':
          return Math.floor(args[0]);
        case 'ceil':
          return Math.ceil(args[0]);
        default:
          return Math.abs(args[0]);
      }
    }
  }
}

/** Value of a geometry value (number, or expression evaluated in `scope`); throws when not a finite number. */
export function evalGeometryValue(value: GeometryValue, scope: Readonly<Record<string, number>>): number {
  if (typeof value === 'number') return value;
  const v = evalNode(parseGeometryExpression(value), scope, value);
  if (!Number.isFinite(v)) throw new GeometryExpressionError(`"${value}" is not a finite number (${v})`, value);
  return Math.round(v * 1000) / 1000;
}

/** The numeric scope of params: numbers as they are, booleans as 1 / 0 (strings, arrays… are not usable). */
export function geometryScope(params: Readonly<Record<string, unknown>>, aspect = DEFAULT_CAPTURE_ASPECT): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number' && Number.isFinite(v)) scope[k] = v;
    else if (typeof v === 'boolean') scope[k] = v ? 1 : 0;
  }
  scope.aspect = aspect > 0 && Number.isFinite(aspect) ? aspect : DEFAULT_CAPTURE_ASPECT;
  return scope;
}

const RECT_KEYS = ['screen', 'frame', 'chrome', 'caption', 'brandmark'] as const;

/**
 * The geometry of a layout for the given params and capture aspect: every expression evaluated (design px). Throws
 * GeometryExpressionError (with the offending key in its message) when an expression cannot be evaluated.
 */
export function evalLayoutGeometry(spec: LayoutGeometrySpec, params: Readonly<Record<string, unknown>> = {}, opts: { aspect?: number } = {}): LayoutGeometry {
  const scope = geometryScope(params, opts.aspect);
  const at = (path: string, v: GeometryValue) => {
    try {
      return evalGeometryValue(v, scope);
    } catch (e) {
      const err = e as GeometryExpressionError;
      throw new GeometryExpressionError(`${path}: ${err.message}`, err.expression ?? String(v), err.index);
    }
  };
  for (const [name, v] of Object.entries(spec.vars ?? {})) scope[name] = at(`vars.${name}`, v);
  const rect = (name: string, r: { x: GeometryValue; y: GeometryValue; w: GeometryValue; h: GeometryValue }): Rect1920 => ({
    x: at(`${name}.x`, r.x),
    y: at(`${name}.y`, r.y),
    w: at(`${name}.w`, r.w),
    h: at(`${name}.h`, r.h),
  });
  const out: LayoutGeometry = { screen: rect('screen', spec.screen) };
  for (const name of RECT_KEYS) {
    if (name === 'screen') continue;
    const r = spec[name];
    if (r) out[name] = rect(name, r);
  }
  if (spec.radius !== undefined) out.radius = at('radius', spec.radius);
  return out;
}

/** True when the geometry declares an expression anywhere (it depends on params or on the capture aspect). */
export function geometryIsDynamic(spec: LayoutGeometrySpec): boolean {
  const values: GeometryValue[] = [...Object.values(spec.vars ?? {})];
  for (const name of RECT_KEYS) {
    const r = spec[name];
    if (r) values.push(r.x, r.y, r.w, r.h);
  }
  if (spec.radius !== undefined) values.push(spec.radius);
  return values.some((v) => typeof v === 'string');
}
