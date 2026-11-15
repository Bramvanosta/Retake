/**
 * The menu's page commands by what they open (menu-commands.ts runs them, native-menu.ts says when they can): the
 * Script mode's views, the project's pages, the scenario's pages.
 */
import type { MenuCommand } from '../ui-kit/index.js';
import type { Route, ScenarioTab } from '../route.js';
import type { ScenarioContext } from './modes.js';

/** The Script mode's views (Board · Hooks · YAML). */
export const VIEW_COMMAND: Record<ScenarioTab, MenuCommand> = { blocks: 'view-board', hooks: 'view-hooks', yaml: 'view-yaml' };
/** The Go menu's project pages. */
export const PROJECT_PAGE: Partial<Record<MenuCommand, (slug: string) => Route>> = {
  'new-scenario': (slug) => ({ name: 'record', slug }),
  'go-productions': (slug) => ({ name: 'project', slug }),
  'go-cast': (slug) => ({ name: 'cast', slug }),
  'go-settings': (slug) => ({ name: 'settings', slug }),
  'go-readme': (slug) => ({ name: 'readme', slug }),
  'go-library': (slug) => ({ name: 'library', slug }),
  'go-themes': (slug) => ({ name: 'themes', slug }),
};
/** The Go menu's scenario pages. */
export const SCENARIO_PAGE: Partial<Record<MenuCommand, (c: ScenarioContext) => Route>> = {
  'go-report': (c) => ({ name: 'review', slug: c.slug, scenario: c.scenario }),
  'go-comments': (c) => ({ name: 'comments', slug: c.slug, scenario: c.scenario }),
};

/** Whether a menu command is one of the project's pages (it needs a project open). */
export function isProjectPage(id: MenuCommand): boolean {
  return id in PROJECT_PAGE;
}
/** Whether a menu command is one of the scenario's pages or views (it needs a scenario in context). */
export function isScenarioPage(id: MenuCommand): boolean {
  return id in SCENARIO_PAGE || (Object.values(VIEW_COMMAND) as MenuCommand[]).includes(id);
}
