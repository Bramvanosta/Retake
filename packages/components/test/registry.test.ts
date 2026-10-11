import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS, DEFAULT_TEMPLATE } from '@demo-studio/core';
import type { ComponentKind, Template } from '@demo-studio/core';
import { ComponentError, LIBRARY_DIR, loadComponentRegistry } from '@demo-studio/components';
import { CARD_TSX, cardManifest, tempDir, writeFiles } from './helpers.js';

let ws: { dir: string; cleanup: () => Promise<void> };
let builtin: string;

/** A minimal valid manifest of any kind (layouts get geometry). */
function manifestOf(id: string, kind: ComponentKind, extra = ''): string {
  const geometry = kind === 'layout' ? 'geometry:\n  screen: {x: 180, y: 60, w: 1560, h: 878}\n' : '';
  return `id: ${id}\nversion: 1.0.0\nkind: ${kind}\nname: ${id}\ndescription: A ${kind}.\n${geometry}${extra}`;
}

function component(base: string, id: string, kind: ComponentKind, extra = ''): Record<string, string> {
  return { [`${base}/${id}/component.yaml`]: manifestOf(id, kind, extra), [`${base}/${id}/index.tsx`]: 'export default function C() { return null; }\n' };
}

beforeEach(async () => {
  ws = await tempDir();
  builtin = join(ws.dir, 'builtin');
  await writeFiles(ws.dir, {
    'components/acme/title-card/component.yaml': cardManifest('acme/title-card'),
    'components/acme/title-card/index.tsx': CARD_TSX,
    ...component('components', 'acme/intro-split', 'intro'),
    ...component('components', 'studio/layout-card', 'layout', 'params:\n  type: object\n  properties:\n    width: {type: number, minimum: 800, maximum: 1920, default: 1560}\n'),
    ...component('builtin', 'studio/layout-card', 'layout'),
    ...component('builtin', 'studio/intro-stack', 'intro'),
    ...component('builtin', 'studio/caption-below', 'caption'),
  });
});

afterEach(async () => {
  await ws.cleanup();
});

describe('loadComponentRegistry (R-REG-01, R-REG-02, R-REG-12)', () => {
  it('scans workspace components then the built-in library; a workspace id overrides a built-in one with a warning', async () => {
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    expect(reg.componentsDir).toBe(join(ws.dir, 'components'));
    expect(reg.list().map((c) => `${c.manifest.id} ${c.source}`)).toEqual([
      'acme/intro-split workspace',
      'acme/title-card workspace',
      'studio/caption-below builtin',
      'studio/intro-stack builtin',
      'studio/layout-card workspace',
    ]);
    expect(reg.list('intro').map((c) => c.manifest.id)).toEqual(['acme/intro-split', 'studio/intro-stack']);
    const card = reg.get('acme/title-card');
    expect(card).toMatchObject({ dir: join(ws.dir, 'components/acme/title-card'), entry: join(ws.dir, 'components/acme/title-card/index.tsx'), source: 'workspace' });
    expect(card.manifest.kind).toBe('card');
    expect(reg.notices).toEqual([
      expect.objectContaining({ severity: 'warning', message: 'workspace component studio/layout-card overrides the built-in one', id: 'studio/layout-card', source: 'workspace' }),
    ]);
    expect(reg.has('studio/layout-card')).toBe(true);
    expect(reg.get('studio/layout-card').source).toBe('workspace');
  });

  it('reads components_dir from studio.yaml', async () => {
    await writeFiles(ws.dir, { 'studio.yaml': 'components_dir: ui/parts\n', ...component('ui/parts', 'acme/badge', 'overlay') });
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: null });
    expect(reg.componentsDir).toBe(join(ws.dir, 'ui/parts'));
    expect(reg.list().map((c) => c.manifest.id)).toEqual(['acme/badge']);
  });

  it('the bundled library is scanned by default (19 studio/* components since L2.7) and a missing workspace folder is fine', async () => {
    const empty = await tempDir();
    try {
      const reg = await loadComponentRegistry({ root: empty.dir });
      expect(reg.builtinDir).toBe(LIBRARY_DIR);
      expect(reg.list()).toHaveLength(19);
      expect(reg.list().every((c) => c.source === 'builtin' && c.manifest.id.startsWith('studio/'))).toBe(true);
      expect(reg.notices).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  it('keeps invalid components out of the list and reports them (notices, get)', async () => {
    await writeFiles(ws.dir, {
      'components/acme/broken/component.yaml': 'id: acme/broken\nversion: one\nkind: card\nname: B\ndescription: B.\n',
      'components/acme/broken/index.tsx': '',
      'components/acme/moved/component.yaml': manifestOf('acme/other-name', 'card'),
      'components/acme/moved/index.tsx': '',
      'components/acme/no-entry/component.yaml': manifestOf('acme/no-entry', 'card'),
      'components/Acme/Bad/component.yaml': manifestOf('acme/bad', 'card'),
      'components/loose/component.yaml': manifestOf('loose/x', 'card'),
    });
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    expect(reg.list().map((c) => c.manifest.id)).not.toEqual(expect.arrayContaining(['acme/broken']));
    const notices = reg.notices.map((n) => `${n.severity} ${n.message}`);
    expect(notices).toEqual(
      expect.arrayContaining([
        'error component folder "Acme/Bad" is not a valid id: use lower-case letters, digits and "-" (e.g. acme/intro-split)',
        'error invalid component acme/broken: 1 error in component.yaml (studio components validate acme/broken)',
        'error invalid component acme/moved: 1 error in component.yaml (studio components validate acme/moved)',
        'error invalid component acme/no-entry: entry file index.tsx not found',
        expect.stringMatching(/^warning component\.yaml in loose\/ is ignored: a component lives in <namespace>\/<name>\//),
      ]),
    );
    expect(() => reg.get('acme/broken')).toThrow(/invalid component acme\/broken[\s\S]*component\.yaml:2:10 error version: version must be a semantic version/);
    expect(() => reg.get('acme/moved')).toThrow(/id "acme\/other-name" does not match the folder path "acme\/moved"/);
    try {
      reg.get('acme/broken');
    } catch (e) {
      expect(e).toBeInstanceOf(ComponentError);
      expect((e as ComponentError).issues[0]).toMatchObject({ file: 'component.yaml', line: 2, path: ['version'] });
    }
  });

  it('get: not found with did-you-mean (R-REG-03)', async () => {
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    expect(() => reg.get('studio/intro-stak')).toThrow(/component "studio\/intro-stak" not found in .*components or the built-in library \(did you mean "studio\/intro-stack"\?\)/);
    expect(() => reg.get('intro-stack')).toThrow(/ids are "namespace\/name"/);
    expect(() => reg.get('zzz/qqq')).toThrow(ComponentError);
  });
});

describe('registry.resolve (R-REG-04)', () => {
  it('resolves an id or {id, params}: defaults merged under the given params, validated', async () => {
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    const plain = reg.resolve('acme/title-card', 'card');
    expect(plain).toMatchObject({
      id: 'acme/title-card',
      version: '1.0.0',
      kind: 'card',
      params: { align: 'center', size: 84 },
      source: 'workspace',
      dir: join(ws.dir, 'components/acme/title-card'),
      entry: join(ws.dir, 'components/acme/title-card/index.tsx'),
    });
    expect(plain.manifest.id).toBe('acme/title-card');
    expect(reg.resolve({ id: 'acme/title-card', params: { size: 60 } }, 'card').params).toEqual({ align: 'center', size: 60 });
    expect(reg.resolve({ id: 'acme/intro-split' }, 'intro').params).toEqual({});
  });

  it('rejects a kind mismatch, unknown ids and invalid params with clear messages', async () => {
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    expect(() => reg.resolve('acme/title-card', 'intro')).toThrow(
      'component "acme/title-card" is a card component, not an intro (intro components: acme/intro-split, studio/intro-stack)',
    );
    expect(() => reg.resolve('acme/intro-splt', 'intro')).toThrow(/not found .*\(did you mean "acme\/intro-split"\?\); intro components: acme\/intro-split, studio\/intro-stack/);
    expect(() => reg.resolve({ id: 'acme/title-card', params: { size: 400, aling: 'left' } }, 'card')).toThrow(
      'invalid params for component "acme/title-card":\n  params.size: must be ≤ 120, got 400\n  params: unknown key "aling" (did you mean "align"?)',
    );
    expect(() => reg.resolve({ id: 'acme/intro-split', params: { x: 1 } }, 'intro')).toThrow(/unknown key "x" \(this component takes no params\)/);
  });

  it('resolveTheme: the theme component of every kind (components map → legacy → defaults), resolved', async () => {
    const files: Record<string, string> = {};
    for (const kind of COMPONENT_KINDS) Object.assign(files, component('components', `acme/${kind}-x`, kind));
    await writeFiles(ws.dir, files);
    const reg = await loadComponentRegistry({ root: ws.dir, builtinDir: builtin });
    const template: Template = {
      ...structuredClone(DEFAULT_TEMPLATE),
      name: 'acme',
      components: {
        ...Object.fromEntries(COMPONENT_KINDS.map((k) => [k, `acme/${k}-x`])),
        layout: { id: 'studio/layout-card', params: { width: 1400 } },
        caption: null,
      },
    };
    const themed = reg.resolveTheme(template);
    expect(themed.caption).toBeNull();
    expect(themed.layout).toMatchObject({ id: 'studio/layout-card', params: { width: 1400 }, source: 'workspace' });
    expect(themed.intro?.id).toBe('acme/intro-x');
    expect(Object.keys(themed).sort()).toEqual([...COMPONENT_KINDS].sort());

    // The starter templates point at built-in ids that arrive in L2.5: every failing kind is listed at once.
    const legacy: Template = { ...structuredClone(DEFAULT_TEMPLATE), name: 'plain' };
    expect(() => reg.resolveTheme(legacy)).toThrow(/theme "plain": \d+ components cannot be resolved:\n {2}outro \(a legacy template field\): component "studio\/outro-stack" not found/);
    expect(() => reg.resolveTheme(legacy)).toThrow(/card \(the built-in default\): component "studio\/card-title" not found/);
  });
});
