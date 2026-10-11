/**
 * The bundled fixture product is fictional (R-ISS-10, R-PRIN-01): its farms, washing stations, producers, cafés and
 * competitions have invented names, and the fixture scenarios still find what they rely on in the seed.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/**
 * Real-world coffee farms, stations, producers, cafés and competitions the fixture once borrowed. Stored reversed so
 * the names themselves do not appear in the repository; matched case-insensitively on word boundaries.
 */
const FORMER_NAMES = [
  'osíaraP lE acniF', 'osiaraP lE', 'aznarepsE aL', 'itireB olaH', 'arabamaiK', 'atsiV aoB', 'anugaL aL', 'ebmoB',
  'aícuL atnaS', 'aicuL atnaS', 'ekehsamayN', 'asoR atnaS', 'agayniriK', 'slliH aznayaK', 'oyaG hecA', 'rodariM lE',
  'sebuN saL', 'agarU ijuG', 'agarU', 'ordisI naS', 'amanaP fo tseB', 'nedrågdniL', 'nogroM', 'uviK ekaL',
  'setnoP sêrT', 'ognarA', 'aniloM', 'soniceR', 'raliugA',
].map((r) => [...r].reverse().join(''));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FORMER_RE = new RegExp(`(?<![\\p{L}])(${FORMER_NAMES.map(escape).join('|')})(?![\\p{L}])`, 'iu');

const TEXT = /\.(mjs|js|jsx|ts|tsx|json|ya?ml|md|css|html|sql)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'runs', '.git', '.demo-studio']);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(p, out);
    } else if (TEXT.test(e.name) && p !== SELF) {
      out.push(p);
    }
  }
  return out;
}

interface Lot {
  ref: string;
  name: string;
  farm: string;
  producer: string;
  harvest_year: number;
  awards: Array<{ title: string }>;
}
interface Product {
  slug: string;
  name: string;
  farm: string;
  producer: string;
  status: string;
  shelves: string[];
  prices: Record<string, number>;
  registry_refs: string[];
  availability: Array<{ region: string }>;
  awards: Array<{ title: string }>;
}
interface SeedModule {
  buildSeed(): { products: Product[]; quotes: Array<{ buyer_name: string }> };
  registryEntries(): Lot[];
  pricesFor(price5: number): Record<string, number>;
  VAT_RATE: number;
  SHIPPING_EUR: number;
}

async function seed(): Promise<SeedModule> {
  return (await import(join(ROOT, 'fixtures/wholesale/server/seed.mjs'))) as SeedModule;
}

async function scenario(name: string): Promise<Record<string, unknown> & { scenes: Array<Record<string, unknown>> }> {
  return parse(await readFile(join(ROOT, 'projects/northfield-fixture/scenarios', `${name}.yaml`), 'utf8'));
}

describe('fixture names are invented (R-ISS-10, R-PRIN-01)', () => {
  it('no former real farm, station, producer, café or competition name in the fixture, its project, the tests or the docs', async () => {
    const roots = ['fixtures/wholesale', 'projects/northfield-fixture', 'packages', 'templates', 'README.md', 'docs/SPEC.md', 'docs/DESIGN.md', 'docs/DESIGN-phase2.md'];
    const files: string[] = [];
    for (const r of roots) {
      const abs = join(ROOT, r);
      if (TEXT.test(r)) files.push(abs);
      else await walk(abs, files);
    }
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        const m = FORMER_RE.exec(line);
        if (m) hits.push(`${relative(ROOT, f)}:${i + 1}: ${m[1]}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('every lot, product, producer, award and café of the seed avoids them', async () => {
    const { buildSeed, registryEntries } = await seed();
    const s = buildSeed();
    const strings = [
      ...registryEntries().flatMap((l) => [l.name, l.farm, l.producer, ...l.awards.map((a) => a.title)]),
      ...s.products.flatMap((p) => [p.name, p.slug, p.farm, p.producer, ...(p.awards ?? []).map((a) => a.title)]),
      ...s.quotes.map((q) => q.buyer_name),
    ].filter((x): x is string => typeof x === 'string');
    expect(strings.length).toBeGreaterThan(60);
    expect(strings.filter((x) => FORMER_RE.test(x))).toEqual([]);
  });
});

describe('the fixture scenarios still find what they rely on', () => {
  it('catalogue: the hero product, the archived registry lot it frees, and the typed registry search', async () => {
    const { buildSeed, registryEntries } = await seed();
    const { products } = buildSeed();
    const sc = await scenario('catalogue');
    const scenes = Object.fromEntries(sc.scenes.map((x) => [x.id as string, x]));

    // availability scene: /availability/products/<slug> with Iceland and Sweden rows.
    const slug = String(scenes.availability.open).split('/').pop()!;
    const hero = products.find((p) => p.slug === slug)!;
    expect(hero, slug).toBeDefined();
    expect(hero.availability.map((r) => r.region)).toEqual(expect.arrayContaining(['Iceland', 'Sweden']));

    // add-product scene: the typed name finds a 2026 registry lot held by an archived product, whose refs the setup frees.
    const steps = scenes['add-product'].steps as Array<Record<string, { text?: string; contains?: string[] }>>;
    const typed = steps.find((st) => st.type)!.type.text!;
    const contains = steps.find((st) => st.click?.contains)!.click.contains!;
    expect(contains[0]).toBe(typed);
    const lots = registryEntries().filter((l) => l.name.toLowerCase().includes(typed.toLowerCase()));
    const lot2026 = lots.find((l) => l.harvest_year === 2026)!;
    expect(lot2026, typed).toBeDefined();
    expect(lots.length).toBeGreaterThan(1); // the search lists several harvests: the scenario must pick 2026
    const archived = products.find((p) => p.registry_refs.includes(lot2026.ref))!;
    expect(archived.status).toBe('archived');
    const setup = sc.setup as Array<{ http?: { url: string } }>;
    expect(setup.some((h) => h.http?.url.endsWith(`/api/products/${archived.slug}/refs`))).toBe(true);
    // The awards reveal needs awards on that lot.
    expect(lot2026.awards.length).toBeGreaterThan(0);
  });

  it('quote: the hovered and opened products exist, and the proposal totals €720.00', async () => {
    const { buildSeed, VAT_RATE, SHIPPING_EUR } = await seed();
    const { products } = buildSeed();
    const sc = await scenario('quote');
    const discover = sc.scenes.find((x) => x.id === 'discover')!.steps as Array<Record<string, unknown>>;
    const hovered = (discover.find((st) => st.hover)!.hover as { text: string }).text;
    const opened = discover.find((st) => st.click)!.click as string;
    expect(products.find((p) => p.name === hovered), hovered).toBeDefined();
    const product = products.find((p) => p.name === opened)!;
    expect(product, opened).toBeDefined();
    expect(product.shelves).toContain('arrivals'); // shown under "Fresh arrivals"
    const total = (3 * 5 * product.prices['5 kg'] + SHIPPING_EUR) * (1 + VAT_RATE);
    expect(total.toFixed(2)).toBe('720.00');
  });
});
