import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  TemplateSchema,
  errorsOf,
  listProjects,
  listTemplates,
  loadProject,
  loadProjectTemplate,
  loadScenario,
  loadTemplate,
  parseTemplateYaml,
  resolveThemeComponents,
  COMPONENT_KINDS,
  COMPONENT_ID_RE,
} from '@demo-studio/core';

/** The repository itself is a workspace: bundled starter templates and the fixture project. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('bundled templates', () => {
  it('every template loads with all its assets and is complete on its own (no reliance on defaults)', async () => {
    const templates = await listTemplates(ROOT);
    expect(templates.map((t) => t.name)).toEqual(expect.arrayContaining(['default', 'editorial', 'motion']));
    for (const t of templates) {
      const loaded = await loadTemplate(t.name, ROOT);
      expect(loaded.template.name, t.name).toBeTruthy();
      const text = await readFile(`${t.dir}/template.yaml`, 'utf8');
      expect(parseTemplateYaml(text).issues, t.name).toEqual([]);
      const standalone = TemplateSchema.safeParse(parse(text));
      expect(standalone.success, `${t.name}: ${standalone.error?.message ?? ''}`).toBe(true);
    }
  });
});

describe('bundled templates pick components (R-THM-01..03)', () => {
  it('each declares a fictional brand and an explicit component per kind, consistent with its legacy fields', async () => {
    for (const t of await listTemplates(ROOT)) {
      const { template } = await loadTemplate(t.name, ROOT);
      expect(template.brand?.name, t.name).toBeTruthy();
      expect(template.brand?.url, t.name).toBe('example.com');
      expect(Object.keys(template.components ?? {}).sort(), t.name).toEqual([...COMPONENT_KINDS].sort());
      const chosen = resolveThemeComponents(template);
      const legacy = resolveThemeComponents({ ...template, components: undefined });
      for (const kind of COMPONENT_KINDS) {
        const c = chosen[kind];
        expect(c?.source, `${t.name}.${kind}`).toBe('theme');
        expect(COMPONENT_ID_RE.test(c!.id), `${t.name}.${kind}`).toBe(true);
        expect({ id: c!.id, params: c!.params }, `${t.name}.${kind} matches the legacy fields`).toEqual(
          legacy[kind] && { id: legacy[kind]!.id, params: legacy[kind]!.params },
        );
      }
    }
  });
});

describe('bundled fixture project', () => {
  it('loads with its template, and every scenario validates without errors', async () => {
    const projects = await listProjects(ROOT);
    expect(projects.map((p) => p.slug)).toContain('northfield-fixture');
    const project = await loadProject('northfield-fixture', ROOT);
    expect(errorsOf(project.issues ?? [])).toEqual([]);
    const template = await loadProjectTemplate(project);
    expect(project.scenarios).toEqual(expect.arrayContaining(['catalogue', 'quote']));
    for (const name of project.scenarios) {
      const loaded = await loadScenario(project, name, { template: template.template });
      expect(errorsOf(loaded.issues), name).toEqual([]);
    }
  });

  it('the quote scenario shows the phase-2 syntax: a card entry and a step overlay with a target', async () => {
    const project = await loadProject('northfield-fixture', ROOT);
    const { scenario } = await loadScenario(project, 'quote');
    const card = scenario.scenes.find((e) => 'card' in e);
    expect(card).toMatchObject({ id: 'chapter-request', card: { slots: { title: expect.any(String) } } });
    const steps = scenario.scenes.flatMap((e) => ('steps' in e ? e.steps : []));
    const withOverlay = steps.filter((st) => st.overlay);
    // L2.9 added the captured web notification (studio/notification, no target) next to the targeted callout.
    expect(withOverlay).toHaveLength(2);
    expect(withOverlay.find((st) => st.overlay?.target)?.overlay).toMatchObject({ component: 'studio/overlay-callout', target: { testid: 'proposal-total' } });
    expect(withOverlay.find((st) => !st.overlay?.target)?.overlay).toMatchObject({ component: 'studio/notification', slots: { notification: 'quote-request' } });
  });
});
