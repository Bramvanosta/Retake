/**
 * L5.12c « Épure » 4c: the browser pane on the Library and the Themes list (R4-Library's left pane) — back to the
 * Productions, the Library group (Components, Themes) and each theme of the project with where it comes from in words:
 * on the Library a theme row shows the components in that theme (the title bar's Theme select does the same), on the
 * Themes list it opens the theme's editor (a theme with no editor — a project folder's — is listed in the centre only).
 * Theme names are text (`Txt`).
 */
import { Txt } from './bits.js';
import type { Route } from './route.js';
import { ShellSlot } from './shell/slots.js';
import { SourceList } from './ui-kit/index.js';
import type { SourceItem } from './ui-kit/index.js';

export interface BrowserTheme {
  name: string;
  source: 'starter' | 'workspace' | 'project';
  /** The project's theme (project.yaml names it). */
  default: boolean;
  /** It opens somewhere (a project-folder theme has no editor; a name off the rules has no address). */
  opens: boolean;
}

const FROM: Record<BrowserTheme['source'], string> = { starter: 'Starter', workspace: 'Workspace', project: 'Project folder' };

export function LibraryBrowser({ slug, at, themes, current, components }: { slug: string; at: 'library' | 'themes'; themes: BrowserTheme[]; current?: string; components?: number }) {
  const themeRows: SourceItem[] = themes.filter((t) => t.opens).map((t) => ({
    key: `t-${t.source}-${t.name}`,
    label: <Txt text={t.name} />,
    current: t.name === current,
    icon: 'theme',
    flag: t.default ? "Project's" : FROM[t.source],
    to: (at === 'library' ? { name: 'library', slug, theme: t.name } : { name: 'themes', slug, theme: t.name }) as Route,
  }));
  return (
    <ShellSlot name="browser">
      <SourceList
        label="Library"
        groups={[
          { key: 'back', items: [{ key: 'productions', to: { name: 'project', slug }, label: 'Productions', icon: 'film', current: false }] },
          {
            key: 'library',
            heading: 'Library',
            label: 'Library',
            items: [
              { key: 'components', to: { name: 'library', slug }, label: 'Components', icon: 'components', current: at === 'library', testId: 'library-link', ...(components !== undefined ? { count: components } : {}) },
              { key: 'themes', to: { name: 'themes', slug }, label: 'Themes', icon: 'theme', current: at === 'themes' && current === undefined, count: themes.length },
            ],
          },
          { key: 'themes', heading: 'Themes', label: 'Themes of this project', items: themeRows },
        ]}
      />
    </ShellSlot>
  );
}
