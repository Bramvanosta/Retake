import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_TEMPLATE,
  TemplateSchema,
  createProject,
  listTemplates,
  loadProjectTemplate,
  loadTemplate,
  parseTemplateYaml,
  STARTER_TEMPLATES_DIR,
} from '@retake/core';
import { tempDir, writeFiles } from './helpers.js';

const ASSETS = {
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'fonts/Display.ttf': 'x',
  'fonts/Body-Regular.ttf': 'x',
  'fonts/Body-SemiBold.ttf': 'x',
  'fonts/Body-Bold.ttf': 'x',
};

function withPrefix(prefix: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
}

let ws: { dir: string; cleanup: () => Promise<void> };
beforeEach(async () => {
  ws = await tempDir();
});
afterEach(() => ws.cleanup());

describe('DEFAULT_TEMPLATE', () => {
  it('is a complete, valid template with the documented look', () => {
    expect(TemplateSchema.safeParse(DEFAULT_TEMPLATE).success).toBe(true);
    expect(DEFAULT_TEMPLATE).toMatchObject({
      frame: { style: 'card', width: 1560, radius: 18, shadow: 'soft' },
      captions: { position: 'below' },
      intro: { duration: 3.2, layout: 'logo-kicker-title' },
      outro: { duration: 3.0, layout: 'logo-wordmark-tagline-url' },
      interstitial: { style: 'dark-clock' },
      transitions: { between_scenes: 'crossfade', duration: 0.35 },
      cursor: { style: 'arrow-dark' },
      motion: { default_zoom: 'none', max_zoom: 1.4, zoom_ease: [0.45, 0, 0.2, 1] },
      style_bias: 'real',
    });
  });
});

describe('loadTemplate', () => {
  it('applies defaults to a minimal template and resolves assets', async () => {
    await writeFiles(ws.dir, { ...withPrefix('templates/plain', ASSETS), 'templates/plain/template.yaml': '' });
    const t = await loadTemplate('plain', ws.dir);
    const dir = join(ws.dir, 'templates/plain');
    expect(t.name).toBe('plain');
    expect(t.dir).toBe(dir);
    expect(t.template).toEqual({ ...DEFAULT_TEMPLATE, name: 'plain' });
    expect(t.assets).toEqual({
      logo: join(dir, 'logo.svg'),
      display: join(dir, 'fonts/Display.ttf'),
      body: ['Body-Regular', 'Body-SemiBold', 'Body-Bold'].map((f) => join(dir, `fonts/${f}.ttf`)),
    });
  });

  it('merges objects deeply, replaces arrays and scalars', async () => {
    await writeFiles(ws.dir, {
      ...withPrefix('templates/editorial', { 'brand/mark.png': 'x', 'f/Serif.otf': 'x', 'f/Sans.woff2': 'x', 'brand/word.svg': 'x' }),
      'templates/editorial/template.yaml': [
        'colors: {accent: "#8a2332", highlight: "#f0c"}',
        'fonts: {display: f/Serif.otf, body: [f/Sans.woff2]}',
        'logo: brand/mark.png',
        'wordmark: brand/word.svg',
        'captions: {kicker: {size: 17}}',
        'motion: {max_zoom: 1.25}',
        'outro: {url: example.com}',
      ].join('\n'),
    });
    const { template, assets } = await loadTemplate(join(ws.dir, 'templates/editorial'));
    expect(template.colors).toEqual({ ...DEFAULT_TEMPLATE.colors, accent: '#8a2332', highlight: '#f0c' });
    expect(template.fonts.body).toEqual(['f/Sans.woff2']);
    expect(template.captions.kicker).toEqual({ ...DEFAULT_TEMPLATE.captions.kicker, size: 17 });
    expect(template.motion).toEqual({ ...DEFAULT_TEMPLATE.motion, max_zoom: 1.25 });
    expect(template.outro).toEqual({ ...DEFAULT_TEMPLATE.outro, url: 'example.com' });
    expect(template.name).toBe('editorial');
    expect(assets.wordmark).toBe(join(ws.dir, 'templates/editorial/brand/word.svg'));
  });

  it('fails with a clear message listing every missing asset', async () => {
    await writeFiles(ws.dir, {
      'templates/broken/template.yaml': 'wordmark: wordmark.svg\n',
      'templates/broken/fonts/Display.ttf': 'x',
    });
    const err = await loadTemplate('broken', ws.dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(
      `template "broken" (${join(ws.dir, 'templates/broken')}) is missing 5 asset files: ` +
        'logo.svg, wordmark.svg, fonts/Body-Regular.ttf, fonts/Body-SemiBold.ttf, fonts/Body-Bold.ttf',
    );
  });

  it('invalid template.yaml → positioned issues; unknown template → suggestion', async () => {
    await writeFiles(ws.dir, {
      ...withPrefix('templates/x', ASSETS),
      'templates/x/template.yaml': 'frame: {style: card, widht: 1500}\nstyle_bias: subtle\nlogo: logo.gif\n',
    });
    const err = (await loadTemplate('x', ws.dir).catch((e: unknown) => e)) as ConfigError;
    expect(err.issues.map((i) => `${i.line}:${i.col} ${i.message}`)).toEqual([
      '1:22 unknown key "widht" (did you mean "width"?)',
      '2:13 expected one of "real", "balanced", "motion", got "subtle"',
      '3:7 expected an image file (.svg, .png, .jpg or .webp) relative to the template dir',
    ]);
    await expect(loadTemplate('y', ws.dir)).rejects.toThrow(
      /template "y" not found in .*templates or the starter templates \(did you mean "x"\?\) \(available: default, editorial, motion, x\)/,
    );
  });

  it('listTemplates and loadProjectTemplate (name or project-relative path)', async () => {
    await writeFiles(ws.dir, {
      ...withPrefix('templates/default', ASSETS),
      'templates/default/template.yaml': 'name: Neutral\n',
      'templates/notes/README.md': 'not a template',
    });
    // The workspace's own default shadows the starter one; the other starters are listed after it.
    expect(await listTemplates(ws.dir)).toEqual([
      { name: 'default', dir: join(ws.dir, 'templates/default'), source: 'workspace' },
      { name: 'editorial', dir: join(STARTER_TEMPLATES_DIR, 'editorial'), source: 'starter' },
      { name: 'motion', dir: join(STARTER_TEMPLATES_DIR, 'motion'), source: 'starter' },
    ]);
    const p = await createProject(ws.dir, { name: 'Northfield' });
    const t = await loadProjectTemplate(p);
    expect(t.name).toBe('default');
    expect(t.template.name).toBe('Neutral');
    await writeFiles(p.dir, { ...withPrefix('brand', ASSETS), 'brand/template.yaml': 'colors: {accent: "#123456"}\n' });
    const local = await loadProjectTemplate(p, './brand');
    expect(local.dir).toBe(join(p.dir, 'brand'));
    expect(local.template.colors.accent).toBe('#123456');
  });

  it('a workspace without templates uses the starter templates (R-MAC-04)', async () => {
    const p = await createProject(ws.dir, { name: 'Northfield' });
    expect(p.config.template).toBe('default');
    expect((await listTemplates(ws.dir)).map((t) => `${t.name}:${t.source}`)).toEqual(['default:starter', 'editorial:starter', 'motion:starter']);
    const t = await loadProjectTemplate(p);
    expect(t.dir).toBe(join(STARTER_TEMPLATES_DIR, 'default'));
    expect((await loadTemplate('editorial', ws.dir)).dir).toBe(join(STARTER_TEMPLATES_DIR, 'editorial'));
  });

  it('a workspace folder named like a starter shadows it, even without a template.yaml', async () => {
    await writeFiles(ws.dir, { 'templates/default/README.md': 'work in progress' });
    expect((await listTemplates(ws.dir)).map((t) => t.name)).toEqual(['editorial', 'motion']);
    await expect(loadTemplate('default', ws.dir)).rejects.toThrow(/template "default": no template\.yaml in .*templates\/default \(a workspace folder of that name takes precedence/);
  });

  it('the repository itself lists its templates once, as its own', async () => {
    expect((await listTemplates(join(STARTER_TEMPLATES_DIR, '..'))).map((t) => `${t.name}:${t.source}`)).toEqual([
      'default:workspace',
      'editorial:workspace',
      'motion:workspace',
    ]);
  });

  it('parseTemplateYaml validates without touching the disk', () => {
    expect(parseTemplateYaml('motion: {max_zoom: 5}').issues[0]).toMatchObject({ message: 'must be ≤ 3, got 5', line: 1 });
    expect(parseTemplateYaml('').template?.frame.width).toBe(1560);
  });
});
