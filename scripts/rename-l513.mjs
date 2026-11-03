#!/usr/bin/env node
// old-name: this whole file is the rename (L5.13) and names the old spellings it rewrites; the guard test allows it.
// The rename of L5.13 (Demo Studio → Retake), as a deterministic, idempotent rewrite of the repository's text files:
// the same input gives the same output on any base, and a second run changes nothing. A branch started before L5.13
// runs it on itself before rebasing; the lead runs it again on a newer main at merge time.
// Usage: node scripts/rename-l513.mjs [--dry] [--allow-dirty] [--only <file> …]
//   --dry          list what would change (per rule, per file) and the remaining lower-case `studio` words to look at;
//                  no write
//   --allow-dirty  a full run refuses while tracked files have changes (they would be rewritten with them): this runs
//                  anyway (a second run to check idempotence, say)
//   --only         rewrite these files only (paths inside the repository, tracked or not, dirty or not: the lead's
//                  stashed work at merge time; no folder renames)
// A full run rewrites the TRACKED files only (`git ls-files`: never another session's untracked work or a person's
// notes), then makes the path renames. It never follows a symbolic link (a linked file or folder is skipped) and skips,
// with a warning, a file that is not valid UTF-8 (it would come back with U+FFFD in place of its bytes).
// Lines that carry `old-name:` and regions between `old-name:begin` and `old-name:end` are left as they are (the guard
// test allows them in its listed files only). Generated files (docs/REQUIREMENTS.md, component preview.json) are skipped:
// regenerate them afterwards. Delete this script once no branch from before L5.13 is left (BACKLOG BL-136).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files never rewritten: the rename itself, the legacy module and its tests, generated files. */
const SKIP = [
  /^\.claude\//,
  /^scripts\/rename-l513\.mjs$/,
  /^packages\/[^/]+\/src\/legacy\.ts$/,
  /^packages\/[^/]+\/test\/legacy[^/]*\.test\.ts$/,
  /^packages\/core\/test\/old-name\.test\.ts$/,
  /^docs\/REQUIREMENTS\.md$/,
  /(^|\/)preview\.json$/,
];
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|mp4|mov|webm|woff2?|ttf|otf|pdf|zip|gz|sqlite|wasm)$/i;

/** Folder and file renames of a full run (plain renames: nothing is staged). */
export const PATH_RENAMES = [
  ['skills/demo-studio-scenario', 'skills/retake-scenario'],
  ['skills/demo-studio-theme', 'skills/retake-theme'],
  ['skills/demo-studio-component', 'skills/retake-component'],
  ['studio.yaml', 'retake.yaml'],
];

// The command's sub-commands (Commander's, the hidden worker, and the ones the docs name before they exist).
const SUB = [
  'export-capture', 'components', 'validate', 'sandbox', 'inspect', 'comment', 'doctor', 'record', 'render', 'review',
  'export', 'schema', 'worker', 'migrate', 'skills', 'player', 'outline', 'delete', 'theme', 'still', 'hooks', 'login',
  'prune', 'shell', 'draft', 'list', 'plan', 'auth', 'jobs', 'help', 'lint', 'new', 'run', 'env', 'mcp', 'ui',
];
/** Whitespace before a word, or a line break with a comment / quote prefix (a command wrapped at the line end). */
const WRAP = String.raw`(?:[ \t]*\n[ \t]*(?:(?:\*|\/\/|#|>)[ \t]+)?|[ \t]+)`;
const CMD_NEXT = String.raw`(?:(?:${SUB.join('|')})(?![\w-])|…|\.\.\.|\$\{|<[A-Za-z]|\[|-{1,2}[A-Za-z])`;
/** `studio <sub>` and friends: not a path piece (`studio/x`, `x-studio`), a property or a page event. */
const CMD = new RegExp(String.raw`(?<![\w./@:$\\-])studio(?=${WRAP}${CMD_NEXT})`, 'g');

/**
 * Exact replacements in one file, applied before the general rules (literals the general rules must not see, texts
 * that describe the rename, the plugin's userConfig key, D1's code literals).
 */
const FILE_RULES = {
  'docs/reference/studio-ui.md': [
    [
      '(the\ncanvas says "Retake"; the repository says "Demo Studio" until then — the page writes it in one place,\n`packages/ui/src/app/brand.ts`, every screen included (a lint over the app\'s sources; the server\'s comments and the preview\nbundle\'s generated header still name it, for L5.13).',
      '(done in\nL5.13a; the page writes the name in one place, `packages/ui/src/app/brand.ts`, every screen included — a lint over the\napp\'s sources).',
    ],
  ],
  'packages/core/src/sandbox.ts': [
    ["slug: string, studio = 'studio')", "slug: string, cli = 'retake')"],
    ['${studio} sandbox init ${slug}', '${cli} sandbox init ${slug}'],
    ['then ${studio} run ${slug}', 'then ${cli} run ${slug}'],
  ],
  'packages/cli/src/errors.ts': [['Process exit codes of `studio`.', 'Process exit codes of `retake`.']],
  'packages/cli/src/commands/auth.ts': [["/** `studio`, with `-C <root>`", "/** `retake`, with `-C <root>`"], [": 'studio';", ": 'retake';"]],
  'packages/engine/src/jobs/queue.ts': [["readonly cli = 'studio',", "readonly cli = 'retake',"]],
  'apps/desktop/src/child.rs': [['eprintln!("studio: {text}");', 'eprintln!("retake: {text}");']],
  'docs/DESIGN.md': [['never `studio`, `pnpm studio` or', 'never `retake`, `pnpm retake` or'], ['(`studio: …`)', '(`retake: …`)']],
  'packages/cli/src/bin.ts': [["'studio: exited before", "'retake: exited before"], ['~/.local/bin/studio', '~/.local/bin/retake']],
  'packages/cli/test/desktop-shell.test.ts': [["'studio: stopped: SIGTERM'", "'retake: stopped: SIGTERM'"]],
  'apps/desktop/core/src/rules.rs': [['"studio: ready"', '"retake: ready"'], ['the Studio CLI', 'the retake CLI']],
  'apps/desktop/core/src/config.rs': [['a_workspace_has_studio_yaml_or_projects_like_the_cli', 'a_workspace_has_retake_yaml_or_projects_like_the_cli']],
  'docs/BACKLOG.md': [['a Postgres the studio ships', 'a Postgres Retake ships']],
  'docs/ROADMAP.md': [
    ['the `studio` command and the old names are gone after it', 'the old command and the old names are gone after it'],
    ['the `retake` command and the old names are gone after it', 'the old command and the old names are gone after it'],
  ],
  'packages/cli/package.json': [['"studio": "./dist/bin.js"', '"retake": "./dist/bin.js"']],
  'package.json': [['"studio": "node packages/cli/dist/bin.js"', '"retake": "node packages/cli/dist/bin.js"']],
  'skills/.claude-plugin/plugin.json': [['  "studio": {\n   "type": "file",', '  "cli": {\n   "type": "file",']],
  'skills/README.md': [['`studio` (the absolute', '`cli` (the absolute'], ['<node> <studio> --root', '<node> <cli> --root']],
  'packages/mcp/test/skill-lint.ts': [
    ['(?:studio\\b|pnpm\\s+studio\\b|node\\s)', '(?:retake\\b|pnpm\\s+retake\\b|node\\s)'],
    ['/^(?:studio|pnpm studio|node \\S*bin\\.js)\\s+\\S/', '/^(?:retake|pnpm retake|node \\S*bin\\.js)\\s+\\S/'],
    ['/^studio\\s/', '/^retake\\s/'],
  ],
  'packages/mcp/test/plugin.test.ts': [
    ['userConfig node / studio / workspace', 'userConfig node / cli / workspace'],
    ["toEqual(['node', 'studio', 'workspace', 'home'])", "toEqual(['node', 'cli', 'workspace', 'home'])"],
    ["toEqual(['node', 'retake', 'workspace', 'home'])", "toEqual(['node', 'cli', 'workspace', 'home'])"],
    ["      node: ['file', true],\n      studio: ['file', true],", "      node: ['file', true],\n      cli: ['file', true],"],
  ],
  'packages/cli/test/record.test.ts': [['/next +studio .*run shop first --dry/', '/next +retake .*run shop first --dry/']],
  'packages/core/test/schema.test.ts': [['encoder 0.16, studio 0.15, product', 'encoder 0.16, retake 0.15, product']],
  // `studio` here is a variable holding a draft, not the old workspace file.
  'packages/core/test/recording.test.ts': [
    ['const studio = draftFromRecording(ev, CTX, null, { aliases: false });', 'const studioDraft = draftFromRecording(ev, CTX, null, { aliases: false });'],
    ['studio.yaml', 'studioDraft.yaml'],
    ['retake.yaml', 'studioDraft.yaml'],
  ],
  'packages/ui/src/app/ui-kit/panes.tsx': [['<code className="k-mono">studio</code>', '<code className="k-mono">retake</code>']],
  // The starters' sample brand is the tool's own name now, not a fictional one (L5.13a review B L9).
  'templates/default/template.yaml': [['# Placeholder brand: "', '# Sample brand, the tool\'s own name: "'], ['   # placeholder brand (fictional)', '   # sample brand: the tool\'s own name']],
  'templates/motion/template.yaml': [['# Placeholder brand: "', '# Sample brand, the tool\'s own name: "'], ['   # placeholder brand (fictional)', '   # sample brand: the tool\'s own name']],
  'templates/default/README.md': [['(placeholder brand "', '(sample brand: the tool\'s own name, "']],
  'templates/motion/README.md': [['(placeholder brand "', '(sample brand: the tool\'s own name, "']],
  'templates/README.md': [
    ['| Frame / captions | Placeholder brand |', '| Frame / captions | Sample brand |'],
    ['walks through it). Every\nplaceholder brand is fictional.', 'walks through it). The\nsample brands are the tool\'s own name (default, motion) and an invented one (editorial).'],
  ],
  'docs/requirements.json': [
    ['templates/README.md (fictional placeholder brands)', "templates/README.md (sample brands: the tool's own name and an invented one)"],
    ["fixture 'Northfield' and placeholder brands are fictional", "fixture 'Northfield' and the editorial starter's sample brand are invented (the other starters show the tool's own name)"],
  ],
  'packages/core/test/theme-edits.test.ts': [['/placeholder brand|consistent with the legacy/', '/placeholder brand|sample brand|consistent with the legacy/']],
};

/** Edits after the general rules, each idempotent (the .gitignore keeps the old state folders ignored, critique M7). */
const POST_RULES = {
  '.gitignore': (t) =>
    t.includes('old-name:begin')
      ? t
      : `${t.replace(/\n*$/, '\n')}# old-name:begin — the tool's state folders from before L5.13 stay ignored (an older checkout keeps them)\n` +
        'projects/*/.demo-studio/\n.demo-studio/\n# old-name:end\n',
  'pnpm-lock.yaml': sortLockDeps,
  'apps/desktop/Cargo.lock': sortCargoLock,
};

/** The general rules, in order: [name, pattern, replacement]. */
export const RULES = [
  // Packages, env, identifiers, every hyphenated spelling (paths, Docker, temp prefixes, MCP, plugin, desktop id).
  ['package scope', /@demo-studio\//g, '@retake/'],
  ['DEMO_STUDIO', /DEMO_STUDIO/g, 'RETAKE'],
  ['DEMO-STUDIO', /DEMO-STUDIO/g, 'RETAKE'],
  ['demo_studio', /demo_studio/g, 'retake'],
  ['demoStudio', /demoStudio/g, 'retake'],
  ['DemoStudio', /DemoStudio/g, 'Retake'],
  ['demo-studio', /demo-studio/g, 'retake'],
  ['Demo-Studio', /Demo-Studio/g, 'Retake'],
  // The words, wrapped across a line break with a comment prefix too.
  ['Demo Studio (wrapped)', /Demo([ \t]*\n[ \t]*(?:(?:\*|\/\/|#|>)[ \t]+)?)Studio([.,;:)]*)[ \t]?/g, 'Retake$2$1'],
  ['Demo Studio', /Demo[ \t\u00a0]+Studio/g, 'Retake'],
  // The plugin's userConfig key names the entry point, not the product (plan D1).
  ['plugin key', /user_config\.studio\b/g, 'user_config.cli'],
  ['plugin key', /(--config |… )studio=/g, '$1cli='],
  ['plugin key', /`node` \/ `studio`/g, '`node` / `cli`'],
  ['plugin key', /\(`node`, `studio`, `workspace`/g, '(`node`, `cli`, `workspace`'],
  ['plugin key', /\['studio', e\.args\[0\]\]/g, "['cli', e.args[0]]"],
  // The command.
  ['pnpm studio', /\bpnpm studio\b/g, 'pnpm retake'],
  ['Command()', /new Command\('studio'\)/g, "new Command('retake')"],
  ['argv', /'node', 'studio'/g, "'node', 'retake'"],
  ['alias', /\balias studio=/g, 'alias retake='],
  ['Usage:', /\bUsage: studio\b/g, 'Usage: retake'],
  ['replace(/^studio /)', /\/\^studio \//g, '/^retake /'],
  ["'studio '", /'studio '/g, "'retake '"],
  ['cli name argument', /\bcli: 'studio'/g, "cli: 'retake'"],
  ['cli name argument', /(new FileJobQueue\([^()\n]*?), 'studio'\)/g, "$1, 'retake')"],
  ['cli name argument', /\brunCommandLine\('studio',/g, "runCommandLine('retake',"],
  ['`studio` command', /`studio`(?=,? `pnpm studio`|\s*(?:[*#]\s+)?(?:command|CLI|program|entry|on\s+(?:[*#]\s+)?(?:their|your)\s+PATH|is not on|from anywhere|from inside|or `bin\.js`|broke|on request))/g, '`retake`'],
  ['CLI (`studio`', /(?<=CLI \()`studio`(?=[,)])/g, '`retake`'],
  ['studio command', /(?<![\w./@:$\\-])studio(?=\s+(?:command|commands|entry point|process|node)\b|\s+on\s+(?:[*#]\s+)?(?:your|their)\s+PATH)/g, 'retake'],
  ['\\`studio\\` CLI', /\\`studio\\`(?= (?:CLI|command))/g, '\\`retake\\`'],
  ['studio needs Node', /(?<![\w./@:$\\-])studio(?= needs Node)/g, 'retake'],
  ['plugin values', /values: node, studio, workspace, home/g, 'values: node, cli, workspace, home'],
  ['studio <sub>', CMD, 'retake'],
  // A regex literal that starts with the command (tests): `/studio render …/`.
  ['studio <sub> (regex)', new RegExp(String.raw`(?<=[(\[,=:!\s]\/\^?)studio(?=${WRAP}${CMD_NEXT})`, 'g'), 'retake'],
  // The workspace file, the home.
  ['studio.yaml', /\bstudio\.yaml\b/g, 'retake.yaml'],
  ['studio\\.yaml', /\bstudio\\\.yaml\b/g, 'retake\\.yaml'],
  ['studio home', /\b[Ss]tudio(\s*\n\s*(?:(?:\*|\/\/|#)\s+)?|[ \t]+)home\b/g, 'Retake$1home'],
  ['studioHome', /\bstudioHome\b/g, 'retakeHome'],
  ['studio_home', /\bstudio_home/g, 'retake_home'],
  ['studioCommand', /\bstudioCommand\b/g, 'retakeCommand'],
  // A test regex of the command with an optional `-C <root>` group: `/studio( -C \S+)? sandbox init …/`.
  ['studio( -C (regex)', /\/studio\((?= -C\b)/g, '/retake('],
  // The tests' helper that runs the command (`await studio('run', …)`), not a property or a path.
  ['studio() helper', /(?<![\w.$\/-])studio\(/g, 'retake('],
];

/** pnpm sorts each importer's dependency keys: put the renamed `@retake/*` entries back in its order (critique L4). */
function sortLockDeps(text) {
  const lines = text.split('\n');
  const out = [];
  let section = '';
  for (let i = 0; i < lines.length; ) {
    out.push(lines[i]);
    if (/^\S/.test(lines[i])) section = lines[i];
    if (section !== 'importers:' || !/^ {4}(dependencies|devDependencies|optionalDependencies):$/.test(lines[i])) {
      i++;
      continue;
    }
    i++;
    const groups = [];
    while (i < lines.length && /^ {6}\S/.test(lines[i])) {
      const g = [lines[i++]];
      while (i < lines.length && /^ {8}/.test(lines[i])) g.push(lines[i++]);
      groups.push(g);
    }
    const key = (g) => g[0].trim().replace(/:$/, '').replace(/^'(.*)'$/, '$1');
    if (groups.some((g) => key(g).startsWith('@retake/'))) groups.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    for (const g of groups) out.push(...g);
  }
  return out.join('\n');
}

/** Cargo keeps its lockfile's packages sorted by name: move the renamed root package to its place (`--locked`). */
function sortCargoLock(text) {
  const parts = text.split('\n[[package]]\n');
  const head = parts.shift();
  const name = (b) => /^name = "([^"]+)"/.exec(b)?.[1] ?? '';
  const last = parts.length ? parts[parts.length - 1] : '';
  const tail = last.endsWith('\n') ? '' : null;
  if (tail === null) return text;
  const blocks = parts.map((b) => b.replace(/\n+$/, ''));
  blocks.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  return `${head}\n${blocks.map((b) => `[[package]]\n${b}\n`).join('\n')}`;
}

/** Split a text into free and protected pieces (`old-name:` lines, `old-name:begin` … `old-name:end` regions). */
function pieces(text) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  let inRegion = false;
  for (const line of lines) {
    let kept = inRegion;
    if (line.includes('old-name:begin')) (inRegion = true), (kept = true);
    else if (line.includes('old-name:end')) (inRegion = false), (kept = true);
    else if (line.includes('old-name:')) kept = true;
    const last = out[out.length - 1];
    if (last && last.kept === kept) last.text += line;
    else out.push({ kept, text: line });
  }
  return out;
}

/** The renamed text of one file, and the count per rule (`counts` is filled in place when given). */
export function renameText(path, text, counts = new Map()) {
  let t = text;
  for (const [from, to] of FILE_RULES[path] ?? []) {
    if (t.includes(from)) {
      t = t.split(from).join(to);
      counts.set('file rule', (counts.get('file rule') ?? 0) + 1);
    }
  }
  t = pieces(t)
    .map((p) => {
      if (p.kept) return p.text;
      let s = p.text;
      for (const [name, re, to] of RULES) {
        const n = (s.match(re) ?? []).length;
        if (!n) continue;
        counts.set(name, (counts.get(name) ?? 0) + n);
        s = s.replace(re, to);
      }
      return s;
    })
    .join('');
  if (POST_RULES[path]) t = POST_RULES[path](t);
  return t;
}

function skipped(path) {
  return SKIP.some((re) => re.test(path)) || BINARY.test(path);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** The tracked files (never untracked ones: another session's work, a person's notes). */
function trackedFiles() {
  return git(['ls-files', '-z', '-c']).split('\0').filter(Boolean);
}

/** Tracked files with changes in the working tree or the index. */
function dirtyFiles() {
  return git(['status', '--porcelain', '-z', '--untracked-files=no']).split('\0').filter(Boolean);
}

const REAL_ROOT = realpathSync(ROOT);

/** Whether `abs` (resolved through its links) lies inside the repository. */
function insideRepo(abs) {
  try {
    const real = realpathSync(abs);
    return real === REAL_ROOT || real.startsWith(REAL_ROOT + sep);
  } catch {
    return false;
  }
}

/** A regular file of the repository, never through a link (the file itself or a folder on the way). */
function plainFile(rel) {
  const abs = join(ROOT, rel);
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  const real = realpathSync(abs);
  return real === join(REAL_ROOT, rel);
}

/** `--only` paths as repository paths; throws on one outside the repository. */
function onlyPaths(args) {
  return args.map((a) => {
    const abs = resolve(ROOT, a);
    const rel = relative(ROOT, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !insideRepo(dirname(abs))) throw new Error(`--only ${a}: not a path inside the repository`);
    return rel.split(sep).join('/');
  });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a file, or null when it is not valid UTF-8 (decoded and encoded back, the same bytes). */
function utf8Text(buf) {
  try {
    const text = UTF8.decode(buf);
    return Buffer.from(text, 'utf8').equals(buf) ? text : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const dry = argv.includes('--dry');
  const at = argv.indexOf('--only');
  const only = at >= 0 ? onlyPaths(argv.slice(at + 1).filter((a) => !a.startsWith('--'))) : null;
  if (!only && !dry && !argv.includes('--allow-dirty')) {
    const dirty = dirtyFiles();
    if (dirty.length) {
      console.error(`refused: ${dirty.length} tracked file(s) have changes (commit or stash them, rewrite them with --only, or pass --allow-dirty):`);
      for (const d of dirty.slice(0, 20)) console.error(`  ${d}`);
      process.exitCode = 1;
      return;
    }
  }
  const files = (only ?? trackedFiles()).filter((f) => !skipped(f) && existsSync(join(ROOT, f)));
  const counts = new Map();
  const changed = [];
  const review = [];
  for (const f of files) {
    if (!plainFile(f)) {
      console.warn(`skipped ${f}: a symbolic link (or under one), or not a regular file`);
      continue;
    }
    const buf = readFileSync(join(ROOT, f));
    if (buf.subarray(0, 8000).includes(0)) continue;
    const before = utf8Text(buf);
    if (before === null) {
      if (/demo|studio/i.test(buf.toString('latin1'))) console.warn(`skipped ${f}: not valid UTF-8 (rewrite it by hand if it names the old product)`);
      continue;
    }
    const after = renameText(f, before, counts);
    if (after !== before) {
      changed.push(f);
      if (!dry) writeFileSync(join(ROOT, f), after);
    }
    if (dry) {
      for (const m of after.matchAll(/(?<![\w./@:$\\'"`-])studio(?![\w/:.'"`-])(?! \(the Studio| channel)/g)) {
        const line = after.slice(after.lastIndexOf('\n', m.index) + 1, after.indexOf('\n', m.index) >>> 0 || undefined);
        review.push(`${f}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  if (!only && !dry) {
    for (const [from, to] of PATH_RENAMES) {
      const src = join(ROOT, from);
      let st;
      try {
        st = lstatSync(src);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !insideRepo(dirname(src)) || existsSync(join(ROOT, to))) continue;
      renameSync(src, join(ROOT, to));
    }
  }
  for (const [name, n] of counts) console.log(`${String(n).padStart(6)}  ${name}`);
  console.log(`${changed.length} file(s) ${dry ? 'would change' : 'changed'}`);
  if (dry) {
    for (const f of changed) console.log(`  ${f}`);
    console.log(`\nlower-case "studio" words left (${review.length}), to look at:`);
    for (const r of review) console.log(`  ${r}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
