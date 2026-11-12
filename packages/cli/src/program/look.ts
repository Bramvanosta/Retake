import { Option } from 'commander';
import { COMPONENT_KINDS } from '@retake/core';
import { componentsCreateCommand, componentsListCommand, componentsPreviewCommand, componentsValidateCommand } from '../commands/components.js';
import type { ComponentsCreateOptions, ComponentsListOptions, ComponentsPreviewOptions, ComponentsValidateOptions } from '../commands/components.js';
import { themeCreateCommand, themeFromSiteCommand } from '../commands/theme.js';
import type { ThemeCreateOptions } from '../commands/theme.js';
import { collect } from './context.js';
import type { ProgramContext } from './context.js';

/** Components and themes: components, theme. */
export function registerLookCommands({ program, action }: ProgramContext): void {
  const components = program.command('components').description('list, validate, scaffold and preview components (intros, layouts, captions…)');
  components
    .command('list')
    .description('components of the workspace (components/) and the built-in library')
    .addOption(new Option('--kind <kind>', 'only this kind').choices([...COMPONENT_KINDS]))
    .option('--json', 'machine-readable output')
    .action(action((u, g, o: ComponentsListOptions) => componentsListCommand(u, g, o)));
  components
    .command('validate')
    .description('check a component: manifest, params schema, preview samples, entry compile and imports (every workspace component when omitted)')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsValidateOptions) => componentsValidateCommand(u, g, id, o)));
  components
    .command('create')
    .alias('new')
    .description('scaffold a workspace component (components/<namespace>/<name>/) from the scaffold of its kind (alias: new)')
    .argument('<id>', 'component id "namespace/name" (lower-case letters, digits and "-")')
    .addOption(new Option('--kind <kind>', 'what it renders').choices([...COMPONENT_KINDS]).makeOptionMandatory())
    .option('--description <text>', 'one or two sentences: what it looks like and when to use it')
    .option('--name <name>', 'display name (default: from the id)')
    .option('--theme <name>', 'theme of the generated preview (default editorial)')
    .option('--no-preview', 'do not render preview.png')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string, o: ComponentsCreateOptions) => componentsCreateCommand(u, g, id, o)));
  components
    .command('preview')
    .description('render preview.png (960×540) + preview.json + the README block of a component, or of every component with --all')
    .argument('[component]', 'component id (namespace/name) or folder')
    .option('--all', 'every component: workspace, built-in library and the per-kind scaffolds')
    .option('--workspace', 'with --all: only the workspace components')
    .option('--stale', 'only previews that are missing or out of date')
    .option('--theme <name>', 'theme of the previews (a theme name or path; default editorial)')
    .option('--out <dir>', 'write only the images to <dir>/<namespace>/<name>.png (component folders untouched)')
    .option('--json', 'machine-readable output')
    .action(action((u, g, id: string | undefined, o: ComponentsPreviewOptions) => componentsPreviewCommand(u, g, id, o)));

  const theme = program.command('theme').description('workspace themes (templates/<name>/) from brand files or a site');
  theme
    .command('create')
    .description('a new workspace theme (templates/<name>/) from a logo, hex colours and fonts over a base theme: palette derived and contrast-checked, files checked and copied, LICENSES.md; never an existing theme (except --replace of an unchanged one Retake made)')
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
    .option('--display-font <file>', 'display font: .ttf, .otf, .woff or .woff2 (default the base theme\'s)')
    .option('--body-font <file>', 'body font file, one per weight (repeatable; default the base theme\'s)', collect)
    .option('--brand-name <name>', 'brand name (drawn when there is no wordmark)')
    .option('--brand-url <url>', 'brand URL shown in the outro, e.g. example.com')
    .option('--no-adjust', 'keep colours that miss a contrast threshold (warnings only)')
    .option('--replace', 'replace a theme Retake made under that name (this command or template_create_from_brand), when nobody changed it since')
    .option('--json', 'machine-readable output')
    .action(action((u, g, n: string, o: ThemeCreateOptions) => themeCreateCommand(u, g, n, o)));
  theme
    .command('from-site')
    .description('open one public https page in a clean headless browser (no profile, GET only, public addresses only) and extract its colours by role, font family names, logo candidates (PNG) and a screenshot into .retake/site/<id>/, with a draft for `retake theme create`')
    .argument('<url>', 'https://<site>/<path>: default port, no query or fragment')
    .option('--json', 'machine-readable output')
    .action(action((u, g, url: string, o: { json?: boolean }) => themeFromSiteCommand(u, g, url, o)));
}
