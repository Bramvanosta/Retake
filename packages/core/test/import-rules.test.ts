/**
 * The import-rules ratchet: the layer rules of docs/audit/target-architecture.md (R1–R7), file cycles, who builds the
 * file job queue and who calls the process-wide setters, held to the committed baseline (scripts/audit/baseline.json).
 * A new violation fails, and so does a stale baseline entry (the count only goes down, in the commit that lowers it).
 * The rules are scripts/audit/lib.mjs, shared with the audit scripts (rules.mjs, imports.mjs).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROJECT_DIRS, STATE_DIR } from '../src/layout.js';
// @ts-expect-error — a plain .mjs script without types
import * as lib from '../../../scripts/audit/lib.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Hit = { rule: string; file: string; spec: string };
const hits = (fileImports: Record<string, string[]>, root = ROOT): string[] => lib.ruleHits(root, fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
const wiring = (rel: string, text: string): string[] => lib.wiringHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);

describe('the import-rules ratchet', () => {
  it('the repository holds its baseline: no new violation, no stale entry, every group with a reason', () => {
    const entries = lib.ratchetEntries(ROOT);
    const report = lib.ratchetReport(lib.compareBaseline(entries, lib.readBaseline(ROOT)));
    expect(report, report).toBe('');
    // The baseline is written the way --write-baseline writes it (so that command only ever changes what moved).
    const baseline = lib.readBaseline(ROOT);
    expect(lib.rewriteBaseline(entries, baseline)).toEqual(baseline);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('flags each layer rule on the import that breaks it, and leaves the allowed imports alone', () => {
    expect(hits({ 'packages/core/src/a.ts': ['node:fs', 'fs/promises', 'node:path', 'zod', './b.js'] })).toEqual(['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/a.ts → fs/promises']);
    expect(hits({ 'packages/editor/src/a.ts': ['@retake/engine', '@retake/core'], 'packages/hooks/src/a.ts': ['@retake/cli'] })).toEqual(['R2 packages/editor/src/a.ts → @retake/engine', 'R2 packages/hooks/src/a.ts → @retake/cli']);
    expect(hits({ 'packages/ui/src/server/a.ts': ['@retake/mcp', '@retake/engine'], 'packages/cli/src/a.ts': ['@retake/mcp', '@retake/ui'] })).toEqual(['R3 packages/ui/src/server/a.ts → @retake/mcp']);
    expect(hits({ 'packages/mcp/src/a.ts': ['@retake/editor', '@retake/engine', '@retake/core'] })).toEqual(['R4 packages/mcp/src/a.ts → @retake/editor']);
    expect(hits({ 'packages/mcp/src/tools/a.ts': ['node:fs', 'node:path'], 'packages/mcp/src/a.ts': ['node:fs'], 'packages/cli/src/commands/b.ts': ['child_process'] })).toEqual(['R6 packages/mcp/src/tools/a.ts → node:fs', 'R6 packages/cli/src/commands/b.ts → child_process']);
    expect(hits({ 'packages/editor/src/plan.ts': ['remotion', 'node:fs', './timing.js'], 'packages/review/src/checks.ts': ['react'], 'packages/editor/src/render/a.ts': ['remotion'] })).toEqual(['R7 packages/editor/src/plan.ts → remotion', 'R7 packages/editor/src/plan.ts → node:fs', 'R7 packages/review/src/checks.ts → react']);
  });

  /** Rule hits of files written into a scratch repository (the specifiers the scan's pre-processor would list). */
  const hitsOf = (files: Record<string, { text: string; specs: string[] }>): string[] => {
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    try {
      for (const [rel, { text }] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
      return hits(Object.fromEntries(Object.entries(files).map(([rel, { specs }]) => [rel, specs])), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('allows type-only imports from other packages in the Studio front end, not value imports', () => {
    const app = (name: string, text: string) => [`packages/ui/src/app/${name}.ts`, { text, specs: ['@retake/core'] }] as const;
    const files = Object.fromEntries([
      app('types', "import type { Step } from '@retake/core';\n"),
      app('named-types', "import { type Step, type Scene } from '@retake/core';\n"),
      app('reexport-types', "export type { Step } from '@retake/core';\n"),
      app('reexport-named-types', 'export { type Step } from "@retake/core";\n'),
      app('type-position', "let s: import('@retake/core').Step;\n"),
      app('value', "import { parseScenario } from '@retake/core';\n"),
      app('double-quotes', 'import { parseScenario } from "@retake/core";\n'),
      app('mixed', "import { type Step, parseScenario } from '@retake/core';\n"),
      app('default', "import core from '@retake/core';\n"),
      app('reexport', "export { parseScenario } from '@retake/core';\n"),
      app('reexport-all', "export * from '@retake/core';\n"),
      app('side-effect', "import '@retake/core';\n"),
      app('dynamic', "const core = await import('@retake/core');\n"),
      app('require', "import core = require('@retake/core');\n"),
    ]);
    const flagged = hitsOf(files).map((h) => h.replace(/^R5 packages\/ui\/src\/app\/(.+)\.ts → @retake\/core$/, '$1'));
    expect(flagged.sort()).toEqual(['default', 'double-quotes', 'dynamic', 'mixed', 'reexport', 'reexport-all', 'require', 'side-effect', 'value']);
    // A file that cannot be read counts as a value import (the check fails closed).
    expect(hits({ 'packages/ui/src/app/gone.ts': ['@retake/core'] }, join(tmpdir(), 'retake-import-rules-none'))).toEqual(['R5 packages/ui/src/app/gone.ts → @retake/core']);
  });

  it('counts a module loader in core as I/O: node:module, process.getBuiltinModule(), import() of a computed name', () => {
    const found = hitsOf({
      'packages/core/src/loader.ts': { text: "import { createRequire } from 'node:module';\nexport const req = createRequire(import.meta.url);\n", specs: ['node:module'] },
      'packages/core/src/builtin.ts': { text: "export const fs = process.getBuiltinModule('node:fs');\nexport const g = globalThis.process.getBuiltinModule('fs');\n", specs: [] },
      'packages/core/src/computed.ts': { text: "export const load = (name: string) => import(name);\nexport const ok = () => import('./x.js');\n", specs: ['./x.js'] },
      'packages/core/src/net.ts': { text: '', specs: ['node:tls', 'http2', 'node:dgram', 'node:vm', 'node:path'] },
      'packages/core/src/pure.ts': { text: "import { join } from 'node:path';\nexport const j = join;\n", specs: ['node:path'] },
      'packages/editor/src/other.ts': { text: "export const fs = process.getBuiltinModule('node:fs');\n", specs: [] },
    });
    expect(found.sort()).toEqual([
      'R1 packages/core/src/builtin.ts → getBuiltinModule()',
      'R1 packages/core/src/computed.ts → import()',
      'R1 packages/core/src/loader.ts → node:module',
      'R1 packages/core/src/net.ts → http2',
      'R1 packages/core/src/net.ts → node:dgram',
      'R1 packages/core/src/net.ts → node:tls',
      'R1 packages/core/src/net.ts → node:vm',
    ]);
  });

  it('finds a file cycle and names it by its first file', () => {
    const cycles = lib.fileCycles({ 'packages/x/src/b.ts': ['./a.js'], 'packages/x/src/a.ts': ['./b.js'], 'packages/x/src/c.ts': ['./a.js', './d/index.js'], 'packages/x/src/d/index.ts': [] });
    expect(cycles).toEqual([['packages/x/src/a.ts', 'packages/x/src/b.ts']]);
  });

  it('counts the imports inside a cycle, so a new import between files already in it fails the ratchet', () => {
    const write = (fileImports: Record<string, string[]>): string[] => {
      const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
      try {
        mkdirSync(join(root, 'packages/x/src'), { recursive: true });
        writeFileSync(join(root, 'packages/x/package.json'), '{"name":"@retake/x"}');
        for (const [rel, specs] of Object.entries(fileImports)) writeFileSync(join(root, rel), specs.map((s) => `import './${s}';\n`).join(''));
        return lib.ratchetEntries(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    // a → b → c → a: one cycle of three imports.
    const before = write({ 'packages/x/src/a.ts': ['b.js'], 'packages/x/src/b.ts': ['c.js'], 'packages/x/src/c.ts': ['a.js'] });
    expect(before).toEqual([
      'cycle packages/x/src/a.ts → 3 imports inside its cycle',
      'cycle packages/x/src/a.ts → cycle of packages/x/src/a.ts',
      'cycle packages/x/src/b.ts → cycle of packages/x/src/a.ts',
      'cycle packages/x/src/c.ts → cycle of packages/x/src/a.ts',
    ]);
    const baseline = { groups: [{ rule: 'cycle', reason: 'They use each other.', entries: before.map((e) => e.slice('cycle '.length)) }] };
    expect(lib.ratchetReport(lib.compareBaseline(before, baseline))).toBe('');
    // b → a as well: the same files, one more cycle among them (an import twice counts once).
    const after = write({ 'packages/x/src/a.ts': ['b.js'], 'packages/x/src/b.ts': ['c.js', 'a.js', 'a.js'], 'packages/x/src/c.ts': ['a.js'] });
    const cmp = lib.compareBaseline(after, baseline);
    expect(cmp.added).toEqual(['cycle packages/x/src/a.ts → 4 imports inside its cycle']);
    expect(cmp.stale).toEqual(['cycle packages/x/src/a.ts → 3 imports inside its cycle']);
    // Rewritten, the new count stays in the cycle's group with its reason.
    expect(lib.rewriteBaseline(after, baseline).groups).toEqual([{ rule: 'cycle', reason: 'They use each other.', entries: [...after.map((e) => e.slice('cycle '.length))].sort() }]);
  });

  it('flags the file job queue built outside the composition roots, under its name, an alias or as a base class', () => {
    expect(wiring('packages/ui/src/server/a.ts', "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(root);")).toEqual(['queue packages/ui/src/server/a.ts → new FileJobQueue']);
    expect(wiring('packages/ui/src/server/c.ts', "import { FileJobQueue as Q } from '@retake/engine';\nconst q = new Q(root);")).toEqual(['queue packages/ui/src/server/c.ts → new FileJobQueue']);
    expect(wiring('packages/mcp/src/a.ts', "import * as e from '@retake/engine';\nconst q = new e.FileJobQueue(root);\nclass Mine extends e.FileJobQueue {}")).toEqual(['queue packages/mcp/src/a.ts → new FileJobQueue', 'queue packages/mcp/src/a.ts → extends FileJobQueue']);
    // Inside the engine too: a module is handed the queue (the JobQueue port), it does not build one.
    expect(wiring('packages/engine/src/jobs/a.ts', 'const q = new FileJobQueue(root);')).toEqual(['queue packages/engine/src/jobs/a.ts → new FileJobQueue']);
    expect(wiring('packages/engine/src/index-db/index-db.ts', 'const q = new FileJobQueue(ws.root);')).toEqual(['queue packages/engine/src/index-db/index-db.ts → new FileJobQueue']);
    // The composition roots: the engine, the worker, the job process, the CLI's workspaceQueue, and the adapter's own withOwnMemory().
    for (const root of ['packages/engine/src/engine.ts', 'packages/engine/src/jobs/worker.ts', 'packages/engine/src/jobs/job-child.ts', 'packages/engine/src/jobs/queue.ts', 'packages/cli/src/workspace.ts']) {
      expect(wiring(root, "import { FileJobQueue as Q } from '@retake/engine';\nconst q = new Q(root);"), root).toEqual([]);
    }
    // A CLI command is handed the CLI's one queue (workspaceQueue), it does not build its own.
    expect(wiring('packages/cli/src/commands/a.ts', "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(ws.root);")).toEqual(['queue packages/cli/src/commands/a.ts → new FileJobQueue']);
    expect(wiring('packages/ui/src/server/b.ts', "import type { FileJobQueue } from '@retake/engine';\nlet q: FileJobQueue;")).toEqual([]);
  });

  it('flags a submit or a worker\'s write on the job queue outside packages/engine/src, not a read nor a client\'s request', () => {
    const at = (rel: string, text: string) => wiring(rel, text);
    expect(at('packages/ui/src/server/a.ts', 'await engine.queue.enqueue(input);')).toEqual(['queue-call packages/ui/src/server/a.ts → queue.enqueue']);
    expect(at('packages/mcp/src/tools/a.ts', "await queue.claim(id, me);\nawait queue.unclaim(id);\nawait this.queue['write'](rec);")).toEqual([
      'queue-call packages/mcp/src/tools/a.ts → queue.claim',
      'queue-call packages/mcp/src/tools/a.ts → queue.unclaim',
      'queue-call packages/mcp/src/tools/a.ts → queue.write',
    ]);
    expect(at('packages/cli/src/commands/a.ts', 'await o.queue.setYield(id, null);\nawait queue.append(id, 0, []);')).toEqual(['queue-call packages/cli/src/commands/a.ts → queue.setYield', 'queue-call packages/cli/src/commands/a.ts → queue.append']);
    // Reads and a client's requests are the view's: fine anywhere; the engine's own modules submit and write.
    expect(at('packages/ui/src/server/a.ts', 'await engine.queue.list({});\nawait queue.cancel(id, by);\nawait queue.withOwnMemory().takeHold();\nawait other.write(x);')).toEqual([]);
    expect(at('packages/engine/src/jobs/a.ts', 'await ctx.queue.enqueue(input);\nawait w.queue.write(rec);')).toEqual([]);
  });

  it('flags the file job queue class passed on as a value outside the composition roots, not its use as a type', () => {
    const value = ['queue packages/ui/src/server/a.ts → FileJobQueue as a value'];
    const at = (text: string) => wiring('packages/ui/src/server/a.ts', text);
    expect(at("import { FileJobQueue } from '@retake/engine';\nconst Q = FileJobQueue;\nconst q = new Q(root);")).toEqual(value);
    expect(at("const { FileJobQueue: Q } = await import('@retake/engine');\nconst q = new Q(root);")).toEqual(value);
    expect(at("const { FileJobQueue } = engine;\nmake(FileJobQueue);")).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nconst Q = e['FileJobQueue'];")).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nregister(e.FileJobQueue);")).toEqual(value);
    expect(at("import { FileJobQueue as F } from '@retake/engine';\nexport const kinds = { F };")).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nimport Q = e.FileJobQueue;")).toEqual(value);
    // Types only: annotations, typeof, generics, implements, type declarations.
    expect(at("import { FileJobQueue } from '@retake/engine';\nlet q: FileJobQueue;\ntype Ctor = typeof FileJobQueue;\ninterface I { q: FileJobQueue }\nclass Mine implements FileJobQueue {}\nconst xs: Array<FileJobQueue> = [];\nconst y = q as FileJobQueue;")).toEqual([]);
    expect(wiring('packages/engine/src/jobs/b.ts', 'const Q = FileJobQueue;')).toEqual(['queue packages/engine/src/jobs/b.ts → FileJobQueue as a value']);
    expect(wiring('packages/engine/src/engine.ts', 'const Q = FileJobQueue;')).toEqual([]);
  });

  it('flags a process-wide setter used outside the workspace module, called or passed on, and not its declaration', () => {
    expect(wiring('packages/cli/src/a.ts', "import { useAgentPolicy } from '@retake/core';\nuseAgentPolicy(null);")).toEqual(['setter packages/cli/src/a.ts → useAgentPolicy']);
    expect(wiring('packages/ui/src/server/a.ts', "import * as core from '@retake/core';\ncore.useWorkspaceFfmpeg('x');")).toEqual(['setter packages/ui/src/server/a.ts → useWorkspaceFfmpeg']);
    expect(wiring('packages/mcp/src/a.ts', "import { useWorkspaceRender as set } from '@retake/core';\nconst f = set;\nf(undefined);")).toEqual(['setter packages/mcp/src/a.ts → useWorkspaceRender']);
    expect(wiring('packages/engine/src/workspace.ts', "import { useAgentPolicy } from '@retake/core';\nuseAgentPolicy(null);")).toEqual([]);
    expect(wiring('packages/core/src/agent-policy.ts', 'export function useAgentPolicy(folders: string[] | null): void {}')).toEqual([]);
    expect(wiring('packages/core/src/index.ts', "export { useAgentPolicy } from './agent-policy.js';")).toEqual([]);
  });

  it('rules.mjs --check without a root checks the current folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    try {
      mkdirSync(join(root, 'packages/x/src'), { recursive: true });
      writeFileSync(join(root, 'packages/x/package.json'), '{"name":"@retake/x"}');
      writeFileSync(join(root, 'packages/x/src/a.ts'), 'export const a = 1;\n');
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/audit/rules.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('scripts/audit/baseline.json holds: 0 entries');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts the hand-joined layout names outside the layout module: node:path join / resolve under any name, a literal or a template', () => {
    const layout = (rel: string, text: string): string[] => lib.layoutHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).map((h: { file: string; count: number }) => `${h.file} ${h.count}`);
    const text = [
      "import { join, resolve as res, posix } from 'node:path';",
      "import path from 'node:path';",
      "import * as np from 'path';",
      "join(dir, 'runs', id);", // 1
      "res(root, '.retake');", // 2
      'join(dir, `scenarios/${name}.yaml`);', // 3
      "path.join(dir, 'renders');", // 4
      "path.posix.join('review', id);", // 5
      "posix.join(dir, 'exports');", // 6
      "np.resolve(dir, 'comments', 'x');", // 7
      "join(dir, 'hooks', 'a'), join(dir, 'assets');", // 8, 9
      // Not counted: other names, an array's join, another module's join, a layout name that is not a path argument.
      "join(dir, 'project.yaml'); join(dir, 'runsx'); ['runs', 'x'].join('/'); other.join('runs'); f('runs');",
    ].join('\n');
    expect(layout('packages/engine/src/a.ts', text)).toEqual(['packages/engine/src/a.ts 9']);
    expect(layout('packages/core/src/layout.ts', text)).toEqual([]);
    expect(layout('packages/engine/src/b.ts', "import { join } from 'node:path';\njoin(dir, 'scenarios-old');\n")).toEqual([]);
    // The names the check looks for are the layout module's.
    expect([...lib.LAYOUT_NAMES].sort()).toEqual([...Object.values(PROJECT_DIRS), STATE_DIR].sort());
    // A ratchet entry per file, with its count: one more join in a file is a new entry (and its old count a stale one).
    expect(lib.ratchetEntries(ROOT).filter((e: string) => e.startsWith('layout '))).toEqual([]);
  });

  it('fails on a new entry, a stale entry, a group without a reason, and says how to update the baseline', () => {
    const baseline = { groups: [{ rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] }, { rule: 'R6', reason: '', entries: ['packages/cli/src/commands/a.ts → node:fs'] }] };
    const now = ['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/new.ts → node:os', 'R6 packages/cli/src/commands/a.ts → node:fs'];
    const cmp = lib.compareBaseline(now, baseline);
    expect(cmp.added).toEqual(['R1 packages/core/src/new.ts → node:os']);
    expect(cmp.stale).toEqual(['R1 packages/core/src/gone.ts → node:fs']);
    expect(cmp.unexplained).toEqual(['R6: packages/cli/src/commands/a.ts → node:fs']);
    const report = lib.ratchetReport(cmp);
    expect(report).toContain('New violations');
    expect(report).toContain('Stale baseline entries');
    expect(report).toContain('node scripts/audit/rules.mjs . --write-baseline');
    expect(lib.ratchetReport(lib.compareBaseline(['R1 packages/core/src/a.ts → node:fs'], { groups: [{ rule: 'R1', reason: 'x', entries: ['packages/core/src/a.ts → node:fs'] }] }))).toBe('');
    expect(lib.compareBaseline([], { groups: [{ rule: 'R9', reason: 'x', entries: ['a → b'] }] }).misfiled).toEqual(['R9 a → b']);
  });

  it('rewrites the baseline keeping reasons, dropping stale entries and grouping new ones to explain', () => {
    const baseline = { about: 'a', groups: [{ rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] }, { rule: 'R4', reason: 'Gone.', entries: ['packages/cli/src/x.ts → @retake/editor'] }] };
    const next = lib.rewriteBaseline(['R1 packages/core/src/a.ts → node:fs', 'R1 packages/core/src/new.ts → node:os', 'queue packages/ui/src/a.ts → new FileJobQueue'], baseline);
    expect(next).toEqual({
      about: 'a',
      groups: [
        { rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs'] },
        { rule: 'R1', reason: '', entries: ['packages/core/src/new.ts → node:os'] },
        { rule: 'queue', reason: '', entries: ['packages/ui/src/a.ts → new FileJobQueue'] },
      ],
    });
  });
});
