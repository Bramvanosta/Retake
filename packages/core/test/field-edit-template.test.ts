/**
 * L4.7 part A1 (critique B1): a scenario's `template` — its theme by name — is a field of the timeline's `set_field`
 * (core FIELD_PATHS.top): set, changed and removed (the project's theme) as a splice before `scenes:`; never a path; an
 * edit value (L5.5: a render of every existing take re-plans it, no new capture). The engine checks the name is a theme
 * the workspace lists (engine theme-edit tests).
 */
import { describe, expect, it } from 'vitest';
import { FIELD_PATHS, StepEditError, applyFieldEdit, fieldKindOf, filmedChanges, parseScenario, parseYaml, timelineVideo, verifyEditText } from '../src/index.js';

const BASE = `# Quote
video: demo
title: {text: Hello}   # the title
# The scenes
scenes:
  - id: request
    page: shop
    steps:
      - click: Save
`;
const top = { entry: 'top' } as const;

function refusal(t: string, edit: Parameters<typeof applyFieldEdit>[1]): StepEditError {
  try {
    applyFieldEdit(t, edit);
  } catch (e) {
    expect(e).toBeInstanceOf(StepEditError);
    return e as StepEditError;
  }
  throw new Error('not refused');
}

describe('set_field template (L4.7, critique B1)', () => {
  it('is a top-level field of kind theme', () => {
    expect(FIELD_PATHS.top).toContain('template');
    expect(fieldKindOf('template')).toBe('theme');
  });

  it("set: one line before `scenes:` above its comment lines; changed in place; removed back to the project's theme", () => {
    const set = applyFieldEdit(BASE, { kind: 'set_field', at: top, field: 'template', to: 'motion' });
    expect(verifyEditText(set.text, set.intended)).toBeNull();
    expect(set.text).toBe(BASE.replace('# The scenes\n', 'template: motion\n# The scenes\n'));
    expect(set.label).toBe('Set the theme to motion');
    expect(parseScenario(set.text).scenario?.template).toBe('motion');
    const changed = applyFieldEdit(set.text, { kind: 'set_field', at: top, field: 'template', from: 'motion', to: 'my-brand' });
    expect(changed.text).toBe(BASE.replace('# The scenes\n', 'template: my-brand\n# The scenes\n'));
    const removed = applyFieldEdit(changed.text, { kind: 'set_field', at: top, field: 'template', from: 'my-brand' });
    expect(removed.text).toBe(BASE);
    expect(removed.label).toBe("Reset the theme to the project's theme");
  });

  it("is an edit value: no filmed change; the timeline video takes it (the project's otherwise)", () => {
    const set = applyFieldEdit(BASE, { kind: 'set_field', at: top, field: 'template', to: 'editorial' });
    expect(filmedChanges(set.text, BASE)).toEqual([]);
    const s = parseScenario(set.text).scenario!;
    expect(timelineVideo(s, { frame: 'card', template: 'default' }).template).toBe('editorial');
    expect(timelineVideo(parseScenario(BASE).scenario!, { frame: 'card', template: 'default' }).template).toBe('default');
  });

  it('a path, a name with a slash or a hidden character is refused before anything is written', () => {
    for (const to of ['./theme', '../templates/x', '/abs/theme', 'templates/editorial', 'my theme', '-dash', 'edi​torial', '', 'x'.repeat(101), 3 as unknown as string]) {
      const e = refusal(BASE, { kind: 'set_field', at: top, field: 'template', to });
      expect(e.code, String(to)).toBe('invalid');
      expect(e.message, String(to)).toMatch(/takes a theme name|takes a name|U\+200B/);
    }
  });

  it('stale: a theme changed meanwhile is never overwritten; nothing to change is said', () => {
    const t = BASE.replace('# The scenes\n', 'template: motion\n# The scenes\n');
    expect(refusal(t, { kind: 'set_field', at: top, field: 'template', from: 'editorial', to: 'default' }).code).toBe('stale');
    expect(refusal(t, { kind: 'set_field', at: top, field: 'template', to: 'default' }).code).toBe('stale');
    expect(refusal(t, { kind: 'set_field', at: top, field: 'template', from: 'motion', to: 'motion' }).message).toMatch(/nothing to change/);
  });

  it('a template written as a path stays replaceable by a name (undo restores the path through `restore`)', () => {
    const t = BASE.replace('# The scenes\n', 'template: ./brand\n# The scenes\n');
    const r = applyFieldEdit(t, { kind: 'set_field', at: top, field: 'template', from: './brand', to: 'editorial' });
    expect((parseYaml(r.text).value as { template: string }).template).toBe('editorial');
  });
});
