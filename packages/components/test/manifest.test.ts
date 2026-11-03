import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPONENT_KINDS, formatIssues } from '@retake/core';
import {
  ComponentManifestFileSchema,
  PACKAGE_DIR,
  componentJsonSchema,
  parseManifest,
} from '@retake/components';
import type { ComponentIssue } from '@retake/components';
import { cardManifest } from './helpers.js';

const fmt = (issues: ComponentIssue[]) => formatIssues(issues, 'component.yaml');
const errors = (text: string, folderId?: string) => parseManifest(text, 'component.yaml', { folderId }).issues.filter((i) => i.severity === 'error');
const warnings = (text: string) => parseManifest(text).issues.filter((i) => i.severity === 'warning');

const LAYOUT = `id: acme/frame
version: 0.2.0
kind: layout
name: Frame
description: Capture in a frame.
slots:
  screen: {type: screen, required: true}
geometry:
  screen: {x: 160, y: 60, w: 1600, h: 900}
  caption: {x: 160, y: 970, w: 1600, h: 90}
  radius: 16
`;

describe('parseManifest (R-CMP-04)', () => {
  it('accepts a complete manifest and applies defaults (entry, slots)', () => {
    const { manifest, issues } = parseManifest(cardManifest('acme/title-card', 'publisher: Acme Studio\nlicense: MIT\ntags: [title, chapter]\ntokens: [colors.accent, fonts.display, colors.highlight]\nvariants: [landscape, vertical]'));
    expect(issues).toEqual([]);
    expect(manifest).toMatchObject({
      id: 'acme/title-card',
      version: '1.0.0',
      kind: 'card',
      entry: 'index.tsx',
      slots: { title: { type: 'text', required: true, max_chars: 60 }, kicker: { type: 'text' } },
      duration: { default: 2.5, min: 1, max: 10 },
      publisher: 'Acme Studio',
      license: 'MIT',
      tags: ['title', 'chapter'],
      variants: ['landscape', 'vertical'],
    });
    const transition = parseManifest('id: a/fade\nversion: 1.0.0\nkind: transition\nname: Fade\ndescription: Fade.\n');
    expect(transition.issues).toEqual([]);
    expect(transition.manifest?.slots).toEqual({});
  });

  it('is strict: unknown keys are positioned errors with a did-you-mean', () => {
    const text = cardManifest('acme/title-card', 'descripton: typo').replace('  kicker: {type: text}', '  kicker: {type: text, requird: true}');
    const out = fmt(errors(text));
    expect(out).toMatch(/component\.yaml:8:\d+ error slots\.kicker: unknown key "requird" \(did you mean "required"\?\)/);
    expect(out).toMatch(/component\.yaml:17:1 error: unknown key "descripton"/);
  });

  it('checks id, semver, kind and slot types with positions', () => {
    const text = 'id: Acme/Title\nversion: "1.0"\nkind: intr\nname: X\ndescription: Y\nslots:\n  title: {type: txt}\n';
    const out = fmt(errors(text));
    expect(out).toMatch(/component\.yaml:1:5 error id: component id must be "namespace\/name"/);
    expect(out).toMatch(/:2:10 error version: version must be a semantic version like "1\.0\.0", got "1\.0"/);
    expect(out).toMatch(/:3:7 error kind: expected one of .* got "intr" \(did you mean "intro"\?\)/);
    expect(out).toMatch(/:7:17 error slots\.title\.type: expected one of "text", "image", "url", "color", "screen", "email", "document", "notification", "capture", "frame", "data", "media", "lottie", got "txt"/);
    expect(errors('id: a/b\nversion: 1.2.3-beta.1+build.5\nkind: card\nname: X\ndescription: Y\n')).toEqual([]);
  });

  it('checks that the id matches the folder path', () => {
    expect(fmt(errors(cardManifest('acme/title-card'), 'acme/other-card'))).toMatch(
      /:1:5 error id: id "acme\/title-card" does not match the folder path "acme\/other-card"/,
    );
    expect(errors(cardManifest('acme/title-card'), 'acme/title-card')).toEqual([]);
  });

  it('layouts must declare geometry inside the design space (R-CMP-11)', () => {
    expect(errors(LAYOUT)).toEqual([]);
    const missing = fmt(errors(LAYOUT.replace(/geometry:[\s\S]*$/, '')));
    expect(missing).toMatch(/:3:7 error: a layout component must declare "geometry"/);
    const outside = fmt(errors(LAYOUT.replace('w: 1600, h: 900', 'w: 1800, h: 900')));
    expect(outside).toMatch(/:9:\d+ error geometry\.screen: screen rect \{x: 160, y: 60, w: 1800, h: 900\} leaves the 1920×1080 design space/);
    const vertical = fmt(errors(`${LAYOUT}variants: [landscape, vertical]\n`));
    expect(vertical).toMatch(/error: a layout with the vertical variant must declare "geometry_vertical"/);
    const ok = `${LAYOUT}variants: [landscape, vertical]\ngeometry_vertical:\n  screen: {x: 40, y: 600, w: 1000, h: 563}\n`;
    expect(errors(ok)).toEqual([]);
    const tooWide = ok.replace('{x: 40, y: 600, w: 1000, h: 563}', '{x: 40, y: 600, w: 1600, h: 900}');
    expect(fmt(errors(tooWide))).toMatch(/geometry_vertical\.screen: .* leaves the 1080×1920 design space/);
    expect(fmt(errors(LAYOUT.replace('w: 1600, h: 900', 'w: 0, h: 900')))).toMatch(/geometry\.screen\.w: must be > 0/);
    // Geometry on another kind is a warning (ignored).
    expect(fmt(warnings(`${cardManifest()}geometry:\n  screen: {x: 0, y: 0, w: 100, h: 100}\n`))).toMatch(/geometry is only used by layout components/);
  });

  it('checks duration bounds and warns for clip-bound kinds', () => {
    expect(fmt(errors(cardManifest().replace('duration: {default: 2.5, min: 1, max: 10}', 'duration: {default: 12, min: 1, max: 10}')))).toMatch(
      /duration\.default: default \(12 s\) is above max \(10 s\)/,
    );
    expect(fmt(errors(cardManifest().replace('duration: {default: 2.5, min: 1, max: 10}', 'duration: {default: 2, min: 5, max: 3}')))).toMatch(
      /duration\.min: min \(5 s\) is greater than max \(3 s\)/,
    );
    expect(fmt(errors(cardManifest().replace('duration: {default: 2.5, min: 1, max: 10}', 'duration: {default: 0}')))).toMatch(/duration\.default: must be > 0/);
    expect(fmt(warnings(`${LAYOUT}duration: {default: 3}\n`))).toMatch(/duration is ignored for layout components/);
  });

  it('warns on unknown slot sources and theme tokens, and on max_chars of non-text slots (R-CMP-10)', () => {
    const text = cardManifest('acme/t', 'tokens: [colors.accent, font.display]').replace(
      '  kicker: {type: text}',
      '  kicker: {type: text, default_from: scenario.title.kiker}\n  logo: {type: image, default_from: theme.logo, max_chars: 3}',
    );
    const out = fmt(warnings(text));
    expect(out).toMatch(/warning slots\.kicker\.default_from: unknown slot source "scenario\.title\.kiker" \(did you mean "scenario\.title\.kicker"\?\)/);
    expect(out).toMatch(/warning slots\.logo\.max_chars: max_chars only applies to text and url slots/);
    expect(out).toMatch(/warning tokens\[1\]: unknown theme token "font\.display" \(did you mean "fonts\.display"\?\)/);
    expect(errors(text)).toEqual([]);
  });

  it('preview samples must fill the required slots and name declared slots (R-REG-08)', () => {
    const noPreview = cardManifest().replace('preview:\n  slots: {title: Hello}\n', '');
    expect(fmt(errors(noPreview))).toMatch(/error: preview\.slots must give a sample for the required slot "title"/);
    const typo = cardManifest().replace('slots: {title: Hello}', 'slots: {titel: Hello}');
    const out = fmt(errors(typo));
    expect(out).toMatch(/:16:\d+ error preview\.slots: unknown slot "titel" \(did you mean "title"\?\)/);
    expect(out).toMatch(/error preview: preview\.slots must give a sample for the required slot "title"/);
    // A required slot filled from the theme, or a screen slot, needs no sample.
    const themed = cardManifest().replace('  kicker: {type: text}', '  logo: {type: image, required: true, default_from: theme.logo}');
    expect(errors(themed)).toEqual([]);
    expect(errors(LAYOUT)).toEqual([]);
  });

  it('checks the params JSON Schema and its defaults (R-REG-07)', () => {
    const withParams = (params: string) => cardManifest().replace(/params:\n(?: {2}.*\n)+/, `params:\n${params}`);
    const cases: Array<[string, RegExp]> = [
      ['  type: array\n', /params\.type: params must be an object schema \(type: object\), got type "array"/],
      ['  properties: {a: {type: string}}\n', /error params: params must be an object schema: add "type: object"/],
      ['  type: object\n  properties:\n    a: {type: strin}\n', /params\.properties\.a\.type: unknown type "strin" \(did you mean "string"\?\)/],
      ['  type: object\n  properties:\n    a: {type: number, defualt: 1}\n', /params\.properties\.a: unknown schema keyword "defualt" \(did you mean "default"\?\)/],
      ['  type: object\n  properties:\n    a: {$ref: "#/x"}\n', /"\$ref" is not supported in component params/],
      ['  type: object\n  properties:\n    a: {type: number, maximum: 10, default: 12}\n', /params\.properties\.a\.default: default does not match its schema: must be ≤ 10, got 12/],
      ['  type: object\n  properties:\n    a: {type: string, enum: [soft, none], default: hard}\n', /default does not match its schema: expected one of "soft", "none", got "hard"/],
      ['  type: object\n  required: [b]\n  properties:\n    a: {type: number}\n', /params\.required\[0\]: required property "b" is not declared in properties/],
      ['  type: object\n  properties:\n    a: {type: string, pattern: "("}\n', /params\.properties\.a\.pattern: invalid regular expression/],
      ['  type: object\n  properties:\n    a: {type: number, minimum: 5, maximum: 1}\n', /minimum \(5\) is greater than maximum \(1\)/],
    ];
    for (const [params, re] of cases) expect(fmt(errors(withParams(params))), params).toMatch(re);
    // Positions point into the schema.
    const located = errors(withParams('  type: object\n  properties:\n    a: {type: number, maximum: 10, default: 12}\n'));
    expect(located[0]).toMatchObject({ line: 12, file: 'component.yaml' });
  });

  it('validates preview params against the params schema', () => {
    const text = cardManifest().replace('slots: {title: Hello}', 'slots: {title: Hello}\n  params: {aling: left, size: 200}');
    const out = fmt(errors(text));
    expect(out).toMatch(/preview\.params: unknown key "aling" \(did you mean "align"\?\)/);
    expect(out).toMatch(/preview\.params\.size: must be ≤ 120, got 200/);
  });

  it('checks entry paths and variants', () => {
    expect(fmt(errors(cardManifest('a/b', 'entry: ../x.tsx')))).toMatch(/entry: entry must be a path inside the component folder/);
    expect(fmt(errors(cardManifest('a/b', 'entry: component.css')))).toMatch(/entry must be a \.tsx, \.ts, \.jsx or \.js file/);
    expect(errors(cardManifest('a/b', 'entry: src/main.tsx'))).toEqual([]);
    expect(fmt(errors(cardManifest('a/b', 'variants: [landscape, landscape]')))).toMatch(/variants\[1\]: "landscape" is listed twice/);
  });

  it('reports YAML syntax errors with positions', () => {
    const out = fmt(errors('id: a/b\nslots: {title: [}\n'));
    expect(out).toMatch(/component\.yaml:2:\d+ error: YAML:/);
  });

  it('covers every component kind', () => {
    for (const kind of COMPONENT_KINDS) {
      const r = ComponentManifestFileSchema.safeParse({ id: 'a/b', version: '1.0.0', kind, name: 'X', description: 'Y' });
      expect(r.success, kind).toBe(true);
    }
  });
});

describe('component.schema.json (editor autocompletion)', () => {
  it('is up to date (pnpm -F @retake/components gen:schema)', () => {
    const onDisk = JSON.parse(readFileSync(join(PACKAGE_DIR, 'schema', 'component.schema.json'), 'utf8'));
    expect(onDisk).toEqual(componentJsonSchema());
  });

  it('describes every manifest key, strictly, with params as the supported JSON Schema subset', () => {
    const s = componentJsonSchema() as {
      properties: Record<string, { $ref?: string }>;
      required: string[];
      additionalProperties: boolean;
      $defs: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(Object.keys(s.properties)).toEqual(Object.keys(ComponentManifestFileSchema.shape));
    expect(s.required).toEqual(['id', 'version', 'kind', 'name', 'description']);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.params.$ref).toBe('#/$defs/ParamSchema');
    expect(Object.keys(s.$defs.ParamSchema.properties)).toEqual(expect.arrayContaining(['type', 'properties', 'default', 'enum', 'minimum']));
  });
});
