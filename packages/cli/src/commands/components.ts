import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPONENT_ID_RE, errorsOf, warningsOf } from '@demo-studio/core';
import type { ComponentKind } from '@demo-studio/core';
import { createComponent, loadComponentRegistry, paramDefaults, validateComponentDir } from '@demo-studio/components';
import type { ComponentInfo, ComponentIssue, ComponentRegistry, JsonSchemaNode, RegistryNotice } from '@demo-studio/components';
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

/** `studio components list [--kind K] [--json]`: workspace components, then the built-in library. */
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
          ? `  no ${opts.kind} component yet — create one with \`studio components create <namespace/name> --kind ${opts.kind}\``
          : '  none yet — create one with `studio components create <namespace/name> --kind <kind>`',
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
 * `studio components validate [<id|dir>] [--json]`: manifest, entry and compile check of one component — or of every
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
}

/** `studio components create <id> --kind K [--description D] [--name N]`: scaffold a workspace component. */
export async function componentsCreateCommand(ui: Ui, global: GlobalOptions, id: string, opts: ComponentsCreateOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const created = await createComponent(ws.root, { id, kind: opts.kind, description: opts.description, name: opts.name });
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
  ui.line(c.dim('  README.md       notes for whoever edits it'));
  if (created.overrides) ui.warn(`${created.manifest.id} overrides the built-in component of the same id`);
  for (const i of created.issues) ui.line(`  ${ui.issue(i, join(created.dir, i.file))}`);
  ui.line(
    `next: edit index.tsx, then ${c.bold(`studio components validate ${created.manifest.id}`)}; ` +
      `use it from a template (components: {${opts.kind}: ${created.manifest.id}}) or a scenario`,
  );
  return EXIT.ok;
}
