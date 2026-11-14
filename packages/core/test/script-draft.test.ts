/**
 * L3.3 scenario_from_script's parser (R-MCP-22): one GFM table, English and French headers, M:SS times and ranges,
 * durations, the type column (interstitial, title, outro), pages mapped to environment keys (a URL never reaches the
 * draft), positioned issues, timing warnings, and a draft that parses as a scenario. Pure: no project, no files.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { draftScenarioFromScript, hasErrors, parseScenario } from '../src/index.js';

const env = {
  name: 'local',
  pages: { console: 'http://localhost:4401', shop: 'http://localhost:4402/app' },
  display: { console: 'https://console.northfield.example', shop: 'https://shop.northfield.example' },
};

const EN = `# Quote request — 1 minute

| Time | Scene | Action | Caption | Kicker |
|------|-------|--------|---------|--------|
| 0:00 | Discover | Hover the lot of the month | Award-winning lots, roasted to order. | Discover |
| 0:08 | | Scroll to the fresh arrivals | | |
| 0:16 | | Open Selowa Ridge | Every lot has its story. | |
| 0:24–0:40 | Request | Fill in the quote form | Choose the quantity and the grind. | Request a quote |
| 0:40 | Delivery | Pick a delivery window | Pick a window. | Delivery |
| 1:02 | Proposal | Open the proposal | The proposal arrives. | |
`;

function yamlOf(md: string, video = 'draft') {
  const d = draftScenarioFromScript(md, { env, video });
  return { ...d, value: parse(d.yaml) as Record<string, unknown> };
}

describe('draftScenarioFromScript', () => {
  it('an English table: scenes grouped by name, one hold per beat sized to its time, the action as its note, captions', () => {
    const d = yamlOf(EN, 'quote-draft');
    expect(d.outline.columns).toEqual({ time: 'Time', scene: 'Scene', action: 'Action', caption: 'Caption', kicker: 'Kicker' });
    expect(d.outline.rows).toBe(6);
    expect(d.outline.scenes.map((s) => [s.id, s.duration_s, s.beats.length])).toEqual([
      ['discover', 24, 3],
      ['request', 16, 1],
      ['delivery', 22, 1],
      ['proposal', 5, 1],
    ]);
    expect(d.outline.total_s).toBe(67);
    const scenes = d.value.scenes as Array<Record<string, unknown>>;
    expect(scenes[0]).toEqual({
      id: 'discover',
      caption: { kicker: 'Discover', text: 'Award-winning lots, roasted to order.' },
      page: 'console',
      open: '/',
      steps: [
        { hold: 8, note: 'Hover the lot of the month' },
        { hold: 8, note: 'Scroll to the fresh arrivals' },
        { hold: 8, note: 'Open Selowa Ridge', caption: { text: 'Every lot has its story.' } },
      ],
    });
    // Later scenes continue on the page (no page / open written).
    expect(scenes[1]).not.toHaveProperty('open');
    expect(d.value.video).toBe('quote-draft');
    expect(d.yaml).toMatch(/^# Draft from a timecoded script/);
    // The last row has no end: 5 s assumed, said at its line.
    expect(d.issues).toEqual([{ severity: 'warning', line: 10, message: 'no end or duration: 5 s assumed' }]);
    const { scenario, issues } = parseScenario(d.yaml);
    expect(hasErrors(issues), JSON.stringify(issues)).toBe(false);
    expect(scenario?.scenes.length).toBe(4);
  });

  it('French headers, ranges, the type column (title, interstitial, outro) and pages mapped to keys', () => {
    const md = [
      '| Temps | Scène | À l’écran | Texte | Surtitre | Page | Type |',
      '| :-- | :-- | :-- | :-- | :-- | :-- | :-: |',
      '| 0:00–0:04 | | Logo | Demander un devis | Pour les cafés | | titre |',
      '| 0:04 – 0:20 | Découvrir | Survol de la carte | Des lots primés | Découvrir | shop.northfield.example/products | |',
      '| 0:20 à 0:36 | Proposition | La cloche sonne | La proposition arrive | | console:/quotes | |',
      '| 0:36-0:39 | | | Quelques heures plus tard | | | intertitre |',
      '| 0:39→0:55 | Suivi | Le tableau de bord | Tout au même endroit | | http://localhost:4402/app/orders?tab=open | |',
      '| 0:55–1:00 | | | Du devis à la proposition | | | outro |',
    ].join('\n');
    const d = yamlOf(md);
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(d.value.title).toEqual({ kicker: 'Pour les cafés', text: 'Demander un devis' });
    expect(d.value.intro).toEqual({ duration: 4 });
    expect(d.value.outro).toEqual({ tagline: 'Du devis à la proposition', duration: 5 });
    const scenes = d.value.scenes as Array<Record<string, unknown>>;
    expect(scenes.map((s) => s.id ?? 'interstitial')).toEqual(['decouvrir', 'proposition', 'interstitial', 'suivi']);
    expect(scenes[0]).toMatchObject({ page: 'shop', open: '/products', steps: [{ hold: 16, note: 'Survol de la carte' }] });
    expect(scenes[1]).toMatchObject({ page: 'console', open: '/quotes' });
    expect(scenes[2]).toEqual({ interstitial: { text: 'Quelques heures plus tard', duration: 3 } });
    // A real URL of a page (its base path /app) → its key and the path under it; never the URL itself.
    expect(scenes[3]).toMatchObject({ page: 'shop', open: '/orders?tab=open' });
    expect(d.yaml).not.toMatch(/localhost|northfield\.example/);
    expect(d.outline.total_s).toBe(60);
    expect(hasErrors(parseScenario(d.yaml).issues)).toBe(false);
  });

  it('a duration column instead of times; a URL of no page, an unknown key and a template are left out with positioned warnings', () => {
    const md = [
      'Intro paragraph | with a pipe that is not a table.',
      '',
      '| Duration | Section | On screen | Text | Page |',
      '|---|---|---|---|---|',
      '| 6s | Home | Land on the home page | Hello | https://other.example/home |',
      '| 0:07 | Catalogue | Browse the catalogue | {{env:SECRET}} | catalog |',
      '| 5 | Cart | Add to cart \\| checkout | Done | /cart |',
    ].join('\n');
    const d = yamlOf(md);
    expect(d.outline.scenes.map((s) => [s.id, s.start_s, s.duration_s, s.page, s.path])).toEqual([
      ['home', 0, 6, 'console', '/'],
      ['catalogue', 6, 7, undefined, undefined],
      ['cart', 13, 5, 'console', '/cart'],
    ]);
    expect(d.outline.scenes[2].beats[0].action).toBe('Add to cart | checkout');
    const at = d.issues.map((i) => `${i.line}:${i.col ?? '-'} ${i.message}`);
    expect(at).toContain(`5:47 page "https://other.example/home" is not on one of environment local's pages (console, shop): left out — a draft never carries a URL`);
    expect(at.find((m) => m.startsWith('6:62 page "catalog" is not a page key'))).toBeDefined();
    expect(at.find((m) => m.startsWith('6:45 caption: a {{…}} template'))).toBeDefined();
    expect(d.yaml).not.toContain('{{');
    expect(d.yaml).not.toContain('other.example');
    // 18 s in all: under the look's 1:00–2:00, said at the header; each scene is short.
    expect(at).toContain(`3:- the script lasts 0:18 (18 s): the reference look targets 1:00–2:00`);
    expect(at.filter((m) => /short \(the look: 4–25 s per scene\)/.test(m)).length).toBe(0);
    expect(hasErrors(parseScenario(d.yaml).issues)).toBe(false);
  });

  it('bad times, overlaps, long and unreadable scenes are positioned warnings; the draft still parses', () => {
    const md = [
      '| Time | Scene | Action |',
      '|---|---|---|',
      '| 0:00 | One | A |',
      '| 0:1 | | B |',
      '| 0:30 | Two | C |',
      '| 0:29 | Three | D |',
      '| 0:30 | Four | E |',
      '| 0:31–0:40 | Five | |',
    ].join('\n');
    const d = yamlOf(md);
    const at = d.issues.map((i) => `${i.line}:${i.col ?? '-'} ${i.message}`);
    expect(at).toContain('4:3 time "0:1": expected M:SS or a range M:SS–M:SS — the row starts where the previous one ends');
    // The row with a bad time shares the span up to the next time with the row before it.
    expect(d.outline.scenes[0].beats.map((b) => [b.start_s, b.duration_s])).toEqual([
      [0, 15],
      [15, 15],
    ]);
    expect(at).toContain('5:- ends at or before its start (0:30): 5 s assumed');
    expect(at).toContain('6:3 starts at 0:29, before the previous row ends (0:35)');
    expect(at).toContain('3:- scene "One" lasts 30 s: long — split it (the look: 4–25 s per scene)');
    expect(at).toContain('7:- scene "Four" lasts 1 s: too short to read (under 2 s)');
    expect(at).toContain('8:- no action: the beat holds with no note');
    expect(hasErrors(parseScenario(d.yaml).issues)).toBe(false);
  });

  it('scene names that slug the same get unique ids; a name with no letters gets a numbered id', () => {
    const md = ['| Time | Scene |', '|---|---|', '| 0:00 | Café | ', '| 0:10 | Cafe! |', '| 0:20 | ★ |', '| 0:30 | | '].join('\n');
    const d = yamlOf(md);
    expect(d.outline.scenes.map((s) => s.id)).toEqual(['cafe', 'cafe-2', 'scene-3']);
    expect(hasErrors(parseScenario(d.yaml).issues)).toBe(false);
  });

  it('no usable table: one error, no draft', () => {
    expect(draftScenarioFromScript('Just prose, no table.', { env })).toMatchObject({
      yaml: '',
      issues: [{ severity: 'error', line: 1, message: expect.stringMatching(/^no Markdown table found/) }],
    });
    const other = draftScenarioFromScript('\n| Name | Price |\n|---|---|\n| A | 1 |\n', { env });
    expect(other.yaml).toBe('');
    expect(other.issues[0]).toMatchObject({ severity: 'error', line: 2, message: expect.stringMatching(/^no table with a time \(or duration\) column/) });
    const only = draftScenarioFromScript('| Time | Type | Caption |\n|---|---|---|\n| 0:00 | title | Hi |\n', { env });
    expect(only.issues.at(-1)?.message).toMatch(/no scene row/);
  });

  it('is deterministic and reads only the first script table', () => {
    const twice = `${EN}\n\n${EN}`;
    const a = draftScenarioFromScript(twice, { env });
    const b = draftScenarioFromScript(twice, { env });
    expect(a.yaml).toBe(b.yaml);
    expect(a.outline.rows).toBe(6);
    expect(a.issues.some((i) => /another script table/.test(i.message))).toBe(true);
  });
});
