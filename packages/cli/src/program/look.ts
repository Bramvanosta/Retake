import { Option } from 'commander';
import { COMPONENT_KINDS } from '@retake/core/model';
import { componentsCreateCommand, componentsListCommand, componentsPreviewCommand, componentsValidateCommand } from '../commands/components.js';
import type { ComponentsCreateOptions, ComponentsListOptions, ComponentsPreviewOptions, ComponentsValidateOptions } from '../commands/components.js';
import { themeCreateCommand, themeFetchFontCommand, themeFromSiteCommand, themeFromTokensCommand, themeListCommand } from '../commands/theme.js';
import type { ThemeCreateOptions } from '../commands/theme.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';

/** Components and themes: components, theme. */
export function registerLookCommands({ program, action }: ProgramContext): void {
  const components = program.command('components').description('list, validate, scaffold and preview components (intros, layouts, captions…)');
  components
    .command('list')
    .description("components of the workspace (components/) and the built-in library; with --project, the project's own (projects/<slug>/components/) first")
    .addOption(new Option('--kind <kind>', 'only this kind').choices([...COMPONENT_KINDS]))
    .option('--project <slug>', "list this project's own components first, as its renders resolve them")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ComponentsListOptions) => componentsListCommand(u, g, o)));
  components
    .command('validate')
    .description('check a component: manifest, params schema, preview samples, entry compile and imports (every workspace component when omitted)')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--project <slug>', "the project's own component of that id first (none named: its own components too)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsValidateOptions) => componentsValidateCommand(u, g, id, o)));
  components
    .command('create')
    .alias('new')
    .description(
      "scaffold a workspace component (components/<namespace>/<name>/) — or a project's own with --project (projects/<slug>/components/<namespace>/<name>/) — from the scaffold of its kind (alias: new)",
    )
    .argument('<id>', 'component id "namespace/name" (lower-case letters, digits and "-")')
    .addOption(new Option('--kind <kind>', 'what it renders').choices([...COMPONENT_KINDS]).makeOptionMandatory())
    .option('--description <text>', 'one or two sentences: what it looks like and when to use it')
    .option('--name <name>', 'display name (default: from the id)')
    .option('--theme <name>', 'theme of the generated preview (default editorial)')
    .option('--project <slug>', "make it in this project's own components folder (used by its renders only)")
    .option('--no-preview', 'do not render preview.png')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: ComponentsCreateOptions) => componentsCreateCommand(u, g, id, o)));
  components
    .command('preview')
    .description('render preview.png (960×540) + preview.json + the README block of a component, or of every component with --all')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--all', 'every component: workspace, built-in library and the per-kind scaffolds')
    .option('--workspace', "with --all: only the workspace components (and the project's own with --project)")
    .option('--project <slug>', "the project's own components first, and its own theme of --theme's name")
    .option('--stale', 'only previews that are missing or out of date')
    .option('--theme <name>', 'theme of the previews (a theme name or path; default editorial)')
    .option('--out <dir>', 'write only the images to <dir>/<namespace>/<name>.png (component folders untouched)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsPreviewOptions) => componentsPreviewCommand(u, g, id, o)));

  registerThemeCommands({ program, action } as ProgramContext);
}

/** Themes: theme list, create, from-site, from-tokens, fetch-font. */
function registerThemeCommands({ program, action }: ProgramContext): void {
  const theme = program.command('theme').description("themes: a project's own (projects/<slug>/templates/<name>/), the workspace's (templates/<name>/), made from brand files or a site");
  theme
    .command('list')
    .description(
      "the themes a render can name, each with its origin: with --project, the project's own first (a name of the project's hides the workspace's theme or the starter of that name), then the workspace's and the starters",
    )
    .option('--project <slug>', "list this project's own themes first and mark its theme")
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: { project?: string; json?: boolean }) => themeListCommand(u, g, o)));
  theme
    .command('create')
    .description(
      "a new theme from a logo, hex colours and fonts over a base theme — the project's own with --project (projects/<slug>/templates/<name>/), else a workspace theme (templates/<name>/): palette derived and contrast-checked, files checked and copied, LICENSES.md; never an existing theme (except --replace of an unchanged one Retake made)",
    )
    .argument('<name>', 'new theme name: lower-case letters, digits and "-", not a starter\'s or an existing folder\'s')
    .requiredOption('--accent <hex>', 'brand colour (#rrggbb): kicker, rules, clock hand, cursor ripple — never changed')
    .requiredOption('--logo <file>', 'logo: .svg, .png, .jpg or .webp')
    .option('--text <hex>', 'text colour (default derived)')
    .option('--paper <hex>', 'paper colour (default derived; a dark paper makes a dark theme)')
    .option('--muted <hex>', 'muted colour (default derived)')
    .option('--dark <hex>', 'night tone of dark cards and interstitials (default derived)')
    .option('--background <spec>', 'a hex (solid) or radial:<from>:<to> / linear:<from>:<to> (default derived)')
    .option('--base <theme>', 'theme whose components, frame, captions and motion are kept (default editorial)')
    .option('--wordmark <file>', 'wordmark image of the outro (default: the brand name as text)')
    .option('--display-font <file>', "display font: .ttf, .otf, .woff or .woff2, or fontsource:<id>[@<version>][:<weight>[italic]] fetched with `retake theme fetch-font` (default the base theme's)")
    .option('--body-font <file>', "body font file or fontsource: ref, one per weight (repeatable; default the base theme's)", collect)
    .option('--brand-name <name>', 'brand name (drawn when there is no wordmark)')
    .option('--brand-url <url>', 'brand URL shown in the outro, e.g. example.com')
    .option('--logo-kind <kind>', 'mark (the brand name drawn beside it) or wordmark (the name itself: drawn alone); default wordmark for a logo 3:1 and wider')
    .option('--cursor <style>', "filmed cursor: arrow-dark or arrow-light (default the base theme's; the palette's tone when it differs)")
    .option('--cursor-size <px>', "cursor size in px, 12 to 64 (default the base theme's)")
    .option('--component <kind>=<id>', "a kind's component, e.g. outro=studio/outro-minimal (repeatable; default the base theme's)", collect)
    .option('--param <kind>.<name>=<value>', "a component param merged over the base theme's, e.g. outro.logo_size=72 (repeatable; the value is JSON or text)", collect)
    .option('--no-adjust', 'keep colours that miss a contrast threshold (warnings only)')
    .option('--replace', 'replace a theme Retake made under that name (this command or template_create_from_brand), when nobody changed it since')
    .option(
      '--project <slug>',
      "make it the project's own theme; its brand files are looked for in the project folder first (brand/logo.svg: the project's, else the workspace's; ./ or an absolute path: as typed)",
    )
    .option('--json', 'machine-readable output')
    .action(action((u, g, n: string, o: ThemeCreateOptions) => themeCreateCommand(u, g, n, o)));
  theme
    .command('from-site')
    .description(
      'open one public https page in a clean headless browser (no profile, GET only, public addresses only) and extract its colours by role, font family names, logo candidates (PNG) and a screenshot into .retake/site/<id>/, with a draft for `retake theme create`',
    )
    .argument('<url>', 'https://<site>/<path>: default port, no query or fragment')
    .option('--json', 'machine-readable output')
    .action(action((u, g, url: string, o: { json?: boolean }) => themeFromSiteCommand(u, g, url, o)));
  theme
    .command('from-tokens')
    .description(
      "read a design-token file (a list format or DTCG JSON) and propose the theme's colour roles (accent, paper, text, muted, dark) by token name, then by colour, with a draft for `retake theme create` — nothing is written",
    )
    .argument('<file>', 'the token file: .json or .tokens, at most 1 MB')
    .option('--map <role>=<token>', 'pick a token for a role, e.g. accent=color.brand.primary (repeatable)', collect)
    .option('--base <theme>', 'base theme of the draft (default motion for a dark paper, else editorial)')
    .option('--name <name>', "the draft's theme name (default from the file's name)")
    .option('--json', 'machine-readable output')
    .action(action((u, g, file: string, o: { map?: string[]; base?: string; name?: string; json?: boolean }) => themeFromTokensCommand(u, g, file, o)));
  theme
    .command('fetch-font')
    .description(
      "download open-licence fonts — fontsource packages, from https://registry.npmjs.org only — into the workspace's font store (.retake/fonts/): the licence must be OFL-1.1 or Apache-2.0 as the publisher declares it, the archive must match the registry's integrity, and only the latin WOFF2 files of the faces asked and the LICENSE are kept; a theme then names them as fontsource:<id>@<version>:<weight>",
    )
    .argument('<refs...>', 'fontsource:<id>[@<version>][:<weight>[italic]], one per face (default weight 400; no version: the latest, resolved and recorded)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, refs: string[], o: { json?: boolean }) => themeFetchFontCommand(u, g, refs, o)));
}
