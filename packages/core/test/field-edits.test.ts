/**
 * L4.5 part A, core field edits (field-edits.ts `set_field`): one edit value of the video, a scene, a card or an
 * interstitial written from the timeline as a splice, checked with facts independent of the edit code — the re-parsed
 * value against the change applied to the parsed value (verifyEditText), the lines that may change, every other byte.
 * The allow-list (no hook, var, env, capture, pacing or step path is ever reached), stale `from` / guard, placement (a
 * new top-level key before `scenes:`, a scene key before `steps:`), `intro: false` ⇄ a component, removing a nested
 * map's last key; every path an edit value (core filmedChanges); goldens on the fixture's 15 scenarios (set then
 * reset restores the bytes) and a fuzz of random set / reset sequences.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIELD_PATHS, StepEditError, applyFieldEdit, filmedChanges, parseScenario, parseYaml, sceneId, stepGuard, timelineVideo, verifyEditText } from '../src/index.js';
import type { FieldAt, FieldEdit, FieldValue, Scenario } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCENARIOS = join(ROOT, 'projects', 'northfield-fixture', 'scenarios');
type Obj = Record<string, unknown>;

const valueOf = (t: string) => parseYaml(t).value as { scenes: Obj[] } & Obj;
/** The FieldAt of entry `id` of type `entry` in text `t`. */
function atOf(t: string, entry: 'scene' | 'card' | 'interstitial', id: string): FieldAt {
  const v = valueOf(t);
  const k = v.scenes.findIndex((e, i) => sceneId(e as unknown as Scenario['scenes'][number], i) === id);
  return { entry, id, guard: stepGuard(v.scenes[k]) };
}
/** What the file says at a field (scalar; `true` for an intro / outro map). */
function readAt(t: string, at: FieldAt, field: string): FieldValue | undefined {
  const v = valueOf(t);
  let cur: unknown = at.entry === 'top' ? v : v.scenes.find((e, i) => sceneId(e as unknown as Scenario['scenes'][number], i) === (at as { id: string }).id);
  for (const k of field.split('.')) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Obj)[k] : undefined;
  if (cur && typeof cur === 'object') return true;
  return cur as FieldValue | undefined;
}
/** The edit applied and verified: the text re-parses to exactly the intended value, which holds `to` there. */
function applied(t: string, edit: FieldEdit) {
  const r = applyFieldEdit(t, edit);
  expect(verifyEditText(r.text, r.intended), JSON.stringify(edit)).toBeNull();
  const now = readAt(r.text, edit.at.entry === 'top' ? edit.at : { ...edit.at, guard: '' }, edit.field);
  expect(now, JSON.stringify(edit)).toEqual(edit.field === 'intro' || edit.field === 'outro' ? (edit.to === undefined ? undefined : edit.to) : edit.to);
  return r;
}
const changedLines = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return { removed: x.slice(i, x.length - j), added: y.slice(i, y.length - j) };
};

const BASE = `# yaml-language-server: $schema=../schema.json
video: demo
title: {text: Hello}
intro:
  component: studio/intro-stack
  duration: 3
vars: {company: Acme}
setup:
  - {name: seed, http: {url: "http://admin.test/seed", method: POST}}
# The scenes
scenes:
  - id: request
    page: shop
    open: /
    frame: browser   # a note
    steps:
      - click: Save
  - card: {component: studio/card-title, slots: {title: Hi}}
    id: c1
  - card:
      slots: {title: Second}
      transition: {component: studio/transition-tap-open, params: {}}
  - interstitial: {text: Later}
  - id: two
    steps: [ ]
`;

describe('set_field: the allow-list (⚑ no hook, var, env, capture, pacing or step path is ever reached)', () => {
  it('a path outside the allow-list is refused, nothing written', () => {
    const top: Array<[string, FieldValue]> = [
      ['setup', 'x'],
      ['teardown', 'x'],
      ['hooks', 'x'],
      ['mocks', 'x'],
      ['vars', 'x'],
      ['vars.company', 'Other'],
      ['env', 'staging'],
      ['capture', 'x'],
      ['capture.fps', 60],
      ['pacing', 'x'],
      ['clock', 'x'],
      ['scenes', 'x'],
      ['template.name', 'editorial'], // L4.7 (critique B1): `template` itself is a field (theme name)
      ['title.text', 'x'],
      ['__proto__', 'x'],
      ['intro.params', 'x'],
      ['frame.x', 'x'],
      ['', 'x'],
    ];
    for (const [field, to] of top) {
      const e = (() => {
        try {
          applyFieldEdit(BASE, { kind: 'set_field', at: { entry: 'top' }, field, to });
        } catch (x) {
          return x;
        }
      })();
      expect(e, field).toBeInstanceOf(StepEditError);
      expect((e as StepEditError).code, field).toBe('invalid');
      expect((e as StepEditError).message, field).toMatch(/is not a value the timeline sets/);
    }
    const scene = atOf(BASE, 'scene', 'request');
    for (const field of ['steps', 'page', 'open', 'pages', 'persona', 'still', 'cursor', 'caption', 'id', 'skip', 'offscreen', 'steps.0.click', 'caption_component', 'card.component']) {
      expect(() => applyFieldEdit(BASE, { kind: 'set_field', at: scene, field, to: 'x' }), field).toThrow(/is not a value the timeline sets on a scene/);
    }
    const card = atOf(BASE, 'card', 'c1');
    for (const field of ['card.slots', 'card.slots.title', 'card.params', 'card.video', 'id', 'frame']) {
      expect(() => applyFieldEdit(BASE, { kind: 'set_field', at: card, field, to: 'x' }), field).toThrow(/is not a value the timeline sets on a card/);
    }
    expect(() => applyFieldEdit(BASE, { kind: 'set_field', at: { entry: 'steps' } as never, field: 'frame', to: 'x' })).toThrow(/at.entry is one of/);
  });

  it('every path of the allow-list is an edit value: no filmed change (core filmedChanges)', () => {
    const values: Record<string, FieldValue> = { frame: 'laptop', transition: 'cut', speed: 1.5, 'card.component': 'studio/card-cta', 'card.duration': 4, 'card.transition': 'fade-black', 'interstitial.component': 'studio/interstitial-plain', 'interstitial.duration': 2, 'intro.component': 'studio/intro-minimal', 'intro.duration': 2, 'outro.component': 'studio/outro-minimal', 'outro.duration': 2, caption_component: 'studio/caption-overlay' };
    const ats: Record<keyof typeof FIELD_PATHS, FieldAt> = { top: { entry: 'top' }, scene: atOf(BASE, 'scene', 'request'), card: atOf(BASE, 'card', 'c1'), interstitial: atOf(BASE, 'interstitial', 'interstitial-3') };
    let n = 0;
    for (const [entry, fields] of Object.entries(FIELD_PATHS) as Array<[keyof typeof FIELD_PATHS, readonly string[]]>) {
      for (const field of fields) {
        const at = ats[entry];
        const from = readAt(BASE, at, field);
        const to = field === 'intro' || field === 'outro' ? false : from === values[field] ? 'phone' : values[field];
        const r = applied(BASE, { kind: 'set_field', at, field, ...(from !== undefined ? { from } : {}), to });
        expect(filmedChanges(r.text, BASE), field).toEqual([]);
        n++;
      }
    }
    expect(n).toBe(Object.values(FIELD_PATHS).flat().length);
  });

  it('values are checked for their kind and range before anything is written', () => {
    const scene = atOf(BASE, 'scene', 'request');
    const bad: Array<[FieldAt, string, unknown, RegExp]> = [
      [scene, 'speed', 0, /above 0 and at most 16/],
      [scene, 'speed', 17, /above 0 and at most 16/],
      [scene, 'speed', '2', /above 0 and at most 16/],
      [scene, 'frame', 'monitor', /raw, card, browser/],
      [scene, 'frame', 'Studio/Layout', /raw, card, browser/],
      [scene, 'transition', 'wipe', /crossfade, cut, fade-black/],
      [{ entry: 'top' }, 'caption_component', '../x', /namespace\/name/],
      [{ entry: 'top' }, 'caption_component', 'studio/cap​tion', /U\+200B/],
      [{ entry: 'top' }, 'intro', true, /takes false/],
      [{ entry: 'top' }, 'intro.duration', 601, /at most 600/],
    ];
    for (const [at, field, to, re] of bad) {
      expect(() => applyFieldEdit(BASE, { kind: 'set_field', at, field, from: readAt(BASE, at, field), to } as FieldEdit), `${field} ${String(to)}`).toThrow(re);
    }
  });
});

describe('set_field: stale and not editable', () => {
  it('a value changed meanwhile, an entry changed or gone: stale (never applied to a neighbour)', () => {
    const scene = atOf(BASE, 'scene', 'request');
    const code = (edit: FieldEdit) => {
      try {
        applyFieldEdit(BASE, edit);
        return 'applied';
      } catch (e) {
        return (e as StepEditError).code;
      }
    };
    expect(code({ kind: 'set_field', at: scene, field: 'frame', from: 'card', to: 'laptop' })).toBe('stale');
    expect(code({ kind: 'set_field', at: scene, field: 'frame', to: 'laptop' })).toBe('stale'); // the file has browser there
    expect(code({ kind: 'set_field', at: { ...scene, guard: '0000000000000000' }, field: 'frame', from: 'browser', to: 'laptop' })).toBe('stale');
    expect(code({ kind: 'set_field', at: { entry: 'scene', id: 'gone', guard: scene.guard }, field: 'frame', to: 'laptop' })).toBe('stale');
    // A card addressed as a scene of the same id is not that card.
    expect(code({ kind: 'set_field', at: { entry: 'scene', id: 'c1', guard: atOf(BASE, 'card', 'c1').guard }, field: 'frame', to: 'laptop' })).toBe('stale');
    expect(code({ kind: 'set_field', at: { entry: 'top' }, field: 'caption_component', from: 'studio/caption-below', to: 'studio/caption-overlay' })).toBe('stale');
    expect(code({ kind: 'set_field', at: scene, field: 'frame', from: 'browser', to: 'browser' })).toBe('invalid');
  });

  it('a transition written with params is changed in the YAML tab', () => {
    const at = atOf(BASE, 'card', 'card-2');
    expect(() => applyFieldEdit(BASE, { kind: 'set_field', at, field: 'card.transition', to: 'cut' })).toThrow(/written as a map \(with params\): change it in the YAML view/);
  });

  it('a card keeps the key of its kind: its last value cannot be removed here', () => {
    const t = BASE.replace('  - card: {component: studio/card-title, slots: {title: Hi}}', '  - card: {component: studio/card-title}');
    expect(() => applyFieldEdit(t, { kind: 'set_field', at: atOf(t, 'card', 'c1'), field: 'card.component', from: 'studio/card-title' })).toThrow(/the card needs component/);
  });
});

describe('set_field: placement and forms', () => {
  it('a new top-level key goes just before `scenes:`, above its comment lines; one line added', () => {
    const r = applied(BASE, { kind: 'set_field', at: { entry: 'top' }, field: 'caption_component', to: 'studio/caption-overlay' });
    expect(changedLines(BASE, r.text)).toEqual({ removed: [], added: ['caption_component: studio/caption-overlay'] });
    expect(r.text).toContain('caption_component: studio/caption-overlay\n# The scenes\nscenes:\n');
    expect(r.label).toBe('Set the caption component to studio/caption-overlay');
  });

  it('a new scene key goes just before `steps:`; a scalar keeps its line and its comment', () => {
    const at = atOf(BASE, 'scene', 'request');
    const sp = applied(BASE, { kind: 'set_field', at, field: 'speed', to: 1.5 });
    expect(changedLines(BASE, sp.text)).toEqual({ removed: [], added: ['    speed: 1.5'] });
    expect(sp.text).toContain('    speed: 1.5\n    steps:\n');
    const fr = applied(BASE, { kind: 'set_field', at, field: 'frame', from: 'browser', to: 'laptop' });
    expect(changedLines(BASE, fr.text)).toEqual({ removed: ['    frame: browser   # a note'], added: ['    frame: laptop   # a note'] });
    expect(fr.label).toBe('Set the layout of scene request to laptop');
    const empty = atOf(BASE, 'scene', 'two');
    const tr = applied(BASE, { kind: 'set_field', at: empty, field: 'transition', to: 'cut' });
    expect(tr.text).toContain('  - id: two\n    transition: cut\n    steps: [ ]\n');
  });

  it('a flow map takes `, key: value`; a removal takes the key and its comma', () => {
    const at = atOf(BASE, 'card', 'c1');
    const d = applied(BASE, { kind: 'set_field', at, field: 'card.duration', to: 4 });
    expect(changedLines(BASE, d.text)).toEqual({ removed: ['  - card: {component: studio/card-title, slots: {title: Hi}}'], added: ['  - card: {component: studio/card-title, slots: {title: Hi}, duration: 4}'] });
    const back = applied(d.text, { kind: 'set_field', at: atOf(d.text, 'card', 'c1'), field: 'card.duration', from: 4 });
    expect(back.text).toBe(BASE);
  });

  it('intro ⇄ false: a block map written over by `intro: false`; a component on `intro: false` becomes `{component: x}`', () => {
    const off = applied(BASE, { kind: 'set_field', at: { entry: 'top' }, field: 'intro', from: true, to: false });
    expect(changedLines(BASE, off.text)).toEqual({ removed: ['intro:', '  component: studio/intro-stack', '  duration: 3'], added: ['intro: false'] });
    expect(off.label).toBe('Turned the intro off');
    const on = applied(off.text, { kind: 'set_field', at: { entry: 'top' }, field: 'intro.component', to: 'studio/intro-minimal' });
    expect(changedLines(off.text, on.text)).toEqual({ removed: ['intro: false'], added: ['intro: {component: studio/intro-minimal}'] });
    // Back to the theme's intro: the key goes.
    const theme = applied(off.text, { kind: 'set_field', at: { entry: 'top' }, field: 'intro', from: false });
    expect(changedLines(off.text, theme.text)).toEqual({ removed: ['intro: false'], added: [] });
  });

  it('review B H2: the intro / outro switch never drops the map\'s own text or files (refused: the YAML tab)', () => {
    const t = BASE.replace('intro:\n  component: studio/intro-stack\n  duration: 3\n', 'intro:\n  component: studio/intro-stack\n  duration: 3\noutro:\n  tagline: Order in two clicks\n  image: assets/logo.png\n');
    for (const edit of [
      { kind: 'set_field', at: { entry: 'top' }, field: 'outro', from: true, to: false },
      { kind: 'set_field', at: { entry: 'top' }, field: 'outro', from: true },
    ] as FieldEdit[]) {
      let err: unknown;
      try {
        applyFieldEdit(t, edit);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(edit)).toBeInstanceOf(StepEditError);
      expect((err as StepEditError).code).toBe('not_editable');
      expect((err as StepEditError).message).toBe("the outro has its own tagline, image: turn it off or back to the theme's in the YAML view (a switch would drop it)");
    }
    // Its component and duration still switch inside the map (the tagline stays).
    const c = applied(t, { kind: 'set_field', at: { entry: 'top' }, field: 'outro.component', to: 'studio/outro-minimal' });
    expect(c.text).toContain('  tagline: Order in two clicks\n');
    // A map of component / duration only switches as before.
    expect(applied(t, { kind: 'set_field', at: { entry: 'top' }, field: 'intro', from: true, to: false }).text).toContain('  tagline: Order in two clicks\n');
  });

  it('removing the last key of a nested map removes the parent pair (the theme default)', () => {
    const t = BASE.replace('intro:\n  component: studio/intro-stack\n  duration: 3\n', 'intro:\n  component: studio/intro-stack\n');
    const r = applied(t, { kind: 'set_field', at: { entry: 'top' }, field: 'intro.component', from: 'studio/intro-stack' });
    expect(changedLines(t, r.text)).toEqual({ removed: ['intro:', '  component: studio/intro-stack'], added: [] });
    expect(r.label).toBe("Reset the intro component to the theme's default");
    // An outro absent: setting its component adds `outro: {component: x}` before scenes:.
    const o = applied(BASE, { kind: 'set_field', at: { entry: 'top' }, field: 'outro.component', to: 'studio/outro-minimal' });
    expect(changedLines(BASE, o.text)).toEqual({ removed: [], added: ['outro: {component: studio/outro-minimal}'] });
  });

  it('CR LF line breaks and a missing final line break are kept', () => {
    const crlf = BASE.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    const r = applied(crlf, { kind: 'set_field', at: { entry: 'top' }, field: 'caption_component', to: 'studio/caption-overlay' });
    expect(r.text).toContain('caption_component: studio/caption-overlay\r\n# The scenes\r\n');
    expect(r.text.endsWith('\n')).toBe(false);
    expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const sp = applied(crlf, { kind: 'set_field', at: atOf(crlf, 'scene', 'two'), field: 'speed', to: 2 });
    expect(sp.text.endsWith('steps: [ ]')).toBe(true);
  });

  it('a value that reads as another type is quoted (a component id stays a string, a frame word a frame)', () => {
    const t = BASE.replace('    frame: browser   # a note\n', "    frame: 'browser'\n");
    const r = applied(t, { kind: 'set_field', at: atOf(t, 'scene', 'request'), field: 'frame', from: 'browser', to: 'laptop' });
    expect(r.text).toContain("    frame: 'laptop'\n");
  });
});

// ── Goldens and fuzz on the fixture's scenarios ──────────────────────────────

/** Every (at, field) of a text the allow-list reaches. */
function targets(t: string): Array<{ at: FieldAt; field: string }> {
  const v = valueOf(t);
  const out: Array<{ at: FieldAt; field: string }> = FIELD_PATHS.top.map((field) => ({ at: { entry: 'top' } as FieldAt, field }));
  v.scenes.forEach((e, i) => {
    const type = e.card !== undefined ? 'card' : e.interstitial !== undefined ? 'interstitial' : 'scene';
    const id = sceneId(e as unknown as Scenario['scenes'][number], i);
    // Two entries of one id: the first is the one addressed (ids are unique in valid files).
    if (v.scenes.findIndex((x, j) => sceneId(x as unknown as Scenario['scenes'][number], j) === id) !== i) return;
    for (const field of FIELD_PATHS[type]) out.push({ at: { entry: type, id, guard: stepGuard(e) } as FieldAt, field });
  });
  return out;
}

const POOL: Record<string, FieldValue[]> = {
  frame: ['laptop', 'phone', 'raw', 'card', 'acme/layout-wide'],
  transition: ['cut', 'crossfade', 'fade-black', 'studio/transition-tap-open'],
  speed: [1.25, 1.5, 2, 0.75, 3.333],
  duration: [2, 4.5, 6, 12],
  component: ['studio/card-cta', 'acme/thing-2', 'studio/caption-overlay', 'x/y'],
};
const poolOf = (field: string) => (field === 'frame' ? POOL.frame : field.endsWith('transition') ? POOL.transition : field === 'speed' ? POOL.speed : field.endsWith('duration') ? POOL.duration : POOL.component);

describe('set_field on the fixture scenarios (goldens)', () => {
  const names = readdirSync(SCENARIOS).filter((f) => f.endsWith('.yaml'));
  it('the fixture has its 15 scenarios', () => expect(names).toHaveLength(15));

  it('every field of every entry: set, then reset to what was written, gives the original bytes back; one line changes', () => {
    let edits = 0;
    let refused = 0;
    for (const name of names) {
      const text = readFileSync(join(SCENARIOS, name), 'utf8');
      for (const { at, field } of targets(text)) {
        if (field === 'intro' || field === 'outro') continue; // a switch over a map is undone byte-exactly by `restore` (the Studio's undo)
        let from: FieldValue | undefined;
        try {
          from = readAt(text, at, field);
        } catch {
          continue;
        }
        if (from === true) continue;
        // A component on `intro: false` replaces the scalar: its reset is the theme's intro (undone by `restore`).
        const parent = field.includes('.') ? readAt(text, at, field.split('.')[0]) : undefined;
        if (parent !== undefined && parent !== true) continue;
        const to = poolOf(field).find((x) => x !== from)!;
        let r;
        try {
          r = applied(text, { kind: 'set_field', at, field, ...(from !== undefined ? { from } : {}), to });
        } catch (e) {
          // Refused, never corrupted: only for what the file writes in a form this editor does not change.
          expect(e, `${name} ${field}`).toBeInstanceOf(StepEditError);
          expect((e as StepEditError).code, `${name} ${field}: ${(e as Error).message}`).toMatch(/not_editable|invalid/);
          refused++;
          continue;
        }
        const d = changedLines(text, r.text);
        expect(d.added.length, `${name} ${field}`).toBe(1);
        expect(d.removed.length, `${name} ${field}`).toBeLessThanOrEqual(1);
        const at2 = at.entry === 'top' ? at : ({ ...at, guard: stepGuard(valueOf(r.text).scenes.find((e, i) => sceneId(e as unknown as Scenario['scenes'][number], i) === at.id)) } as FieldAt);
        const back = applied(r.text, { kind: 'set_field', at: at2, field, from: to, ...(from !== undefined ? { to: from } : {}) });
        expect(back.text, `${name} ${field}`).toBe(text);
        edits++;
      }
    }
    expect(edits).toBeGreaterThan(150);
    expect(refused).toBeLessThan(edits / 10);
  });

  it('fuzz: 3,000 random set / reset edits in sequence give exactly the intended value every time', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let mismatches = 0;
    let applied = 0;
    const texts = names.map((n) => readFileSync(join(SCENARIOS, n), 'utf8'));
    for (let round = 0; round < texts.length; round++) {
      let text = texts[round];
      for (let i = 0; i < 200; i++) {
        const all = targets(text);
        const { at, field } = all[rnd(all.length)];
        let from: FieldValue | undefined;
        try {
          from = readAt(text, at, field);
        } catch {
          continue;
        }
        const pool = field === 'intro' || field === 'outro' ? [false] : poolOf(field);
        const reset = from !== undefined && rnd(3) === 0;
        const to = reset ? undefined : pool[rnd(pool.length)];
        if (to === from || (to === undefined && from === undefined)) continue;
        try {
          const r = applyFieldEdit(text, { kind: 'set_field', at, field, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
          if (verifyEditText(r.text, r.intended) !== null) mismatches++;
          text = r.text;
          applied++;
        } catch (e) {
          if (!(e instanceof StepEditError)) throw e;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(applied).toBeGreaterThan(1500);
  }, 120_000);
});

describe('caption_component (L4.5): a scenario key of the edit part', () => {
  it('validates as a component id, goes to the timeline video, and is an edit change', () => {
    const ok = parseScenario('video: x\ncaption_component: studio/caption-overlay\nscenes:\n  - id: a\n    steps:\n      - hold: 1\n');
    expect(ok.scenario?.caption_component).toBe('studio/caption-overlay');
    expect(timelineVideo(ok.scenario!, { frame: 'card', template: 'default' }).caption_component).toBe('studio/caption-overlay');
    const bad = parseScenario('video: x\ncaption_component: Caption Below\nscenes:\n  - id: a\n    steps:\n      - hold: 1\n');
    expect(bad.issues.find((i) => i.path.join('.') === 'caption_component')?.message).toMatch(/caption component id must be "namespace\/name"/);
    expect(filmedChanges(BASE.replace('scenes:\n', 'caption_component: studio/caption-overlay\nscenes:\n'), BASE)).toEqual([]);
  });
});
