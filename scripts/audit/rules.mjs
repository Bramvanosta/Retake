// Dependency-rule probe (read-only): the import rules the target architecture proposes, checked against today's code.
// It is the prototype of an import-rules test (a ratchet: today's violations as the allowed baseline, never more).
// Usage: node scripts/audit/rules.mjs <repo-root> --imports <imports.json> [--json <out.json>] [--list]
//        (imports.json comes from `imports.mjs --json`; without --imports it runs imports.mjs into a temp file)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? '.');
const opt = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const LIST = process.argv.includes('--list');
let jf = opt('--imports');
if (!jf) {
  jf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retake-audit-')), 'imports.json');
  execFileSync(process.execPath, [path.join(here, 'imports.mjs'), root, '--json', jf], { stdio: 'ignore' });
}
const { fileImports } = JSON.parse(fs.readFileSync(jf, 'utf8'));

const IO = /^(node:)?(fs|fs\/promises|child_process|net|http|https|os|dns|dns\/promises|worker_threads|readline|sqlite|zlib|stream)$|^(playwright|playwright-core|pg|sharp|esbuild|@remotion\/(renderer|bundler)|@modelcontextprotocol|pdfjs-dist)/;
const pkgOf = (f) => f.split('/')[1];
const retake = (s) => (s.startsWith('@retake/') ? s.slice(8).split('/')[0] : null);

// Rule set. `files` selects importing files; `bad(spec, file)` says whether one import breaks the rule.
const SHELLS = ['cli', 'mcp', 'ui'];
const ADAPTERS = ['runner-web', 'editor', 'review', 'sandbox', 'hooks', 'components'];
const rules = [
  { id: 'R1 core is I/O-free (domain)', files: (f) => pkgOf(f) === 'core', bad: (s) => IO.test(s) },
  { id: 'R2 adapters never import application or shells', files: (f) => ADAPTERS.includes(pkgOf(f)), bad: (s) => ['engine', 'mcp', 'ui', 'cli'].includes(retake(s)) },
  { id: 'R3 shells never import another shell (ui→mcp, mcp→ui; cli is the composition root and may)', files: (f) => ['mcp', 'ui'].includes(pkgOf(f)), bad: (s, f) => { const p = retake(s); return p && SHELLS.includes(p) && p !== pkgOf(f); } },
  { id: 'R4 shells call the application only (no direct adapter import)', files: (f) => SHELLS.includes(pkgOf(f)), bad: (s) => ['runner-web', 'editor', 'review', 'sandbox', 'hooks', 'components'].includes(retake(s)) },
  { id: 'R5 the Studio front end imports types only from other packages (checked: any @retake value import in src/app)', files: (f) => f.startsWith('packages/ui/src/app/'), bad: (s) => !!retake(s), typeOnlyCheck: true },
  { id: 'R6 shells do not touch the file system / processes themselves', files: (f) => ['packages/mcp/src/tools/', 'packages/ui/src/server/', 'packages/cli/src/commands/'].some((p) => f.startsWith(p)), bad: (s) => /^(node:)?(fs|fs\/promises|child_process)$/.test(s) },
  { id: 'R7 the planner and review checks stay renderer-free (editor/review pure modules)', files: (f) => /packages\/editor\/src\/(plan|plan-types|timing|camera|layout|panes|timeline|resolve|tutorial|summary)\.ts$/.test(f) || /packages\/review\/src\/(checks|pixel-checks|spans|timeline|anchor|diff)\.ts$/.test(f), bad: (s) => IO.test(s) || /^remotion|^react/.test(s) },
];

const totals = [];
for (const r of rules) {
  const hits = [];
  for (const [f, specs] of Object.entries(fileImports)) {
    if (!r.files(f)) continue;
    let src;
    for (const s of specs) {
      if (!r.bad(s, f)) continue;
      if (r.typeOnlyCheck) {
        src ??= fs.readFileSync(path.join(root, f), 'utf8');
        const re = new RegExp(`import\\s+(?!type\\b)[^;]*from\\s+'${s.replace(/[/.]/g, '\\$&')}'`);
        if (!re.test(src)) continue;
      }
      hits.push(`${f} → ${s}`);
    }
  }
  const files = new Set(hits.map((h) => h.split(' → ')[0]));
  totals.push({ rule: r.id, violations: hits.length, files: files.size });
  console.log(`${r.id}: ${hits.length} imports in ${files.size} files`);
  if (LIST) for (const h of hits) console.log('   ', h);
}
const out = opt('--json');
if (out) fs.writeFileSync(out, JSON.stringify(totals, null, 1) + '\n');
