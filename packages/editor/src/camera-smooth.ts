/** The reframe's smoothing: critically damped, without lag, and the smoothest repair of a path into a corridor. Pure. */
import { clamp } from './util.js';

/**
 * Critically damped smoothing without lag: two first-order lags in cascade (= a critically damped second-order
 * system, no overshoot) run forward, then the same backward (zero phase: a change of the target signal becomes a
 * smooth S that starts before it and ends after it — the reframe anticipates).
 */
export function dampedSmooth(values: readonly number[], fps: number, tauS: number, zeroPhase = true): number[] {
  const n = values.length;
  if (n === 0) return [];
  const alpha = 1 - Math.exp(-1 / Math.max(1e-6, tauS * fps));
  const pass = (src: number[], reverse: boolean): number[] => {
    const out = new Array<number>(n);
    let y = src[reverse ? n - 1 : 0];
    for (let i = 0; i < n; i++) {
      const k = reverse ? n - 1 - i : i;
      y += alpha * (src[k] - y);
      out[k] = y;
    }
    return out;
  };
  let v = values.slice();
  v = pass(pass(v, false), false);
  if (zeroPhase) v = pass(pass(v, true), true);
  return v;
}

/**
 * The smoothest repair of a path: the path `x = free + d` closest to `free` that stays within [lo, hi] at every
 * frame, with the weights of a CRITICALLY DAMPED system on the repair's slope and the path's curvature:
 * minimise Σ d² + 2L² Σ (Δd)² + L⁴ Σ (Δ²x)²  subject to  lo ≤ x ≤ hi.
 * The response to a one-sided push is then a single smooth bump (Green's function (1 + |t|/L)·e^(−|t|/L), never
 * negative: no ringing, the view never moves the wrong way before or after a forced move), reaching ≈ 3 L frames on
 * each side. A banded quadratic programme solved with ADMM (pentadiagonal Cholesky factorised once). Where the free
 * path is already inside, it is returned as is.
 */
export function corridorSmooth(
  free: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
  reachFrames: number,
  opts: { iterations?: number; rho?: number; damping?: number } = {},
): number[] {
  const n = free.length;
  const inside = free.every((x, k) => x >= lo[k] - 1e-9 && x <= hi[k] + 1e-9);
  if (inside || n < 3) return free.map((x, k) => clamp(x, lo[k], hi[k]));
  const rho = opts.rho ?? 1;
  const L = Math.max(1, reachFrames);
  const w1 = 2 * (opts.damping ?? 1) * L * L;
  const w2 = L ** 4;
  // A = (1 + ρ) I + w1 D1ᵀD1 + w2 D2ᵀD2 (D1, D2: first and second differences), stored by diagonals.
  const a0 = new Array<number>(n).fill(1 + rho);
  const a1 = new Array<number>(n).fill(0);
  const a2 = new Array<number>(n).fill(0);
  for (let i = 0; i + 1 < n; i++) {
    a0[i] += w1;
    a0[i + 1] += w1;
    a1[i] -= w1;
  }
  const c = [1, -2, 1];
  for (let i = 0; i + 2 < n; i++) {
    for (let p = 0; p < 3; p++) {
      a0[i + p] += w2 * c[p] * c[p];
      if (p < 2) a1[i + p] += w2 * c[p] * c[p + 1];
      if (p < 1) a2[i + p] += w2 * c[p] * c[p + 2];
    }
  }
  // Banded Cholesky A = L Lᵀ (L lower, bandwidth 2).
  const l0 = new Array<number>(n).fill(0);
  const l1 = new Array<number>(n).fill(0);
  const l2 = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    const p1 = j >= 1 ? l1[j - 1] : 0;
    const p2 = j >= 2 ? l2[j - 2] : 0;
    l0[j] = Math.sqrt(Math.max(1e-12, a0[j] - p1 * p1 - p2 * p2));
    l1[j] = (a1[j] - (j >= 1 ? l2[j - 1] * l1[j - 1] : 0)) / l0[j];
    l2[j] = a2[j] / l0[j];
  }
  const solve = (b: number[]): number[] => {
    const y = new Array<number>(n);
    for (let j = 0; j < n; j++) y[j] = (b[j] - (j >= 1 ? l1[j - 1] * y[j - 1] : 0) - (j >= 2 ? l2[j - 2] * y[j - 2] : 0)) / l0[j];
    const x = new Array<number>(n);
    for (let j = n - 1; j >= 0; j--) x[j] = (y[j] - (j + 1 < n ? l1[j] * x[j + 1] : 0) - (j + 2 < n ? l2[j] * x[j + 2] : 0)) / l0[j];
    return x;
  };
  // The curvature penalty applies to the path itself (x = free + d), so a path released from a constraint (pinned at
  // the capture's edge) accelerates smoothly instead of taking the free path's speed at once: the right-hand side
  // carries −w2 D2ᵀ D2 free.
  const curve = new Array<number>(n).fill(0);
  for (let i = 0; i + 2 < n; i++) {
    const dd = free[i] - 2 * free[i + 1] + free[i + 2];
    curve[i] -= w2 * dd;
    curve[i + 1] += 2 * w2 * dd;
    curve[i + 2] -= w2 * dd;
  }
  // ADMM on the repair d: d ∈ [lo − free, hi − free].
  const dlo = lo.map((v, k) => v - free[k]);
  const dhi = hi.map((v, k) => v - free[k]);
  let z = dlo.map((v, k) => clamp(0, v, dhi[k]));
  const u = new Array<number>(n).fill(0);
  let d = z.slice();
  const iterations = opts.iterations ?? 3000;
  for (let it = 0; it < iterations; it++) {
    d = solve(z.map((zk, k) => rho * (zk - u[k]) + curve[k]));
    let primal = 0;
    let dual = 0;
    const zn = d.map((v, k) => clamp(v + u[k], dlo[k], dhi[k]));
    for (let k = 0; k < n; k++) {
      u[k] += d[k] - zn[k];
      primal = Math.max(primal, Math.abs(d[k] - zn[k]));
      dual = Math.max(dual, Math.abs(zn[k] - z[k]));
    }
    z = zn;
    if (primal < 0.01 && dual < 0.001) break;
  }
  return free.map((f, k) => clamp(f + d[k], lo[k], hi[k]));
}
