import { printableText } from '@retake/core/base';
import { resolve } from 'node:path';
import { EngineError, createEngine } from '@retake/engine';
import { createThemeFromBrand, extractSiteForAuthor, fetchFonts, personScope, tokensDraft } from '@retake/engine/shell';
import type { FontFetched, SiteJobResult, TemplateListView, TemplateSummary, ThemeCreated, TokensDraft } from '@retake/engine';
import { CliError, EXIT, UsageError } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openWorkspace, workspaceQueue } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface ThemeCreateOptions {
  accent: string;
  text?: string;
  paper?: string;
  muted?: string;
  dark?: string;
  background?: string;
  base?: string;
  logo: string;
  wordmark?: string;
  displayFont?: string;
  bodyFont?: string[];
  brandName?: string;
  brandUrl?: string;
  logoKind?: string;
  cursor?: string;
  cursorSize?: string;
  component?: string[];
  param?: string[];
  adjust?: boolean;
  replace?: boolean;
  /** The project whose own theme it is (projects/<slug>/templates/<name>/; its brand files looked for there first). */
  project?: string;
  json?: boolean;
}

/** `--background #hex` (solid) or `radial:#from:#to` / `linear:#from:#to`. */
function background(v: string): unknown {
  const m = /^(radial|linear):(#[0-9a-f]{3,6}):(#[0-9a-f]{3,6})$/i.exec(v);
  if (m) return { type: m[1].toLowerCase(), from: m[2], to: m[3] };
  if (/^#/.test(v)) return v;
  throw new UsageError(`--background ${v}: a hex colour (#f8f4ef) or radial:<from>:<to> / linear:<from>:<to>`);
}

/** `--cursor-size <px>`: a number from 12 to 64, said plainly when it is not (the schema's words would be zod's). */
export function cursorSizeOption(v: string): number {
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n) || n < 12 || n > 64) throw new UsageError(`--cursor-size ${v}: a cursor size in px, a number from 12 to 64 (e.g. 30)`);
  return n;
}

const KINDS = ['intro', 'outro', 'card', 'interstitial', 'caption', 'layout', 'overlay', 'transition'];

/**
 * `--component <kind>=<id>` and `--param <kind>.<name>=<json>` (each repeatable) → the brand input's `components`
 * (a param value is JSON — 72, true, "left" — else taken as text); the engine checks ids and params against the
 * registry.
 */
export function componentsOption(components: readonly string[] = [], params: readonly string[] = []): Record<string, { id?: string; params?: Record<string, unknown> }> | undefined {
  const out: Record<string, { id?: string; params?: Record<string, unknown> }> = {};
  const entry = (kind: string, flag: string) => {
    if (!KINDS.includes(kind)) throw new UsageError(`${flag}: ${kind} is not a component kind (${KINDS.join(', ')})`);
    out[kind] ??= {};
    return out[kind];
  };
  for (const c of components) {
    const m = /^([a-z]+)=(.+)$/.exec(c);
    if (!m) throw new UsageError(`--component ${c}: <kind>=<namespace/name>, e.g. outro=studio/outro-minimal`);
    entry(m[1], '--component').id = m[2];
  }
  for (const p of params) {
    const m = /^([a-z]+)\.([A-Za-z0-9_-]+)=(.*)$/s.exec(p);
    if (!m) throw new UsageError(`--param ${p}: <kind>.<name>=<value>, e.g. outro.logo_size=72`);
    let value: unknown;
    try {
      value = JSON.parse(m[3]);
    } catch {
      value = m[3];
    }
    const e = entry(m[1], '--param');
    e.params = { ...(e.params ?? {}), [m[2]]: value };
  }
  return Object.keys(out).length ? out : undefined;
}

function printCreated(ui: Ui, c: ThemeCreated): void {
  const k = ui.c;
  ui.ok(`${c.replaced ? 'replaced' : 'created'} theme ${k.bold(c.name)} over ${c.base} (${c.palette.tone}) in ${ui.path(c.dir)}`);
  ui.line(k.dim(`  files: ${c.files.join(', ')}`));
  ui.line(
    `  colours: ${Object.entries(c.palette.colors)
      .map(([n, v]) => `${n} ${v}`)
      .join(', ')}`,
  );
  ui.line(`  contrast: ${c.palette.checks.map((x) => `${x.check} ${x.ratio}${x.ok ? '' : ` (< ${x.min})`}`).join(', ')}`);
  for (const a of c.palette.adjusted) ui.line(`  adjusted ${a.key}${a.given ? ' (given)' : ''} ${a.from} → ${a.to} (${a.check} ${a.ratio_before} → ${a.ratio_after})`);
  if (c.palette.suggestions.accent) ui.line(`  suggested accent (not applied): ${c.palette.suggestions.accent}`);
  ui.line(`  fonts: ${c.fonts.map((f) => `${f.file} (${f.role} ${Array.isArray(f.weight) ? f.weight.join('–') : f.weight}${f.italic ? ' italic' : ''})`).join(', ')}`);
  for (const f of c.untrusted.fonts) ui.line(k.dim(`  ${f.file}: ${f.family ?? '?'}${f.licence_url ? `, ${f.licence_url}` : ''}`));
  for (const n of c.notes ?? []) ui.line(`  note: ${n}`);
  for (const w of c.warnings) ui.warn(w);
  ui.line(`next: ${k.bold(`retake render <project> <scenario> --theme ${c.name}`)} (or template_preview through MCP); change it with --replace while nobody edited it`);
}

/** `retake theme create <name> --accent <hex> --logo <file> [--project <slug>] …`: a new theme from brand files (trust author), the project's own with --project. */
export async function themeCreateCommand(ui: Ui, global: GlobalOptions, name: string, opts: ThemeCreateOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const components = componentsOption(opts.component, opts.param);
  const input = {
    name,
    ...(opts.base ? { base: opts.base } : {}),
    colors: {
      accent: opts.accent,
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.paper ? { paper: opts.paper } : {}),
      ...(opts.muted ? { muted: opts.muted } : {}),
      ...(opts.dark ? { dark: opts.dark } : {}),
    },
    ...(opts.background ? { background: background(opts.background) } : {}),
    ...(opts.adjust === false ? { adjust: false } : {}),
    logo: opts.logo,
    ...(opts.wordmark ? { wordmark: opts.wordmark } : {}),
    ...(opts.displayFont || opts.bodyFont?.length ? { fonts: { ...(opts.displayFont ? { display: opts.displayFont } : {}), ...(opts.bodyFont?.length ? { body: opts.bodyFont } : {}) } } : {}),
    ...(opts.brandName || opts.brandUrl ? { brand: { ...(opts.brandName ? { name: opts.brandName } : {}), ...(opts.brandUrl ? { url: opts.brandUrl } : {}) } } : {}),
    ...(opts.logoKind ? { logo_kind: opts.logoKind } : {}),
    ...(opts.cursor || opts.cursorSize !== undefined
      ? { cursor: { ...(opts.cursor ? { style: opts.cursor } : {}), ...(opts.cursorSize !== undefined ? { size: cursorSizeOption(opts.cursorSize) } : {}) } }
      : {}),
    ...(components ? { components } : {}),
    ...(opts.replace ? { replace: true } : {}),
    ...(opts.project ? { project: opts.project } : {}),
  };
  let created: ThemeCreated;
  try {
    created = await createThemeFromBrand(ws, input, { trust: 'author', cwd: process.cwd(), scope: personScope(ws.root, global.ports) });
  } catch (e) {
    if (e instanceof EngineError) throw new CliError(`${e.message}${e.fix ? `\n  fix: ${e.fix}` : ''}`);
    throw e;
  }
  if (opts.json) {
    ui.result(JSON.stringify(created, null, 2));
    return EXIT.ok;
  }
  printCreated(ui, created);
  return EXIT.ok;
}

function printSite(ui: Ui, r: SiteJobResult): void {
  const k = ui.c;
  if (r.status !== 'ok') {
    ui.warn(`the page of ${r.host} could not be read: ${printableText(String(r.untrusted.error ?? 'unknown error'))}`);
  } else {
    ui.ok(`read ${k.bold(r.url)} into ${ui.path(r.dir)} (site id ${r.site_id})`);
  }
  if (r.palette) {
    const roles = r.palette.roles;
    ui.line(`  roles: paper ${roles.paper}, text ${roles.text}, accent ${roles.accent ?? 'none found'}, dark ${roles.dark ?? 'none found'}`);
    ui.line(`  swatches: ${r.palette.swatches.map((s) => `${s.hex} (${Math.round(Math.max(s.background, s.text, s.interactive) * 100)} %)`).join(', ')}`);
  }
  const fonts = r.untrusted.fonts as { display?: Array<{ family: string }>; body?: Array<{ family: string }> } | undefined;
  // Page strings: printable only (no control or bidirectional character reaches the terminal).
  const names = (l?: Array<{ family: string }>) => l?.map((f) => printableText(String(f.family))).join(', ') || '—';
  if (fonts) ui.line(k.dim(`  fonts seen (names from the page): display ${names(fonts.display)}; body ${names(fonts.body)} — give the font files yourself (--display-font / --body-font)`));
  for (const c of r.candidates) ui.line(`  logo candidate ${c.ref}: ${c.file} (${c.width}×${c.height}, ${c.source})`);
  if (r.screenshot) ui.line(`  screenshot: ${ui.path(r.screenshot)}`);
  const blocked = Object.entries(r.network.blocked)
    .map(([why, n]) => `${n} ${why}`)
    .join(', ');
  const refused = Object.entries(r.network.refused)
    .map(([why, n]) => `${n} ${why}`)
    .join(', ');
  ui.line(
    k.dim(
      `  network: ${r.network.requests} requests, ${r.network.tunnels} connections, ${Math.round(r.network.bytes / 1024)} KB${blocked ? `; blocked: ${blocked}` : ''}${refused ? `; refused connections: ${refused}` : ''}`,
    ),
  );
  for (const w of r.warnings) ui.warn(w);
  if (r.draft) {
    const d = r.draft.brand_input as { name: string; base: string; colors: Record<string, string>; logo?: string; brand?: { url?: string } };
    const c = d.colors;
    ui.line(
      `next: ${k.bold(
        `retake theme create ${d.name} --base ${d.base} --accent '${c.accent}' --text '${c.text}' --paper '${c.paper}'${c.dark ? ` --dark '${c.dark}'` : ''} --logo ${d.logo ?? '<file>'}${d.brand?.url ? ` --brand-url ${d.brand.url}` : ''}`,
      )} (change any value; check the logo first)`,
    );
  }
}

/** `retake theme from-site <url>`: a site extraction in-process (trust author: no approval, the same network rules). */
export async function themeFromSiteCommand(ui: Ui, global: GlobalOptions, url: string, opts: { json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  let r: SiteJobResult;
  try {
    r = await extractSiteForAuthor(ws, url, { queue: workspaceQueue(ws, global.ports), clock: global.ports.clock, capture: global.ports.capture, hosts: global.ports.hosts });
  } catch (e) {
    if (e instanceof EngineError) throw new CliError(`${e.message}${e.fix ? `\n  fix: ${e.fix}` : ''}`);
    throw e;
  }
  if (opts.json) {
    ui.result(JSON.stringify(r, null, 2));
    return r.status === 'ok' ? EXIT.ok : EXIT.failure;
  }
  printSite(ui, r);
  return r.status === 'ok' ? EXIT.ok : EXIT.failure;
}

/** An engine error as the CLI's own (its fix on the next line). */
function cliError(e: unknown): unknown {
  return e instanceof EngineError ? new CliError(`${e.message}${e.fix ? `\n  fix: ${e.fix}` : ''}`) : e;
}

/**
 * `retake theme fetch-font <ref>…`: open-licence fonts (fontsource packages) from the npm registry into the workspace's
 * font store — the person's own act (no form), under the same checks as font_fetch (engine brand/fontsource-fetch.ts).
 */
export async function themeFetchFontCommand(ui: Ui, global: GlobalOptions, refs: string[], opts: { json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  let f: FontFetched;
  try {
    f = await fetchFonts(ws, { refs }, { registry: global.ports.fontRegistry, clock: global.ports.clock, ask: false });
  } catch (e) {
    throw cliError(e);
  }
  if (opts.json) {
    ui.result(JSON.stringify(f, null, 2));
    return EXIT.ok;
  }
  const k = ui.c;
  for (const p of f.packages) {
    ui.ok(
      `${p.downloaded ? 'fetched' : 'stored already:'} ${k.bold(`${p.package} ${p.version}`)} (${p.licence}, as its publisher declares it) from ${p.registry}${p.test_registry ? ' (a TEST registry)' : ''} into ${p.dir}`,
    );
    ui.line(k.dim(`  integrity ${p.integrity}`));
    for (const x of p.faces) ui.line(`  ${x.ref} (${x.state})`);
  }
  for (const w of f.warnings) ui.warn(w);
  ui.line(`next: ${k.bold(`retake theme create <name> --accent <hex> --logo <file> --display-font ${f.refs[0]}`)} (or --body-font, once per face)`);
  return EXIT.ok;
}

function printTokens(ui: Ui, t: TokensDraft): void {
  const k = ui.c;
  ui.ok(`read ${t.file} (${t.format === 'dtcg' ? 'DTCG' : 'list'} format): ${t.counts.tokens} tokens, ${t.counts.colours} colours, ${t.counts.families} font families — nothing written`);
  // Token names are the file's text: printable only, dimmed (no control or bidirectional character reaches the terminal).
  const name = (i: number) => printableText(t.untrusted.colours[i]?.name ?? '?');
  for (const [role, v] of Object.entries(t.roles)) {
    ui.line(`  ${role}: ${v.hex} — ${k.dim(name(v.index))} (by ${v.why}${v.contrast_on_paper !== undefined ? `, ${v.contrast_on_paper}:1 on the paper` : ''})`);
  }
  if (t.palette) ui.line(`  contrast: ${t.palette.checks.map((x) => `${x.check} ${x.ratio}${x.ok ? '' : ` (< ${x.min})`}`).join(', ')}`);
  for (const f of t.untrusted.families) ui.line(k.dim(`  font family: ${printableText(f.family)} (${printableText(f.name)})`));
  for (const n of t.notes) ui.line(`  note: ${n}`);
  const d = t.draft?.brand_input as { name: string; base: string; colors: Record<string, string> } | undefined;
  if (d) {
    const flags = Object.entries(d.colors)
      .map(([r, v]) => `--${r} '${v}'`)
      .join(' ');
    ui.line(`next: ${k.bold(`retake theme create ${d.name} --base ${d.base} ${flags} --logo <file>`)} (change any value; --map <role>=<token> picks another token)`);
  }
}

/** `--map <role>=<token>` (repeatable) → the input's map. */
export function mapOption(values: readonly string[] = []): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of values) {
    const m = /^(accent|paper|text|muted|dark)=(.+)$/s.exec(v);
    if (!m) throw new UsageError(`--map ${v}: <role>=<token name>, the role one of accent, paper, text, muted, dark (e.g. accent=color.brand.primary)`);
    out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : undefined;
}

/** `retake theme from-tokens <file>`: a design-token file read into proposed roles and a draft (trust author; nothing written). */
export async function themeFromTokensCommand(ui: Ui, global: GlobalOptions, file: string, opts: { map?: string[]; base?: string; name?: string; json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const map = mapOption(opts.map);
  let t: TokensDraft;
  try {
    t = await tokensDraft(
      ws,
      { tokens: file, ...(map ? { map } : {}), ...(opts.base ? { base: opts.base } : {}), ...(opts.name ? { name: opts.name } : {}) },
      { trust: 'author', clock: global.ports.clock, cwd: process.cwd() },
    );
  } catch (e) {
    // A --map name the file lacks: its nearest token names (the file's text: printable only, said to be the file's).
    const near = e instanceof EngineError ? (e.details?.untrusted as { near?: unknown } | undefined)?.near : undefined;
    if (e instanceof EngineError && Array.isArray(near)) {
      const names = near.filter((n): n is string => typeof n === 'string').map((n) => printableText(n));
      if (opts.json) {
        ui.result(JSON.stringify({ error: { code: e.code, message: e.message, untrusted: { near: names } } }, null, 2));
        return EXIT.failure;
      }
      throw new CliError(`${e.message}\n  nearest token names (from the file): ${names.join(', ') || 'none'}`);
    }
    throw cliError(e);
  }
  if (opts.json) {
    ui.result(JSON.stringify(t, null, 2));
    return EXIT.ok;
  }
  printTokens(ui, t);
  return EXIT.ok;
}

/** One row of `retake theme list`: name, origin (and what it hides), the project's default. */
function themeRow(ui: Ui, t: TemplateSummary): string {
  const k = ui.c;
  const origin = t.by_path ? 'project, by its path' : t.shadows ? `${t.source}, instead of the ${t.shadows === 'workspace' ? "workspace's" : 'starter'}` : t.source;
  return `  ${k.bold(t.name)} ${k.dim(`(${origin})`)}${t.default ? " — the project's theme" : ''}${t.issues.length ? ` ${k.red(`— ${t.issues[0]}`)}` : ''}`;
}

/** `retake theme list [--project <slug>] [--json]`: the themes a render can name, each with its origin (template_list). */
export async function themeListCommand(ui: Ui, global: GlobalOptions, opts: { project?: string; json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const engine = await createEngine({ root: resolve(ws.root), client: 'cli', autoStartWorker: false, ports: global.ports });
  let v: TemplateListView;
  try {
    v = await engine.templates.list(opts.project !== undefined ? { project: opts.project } : {});
  } catch (e) {
    if (e instanceof EngineError) throw new CliError(e.message);
    throw e;
  }
  if (opts.json) {
    ui.result(JSON.stringify(v, null, 2));
    return EXIT.ok;
  }
  const k = ui.c;
  if (v.project_templates_dir !== undefined) ui.result(`${k.bold('Themes')} ${k.dim(`${ui.path(v.project_templates_dir)}, then ${ui.path(v.templates_dir)}, then the starters`)}`);
  else ui.result(`${k.bold('Themes')} ${k.dim(`${ui.path(v.templates_dir)}, then the starters`)}`);
  for (const t of v.templates) ui.result(themeRow(ui, t));
  for (const n of v.notices ?? []) ui.line(k.dim(`  note: ${n}`));
  return EXIT.ok;
}
