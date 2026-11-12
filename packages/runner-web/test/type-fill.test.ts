/**
 * Hotfix v0.2.6 (field point 25) — `type: {fill: true}` sets the value at once, as a browser autofill: one input event
 * and a change event, never a key per character; the value check still runs (`data.rate: fill`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TimelineEvent } from '@retake/core';
import { PERSON_POLICY } from '@retake/core';
import { runScenario } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

const PAGE = `<!doctype html><html><head><title>Sign up</title></head><body>
<label>Email <input id="email"></label> <label>Company <input id="co"></label>
<p id="log"></p>
<script>
const log = { input: 0, change: 0, keydown: 0 };
for (const id of ['email', 'co']) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => { log.input++; show(); });
  el.addEventListener('change', () => { log.change++; show(); });
  el.addEventListener('keydown', () => { log.keydown++; show(); });
}
function show() { document.getElementById('log').textContent = 'input=' + log.input + ' change=' + log.change + ' keydown=' + log.keydown + ' email=' + document.getElementById('email').value + ';'; }
</script></body></html>`;

let server: TestServer;
let dir: string;
beforeAll(async () => {
  server = await startServer({ '/form.html': PAGE });
  dir = await tempDir();
});
afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('type with fill (hotfix v0.2.6)', () => {
  it('fills the field at once: one input event, a change event, no key', async () => {
    const project = makeProject(dir, { app: server.url });
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project,
      mode: 'dry',
      runId: 'fill',
      scenario: makeScenario('fill', {
        pacing: FAST,
        scenes: [
          {
            id: 'form',
            open: '/form.html',
            steps: [{ type: { into: { label: 'Email' }, text: 'buyer@example.com', fill: true } }, { assert: { text: 'input=1 change=1 keydown=0 email=buyer@example.com;' } }],
          },
        ],
      }),
    });
    expect(rec.error?.message).toBeUndefined();
    const events = (await readTimeline(join(rec.dir, 'timeline.json'))).events.filter((e: TimelineEvent) => e.step === 0);
    expect(events[0].data).toMatchObject({ rate: 'fill', chars: 17 });
  });
});
