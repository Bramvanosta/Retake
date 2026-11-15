import { printableText } from '@retake/core/base';
import { EngineError } from '@retake/engine';
import { createThemeFromBrand, extractSiteForAuthor, personScope } from '@retake/engine/shell';
import type { SiteJobResult, ThemeCreated } from '@retake/engine';
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

/** `retake theme create <name> --accent <hex> --logo <file> …`: a new workspace theme from brand files (trust author). */
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
