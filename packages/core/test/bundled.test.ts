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
});
