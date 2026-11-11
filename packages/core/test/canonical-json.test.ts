/**
 * One canonical JSON (core canonical-json.ts) for the copies that wrote the same bytes: the hook approval fingerprint
 * (hooks approval.ts; its frozen values: hooks test/approval-fingerprint.test.ts), the sandbox seed hash (core
 * sandbox.ts) and the scenario snapshot comparison (core scenario.ts). Frozen values first — a fingerprint or a hash that moved would void every approval or snapshot already stored — then
 * the copies replaced (kept below verbatim as oracles) against canonicalJson over the repository's YAML and odd values.
 * The two copies that sort keys with localeCompare (theme descriptions, schema messages) give other bytes: they stay
 * separate, and the last test shows why.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, scenarioTextChanged } from '../src/index.js';
import { seedHash } from '../src/io/index.js';
import type { SandboxManifest } from '../src/index.js';

// ── The copies replaced, verbatim ────────────────────────────────────────────────────────────────────────────────────
/** hooks approval.ts `canonical`. */
function hooksCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(hooksCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${hooksCanonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** core sandbox.ts `canonicalJson`. */
function sandboxCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sandboxCanonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sandboxCanonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
/** core scenario.ts `canonicalJson`. */
function scenarioCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(scenarioCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${scenarioCanonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** The localeCompare copies (core template.ts `sortedJson`, components json-schema.ts `canonical`), for the contrast. */
const localeSorted = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

const REPO = resolve(__dirname, '../../..');

/** Every YAML file of the repository's projects, fixtures and templates (scenarios, project.yaml, sandboxes, themes). */
function repoYaml(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') || ['runs', 'renders', 'review', 'exports'].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['projects', 'fixtures', 'templates', 'packages/core/test/fixtures']) walk(join(REPO, d));
  return out.sort();
}

const ODD: unknown[] = [
  { b: 1, a: [3, { d: null, c: 'x' }], 'Z': true, _: false, é: 'é', '10': 1, '9': 2 },
  [],
  {},
  [[], {}, [null]],
  'text with "quotes" and \\ and \u2028',
  0,
  -0,
  1.5e300,
  null,
  { nested: { deeper: { deepest: [1, 'two', { three: 3 }] } } },
  { k: undefined, kept: 1 },
];

describe('canonicalJson: the frozen hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retake-canonical-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('a sandbox seed hash keeps its value (snapshots already taken stay fresh)', async () => {
    mkdirSync(join(dir, 'seed'), { recursive: true });
    writeFileSync(join(dir, 'seed', '01-data.sql'), 'insert into t values (1);\n');
    const manifest = {
      services: { db: { image: 'postgres:16' } },
      databases: { main: { url: 'postgres://demo@127.0.0.1:5544/demo', external: undefined } },
      seed: [{ sql: 'seed/01-data.sql', name: 'data' }, { http: { method: 'POST', url: 'http://127.0.0.1:4999/reset' } }],
      reset: { strategy: 'snapshot', snapshot: { database: 'main' } },
    } as unknown as SandboxManifest;
    expect(await seedHash({ dir, manifest })).toBe('00ad072782f5c866406d060ea712d39c0e0630cbfc6cdd42e77189c80a8c50d1');
    expect(await seedHash({ dir, manifest: { services: {} } as unknown as SandboxManifest }, ['img:sha256:1'])).toBe('dca8896ab8bbcf5713d8a2e43415033d1e5601d8ffe774057b89dc271c8ffd7d');
  });

  it('the scenario snapshot comparison keeps its answers', () => {
    const pairs: [string, string][] = [
      ['a: 1\nb: [1, 2]\n', 'b: [1, 2]\na: 1\n'],
      ['a: 1\nb: [1, 2]\n', 'b: [2, 1]\na: 1\n'],
      ['x: ~\n', 'x: null\n'],
      ['x:\n', 'x: null\n'],
      ['k: "1"\n', 'k: 1\n'],
      ['k: [\n', 'k: []\n'],
      ['é: 1\nZ: 2\n_: 3\n', '_: 3\nZ: 2\né: 1\n'],
    ];
    expect(pairs.map(([a, b]) => scenarioTextChanged(a, b))).toEqual([false, true, false, false, true, true, false]);
  });
});

describe('canonicalJson: the copies replaced gave the same bytes', () => {
  it('over every YAML file of the repository (as parsed) and odd values', () => {
    const files = repoYaml();
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const doc = parseDocument(readFileSync(f, 'utf8'));
      if (doc.errors.length) continue;
      const v = doc.toJS();
      const want = canonicalJson(v);
      expect(hooksCanonical(v), f).toBe(want);
      expect(sandboxCanonical(v), f).toBe(want);
      expect(scenarioCanonical(v), f).toBe(want);
    }
    for (const v of ODD) {
      expect(hooksCanonical(v)).toBe(canonicalJson(v));
      if (!(v && typeof v === 'object' && 'k' in v)) expect(scenarioCanonical(v)).toBe(canonicalJson(v));
      expect(sandboxCanonical(v)).toBe(canonicalJson(v));
    }
  });

  it('where the copies differed: values their inputs never hold (YAML data has no undefined; a manifest no undefined in a list)', () => {
    // scenario: an undefined property was written as null (YAML data never holds one).
    expect(scenarioCanonical({ k: undefined })).toBe('{"k":null}');
    expect(canonicalJson({ k: undefined })).toBe('{}');
    // sandbox: an undefined list item was written as nothing (the manifest's lists hold steps, strings and files).
    expect(sandboxCanonical([1, undefined])).toBe('[1,]');
    expect(canonicalJson([1, undefined])).toBe('[1,null]');
  });

  it('the localeCompare copies give other bytes, so they stay separate', () => {
    const v = { b: 1, B: 2, a: 3, _: 4 };
    expect(localeSorted(v)).not.toBe(canonicalJson(v));
    expect(canonicalJson(v)).toBe('{"B":2,"_":4,"a":3,"b":1}');
  });
});
