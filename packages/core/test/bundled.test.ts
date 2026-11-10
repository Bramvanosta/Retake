import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TemplateSchema, errorsOf, parseTemplateYaml, planPersonas, resolvePersonas, resolveThemeComponents, COMPONENT_KINDS, COMPONENT_ID_RE, PERSON_POLICY } from '@retake/core';
import { listProjects, listTemplates, loadProject, loadProjectTemplate, loadScenario, loadTemplate, fileFacts } from '@retake/core/io';

/** The repository itself is a workspace: bundled starter templates and the fixture project. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('bundled templates', () => {
  it('every template loads with all its assets and is complete on its own (no reliance on defaults)', async () => {
    const templates = await listTemplates(ROOT);
    expect(templates.map((t) => t.name)).toEqual(expect.arrayContaining(['default', 'editorial', 'motion']));
    for (const t of templates) {
      const loaded = await loadTemplate(t.name, ROOT, { files: fileFacts(PERSON_POLICY) });
      expect(loaded.template.name, t.name).toBeTruthy();
      const text = await readFile(`${t.dir}/template.yaml`, 'utf8');
      expect(parseTemplateYaml(text).issues, t.name).toEqual([]);
      // Complete on its own: every section of a full template (`version` is the file's format, not a section).
      const { version, ...sections } = parse(text) as { version?: unknown };
      expect(version, t.name).toBe(1);
      const standalone = TemplateSchema.safeParse(sections);
      expect(standalone.success, `${t.name}: ${standalone.error?.message ?? ''}`).toBe(true);
    }
  });
});

describe('bundled templates pick components (R-THM-01..03)', () => {
  it('each declares a fictional brand and an explicit component per kind, consistent with its legacy fields', async () => {
    for (const t of await listTemplates(ROOT)) {
      const { template } = await loadTemplate(t.name, ROOT, { files: fileFacts(PERSON_POLICY) });
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
    const template = await loadProjectTemplate(project, undefined, { files: fileFacts(PERSON_POLICY) });
    expect(project.scenarios).toEqual(expect.arrayContaining(['catalogue', 'quote']));
    // The committed files show the format version (R-PRIN-13): optional, written by example.
    expect(project.config.version).toBe(1);
    for (const name of project.scenarios) {
      const loaded = await loadScenario(project, name, { files: fileFacts(PERSON_POLICY), template: template.template });
      expect(errorsOf(loaded.issues), name).toEqual([]);
      expect(loaded.scenario.version, name).toBe(1);
    }
  });

  it('env signed-in (L1.6): every scenario films each page as the persona of its environment page, env local as none', async () => {
    const project = await loadProject('northfield-fixture', ROOT);
    const personas = resolvePersonas(project, 'signed-in', { home: '/nonexistent-home' });
    expect(personas.map((p) => [p.name, p.pages, p.loginPatterns])).toEqual([
      ['supplier', ['console'], ['/sign-in']],
      ['buyer', ['shop'], ['/sign-in']],
    ]);
    expect(resolvePersonas(project, 'local', { home: '/nonexistent-home' })).toEqual([]);
    const used: Record<string, string> = {};
    for (const name of project.scenarios) {
      const { scenario } = await loadScenario(project, name, { files: fileFacts(PERSON_POLICY) });
      const plan = planPersonas(scenario, { env: 'signed-in', envPages: project.config.environments['signed-in'], personas, hooks: true });
      expect(plan.issues, name).toEqual([]);
      expect(plan.needsDefault, name).toBe(false);
      used[name] = plan.used.join(',');
    }
    expect(used).toMatchObject({ catalogue: 'supplier', reports: 'supplier', quote: 'supplier,buyer', 'live-quote': 'supplier,buyer', signup: 'buyer', 'phone-and-desktop': 'buyer' });
  });

  it('its process sandbox (L1.8) is environment sandbox: the signed-in side on 4503 / 4504, the supplier and buyer accounts, its own mailbox', async () => {
    const project = await loadProject('northfield-fixture', ROOT);
    const sandbox = project.sandboxes?.sandbox;
    expect(sandbox?.issues).toEqual([]);
    expect(sandbox?.manifest).toMatchObject({ provider: 'process', services: { fixture: { url: 'http://localhost:4501', health: '/api/health' } } });
    expect(sandbox?.manifest.services.fixture.command).toEqual(['node', 'server.mjs', '--console-port', '4501', '--shop-port', '4502', '--auth-console-port', '4503', '--auth-shop-port', '4504']);
    expect(project.config.environments.sandbox).toEqual({ console: 'http://localhost:4503', shop: 'http://localhost:4504' });
    expect(project.config.environment_settings?.sandbox).toMatchObject({
      display: { console: 'https://console.northfield.example', shop: 'https://shop.northfield.example' },
      sandbox: { provider: 'process' },
      mailbox: { provider: 'mailpit', url: 'http://localhost:4501/mailbox' },
    });
    const personas = resolvePersonas(project, 'sandbox', { home: '/nonexistent-home' });
    expect(personas.map((p) => [p.name, p.pages, p.sandbox, p.secrets])).toEqual([
      ['supplier', ['console'], true, ['roast-lot-2026']],
      ['buyer', ['shop'], true, ['filter-bloom-2026']],
    ]);
    const { scenario, issues } = await loadScenario(project, 'sandbox-quote', { files: fileFacts(PERSON_POLICY) });
    expect(errorsOf(issues)).toEqual([]);
    expect(scenario.env).toBe('sandbox');
    expect(scenario.setup ?? []).toEqual([]);
    expect(planPersonas(scenario, { env: 'sandbox', envPages: project.config.environments.sandbox, personas, hooks: true }).used).toEqual(['buyer']);
  });

  it('its Docker sandbox (L1.8) is environment sandbox-docker: the fixture image on 4511–4514, a real Mailpit on 4525, the same accounts', async () => {
    const project = await loadProject('northfield-fixture', ROOT);
    const sandbox = project.sandboxes?.['sandbox-docker'];
    expect(sandbox?.issues).toEqual([]);
    expect(sandbox?.manifest).toMatchObject({ provider: 'docker-compose', compose: { files: ['compose.yaml'] }, services: { fixture: { url: 'http://localhost:4511', health: '/api/health' } } });
    expect(project.config.environments['sandbox-docker']).toEqual({ console: 'http://localhost:4513', shop: 'http://localhost:4514' });
    expect(project.config.environment_settings?.['sandbox-docker']).toMatchObject({
      display: { console: 'https://console.northfield.example', shop: 'https://shop.northfield.example' },
      sandbox: { provider: 'docker-compose' },
      mailbox: { provider: 'mailpit', url: 'http://localhost:4525' },
    });
    // The compose file publishes every port of the manifest (and Mailpit's) on 127.0.0.1 only, builds the fixture
    // from fixtures/wholesale and relays its mails to Mailpit, pinned to an exact version.
    const compose = parse(await readFile(new URL('../../../projects/northfield-fixture/sandbox/docker/compose.yaml', import.meta.url), 'utf8')) as {
      services: Record<string, { build?: string; image?: string; init?: boolean; ports: string[]; environment: Record<string, string> }>;
    };
    expect(compose.services.fixture).toMatchObject({ build: '../../../../fixtures/wholesale', init: true, environment: { NORTHFIELD_SMTP: 'mailpit:1025', NORTHFIELD_CONSOLE_PORT: '4511' } });
    expect(compose.services.fixture.image).toBeUndefined();
    expect(compose.services.mailpit.image).toBe('axllent/mailpit:v1.29.4');
    expect(Object.values(compose.services).flatMap((s) => s.ports)).toEqual(['127.0.0.1:4511:4511', '127.0.0.1:4512:4512', '127.0.0.1:4513:4513', '127.0.0.1:4514:4514', '127.0.0.1:4525:8025']);
    const personas = resolvePersonas(project, 'sandbox-docker', { home: '/nonexistent-home' });
    expect(personas.map((p) => [p.name, p.pages, p.sandbox])).toEqual([
      ['supplier', ['console'], true],
      ['buyer', ['shop'], true],
    ]);
    // sandbox-quote and signup (wait_for_email through Mailpit) validate on it; neither needs the quote PDF.
    for (const name of ['sandbox-quote', 'signup']) {
      const { issues, text } = await loadScenario(project, name, { files: fileFacts(PERSON_POLICY), env: 'sandbox-docker' });
      expect(errorsOf(issues), name).toEqual([]);
      expect(text, name).not.toMatch(/quote\.pdf|download/);
    }
  });

  it('the quote scenario shows the phase-2 syntax: a card entry and a step overlay with a target', async () => {
    const project = await loadProject('northfield-fixture', ROOT);
    const { scenario } = await loadScenario(project, 'quote', { files: fileFacts(PERSON_POLICY) });
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
