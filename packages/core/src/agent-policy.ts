/**
 * The shared rules for work an agent can shape (trust `mcp`, core HookTrust): one home for the lists every package
 * applies, so the engine, the hooks and the runner never keep their own copy.
 *
 * The paths agent work writes (its refusals' words are its confinement's: confinement.ts), the project paths
 * an agent or the tools write (AGENT_WRITABLE_PATHS, agentWritable — never run as code: agent-trust.ts), and the real
 * path every such comparison is made on (realPathOf).
 *
 * Loader variables: environment variables that make a program load code, change the shell it starts or the folders it
 * reads its configuration from, before the command itself runs — node (NODE_OPTIONS, NODE_PATH), the shell (PATH, HOME,
 * ZDOTDIR, XDG_CONFIG_HOME, BASH_ENV, ENV, SHELLOPTS, BASHOPTS, PS4, PROMPT_COMMAND, IFS, CDPATH), the dynamic linker
 * (DYLD_*, LD_*), bash's exported functions (BASH_FUNC_*), git (GIT_*), the interpreters (PYTHON*, PERL5LIB, PERLLIB,
 * PERL5OPT, PERL5DB, RUBYOPT, RUBYLIB, GEM_HOME, GEM_PATH, BUNDLE_GEMFILE, LUA_INIT*, LUA_PATH, LUA_CPATH, PHPRC,
 * PHP_INI_SCAN_DIR, CLASSPATH, *JAVA*_OPTIONS, R_PROFILE*, R_ENVIRON*, R_LIBS*, TCLLIBPATH, GOFLAGS), the start files
 * of psql, curl and wget (PSQLRC, CURL_HOME, WGETRC), the programs other tools start (EDITOR, VISUAL, PAGER, MANPAGER,
 * BROWSER, LESSOPEN, LESSCLOSE, SSH_ASKPASS, SUDO_ASKPASS, RUSTC_WRAPPER), the JVM build tools' options (MAVEN_OPTS,
 * GRADLE_OPTS, ANT_OPTS), zsh's function path (FPATH) and the package managers (npm_config_*, PNPM_*, YARN_*,
 * COREPACK_*, PIP_*, UV_*).
 *
 * Agent-written shell commands: a strict grammar — plain words joined by single spaces and ` && ` — read in one pass,
 * then a few rules per word (agentShellProblems, agentShellCwdProblems, agentShellEnvProblems).
 *
 * Navigation: the URLs a scenario opens (navigationProblem, scenarioNavigationProblems), the one origin comparison
 * (canonicalOrigin) and, built on it, the server a URL reaches (canonicalAddress, canonicalIp).
 *
 * Chromium switches: the ones that turn Chromium's OS sandbox or its site isolation off (SANDBOX_OFF_SWITCHES,
 * SITE_ISOLATION_OFF_FEATURES) or open the browser to other code (BROWSER_OPEN_SWITCHES), refused in `browser.args`
 * whoever writes them (sandboxOffArgProblem): every browser Retake launches runs sandboxed. For a job an agent can shape
 * also positional arguments and every switch outside AGENT_ALLOWED_SWITCHES (agentArgProblem).
 *
 * Agent policy: whether a piece of work is one an agent can shape (a WorkPolicy whose `agentFolders` are set: the jobs
 * worker, the MCP server, the Studio server — never a command a person types; the engine builds it when it opens a
 * workspace and passes it to every adapter), and under it the programs a job may run (programProblem: none from inside
 * the workspace, none by a relative path; policyProgram also gives the real path to start) and the browser switches it
 * may pass (policyArgsProblems: an allow-list). Also under it, the
 * environment of the programs a job starts: an allow-list of the worker's (childEnv, project.yaml `pass_env:`).
 */
import { dirname, join, resolve, sep } from 'node:path';
import { ENV_NAME_PLAIN, isLoaderEnvName } from './agent-env.js';
import { GIT_VALUE_OPTIONS, PACKAGE_RUNNERS, PATH_OPTIONS, PATH_OPTION_EQ, REFUSED_BUILTINS, VARIABLE_SETTERS, WRAPPERS, interpreterOf, word0 } from './agent-shell-words.js';
import { needFiles } from './file-facts.js';
import type { FileFacts } from './file-facts.js';
import { relativeInside } from './path-inside.js';
import { showHiddenChars } from './printable.js';
import { realPathOf } from './real-path.js';

export * from './agent-env.js';
export * from './browser-switches.js';
export * from './navigation-policy.js';
export { realPathOf } from './real-path.js';
export * from './work-policy.js';

// ── The paths an agent writes ──────────────────────────────────────────────────────────────────────────────────

/**
 * Paths of a project folder an agent can write through MCP, or that runs and the tools write (relative, `/`).
 */
export const AGENT_WRITABLE_PATHS: readonly string[] = ['README.md', 'scenarios/', 'comments/', 'runs/', 'renders/', 'review/', 'exports/', '.retake/'];

/**
 * Whether a project-relative path (`/` or the platform separator) is one an agent can write through MCP. Compared
 * without case: the default macOS and Windows file systems ignore it, so `RUNS/…` is `runs/…` there (refusing it on a
 * case-sensitive file system too only errs on the safe side).
 */
export function agentWritable(rel: string): boolean {
  const p = rel
    .split(sep)
    .join('/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();
  return AGENT_WRITABLE_PATHS.some((w) => (w.endsWith('/') ? p === w.slice(0, -1) || p.startsWith(w) : p === w.toLowerCase()));
}

// ── Agent-written shell commands ────────────────────────────────────────────────────────────────────────────────────

/** The longest agent-written shell command (`run`, `rollback` or `cwd`, rendered), read before anything else. */
export const AGENT_SHELL_MAX_CHARS = 4_000;

/** The characters of a plain word: letters, digits and `. / : = @ % + , - _`. */
const PLAIN_CHAR = /[A-Za-z0-9./:=@%+,_-]/;
/** A plain word, whole. */
export const PLAIN_WORD = /^[A-Za-z0-9./:=@%+,_-]+$/;

/** What an agent-written shell command is (the refusals end with it). */
export const AGENT_SHELL_GRAMMAR = 'plain words (letters, digits and . / : = @ % + , - _) separated by single spaces, commands joined by ` && `';

/** `NAME=` (an assignment word, or an `env` / `export` argument) and the variable it sets. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const VARIABLE_WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where agentShellProblems judges the paths of a command. */
export interface AgentShellOptions {
  /** The project folder: a path through one of its agent-writable folders (core AGENT_WRITABLE_PATHS) is refused. */
  projectDir: string;
  /** The folder the command runs in, which relative words resolve from (default projectDir). */
  cwd?: string;
  /** What `~` stands for (the account's home folder; agentWritablePath only — a command has no `~`). */
  home?: string;
  /** How real paths are read (core FileFacts). */
  files: FileFacts;
}

/**
 * Where `path` leads relative to the project (`own`) or to a project beside it (`beside`, `<project>/<rest>`), once
 * symbolic links of its existing part are followed (it need not exist); null outside both. `~` and `~/…` stand for
 * `o.home` unless `tilde: false`; a `file://` URL for its path.
 */
function projectPlace(path: string, o: AgentShellOptions & { tilde?: boolean }): { own: string } | { beside: string; rest: string } | null {
  let p = path.replace(/^file:\/\//i, '');
  if (o.tilde !== false && (p === '~' || p.startsWith('~/'))) {
    if (o.home === undefined) throw new Error("agentWritablePath: a path starting with `~` needs `home` (the account's home folder)");
    p = join(o.home, p.slice(1));
  }
  const files = needFiles(o.files, 'agentWritablePath');
  const real = realPathOf(resolve(o.cwd ?? o.projectDir, p), files);
  const below = (base: string): string | undefined => relativeInside(real, base, { self: false });
  const root = realPathOf(resolve(o.projectDir), files);
  const own = below(root);
  if (own !== undefined) return { own };
  const beside = below(realPathOf(dirname(root), files));
  if (beside === undefined) return null;
  const [, ...rest] = beside.split(sep);
  return rest.length ? { beside, rest: rest.join(sep) } : null;
}

/**
 * Where a path an agent-written shell command names leads, when that is through a folder an agent can write (core
 * agentWritable): of the project (`runs/…`, `scenarios/…`, README.md…), or of a project beside it — the agent writes the
 * scenarios of every project of the workspace. Its project-relative form (`runs/x/a.sh`, `../other/runs/a.sh`), else
 * null. Symbolic links of its existing part are followed; it need not exist. `~` and `~/…` stand for `o.home`, a
 * `file://` URL for its path; `tilde: false` takes `~` literally (a hook's cwd).
 */
export function agentWritablePath(path: string, o: AgentShellOptions & { tilde?: boolean }): string | null {
  const at = projectPlace(path, o);
  if (!at) return null;
  if ('own' in at) return agentWritable(at.own) ? at.own.split(sep).join('/') : null;
  return agentWritable(at.rest) ? `../${at.beside.split(sep).join('/')}` : null;
}

/** A person's own file of a project (or of one beside it): `hooks/…` or `project.yaml`, project-relative; else null. */
function personFilePath(path: string, o: AgentShellOptions): { rel: string; file: 'hooks/' | 'project.yaml' } | null {
  const at = projectPlace(path, { ...o, tilde: false });
  if (!at) return null;
  const rel = ('own' in at ? at.own : at.rest)
    .split(sep)
    .join('/')
    .replace(/^(?:\.\/)+/, '');
  const shown = 'own' in at ? rel : `../${at.beside.split(sep).join('/')}`;
  const lower = rel.toLowerCase();
  if (lower === 'project.yaml' || lower === 'project.yml') return { rel: shown, file: 'project.yaml' };
  if (lower === 'hooks' || lower.startsWith('hooks/')) return { rel: shown, file: 'hooks/' };
  return null;
}

/** The folder of agentWritablePath's answer, for a message: "runs/", "README.md", "runs/ of another project". */
function writableFolder(rel: string): string {
  const parts = rel.split('/');
  const folder = (name: string, deeper: boolean) => (deeper || AGENT_WRITABLE_PATHS.includes(`${name.toLowerCase()}/`) ? `${name}/` : name);
  if (parts[0] === '..') return `${folder(parts[2], parts[3] !== undefined)} of another project`;
  return folder(parts[0], parts.length > 1);
}

/** The parts of a word that may name a path: the word, the value after `=`, after `-X`, after `@`, each `:` or `,` part. */
function pathCandidates(w: string): string[] {
  const out = new Set<string>([w]);
  const eq = w.indexOf('=');
  if (eq >= 0) out.add(w.slice(eq + 1));
  if (/^-[^-]./.test(w)) out.add(w.slice(2));
  if (w.startsWith('@')) out.add(w.slice(1));
  for (const c of [...out]) {
    if (c.includes(',')) for (const part of c.split(',')) out.add(part);
  }
  for (const c of [...out]) {
    const e = c.indexOf('=');
    if (e >= 0) out.add(c.slice(e + 1));
  }
  for (const c of [...out]) if (c.includes(':') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) for (const part of c.split(':')) out.add(part);
  return [...out].filter((c) => c !== '');
}

/** How a character is named in a refusal: `x`, a space, or `\u{…}` for a control, invisible or non-ASCII one. */
function shownChar(c: string): string {
  if (c === ' ') return 'a space';
  const code = c.codePointAt(0)!;
  return code < 0x21 || code > 0x7e ? `\`\\u{${code.toString(16)}}\`` : `\`${c}\``;
}

/** How a word is shown in a refusal (a plain word: shown as is, a long one cut — the hook itself is shown in full). */
function shownWord(w: string): string {
  return w.length > 80 ? `${w.slice(0, 77)}…` : w;
}

/**
 * The grammar of an agent-written command, in one pass over its characters: its words, by command; or the problems.
 * Every character is a plain word's, a single space between two words, or the `&&` of ` && ` between two commands.
 */
function plainCommands(text: string): { commands: string[][] } | { problems: string[] } {
  const bad: string[] = [];
  const problems: string[] = [];
  for (const ch of text) {
    if (PLAIN_CHAR.test(ch) || ch === ' ' || ch === '&') continue;
    const shown = shownChar(ch);
    if (!bad.includes(shown)) bad.push(shown);
  }
  if (bad.length) {
    const list = bad.length > 8 ? `${bad.slice(0, 8).join(', ')}…` : bad.join(', ');
    problems.push(`${bad.length === 1 ? 'the character' : 'the characters'} ${list} (only plain words: letters, digits and . / : = @ % + , - _)`);
  }
  const words = text.split(' ');
  if (text === '') problems.push('no command');
  else if (words.some((w) => w === '')) problems.push('two spaces in a row, or a space at its start or end (one space between two words)');
  if (words.some((w) => w.includes('&') && w !== '&&')) problems.push('`&` other than ` && ` between two commands (`&`, `&>`, `a&&b`)');
  const commands: string[][] = [[]];
  for (const w of words) {
    if (w === '&&') commands.push([]);
    else if (w !== '') commands[commands.length - 1].push(w);
  }
  if (text !== '' && commands.some((c) => c.length === 0) && !problems.length) problems.push('` && ` without a command on each side');
  return problems.length ? { problems } : { commands };
}

/** Whether word `i` of a command is where a program reads the script it runs (`sh x.sh`, `awk -f x.awk`, `psql -f x.sql`). */
function runsFileAt(words: readonly string[], i: number, program: number): boolean {
  if (i === program) return true;
  const prev = words[i - 1];
  if (prev === '-f' || prev === '--file' || prev === '-m') return true;
  if (/^(?:--file=|-f.)/.test(words[i])) return true;
  // An interpreter's first word that is not an option: its script.
  for (let k = 0; k < i; k++) {
    if (!interpreterOf(words[k])) continue;
    const first = words.slice(k + 1).findIndex((w) => !w.startsWith('-'));
    return first >= 0 && k + 1 + first === i;
  }
  return false;
}

/** The problems of one command's words (agentShellProblems). */
function commandProblems(words: readonly string[], o: AgentShellOptions, add: (p: string) => void): void {
  let program = 0;
  while (program < words.length && ASSIGNMENT.test(words[program])) program++;

  // Builtins that run text or a file, or rebind names: the program, and any word after a wrapper (`nice -n 1 cd`).
  const wrapped = program < words.length && WRAPPERS.has(word0(words[program]));
  for (let i = program; i < words.length; i++) {
    const base = word0(words[i]);
    if ((i === program || wrapped) && Object.hasOwn(REFUSED_BUILTINS, base)) add(`\`${base}\` (it ${REFUSED_BUILTINS[base]})`);
  }

  // Loader variables it sets: an assignment before the program, an `env` argument, a setter's names.
  const loader = (name: string, assigned = true) => {
    if (isLoaderEnvName(name)) add(`\`${name}${assigned ? '=' : ''}\` (it sets ${name}, a loader variable)`);
  };
  for (let i = 0; i < program; i++) loader(ASSIGNMENT.exec(words[i])![1]);
  words.forEach((w, i) => {
    const base = word0(w);
    if (base === 'env') {
      for (const a of words.slice(i + 1)) {
        const m = ASSIGNMENT.exec(a);
        if (m) loader(m[1]);
        else if (!a.startsWith('-')) break;
      }
    }
    if (VARIABLE_SETTERS.has(base)) {
      const rest = words.slice(i + 1);
      for (const [k, a] of rest.entries()) {
        // printf sets only the name after its `-v`; the others every name and NAME= they list.
        if (base === 'printf') {
          if (rest[k - 1] === '-v' && VARIABLE_WORD.test(a)) loader(a, false);
          continue;
        }
        const m = ASSIGNMENT.exec(a);
        if (m) loader(m[1]);
        else if (VARIABLE_WORD.test(a)) loader(a, false);
      }
    }
  });

  const interpreter = words.some((w) => interpreterOf(w));
  words.forEach((w, i) => {
    const base = word0(w);
    const rest = words.slice(i + 1);
    const spec = interpreterOf(w);
    if (spec) {
      const flag = spec.code ? rest.find((r) => spec.code!.test(r)) : undefined;
      if (flag !== undefined) add(`\`${base} ${flag.replace(/=.*$/, '')}\` (it runs code written in the command) — put the code in a script under hooks/`);
      if (!spec.code && !rest.some((r) => /^(?:-f|--file)/.test(r))) add(`\`${base}\` with a program text (it can run commands) — put the program in a file under hooks/ and pass it with \`-f\``);
      if (/^(?:python|pypy)/.test(base)) {
        rest.forEach((r, k) => {
          const mod = r === '-m' ? rest[k + 1] : /^-m./.test(r) ? r.slice(2) : undefined;
          if (mod !== undefined) pathProblem(mod.split('.').join('/'), o, add, { word: mod, runs: true });
        });
      }
    }
    if (base === 'xargs' || base === 'parallel') add(`\`${base}\` (it runs commands built from its input)`);
    if (base === 'find') {
      const run = rest.find((r) => /^-(?:exec|execdir|ok|okdir)$/.test(r));
      if (run) add(`\`find ${run}\` (it runs a command for each file)`);
    }
    if (base === 'env') {
      const split = rest.find((r) => /^(?:-[A-Za-z]*S|--split-string)/.test(r));
      if (split) add('`env -S` (it splits a string into a command)');
    }
    const runner = PACKAGE_RUNNERS[base];
    if (runner === true) add(`\`${base}\` (it runs a package, downloading it when it is not installed)`);
    else if (runner) {
      const sub = rest.find((r) => runner.includes(r));
      if (sub !== undefined) add(`\`${base} ${sub}\` (it runs a package, downloading it when it is not installed)`);
    }
    if (base === 'deno') {
      const spec2 = rest.find((r) => /^(?:npm|jsr):/.test(r));
      if (spec2) add(`\`deno ${shownWord(spec2)}\` (it runs a package, downloading it when it is not installed)`);
    }
    if (base === 'git') {
      for (let k = 0; k < rest.length && rest[k].startsWith('-'); k++) {
        if (rest[k].startsWith('-c') || rest[k].startsWith('--config-env')) {
          add('`git -c` (a configuration given in the command can run commands)');
          break;
        }
        if (GIT_VALUE_OPTIONS.has(rest[k])) k++;
      }
    }
  });

  // Paths. A person's file (hooks/, project.yaml): any word. A folder an agent can write: a word holding a `/`, a bare
  // word an interpreter may run, the value of a folder or file option (a bare `review` of `pnpm run review` is a name).
  words.forEach((w, i) => {
    if (i === program && !w.includes('/')) return; // a program looked up on PATH
    if (/^\/dev\/(?:stdin|fd\/)|^\/proc\/[^/]+\/fd\//.test(w)) add(`\`${shownWord(w)}\` (a stream read as a file)`);
    const judged = w.includes('/') || interpreter || (i > 0 && PATH_OPTIONS.test(words[i - 1])) || PATH_OPTION_EQ.test(w);
    const runs = runsFileAt(words, i, program);
    for (const c of pathCandidates(w)) pathProblem(c, o, add, { word: w, runs, judged });
  });
}

/** Whether agentWritablePath's answer is one of the files (not folders) an agent writes: README.md of a project. */
function writableFile(rel: string): boolean {
  const inProject = rel.replace(/^\.\.\/[^/]+\//, '').toLowerCase();
  return AGENT_WRITABLE_PATHS.some((w) => !w.endsWith('/') && w.toLowerCase() === inProject);
}

/**
 * A path problem of one candidate: through a folder an agent can write when `judged` (a bare folder name such as
 * `review` of `npm run review` is a name), to one of the files an agent writes (README.md) always — any program may
 * read a bare file name as its script.
 */
function pathProblem(candidate: string, o: AgentShellOptions, add: (p: string) => void, of: { word: string; runs: boolean; judged?: boolean }): void {
  const { word, runs, judged = true } = of;
  const found = agentWritablePath(candidate, { ...o, tilde: false });
  const rel = found !== null && (judged || writableFile(found)) ? found : null;
  if (rel !== null) {
    add(`\`${shownWord(word)}\` (a path through ${writableFolder(rel)}, which an agent can write)`);
    return;
  }
  const person = personFilePath(candidate, o);
  if (!person) return;
  if (person.file === 'project.yaml') add(`\`${shownWord(word)}\` (project.yaml, a person's file)`);
  else if (!runs) add(`\`${shownWord(word)}\` (a path into hooks/, a person's folder, other than the script a command runs)`);
}

/**
 * What an agent-written shell command may not use (trust `mcp`, a hook the agent wrote: its rendered `run` or
 * `rollback`): each problem once, in the order found; empty when none. Length first (AGENT_SHELL_MAX_CHARS), then the
 * grammar in one pass — plain words of letters, digits and `. / : = @ % + , - _`, single spaces, commands joined by
 * ` && ` — so the shell expands, redirects, substitutes and quotes nothing. Then, per command:
 * - `cd`, `pushd`, `popd`, `eval`, `exec`, `command`, `builtin`, `trap`, `alias`, `unalias`, `hash`, `enable`, `fc`,
 *   `source`, `.` as the program (by its last path part: `/usr/bin/command`) or after a wrapper (`nice`, `env`…, and
 *   the shells' prefix words `coproc`, `noglob`, `nocorrect`, `-`);
 * - a loader variable it sets: an assignment before the program, an `env` argument, the names a setter (`export`,
 *   `declare`, `read`, `printf -v`…) lists;
 * - inline interpreter code (a shell's `-c`, `node -e` / `-p` / `--eval` / `-r` / `--import`, `deno eval`,
 *   `python -c`, `perl -e`, `ruby -e`, `php -r`, `osascript -e`…), `awk` without `-f`; `xargs`, `parallel`,
 *   `find -exec`, `env -S`; a package runner (`npx`, `uvx`, `bunx`, `pnpx`) or its subcommand wherever it stands
 *   (`npm exec` / `x` / `create` / `init`, `pnpm dlx` / `create`, `yarn dlx`, `bun x`, `pipx run`, `uv tool`,
 *   `deno npm:…`); `git -c`;
 * - a path (a word holding a `/`; a bare word an interpreter may run, or the value of `-C`, `-f`, `--file`, `--prefix`,
 *   `--cwd`…; the value of `--opt=…`, `-Xvalue`, `@file`, a `:` or `,` list; `python -m`'s module) through a folder an
 *   agent can write (agentWritablePath), whether it exists or not; any word naming a file an agent writes (README.md,
 *   bare or not); project.yaml; hooks/ other than the script a command
 *   runs (its program, an interpreter's script, a `-f` file); `/dev/stdin`, `/dev/fd/…`.
 */
export function agentShellProblems(text: string, o: AgentShellOptions): string[] {
  if (text.length > AGENT_SHELL_MAX_CHARS) return [`${text.length.toLocaleString('en-US')} characters (at most ${AGENT_SHELL_MAX_CHARS.toLocaleString('en-US')})`];
  const parsed = plainCommands(text);
  if ('problems' in parsed) return parsed.problems;
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const words of parsed.commands) commandProblems(words, o, add);
  return out;
}

/**
 * What an agent-written hook's working folder (`cwd`, rendered) may not be: over AGENT_SHELL_MAX_CHARS, other than one
 * plain word, or through a folder an agent can write. Empty when none.
 */
export function agentShellCwdProblems(cwd: string, o: AgentShellOptions): string[] {
  if (cwd.length > AGENT_SHELL_MAX_CHARS) return [`its working folder: ${cwd.length.toLocaleString('en-US')} characters (at most ${AGENT_SHELL_MAX_CHARS.toLocaleString('en-US')})`];
  if (!PLAIN_WORD.test(cwd)) return [`its working folder \`${shownWord(showHiddenChars(cwd).replace(/\n/g, '\\u{a}'))}\` (one plain word: letters, digits and . / : = @ % + , - _)`];
  const rel = agentWritablePath(cwd, { ...o, tilde: false });
  return rel !== null ? [`its working folder \`${shownWord(cwd)}\` (a path through ${writableFolder(rel)}, which an agent can write)`] : [];
}

/**
 * The environment variable names an agent-written shell hook may not give its `env` (trust `mcp`): a name that is not a
 * plain identifier (ENV_NAME_PLAIN), or a loader variable. Each once, in order; empty: none.
 */
export function agentShellEnvProblems(env: Readonly<Record<string, string>> | undefined): string[] {
  const out: string[] = [];
  for (const name of Object.keys(env ?? {})) {
    if (!ENV_NAME_PLAIN.test(name)) out.push(`its env name \`${shownWord(showHiddenChars(name).replace(/\n/g, '\\u{a}'))}\` (letters, digits and _, not starting with a digit)`);
    else if (isLoaderEnvName(name)) out.push(`its env \`${name}\` (a loader variable)`);
  }
  return out;
}
