/**
 * Phase-2 contracts in core (lot L2.1): component references, template `brand` + `components` with the legacy
 * mapping, scenario additions (intro/outro/interstitial components, `card` entries, `frame` as a layout id, step
 * `overlay`), timeline `video` / card scenes / overlay events, JSON Schemas for editor autocompletion.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_ID_RE,
  COMPONENT_KINDS,
  DEFAULT_TEMPLATE,
  FRAME_STYLE_LAYOUTS,
  TimelineSchema,
  componentRefId,
  formatIssues,
  listSteps,
  mergeTemplate,
  normalizeComponentRef,
  normalizeStep,
  parseProjectYaml,
  parseScenario,
  parseTemplateYaml,
  resolveStepRef,
  resolveThemeComponents,
  sceneId,
  scenarioJsonSchema,
  templateJsonSchema,
  timelineJsonSchema,
  timelineVideo,
} from '@demo-studio/core';
import { COMMENTS_DIR } from '@demo-studio/core';
import type { FrameComment, FrameCommentsFile, Scenario, Template, Timeline, ValidationIssue } from '@demo-studio/core';
import { colOf, errors, lineOf, warnings } from './helpers.js';

type Json = Record<string, any>;

/** "line:col path: message" of the error-level issues. */
const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.line} ${i.path.join('.')}: ${i.message}`);

const SCENE = ['  - id: main', '    open: /', '    steps:', '      - wait: 1'];
const doc = (...lines: string[]) => ['video: demo', ...lines, ''].join('\n');

describe('component ids and references', () => {
  it('COMPONENT_ID_RE accepts "namespace/name" in lower case only', () => {
    for (const ok of ['studio/intro-stack', 'acme/layout-2', 'a/b', '0x/9-lives']) expect(COMPONENT_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['studio', 'Studio/intro', 'studio/Intro', 'studio/intro_stack', '-a/b', 'a/-b', 'a/b/c', 'a /b', '']) {
      expect(COMPONENT_ID_RE.test(bad), bad).toBe(false);
    }
  });

  it('componentRefId / normalizeComponentRef', () => {
    expect(componentRefId('studio/card-title')).toBe('studio/card-title');
    expect(componentRefId({ id: 'studio/layout-card', params: { width: 1400 } })).toBe('studio/layout-card');
    expect(normalizeComponentRef('studio/card-title')).toEqual({ id: 'studio/card-title', params: {} });
    const params = { width: 1400 };
    const n = normalizeComponentRef({ id: 'studio/layout-card', params });
    expect(n).toEqual({ id: 'studio/layout-card', params: { width: 1400 } });
    expect(n.params).not.toBe(params);
  });

  it('every FrameStyle stands for a built-in layout id', () => {
    for (const id of Object.values(FRAME_STYLE_LAYOUTS)) expect(COMPONENT_ID_RE.test(id)).toBe(true);
    expect(FRAME_STYLE_LAYOUTS.card).toBe('studio/layout-card');
  });
});

describe('scenario additions (R-SCN2-01..06)', () => {
  it('intro / outro take component, params and duration (or false)', () => {
    const text = doc(
      'intro: {component: studio/intro-minimal, params: {logo_only: true}, duration: 2.4}',
      'outro: {component: acme/outro-big, params: {rule: false}, tagline: Hello, url: example.com, duration: 3}',
      'scenes:',
      ...SCENE,
    );
    const { scenario, issues } = parseScenario(text);
    expect(issues, formatIssues(issues)).toEqual([]);
    expect(scenario?.intro).toEqual({ component: 'studio/intro-minimal', params: { logo_only: true }, duration: 2.4 });
    expect(scenario?.outro).toMatchObject({ component: 'acme/outro-big', tagline: 'Hello' });
    expect(parseScenario(doc('intro: false', 'outro: false', 'scenes:', ...SCENE)).issues).toEqual([]);

    const bad = doc('intro: {component: Intro, duration: 0}', 'outro: {tagline: x, compnent: studio/outro-stack}', 'scenes:', ...SCENE);
    expect(errs(parseScenario(bad).issues)).toEqual([
      `2:${colOf(bad, 'Intro')} intro.component: intro component id must be "namespace/name" (lower-case letters, digits and "-", e.g. "studio/intro-stack"), got "Intro"`,
      `2:${colOf(bad, '0}')} intro.duration: must be > 0, got 0`,
      `3:${colOf(bad, 'compnent')} outro: unknown key "compnent" (did you mean "component"?)`,
    ]);
  });

  it('interstitial takes component and params; `style` next to `component` is a warning', () => {
    const text = doc(
      'scenes:',
      ...SCENE,
      '  - interstitial: {text: A few hours later, component: studio/interstitial-plain, params: {tone: dark}, style: dark}',
    );
    const { scenario, issues } = parseScenario(text);
    expect(errors(issues)).toEqual([]);
    expect(warns(issues)).toEqual([`${lineOf(text, 'interstitial:')} scenes.1.interstitial.style: \`style\` (legacy) is ignored when \`component\` is set`]);
    expect(scenario?.scenes[1]).toEqual({
      interstitial: { text: 'A few hours later', component: 'studio/interstitial-plain', params: { tone: 'dark' }, style: 'dark' },
    });
    const dur = doc('scenes:', ...SCENE, '  - interstitial: {text: Later, duration: -1}');
    expect(errs(parseScenario(dur).issues)).toEqual([`${lineOf(dur, '-1')}:${colOf(dur, '-1')} scenes.1.interstitial.duration: must be > 0, got -1`]);
  });

  it('`card` entries: component, params, slots, duration and an optional id; no capture time, no steps', () => {
    const text = doc(
      'scenes:',
      '  - card: {slots: {kicker: Chapter two, title: The proposal}, duration: 2.2}',
      '    id: chapter-2',
      ...SCENE,
      '  - card: {component: acme/quote-card, params: {align: left}, slots: {text: "Fast."}}',
    );
    const { scenario, issues } = parseScenario(text);
    expect(issues, formatIssues(issues)).toEqual([]);
    const s = scenario as Scenario;
    expect(s.scenes[0]).toEqual({ card: { slots: { kicker: 'Chapter two', title: 'The proposal' }, duration: 2.2 }, id: 'chapter-2' });
    expect(sceneId(s.scenes[0], 0)).toBe('chapter-2');
    expect(sceneId(s.scenes[2], 2)).toBe('card-2');
    expect(listSteps(s).map((l) => l.ref)).toEqual(['main.0']);
    expect(resolveStepRef(s, 'chapter-2')).toBeNull();
    expect(resolveStepRef(s, 'main')).toEqual({ sceneIndex: 1, stepIndex: 0 });
  });

  it('a card needs a component or slots.title; durations are positive; unknown keys are errors (with lines)', () => {
    const text = doc(
      'scenes:',
      '  - card: {slots: {kicker: Only a kicker}}',
      '  - card: {slots: {title: "  "}}',
      '  - card: {component: studio/card-title, duration: 0}',
      '  - card: {slots: {title: T}}',
      '    steps: []',
      '  - card: {slots: {"two words": x, title: T}}',
      ...SCENE,
    );
    expect(errs(parseScenario(text).issues)).toEqual([
      `3:11 scenes.0.card: a card needs a \`component\` or a \`slots.title\` (the theme's card component shows a title)`,
      `4:11 scenes.1.card: a card needs a \`component\` or a \`slots.title\` (the theme's card component shows a title)`,
      `5:${colOf(text, '0}')} scenes.2.card.duration: must be > 0, got 0`,
      `7:5 scenes.3: unknown key "steps"`,
      `8:${colOf(text, 'x, title')} scenes.4.card.slots.two words: slot name must be an identifier: letters, digits, "_" or "-", starting with a letter or "_"`,
    ]);
    const both = doc('scenes:', '  - card: {slots: {title: T}}', '    interstitial: {text: Later}', ...SCENE);
    expect(errs(parseScenario(both).issues)).toEqual([
      `3:5 scenes.0: several scene kinds in one scene (interstitial, card): split them into separate scenes`,
    ]);
  });

  it('ids are unique across scenes, cards and interstitials (default ids included)', () => {
    const text = doc(
      'scenes:',
      '  - card: {slots: {title: T}}',
      '    id: main',
      ...SCENE,
      '  - interstitial: {text: Later}',
      '    id: main',
      '  - interstitial: {text: Later}',
      '  - id: interstitial-4',
      '    steps: [{wait: 1}]',
    );
    expect(errs(parseScenario(text).issues)).toEqual([
      '5:9 scenes.1.id: duplicate scene id "main" (already used by scenes[0])',
      '10:9 scenes.2.id: duplicate scene id "main" (already used by scenes[0])',
    ]);
    // The default id of an unnamed entry must not collide with an explicit id.
    const clash = doc('scenes:', ...SCENE, '  - card: {slots: {title: T}}', '  - id: card-1', '    steps: [{wait: 1}]');
    expect(errs(parseScenario(clash).issues)).toEqual([
      '7:5 scenes.1: the default id "card-1" of this card is already used by scenes[2]: give the card an `id`',
    ]);
  });

  it('`frame` (scenario, scene) accepts a FrameStyle or a layout component id, with a precise error otherwise', () => {
    const ok = doc('frame: studio/layout-browser', 'scenes:', ...SCENE, '    frame: raw', '  - id: two', '    frame: acme/device-frame', '    steps: [{wait: 1}]');
    expect(parseScenario(ok).issues).toEqual([]);
    const bad = doc('frame: cards', 'scenes:', ...SCENE, '    frame: Acme/Frame');
    expect(errs(parseScenario(bad).issues)).toEqual([
      '2:8 frame: expected a frame style (raw, card, browser, laptop, phone, tablet) or a layout component id "namespace/name" (lower-case letters, digits and "-", e.g. "studio/layout-card"), got "cards" (did you mean "card"?)',
      `8:12 scenes.0.frame: expected a frame style (raw, card, browser, laptop, phone, tablet) or a layout component id "namespace/name" (lower-case letters, digits and "-", e.g. "studio/layout-card"), got "Acme/Frame"`,
    ]);
  });

  it('step `overlay`: component, slots, params, duration ≤ 30 s, target (checked like any target)', () => {
    const text = doc(
      'scenes:',
      '  - id: main',
      '    open: /',
      '    steps:',
      '      - click: Save',
      '        overlay: {component: studio/overlay-callout, slots: {text: Saved}, params: {side: left}, duration: 2.5, target: {text: Total}}',
      '      - wait: 1',
      '        overlay: {component: studio/overlay-lower-third, slots: {title: Ada, subtitle: Buyer}}',
    );
    const { scenario, issues } = parseScenario(text);
    expect(issues, formatIssues(issues)).toEqual([]);
    const step = normalizeStep((scenario!.scenes[0] as { steps: Scenario['scenes'] }).steps[0] as never, 0);
    expect(step.overlay).toEqual({
      component: 'studio/overlay-callout',
      slots: { text: 'Saved' },
      params: { side: 'left' },
      duration: 2.5,
      target: { text: 'Total' },
    });

    const bad = doc(
      'scenes:',
      '  - id: main',
      '    open: /',
      '    steps:',
      '      - wait: 1',
      '        overlay: {component: studio/overlay-callout, duration: 45}',
      '      - wait: 1',
      '        overlay: {slots: {text: x}}',
      '      - wait: 1',
      '        overlay: {component: callout}',
      '      - wait: 1',
      '        overlay: {component: studio/overlay-callout, target: {nth: 1}}',
      '      - wait: 1',
      '        overlay: {component: studio/overlay-callout, duration: 0}',
    );
    expect(errs(parseScenario(bad).issues)).toEqual([
      `7:${colOf(bad, '45')} scenes.0.steps.0.overlay.duration: must be ≤ 30, got 45`,
      `9:18 scenes.0.steps.1.overlay: missing required key "component"`,
      `11:${colOf(bad, 'callout}')} scenes.0.steps.2.overlay.component: overlay component id must be "namespace/name" (lower-case letters, digits and "-", e.g. "studio/intro-stack"), got "callout"`,
      `13:${colOf(bad, '{nth: 1}')} scenes.0.steps.3.overlay.target: target needs at least one of text, contains, role, label, aria, placeholder, css or testid`,
      `15:${colOf(bad, '0}')} scenes.0.steps.4.overlay.duration: must be > 0, got 0`,
    ]);
  });

  it('a scenario made only of cards and interstitials has nothing to capture', () => {
    const text = doc('scenes:', '  - card: {slots: {title: T}}', '  - interstitial: {text: Later}');
    expect(warns(parseScenario(text).issues)).toEqual(['3 scenes: nothing to capture: every entry is a card, an interstitial or a skipped scene']);
  });
});

describe('project frame (R-PROJ-06)', () => {
  it('defaults to card and accepts a FrameStyle or a layout component id', () => {
    expect(parseProjectYaml('name: Demo\n').config?.frame).toBe('card');
    expect(parseProjectYaml('name: Demo\nframe: phone\n').config?.frame).toBe('phone');
    expect(parseProjectYaml('name: Demo\nframe: tablet\n').config?.frame).toBe('tablet');
    expect(parseProjectYaml('name: Demo\nframe: acme/tablet\n').config?.frame).toBe('acme/tablet');
    const { config, issues } = parseProjectYaml('name: Demo\nframe: laptops\n');
    expect(config).toBeUndefined();
    expect(errs(issues)).toEqual([
      '2:8 frame: expected a frame style (raw, card, browser, laptop, phone, tablet) or a layout component id "namespace/name" (lower-case letters, digits and "-", e.g. "studio/layout-card"), got "laptops" (did you mean "laptop"?)',
    ]);
  });
});

describe('template brand + components (R-THM-01..03)', () => {
  it('brand and components are accepted, merged over the defaults; null means "none"', () => {
    const text = [
      'brand: {name: Atelier, url: example.com}',
      'components:',
      '  intro: studio/intro-minimal',
      '  caption: null',
      '  layout: {id: acme/layout-tilted, params: {angle: 4}}',
      '',
    ].join('\n');
    const { template, issues } = parseTemplateYaml(text);
    expect(issues).toEqual([]);
    expect(template?.brand).toEqual({ name: 'Atelier', url: 'example.com' });
    expect(template?.components).toEqual({ intro: 'studio/intro-minimal', caption: null, layout: { id: 'acme/layout-tilted', params: { angle: 4 } } });
    const c = resolveThemeComponents(template!);
    expect(c.intro).toEqual({ id: 'studio/intro-minimal', params: {}, source: 'theme' });
    expect(c.caption).toBeNull();
    expect(c.layout).toEqual({ id: 'acme/layout-tilted', params: { angle: 4 }, source: 'theme' });
    expect(c.outro).toEqual({ id: 'studio/outro-stack', params: {}, source: 'legacy' });
  });

  it('positioned errors: unknown kind (did you mean), invalid id, unknown brand key', () => {
    const text = ['brand: {nme: Atelier}', 'components:', '  layuot: studio/layout-card', '  outro: Studio/Outro', '  card: {id: studio/card-title, parms: {}}', ''].join('\n');
    expect(errs(parseTemplateYaml(text).issues)).toEqual([
      '1:9 brand: unknown key "nme" (did you mean "name"?)',
      '3:3 components: unknown key "layuot" (did you mean "layout"?)',
      '4:10 components.outro: component id must be "namespace/name" (lower-case letters, digits and "-", e.g. "studio/intro-stack"), got "Studio/Outro"',
      `5:${colOf(text, 'parms')} components.card: unknown key "parms" (did you mean "params"?)`,
    ]);
  });

  it('a components entry that contradicts a legacy field written in the same file is a warning', () => {
    const text = [
      'frame: {style: browser, width: 1600}',
      'captions: {position: none}',
      'transitions: {between_scenes: cut}',
      'components:',
      '  layout: {id: studio/layout-card, params: {width: 1560}}',
      '  caption: studio/caption-below',
      '  transition: null',
      '',
    ].join('\n');
    const { template, issues } = parseTemplateYaml(text);
    expect(template).toBeDefined();
    expect(warns(issues)).toEqual([
      '5 components.layout: components.layout (studio/layout-card {"width":1560}) takes precedence over frame.style, frame.width (which map to studio/layout-browser): change components.layout, or remove it to use frame',
      '6 components.caption: components.caption (studio/caption-below) takes precedence over captions.position (which maps to none): change components.caption, or remove it to use captions',
    ]);
    // Legacy fields left to the defaults never warn.
    expect(parseTemplateYaml('components: {layout: studio/layout-raw}\n').issues).toEqual([]);
  });

  describe('resolveThemeComponents: legacy mapping when `components` does not set a kind', () => {
    const t = (over: Partial<Template>): Template => mergeTemplate(DEFAULT_TEMPLATE, over as never);
    const pick = (over: Partial<Template>, kind: (typeof COMPONENT_KINDS)[number]) => {
      const c = resolveThemeComponents(t(over))[kind];
      return c && { id: c.id, params: c.params, source: c.source };
    };

    it.each([
      [{ frame: { style: 'card', width: 1400, radius: 12, shadow: 'strong' } }, 'layout', 'studio/layout-card', { width: 1400, radius: 12, shadow: 'strong' }],
      [{ frame: { style: 'browser' } }, 'layout', 'studio/layout-browser', {}],
      [{ frame: { style: 'laptop' } }, 'layout', 'studio/layout-laptop', {}],
      [{ frame: { style: 'phone' } }, 'layout', 'studio/layout-phone', {}],
      [{ frame: { style: 'raw' } }, 'layout', 'studio/layout-raw', {}],
      [{ intro: { layout: 'logo-kicker-title' } }, 'intro', 'studio/intro-stack', {}],
      [{ intro: { layout: 'kicker-title' } }, 'intro', 'studio/intro-minimal', {}],
      [{ intro: { layout: 'logo-only' } }, 'intro', 'studio/intro-minimal', { logo_only: true }],
      [{ outro: { layout: 'logo-wordmark-tagline-url' } }, 'outro', 'studio/outro-stack', {}],
      [{ outro: { layout: 'logo-tagline' } }, 'outro', 'studio/outro-minimal', {}],
      [{ outro: { layout: 'logo-only' } }, 'outro', 'studio/outro-minimal', { logo_only: true }],
      [{ interstitial: { style: 'dark-clock' } }, 'interstitial', 'studio/interstitial-clock', {}],
      [{ interstitial: { style: 'paper' } }, 'interstitial', 'studio/interstitial-plain', { tone: 'paper' }],
      [{ interstitial: { style: 'dark' } }, 'interstitial', 'studio/interstitial-plain', { tone: 'dark' }],
      [{ captions: { position: 'below' } }, 'caption', 'studio/caption-below', {}],
      [{ captions: { position: 'above' } }, 'caption', 'studio/caption-below', { position: 'above' }],
      [{ captions: { position: 'overlay' } }, 'caption', 'studio/caption-overlay', {}],
      [{ transitions: { between_scenes: 'crossfade', duration: 0.5 } }, 'transition', 'studio/transition-crossfade', { duration: 0.5 }],
      [{ transitions: { between_scenes: 'fade-black', duration: 0.4 } }, 'transition', 'studio/transition-fade-black', { duration: 0.4 }],
    ] as const)('%j → %s %s %j', (over, kind, id, params) => {
      expect(pick(over as Partial<Template>, kind)).toEqual({ id, params, source: 'legacy' });
    });

    it('captions none and cut transitions mean no component; card and overlay use the built-in defaults', () => {
      expect(pick({ captions: { ...DEFAULT_TEMPLATE.captions, position: 'none' } }, 'caption')).toBeNull();
      expect(pick({ transitions: { between_scenes: 'cut', duration: 0 } }, 'transition')).toBeNull();
      expect(pick({}, 'card')).toEqual({ id: 'studio/card-title', params: {}, source: 'default' });
      expect(pick({}, 'overlay')).toEqual({ id: 'studio/overlay-callout', params: {}, source: 'default' });
    });

    it('covers every kind, is pure, and an explicit entry is taken as written (no legacy params merged)', () => {
      const template = t({ components: { layout: 'studio/layout-card', card: null } });
      const before = structuredClone(template);
      const c = resolveThemeComponents(template);
      expect(Object.keys(c).sort()).toEqual([...COMPONENT_KINDS].sort());
      expect(c.layout).toEqual({ id: 'studio/layout-card', params: {}, source: 'theme' });
      expect(c.card).toBeNull();
      expect(template).toEqual(before);
      c.transition!.params.duration = 9;
      expect(resolveThemeComponents(template).transition!.params.duration).toBe(DEFAULT_TEMPLATE.transitions.duration);
    });
  });
});

describe('timeline additions (R-SCN-03, R-SCN-07)', () => {
  const base: Timeline = {
    version: 1,
    run_id: '20261011-142233-quote',
    project: 'northfield',
    scenario: 'quote',
    created_at: '2026-10-11T14:22:33.000Z',
    mode: 'capture',
    capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 10, t0_wall: 1791728553000, frames: 300 },
    scenes: [],
    events: [],
    markers: [],
    pages: [],
    cursor: [],
    idle: [],
    warnings: [],
  };

  it('video block, card scenes and overlay events round-trip; older timelines without `video` stay valid', () => {
    const tl: Timeline = {
      ...base,
      video: {
        title: { kicker: 'For cafés', text: 'Request a quote' },
        intro: { component: 'studio/intro-stack', duration: 3 },
        outro: false,
        frame: 'studio/layout-browser',
        template: 'editorial',
        music: { file: 'assets/bed.mp3', volume: 0.4 },
      },
      scenes: [
        { id: 'chapter', index: 0, kind: 'card', t_start: 0, t_end: 0, card: { slots: { title: 'Two' }, duration: 2 }, status: 'ok' },
        { id: 'main', index: 1, kind: 'scene', t_start: 0, t_end: 10, frame: 'acme/device', status: 'ok' },
        { id: 'interstitial-2', index: 2, kind: 'interstitial', t_start: 10, t_end: 10, interstitial: { text: 'Later', component: 'studio/interstitial-plain', params: { tone: 'dark' } }, status: 'ok' },
      ],
      events: [
        {
          scene: 'main',
          scene_index: 1,
          step: 0,
          action: 'wait_for',
          t_start: 1,
          t_end: 2,
          overlay: { component: 'studio/overlay-callout', slots: { text: 'Total' }, params: {}, duration: 2.5, target: 'testid="total"', bbox: { x: 1, y: 2, w: 3, h: 4 } },
          status: 'ok',
        },
      ],
    };
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    expect(TimelineSchema.safeParse(base).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...tl, video: { ...tl.video, extra: 1 } }).success).toBe(false);
  });

  it('timelineVideo: title/intro/outro/music as written, effective frame and template', () => {
    const s: Scenario = {
      video: 'quote',
      title: { text: 'Request a quote' },
      intro: { component: 'studio/intro-minimal' },
      outro: false,
      music: { file: 'assets/bed.mp3' },
      scenes: [],
    };
    const project = { frame: 'card', template: 'default' } as const;
    expect(timelineVideo(s, project)).toEqual({
      title: { text: 'Request a quote' },
      intro: { component: 'studio/intro-minimal' },
      outro: false,
      frame: 'card',
      template: 'default',
      music: { file: 'assets/bed.mp3' },
    });
    expect(timelineVideo({ ...s, frame: 'phone', template: 'motion' }, project)).toMatchObject({ frame: 'phone', template: 'motion' });
    expect(timelineVideo({ ...s, template: 'motion' }, project, 'editorial').template).toBe('editorial');
    const v = timelineVideo(s, project);
    (v.title as { text: string }).text = 'changed';
    expect(s.title?.text).toBe('Request a quote');
    expect(timelineVideo({ video: 'x', scenes: [] }, project)).toEqual({ frame: 'card', template: 'default' });
  });
});

describe('JSON Schemas carry the phase-2 keys with descriptions (R-SCN-08)', () => {
  it('scenario: card entry, overlay modifier, frame ids, intro/outro/interstitial components', () => {
    const s = scenarioJsonSchema() as Json;
    const d = s.$defs;
    expect(d.SceneEntry.anyOf.map((b: Json) => b.$ref)).toEqual(['#/$defs/Scene', '#/$defs/Interstitial', '#/$defs/Card']);
    expect(d.Card.required).toEqual(['card']);
    expect(Object.keys(d.Card.properties.card.properties)).toEqual(['component', 'params', 'slots', 'duration']);
    for (const k of ['component', 'params', 'slots', 'duration']) expect(typeof d.Card.properties.card.properties[k].description, k).toBe('string');
    expect(d.Overlay.required).toEqual(['component']);
    expect(d.Overlay.properties.duration).toMatchObject({ exclusiveMinimum: 0, maximum: 30 });
    expect(d.Overlay.properties.component.pattern).toBe(COMPONENT_ID_RE.source);
    for (const branch of d.Step.anyOf as Json[]) expect(branch.properties.overlay, branch.title).toEqual({ $ref: '#/$defs/Overlay' });
    expect(d.Frame.anyOf[0].enum).toEqual(['raw', 'card', 'browser', 'laptop', 'phone', 'tablet']);
    expect(d.Frame.anyOf[1].pattern).toBe(COMPONENT_ID_RE.source);
    expect(d.Scene.properties.frame).toMatchObject({ $ref: '#/$defs/Frame', description: expect.any(String) });
    expect(s.properties.frame).toMatchObject({ $ref: '#/$defs/Frame', description: expect.any(String) });
    const intro = s.properties.intro.anyOf[1].properties;
    expect(Object.keys(intro)).toEqual(['component', 'params', 'duration']);
    expect(Object.keys(s.properties.outro.anyOf[1].properties)).toEqual(['component', 'params', 'tagline', 'url', 'duration']);
    expect(Object.keys(d.Interstitial.properties.interstitial.properties)).toEqual(['text', 'kicker', 'duration', 'style', 'component', 'params']);
    for (const k of ['component', 'params', 'duration']) expect(typeof intro[k].description, k).toBe('string');
  });

  it('template: brand and one described key per component kind; timeline: video, card, overlay', () => {
    const t = templateJsonSchema() as Json;
    expect(Object.keys(t.properties.brand.properties)).toEqual(['name', 'url']);
    const comps = t.properties.components;
    expect(comps.additionalProperties).toBe(false);
    expect(Object.keys(comps.properties)).toEqual([...COMPONENT_KINDS]);
    for (const k of COMPONENT_KINDS) {
      expect(comps.properties[k].anyOf, k).toEqual([{ $ref: '#/$defs/ComponentRef' }, { type: 'null' }]);
      expect(typeof comps.properties[k].description, k).toBe('string');
    }
    expect(t.$defs.ComponentRef.anyOf[0].pattern).toBe(COMPONENT_ID_RE.source);
    const tl = timelineJsonSchema() as Json;
    expect(Object.keys(tl.properties.video.properties)).toEqual(['title', 'intro', 'outro', 'frame', 'template', 'music']);
    expect(tl.properties.scenes.items.properties.kind.enum).toEqual(['scene', 'interstitial', 'card']);
    expect(Object.keys(tl.properties.events.items.properties.overlay.properties)).toEqual([
      'component',
      'slots',
      'params',
      'duration',
      'target',
      'bbox',
      'point',
    ]);
  });
});

describe('frame comments data model (R-CMT-01)', () => {
  it('FrameComment carries the frame, an optional region, the anchor, replies and the resolution', () => {
    const comment = {
      id: 'c-1',
      scenario: 'quote',
      render_id: 'quote-v3',
      frame: 412,
      time_s: 13.733,
      region: { x: 0.52, y: 0.61, w: 0.2, h: 0.08 },
      text: 'The total should stay on screen a bit longer.',
      author: 'reviewer',
      created_at: '2026-10-11T18:00:00.000Z',
      status: 'resolved',
      anchor: { segment: 'proposal', kind: 'clip', component: 'studio/layout-card', scene: 'proposal', step: 2, step_id: 'total', src_time_s: 41.2 },
      replies: [{ author: 'claude', text: 'Hold extended to 2.5 s.', created_at: '2026-10-11T18:05:00.000Z' }],
      resolution: { by: 'claude', note: 'hold: 2.5 on the step', render_id: 'quote-v4' },
    } satisfies FrameComment;
    const file: FrameCommentsFile = { version: 1, scenario: 'quote', comments: [comment] };
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
    expect(COMMENTS_DIR).toBe('comments');
  });
});
