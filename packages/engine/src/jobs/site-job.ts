/**
 * `site` jobs (L3.5, R-MCP-12): template_from_site through the worker. A clean ephemeral Chromium opens one public
 * page through the worker's CONNECT proxy (runner-web site/), and the colours by role, font family names, logo
 * candidates (PNGs made by Chromium) and a screenshot go to <workspace>/.demo-studio/site/<site_id>/ (site.json,
 * screenshot.jpg, logo-<n>.png; the newest 10 kept). The result carries a draft brand input for
 * template_create_from_brand (`logo: site:<id>/logo-1`) and the template.yaml it would make — nothing is written to
 * templates/ here.
 *
 * Trust: the URL is checked at submit and again by the worker (core parseSiteUrl: https, default port, no userinfo,
 * query or fragment, a public-looking DNS name), and must be neither a page of an environment of a workspace project
 * (filmed through runs and page_inspect, with their access rules) nor a protected host. Through MCP a human approves
 * the exact canonical URL (elicitation); the approval — fingerprint sha256("site\n" + href) — is signed at enqueue
 * (signing.ts) over the whole input. The worker refuses the WHOLE job unless a verified approval of that fingerprint
 * is there, whoever `submitted_by` names: `studio theme from-site` runs in-process and never queues one, so a site job
 * without it is a forgery (a job.json written by something else, or an input edited after it was signed).
 *
 * The folder: the worker makes <id>/ itself, new (an existing one — planted — is refused), with `.demo-studio/` and
 * `site/` real folders of the workspace (never links); the extraction writes each file under a temporary name and
 * renames it into place, so nothing is written through a link.
 *
 * Read back (template_from_site, job_status), site.json is a file of the workspace: only values of the tool's own
 * shape (hex colours, numbers, the candidate files that are plain files of the right type and size) are kept outside
 * `untrusted`; every string goes under it. The job's own warnings are shown as the tool's text only when they are one
 * of the tool's sentences (`isSiteWarning`); anything else in a job.json goes under `untrusted`.
 */
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  BRAND_IMAGE_MAX_BYTES,
  JOB_INPUT_VERSION,
  SITE_ID_RE,
  TEMPLATE_FILE,
  insideFolder,
  listProjects,
  loadTemplate,
  normalizeHost,
  parseSiteUrl,
  parseYaml,
  realPathOf,
  resolveEnvironment,
  siteApprovalFingerprint,
  siteThemeName,
  unsafeTestResolve,
} from '@demo-studio/core';
import type { JobApproval, LoadedProject, SiteJobInput, SiteUrl, TemplateFile, WorkspaceConfig } from '@demo-studio/core';
import type { SiteReport } from '@demo-studio/runner-web';
import { takeSiteApproval } from '../approvals.js';
import type { Approver } from '../approvals.js';
import { components } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import { protectedHostOf, workspaceProtectedHosts } from '../protected-hosts.js';
import { openProject } from '../workspace.js';
import { newJobId } from './ids.js';
import { FileJobQueue } from './queue.js';
import type { SubmitContext } from './run-job.js';
import { verifiedApprovals } from './signing.js';
import type { JobEventBody, JobProgress, JobRecord, SiteCandidateResult, SiteJobResult } from './types.js';

/** Site extractions kept per workspace (the newest). */
export const SITE_KEEP = 10;
const HEX = /^#[0-9a-f]{6}$/;
const CANDIDATE_FILE = /^logo-[1-6]\.png$/;
const SOURCES = ['header-img', 'header-svg', 'page-img', 'page-svg', 'icon', 'og-image'] as const;
/** A screenshot read back, at most (a 1440×900 JPEG at quality 80 is far below). */
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** <workspace>/.demo-studio/site */
export function siteRoot(ws: WorkspaceConfig): string {
  return join(ws.root, '.demo-studio', 'site');
}

/** <workspace>/.demo-studio/site/<id> (the id checked: never a path). */
export function siteDir(ws: WorkspaceConfig, id: string): string {
  if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new EngineError('invalid', `invalid site extraction id "${String(id)}": s_ followed by 26 characters (template_from_site returns it), never a path`);
  return join(siteRoot(ws), id);
}

export function newSiteId(): string {
  return `s_${newJobId().slice(2)}`;
}

/**
 * Make <workspace>/.demo-studio/site/<id>/ for one extraction: `.demo-studio` and `site` made when missing and required
 * to be real folders (a link or a file there is refused), inside the workspace once links are followed, and <id> made
 * NEW (non-recursive: an existing one was planted, refused). Returns the folder.
 */
export async function makeSiteDir(ws: WorkspaceConfig, id: string): Promise<string> {
  const dir = siteDir(ws, id);
  let parent = ws.root;
  for (const seg of ['.demo-studio', 'site']) {
    parent = join(parent, seg);
    await mkdir(parent).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const st = await lstat(parent);
    if (!st.isDirectory()) throw new EngineError('refused', `${parent} is not a folder (a link or a file): site extractions are written only into plain folders of the workspace — remove it`);
  }
  if (!insideFolder(realPathOf(resolve(ws.root)), realPathOf(parent))) throw new EngineError('refused', `${parent} leaves the workspace: site extractions stay in it`);
  try {
    await mkdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new EngineError('refused', `${dir} exists already: an extraction's folder is made by the extraction itself, never reused`);
    throw e;
  }
  return dir;
}

/** Whether `.demo-studio/`, `site/` and <id>/ are real folders (no link on the way to the extraction's files). */
function plainSiteFolders(ws: WorkspaceConfig, id: string): boolean {
  let p = ws.root;
  for (const seg of ['.demo-studio', 'site', id]) {
    p = join(p, seg);
    try {
      if (!lstatSync(p).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether `file` is a plain file (not a link) of at most `max` bytes whose first bytes are `magic`. */
function plainFileOf(file: string, max: number, magic: Buffer): boolean {
  let fd: number | undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > max || st.size < magic.length) return false;
    fd = openSync(file, 'r');
    const head = Buffer.alloc(magic.length);
    readSync(fd, head, 0, magic.length, 0);
    return head.equals(magic);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_MAGIC = Buffer.from('ffd8ff', 'hex');

/** The tool's own warning sentences of a site report (anything else in a job.json is data). */
const SITE_WARNINGS: RegExp[] = [
  /^the unsafe test resolver is set \(DEMO_STUDIO_UNSAFE_TEST_RESOLVE: [a-z0-9.-]+(?:, [a-z0-9.-]+)*\): those names reach loopback ports, and the browser accepts any certificate for every host of this extraction — never set it outside tests$/,
  /^the page did not finish loading in 20 s: read as it was$/,
  /^no logo candidate could be made: give the logo as a file \(brand\/\)$/,
  /^\d{1,6} connection\(s\) closed by a cap \(bytes, idle or life time\)$/,
  /^the page redirects to another host \(its URL is the last of untrusted\.redirect_chain\): only [a-z0-9.-]+ and its www \/ apex sibling are read — that URL is extracted only once the user approves it \(template_from_site with it\)$/,
];

/** Whether a warning is one of the tool's sentences (shown as its text), not something else written into a job file. */
export function isSiteWarning(w: unknown): w is string {
  return typeof w === 'string' && w.length <= 1000 && SITE_WARNINGS.some((re) => re.test(w));
}

/** Quote a word for a shell command line when it needs it. */
function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `studio theme from-site` command a human runs for the same extraction. */
export function siteCommandLine(cli: string, href: string): string {
  return `${cli} theme from-site ${q(href)}`;
}

/** The URL checked (core parseSiteUrl, with the unsafe test resolver's names when it is set). EngineError refused otherwise. */
export function checkSiteUrl(url: string, fix?: string): SiteUrl {
  const r = parseSiteUrl(url, unsafeTestResolve().map);
  if (!r.ok) throw new EngineError('refused', `url: ${r.problem}`, fix ? { fix } : {});
  return r.url;
}

/**
 * Where the host is an environment page of a workspace project, or a protected host (production / read-only, read_only
 * host patterns): each as a sentence. A project that does not load contributes nothing.
 */
export async function siteHostConflicts(ws: WorkspaceConfig, host: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of await listProjects(ws.root)) {
    let project: LoadedProject;
    try {
      project = await openProject(ws, p.dir);
    } catch {
      continue;
    }
    for (const name of Object.keys(project.config.environments ?? {})) {
      let pages: Record<string, string>;
      try {
        pages = resolveEnvironment(project, name).pages;
      } catch {
        continue;
      }
      for (const [page, url] of Object.entries(pages)) {
        let h: string;
        try {
          h = normalizeHost(new URL(url).hostname);
        } catch {
          continue;
        }
        if (h === host) out.push(`page ${page} of environment ${name} of project ${p.slug}`);
      }
    }
  }
  const hit = protectedHostOf(`https://${host}/`, await workspaceProtectedHosts(ws));
  if (hit) out.push(`a protected host of ${hit.production ? 'production' : 'read-only'} environment ${hit.env} of project ${hit.project}`);
  return [...new Set(out)];
}

/** The extractions whose job is queued or running (their folders are in use). */
async function activeSites(root: string): Promise<string[]> {
  const jobs = await new FileJobQueue(root).list({ kinds: ['site'], states: ['queued', 'running'], limit: 10_000 });
  return jobs.flatMap((j) => (j.input.kind === 'site' ? [j.input.site_id] : []));
}

/** Keep the newest `keep` extraction folders (ids sort by creation); `except` and folders of active jobs never removed. */
export async function pruneSites(ws: WorkspaceConfig, keep = SITE_KEEP, except: readonly string[] = []): Promise<string[]> {
  const active = await activeSites(ws.root).catch(() => null);
  if (active === null) return [];
  const spared = new Set([...except, ...active]);
  // Never through a link: .demo-studio/ and site/ must be real folders.
  if (!(await lstat(join(ws.root, '.demo-studio')).catch(() => null))?.isDirectory() || !(await lstat(siteRoot(ws)).catch(() => null))?.isDirectory()) return [];
  let names: string[];
  try {
    names = (await readdir(siteRoot(ws), { withFileTypes: true })).filter((e) => e.isDirectory() && SITE_ID_RE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const old = names.sort().reverse().slice(keep).filter((n) => !spared.has(n));
  for (const n of old) await rm(join(siteRoot(ws), n), { recursive: true, force: true }).catch(() => undefined);
  return old;
}

export interface SiteSubmitted {
  job: JobRecord;
  site_id: string;
  url: string;
  host: string;
  unicode_host: string;
  dir: string;
  warnings: string[];
}

/**
 * Check, ask the human (through `approver`), reserve the folder and queue a `site` job. Throws refused (URL, an
 * environment or protected host, a decline), needs_approval (no way to ask).
 */
export async function submitSiteJob(ctx: SubmitContext, req: { url: string }, approver: Approver | undefined): Promise<SiteSubmitted> {
  const first = checkSiteUrl(req.url);
  const fix = siteCommandLine(ctx.cli, first.href);
  const conflicts = await siteHostConflicts(ctx.ws, first.host);
  if (conflicts.length) {
    throw new EngineError('refused', `url: ${first.host} is ${conflicts.join('; ')}: an environment of a project is filmed through runs and page_inspect (with its access rules), never extracted as a site`, {
      fix: 'page_inspect {project, url} reads an environment page',
    });
  }
  const approvals: JobApproval[] = await takeSiteApproval(
    { what: 'site extraction', href: first.href, host: first.host, unicode_host: first.unicode_host, fingerprint: siteApprovalFingerprint(first.href), fix },
    approver,
    ctx.client,
  );
  // The folder is made by the worker (makeSiteDir), new: nothing is reserved on disk here.
  const id = newSiteId();
  const dir = siteDir(ctx.ws, id);
  await pruneSites(ctx.ws, SITE_KEEP, [id]);
  const input: SiteJobInput = { version: JOB_INPUT_VERSION, kind: 'site', site_id: id, url: first.href, submitted_by: ctx.client, approvals };
  const job = await ctx.queue.enqueue(input);
  const warnings = unsafeTestResolve().map.size ? ['the unsafe test resolver (DEMO_STUDIO_UNSAFE_TEST_RESOLVE) is set in this server\'s environment'] : [];
  return { job, site_id: id, url: first.href, host: first.host, unicode_host: first.unicode_host, dir, warnings };
}

export interface SiteJobContext {
  ws: WorkspaceConfig;
  cli: string;
  input: SiteJobInput;
  signal: AbortSignal;
  event(e: JobEventBody): void;
  progress(p: JobProgress): void;
}

/** Whether the job carries a verified (signed) human approval of exactly its URL. */
export async function siteApproved(input: SiteJobInput): Promise<boolean> {
  const { approvals } = await verifiedApprovals(input);
  const want = siteApprovalFingerprint(input.url);
  return approvals.some((a) => a.fingerprint === want);
}

/** A draft brand input and the template.yaml it would make, from an extraction's colours and first candidate. */
export async function siteDraft(ws: WorkspaceConfig, siteId: string, view: Pick<SiteJobResult, 'host' | 'palette' | 'candidates' | 'status'>): Promise<SiteJobResult['draft']> {
  if (view.status !== 'ok' || !view.palette) return null;
  const { roles, swatches } = view.palette;
  const lib = await components();
  const accent = roles.accent ?? [...swatches].map((s) => s.hex).filter((h) => h !== roles.paper && h !== roles.text)[0] ?? roles.text;
  const tone = lib.paletteTone(roles.paper);
  const baseName = tone === 'dark' ? 'motion' : 'editorial';
  let base;
  try {
    base = await loadTemplate(baseName, ws.root);
  } catch {
    return null;
  }
  const baseFile = parseYaml(await readFile(join(base.dir, TEMPLATE_FILE), 'utf8')).value as TemplateFile;
  const colors = { accent, text: roles.text, paper: roles.paper, ...(roles.dark && roles.dark !== roles.paper ? { dark: roles.dark } : {}) };
  const palette = lib.derivePalette({ ...colors, adjust: true, tone });
  const name = siteThemeName(view.host);
  const logo = view.candidates[0]?.ref;
  const generated = lib.generateThemeFile({
    base: baseFile,
    baseName,
    name,
    palette,
    logo: 'logo.png',
    fonts: { display: `fonts/${basename(base.assets.display)}`, body: base.assets.body.map((b) => `fonts/${basename(b)}`) },
    brand: { url: view.host },
    date: new Date().toISOString().slice(0, 10),
  });
  return { base: baseName, brand_input: { name, base: baseName, colors, ...(logo ? { logo } : {}), brand: { url: view.host } }, template_yaml: generated.yaml };
}

const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
const ratio = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, Math.round(v * 1000) / 1000)) : 0);
const contrastOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(21, Math.round(v * 100) / 100)) : 1);
const hexOr = <T>(v: unknown, d: T): string | T => (typeof v === 'string' && HEX.test(v) ? v : d);
const counts = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}).filter(([k]) => /^[a-z_]{1,20}$/.test(k)).map(([k, n]) => [k, int(n)]));

/**
 * An extraction as a result shows it, from its report (in memory, or site.json read back): hex colours, numbers,
 * enums and the candidate files that exist kept; the rest under `untrusted` (page strings, and anything of another
 * shape). `url` and `host` come from the job's signed input, never from the file.
 */
export function siteView(ws: WorkspaceConfig, siteId: string, url: SiteUrl, raw: unknown): Omit<SiteJobResult, 'kind' | 'draft'> {
  const dir = siteDir(ws, siteId);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SiteReport> & Record<string, unknown>;
  const pal = r.palette && typeof r.palette === 'object' ? r.palette : null;
  const roles = pal?.roles;
  const paper = hexOr(roles?.paper, null);
  const text = hexOr(roles?.text, null);
  const palette =
    paper && text
      ? {
          roles: { paper, text, accent: hexOr(roles?.accent, null), dark: hexOr(roles?.dark, null) },
          swatches: (Array.isArray(pal?.swatches) ? pal.swatches : [])
            .slice(0, 8)
            .filter((s) => s && typeof s === 'object' && typeof (s as { hex?: unknown }).hex === 'string' && HEX.test(s.hex))
            .map((s) => ({ hex: s.hex, background: ratio(s.background), text: ratio(s.text), interactive: ratio(s.interactive), contrast: { paper: contrastOf(s.contrast?.paper), text: contrastOf(s.contrast?.text) } })),
        }
      : null;
  const candidates: SiteCandidateResult[] = [];
  // Files are kept only when they are plain files of their type (a link, a folder, a large or other file goes).
  const plain = plainSiteFolders(ws, siteId);
  for (const c of plain && Array.isArray(r.candidates) ? r.candidates.slice(0, 6) : []) {
    if (!c || typeof c !== 'object' || typeof c.file !== 'string' || !CANDIDATE_FILE.test(c.file)) continue;
    const file = join(dir, c.file);
    if (!plainFileOf(file, BRAND_IMAGE_MAX_BYTES, PNG_MAGIC)) continue;
    candidates.push({
      ref: `site:${siteId}/${c.file.replace(/\.png$/, '')}`,
      file,
      source: (SOURCES as readonly string[]).includes(c.source as string) ? (c.source as SiteCandidateResult['source']) : 'page-img',
      width: int(c.width, 8192),
      height: int(c.height, 8192),
    });
  }
  const net = (r.network && typeof r.network === 'object' ? r.network : {}) as Partial<SiteReport['network']>;
  const untrusted = r.untrusted && typeof r.untrusted === 'object' ? { ...(r.untrusted as Record<string, unknown>) } : {};
  return {
    site_id: siteId,
    dir,
    url: url.href,
    host: url.host,
    status: r.status === 'ok' ? 'ok' : 'failed',
    http_status: typeof r.http_status === 'number' ? int(r.http_status, 999) : null,
    redirects: int(r.redirects, 10),
    palette,
    candidates,
    screenshot: plain && r.screenshot === 'screenshot.jpg' && plainFileOf(join(dir, 'screenshot.jpg'), SCREENSHOT_MAX_BYTES, JPEG_MAGIC) ? join(dir, 'screenshot.jpg') : null,
    network: { requests: int(net.requests), blocked: counts(net.blocked), tunnels: int(net.tunnels), bytes: int(net.bytes), refused: counts(net.refused), capped: int(net.capped) },
    warnings: [],
    // The report's own warnings are the tool's text when it is fresh; read back from a file they are data like the rest.
    untrusted: { ...untrusted, ...(Array.isArray(r.warnings) && r.warnings.length ? { report_warnings: r.warnings.filter((w) => typeof w === 'string').slice(0, 10) } : {}) },
  };
}

/** Execute a `site` job: the approval and the URL checked again, the extraction, the draft, the pruning. */
export async function executeSiteJob(ctx: SiteJobContext): Promise<SiteJobResult> {
  const { input } = ctx;
  if (!(await siteApproved(input))) {
    throw new EngineError('refused', `refused without running: a site job runs only with a human's approval of its exact URL, signed when it was submitted — this one has none (a job file not written by a submit, or edited since)`, {
      fix: siteCommandLine(ctx.cli, input.url),
    });
  }
  const url = checkSiteUrl(input.url, siteCommandLine(ctx.cli, input.url));
  const conflicts = await siteHostConflicts(ctx.ws, url.host);
  if (conflicts.length) throw new EngineError('refused', `url: ${url.host} is ${conflicts.join('; ')}: never extracted as a site`);
  const dir = await makeSiteDir(ctx.ws, input.site_id);
  const test = unsafeTestResolve();
  if (test.map.size) ctx.event({ type: 'log', level: 'warn', message: `the unsafe test resolver is set: ${[...test.map.keys()].join(', ')} reach loopback ports` });
  if (test.ignored.length) ctx.event({ type: 'log', level: 'warn', message: `DEMO_STUDIO_UNSAFE_TEST_RESOLVE entries ignored (not <name>.test=127.0.0.1:<port>): ${test.ignored.length}` });
  const { extractSite } = await import('@demo-studio/runner-web');
  const steps = ['redirects', 'loading', 'reading', 'logos', 'writing'];
  let report: SiteReport;
  try {
    report = await extractSite({
      url: url.href,
      host: url.host,
      outDir: dir,
      signal: ctx.signal,
      testResolve: test.map,
      log: (m) => ctx.event({ type: 'log', level: 'info', message: m }),
      onPhase: (phase) => ctx.progress({ steps_done: steps.indexOf(phase), steps_total: steps.length, phase, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  await pruneSites(ctx.ws, SITE_KEEP, [input.site_id]);
  const view = siteView(ctx.ws, input.site_id, url, report);
  return { kind: 'site', ...view, warnings: report.warnings, untrusted: report.untrusted as Record<string, unknown>, draft: await siteDraft(ctx.ws, input.site_id, view) };
}

/**
 * `studio theme from-site <url>` (trust `author`): the same extraction in-process, never a job and never an approval
 * (the human typed the URL). The same network rules; an environment page or a protected host is a warning here.
 */
export async function extractSiteForAuthor(ws: WorkspaceConfig, rawUrl: string, o: { signal?: AbortSignal; onPhase?: (phase: string) => void } = {}): Promise<SiteJobResult> {
  const url = checkSiteUrl(rawUrl);
  const conflicts = await siteHostConflicts(ws, url.host);
  const id = newSiteId();
  const dir = await makeSiteDir(ws, id);
  const test = unsafeTestResolve();
  const { extractSite } = await import('@demo-studio/runner-web');
  let report: SiteReport;
  try {
    report = await extractSite({ url: url.href, host: url.host, outDir: dir, testResolve: test.map, ...(o.signal ? { signal: o.signal } : {}), ...(o.onPhase ? { onPhase: o.onPhase } : {}) });
  } catch (e) {
    throw toEngineError(e);
  }
  await pruneSites(ws, SITE_KEEP, [id]);
  const view = siteView(ws, id, url, report);
  const warnings = [...conflicts.map((c) => `${url.host} is ${c}: environments are filmed through runs, not extracted (done anyway: you typed it)`), ...report.warnings];
  return { kind: 'site', ...view, warnings, untrusted: report.untrusted as Record<string, unknown>, draft: await siteDraft(ws, id, view) };
}

/** An extraction read back from its folder (site.json as a file of the workspace), with its draft; null report when absent. */
export async function readSite(ws: WorkspaceConfig, siteId: string, url: string): Promise<{ dir: string; view: SiteJobResult | null }> {
  const dir = siteDir(ws, siteId);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, 'site.json'), 'utf8'));
  } catch {
    return { dir, view: null };
  }
  const parsed = parseSiteUrl(url, unsafeTestResolve().map);
  if (!parsed.ok) return { dir, view: null };
  const view = siteView(ws, siteId, parsed.url, raw);
  return { dir, view: { kind: 'site', ...view, draft: await siteDraft(ws, siteId, view) } };
}
