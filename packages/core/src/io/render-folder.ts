/**
 * The one reader of renders/: each `*.json` of the folder as a regular file within its cap, parsed at the boundary
 * (core render-record.ts) into a record or a typed problem — never a throw on a file someone else wrote. A file met
 * in a listing is read without following a symbolic link (decision i of the lot: a linked record is said, not read);
 * a file a person named at a terminal is read through links and whatever its size.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { isRenderId } from '../id-grammar.js';
import { projectRef } from '../layout.js';
import { printableText } from '../printable.js';
import { byIdProblem, latestNamedRender, namedRenderProblem, parseRenderRecord, renamedProblem, renderNotWords, renderOutputName, renderRecordsOf, renderUnreadDetail } from '../render-record.js';
import type { NamedRenderPick, RenderEntry, RenderLatestPick, RenderRead, StoredRenderRecord, UnknownStatusRender, WithStoredPlan } from '../render-record.js';
import { NODE_RECORD_FS } from './record-file.js';
import type { RecordFs } from './record-file.js';

// The file seam of the readers (a test, or U6's own file system, hands its own): every read of a record below takes it.
export { NODE_RECORD_FS } from './record-file.js';
export type { RecordFileText, RecordFs } from './record-file.js';

/** A record met in a listing bigger than this is not read (it is not one the tool wrote). */
export const RENDER_RECORD_MAX = 16 * 1024 * 1024;

export interface RenderFolderOptions {
  fs?: RecordFs;
  /** `refuse` (default): a record that is a link is `not-a-file`, `link: true`. `follow`: read through it. */
  links?: 'refuse' | 'follow';
}

async function readEntry(fs: RecordFs, file: string, name: string, o: { max: number; follow: boolean }): Promise<RenderEntry> {
  const r = await fs.text(file, o);
  if (!r.ok) return { name, link: r.link, read: { ok: false, problem: r.problem } };
  let value: unknown;
  try {
    value = JSON.parse(r.text);
  } catch {
    return { name, link: r.link, read: { ok: false, problem: 'not-json' } };
  }
  const read: RenderRead = parseRenderRecord(value);
  return { name, link: r.link, read };
}

/**
 * Every `*.json` of `dir`, dot files aside, in the folder's order (the rules order them). `only`: asked with each
 * file's name (without `.json`) BEFORE anything is read — a file it refuses costs nothing. Never throws; a missing
 * folder holds none.
 */
export async function readRendersFolder(dir: string, o: RenderFolderOptions & { only?: (name: string) => boolean } = {}): Promise<RenderEntry[]> {
  const fs = o.fs ?? NODE_RECORD_FS;
  let files: string[];
  try {
    files = (await fs.names(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const out: RenderEntry[] = [];
  for (const f of files) {
    const name = f.slice(0, -5);
    if (o.only && !o.only(name)) continue;
    out.push(await readEntry(fs, join(dir, f), name, { max: RENDER_RECORD_MAX, follow: o.links === 'follow' }));
  }
  return out;
}

/** One entry of a listing by its name: `dir`/`name`.json under a listing's rules (its cap; no link followed unless asked). */
export function readListedRender(dir: string, name: string, o: RenderFolderOptions = {}): Promise<RenderEntry> {
  return readEntry(o.fs ?? NODE_RECORD_FS, join(dir, `${name}.json`), name, { max: RENDER_RECORD_MAX, follow: o.links === 'follow' });
}

/** A record file a person named at a terminal: read through links, whatever its size. */
export function readNamedRender(file: string, o: { fs?: RecordFs } = {}): Promise<RenderEntry> {
  return readEntry(o.fs ?? NODE_RECORD_FS, file, basename(file).replace(/\.json$/, ''), { max: NO_CAP, follow: true });
}

/** A render someone names is read whole (a listing has its cap). */
const NO_CAP = Number.POSITIVE_INFINITY;

/**
 * renders/<id>.json read BY ITS ID (MCP, the Studio, a job): the record's own file, never through a link (as a listing
 * reads it), whatever its size (a render someone names is read as it always was: no cap). What is read is judged on the
 * open descriptor (readPlainFile, through the seam's not-followed read).
 */
export function readRenderById(dir: string, id: string, o: { fs?: RecordFs } = {}): Promise<RenderEntry> {
  return readEntry(o.fs ?? NODE_RECORD_FS, join(dir, `${id}.json`), id, { max: NO_CAP, follow: false });
}

// ── A render someone names at a terminal (or by its id, through an export or a review job) ──────────────────────

/** What a render named is wanted for: the sentences end "nothing to export" / "nothing to review". */
export type NamedRenderVerb = 'export' | 'review';

/**
 * A render someone named, found: the entry read (`name`: the file's name), the record file, the record (of a status
 * Retake writes or not — what the use does with its status is the caller's; its plan is there), whether its record
 * says another id than its file's name, the name its exports / review folder takes (core renderOutputName), and —
 * with `latest` — what `latest` passed over on the way.
 */
export interface NamedRenderFound {
  entry: RenderEntry;
  file: string;
  record: WithStoredPlan<StoredRenderRecord | UnknownStatusRender>;
  renamed: boolean;
  output: string;
  latest?: RenderLatestPick<NamedRenderPick>;
}

export type NamedRenderFind = { ok: true; render: NamedRenderFound } | { ok: false; message: string };

/** A path of renders/ as `renders/<file>`, any other as it is. */
function refOf(dir: string, file: string): string {
  return resolve(dirname(file)) === resolve(dir) ? projectRef('renders', basename(file)) : file;
}

/** How a sentence names the render of a record: its id when that is a render id or its file's name, else its file's name. Printable. */
function labelOf(entry: RenderEntry, id: string): string {
  return printableText(id !== '' && (isRenderId(id) || id === entry.name) ? id : entry.name);
}

/** What the id a record says is, in words: the id when it is a render id, else fixed words (it is a text anyone could write). */
function saysWords(id: string): string {
  return id === '' ? 'says an empty id' : isRenderId(id) ? `says it is ${id}` : 'says an id that is no render id';
}

/**
 * The render `arg` names in `dir` (renders/), for a use (`verb`):
 * - `latest` (`trust` author): the newest succeeded complete record of renders/, of `scenario` when given, whatever
 *   its file is called (core latestNamedRender) — then read as named BY ITS FILE, never looked up again by the id it says;
 * - `trust: 'mcp'`: a render id only, its own file, no link followed, a record that says another id refused;
 * - else a render id (renders/<arg>.json), or a path to a record (.json) or to a video (the .json beside it), read
 *   through links and whatever its size.
 * A file that is there is never "not found": it is a record, or one sentence says what it is. A record that lacks its
 * plan is refused, naming it; one that lacks its scenario or its creation time works with what it has. A record
 * renamed by hand works, but for one case (decision iv, core renamedProblem): the video it names is now another
 * render's. `slug`: the project's (the sentence of an empty `latest`). `videoAlone`: a video named without a record
 * beside it is said as that (a review needs the plan).
 */
export async function findNamedRender(
  dir: string,
  arg: string,
  o: { verb: NamedRenderVerb; slug: string; scenario?: string; trust?: 'author' | 'mcp'; videoAlone?: boolean; fs?: RecordFs },
): Promise<NamedRenderFind> {
  const fs = o.fs ?? NODE_RECORD_FS;
  const fail = (message: string): NamedRenderFind => ({ ok: false, message });
  const there = (e: RenderEntry): boolean => e.read.ok || e.read.problem !== 'missing';
  const notFound = async (): Promise<NamedRenderFind> => {
    const ids = renderRecordsOf(await readRendersFolder(dir, { fs })).map((r) => printableText(r.id));
    return fail(`render "${arg}" not found in ${dir}${ids.length ? ` (renders: ${ids.slice(-8).join(', ')})` : ''}; use a render id, a .json/.mp4 path or "latest"`);
  };
  if (o.trust === 'mcp') {
    if (!isRenderId(arg)) return fail(`render "${arg}": through MCP a render is named by its id`);
    const entry = await readRenderById(dir, arg, { fs });
    if (!there(entry)) return notFound();
    // The by-id rule, as the engine's (core byIdProblem): a link, a newer format, a file that does not read, another id.
    const problem = byIdProblem(entry, arg);
    if (problem) return fail(problem.message);
    return judge(fs, dir, entry, join(dir, `${arg}.json`), projectRef('renders', `${arg}.json`), o.verb, false, `render "${arg}": `);
  }
  if (arg === 'latest') {
    const latest = latestNamedRender(await readRendersFolder(dir, { fs }), o.scenario !== undefined ? { scenario: o.scenario } : {});
    if (!latest.pick) {
      const n = latest.passed.length + latest.passed_more;
      const why = latest.reasons.map((r) => `${renderNotWords(r.why)} (${r.count})`).join(', ');
      return fail(`no render${o.scenario ? ` of scenario "${o.scenario}"` : ''} in ${dir}: render one with \`retake render ${o.slug} ${o.scenario ?? '<scenario>'}\`${n ? ` — ${n} file${n === 1 ? '' : 's'} of renders/ passed over: ${why}` : ''}`);
    }
    const file = join(dir, `${latest.pick.entry.name}.json`);
    const found = await judge(fs, dir, latest.pick.entry, file, file, o.verb, true);
    return found.ok ? { ok: true, render: { ...found.render, latest } } : found;
  }
  const byId = join(dir, `${arg}.json`);
  if (!/[\\/]/.test(arg)) {
    const entry = await readNamedRender(byId, { fs });
    if (there(entry)) return judge(fs, dir, entry, byId, byId, o.verb, true);
  }
  if (isAbsolute(arg) || arg.startsWith('.') || /[\\/]/.test(arg) || /\.(json|mp4)$/.test(arg)) {
    const file = resolve(arg);
    const json = extname(file) === '.json' ? file : join(dirname(file), `${basename(file, extname(file))}.json`);
    const entry = await readNamedRender(json, { fs });
    if (there(entry)) return judge(fs, dir, entry, json, json, o.verb, true);
    // (A video is no record: whether it is there is asked of the disk, not of the records' seam.)
    if (o.videoAlone && existsSync(file)) return fail(`${file} has no render record next to it (${basename(json)}): review needs the plan the video was rendered from`);
  }
  return notFound();
}

/**
 * The names among `names` that ANOTHER file of renders/ answers to — a folder of exports/ or review/ of that name is
 * that file's render's —, compared as the file system compares names: what it opens for `renders/<name>.json` (case
 * and its own Unicode normalisation), and, beside that, the names of the folder compared after normalisation (NFC).
 * `file`: the record file named (never "another" file, whatever path named it).
 */
async function namesTaken(fs: RecordFs, dir: string, file: string, names: readonly string[]): Promise<Set<string>> {
  const identity = fs.identity ? (f: string) => fs.identity!(f) : null;
  const own = identity ? await identity(file) : null;
  // Without an identity: the named file is the entry of renders/ of its name when it lies in renders/.
  const ownName = resolve(dirname(file)) === resolve(dir) ? basename(file) : null;
  const listed = (await fs.names(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const other = async (f: string): Promise<boolean> => {
    if (!identity) return f !== ownName;
    const at = await identity(join(dir, f));
    return at !== null && at !== own;
  };
  const taken = new Set<string>();
  for (const name of names) {
    if (name === '' || /[\\/\0]/.test(name)) continue;
    // What the file system itself opens for that name (its case and its own normalisation) …
    if (identity && (await other(`${name}.json`))) {
      taken.add(name);
      continue;
    }
    // … and a name of the folder that is the same text after normalisation.
    const nfc = name.normalize('NFC');
    for (const f of listed) if (f.slice(0, -5).normalize('NFC') === nfc && (await other(f))) taken.add(name);
  }
  return taken;
}

/**
 * A record file that was there, judged for a use: a record (its plan there), or one sentence. `renamedOk`: a record
 * that says another id may be used (a terminal). `by`: how a sentence opens when the render was named by its id.
 */
async function judge(fs: RecordFs, dir: string, entry: RenderEntry, file: string, shown: string, verb: NamedRenderVerb, renamedOk: boolean, by = ''): Promise<NamedRenderFind> {
  const r = entry.read;
  let record: StoredRenderRecord | UnknownStatusRender;
  if (r.ok) record = r.value;
  else if (r.problem === 'unknown-status') record = r.record;
  else if (r.problem === 'newer-format') return { ok: false, message: by ? `${by}${r.message}` : `${shown}: ${r.message}` };
  else {
    const detail = renderUnreadDetail(r);
    return { ok: false, message: `${by}${shown} does not read as a render record${detail ? ` (${detail})` : ''}` };
  }
  const label = labelOf(entry, record.id);
  const lack = namedRenderProblem(entry, ['plan']);
  if (lack) return { ok: false, message: `render ${label} has no plan (${shown}): nothing to ${verb}` };
  const renamed = record.id !== entry.name;
  // Its folder of exports/ or review/ is never one another file of renders/ owns (core renderOutputName).
  const output = renderOutputName(entry, record.id, await namesTaken(fs, dir, file, [record.id, entry.name]));
  if (output === null) {
    return { ok: false, message: `${printableText(shown)} ${saysWords(record.id)}, and no folder of ${verb === 'export' ? 'exports' : 'review'}/ can take its name: another file of renders/ has it, or it is no folder name — nothing to ${verb}` };
  }
  if (renamed && renamedOk && record.file !== '') {
    // Decision iv: the video it names is now the video of ANOTHER render (the record beside that video).
    const beside = join(dirname(record.file), `${basename(record.file, extname(record.file))}.json`);
    if (resolve(beside) !== resolve(file)) {
      const other = await readNamedRender(beside, { fs });
      const problem = other.read.ok || other.read.problem !== 'missing' ? renamedProblem(entry, other) : null;
      if (problem) {
        return { ok: false, message: `${printableText(refOf(dir, file))} ${saysWords(record.id)}, and ${printableText(refOf(dir, record.file))} is now the video of another render: nothing to ${verb} — correct "file" in the record, or render again with --out` };
      }
    }
  }
  // (Its plan is there: namedRenderProblem refused a record that lacks it above.)
  return { ok: true, render: { entry, file, record: record as WithStoredPlan<StoredRenderRecord | UnknownStatusRender>, renamed, output } };
}

/**
 * The line a terminal says of a render it was named whose record says another id than its file's name (none
 * otherwise), and — when its folder of exports/ and review/ is named after its file instead — that name. Fixed words,
 * a render id and file names made printable — never another text of the file.
 */
export function renamedRenderLine(dir: string, render: { file: string; renamed: boolean; record: { id: string }; output?: string }): string | null {
  if (!render.renamed) return null;
  const head = `${printableText(refOf(dir, render.file))} ${saysWords(render.record.id)}`;
  // Named after its file: the id is no folder name, or another file of renders/ answers to it.
  return render.output !== undefined && render.output !== render.record.id ? `${head} — its exports and review are named ${printableText(render.output)}` : head;
}

/**
 * The lines a terminal says of what its `latest` passed over (none when nothing): the newer files of renders/ it did
 * not take, each with the fixed words of its reason — the first five named (printable), then a count —, and the files
 * that say nothing readable (a count).
 */
export function latestRenderLines(latest: Pick<RenderLatestPick<unknown>, 'passed' | 'passed_more' | 'not_considered'> | undefined): string[] {
  if (!latest) return [];
  const lines: string[] = [];
  const n = latest.passed.length + latest.passed_more;
  if (n > 0) {
    const list = latest.passed.map((p) => `${printableText(p.file)}: ${renderNotWords(p.why)}`);
    if (latest.passed_more > 0) list.push(`and ${latest.passed_more} more`);
    lines.push(`${n} newer file${n === 1 ? '' : 's'} of renders/ passed over — ${list.join('; ')}`);
  }
  const w = latest.not_considered;
  if (w > 0) lines.push(`${w} file${w === 1 ? '' : 's'} of renders/ ${w === 1 ? 'does' : 'do'} not read: not considered`);
  return lines;
}
