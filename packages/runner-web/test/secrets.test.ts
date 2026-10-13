import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeStep } from '@demo-studio/core';
import type { RunProgress, RunRecord, Scenario } from '@demo-studio/core';
import { RunSecrets, TIMELINE_POLICY, describeStep, runScenario, trimSnippet } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

const EMAIL = 'agent@northfield.example';
const PASSWORD = 'S3cret-pw-42';
const TOKEN = 'tok-7f3a9c';
const SECRETS = [EMAIL, PASSWORD, TOKEN, encodeURIComponent(EMAIL)];

/** A fictional sign-in page: a visible email field, a password field whose value attribute follows its value (as React keeps it), customers. */
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{font:16px system-ui;margin:40px}label{display:block;margin:12px 0}input{font:16px system-ui;padding:6px;width:320px}</style>
</head><body>
<h1>Northfield console</h1>
<label>Work email <input id="email" type="email"></label>
<label>Password <input id="pw" type="password"></label>
<button type="button" id="go">Sign in</button>
<p id="who"></p>
<button type="button" class="open" data-name="Harbour Coffee Co.">Open Harbour Coffee Co.</button>
<button type="button" class="open" data-name="Finca Lirandel">Open Finca Lirandel</button>
<p id="out"></p>
<script>
const pw = document.getElementById('pw');
pw.addEventListener('input', () => pw.setAttribute('value', pw.value));
document.getElementById('go').onclick = () => { document.getElementById('who').textContent = 'Signed in as ' + document.getElementById('email').value; };
for (const b of document.querySelectorAll('.open')) b.onclick = () => { document.getElementById('out').textContent = b.dataset.name + ' — opened'; };
</script></body></html>`;

describe('RunSecrets (R-RUN-17)', () => {
  it('prefetches a keychain reference once, through the injected reader', async () => {
    const asked: string[] = [];
    const secrets = new RunSecrets(async (ref) => {
      asked.push(ref);
      return 'kc-value-0815';
    });
    await secrets.prefetch({ steps: [{ type: '{{keychain:demo-test/agent}}' }, { wait_for: 'x {{keychain:demo-test/agent}}' }], note: '{{keychain:other/one}}' });
    await secrets.prefetch('{{keychain:demo-test/agent}}');
    expect(asked).toEqual(['keychain:demo-test/agent']);
    expect(secrets.resolver('keychain:demo-test/agent')).toBe('kc-value-0815');
    expect(secrets.resolver('keychain:never/fetched')).toBeUndefined();
    expect(secrets.redactText('typed kc-value-0815')).toBe('typed ***');
    await expect(new RunSecrets(async () => Promise.reject(new Error('keychain item x/y not found'))).prefetch('{{keychain:x/y}}')).rejects.toThrow('not found');
  });

  it('registers what the environment resolver returns; redacts every form, longest first, and only values', () => {
    process.env.DEMO_STUDIO_TEST_SECRET_A = 'p@ss wörd"<x>';
    process.env.DEMO_STUDIO_TEST_SECRET_B = 'p@ss';
    try {
      const secrets = new RunSecrets();
      const untouched = { url: 'https://x.example/?q=p@ss' };
      expect(secrets.redactDeep(untouched)).toBe(untouched); // nothing registered: the same value, no copy
      expect(secrets.resolver('env:DEMO_STUDIO_TEST_SECRET_A')).toBe('p@ss wörd"<x>');
      expect(secrets.resolver('env:DEMO_STUDIO_TEST_SECRET_B')).toBe('p@ss');
      expect(secrets.contains('type p@ss wörd"<x> now')).toBe(true);
      expect(secrets.contains('nothing here')).toBe(false);
      expect(secrets.redactText('a p@ss wörd"<x> b')).toBe('a *** b');
      expect(secrets.redactText('?q=p%40ss%20w%C3%B6rd%22%3Cx%3E&r=p%40ss+w%C3%B6rd%22%3Cx%3E')).toBe('?q=***&r=***');
      expect(secrets.redactText('{"text":"p@ss wörd\\"<x>"}')).toBe('{"text":"***"}');
      expect(secrets.redactText('<input value="p@ss wörd&quot;&lt;x&gt;">p@ss wörd"&lt;x&gt;')).toBe('<input value="***">***');
      const tl = {
        run_id: 'r-p@ss',
        scenes: [{ id: 'p@ss-scene', page: 'p@ss', caption: { text: 'p@ss in a caption' }, url: 'http://x/?k=p@ss' }],
        events: [{ action: 'type', target: { desc: 'label="p@ss"' }, data: { value: 'p@ss' }, overlay: { slots: { text: 'p@ss' }, target: 'text="p@ss"' } }],
        artefacts: [{ kind: 'email', as: 'welcome', to: ['p@ss'] }],
        capture: { file: 'capture-p@ss.mp4' },
        warnings: ['typed p@ss'],
      };
      expect(secrets.redactDeep(tl as never, TIMELINE_POLICY)).toEqual({
        run_id: 'r-p@ss',
        scenes: [{ id: 'p@ss-scene', page: 'p@ss', caption: { text: 'p@ss in a caption' }, url: 'http://x/?k=***' }],
        events: [{ action: 'type', target: { desc: 'label="***"' }, data: { value: '***' }, overlay: { slots: { text: 'p@ss' }, target: 'text="***"' } }],
        artefacts: [{ kind: 'email', as: 'welcome', to: ['p@ss'] }],
        capture: { file: 'capture-p@ss.mp4' },
        warnings: ['typed ***'],
      });
      // Without a policy every string is redacted (a step about to be described).
      expect(secrets.redactDeep({ id: 'p@ss', name: 'p@ss' })).toEqual({ id: '***', name: '***' });
    } finally {
      delete process.env.DEMO_STUDIO_TEST_SECRET_A;
      delete process.env.DEMO_STUDIO_TEST_SECRET_B;
    }
  });

  it('a step is described without its secrets, so describeStep’s cut keeps no part of one', async () => {
    const secrets = new RunSecrets(async () => 'straddling-secret-value-123');
    await secrets.prefetch('{{keychain:a/b}}');
    const step = normalizeStep({ wait_for: { text: `${'x'.repeat(80)} straddling-secret-value-123` } }, 0);
    expect(describeStep(step)).toMatch(/ straddling"?$/); // the cut alone keeps a prefix
    const desc = describeStep(secrets.redactDeep(step));
    expect(desc).toContain('***');
    expect(desc).not.toContain('strad');
    // Keys kept elsewhere (a target's `name`, `label`) are redacted in a step too (L1.2 review: S4).
    for (const target of [{ name: `${'A'.repeat(70)} straddling-secret-value-123` }, { role: 'row', label: `${'B'.repeat(70)} straddling-secret-value-123` }]) {
      const d = describeStep(secrets.redactDeep(normalizeStep({ wait_for: { target } }, 0)));
      expect(d).not.toContain('strad');
    }
  });

  it('keeps strings only at the known positions of a run file: never in targets, camera targets, emit data or transition params (L1.2 review: D1, S4)', async () => {
    const secret = 'ACCT-99812-secret';
    const secrets = new RunSecrets(async () => secret);
    await secrets.prefetch('{{env:X}}');
    const tl = {
      scenes: [
        { id: 's1', page: 'app', transition: { component: 'studio/transition-tap-open', params: { label: secret } } },
        { id: 'c1', kind: 'card', card: { slots: { title: 'Welcome' }, transition: { component: 'x/t', params: { text: secret } } }, transition: 'crossfade' },
      ],
      events: [
        {
          scene: 's1', action: 'click', page: 'app', strategy: 'real',
          target: { desc: `row "Account ${secret}"` },
          camera: { zoom: 2, ease: 'slow', until: 'scene_end', target: { role: 'row', name: `Account ${secret}` } },
          overlay: { component: 'studio/callout', slots: { text: 'Saved' }, params: {}, target: `name="${secret}"` },
          data: { clicks: [{ role: 'trigger', strategy: 'real', desc: `name="${secret}"` }], navigation: { kind: 'document', url: `http://x/?t=${secret}` } },
        },
        { scene: 's1', action: 'emit', data: { name: 'login', data: { id: secret, name: secret, label: secret, path: secret, file: secret } } },
        { scene: 's1', action: 'eval', data: { value: { id: secret, name: secret } } },
        { scene: 's1', action: 'capture_text', data: { artefact: 'text', name: 'total', value: secret } },
        { scene: 's1', action: 'hover', camera: { zoom: 1.5, target: 'cursor' } },
      ],
      artefacts: [{ kind: 'text', name: 'total', file: 'artefacts/texts/total.json', value: secret, text: `Total ${secret}`, target: `css="#t-${secret}"` }],
    };
    const out = JSON.parse(JSON.stringify(secrets.redactTimeline(tl as never))) as typeof tl;
    expect(out.scenes[0].transition).toEqual({ component: 'studio/transition-tap-open', params: { label: '***' } });
    expect(out.scenes[1].card).toEqual({ slots: { title: 'Welcome' }, transition: { component: 'x/t', params: { text: '***' } } });
    expect(out.scenes[1].transition).toBe('crossfade');
    const [click, emit, evaled, captured, hover] = out.events;
    expect(click.target.desc).toBe('row "Account ***"');
    expect(click.camera).toEqual({ zoom: 2, ease: 'slow', until: 'scene_end', target: { role: 'row', name: 'Account ***' } });
    expect(click.overlay.target).toBe('name="***"');
    expect(click.data).toEqual({ clicks: [{ role: 'trigger', strategy: 'real', desc: 'name="***"' }], navigation: { kind: 'document', url: 'http://x/?t=***' } });
    expect(emit.data).toEqual({ name: 'login', data: { id: '***', name: '***', label: '***', path: '***', file: '***' } });
    expect(evaled.data).toEqual({ value: { id: '***', name: '***' } });
    expect(captured.data).toEqual({ artefact: 'text', name: 'total', value: '***' });
    expect(hover.camera).toEqual({ zoom: 1.5, target: 'cursor' });
    // A captured text is the app's own content; the description of the target read comes from the scenario.
    expect(out.artefacts[0]).toEqual({ ...tl.artefacts[0], target: 'css="#t-***"' });
    expect(JSON.stringify(secrets.redactProgress({ type: 'log', level: 'info', message: `typed ${secret}` }))).not.toContain(secret);
  });

  it('a short secret never corrupts timestamps, enums, ids or files (L1.2 review: S7)', async () => {
    const pin = new RunSecrets(async () => '2026');
    await pin.prefetch('{{env:PIN}}');
    const rec = {
      id: '20261013-094758-signup', project: 'p', scenario: 'signup', mode: 'capture', status: 'succeeded',
      started_at: '2026-10-13T09:47:58.123Z', finished_at: '2026-10-13T09:49:01.000Z', dir: '/runs/20261013-094758-signup', env: 'local',
      options: { until: 'checkout.3', hooks: 'run', headed: false }, steps_total: 3, steps_done: 3,
      capture: '/runs/20261013-094758-signup/capture.mp4', timeline: '/runs/20261013-094758-signup/timeline.json', screenshots: [],
      hooks: { setup: 'ok', teardown: 'none' }, warnings: ['PIN 2026 typed'], error: { message: 'no 2026', scene: 'checkout', step: 2, action: 'click', screenshot: '/runs/x/error-2026.png' },
    };
    const safeRec = pin.redactRecord(rec as never) as unknown as typeof rec;
    expect({ ...safeRec, warnings: rec.warnings, error: { ...safeRec.error, message: rec.error.message } }).toEqual(rec);
    expect(safeRec.warnings).toEqual(['PIN *** typed']);
    expect(safeRec.error.message).toBe('no ***');
    expect(pin.redactProgress({ type: 'run_start', run: rec as never })).toEqual({ type: 'run_start', run: safeRec });
    const tl = {
      run_id: '20261013-094758-signup', created_at: '2026-10-13T09:47:58Z', mode: 'capture', capture: { file: 'capture.mp4', t0_wall: 1 },
      loading: [{ t_start: 1, t_end: 2, page: 'app', until: 'paint', held_frames: 3 }],
      cursor_effects: [{ t: 1, type: 'icon', icon: 'hand' }],
      markers: [{ name: 'm2026', t: 1, scene: 's2026', step: 0 }],
      events: [{ scene: 's2026', step: 0, action: 'pick', status: 'ok', data: { clicks: [{ role: 'option', strategy: 'real', desc: 'text="2026"' }], days: ['2026-06-14'], close: 'outside', clear: 'keys', rate: 'search' } }],
      tracks: [{ id: 'buyer', file: 'capture-buyer.mp4', frames_file: 'frames-buyer.jsonl', loading: [{ until: 'limit' }], cursor_effects: [{ type: 'icon', icon: 'ibeam' }] }],
    };
    const safeTl = pin.redactTimeline(tl as never) as unknown as typeof tl;
    expect(safeTl.events[0].data.clicks[0].desc).toBe('text="***"');
    safeTl.events[0].data.clicks[0].desc = tl.events[0].data.clicks[0].desc;
    expect(safeTl).toEqual(tl);
  });

  it('trimSnippet cuts at the last tag within the cap and keeps the kit’s original length', () => {
    const html = `<div>${'<p>ab</p>'.repeat(20)}</div>`;
    expect(trimSnippet(html, 1000)).toBe(html);
    const cut = trimSnippet(html, 50);
    expect(cut).toMatch(/^<div>(<p>ab<\/p>)+\n<!-- … trimmed to \d+ of 191 chars -->$/);
    expect(trimSnippet(`${html.slice(0, 100)}\n<!-- … trimmed to 100 of 5000 chars -->`, 50)).toMatch(/ of 5000 chars -->$/);
  });
});

describe('templating and secrets in a run (R-RUN-16, R-RUN-17)', () => {
  let server: TestServer;
  let dir: string;
  beforeAll(async () => {
    server = await startServer({ '/login.html': LOGIN_PAGE });
    dir = await tempDir();
  });
  afterAll(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    process.env.DEMO_STUDIO_TEST_EMAIL = EMAIL;
    process.env.DEMO_STUDIO_TEST_PASSWORD = PASSWORD;
    process.env.DEMO_STUDIO_TEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.DEMO_STUDIO_TEST_EMAIL;
    delete process.env.DEMO_STUDIO_TEST_PASSWORD;
    delete process.env.DEMO_STUDIO_TEST_TOKEN;
  });

  async function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}): Promise<{ rec: RunRecord; events: RunProgress[] }> {
    const events: RunProgress[] = [];
    const rec = await runScenario({
      project: makeProject(dir, { app: server.url }),
      scenario: makeScenario(name, { pacing: FAST, vars: { customer: 'Harbour Coffee Co.' }, ...scenario }),
      mode: 'dry',
      runId: `${name}-${Date.now()}`,
      onProgress: (e) => events.push(e),
      ...opts,
    });
    return { rec, events };
  }

  /** Every text file of the run folder (run.json, log.jsonl, timeline.json, scenario.yaml, error-*.html). */
  async function runTexts(rec: RunRecord): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of await readdir(rec.dir, { recursive: true })) {
      if (/\.(json|jsonl|yaml|html)$/.test(f)) out[f] = await readFile(join(rec.dir, f), 'utf8');
    }
    return out;
  }

  function expectNoSecret(texts: Record<string, string>): void {
    for (const [file, text] of Object.entries(texts)) {
      for (const s of SECRETS) expect(text.includes(s), `${file} holds ${s}`).toBe(false);
    }
  }

  it('templates every step string, resolves env secrets and keeps their values out of every run file', async () => {
    const { rec, events } = await run('signin', {
      scenes: [
        {
          id: 'signin',
          open: '/login.html?token={{env:DEMO_STUDIO_TEST_TOKEN}}',
          caption: 'Sign in as {{vars.customer}}',
          steps: [
            { type: { into: { label: 'Work email' }, text: '{{env:DEMO_STUDIO_TEST_EMAIL}}' } },
            { type: { into: { label: 'Password' }, text: '{{env:DEMO_STUDIO_TEST_PASSWORD}}' } },
            { click: 'Sign in' },
            { wait_for: 'Signed in as {{env:DEMO_STUDIO_TEST_EMAIL}}' },
            { click: 'Open {{vars.customer}}', caption: { kicker: '{{vars.customer}}', text: 'Run {{run.id}}' } },
            { assert: '{{vars.customer}} — opened' },
            { emit: { name: 'quote', data: { customer: '{{vars.customer}}', who: '{{env:DEMO_STUDIO_TEST_EMAIL}}' } } },
            { eval: { js: "return document.getElementById('pw').value === arg", arg: '{{env:DEMO_STUDIO_TEST_PASSWORD}}' } },
            { eval: "return document.getElementById('pw').value" },
          ],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    expect(tl.scenes[0]).toMatchObject({ id: 'signin', page: 'app', caption: { text: 'Sign in as Harbour Coffee Co.' } });
    expect(tl.scenes[0].url).toBe(`${server.url}/login.html?token=***`);
    const steps = tl.events.filter((e) => e.step >= 0);
    expect(steps[4].caption).toEqual({ kicker: 'Harbour Coffee Co.', text: `Run ${rec.id}` });
    expect(steps[4].target?.desc).toContain('Open Harbour Coffee Co.');
    expect(steps[6].data).toEqual({ name: 'quote', data: { customer: 'Harbour Coffee Co.', who: '***' } });
    expect(steps[7].data).toEqual({ value: true }); // the password was typed exactly
    expect(steps[8].data).toEqual({ value: '***' });
    // Typing a secret into a visible field warns once (the email); the password field shows bullets.
    const visible = rec.warnings.filter((w) => w.includes('visible field'));
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatch(/^signin\.0: types the value of a secret reference into a visible field \(.*Work email.*\)/);
    // No secret value in any run file, in the returned record or in the progress events (the terminal, --json).
    const texts = await runTexts(rec);
    expect(Object.keys(texts).sort()).toEqual(['log.jsonl', 'run.json', 'scenario.yaml', 'timeline.json']);
    expectNoSecret(texts);
    expectNoSecret({ record: JSON.stringify(rec), events: JSON.stringify(events) });
    expect(texts['timeline.json']).toContain('token=***');
    expect(texts['log.jsonl']).toContain('"desc":"\\"***\\" into label=');
  });

  it('a text read by capture_text is kept as captured; the description of its target is not (L1.2 review: S4)', async () => {
    const { rec } = await run('capture-who', {
      scenes: [
        {
          id: 'signin',
          open: '/login.html',
          steps: [
            { type: { into: { label: 'Work email' }, text: '{{env:DEMO_STUDIO_TEST_EMAIL}}' } },
            { click: 'Sign in' },
            { capture_text: { target: { text: 'Signed in as {{env:DEMO_STUDIO_TEST_EMAIL}}' }, as: 'who', pattern: '^(Signed in) as' } },
          ],
        },
      ],
    });
    expect(rec.status).toBe('succeeded');
    const texts = await runTexts(rec);
    const file = JSON.parse(texts['artefacts/texts/who.json']) as { value: string; text: string; target: string };
    expect(file.value).toBe('Signed in');
    expect(file.text).toBe(`Signed in as ${EMAIL}`); // the app's own text: artefacts are kept as captured
    expect(file.target).toContain('***');
    expect(file.target).not.toContain(EMAIL);
    const tl = await readTimeline(rec.timeline!);
    expect(tl.artefacts?.[0]).toMatchObject({ kind: 'text', target: file.target });
    expect(tl.events.find((e) => e.action === 'capture_text')?.target?.desc).not.toContain(EMAIL);
    expectNoSecret({ 'log.jsonl': texts['log.jsonl'], 'run.json': texts['run.json'] });
  });

  it('a failing step keeps the secrets out of its error, its DOM snippet and the log', async () => {
    const { rec } = await run('signin-fail', {
      scenes: [
        {
          id: 'signin',
          open: '/login.html',
          steps: [
            { type: { into: { label: 'Password' }, text: '{{env:DEMO_STUDIO_TEST_PASSWORD}}' } },
            { click: { text: '{{env:DEMO_STUDIO_TEST_PASSWORD}}' }, timeout: 0.3 },
          ],
        },
      ],
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toContain('***');
    expect(rec.error?.dom).toBeDefined();
    const texts = await runTexts(rec);
    const dom = Object.keys(texts).find((f) => f.endsWith('.html'))!;
    expect(texts[dom]).toContain('value="***"'); // the password field's value attribute
    expectNoSecret(texts);
  });

  it('a missing environment variable fails the run up front, before the browser and any step', async () => {
    const { rec, events } = await run('unset', {
      scenes: [
        { id: 'first', open: '/login.html', steps: [{ click: 'Sign in' }] },
        { id: 'second', steps: [{ type: { into: { label: 'Password' }, text: '{{env:DEMO_STUDIO_UNSET_VAR}}' } }] },
      ],
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe('scene second: environment variable DEMO_STUDIO_UNSET_VAR is not set');
    expect(rec.steps_done).toBe(0);
    expect(events.some((e) => e.type === 'scene_start')).toBe(false);
  });

  it('a {{hooks.…}} token in a dry run without its setup hooks says how to run them', async () => {
    const { rec } = await run('hooks-skipped', {
      setup: [{ http: { method: 'POST', url: '{{app}}/api/quotes', save_as: 'quote' } }],
      scenes: [{ id: 'quote', open: '/login.html', steps: [{ type: { into: { label: 'Work email' }, text: 'q-{{hooks.quote.json.id}}' } }] }],
    });
    expect(rec.status).toBe('failed');
    expect(rec.hooks.setup).toBe('skipped');
    expect(rec.error?.message).toMatch(/^scenes\[0\]\.steps\[0\]\.type\.text: unknown template key \{\{hooks\.quote\.json\.id\}\}.* — the setup hooks were skipped \(a dry run skips them: add --hooks run\)$/);
  });
});
