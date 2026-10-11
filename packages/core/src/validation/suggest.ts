/** Optimal-string-alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * Closest candidate to a misspelt word, or undefined when nothing is close enough.
 * Case and "-" / "_" differences count as near-identical ("doubleClick" → "double_click").
 */
export function didYouMean(input: string, candidates: Iterable<string>): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const inp = norm(input);
  if (!inp) return undefined;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === input) continue;
    const score = norm(c) === inp ? 0 : editDistance(inp, norm(c)) + 0.5;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  if (best === undefined) return undefined;
  const limit = inp.length <= 3 ? 1 : inp.length <= 6 ? 2 : 3;
  return bestScore - 0.5 <= limit ? best : undefined;
}

/** ' (did you mean "x"?)' or ''. */
export function suggestion(input: string, candidates: Iterable<string>): string {
  const s = didYouMean(input, candidates);
  return s === undefined ? '' : ` (did you mean "${s}"?)`;
}
