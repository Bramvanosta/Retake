import { describe, expect, it } from 'vitest';
import { filmedChanges, parseScenario, replanEdit } from '@demo-studio/core';
import type { Scenario, Timeline, TimelineEvent } from '@demo-studio/core';

/** A scenario text: a setup hook, two scenes, a card between them. */
const BASE = `video: Quote
title: {kicker: Northfield, text: From quote to order}
env: staging
vars: {company: Acme Bakery, greeting: Hello}
setup:
  - {name: seed, http: {url: "{{admin}}/api/seed", method: POST}}
scenes:
  - id: open
    page: admin
    open: /quotes
    caption: Quotes at a glance
    steps:
      - click: {text: New quote}
        caption: Start a quote
      - type: {into: {label: Company}, text: "{{vars.company}}"}
      - hold: 1
  - card:
      slots: {title: "{{greeting}}, buyer"}
      duration: 2
    id: chapter
  - id: send
    steps:
      - click: Send
        hold: 0.5
`;

const changes = (now: string, then = BASE) => filmedChanges(now, then);

describe('filmedChanges (L5.5, R-FLD-01): only what drives the browser counts', () => {
  it('an edit-only change is no filmed change', () => {
    const edits: Array<[string, string]> = [
      ['the title', BASE.replace('text: From quote to order', 'text: "Quotes, faster"')],
      ['the video name', BASE.replace('video: Quote', 'video: Quote tour')],
      ['intro, outro, frame, template, music, tutorial, target length', `${BASE.replace('scenes:\n', 'intro: false\noutro: {tagline: Try it}\nframe: browser\ntemplate: editorial\nmusic: {file: assets/bed.mp3}\ntutorial: true\ntarget_length: {min_s: 30, max_s: 50}\nscenes:\n')}`],
      ['a scene caption, speed, transition, frame, tutorial and note', BASE.replace('    caption: Quotes at a glance\n', '    caption: All quotes\n    speed: 1.5\n    transition: cut\n    frame: laptop\n    tutorial: {spotlight: true}\n    note: shorter\n')],
      ['a step caption, speed, camera, mark, overlay, tutorial, id, note, timeout, optional', BASE.replace('        caption: Start a quote\n', '        caption: Begin\n        speed: 2\n        camera: {zoom: 1.4}\n        mark: start\n        overlay: {component: studio/overlay-callout, slots: {text: Here}}\n        tutorial: false\n        id: new\n        note: x\n        timeout: 30\n        optional: true\n        irreversible: true\n')],
      ['a card text and duration', BASE.replace('duration: 2', 'duration: 4').replace('{{greeting}}, buyer', 'Welcome')],
      ['the card order (moved before the first scene)', BASE.replace("  - card:\n      slots: {title: \"{{greeting}}, buyer\"}\n      duration: 2\n    id: chapter\n", '').replace('scenes:\n', "scenes:\n  - card:\n      slots: {title: \"{{greeting}}, buyer\"}\n      duration: 2\n    id: chapter\n")],
      ['a new interstitial', BASE.replace('  - id: send\n', '  - interstitial: {text: Later that day}\n  - id: send\n')],
      ['a var used only by a card', BASE.replace('greeting: Hello', 'greeting: Hi')],
      ['a shorthand written as its object form', BASE.replace('      - click: Send\n', '      - click: {text: Send}\n')],
      ['comments and key order', `# tour\n${BASE.replace('    page: admin\n    open: /quotes\n', '    open: /quotes   # list\n    page: admin\n')}`],
      ['the scene page written where it was inherited', BASE.replace('  - id: send\n', '  - id: send\n    page: admin\n')],
    ];
    for (const [what, now] of edits) expect(changes(now), what).toEqual([]);
  });

  it('a change to the filmed part is reported by its keys, scene ids and step keys', () => {
    expect(changes(BASE.replace('env: staging', 'env: demo'))).toEqual(['the environment (env)']);
    expect(changes(BASE.replace('/api/seed', '/api/seed2'))).toEqual(['the setup hooks']);
    expect(changes(BASE.replace('scenes:\n', 'teardown: [{shell: "true"}]\ncapture: {fps: 60}\npacing: {hover_ms: 300}\nclock: 2026-01-01T09:00:00Z\nmocks: [{match: "POST /x", status: 200}]\nscenes:\n'))).toEqual([
      'the teardown hooks',
      'the capture settings',
      'the pacing',
      'the product clock (clock)',
      'the write mocks (mocks)',
    ]);
    expect(changes(BASE.replace('company: Acme Bakery', 'company: Acme Mill'))).toEqual(['vars the take uses: company']);
    expect(changes(BASE.replace('open: /quotes', 'open: /quotes/new'))).toEqual(['scene open: open']);
    expect(changes(BASE.replace('    page: admin\n', '    page: shop\n'))).toEqual(['scene open: page', 'scene send: page']); // inherited by send
    expect(changes(BASE.replace('  - id: send\n', '  - id: send\n    still: 3\n    cursor: keep\n    persona: buyer\n'))).toEqual(['scene send: persona, still, cursor']);
    expect(changes(BASE.replace('  - id: send\n', '  - id: send\n    skip: true\n'))).toEqual(['scene send: skip']);
    expect(changes(BASE.replace('click: {text: New quote}', 'click: {text: New order}'))).toEqual(['scene open: step open.0 changed']);
    expect(changes(BASE.replace('      - hold: 1\n', '      - hold: 1\n      - press: Enter\n'))).toEqual(['scene open: step open.3 added']);
    expect(changes(BASE.replace('      - hold: 1\n', ''))).toEqual(['scene open: 1 step removed']);
    expect(changes(BASE.replace('        hold: 0.5\n', '        hold: 2\n'))).toEqual(['scene send: step send.0 changed']); // a hold modifier
    expect(changes(BASE.replace('        hold: 0.5\n', '        park: true\n'))).toEqual(['scene send: step send.0 changed']);
    expect(changes(`${BASE}  - id: extra\n    steps: [{hold: 1}]\n`)).toEqual(['scene extra added']);
    const swapped = BASE.replace(/  - id: open[\s\S]*?(?=  - card:)/, '').replace('  - id: send\n      ', 'x');
    expect(changes(swapped)).toContain('scene open removed');
    const reordered = `video: Quote\nenv: staging\nscenes:\n  - id: b\n    steps: [{hold: 1}]\n  - id: a\n    page: admin\n    steps: [{hold: 1}]\n`;
    expect(changes(reordered, reordered.replace(/  - id: b\n    steps: \[\{hold: 1\}\]\n(  - id: a\n    page: admin\n    steps: \[\{hold: 1\}\]\n)/, '$1  - id: b\n    steps: [{hold: 1}]\n'))).toContain('capture scenes reordered');
  });

  it('a page label is edit, the rest of a page filmed; a text that does not parse is undefined', () => {
    const pages = BASE.replace('    page: admin\n    open: /quotes\n', '    pages:\n      admin: {open: /quotes, label: Supplier}\n      shop: {open: /, viewport: mobile, label: Buyer}\n');
    expect(changes(pages.replace('label: Buyer', 'label: Customer'), pages)).toEqual([]);
    expect(changes(pages.replace('viewport: mobile', 'viewport: tablet'), pages)).toEqual(['scene open: pages']);
    expect(changes('video: [unclosed\n')).toBeUndefined();
  });
});

// ── replanEdit ───────────────────────────────────────────────────────────────

const parse = (text: string): Scenario => {
  const r = parseScenario(text);
  if (!r.scenario) throw new Error(r.issues.map((i) => i.message).join('\n'));
  return r.scenario;
};

const ev = (scene: string, step: number, t: number, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  scene,
  scene_index: scene === 'open' ? 0 : 2,
  step,
  action: 'click',
  t_start: t,
  t_end: t + 1,
  status: 'ok',
  ...extra,
});

/** The timeline a take of BASE recorded (templated values; a hook token resolved at capture). */
function timelineOf(): Timeline {
  return {
    version: 1,
    run_id: '20260101-120000-quote',
    project: 'demo',
    scenario: 'quote',
    created_at: '2026-01-01T12:00:00Z',
    mode: 'capture',
    capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 20, t0_wall: 0, frames: 600 },
    video: { title: { kicker: 'Northfield', text: 'From quote to order' }, frame: 'card', template: 'default' },
    scenes: [
      { id: 'open', index: 0, kind: 'scene', t_start: 0, t_end: 10, page: 'admin', caption: { text: 'Quotes at a glance' }, status: 'ok' },
      { id: 'chapter', index: 1, kind: 'card', t_start: 10, t_end: 10, card: { slots: { title: 'Hello, buyer' }, duration: 2 }, status: 'ok' },
      { id: 'send', index: 2, kind: 'scene', t_start: 10, t_end: 20, page: 'admin', status: 'ok' },
    ],
    events: [
      ev('open', -1, 0, { action: 'scene_still' }),
      ev('open', 0, 2, { caption: { text: 'Start a quote' }, target: { desc: 'button "New quote"', bbox: { x: 100, y: 50, width: 120, height: 40 } }, point: { x: 160, y: 70 }, end_point: { x: 160, y: 70 } }),
      ev('open', 1, 4, { action: 'type', target: { desc: 'field "Company"', bbox: { x: 300, y: 200, width: 400, height: 40 } }, end_point: { x: 500, y: 220 } }),
      ev('open', 2, 6, { action: 'hold', end_point: { x: 510, y: 230 } }),
      ev('send', 0, 12, { target: { desc: 'button "Send"', bbox: { x: 900, y: 600, width: 100, height: 40 } }, end_point: { x: 950, y: 620 } }),
    ],
    markers: [],
    pages: [{ id: 'admin', t_start: 0, t_end: 20, url: 'https://admin.example.test/quotes' }],
    cursor: [],
    idle: [],
    warnings: [],
  };
}

const replan = (now: string, timeline = timelineOf()) =>
  replanEdit({ timeline, now: parse(now), then: parse(BASE), project: { frame: 'card', template: 'default' }, ctx: { pages: { admin: 'https://admin.example.com' }, vars: { company: 'Acme Bakery', greeting: 'Hi' }, run: { id: 'r', dir: '/r' }, hooks: {} } });

describe('replanEdit (L5.5, R-FLD-01): today\'s edit on the take\'s measurements', () => {
  it('nothing changed: the timeline is the same', () => {
    const r = replan(BASE);
    expect(r.changes).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.timeline).toEqual(timelineOf());
  });

  it('captions, a card text, duration and place, the title and the template come from today; times and boxes stay', () => {
    const now = BASE.replace('caption: Quotes at a glance', 'caption: All quotes, one list')
      .replace('caption: Start a quote', 'caption: "Start for {{vars.company}}"')
      .replace('text: From quote to order', 'text: "Quotes, faster"')
      .replace('video: Quote\n', 'video: Quote\ntemplate: editorial\n')
      .replace("  - card:\n      slots: {title: \"{{greeting}}, buyer\"}\n      duration: 2\n    id: chapter\n", '')
      .replace('scenes:\n', 'scenes:\n  - card:\n      slots: {title: "{{greeting}}, welcome"}\n      duration: 3.5\n    id: chapter\n');
    const r = replan(now);
    const t = r.timeline;
    expect(t.scenes.map((s) => [s.id, s.kind, s.index])).toEqual([['chapter', 'card', 0], ['open', 'scene', 1], ['send', 'scene', 2]]);
    expect(t.scenes[0].card).toEqual({ slots: { title: 'Hi, welcome' }, duration: 3.5 });
    expect(t.scenes[1].caption).toEqual({ text: 'All quotes, one list' });
    expect(t.scenes[1]).toMatchObject({ t_start: 0, t_end: 10 });
    expect(t.events[1]).toMatchObject({ caption: { text: 'Start for Acme Bakery' }, t_start: 2, target: { bbox: { x: 100 } } });
    expect(t.video).toMatchObject({ title: { text: 'Quotes, faster' }, template: 'editorial' });
    expect(r.changes).toEqual(expect.arrayContaining(['title', 'template', 'cards and interstitials', 'caption of open', 'caption of open.0']));
  });

  it('an overlay added after the take anchors to the step target box, else to the cursor at the end of the step', () => {
    const now = BASE.replace('        caption: Start a quote\n', '        caption: Start a quote\n        overlay: {component: studio/overlay-callout, slots: {text: "Here, {{vars.company}}"}, duration: 2}\n').replace(
      '      - hold: 1\n',
      '      - hold: 1\n        overlay: {component: studio/overlay-callout, slots: {text: Wait}}\n        camera: {zoom: 1.3}\n',
    );
    const r = replan(now);
    expect(r.timeline.events[1].overlay).toEqual({ component: 'studio/overlay-callout', slots: { text: 'Here, Acme Bakery' }, params: {}, duration: 2, target: 'button "New quote"', bbox: { x: 100, y: 50, width: 120, height: 40 } });
    expect(r.timeline.events[3].overlay).toEqual({ component: 'studio/overlay-callout', slots: { text: 'Wait' }, params: {}, point: { x: 510, y: 230 } });
    expect(r.timeline.events[3].camera).toEqual({ zoom: 1.3, point: { x: 510, y: 230 } });
    expect(r.warnings).toEqual([]);
  });

  it('an overlay naming a target the take did not measure falls back to the step target, with a warning', () => {
    const now = BASE.replace('      - click: Send\n', '      - click: Send\n        overlay: {component: studio/overlay-callout, slots: {text: Total}, target: {text: Total}}\n');
    const r = replan(now);
    expect(r.timeline.events[4].overlay).toMatchObject({ bbox: { x: 900, y: 600 } });
    expect(r.warnings).toEqual([expect.stringMatching(/^step send\.0: the overlay names a target this take did not measure .*capture again to measure it$/)]);
  });

  it('a measured overlay keeps its box when only its text changes', () => {
    const withOverlay = BASE.replace('      - click: Send\n', '      - click: Send\n        overlay: {component: studio/overlay-callout, slots: {text: Total}, target: {text: Total}}\n');
    const tl = timelineOf();
    tl.events[4].overlay = { component: 'studio/overlay-callout', slots: { text: 'Total' }, params: {}, target: 'text "Total"', bbox: { x: 10, y: 20, width: 30, height: 40 } };
    const r = replanEdit({ timeline: tl, now: parse(withOverlay.replace('{text: Total}, target', '{text: The total}, target')), then: parse(withOverlay), project: { frame: 'card' }, ctx: {} });
    expect(r.timeline.events[4].overlay).toMatchObject({ slots: { text: 'The total' }, bbox: { x: 10, y: 20, width: 30, height: 40 } });
    expect(r.warnings).toEqual([]);
  });

  it('marks are rebuilt on the step start times; a token only the take knew keeps the captured text', () => {
    const now = BASE.replace('      - click: Send\n', '      - click: Send\n        mark: sent\n').replace('caption: Start a quote', 'caption: "Quote {{hooks.seed.json.id}}"');
    const r = replan(now);
    expect(r.timeline.markers).toEqual([{ name: 'sent', t: 12, scene: 'send', step: 0 }]);
    expect(r.timeline.events[4].mark).toBe('sent');
    expect(r.timeline.events[1].caption).toEqual({ text: 'Start a quote' });
    expect(r.warnings).toEqual([expect.stringContaining('a value known only during the take: the captured text is kept')]);
  });

  it('a take that stopped early keeps today\'s entries up to its last scene', () => {
    const tl = timelineOf();
    tl.scenes = tl.scenes.slice(0, 1);
    tl.events = tl.events.filter((e) => e.scene === 'open');
    const r = replan(BASE, tl);
    expect(r.timeline.scenes.map((s) => s.id)).toEqual(['open']);
  });
});
