/** "my Project!" → "my-project" */
export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return (process.env.HOME ?? '') + p.slice(1);
  return p;
}

/**
 * A size in decimal megabytes, as every Tools' line says it (the Studio, `retake tools`, the installer): "315 MB" for
 * 315 358 794 bytes, one decimal under 10 MB ("8.4 MB").
 */
export function megabytes(n: number): string {
  const mb = n / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Deterministic PRNG in [0,1) from a string seed (mulberry32 over an FNV-1a hash). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a thrown value says: an Error's message, anything else as text (a throw need not be an Error). */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** decodeURIComponent, or `s` as written when it is no valid percent-encoding (a stray `%`). */
export function decodeOrKeep(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A promise that settles after `ms` (no cancel: the abortable waits keep their own rules for an abort). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
