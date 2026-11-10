import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPONENT_ID_RE, COMPONENT_KINDS, errorsOf, warningsOf } from '@retake/core';
import { bundleInfo, fileFacts } from '@retake/core/io';
import type { ComponentKind } from '@retake/core';
import {
  PREVIEW_FILE,
  PREVIEW_THEME,
  createComponent,
  loadComponentRegistry,
  paramDefaults,
  previewStatus,
  scaffoldDir,
  validateComponentDir,
} from '@retake/components';
import type { ComponentInfo, ComponentIssue, ComponentRegistry, JsonSchemaNode, RegistryNotice } from '@retake/components';
import { loadPreviewTheme } from '@retake/editor';
import type { PreviewComponentTarget, RenderedPreview, PreviewReadmeWriter } from '@retake/editor';
import { componentWriter, editorRenderer, personScope, previewsWork, fileWriter, ProjectStore } from '@retake/engine';
import type { OpenedWorkspace } from '@retake/engine';
import { CliError, EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural, truncate } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

export interface ComponentsListOptions {
  kind?: ComponentKind;
  json?: boolean;
}

function info(c: ComponentInfo) {
  const m = c.manifest;
  return {
    id: m.id,
    kind: m.kind,
    version: m.version,
    name: m.name,
    description: m.description,
    source: c.source,
    dir: c.dir,
    entry: c.entry,
    slots: Object.keys(m.slots),
    params: paramDefaults(m.params as JsonSchemaNode | undefined),
    ...(m.duration ? { duration: m.duration } : {}),
    ...(m.variants ? { variants: m.variants } : {}),
    ...(m.tags ? { tags: m.tags } : {}),
    ...(existsSync(join(c.dir, PREVIEW_FILE)) ? { preview: join(c.dir, PREVIEW_FILE) } : {}),
  };
}

function printNotices(ui: Ui, notices: readonly RegistryNotice[]): void {
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
  const reg = await loadComponentRegistry({ root: ws.root });
  const list = reg.list(opts.kind);
  if (opts.json) {
    ui.result(
      JSON.stringify(
        {
          root: ws.root,
          components_dir: reg.componentsDir,
          builtin_dir: reg.builtinDir,
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
  ui.result(`${c.bold('Components')} ${c.dim(`${ui.path(reg.componentsDir)} → built-in library`)}`);
  if (list.length === 0) {
    ui.result(
      c.dim(
        opts.kind
          ? `  no ${opts.kind} component yet — create one with \`retake components create <namespace/name> --kind ${opts.kind}\``
          : '  none yet — create one with `retake components create <namespace/name> --kind <kind>`',
      ),
    );
  }
  const idWidth = Math.max(0, ...list.map((i) => i.manifest.id.length));
  const kindWidth = Math.max(0, ...list.map((i) => i.manifest.kind.length));
  for (const item of list) {
    const m = item.manifest;
    const source = item.source === 'workspace' ? c.cyan('workspace') : c.dim('built-in ');
    ui.result(`  ${c.bold(m.id.padEnd(idWidth))}  ${m.kind.padEnd(kindWidth)}  ${source}  ${c.dim(m.version.padEnd(6))}  ${truncate(m.description, 70)}`);
  }
  printNotices(ui, reg.notices);
  return EXIT.ok;
}

export interface ComponentsValidateOptions {
  json?: boolean;
}

interface Target {
  /** Id when known (from the registry or the folder). */
  id: string;
  dir: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder of an id (valid or invalid component of the registry), else a directory path. */
function targetOf(reg: ComponentRegistry, arg: string): Target {
  if (COMPONENT_ID_RE.test(arg)) {
    if (reg.has(arg)) return { id: arg, dir: reg.get(arg).dir };
    const broken = reg.notices.find((n) => n.id === arg && n.severity === 'error');
    if (broken) return { id: arg, dir: broken.dir };
  }
  const dir = resolve(arg);
  if (isDir(dir)) return { id: arg, dir };
  // Neither: let the registry explain (not found, did you mean…).
  reg.get(arg);
  throw new CliError(`component "${arg}" not found`);
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
  const reg = await loadComponentRegistry({ root: ws.root });
  let targets: Target[];
  if (arg !== undefined) {
    targets = [targetOf(reg, arg)];
  } else {
    const valid = reg.list().filter((i) => i.source === 'workspace').map((i) => ({ id: i.manifest.id, dir: i.dir }));
    const broken = reg.notices
      .filter((n) => n.severity === 'error' && n.source === 'workspace' && n.id !== undefined)
      .map((n) => ({ id: n.id!, dir: n.dir }));
    targets = [...valid, ...broken].sort((a, b) => a.id.localeCompare(b.id));
  }
  const results: Array<{ id: string; dir: string; ok: boolean; issues: ComponentIssue[] }> = [];
  for (const t of targets) {
    const v = await validateComponentDir(t.dir);
    results.push({ id: v.manifest?.id ?? t.id, dir: v.dir, ok: v.ok, issues: v.issues });
  }
  const failed = results.some((r) => !r.ok);
  if (opts.json) {
    ui.result(JSON.stringify({ ok: !failed, components: results }, null, 2));
    return failed ? EXIT.failure : EXIT.ok;
  }
  const c = ui.c;
  if (results.length === 0) ui.warn(`no workspace component in ${ui.path(reg.componentsDir)}`);
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

/**
 * The READMEs of the workspace's components, written through the project store of its components folder (journaled as
 * the CLI's, on the version read — or created when there was none); the built-in library's and the scaffolds' are
 * written directly by the editor.
 */
function componentReadmes(ws: OpenedWorkspace): PreviewReadmeWriter {
  return { root: ws.componentsDir, write: fileWriter(new ProjectStore(ws.componentsDir, personScope(ws.root), undefined, '<components_dir>'), 'component') };
}

/** `retake components create <id> --kind K [--description D] [--name N]`: scaffold a workspace component. */
export async function componentsCreateCommand(ui: Ui, global: GlobalOptions, id: string, opts: ComponentsCreateOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const created = await createComponent(ws.root, { id, kind: opts.kind, description: opts.description, name: opts.name, write: componentWriter(ws, personScope(ws.root)) });
  // The preview (preview.png + preview.json + the README block) — skipped with a warning when no browser can render.
  let preview: RenderedPreview | undefined;
  let previewError: string | undefined;
  if (opts.preview !== false) {
    try {
      const template = await loadPreviewTheme(opts.theme ?? PREVIEW_THEME, ws.root, fileFacts(ws.policy));
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
          id: created.manifest.id,
          kind: created.manifest.kind,
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
  if (preview) ui.line(c.dim(`  preview.png     generated preview (${preview.meta?.theme ?? PREVIEW_THEME} theme, at ${preview.at} s): ${ui.path(preview.file)}`));
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

/** Every component a preview can be rendered for: the registry (workspace + built-in) and the per-kind scaffolds. */
function allPreviewTargets(reg: ComponentRegistry, workspaceOnly: boolean): PreviewComponentTarget[] {
  const out: PreviewComponentTarget[] = reg
    .list()
    .filter((i) => !workspaceOnly || i.source === 'workspace')
    .map((i) => ({ id: i.manifest.id, dir: i.dir, entry: i.entry, manifest: i.manifest }));
  return out;
}

async function scaffoldTargets(): Promise<PreviewComponentTarget[]> {
  const out: PreviewComponentTarget[] = [];
  for (const kind of COMPONENT_KINDS) {
    const v = await validateComponentDir(scaffoldDir(kind));
    if (v.manifest) out.push({ id: v.manifest.id, dir: v.dir, entry: join(v.dir, v.manifest.entry ?? 'index.tsx'), manifest: v.manifest });
  }
  return out;
}

/**
 * `retake components preview [<id|dir>] [--all] [--stale] [--theme T] [--out DIR] [--json]`: render each component
 * with its manifest preview samples into <component dir>/preview.png (960×540) + preview.json + the README block —
 * or only the images into --out. --all: every component (workspace, built-in library and the per-kind scaffolds).
 */
export async function componentsPreviewCommand(ui: Ui, global: GlobalOptions, arg: string | undefined, opts: ComponentsPreviewOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const reg = await loadComponentRegistry({ root: ws.root });
  let targets: PreviewComponentTarget[];
  if (arg !== undefined) {
    const scaffold = /^scaffolds\/([a-z]+)$/.exec(arg);
    const t = scaffold && (COMPONENT_KINDS as readonly string[]).includes(scaffold[1]) ? { id: arg, dir: scaffoldDir(scaffold[1] as ComponentKind) } : targetOf(reg, arg);
    const v = await validateComponentDir(t.dir);
    if (!v.ok || !v.manifest) {
      for (const i of v.issues) ui.line(`  ${ui.issue(i, join(v.dir, i.file))}`);
      throw new CliError(`component ${t.id} does not validate: fix it before rendering its preview`);
    }
    targets = [{ id: v.manifest.id, dir: v.dir, entry: join(v.dir, v.manifest.entry ?? 'index.tsx'), manifest: v.manifest }];
  } else if (opts.all) {
    // From an app bundle, --all means --workspace: the built-in library and the scaffolds ship inside it, sealed.
    const workspaceOnly = opts.workspace === true || bundleInfo() !== null;
    if (workspaceOnly && !opts.workspace && !opts.json) ui.line(ui.c.dim("the built-in components ship inside the Retake app and keep their own previews: rendering this workspace's"));
    targets = allPreviewTargets(reg, workspaceOnly);
    if (!workspaceOnly) targets.push(...(await scaffoldTargets()));
  } else {
    throw new CliError('name a component (id or folder) or pass --all');
  }
  const themeName = opts.theme ?? PREVIEW_THEME;
  if (opts.stale) targets = targets.filter((t) => previewStatus(t.dir, { theme: themeName }).state !== 'fresh');
  const c = ui.c;
  if (targets.length === 0) {
    if (opts.json) ui.result(JSON.stringify({ theme: themeName, previews: [] }, null, 2));
    else ui.ok('every preview is up to date');
    return EXIT.ok;
  }
  const template = await loadPreviewTheme(themeName, ws.root, fileFacts(ws.policy));
  if (!opts.json) ui.line(c.dim(`rendering ${plural(targets.length, 'preview')} with the ${template.name} theme…`));
  const t0 = performance.now();
  const done = await previewsWork({
    renderer: editorRenderer(),
    workPolicy: ws.policy,
    readmes: componentReadmes(ws),
    root: ws.root,
    registry: reg,
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
