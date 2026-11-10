/**
 * IndexedDB in a saved session (a product that keeps its sign-in there, as the Firebase SDK does by default — neither a
 * cookie nor localStorage). The file format is Playwright's (`storageState({ indexedDB: true })`): per origin, its
 * databases, their stores and indexes, and each record as plain JSON (`key` / `value`) or encoded (`keyEncoded` /
 * `valueEncoded`: dates, typed arrays, shared references…). Playwright restores it only into a context it creates; a
 * persona's browser is a persistent context, so both directions are here: `collectIndexedDb` (the headed sign-in
 * window, read page by page) and `restoreIndexedDb` (every browser a saved session is applied to).
 */
import type { BrowserContext, Page } from 'playwright-core';

/** One database of an origin, as Playwright writes it. */
export interface IdbDatabase {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    autoIncrement: boolean;
    keyPath?: string;
    keyPathArray?: string[];
    records: Array<{ key?: unknown; keyEncoded?: unknown; value?: unknown; valueEncoded?: unknown }>;
    indexes: Array<{ name: string; keyPath?: string; keyPathArray?: string[]; multiEntry: boolean; unique: boolean }>;
  }>;
}

/**
 * Runs in the page (serialised by Playwright: self-contained). `mode: 'collect'` returns the origin's databases;
 * `mode: 'restore'` writes `dbs`, leaving alone a database the origin already has (what the app wrote since wins, as
 * for localStorage) and returning the names it wrote.
 */
/* c8 ignore start */
async function idbInPage(arg: { mode: 'collect' | 'restore'; dbs?: IdbDatabase[] }): Promise<IdbDatabase[] | string[]> {
  const TYPED: Record<string, { new (b: ArrayBuffer): ArrayBufferView }> = {
    i8: Int8Array, ui8: Uint8Array, ui8c: Uint8ClampedArray, i16: Int16Array, ui16: Uint16Array, i32: Int32Array,
    ui32: Uint32Array, f32: Float32Array, f64: Float64Array, bi64: BigInt64Array, bui64: BigUint64Array,
  };
  const isPlain = (v: unknown, depth = 0): boolean => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
    if (typeof v !== 'object' || depth > 50) return false;
    if (Array.isArray(v)) return v.every((x) => isPlain(x, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype) return false;
    return Object.values(v as object).every((x) => isPlain(x, depth + 1));
  };
  const encode = (v: unknown, seen: Map<object, number>): unknown => {
    if (v === undefined) return { v: 'undefined' };
    if (v === null) return { v: 'null' };
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return { v: 'NaN' };
      if (v === Infinity) return { v: 'Infinity' };
      if (v === -Infinity) return { v: '-Infinity' };
      if (Object.is(v, -0)) return { v: '-0' };
      return v;
    }
    if (typeof v === 'bigint') return { bi: v.toString() };
    if (typeof v !== 'object') return v;
    if (v instanceof Date) return { d: Number.isNaN(v.getTime()) ? '' : v.toISOString() };
    if (v instanceof RegExp) return { r: { p: v.source, f: v.flags } };
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const kind = Object.keys(TYPED).find((k) => (v as object).constructor === TYPED[k]);
      if (kind) {
        const bytes = new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return { ta: { b: btoa(s), k: kind } };
      }
    }
    const o = v as object;
    const known = seen.get(o);
    if (known !== undefined) return { ref: known };
    const id = seen.size + 1;
    seen.set(o, id);
    if (Array.isArray(o)) return { a: o.map((x) => encode(x, seen)), id };
    return { o: Object.keys(o).map((k) => ({ k, v: encode((o as Record<string, unknown>)[k], seen) })), id };
  };
  const decode = (v: unknown, refs: Map<number, unknown>): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const x = v as Record<string, unknown>;
    if ('ref' in x) return refs.get(x.ref as number);
    if ('v' in x) {
      if (x.v === 'undefined') return undefined;
      if (x.v === 'null') return null;
      if (x.v === 'NaN') return NaN;
      if (x.v === 'Infinity') return Infinity;
      if (x.v === '-Infinity') return -Infinity;
      if (x.v === '-0') return -0;
      return undefined;
    }
    if ('d' in x) return new Date(x.d as string);
    if ('u' in x) return String(x.u);
    if ('bi' in x) return BigInt(x.bi as string);
    if ('r' in x) return new RegExp((x.r as { p: string }).p, (x.r as { f: string }).f);
    if ('e' in x) return new Error((x.e as { m?: string }).m ?? '');
    if ('ta' in x) {
      const ta = x.ta as { b: string; k: string };
      const bin = atob(ta.b);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const C = TYPED[ta.k];
      return C ? new C(bytes.buffer) : bytes;
    }
    if ('a' in x) {
      const out: unknown[] = [];
      refs.set(x.id as number, out);
      for (const item of x.a as unknown[]) out.push(decode(item, refs));
      return out;
    }
    if ('o' in x) {
      const out: Record<string, unknown> = {};
      refs.set(x.id as number, out);
      for (const { k, v: item } of x.o as Array<{ k: string; v: unknown }>) out[k] = decode(item, refs);
      return out;
    }
    return v;
  };
  const done = <T>(r: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      r.addEventListener('success', () => resolve(r.result));
      r.addEventListener('error', () => reject(r.error));
    });
  const existing = await indexedDB.databases();

  if (arg.mode === 'collect') {
    const out: IdbDatabase[] = [];
    for (const info of existing) {
      if (!info.name) continue;
      const db = await done(indexedDB.open(info.name));
      try {
        const names = [...db.objectStoreNames];
        if (!names.length) continue;
        const tx = db.transaction(names, 'readonly');
        const stores: IdbDatabase['stores'] = [];
        for (const name of names) {
          const store = tx.objectStore(name);
          const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
          const kp = store.keyPath;
          stores.push({
            name,
            autoIncrement: store.autoIncrement,
            ...(typeof kp === 'string' ? { keyPath: kp } : Array.isArray(kp) ? { keyPathArray: kp } : {}),
            records: keys.map((key, i) => ({
              ...(isPlain(key) ? { key } : { keyEncoded: encode(key, new Map()) }),
              ...(isPlain(values[i]) ? { value: values[i] } : { valueEncoded: encode(values[i], new Map()) }),
            })),
            indexes: [...store.indexNames].map((n) => {
              const ix = store.index(n);
              return {
                name: n,
                ...(typeof ix.keyPath === 'string' ? { keyPath: ix.keyPath } : { keyPathArray: ix.keyPath }),
                multiEntry: ix.multiEntry,
                unique: ix.unique,
              };
            }),
          });
        }
        out.push({ name: info.name, version: db.version, stores });
      } finally {
        db.close();
      }
    }
    return out;
  }

  const written: string[] = [];
  for (const saved of arg.dbs ?? []) {
    if (existing.some((d) => d.name === saved.name)) continue;
    const open = indexedDB.open(saved.name, saved.version);
    open.addEventListener('upgradeneeded', () => {
      const db = open.result;
      for (const s of saved.stores) {
        const store = db.createObjectStore(s.name, { autoIncrement: s.autoIncrement, keyPath: s.keyPathArray ?? s.keyPath ?? null });
        for (const ix of s.indexes ?? []) store.createIndex(ix.name, (ix.keyPathArray ?? ix.keyPath) as string | string[], { unique: ix.unique, multiEntry: ix.multiEntry });
      }
    });
    const db = await done(open);
    try {
      const withRecords = saved.stores.filter((s) => s.records?.length);
      if (withRecords.length) {
        const tx = db.transaction(withRecords.map((s) => s.name), 'readwrite');
        const finished = new Promise<void>((resolve, reject) => {
          tx.addEventListener('complete', () => resolve());
          tx.addEventListener('error', () => reject(tx.error));
          tx.addEventListener('abort', () => reject(tx.error));
        });
        for (const s of withRecords) {
          const store = tx.objectStore(s.name);
          for (const r of s.records) {
            const value = 'valueEncoded' in r ? decode(r.valueEncoded, new Map()) : r.value;
            const key = 'keyEncoded' in r ? decode(r.keyEncoded, new Map()) : r.key;
            if (store.keyPath !== null) store.put(value);
            else store.put(value, key as IDBValidKey);
          }
        }
        await finished;
      }
      written.push(saved.name);
    } finally {
      db.close();
    }
  }
  return written;
}
/* c8 ignore stop */

/** The IndexedDB databases of the page's origin (none on a page without storage). */
export async function collectIndexedDb(page: Page): Promise<IdbDatabase[]> {
  return (await page.evaluate(idbInPage, { mode: 'collect' as const })) as IdbDatabase[];
}

/**
 * Write saved IndexedDB databases into a context, origin by origin, before any of its pages loads: a tab of the context
 * opens each origin on an empty document served from here (nothing is requested from the product), writes its
 * databases, and closes. A database the origin already has is left as it is.
 */
export async function restoreIndexedDb(context: BrowserContext, origins: ReadonlyArray<{ origin: string; indexedDB?: unknown[] }>): Promise<void> {
  const todo = origins.filter((o) => o.indexedDB?.length && /^https?:\/\//.test(o.origin));
  if (!todo.length) return;
  const page = await context.newPage();
  try {
    await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title></title>' }));
    for (const o of todo) {
      await page.goto(`${o.origin}/`, { waitUntil: 'load', timeout: 15_000 });
      await page.evaluate(idbInPage, { mode: 'restore' as const, dbs: o.indexedDB as IdbDatabase[] });
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}
