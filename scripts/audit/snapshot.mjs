#!/usr/bin/env node
// One audit snapshot (read-only, offline): runs the architecture probes of this folder and gathers the supply-chain
// counts, then writes the raw outputs and one `summary.json` into a dated folder, so two audits compare with
// `compare.mjs`. Nothing in the repository is changed; the probes read `packages/*/src` and the lockfiles only.
// Usage: node scripts/audit/snapshot.mjs [--root .] [--out <folder>]   (default out: a new temp folder, printed)
// The method around it (security checklist, what to read, how to compare) is docs/audit/METHOD.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const root = path.resolve(opt('--root') ?? '.');
const out = path.resolve(opt('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'retake-audit-')));
fs.mkdirSync(out, { recursive: true });

const node = (script, args) => execFileSync(process.execPath, [path.join(here, script), root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const save = (name, text) => fs.writeFileSync(path.join(out, name), text);
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');

save('imports.out', node('imports.mjs', ['--json', path.join(out, 'imports.json')]));
save('rules.out', node('rules.mjs', ['--imports', path.join(out, 'imports.json'), '--json', path.join(out, 'rules.json'), '--list']));
save('sizes.out', node('sizes.mjs', ['--json', path.join(out, 'sizes.json')]));
save('dupes.out', node('dupes.mjs', ['--json', path.join(out, 'dupes.json')]));
save('terms.out', node('terms.mjs', []));

const imports = JSON.parse(fs.readFileSync(path.join(out, 'imports.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(out, 'rules.json'), 'utf8'));
const sizes = JSON.parse(fs.readFileSync(path.join(out, 'sizes.json'), 'utf8'));
const dupes = JSON.parse(fs.readFileSync(path.join(out, 'dupes.json'), 'utf8'));

const lock = read('pnpm-lock.yaml');
const lockPackages = (() => {
  const m = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0] ?? '';
  return m.split('\n').filter((l) => /^ {2}\S/.test(l)).length;
})();
const cargo = read('apps/desktop/Cargo.lock');
const workflows = fs.existsSync(path.join(root, '.github/workflows')) ? fs.readdirSync(path.join(root, '.github/workflows')) : [];
const uses = workflows.flatMap((w) => read(`.github/workflows/${w}`).match(/^\s*(?:-\s*)?uses:\s*\S+/gm) ?? []);

const summary = {
  commit: git('rev-parse', 'HEAD'),
  date: new Date().toISOString().slice(0, 10),
  packages: Object.fromEntries(
    Object.entries(imports.packages).map(([p, r]) => [
      p,
      {
        files: r.files,
        lines: r.lines,
        ioFiles: r.ioFiles,
        pureFiles: r.pureFiles,
        builtinImports: r.builtinImportsTotal,
        retakeDeps: Object.keys(r.actual)
          .filter((d) => d !== p)
          .sort(),
      },
    ]),
  ),
  packageCycles: imports.packageCycles.length,
  fileCycles: imports.fileCycles.length,
  rules: Object.fromEntries(rules.map((r) => [r.rule.split(' ')[0], r.violations])),
  sizes: { files: sizes.files, lines: sizes.lines, buckets: sizes.buckets, longFunctions: sizes.longFunctions, longFunctionsPerPackage: sizes.longFunctionsPerPackage },
  tests: sizes.tests,
  duplication: { blocks: dupes.blocks, lines: dupes.lines, crossBlocks: dupes.crossBlocks, crossLines: dupes.crossLines },
  supplyChain: {
    pnpmLockPackages: lockPackages,
    pnpmSha512: (lock.match(/integrity: sha512-/g) ?? []).length,
    pnpmGitOrTarball: (lock.match(/tarball:|git\+|codeload\.github/g) ?? []).length,
    cargoLockPackages: (cargo.match(/^\[\[package\]\]$/gm) ?? []).length,
    cargoGitSources: (cargo.match(/^source = "git\+/gm) ?? []).length,
    workflows: workflows.length,
    actionUses: uses.length,
    actionUsesPinnedBySha: uses.filter((u) => /@[0-9a-f]{40}\b/.test(u)).length,
  },
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(out);
