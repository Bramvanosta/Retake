/**
 * L3.3 engine.scenarios.fromScript (R-MCP-22): drafts of script tables validate against the fixture project — a
 * French-header table, an English one with every row type, and a loop over generated tables (random scene names,
 * times, captions, pages and types: every draft validates). Nothing is written to the project.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScenario, seededRandom } from '@retake/core';
import { createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';

const PROJECT = 'northfield-fixture';
let root: string;
let engine: Engine;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-authoring-'));
  await fixtureWorkspace(root);
  engine = await createEngine({ root, client: 'mcp' });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const FRENCH = [
  '# Vidéo devis (60 s)',
  '',
  '| Temps | Scène | À l’écran | Texte | Surtitre | Page | Type |',
  '|---|---|---|---|---|---|---|',
  '| 0:00–0:04 | | | Demander un devis en une minute | Pour les cafés | | titre |',
  '| 0:04–0:16 | Découvrir | Survoler les lots primés | Des lots primés, torréfiés à la commande. | Découvrir | shop | |',
  '| 0:16–0:24 | | Ouvrir Selowa Ridge | | | | |',
  '| 0:24–0:40 | Devis | Remplir le formulaire de devis | Quantité, format, mouture. | Devis | | |',
  '| 0:40–0:43 | | | Quelques heures plus tard | | | intertitre |',
  '| 0:43–0:55 | Proposition | La cloche sonne, ouvrir la proposition | La proposition arrive. | | shop.northfield.example/ | |',
  '| 0:55–1:00 | | | Du devis à la proposition, au même endroit. | | | outro |',
].join('\n');

describe('engine.scenarios.fromScript', () => {
  it('a French-header table: an outline and a draft that validates against the project (agent rules), nothing written', async () => {
    const before = await readdir(join(root, 'projects', PROJECT, 'scenarios'));
    const d = await engine.scenarios.fromScript(PROJECT, FRENCH, { name: 'devis-draft' });
    expect(d).toMatchObject({ project: PROJECT, env: 'local', name: 'devis-draft' });
    expect(d.validation.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(d.validation.ok).toBe(true);
    expect(d.script_issues).toEqual([]);
    expect(d.outline.total_s).toBe(60);
    expect(d.outline.title).toMatchObject({ kicker: 'Pour les cafés', text: 'Demander un devis en une minute', duration_s: 4 });
    expect(d.outline.scenes.map((s) => s.id ?? s.kind)).toEqual(['decouvrir', 'devis', 'interstitial', 'proposition']);
    const v = parseScenario(d.yaml).scenario as unknown as { video: string; scenes: Array<{ page?: string; open?: string; steps?: Array<{ hold: number; note?: string }> }> };
    expect(v.video).toBe('devis-draft');
    expect(v.scenes[0]).toMatchObject({
      page: 'shop',
      open: '/',
      steps: [
        { hold: 12, note: 'Survoler les lots primés' },
        { hold: 8, note: 'Ouvrir Selowa Ridge' },
      ],
    });
    // The display host of the shop maps to its page key: no URL in the draft.
    expect(v.scenes[3]).toMatchObject({ page: 'shop', open: '/' });
    expect(d.yaml).not.toMatch(/https?:|localhost|\.example/);
    expect(await readdir(join(root, 'projects', PROJECT, 'scenarios'))).toEqual(before);
  });

  it('pages of another environment, an unknown environment, a bad name', async () => {
    const md = '| Time | Scene | Action | Page |\n|---|---|---|---|\n| 0:00 | Products | List the products | http://localhost:4403/products |\n| 0:10 | End | Done | |\n';
    const d = await engine.scenarios.fromScript(PROJECT, md, { env: 'signed-in' });
    expect(d.env).toBe('signed-in');
    expect(d.outline.scenes[0]).toMatchObject({ page: 'console', path: '/products' });
    expect(d.validation.ok, JSON.stringify(d.validation.issues)).toBe(true);
    // The same URL is not a page of the local environment: left out, with a warning at its cell.
    const local = await engine.scenarios.fromScript(PROJECT, md);
    expect(local.script_issues.find((i) => i.line === 3)).toMatchObject({ col: 41, message: expect.stringContaining('a draft never carries a URL') });
    await expect(engine.scenarios.fromScript(PROJECT, md, { env: 'nowhere' })).rejects.toThrow(/unknown environment "nowhere"/);
    await expect(engine.scenarios.fromScript(PROJECT, md, { name: '../x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a script with no table: no draft, not ok, the error at its line', async () => {
    const d = await engine.scenarios.fromScript(PROJECT, 'Open the shop, then request a quote.');
    expect(d.yaml).toBe('');
    expect(d.validation).toEqual({ ok: false, issues: [] });
    expect(d.script_issues).toMatchObject([{ severity: 'error', line: 1 }]);
  });

  it('every draft of 60 generated tables validates against the project', async () => {
    const rnd = seededRandom('script-draft');
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    const headers = [
      ['Time', 'Scene', 'Action', 'Caption', 'Kicker', 'Page', 'Type'],
      ['Temps', 'Scène', 'À l’écran', 'Texte', 'Surtitre', 'Page', 'Type'],
      ['Timecode', 'Section', 'On screen', 'Voice-over', 'Kicker', 'URL', 'Kind'],
    ] as const;
    const names = ['Discover', 'Request', 'Café crème', 'Étape 2', 'Proposal', '★ Bonus', 'Delivery & billing', 'x'];
    const texts = ['Award-winning lots.', 'Choose: quantity, size, grind', '"Quoted" text', 'Line with # hash', '- dash first', 'yes', '12:30', '@handle'];
    const pages = ['', '', 'shop', 'console', 'shop:/products', '/quotes', 'https://shop.northfield.example/x', 'http://localhost:4401/', 'https://elsewhere.example/', 'catalog'];
    const types = ['', '', '', '', 'interstitial', 'intertitre', 'title', 'outro', 'carton', 'weird'];
    for (let n = 0; n < 60; n++) {
      const h = pick(headers);
      const rows: string[] = [];
      let t = 0;
      const count = 2 + Math.floor(rnd() * 9);
      for (let i = 0; i < count; i++) {
        const d = 1 + Math.floor(rnd() * 20);
        const time =
          rnd() < 0.7
            ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}${rnd() < 0.5 ? `–${Math.floor((t + d) / 60)}:${String((t + d) % 60).padStart(2, '0')}` : ''}`
            : rnd() < 0.5
              ? ''
              : 'soon';
        const cells = [time, rnd() < 0.5 ? pick(names) : '', rnd() < 0.8 ? pick(texts) : '', rnd() < 0.6 ? pick(texts) : '', rnd() < 0.3 ? pick(names) : '', pick(pages), pick(types)];
        rows.push(`| ${cells.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`);
        t += d;
      }
      const md = [`| ${h.join(' | ')} |`, `|${h.map(() => '---').join('|')}|`, ...rows].join('\n');
      const d = await engine.scenarios.fromScript(PROJECT, md);
      if (!d.yaml) {
        // Only title / outro / interstitial rows: no captured scene, said as the one error.
        expect(
          d.script_issues.filter((i) => i.severity === 'error').map((i) => i.message),
          md,
        ).toEqual([expect.stringMatching(/no scene row/)]);
        continue;
      }
      expect(
        d.validation.issues.filter((i) => i.severity === 'error'),
        `${md}\n\n${d.yaml}`,
      ).toEqual([]);
      expect(d.yaml).not.toMatch(/https?:\/\/|localhost|elsewhere/);
    }
  });
});
