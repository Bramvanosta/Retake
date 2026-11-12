/**
 * L2.10 runner: `capture_text` (the visible text of an element, or the part a pattern selects, as a `text` artefact),
 * what the tutorial overlays need on the timeline (typing span and the focused field of a `type` without `into`, the
 * keys of a `press`) and the tutorial switches copied into the timeline (scenario, scene, step).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TimelineSchema, PERSON_POLICY } from '@retake/core';
import type { TextArtefact, Timeline } from '@retake/core';
import { captureValue, runScenario } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';

const APP = `<!doctype html><html><head><title>Form</title></head><body style="font-family:sans-serif;padding:40px">
<label>Name <input id="name"></label><br><br>
<label>Email <input id="email" style="width:320px"></label>
<p id="total" style="font-size:24px">Total <b>€1,240.50</b> <small>incl. VAT</small></p>
<p id="late">Calculating…</p>
<script>setTimeout(() => { document.getElementById('late').textContent = '921 offers created'; }, 600);</script>
</body></html>`;

let server: { url: string; close: () => Promise<void> };
let dir: string;
let tl: Timeline;
let runDir: string;

beforeAll(async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  server = { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
  dir = await tempDir('rw-tutorial-');
  const rec = await runScenario({
    policy: PERSON_POLICY,
    project: makeProject(dir, { app: server.url }),
    scenario: makeScenario('tutorial', {
      pacing: FAST,
      tutorial: { shortcuts: true, spotlight: 'clicks', steps: true, loupe: true, progress: 'scenes' },
      scenes: [
        {
          id: 'form',
          open: '/form.html',
          tutorial: { loupe: false },
          steps: [
            { type: { into: { css: '#name' }, text: 'Noa' } },
            { press: { key: 'Tab', times: 1 }, tutorial: { shortcuts: { params: { platform: 'windows' } } } },
            { type: { text: 'noa@cafe.example', enter: true } },
            { capture_text: { target: { css: '#total' }, as: 'total', pattern: '/(€\\s?[\\d.,]+)/' } },
            { capture_text: { target: { css: '#late' }, as: 'offers', pattern: '^\\d+' } },
            { capture_text: { target: { css: '#total' }, as: 'whole' } },
          ],
        },
      ],
    }),
    mode: 'dry',
    runId: `tutorial-${Date.now()}`,
  });
  expect(rec.status, JSON.stringify(rec.error)).toBe('succeeded');
  runDir = rec.dir;
  tl = await readTimeline(rec.timeline!);
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('capture_text (R-STO-01)', () => {
  it('keeps the pattern’s first group, waits for a late value, or the whole text', async () => {
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    const texts = (tl.artefacts ?? []).filter((a): a is TextArtefact => a.kind === 'text');
    expect(texts.map((a) => [a.name, a.value])).toEqual([
      ['total', '€1,240.50'],
      ['offers', '921'],
      ['whole', 'Total €1,240.50 incl. VAT'],
    ]);
    expect(texts[0]).toMatchObject({ text: 'Total €1,240.50 incl. VAT', scene: 'form', step: 3, file: 'artefacts/texts/total.json' });
    expect(texts[0].bbox?.w).toBeGreaterThan(0);
    const json = JSON.parse(await readFile(join(runDir, texts[0].file), 'utf8')) as { value: string; pattern: string };
    expect(json).toMatchObject({ value: '€1,240.50', pattern: '/(€\\s?[\\d.,]+)/' });
    const ev = tl.events.find((e) => e.action === 'capture_text')!;
    expect(ev.target?.desc).toMatch(/#total|Total/);
    expect(ev.data).toMatchObject({ artefact: 'text', name: 'total', value: '€1,240.50' });
  });

  it('captureValue', () => {
    expect(captureValue('Total €720.00', '/€([\\d.]+)/')).toBe('720.00');
    expect(captureValue('Total €720.00', 'Total')).toBe('Total');
    expect(captureValue('Total €720.00', '/xyz/')).toBeNull();
    expect(captureValue('Total €720.00')).toBe('Total €720.00');
  });
});

describe('what the tutorial overlays read on the timeline (R-TUT-01…05)', () => {
  it('the switches of the scenario, the scene and the step', () => {
    expect(tl.video?.tutorial).toEqual({ shortcuts: true, spotlight: 'clicks', steps: true, loupe: true, progress: 'scenes' });
    expect(tl.scenes.find((s) => s.id === 'form')?.tutorial).toEqual({ loupe: false });
    expect(tl.events.find((e) => e.action === 'press')?.tutorial).toEqual({ shortcuts: { params: { platform: 'windows' } } });
  });

  it('typing span, the focused field of a type without `into`, the Enter, the keys of a press', () => {
    const types = tl.events.filter((e) => e.action === 'type');
    const [a, b] = types.map((e) => e.data as { t_type: number; t_typed: number; t_enter?: number });
    expect(a.t_typed).toBeGreaterThan(a.t_type);
    expect(types[0].point).toBeDefined();
    // The second type has no `into`: the runner measured the focused field (the Email input, after Tab).
    expect(types[1].point).toBeUndefined();
    // 320 px content box plus the input's default padding and border.
    expect(types[1].target!.bbox!.w).toBeGreaterThanOrEqual(320);
    expect(types[1].target!.bbox!.w).toBeLessThan(340);
    expect(types[1].target!.bbox!.y).toBeGreaterThan(types[0].target!.bbox!.y);
    expect(b.t_enter).toBeGreaterThanOrEqual(b.t_typed);
    const press = tl.events.find((e) => e.action === 'press')!;
    expect(press.data).toEqual({ key: 'Tab', times: 1 });
    expect(press.t_click).toBeGreaterThanOrEqual(press.t_start);
  });
});
