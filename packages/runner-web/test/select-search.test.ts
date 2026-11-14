/**
 * Hotfix v0.2.2 — `select` / `pick` on a long list that renders only its first options and filters by a search field
 * (a country list): without `search`, the option's own text is typed in the list's search field when the option does
 * not show; a list without a search field, or an option no search finds, fails saying which.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Step, TimelineEvent } from '@retake/core';
import { PERSON_POLICY } from '@retake/core';
import { runScenario } from '../src/index.js';
import { FAST, makeScenario, startServer } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir } from './helpers.js';
import type { TestServer } from '@retake/test-support/capture';

/** 60 options; the list shows the first 5 that match its search (`search=1`), or the first 5 of all with no search field. */
const LIST_PAGE = `<!doctype html><html><head><title>Sign up</title><style>body{font:16px sans-serif;margin:40px}</style></head><body>
<h1>Sign up</h1>
<p><span id="c-label">Country</span> <button id="c" role="combobox" aria-labelledby="c-label" aria-haspopup="listbox" aria-expanded="false">Choose…</button></p>
<p id="status"></p>
<p id="inputs"></p>
<script>
const ALL = ['Albania', 'Belgium', 'Chile', 'Denmark', 'Estonia', 'France', 'Germany', 'Hungary', 'Iceland', 'Japan'].concat(Array.from({ length: 50 }, (_, i) => 'Land ' + (i + 1)));
const withSearch = new URLSearchParams(location.search).get('search') !== '0';
const c = document.getElementById('c');
let lb = null;
const close = () => { lb?.remove(); lb = null; c.setAttribute('aria-expanded', 'false'); };
c.addEventListener('click', () => {
  if (lb) return close();
  lb = document.createElement('div');
  lb.setAttribute('data-radix-popper-content-wrapper', '');
  const r = c.getBoundingClientRect();
  lb.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #ccc;padding:6px;width:260px';
  lb.innerHTML = (withSearch ? '<input id="q" placeholder="Search…">' : '') + '<div role="listbox"></div>';
  const draw = (q) => { lb.querySelector('[role=listbox]').innerHTML = ALL.filter((o) => o.toLowerCase().includes(q.toLowerCase())).slice(0, 5).map((o) => '<div role="option" style="padding:6px">' + o + '</div>').join(''); };
  draw('');
  document.body.appendChild(lb);
  c.setAttribute('aria-expanded', 'true');
  const typed = [];
  lb.querySelector('#q')?.addEventListener('input', (e) => { draw(e.target.value); typed.push(e.target.value); document.getElementById('inputs').textContent = 'inputs=' + typed.join('|') + ';'; });
  lb.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; c.textContent = o.textContent; document.getElementById('status').textContent = 'country=' + o.textContent; close(); });
});
</script></body></html>`;

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/list.html': LIST_PAGE });
  dir = await tempDir();
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function run(runId: string, open: string, steps: Step[], timeout = 4) {
  const project = makeProject(dir, { app: server.url });
  const rec = await runScenario({
    policy: PERSON_POLICY,
    project,
    mode: 'dry',
    runId,
    scenario: makeScenario(runId, { pacing: FAST, defaults: { timeout_s: timeout }, scenes: [{ id: 'form', open, steps }] }),
  });
  const events = (await readTimeline(join(rec.dir, 'timeline.json'))).events.filter((e: TimelineEvent) => e.step >= 0);
  return { rec, events };
}

const roles = (e: TimelineEvent) => ((e.data as { clicks?: Array<{ role: string }> } | undefined)?.clicks ?? []).map((c) => c.role);

describe('select and pick on a list with a search field (hotfix v0.2.2)', () => {
  it('select without `search`: an option the list has not rendered is typed in its search field, then chosen; one it shows is clicked at once', async () => {
    const { rec, events } = await run('auto-search', '/list.html', [
      { select: { field: 'Country', option: 'Japan' } },
      { assert: { text: 'country=Japan' } },
      { select: { field: 'Country', option: 'Belgium' } },
      { assert: { text: 'country=Belgium' } },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(roles(events[0])).toEqual(['trigger', 'search', 'option']);
    expect(events[0].data).toMatchObject({ option: 'Japan', searched: 'Japan' });
    expect(roles(events[2])).toEqual(['trigger', 'option']);
    expect((events[2].data as { searched?: string }).searched).toBeUndefined();
  });

  it('pick without `search` searches for its first option too', async () => {
    const { rec, events } = await run('auto-search-pick', '/list.html', [{ pick: { field: 'Country', option: 'Iceland', close: 'none' } }, { assert: { text: 'country=Iceland' } }]);
    expect(rec.error?.message).toBeUndefined();
    expect(events[0].data).toMatchObject({ options: ['Iceland'], searched: 'Iceland' });
  });

  it('an option no search finds, and a list without a search field: the error says which', async () => {
    const none = await run('auto-search-none', '/list.html', [{ select: { field: 'Country', option: 'Atlantis' } }], 3);
    expect(none.rec.error?.message).toMatch(
      /select: "Atlantis" not found in the open popover after \d+\.\d s — typed in the list's search field, no option matched: give `search:` with the text that finds it/,
    );
    const plain = await run('no-search-field', '/list.html?search=0', [{ select: { field: 'Country', option: 'Japan' } }], 3);
    expect(plain.rec.error?.message).toMatch(/select: "Japan" not found in the open popover after \d+\.\d s; /);
    expect(plain.rec.error?.message).not.toContain('search');
  });

  it('hotfix v0.2.5: `search_instant` fills the search at once (one input: only the final list is filmed); `search_cps` types it at its own pace', async () => {
    const { rec, events } = await run('search-pace', '/list.html', [
      { select: { field: 'Country', option: 'Japan', search: 'Japan', search_instant: true } },
      { assert: { text: 'inputs=Japan;' } },
      { assert: { text: 'country=Japan' } },
      { pick: { field: 'Country', option: 'Iceland', search: 'Ice', search_cps: 40, close: 'none' } },
      { assert: { text: 'inputs=I|Ic|Ice;' } },
      { assert: { text: 'country=Iceland' } },
      // Without `search`, the search the runner types by itself fills at once too.
      { select: { field: 'Country', option: 'Hungary', search_instant: true } },
      { assert: { text: 'inputs=Hungary;' } },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(roles(events[0])).toEqual(['trigger', 'search', 'option']);
  });
});
