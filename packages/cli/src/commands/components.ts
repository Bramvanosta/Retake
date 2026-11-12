import { join, resolve } from 'node:path';
import { errorsOf, warningsOf } from '@retake/core';
import { bundleInfo } from '@retake/core/io';
import type { ComponentKind } from '@retake/core';
import {
  componentCreateShell,
  componentListEntries,
  componentPreviewTargets,
  componentPreviewTheme,
  componentReadmeWriter,
  componentValidateShell,
  editorRenderer,
  personScope,
  previewsWork,
} from '@retake/engine';
import type { ComponentEntry, ComponentRef, OpenedWorkspace, RegistryNoticeView } from '@retake/engine';
import { CliError, EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural, truncate } from '../ui.js';
import { cliPorts, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface ComponentsListOptions {
  kind?: ComponentKind;
  json?: boolean;
}

function info(c: ComponentEntry) {
  const m = c.manifest;
  return {
    id: c.id,
    kind: c.kind,
    version: c.version,
    name: c.name,
    description: c.description,
    source: c.source,
    dir: c.dir,
    entry: c.entry,
    slots: c.slots,
    params: c.param_defaults,
    ...(m.duration ? { duration: m.duration } : {}),
    ...(m.variants ? { variants: m.variants } : {}),
    ...(m.tags ? { tags: m.tags } : {}),
    ...(c.preview ? { preview: c.preview } : {}),
  };
}

function printNotices(ui: Ui, notices: readonly RegistryNoticeView[]): void {
  for (const n of notices) {
    const text = `${n.message}${n.id ? '' : ` (${ui.path(n.dir)})`}`;
    if (n.severity === 'error') ui.error(text);
    else ui.warn(text);
    for (const i of n.issues ?? []) ui.line(`    ${ui.issue(i, join(n.dir, i.file))}`);
  }
}

/** `retake components list [--kind K] [--json]`: workspace components, then the built-in library. */
export async function componentsListCommand(ui: Ui, global: GlobalOptions, opts: ComponentsListOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const reg = await componentListEntries(ws, opts.kind);
  const list = reg.components;
  if (opts.json) {
    ui.result(
      JSON.stringify(
        {
          root: ws.root,
          components_dir: reg.components_dir,
          builtin_dir: reg.builtin_dir,
          components: list.map(info),
          notices: reg.notices.map((n) => ({ severity: n.severity, message: n.message, dir: n.dir, id: n.id, issues: n.issues ?? [] })),
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  const c = ui.c;
  ui.result(`${c.bold('Components')} ${c.dim(`${ui.path(reg.components_dir)} → built-in library`)}`);
  if (list.length === 0) {
    ui.result(
      c.dim(
        opts.kind
          ? `  no ${opts.kind} component yet — create one with \`retake components create <namespace/name> --kind ${opts.kind}\``
          : '  none yet — create one with `retake components create <namespace/name> --kind <kind>`',
      ),
    );
  }
  const idWidth = Math.max(0, ...list.map((i) => i.id.length));
  const kindWidth = Math.max(0, ...list.map((i) => i.kind.length));
  for (const item of list) {
    const m = item;
    const source = item.source === 'workspace' ? c.cyan('workspace') : c.dim('built-in ');
    ui.result(`  ${c.bold(m.id.padEnd(idWidth))}  ${m.kind.padEnd(kindWidth)}  ${source}  ${c.dim(m.version.padEnd(6))}  ${truncate(m.description, 70)}`);
  }
  printNotices(ui, reg.notices);
  return EXIT.ok;
}

export interface ComponentsValidateOptions {
  json?: boolean;
}

/** What a person named on the command line: an id, else a folder (resolved against the current folder). */
function refOf(arg: string): ComponentRef {
  return { ref: arg, dir: resolve(arg) };
}

/**
 * `retake components validate [<id|dir>] [--json]`: manifest, entry and compile check of one component — or of every
 * workspace component when none is given. Exit 1 on any error.
 */
export async function componentsValidateCommand(
  ui: Ui,
  global: GlobalOptions,
  arg: string | undefined,
  opts: ComponentsValidateOptions,
): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const validated = await componentValidateShell(ws, arg !== undefined ? refOf(arg) : { workspace: true });
  const results = validated.components;
  const failed = results.some((r) => !r.ok);
  if (opts.json) {
    ui.result(JSON.stringify({ ok: !failed, components: results }, null, 2));
    return failed ? EXIT.failure : EXIT.ok;
  }
  const c = ui.c;
  if (results.length === 0) ui.warn(`no workspace component in ${ui.path(validated.components_dir)}`);
  for (const r of results) {
    const errors = errorsOf(r.issues).length;
    const warnings = warningsOf(r.issues).length;
    const counts = [errors ? c.red(plural(errors, 'error')) : '', warnings ? c.yellow(plural(warnings, 'warning')) : ''].filter(Boolean).join(', ');
    ui.line(`${r.ok ? c.green('✓') : c.red('✗')} component ${c.bold(r.id)}${c.dim(` ${ui.path(r.dir)}`)}${counts ? `  ${counts}` : ''}`);
    for (const i of r.issues) ui.line(`  ${ui.issue(i, join(r.dir, i.file))}`);
  }
  return failed ? EXIT.failure : EXIT.ok;
}

export interface ComponentsCreateOptions {
  kind: ComponentKind;
  description?: string;
  name?: string;
  json?: boolean;
  /** Theme of the generated preview (default editorial). */
  theme?: string;
  /** commander: `--no-preview` sets it to false. */
  preview?: boolean;
}

/** The preview README writer of the workspace's components, journaled as the CLI's (engine componentReadmeWriter). */
function componentReadmes(ws: OpenedWorkspace) {
  return componentReadmeWriter(ws, personScope(ws.root, cliPorts));
}

/** `retake components create <id> --kind K [--description D] [--name N]`: scaffold a workspace component. */
export async function componentsCreateCommand(ui: Ui, global: GlobalOptions, id: string, opts: ComponentsCreateOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const created = await componentCreateShell(ws, { id, kind: opts.kind, description: opts.description, name: opts.name }, personScope(ws.root, cliPorts));
  // The preview (preview.png + preview.json + the README block) — skipped with a warning when no browser can render.
  let preview: Awaited<ReturnType<typeof previewsWork>>[number] | undefined;
  let previewTheme: string | undefined;
  let previewError: string | undefined;
  if (opts.preview !== false) {
    try {
      const { theme, template } = await componentPreviewTheme(ws, opts.theme);
      previewTheme = theme;
      [preview] = await previewsWork({
        renderer: editorRenderer(),
        workPolicy: ws.policy,
        readmes: componentReadmes(ws),
        root: ws.root,
        template,
        targets: [{ id: created.manifest.id, dir: created.dir, entry: created.entry, manifest: created.manifest }],
      });
    } catch (e) {
      previewError = (e as Error).message.split('\n')[0];
    }
  }
  if (opts.json) {
    ui.result(
      JSON.stringify(
        {
          id: created.id,
          kind: created.kind,
          dir: created.dir,
          entry: created.entry,
          files: created.files,
          issues: created.issues,
          ...(created.overrides ? { overrides: created.overrides } : {}),
          ...(preview ? { preview: preview.file } : {}),
          ...(previewError ? { preview_error: previewError } : {}),
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  const c = ui.c;
  ui.ok(`created ${opts.kind} component ${c.bold(created.manifest.id)} in ${ui.path(created.dir)} (validated)`);
  ui.line(c.dim('  component.yaml  manifest: slots, params (JSON Schema + defaults), duration, preview samples'));
  ui.line(c.dim('  index.tsx       implementation: theme tokens + unit, frame-driven, imports react / remotion / the kit'));
  ui.line(c.dim('  README.md       notes for whoever edits it (+ the generated preview block)'));
  if (preview) ui.line(c.dim(`  preview.png     generated preview (${preview.meta?.theme ?? previewTheme} theme, at ${preview.at} s): ${ui.path(preview.file)}`));
  if (previewError) ui.warn(`no preview rendered (${previewError}): run \`retake components preview ${created.manifest.id}\` when a browser is available`);
  if (created.overrides) ui.warn(`${created.manifest.id} overrides the built-in component of the same id`);
  for (const i of created.issues) ui.line(`  ${ui.issue(i, join(created.dir, i.file))}`);
  ui.line(
    `next: edit index.tsx, then ${c.bold(`retake components validate ${created.manifest.id}`)} and ${c.bold(`retake components preview ${created.manifest.id}`)}; ` +
      `use it from a template (components: {${opts.kind}: ${created.manifest.id}}) or a scenario`,
  );
  return EXIT.ok;
}

export interface ComponentsPreviewOptions {
  all?: boolean;
  /** Only previews that are missing or stale. */
  stale?: boolean;
  /** Only workspace components (with --all). */
  workspace?: boolean;
  theme?: string;
  out?: string;
  json?: boolean;
}

/**
 * `retake components preview [<id|dir>] [--all] [--stale] [--theme T] [--out DIR] [--json]`: render each component
 * with its manifest preview samples into <component dir>/preview.png (960×540) + preview.json + the README block —
 * or only the images into --out. --all: every component (workspace, built-in library and the per-kind scaffolds).
 */
export async function componentsPreviewCommand(ui: Ui, global: GlobalOptions, arg: string | undefined, opts: ComponentsPreviewOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  let workspaceOnly = false;
  if (arg === undefined && opts.all) {
    // From an app bundle, --all means --workspace: the built-in library and the scaffolds ship inside it, sealed.
    workspaceOnly = opts.workspace === true || bundleInfo() !== null;
  } else if (arg === undefined) {
    throw new CliError('name a component (id or folder) or pass --all');
  }
  const picked = await componentPreviewTargets(ws, arg !== undefined ? { ref: refOf(arg) } : { all: true, workspaceOnly }, { ...(opts.theme !== undefined ? { theme: opts.theme } : {}), ...(opts.stale ? { stale: true } : {}) });
  if ('invalid' in picked) {
    for (const i of picked.invalid.issues) ui.line(`  ${ui.issue(i, join(picked.invalid.dir, i.file))}`);
    throw new CliError(`component ${picked.invalid.id} does not validate: fix it before rendering its preview`);
  }
  if (arg === undefined && workspaceOnly && !opts.workspace && !opts.json) ui.line(ui.c.dim("the built-in components ship inside the Retake app and keep their own previews: rendering this workspace's"));
  const { targets, registry, theme: themeName } = picked;
  const c = ui.c;
  if (targets.length === 0) {
    if (opts.json) ui.result(JSON.stringify({ theme: themeName, previews: [] }, null, 2));
    else ui.ok('every preview is up to date');
    return EXIT.ok;
  }
  const { template } = await componentPreviewTheme(ws, themeName);
  if (!opts.json) ui.line(c.dim(`rendering ${plural(targets.length, 'preview')} with the ${template.name} theme…`));
  const t0 = performance.now();
  const done = await previewsWork({
    renderer: editorRenderer(),
    workPolicy: ws.policy,
    readmes: componentReadmes(ws),
    root: ws.root,
    registry,
    template,
    targets,
    ...(opts.out ? { outDir: resolve(opts.out) } : {}),
    onProgress: (n, total, id) => {
      if (!opts.json) ui.line(c.dim(`  ${n}/${total} ${id}`));
    },
  });
  if (opts.json) {
    ui.result(JSON.stringify({ theme: template.name, previews: done.map((p) => ({ id: p.id, file: p.file, bytes: p.bytes, at: p.at, screen: p.screen, quantized: p.quantized, readme: p.readme })) }, null, 2));
    return EXIT.ok;
  }
  for (const p of done) ui.ok(`${c.bold(p.id)} ${ui.path(p.file)} ${c.dim(`${Math.round(p.bytes / 1024)} KB · at ${p.at} s${p.screen ? ` · ${p.screen} screen` : ''}${p.quantized ? ' · 256 colours' : ''}`)}`);
  ui.line(c.dim(`${plural(done.length, 'preview')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`));
  return EXIT.ok;
}
