/**
 * The files a person's trust in an agent's hooks binds (L7.39), and the check of a run against them. Not an approval's
 * fingerprint (approval.ts hookFiles, unchanged): a fingerprint binds what work submitted through MCP may run; this
 * binds what a hook reads at a person's terminal, so it follows the shell further and sorts what it finds.
 *
 * - **Code** (bound strictly: changed, newly read or unreadable is not as trusted): an sql hook's file and its
 *   rollback's, a js hook's file; in a shell command (and its rollback), argv[0] when it has a slash, the script of an
 *   interpreter (`sh`, `bash`, `zsh`, `dash`, `node`, `deno`, `bun`, `tsx`, `python`, `python3`, `ruby`, `perl`, `php`,
 *   `source`, `.`), psql's `-f` / `--file`, and the target of a `<` redirect.
 * - **Data** (every other word of a shell command, the value of `--opt=value` and of a glued short option `-xVALUE`,
 *   and the hook's `env` values): bound when the file exists, so one that appears later is not looked at; never under
 *   Retake's own folders (`runs/`, `renders/`, `review/`, `exports/`, `.retake/`) nor the run's folder. Files a run
 *   writes belong under `{{run.dir}}`.
 * - A word is resolved against the hook's working folder and every folder an earlier `cd` / `pushd` of the same script
 *   names (each candidate that exists is bound); `sh -c "<script>"` is followed; a redirect glued to a word (`sh<x`) is
 *   split off; a target of `>` / `>>` is written, not read: not bound. Templates are rendered with the hook's vars only
 *   (`{{vars.x}}`, `{{x}}`): a word or working folder with any other token (`{{run.dir}}`, a secret, a response) is not
 *   bound. An absolute or `~` path is bound only inside the project or its workspace. A command looked up on PATH is
 *   not a file of the project.
 * - A file is hashed as a stream; a directory is no file; any other file that is not a regular one (a FIFO) is bound as
 *   unreadable.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { commandName, lexShell, nestedShellScript } from '@retake/core/base';
import { trustedFileChanges, UNREADABLE_FILE } from '@retake/core/hooks';
import type { HookContext, HookFileChange, TrustFilesPlace, TrustedHookFiles } from '@retake/core/hooks';
import { PROJECT_DIRS, STATE_DIR } from '@retake/core/project';
import { hookFileRefs } from '@retake/core/scenario';
import type { HookStep, ShellHookSpec } from '@retake/core/model';

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'node', 'deno', 'bun', 'tsx', 'python', 'python3', 'ruby', 'perl', 'php', 'source', '.']);
/** An interpreter's option after which comes code text, not a script file. */
const INLINE_CODE = new Set(['-c', '-e', '-p', '--eval', '--print', '-m']);
const WRAPPERS = new Set(['env', 'exec', 'nohup', 'time', 'command', 'nice']);
/** Retake's own folders of a project (core layout): what they hold is written by Retake and its runs. */
const RETAKE_FOLDERS = new Set<string>([PROJECT_DIRS.runs, PROJECT_DIRS.renders, PROJECT_DIRS.review, PROJECT_DIRS.exports, STATE_DIR]);
const INPUT = new Set(['<', '<>']);
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** A text with its `{{vars.x}}` / `{{x}}` tokens rendered from `vars`; undefined when it holds any other token. */
export function renderWithVars(text: string, vars: Record<string, unknown>): string | undefined {
  let ok = true;
  const out = text.replace(TOKEN, (_m, raw: string) => {
    const path = raw
      .trim()
      .replace(/\s*\.\s*/g, '.')
      .split('.');
    const keys = path[0] === 'vars' ? path.slice(1) : path;
    if (!keys.length || !Object.hasOwn(vars, keys[0] as string)) {
      ok = false;
      return '';
    }
    let v: unknown = vars;
    for (const k of keys) v = v && typeof v === 'object' && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
    if (v === undefined || v === null || typeof v === 'object') {
      ok = false;
      return '';
    }
    return String(v);
  });
  return ok ? out : undefined;
}

/** The sha256 of a file's bytes, read as a stream; `UNREADABLE_FILE` when it is not a regular file or cannot be read; undefined when there is none (or a directory). */
async function hashFile(abs: string): Promise<string | undefined> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? undefined : UNREADABLE_FILE;
  }
  if (st.isDirectory()) return undefined;
  if (!st.isFile()) return UNREADABLE_FILE;
  return new Promise((done) => {
    const h = createHash('sha256');
    createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('error', () => done(UNREADABLE_FILE))
      .on('end', () => done(h.digest('hex')));
  });
}

const inside = (abs: string, root: string | undefined) => root !== undefined && !relative(root, abs).startsWith('..') && !isAbsolute(relative(root, abs));

class Collector {
  readonly code: Record<string, string> = Object.create(null) as Record<string, string>;
  readonly data: Record<string, string> = Object.create(null) as Record<string, string>;
  /** What its command writes with a plain `>`: generated files. */
  readonly writes = new Set<string>();
  /** Every path it names in a code position, existing or not. */
  readonly codeNames = new Set<string>();
  /** Every path it names as data, existing or not (Retake's folders included). */
  readonly dataNames = new Set<string>();
  /** Data it names under Retake's own folders or the run's: compared only as a code writer's inputs (inputsAsCode). */
  readonly quiet: Record<string, string> = Object.create(null) as Record<string, string>;
  readonly #pending: Array<Promise<void>> = [];
  constructor(readonly p: TrustFilesPlace) {}

  key(abs: string): string {
    return relative(this.p.projectDir, abs).split(sep).join('/');
  }

  /** An explicit file (an sql / js `file:`): code, unreadable when it is missing. */
  explicit(ref: string, base: string): void {
    const text = ref.includes('{{') ? renderWithVars(ref, this.p.vars) : ref;
    if (text === undefined) return;
    const abs = resolve(base, text);
    this.#pending.push(
      hashFile(abs).then((h) => {
        this.code[this.key(abs)] = h ?? UNREADABLE_FILE;
      }),
    );
    this.codeNames.add(this.key(abs));
  }

  /** A word of a shell command, `code` or data, against the candidate folders. */
  word(raw: string, dirs: readonly string[], code: boolean): void {
    let w = raw.includes('{{') ? renderWithVars(raw, this.p.vars) : raw;
    if (w === undefined || w === '' || w.startsWith('-')) return;
    if (w === '~' || w.startsWith('~/')) w = homedir() + w.slice(1);
    let candidates: string[];
    if (isAbsolute(w)) {
      if (!inside(w, this.p.projectDir) && !inside(w, this.p.workspaceDir)) return;
      candidates = [resolve(w)];
    } else candidates = dirs.map((d) => resolve(d, w as string));
    for (const abs of new Set(candidates)) {
      const key = this.key(abs);
      if (code) this.codeNames.add(key);
      else this.dataNames.add(key);
      if (!code && ((inside(abs, this.p.projectDir) && RETAKE_FOLDERS.has(key.split('/')[0] as string)) || (this.p.runDir !== undefined && inside(abs, this.p.runDir)))) {
        this.#pending.push(
          hashFile(abs).then((h) => {
            if (h !== undefined) this.quiet[key] = h;
          }),
        );
        continue;
      }
      this.#pending.push(
        hashFile(abs).then((h) => {
          if (h === undefined) return;
          if (code) {
            this.code[key] = h;
            delete this.data[key];
          } else if (!Object.hasOwn(this.code, key)) this.data[key] = h;
        }),
      );
    }
  }

  /** The target of a plain `>`: each candidate, existing or not. */
  written(raw: string, dirs: readonly string[]): void {
    let w = raw.includes('{{') ? renderWithVars(raw, this.p.vars) : raw;
    if (w === undefined || w === '' || w.startsWith('&')) return;
    if (w === '~' || w.startsWith('~/')) w = homedir() + w.slice(1);
    if (isAbsolute(w)) {
      if (inside(w, this.p.projectDir) || inside(w, this.p.workspaceDir)) this.writes.add(this.key(resolve(w)));
      return;
    }
    for (const d of dirs) this.writes.add(this.key(resolve(d, w)));
  }

  async done(): Promise<TrustedHookFiles> {
    await Promise.all(this.#pending);
    return {
      code: this.code,
      data: this.data,
      ...(this.writes.size ? { generated: [...this.writes].sort() } : {}),
      ...(this.codeNames.size ? { codeNames: [...this.codeNames].sort() } : {}),
      ...(this.dataNames.size ? { dataNames: [...this.dataNames].sort() } : {}),
      ...(Object.keys(this.quiet).length ? { quiet: this.quiet } : {}),
    };
  }
}

/** A token of a script: a word (quoting resolved), a control operator, or a redirect operator. */
type Token = { word: string } | { op: string } | { redirect: string };

/**
 * The tokens of one script, as the shell reads them: quotes and backslashes resolved into words, `#` comments dropped;
 * an unquoted `;`, `&`, `|`, `&&`, `||`, `(`, `)` or line break is a control operator, an unquoted `<`, `>`, `>>`,
 * `>|`, `>&`, `<>`, `<<`, `<<<`, `&>` or `&>>` a redirect (a file descriptor's digits before it dropped), even glued to
 * a word (`sh<x`). A quoted or escaped `>` (`'>'`, `">"`, `\>`) is part of a word, never an operator. `$` reads as the
 * destructive-hook guard reads it (core lexShell, `dollar: 'keep'`): `$'…'` / `$"…"` quoting resolved, an expansion
 * or a substitution kept as written, each command substitution's script given to `sub`.
 */
export function scriptTokens(cmd: string, sub?: (script: string) => void): Token[] {
  return lexShell(cmd, { dollar: 'keep', redirects: true, ...(sub ? { sub } : {}) }).map((t) => (t.op ? { op: t.text } : t.redirect ? { redirect: t.text } : { word: t.text }));
}

/** The commands of a script: their words, and their redirects with their targets. */
function scriptCommands(script: string, sub?: (script: string) => void): Array<{ args: string[]; redirects: Array<{ op: string; target: string | undefined }> }> {
  const out: Array<{ args: string[]; redirects: Array<{ op: string; target: string | undefined }> }> = [];
  let cmd = { args: [] as string[], redirects: [] as Array<{ op: string; target: string | undefined }> };
  const tokens = scriptTokens(script, sub);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if ('op' in t) {
      if (cmd.args.length || cmd.redirects.length) out.push(cmd);
      cmd = { args: [], redirects: [] };
    } else if ('redirect' in t) {
      const next = tokens[i + 1];
      const target = next && 'word' in next ? next.word : undefined;
      if (target !== undefined) i++;
      cmd.redirects.push({ op: t.redirect, target });
    } else cmd.args.push(t.word);
  }
  if (cmd.args.length || cmd.redirects.length) out.push(cmd);
  return out;
}

/** A folder `cd` / `pushd` names, as candidates of every folder known so far. */
async function folders(raw: string, dirs: readonly string[], vars: Record<string, unknown>): Promise<string[]> {
  let w = raw.includes('{{') ? renderWithVars(raw, vars) : raw;
  if (w === undefined || w === '' || w === '-') return [];
  if (w === '~' || w.startsWith('~/')) w = homedir() + w.slice(1);
  const out: string[] = [];
  for (const abs of new Set(isAbsolute(w) ? [resolve(w)] : dirs.map((d) => resolve(d, w as string)))) {
    if (
      await stat(abs).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      out.push(abs);
  }
  return out;
}

/** Every file one shell script names, sorted into code and data (see the module comment). */
async function scanScript(script: string, start: readonly string[], c: Collector, writes = true): Promise<void> {
  const dirs = [...start];
  const subs: string[] = [];
  for (const { args, redirects } of scriptCommands(script, (inner) => subs.push(inner))) {
    // Redirects: a `<` target is code; an output's target is written, not read; a here-document's word is no file.
    for (const { op, target } of redirects) {
      if (target === undefined) continue;
      if (INPUT.has(op)) c.word(target, dirs, true);
      // A plain `>` (a file descriptor's too, `>|`) truncates before it writes: a file this hook may write.
      else if (writes && (op === '>' || op === '>|')) c.written(target, dirs);
    }
    let i = 0;
    const assign = /^[A-Za-z_]\w*=/;
    const skipLeading = () => {
      for (;;) {
        const a = args[i];
        if (a === undefined) return;
        if (assign.test(a)) {
          c.word(a.slice(a.indexOf('=') + 1), dirs, false);
          i++;
        } else if (WRAPPERS.has(a)) {
          i++;
          while (args[i]?.startsWith('-')) i++;
        } else return;
      }
    };
    skipLeading();
    const argv0 = args[i];
    if (argv0 === undefined) continue;
    const name = commandName(argv0);
    if (name === 'cd' || name === 'pushd') {
      const target = args.slice(i + 1).find((a) => !a.startsWith('-'));
      if (target !== undefined) for (const d of await folders(target, dirs, c.p.vars)) if (!dirs.includes(d)) dirs.push(d);
      continue;
    }
    const nested = nestedShellScript(args, i);
    if (nested !== undefined) {
      await scanScript(nested, dirs, c, writes);
      continue;
    }
    if (argv0.includes('/')) c.word(argv0, dirs, true);
    let script: number | undefined;
    if (INTERPRETERS.has(name)) {
      for (let j = i + 1; j < args.length; j++) {
        const a = args[j] as string;
        if (INLINE_CODE.has(a)) break;
        if (a.startsWith('-')) continue;
        if ((name === 'deno' || name === 'bun') && a === 'run') continue;
        script = j;
        break;
      }
    }
    for (let j = i + 1; j < args.length; j++) {
      const a = args[j] as string;
      if (j === script) {
        c.word(a, dirs, true);
        continue;
      }
      if (name === 'psql') {
        if ((a === '-f' || a === '--file') && args[j + 1] !== undefined) {
          c.word(args[j + 1] as string, dirs, true);
          j++;
          continue;
        }
        if (a.startsWith('--file=')) {
          c.word(a.slice('--file='.length), dirs, true);
          continue;
        }
        if (/^-f./.test(a)) {
          c.word(a.slice(2), dirs, true);
          continue;
        }
      }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq > 0) c.word(a.slice(eq + 1), dirs, false);
        continue;
      }
      if (a.startsWith('-')) {
        if (/^-[A-Za-z]./.test(a)) c.word(a.slice(2), dirs, false);
        continue;
      }
      c.word(a, dirs, false);
    }
  }
  // A command substitution runs its script: the files it names are read too (the folders known so far).
  for (const inner of subs) await scanScript(inner, dirs, c, writes);
}

/** The files `hook` reads, as a person's trust binds them (see the module comment). */
export async function hookTrustFiles(hook: HookStep, p: TrustFilesPlace): Promise<TrustedHookFiles> {
  const c = new Collector(p);
  const base = p.baseDir ?? p.projectDir;
  for (const { ref } of hookFileRefs(hook)) c.explicit(ref, base);
  if (hook && typeof hook === 'object' && 'shell' in hook) {
    const spec = (hook as { shell: string | ShellHookSpec }).shell;
    const s: ShellHookSpec = typeof spec === 'string' ? { run: spec } : spec;
    const cwd = typeof s.cwd === 'string' ? renderWithVars(s.cwd, p.vars) : '';
    // A working folder that renders with more than the vars (`{{run.dir}}`): its relative words are not bound.
    const dirs = cwd === undefined ? [] : [resolve(base, cwd)];
    for (const v of Object.values(s.env && typeof s.env === 'object' ? s.env : {})) if (typeof v === 'string') c.word(v, dirs, false);
    if (typeof s.run === 'string') await scanScript(s.run, dirs, c);
    // A rollback runs after the run (or not at all): what it writes is generated for nobody.
    if (typeof s.rollback === 'string') await scanScript(s.rollback, dirs, c, false);
  }
  return c.done();
}

const placeOf = (ctx: Pick<HookContext, 'project' | 'baseDir' | 'vars' | 'runDir'>): TrustFilesPlace => ({
  projectDir: ctx.project.dir,
  ...(ctx.baseDir !== undefined ? { baseDir: ctx.baseDir } : {}),
  workspaceDir: ctx.project.root,
  vars: ctx.vars,
  ...(ctx.runDir !== undefined ? { runDir: ctx.runDir } : {}),
});

/** The files of `hook` not as the context's trusted files hold them (none without `ctx.trustedFiles`). */
export async function trustedFilesProblem(hook: HookStep, ctx: Pick<HookContext, 'trustedFiles' | 'project' | 'baseDir' | 'vars' | 'runDir'>): Promise<HookFileChange[]> {
  const t = ctx.trustedFiles;
  if (!t) return [];
  const now = await hookTrustFiles(hook, placeOf(ctx));
  // A writer whose output a later hook runs as code: its inputs are code too.
  const outputs = new Set(Array.isArray(t.codeOutputs) ? t.codeOutputs : []);
  return trustedFileChanges(t, (now.generated ?? []).some((p) => outputs.has(p)) ? inputsAsCode(now) : now);
}

/** A file as a hook found it: its bytes' sha256 and its modification time (a rewrite of the same bytes changes it). */
type FileState = { hash: string; mtime: bigint } | undefined;

async function fileState(abs: string): Promise<FileState> {
  const hash = await hashFile(abs);
  if (hash === undefined) return undefined;
  const mtime = await stat(abs, { bigint: true }).then(
    (st) => st.mtimeNs,
    () => -1n,
  );
  return { hash, mtime };
}

/** What a run held to trusted files saw just before a hook: the files it writes with a plain `>`. */
export interface HoldPoint {
  writes: Map<string, FileState>;
}

/** Before a hook of a run held to trusted files (`ctx.trustedFiles`) runs: the state of the files it writes. */
export async function holdBefore(hook: HookStep, ctx: Pick<HookContext, 'trustedFiles' | 'project' | 'baseDir' | 'vars' | 'runDir'>): Promise<HoldPoint | undefined> {
  if (!ctx.trustedFiles) return undefined;
  const writes = new Map<string, FileState>();
  for (const path of (await hookTrustFiles(hook, placeOf(ctx))).generated ?? []) writes.set(path, await fileState(resolve(ctx.project.dir, path)));
  return { writes };
}

const same = (a: FileState, b: FileState) => (a === undefined ? b === undefined : b !== undefined && a.hash === b.hash && a.mtime === b.mtime);

/**
 * After a hook of a run held to trusted files returned (`status`), from what `holdBefore` saw. Only a file the hook
 * names as written (a plain `>` / `>|` target) can become the run's own output: it is when the hook succeeded and the
 * file changed (its bytes or its modification time: written, even with the same bytes) — then held as written; one the
 * hook did not write (a writer behind a condition) stays held as it was, or checked against the trust; a writer that
 * failed or was refused leaves it unreadable for every later reader. Any other held file the hook changed — or that
 * changed while it ran — stays held as before: a later reader of it is refused, as after a change between two hooks.
 */
export async function holdAfter(ctx: Pick<HookContext, 'trustedFiles' | 'project'>, point: HoldPoint | undefined, status: 'ok' | 'failed' | 'refused' | 'dry'): Promise<void> {
  const t = ctx.trustedFiles;
  if (!t || !point || status === 'dry') return;
  for (const [path, before] of point.writes) {
    if (status !== 'ok') {
      delete t.data[path];
      t.code[path] = UNREADABLE_FILE;
      continue;
    }
    const now = await fileState(resolve(ctx.project.dir, path));
    if (now === undefined || same(before, now)) continue;
    delete t.data[path];
    t.code[path] = now.hash;
  }
}

/** `f` with its data files (and those it names under Retake's folders) moved to code: a writer whose output runs as code. */
export function inputsAsCode(f: TrustedHookFiles): TrustedHookFiles {
  const code = Object.assign(Object.create(null) as Record<string, string>, f.quiet ?? {}, f.data, f.code);
  return { ...f, code, data: Object.create(null) as Record<string, string> };
}

/** The refusal of a hook whose files are not as the person checked them. */
export function trustedFilesMessage(changes: readonly HookFileChange[]): string {
  const how = { changed: 'changed since', added: 'newly read as code', unreadable: 'cannot be read' } as const;
  return `files this hook reads are not as you checked them before the run: ${changes.map((x) => `${x.path} (${how[x.change]})`).join(', ')} — run again to be asked about them`;
}
