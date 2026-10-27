/**
 * A line diff for scenario proposals (L4.6, R-UI-28; critique B1): what a person reads in a thread is the canonical
 * diff of the exact bytes Apply writes. Pure, no dependency.
 *
 * - Lines are a text split at its line breaks (LF or CR LF), without them; a final line break ends the last line (no
 *   empty line after it): "a\nb\n" and "a\nb" are both ["a", "b"].
 * - A hunk `{at, del, add}`: `del` are the base's lines `at … at + del.length − 1` (1-based), replaced by `add`; a pure
 *   insertion has no `del` and goes before base line `at` (`at` = lines + 1: at the end). No context lines: context is
 *   added for display from the text itself.
 * - `diffLines` is Myers' O(ND) shortest edit script on what lies between the common head and tail, so its hunks are
 *   minimal, sorted, separated by at least one unchanged line and never empty — the one canonical diff of a pair:
 *   a stored list of hunks is accepted only when it deep-equals `diffLines(base, applyHunks(base, hunks))`.
 * - `applyHunks` is strict: hunks out of order, overlapping, touching, empty or whose `del` is not the base's lines
 *   throw (LineDiffError) — never a fuzzy patch.
 */

/** One change of a line diff (see the module comment). */
export interface LineHunk {
  /** 1-based line of the base where `del` starts (a pure insertion: the line it goes before; lines + 1 at the end). */
  at: number;
  del: string[];
  add: string[];
}

export class LineDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineDiffError';
  }
}

/** The lines of a text (LF or CR LF line breaks, left out; a final line break adds no empty line). */
export function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Lines joined with `eol`, a final line break included (no lines: the empty text). */
export function joinLines(lines: readonly string[], eol: '\n' | '\r\n'): string {
  return lines.length ? `${lines.join(eol)}${eol}` : '';
}

/** How a text breaks its lines: CR LF, LF alone, and CR alone (a CR not followed by a LF). */
export function lineBreaks(text: string): { crlf: number; lf: number; cr: number } {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return { crlf, lf, cr };
}

type Op = 0 | 1 | 2; // 0 equal, 1 delete (a base line), 2 insert (a new line)

/**
 * The canonical line diff from `base` to `next` (see the module comment); null when it needs more than `maxChanged`
 * deleted plus inserted lines (the search stops there: a whole-file rewrite costs no more than the cap allows).
 */
export function diffLines(base: readonly string[], next: readonly string[], o: { maxChanged?: number } = {}): LineHunk[] | null {
  let head = 0;
  while (head < base.length && head < next.length && base[head] === next[head]) head++;
  let tail = 0;
  while (tail < base.length - head && tail < next.length - head && base[base.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const a = base.slice(head, base.length - tail);
  const b = next.slice(head, next.length - tail);
  const ops = myers(a, b, o.maxChanged ?? Number.POSITIVE_INFINITY);
  if (ops === null) return null;
  // Group the runs of deletes and inserts between equal lines into hunks (base positions offset by the common head).
  const hunks: LineHunk[] = [];
  let x = 0;
  let y = 0;
  let cur: LineHunk | null = null;
  for (const op of ops) {
    if (op === 0) {
      if (cur) hunks.push(cur);
      cur = null;
      x++;
      y++;
      continue;
    }
    if (!cur) cur = { at: head + x + 1, del: [], add: [] };
    if (op === 1) cur.del.push(a[x++]);
    else cur.add.push(b[y++]);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** Myers' greedy shortest edit script (forward, with a trace of each round's frontier), or null past `maxD`. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

/** The edit script from the trace (trace[d][k + d] = the furthest x on diagonal k after round d). */
function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    // The equal lines of the snake after the move, then the move itself.
    const sx = down ? px : px + 1;
    while (x > sx) {
      out.push(0);
      x--;
      y--;
    }
    out.push(down ? 2 : 1);
    x = px;
    y = py;
  }
  while (x > 0) {
    out.push(0);
    x--;
    y--;
  }
  return out.reverse();
}

/** Why a list of hunks is not well-formed (sorted, separated by an unchanged line, none empty, `at` ≥ 1), or null. */
export function hunkOrderProblem(hunks: readonly LineHunk[]): string | null {
  let end = 0; // the last base line the previous hunk deleted (or, for an insertion, the line before it)
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (!Number.isInteger(h.at) || h.at < 1) return `hunk ${i + 1}: "at" is a line number from 1`;
    if (h.del.length === 0 && h.add.length === 0) return `hunk ${i + 1} changes nothing`;
    if (i > 0 && h.at <= end + 1) return `hunk ${i + 1} is not after hunk ${i} with an unchanged line between them`;
    end = h.at - 1 + h.del.length;
  }
  return null;
}

/** The base's lines with each hunk applied (strict: see the module comment). */
export function applyHunks(base: readonly string[], hunks: readonly LineHunk[]): string[] {
  const order = hunkOrderProblem(hunks);
  if (order) throw new LineDiffError(order);
  const out: string[] = [];
  let i = 0; // next base line (0-based) not yet copied
  for (const [n, h] of hunks.entries()) {
    const start = h.at - 1;
    if (start > base.length || start + h.del.length > base.length) throw new LineDiffError(`hunk ${n + 1} lies past the end of the text (${base.length} lines)`);
    for (; i < start; i++) out.push(base[i]);
    for (let j = 0; j < h.del.length; j++) {
      if (base[start + j] !== h.del[j]) throw new LineDiffError(`hunk ${n + 1}: line ${start + j + 1} is not the line it removes`);
    }
    out.push(...h.add);
    i = start + h.del.length;
  }
  for (; i < base.length; i++) out.push(base[i]);
  return out;
}

/** The hunks that undo `hunks` on the text they produced (positions in that text): `applyHunks(result, inverse)` = base. */
export function invertHunks(hunks: readonly LineHunk[]): LineHunk[] {
  let shift = 0;
  return hunks.map((h) => {
    const inv = { at: h.at + shift, del: [...h.add], add: [...h.del] };
    shift += h.add.length - h.del.length;
    return inv;
  });
}

/** Lines added and removed, their sum (the changed lines) and their characters (UTF-16 units). */
export function hunkStats(hunks: readonly LineHunk[]): { added: number; removed: number; changed: number; chars: number } {
  let added = 0;
  let removed = 0;
  let chars = 0;
  for (const h of hunks) {
    added += h.add.length;
    removed += h.del.length;
    for (const l of h.add) chars += l.length;
    for (const l of h.del) chars += l.length;
  }
  return { added, removed, changed: added + removed, chars };
}

/** Whether two hunk lists are the same (positions and lines). */
export function sameHunks(a: readonly LineHunk[], b: readonly LineHunk[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.at !== y.at || x.del.length !== y.del.length || x.add.length !== y.add.length) return false;
    for (let j = 0; j < x.del.length; j++) if (x.del[j] !== y.del[j]) return false;
    for (let j = 0; j < x.add.length; j++) if (x.add[j] !== y.add[j]) return false;
  }
  return true;
}
