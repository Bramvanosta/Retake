/**
 * A project archive at a terminal (engine project-archive/): `retake project export` writes a project in one ZIP,
 * `retake project import` makes one a project of this workspace — untrusted, inert —, and `retake project trust` lists
 * what of it runs, then trusts it (a person's yes) or discards the import. Import and trust are a person's commands
 * only: no MCP tool or Studio route does them; a trust and a discard each take a person's y/N at a terminal, always (no
 * `--yes`: an agent's shell cannot be told from a person's script).
 *
 * The sandbox (a person's options): `export --with-sandbox` carries its compose files and saves its images (said
 * before writing: their count, platform and sizes), `--no-images` its files only, `--with-env` its env file too after
 * a y/N naming the file and its key count. `trust` loads the images after its yes (`--no-images`: later, with
 * `--images` and a y/N of its own).
 */
import { resolve } from 'node:path';
import { errorMessage, showHiddenCharsLine } from '@retake/core/base';
import { createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import { CliError, EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

type ExportResult = Awaited<ReturnType<Engine['projects']['exportArchive']>>;
type ImportResult = Awaited<ReturnType<Engine['projects']['importArchive']>>;
type TrustView = Awaited<ReturnType<Engine['projects']['trustView']>>;
type ImagesLoad = Awaited<ReturnType<Engine['projects']['loadImages']>>;

export interface ProjectExportOptions {
  withRuns?: boolean;
  out?: string;
  dryRun?: boolean;
  withSandbox?: boolean;
  /** `--no-images` sets false. */
  images?: boolean;
  withEnv?: boolean;
  json?: boolean;
}

export interface ProjectImportOptions {
  as?: string;
  json?: boolean;
}

export interface ProjectTrustOptions {
  list?: boolean;
  discard?: boolean;
  /** `--images`: load the images a trusted import waits for; `--no-images`: trust without loading them. */
  images?: boolean;
  json?: boolean;
}

async function engineOf(global: GlobalOptions): Promise<Engine> {
  const ws = await openWorkspace(global);
  return createEngine({ root: resolve(ws.root), client: 'cli', autoStartWorker: false, ports: global.ports });
}

const mb = (n: number): string => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const listOf = (l: readonly string[], max = 12): string => `${l.slice(0, max).join(', ')}${l.length > max ? ` and ${l.length - max} more` : ''}`;

function printNeeds(ui: Ui, needs: ExportResult['needs']): void {
  if (needs.env_vars.length) ui.line(`  environment variables: ${listOf(needs.env_vars)}`);
  if (needs.keychain.length) ui.line(`  keychain items: ${listOf(needs.keychain)}`);
  if (needs.pass_env.length) ui.line(`  passed on to its hooks: ${listOf(needs.pass_env)}`);
  if (needs.sessions.length) ui.line(`  personas to sign in: ${listOf(needs.sessions.map((s) => `${s.env}/${s.persona}`))}`);
}

/** The sandbox's part of an export: the images (count, platform, sizes), what is copied, rewritten, mounted, not carried. */
function printSandbox(ui: Ui, r: ExportResult): void {
  const shown = showHiddenCharsLine;
  const images = r.images ?? [];
  if (images.length) {
    const platforms = [...new Set(images.map((i) => i.platform))].map(shown).join(', ');
    const total = images.reduce((n, i) => n + i.size, 0);
    ui.line(
      `  sandbox images: ${images.length} (${platforms}), about ${mb(total)} before compression — ${listOf(images.map((i) => `${i.services.map(shown).join(' ')} ${mb(i.size)} ${shown(i.platform)}`))}`,
    );
  }
  if (r.docker) ui.line(ui.c.dim(`  saved with Docker Compose ${shown(r.docker.compose)} on ${shown(r.docker.platform)}; the importer's Compose must be v2.24 or later to run them unbuilt`));
  for (const p of r.sandbox ?? []) {
    const env = shown(p.env);
    for (const c of p.copied) ui.line(`  sandbox ${env}: ${shown(c.from)} copied as ${shown(c.to)}`);
    for (const f of p.rewritten) ui.line(`  sandbox ${env}: ${shown(f)} rewritten to name them there`);
    if (p.env_file)
      ui.line(
        `  sandbox ${env}: env file ${shown(p.env_file.path)} — ${p.env_file.included ? 'CARRIED, with its values' : 'not carried'} (${p.env_file.keys.length} keys: ${listOf(p.env_file.keys.map(shown))})`,
      );
    for (const f of p.service_env_files)
      ui.line(
        `  sandbox ${env}: service ${shown(f.service)} reads ${shown(f.path)} — not carried: the importer puts it at ${shown(f.expected_at ?? f.path)} (${f.keys.length} keys: ${listOf(f.keys.map(shown))})`,
      );
    for (const m of p.host_mounts)
      ui.warn(
        `sandbox ${env}: service ${shown(m.service)} mounts ${shown(m.source)} (${shown(m.target)}) — a folder of this machine, never carried: the importer puts one at ${shown(m.expected_at ?? m.source)}`,
      );
    for (const o of p.outside) ui.line(`  sandbox ${env}: ${shown(o.ref)} — ${shown(o.what)}`);
  }
  // Already shown through showHiddenCharsLine (compose-read.ts composeLines).
  for (const l of r.sandbox_settings ?? []) l.includes('WARNING') ? ui.warn(l) : ui.line(`  ${l}`);
}

function printExport(ui: Ui, r: ExportResult): void {
  const k = ui.c;
  if (r.file) ui.ok(`project ${k.bold(r.project)} exported: ${ui.path(r.file)} (${r.files} files, ${mb(r.bytes)}, ${mb(r.archive_bytes ?? 0)} zipped)`);
  else ui.ok(`project ${k.bold(r.project)} would export ${r.files} files, ${mb(r.bytes)} (dry run: nothing written)`);
  if (r.embedded.themes.length || r.embedded.components.length)
    ui.line(`  with the workspace's ${listOf([...r.embedded.themes.map((t) => `theme ${t}`), ...r.embedded.components.map((c) => `component ${c}`)])}`);
  if (r.uses.starters.length || r.uses.builtin_components.length)
    ui.line(k.dim(`  uses what every Retake ships: ${listOf([...r.uses.starters.map((t) => `starter ${t}`), ...r.uses.builtin_components])}`));
  const left = [...r.excluded.env, ...r.excluded.sensitive, ...r.excluded.links, ...r.excluded.special].map(showHiddenCharsLine);
  if (left.length) ui.line(`  left out: ${listOf(left)}`);
  if (r.excluded.outside_renders.length) ui.warn(`left out: ${listOf(r.excluded.outside_renders.map(showHiddenCharsLine))} — rendered with a theme outside the project (re-render after import)`);
  if (r.needs.env_vars.length || r.needs.keychain.length || r.needs.sessions.length || r.needs.pass_env.length) {
    ui.line('  what it needs on another machine (names only):');
    printNeeds(ui, {
      env_vars: r.needs.env_vars.map(showHiddenCharsLine),
      keychain: r.needs.keychain.map(showHiddenCharsLine),
      pass_env: r.needs.pass_env.map(showHiddenCharsLine),
      sessions: r.needs.sessions,
    });
  }
  for (const w of r.warnings.literal_tokens) ui.warn(`${showHiddenCharsLine(w.file)} line ${w.lines.join(', ')}: ${w.what} — it is in the archive`);
  if (!r.file) printSandbox(ui, r);
  if (r.file) ui.line(k.dim(`  on the other machine: retake project import ${r.file}`));
}

/** Before an export with the sandbox writes: what it carries said, and a person's yes to an env file it would carry. */
async function beforeSandboxWrite(ui: Ui, r: ExportResult, json: boolean): Promise<void> {
  if (!r.sandbox) return;
  if (!json) printSandbox(ui, r);
  const carried = r.sandbox.flatMap((p) => (p.env_file?.included ? [p.env_file] : []));
  if (!carried.length) return;
  const what = carried.map((f) => `${showHiddenCharsLine(f.from ?? f.path)} (as ${showHiddenCharsLine(f.path)}, ${f.keys.length} key${f.keys.length === 1 ? '' : 's'})`).join(', ');
  await personsYes(ui, `The archive will hold ${what} with its values, in clear, for whoever gets the file: carry it?`, `carrying ${what}`);
}

/** `retake project export <project> [--with-runs] [--with-sandbox [--no-images] [--with-env]] [--out <path>] [--dry-run] [--json]`. */
export async function projectExportCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: ProjectExportOptions): Promise<ExitCode> {
  const engine = await engineOf(global);
  const r = await engine.projects.exportArchive(
    {
      project: projectArg,
      ...(opts.withRuns ? { withRuns: true } : {}),
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.withSandbox ? { withSandbox: true } : {}),
      ...(opts.images === false ? { images: false } : {}),
      ...(opts.withEnv ? { withEnv: true } : {}),
    },
    {
      onFile: (done, total) => ui.setStatus(`archiving ${done}/${total} files`),
      onImage: (done, total) => ui.setStatus(`saving the sandbox's images ${done}/${total}`),
      onImageBytes: (n, total, bytes) => ui.setStatus(`saving the sandbox's image ${n}/${total}: ${mb(bytes)} written`),
      beforeWrite: (plan) => beforeSandboxWrite(ui, plan, opts.json === true),
    },
  );
  ui.clearStatus();
  if (opts.json) ui.result(JSON.stringify(r, null, 2));
  else printExport(ui, r);
  return EXIT.ok;
}

function printCodeFiles(ui: Ui, files: ReadonlyArray<{ path: string; why: string; size: number; sha256: string; since?: string }>): void {
  for (const f of files) {
    const since = f.since === 'changed' ? ui.c.yellow(' changed since the import') : f.since === 'new' ? ui.c.yellow(' new since the import') : '';
    ui.line(`  ${f.why.padEnd(9)} ${f.path} ${ui.c.dim(f.why === 'link' ? '(a symbolic link)' : `${f.size} B · ${f.sha256.slice(0, 12)}`)}${since}`);
  }
}

function printImages(ui: Ui, images: ReadonlyArray<{ id: string; platform: string; size: number; services: string[]; loaded?: boolean }>, state: string): void {
  if (!images.length) return;
  ui.line(`  its sandbox's images (${images.length}, ${state}):`);
  for (const i of images) ui.line(`    ${i.id.slice(7, 19)} ${i.platform} ${mb(i.size)} — ${listOf(i.services)}${i.loaded === true ? ui.c.dim(' (loaded)') : ''}`);
}

/** What the sandboxes will do, read from their compose files (lines shown already): the risky ones as warnings. */
function printSettings(ui: Ui, lines: readonly string[]): void {
  if (lines.length) ui.line('  what its sandboxes will do (read from its compose files):');
  for (const l of lines) l.includes('WARNING') ? ui.warn(l) : ui.line(`    ${l}`);
}

function printImport(ui: Ui, r: ImportResult): void {
  const k = ui.c;
  ui.ok(`project ${k.bold(r.project)} imported: ${ui.path(r.dir)} (${r.files} files, ${mb(r.bytes)})${r.exported_as !== r.project ? ` — exported as ${showHiddenCharsLine(r.exported_as)}` : ''}`);
  if (r.embedded.themes.length || r.embedded.components.length)
    ui.line(`  its own now: ${listOf([...r.embedded.themes.map((t) => `theme ${t}`), ...r.embedded.components.map((c) => `component ${c}`)])}`);
  for (const w of r.refused_records) ui.warn(`record refused: ${w}`);
  for (const w of r.warnings) ui.warn(w);
  if (r.needs.env_vars.length || r.needs.keychain.length || r.needs.sessions.length || r.needs.pass_env.length) {
    ui.line('  what it needs on this machine:');
    printNeeds(ui, r.needs);
  }
  if (r.sessions_here.length) ui.warn(`this machine already holds saved sessions for ${r.project}: ${listOf(r.sessions_here)} — the project would use them`);
  ui.warn(`${r.project} is NOT trusted: nothing of it runs (hooks, sandboxes, components, browser settings) until you read its code files and trust it`);
  ui.line(`  its code files (${r.code_files.length}):`);
  printCodeFiles(ui, r.code_files);
  for (const s of r.settings) ui.line(`  project.yaml ${s}`);
  printImages(ui, r.images, 'extracted, not loaded: trust loads them');
  printSettings(ui, r.sandbox_settings);
  for (const n of r.sandbox_notes) ui.line(ui.c.dim(`  the exporter says: ${n}`));
  ui.line(`  next: ${k.bold(r.trust_command)} (lists them again, then asks)`);
}

/** `retake project import <archive> [--as <slug>] [--json]`. */
export async function projectImportCommand(ui: Ui, global: GlobalOptions, archive: string, opts: ProjectImportOptions): Promise<ExitCode> {
  const engine = await engineOf(global);
  const r = await engine.projects.importArchive(resolve(archive), opts.as !== undefined ? { as: opts.as } : {});
  if (opts.json) ui.result(JSON.stringify(r, null, 2));
  else printImport(ui, r);
  return EXIT.ok;
}

/** A person's yes to `question` at a terminal, or a refusal (no terminal; a no). */
async function personsYes(ui: Ui, question: string, refusal: string): Promise<void> {
  if (!ui.io.canPrompt || !ui.io.confirm) throw new CliError(`refused: ${refusal} takes a person's yes at a terminal — run it in your own terminal`);
  let yes = false;
  try {
    yes = await ui.io.confirm(question);
  } catch {
    yes = false; // the input closed: no answer is a no
  }
  if (!yes) throw new CliError(`nothing done: ${refusal} needs a yes`);
}

function printTrustView(ui: Ui, v: TrustView): void {
  ui.line(`${ui.c.bold(v.project)}: ${v.state === 'trusted' ? 'trusted' : `not trusted (${v.why ?? ''})`}`);
  ui.line(`  its code files (${v.files.length}):`);
  printCodeFiles(ui, v.files);
  if (v.removed.length) ui.line(`  removed since the import: ${listOf(v.removed)}`);
  for (const s of v.settings) ui.line(`  project.yaml ${s}`);
  if (v.sessions_here.length) ui.warn(`saved sessions on this machine for ${v.project}: ${listOf(v.sessions_here)} — the project uses them once trusted`);
  printImages(ui, v.images, 'loaded into Docker after the yes, tagged retake-share-*');
  printSettings(ui, v.sandbox_settings);
  for (const o of v.overrides) ui.line(`  override ${o}`);
  for (const m of v.missing) ui.warn(`does not start: ${m}`);
  for (const n of v.sandbox_notes) ui.line(ui.c.dim(`  ${n}`));
}

function printLoad(ui: Ui, r: ImagesLoad): void {
  for (const l of r.loaded) ui.ok(`image ${l.id.slice(7, 19)} loaded: ${listOf(l.tags)}`);
  for (const o of r.overrides) ui.line(ui.c.dim(`  its sandbox runs them unbuilt: ${ui.path(o)}`));
  for (const m of r.missing) ui.warn(`does not start: ${m}`);
  for (const n of r.notes) ui.line(`  ${n}`);
  if (r.waiting) ui.warn(r.waiting);
}

/** `--images`: a person's yes, then the images a trusted import waits for loaded. */
async function loadWithYes(ui: Ui, engine: Engine, view: TrustView, json: boolean): Promise<ExitCode> {
  const pending = view.images.filter((i) => !i.loaded);
  if (!pending.length) {
    ui.ok(`${view.project} waits for no image`);
    return EXIT.ok;
  }
  const size = pending.reduce((n, i) => n + i.size, 0);
  await personsYes(ui, `Load ${pending.length} image(s) of ${view.project} (about ${mb(size)}) into Docker?`, `loading ${view.project}'s images`);
  const r = await engine.projects.loadImages(view.project, { onProgress: (l) => ui.setStatus(l) });
  ui.clearStatus();
  if (json) ui.result(JSON.stringify(r, null, 2));
  else printLoad(ui, r);
  return r.waiting ? EXIT.failure : EXIT.ok;
}

/** `retake project trust <project> [--list] [--yes] [--discard] [--json]`. */
export async function projectTrustCommand(ui: Ui, global: GlobalOptions, projectArg: string, opts: ProjectTrustOptions): Promise<ExitCode> {
  const engine = await engineOf(global);
  const view = await engine.projects.trustView(projectArg);
  if (opts.json && (opts.list || (view.state === 'trusted' && !opts.discard))) {
    ui.result(JSON.stringify(view, null, 2));
    return EXIT.ok;
  }
  if (!opts.json) printTrustView(ui, view);
  if (opts.list) return EXIT.ok;
  if (opts.discard) {
    await personsYes(ui, `Set ${view.project}'s folder aside and forget its import?`, `discarding the import of ${view.project}`);
    const d = await engine.projects.discardImport(view.project);
    if (opts.json) ui.result(JSON.stringify(d, null, 2));
    else ui.ok(`the import of ${d.project} is discarded: its folder is set aside in ${ui.path(d.moved_to)} — remove it once you no longer need it`);
    return EXIT.ok;
  }
  if (view.state === 'trusted' && opts.images === true) return loadWithYes(ui, engine, view, opts.json === true);
  if (view.state === 'trusted') {
    ui.ok(`${view.project} is trusted already: its code runs as any project's`);
    if (view.images.some((i) => !i.loaded)) ui.warn(`its sandbox's images wait: retake project trust ${view.project} --images loads them`);
    return EXIT.ok;
  }
  await personsYes(ui, `Trust ${view.project}: let its ${view.files.length} code files, as listed, run on this machine?`, `trusting ${view.project}`);
  const t = await engine.projects.trust(view.project, view);
  // Trusted now: a load that fails says so, the trust stays (the images wait).
  let load: ImagesLoad | undefined;
  if (view.images.length && opts.images !== false) {
    try {
      load = await engine.projects.loadImages(view.project, { onProgress: (l) => ui.setStatus(l) });
    } catch (e) {
      load = { project: view.project, loaded: [], overrides: [], missing: [], notes: [], waiting: `${errorMessage(e)} — the images wait: retake project trust ${view.project} --images loads them` };
    }
    ui.clearStatus();
  }
  if (opts.json) ui.result(JSON.stringify(load ? { ...t, images_load: load } : t, null, 2));
  else {
    ui.ok(`${t.project} is trusted: its hooks, sandboxes and components run as any project's (its saved sessions, environment variables and keychain items are this machine's to provide)`);
    if (load) printLoad(ui, load);
    else if (view.images.length) ui.warn(`its sandbox's images wait: retake project trust ${t.project} --images loads them`);
  }
  return EXIT.ok;
}
