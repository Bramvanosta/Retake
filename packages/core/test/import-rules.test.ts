/**
 * The import-rules ratchet: the layer rules of docs/audit/target-architecture.md (R1–R13), file cycles, who builds the
 * file job queue, and no module-level variable holding the work's policy, held to the committed baseline
 * (scripts/audit/baseline.json).
 * A new violation fails, and so does a stale baseline entry (the count only goes down, in the commit that lowers it).
 * The rules are scripts/audit/lib.mjs, shared with the audit scripts (rules.mjs, imports.mjs).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HISTORY_FILE, PROJECT_DIRS, PROJECT_SCENARIO_WRITES_FILE, STATE_DIR, WORKSPACE_JOURNAL_FILE } from '../src/layout.js';
import { ULID_PREFIXES } from '../src/id-grammar.js';
// @ts-expect-error — a plain .mjs script without types
import * as lib from '../../../scripts/audit/lib.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Hit = { rule: string; file: string; spec: string };
const hits = (fileImports: Record<string, readonly string[]>, root = ROOT): string[] => lib.ruleHits(root, fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
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
    expect(hits({ 'packages/editor/src/a.ts': ['@retake/engine', '@retake/core'], 'packages/hooks/src/a.ts': ['@retake/cli'] })).toEqual([
      'R2 packages/editor/src/a.ts → @retake/engine',
      'R2 packages/hooks/src/a.ts → @retake/cli',
    ]);
    expect(hits({ 'packages/ui/src/server/a.ts': ['@retake/mcp', '@retake/engine'], 'packages/cli/src/a.ts': ['@retake/mcp', '@retake/ui'] })).toEqual([
      'R3 packages/ui/src/server/a.ts → @retake/mcp',
    ]);
    expect(hits({ 'packages/mcp/src/a.ts': ['@retake/editor', '@retake/engine', '@retake/core'] })).toEqual(['R4 packages/mcp/src/a.ts → @retake/editor']);
    expect(hits({ 'packages/mcp/src/tools/a.ts': ['node:fs', 'node:path'], 'packages/mcp/src/a.ts': ['node:fs'], 'packages/cli/src/commands/b.ts': ['child_process'] })).toEqual([
      'R6 packages/mcp/src/tools/a.ts → node:fs',
      'R6 packages/cli/src/commands/b.ts → child_process',
    ]);
    expect(
      hits({
        'packages/editor/src/plan.ts': ['remotion', 'node:fs', './timing.js'],
        'packages/review/src/checks.ts': ['react'],
        'packages/editor/src/render/a.ts': ['remotion'],
        'packages/review/src/pixel-maths.ts': ['node:child_process', './types.js'],
        'packages/review/src/pixels.ts': ['node:child_process'],
      }),
    ).toEqual([
      'R7 packages/editor/src/plan.ts → remotion',
      'R7 packages/editor/src/plan.ts → node:fs',
      'R7 packages/review/src/checks.ts → react',
      'R7 packages/review/src/pixel-maths.ts → node:child_process',
    ]);
  });

  /** Rule hits of files written into a scratch repository (the specifiers the scan's pre-processor would list). */
  const hitsOf = (files: Record<string, { text: string; specs: readonly string[] }>): string[] => {
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

  it('core outside its io side reads the environment in three listed defaults only (docs/DESIGN.md §1): defaultSecrets, expandHome, unsafeTestResolve', () => {
    const scanned = lib.scan(ROOT);
    const reads = scanned.files
      .filter((f: { rel: string }) => f.rel.startsWith('packages/core/src/') && !f.rel.startsWith(lib.CORE_IO_DIR))
      .flatMap((f: { rel: string; text: string }) => {
        const lines = f.text.split('\n');
        // Each read, named by the function it is in (the nearest declaration above it).
        const fn = (i: number): string =>
          lines
            .slice(0, i + 1)
            .reverse()
            .map((l) => /\bfunction (\w+)/.exec(l)?.[1])
            .find(Boolean) ?? `line ${i + 1}`;
        return lines.flatMap((line, i) => (/\bprocess\.(?:env|platform|cwd|argv|execPath|getBuiltinModule)\b/.test(line) && !/^\s*(?:\*|\/\/)/.test(line) ? [`${f.rel} ${fn(i)}`] : []));
      });
    expect(reads.sort()).toEqual(['packages/core/src/site.ts unsafeTestResolve', 'packages/core/src/templating.ts defaultSecrets', 'packages/core/src/util.ts expandHome']);
  });

  it('R1 sees every form of an import of the io side read from a source (scan): static, bare folder, re-export, require(), import(), import = require()', () => {
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    try {
      mkdirSync(join(root, 'packages', 'core', 'src', 'io'), { recursive: true });
      writeFileSync(join(root, 'packages', 'core', 'package.json'), '{"name": "@retake/core"}\n');
      const files: Record<string, string> = {
        'io/index.ts': 'export const r = 1;\n',
        'bare.ts': "import { r } from './io';\nexport const x = r;\n",
        'index-file.ts': "export * from './io/index.js';\n",
        'req.ts': "const io = require('./io/index.js');\nexport const x = io;\n",
        'dyn.ts': "export const load = () => import('../src/io/index.js');\n",
        'eq.ts': "import io = require('@retake/core/io');\nexport const x = io;\n",
        'type-only.ts': "import type { R } from './io/index.js';\nexport type X = R;\n",
        'iota.ts': "import { y } from './iota-helpers.js';\nexport const z = y;\n",
        'iota-helpers.ts': 'export const y = 1;\n',
      };
      for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, 'packages', 'core', 'src', rel), text);
      const scanned = lib.scan(root);
      expect(
        lib
          .ruleHits(root, scanned.fileImports)
          .map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`)
          .sort(),
      ).toEqual([
        'R1 packages/core/src/bare.ts → ./io',
        'R1 packages/core/src/dyn.ts → ../src/io/index.js',
        'R1 packages/core/src/eq.ts → @retake/core/io',
        'R1 packages/core/src/index-file.ts → ./io/index.js',
        'R1 packages/core/src/req.ts → ./io/index.js',
        'R1 packages/core/src/type-only.ts → ./io/index.js',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("R1 holds for core outside its io side, which the rest of core never imports; node:net's address helpers are no I/O", () => {
    const found = hitsOf({
      'packages/core/src/io/reader.ts': { text: "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n", specs: ['node:fs'] },
      'packages/core/src/pure.ts': { text: "import { r } from './io/reader.js';\nexport const x = r;\n", specs: ['./io/reader.js'] },
      'packages/core/src/checks/deep.ts': { text: "import { r } from '../io/reader.js';\nimport { y } from '../pure.js';\n", specs: ['../io/reader.js', '../pure.js'] },
      'packages/core/src/entry.ts': { text: "export * from '@retake/core/io';\n", specs: ['@retake/core/io'] },
      'packages/core/src/ip.ts': {
        text: "import { BlockList, isIP } from 'node:net';\nimport type { Socket } from 'node:net';\nexport const a = [BlockList, isIP];\n",
        specs: ['node:net', 'node:net'],
      },
      'packages/core/src/socket.ts': { text: "import { connect, isIP } from 'node:net';\nexport const c = [connect, isIP];\n", specs: ['node:net'] },
      'packages/core/src/all.ts': { text: "import * as net from 'node:net';\nexport const n = net;\n", specs: ['node:net'] },
      'packages/core/src/again.ts': { text: "import { isIP } from 'node:net';\nexport { isIPv4 } from 'node:net';\n", specs: ['node:net', 'node:net'] },
    });
    expect(found.sort()).toEqual([
      'R1 packages/core/src/again.ts → node:net',
      'R1 packages/core/src/again.ts → node:net',
      'R1 packages/core/src/all.ts → node:net',
      'R1 packages/core/src/checks/deep.ts → ../io/reader.js',
      'R1 packages/core/src/entry.ts → @retake/core/io',
      'R1 packages/core/src/pure.ts → ./io/reader.js',
      'R1 packages/core/src/socket.ts → node:net',
    ]);
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
    expect(wiring('packages/ui/src/server/a.ts', "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(root, cli, clock);")).toEqual([
      'queue packages/ui/src/server/a.ts → new FileJobQueue',
    ]);
    expect(wiring('packages/ui/src/server/c.ts', "import { FileJobQueue as Q } from '@retake/engine';\nconst q = new Q(root, cli, clock);")).toEqual([
      'queue packages/ui/src/server/c.ts → new FileJobQueue',
    ]);
    expect(wiring('packages/mcp/src/a.ts', "import * as e from '@retake/engine';\nconst q = new e.FileJobQueue(root, cli, clock);\nclass Mine extends e.FileJobQueue {}")).toEqual([
      'queue packages/mcp/src/a.ts → new FileJobQueue',
      'queue packages/mcp/src/a.ts → extends FileJobQueue',
    ]);
    // Inside the engine too: a module is handed the queue (the JobQueue port), it does not build one.
    expect(wiring('packages/engine/src/jobs/a.ts', 'const q = new FileJobQueue(root, cli, clock);')).toEqual(['queue packages/engine/src/jobs/a.ts → new FileJobQueue']);
    expect(wiring('packages/engine/src/index-db/index-db.ts', 'const q = new FileJobQueue(ws.root, cli, clock);')).toEqual(['queue packages/engine/src/index-db/index-db.ts → new FileJobQueue']);
    // The composition roots: the engine, the worker, the job process, the CLI's workspaceQueue, and the adapter's own withOwnMemory().
    for (const root of [
      'packages/engine/src/engine.ts',
      'packages/engine/src/jobs/worker.ts',
      'packages/engine/src/jobs/job-child.ts',
      'packages/engine/src/jobs/queue.ts',
      'packages/cli/src/workspace.ts',
    ]) {
      expect(wiring(root, "import { FileJobQueue as Q } from '@retake/engine';\nconst q = new Q(root, cli, clock);"), root).toEqual([]);
    }
    // A CLI command is handed the CLI's one queue (workspaceQueue), it does not build its own.
    expect(wiring('packages/cli/src/commands/a.ts', "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(ws.root, cli, clock);")).toEqual([
      'queue packages/cli/src/commands/a.ts → new FileJobQueue',
    ]);
    expect(wiring('packages/ui/src/server/b.ts', "import type { FileJobQueue } from '@retake/engine';\nlet q: FileJobQueue;")).toEqual([]);
  });

  it('flags a file job queue built without a clock anywhere but in the adapter itself, the composition roots included', () => {
    const bare = "import { FileJobQueue as Q } from '@retake/engine';\nconst a = new Q(root);\nconst b = new Q(root, cli);";
    for (const root of ['packages/engine/src/engine.ts', 'packages/engine/src/jobs/worker.ts', 'packages/engine/src/jobs/job-child.ts', 'packages/cli/src/workspace.ts']) {
      expect(wiring(root, bare), root).toEqual([`queue ${root} → new FileJobQueue without a clock`]);
      expect(wiring(root, "import { FileJobQueue } from '@retake/engine';\nconst q = new FileJobQueue(root, cli, ports.clock);"), root).toEqual([]);
    }
    // Outside the roots both: built at all, and without a clock.
    expect(wiring('packages/engine/src/jobs/a.ts', 'const q = new FileJobQueue(root);')).toEqual([
      'queue packages/engine/src/jobs/a.ts → new FileJobQueue',
      'queue packages/engine/src/jobs/a.ts → new FileJobQueue without a clock',
    ]);
    // The adapter's own file keeps its default (for tests) and hands its clock on in withOwnMemory().
    expect(wiring('packages/engine/src/jobs/queue.ts', 'class FileJobQueue {}\nconst q = new FileJobQueue(this.root, cli);')).toEqual([]);
    // A third argument that says none is no clock: the adapter's default would apply.
    expect(
      wiring('packages/engine/src/engine.ts', "import { FileJobQueue } from './jobs/queue.js';\nconst a = new FileJobQueue(root, cli, undefined);\nconst b = new FileJobQueue(root, cli, void 0);"),
    ).toEqual(['queue packages/engine/src/engine.ts → new FileJobQueue without a clock']);
    // A type position is not a construction.
    expect(wiring('packages/engine/src/engine.ts', "import type { FileJobQueue } from './jobs/queue.js';\nlet q: FileJobQueue;")).toEqual([]);
  });

  describe('clock-read and store-new: the ports named at the composition roots only', () => {
    const ports = (rel: string, text: string) => {
      const { clock, hits } = lib.portHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]);
      return [...clock.map((h: { file: string; count: number }) => `clock-read ${h.file} → ${h.count}`), ...hits.map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`)];
    };

    it('counts the wall-clock reads of an engine file: new Date(), Date.now (called or as a value, by key too) and Date() called', () => {
      const text = [
        'const a = new Date();', // 1
        'const b = new Date;', // 2
        'const c = Date.now();', // 3
        'const d = o.now ?? Date.now;', // 4
        "const e = Date['now']();", // 5
        'const f = Date();', // 6
        'function g(now = Date.now()) { return now; }', // 7
        // Not reads: a Date of a given time, a parse, the monotonic clock, a property named now, a type.
        'const h = new Date(t); const i = Date.parse(s); const j = performance.now(); const k = clock.now(); let l: Date; const m = new Date(Date.UTC(2026, 0, 1));',
      ].join('\n');
      expect(ports('packages/engine/src/jobs/a.ts', text)).toEqual(['clock-read packages/engine/src/jobs/a.ts → 7']);
      // The port's own file reads the clock; the other packages are not counted (core may read it: its ids).
      expect(ports('packages/engine/src/clock.ts', text)).toEqual([]);
      expect(ports('packages/core/src/ids.ts', text)).toEqual([]);
      expect(ports('packages/engine/src/b.ts', 'const x = new Date(stamp).toISOString();')).toEqual([]);
    });

    it('flags the product adapters named as values outside their roots: systemClock, enginePorts, diskProjectStores', () => {
      const use = "import { systemClock, enginePorts, diskProjectStores } from '@retake/engine';\nf(systemClock);\nconst p = enginePorts();\nconst s = { diskProjectStores };";
      expect(ports('packages/engine/src/jobs/a.ts', use)).toEqual([
        'clock-read packages/engine/src/jobs/a.ts → systemClock outside a root',
        'clock-read packages/engine/src/jobs/a.ts → enginePorts outside a root',
        'store-new packages/engine/src/jobs/a.ts → diskProjectStores outside a root',
      ]);
      // A default parameter is a use too: the hidden default the port replaces.
      expect(ports('packages/engine/src/history.ts', "import { systemClock } from './clock.js';\nexport function f(clock = systemClock) {}")).toEqual([
        'clock-read packages/engine/src/history.ts → systemClock outside a root',
      ]);
      expect(ports('packages/cli/src/commands/a.ts', "import { enginePorts } from '@retake/engine';\nconst p = enginePorts();")).toEqual([
        'clock-read packages/cli/src/commands/a.ts → enginePorts outside a root',
      ]);
      // The roots: the ports bag, createEngine, the worker, the job process, the CLI's cliPorts; each adapter's own file.
      for (const root of lib.PORT_ROOTS.enginePorts) expect(ports(root, 'const p = enginePorts();'), root).toEqual([]);
      for (const root of lib.PORT_ROOTS.systemClock) expect(ports(root, 'f(systemClock);'), root).toEqual([]);
      for (const root of lib.PORT_ROOTS.diskProjectStores) expect(ports(root, 'f(diskProjectStores);'), root).toEqual([]);
      // Imports, re-exports, a declaration's own name, a property name and a type are not uses.
      expect(ports('packages/engine/src/index.ts', "export { systemClock } from './clock.js';\nexport { enginePorts } from './ports.js';")).toEqual([]);
      expect(ports('packages/engine/src/jobs/b.ts', 'const o = { systemClock: 1 }; o.enginePorts; let t: typeof diskProjectStores;')).toEqual([]);
    });

    it('flags a store or a storage of a folder built outside the store, extended or passed on as a value', () => {
      expect(ports('packages/engine/src/runs.ts', "import { LocalStorage } from './storage.js';\nconst s = new LocalStorage(dir);")).toEqual([
        'store-new packages/engine/src/runs.ts → new LocalStorage',
      ]);
      expect(ports('packages/engine/src/a.ts', 'const s = new DiskProjectStore(dir, scope);\nclass Mine extends LocalStorage {}\nconst K = LocalStorage;')).toEqual([
        'store-new packages/engine/src/a.ts → new DiskProjectStore',
        'store-new packages/engine/src/a.ts → extends LocalStorage',
        'store-new packages/engine/src/a.ts → LocalStorage as a value',
      ]);
      expect(ports('packages/cli/src/commands/a.ts', "import { LocalStorage } from '@retake/engine';\nnew LocalStorage(root).readText('x');")).toEqual([
        'store-new packages/cli/src/commands/a.ts → new LocalStorage',
      ]);
      // The store's folder and the storage module build them; a type position is not a use.
      expect(ports('packages/engine/src/store/project-store.ts', 'new LocalStorage(root); new DiskProjectStore(root, scope);')).toEqual([]);
      expect(ports('packages/engine/src/storage.ts', 'class LocalStorage {}\nnew LocalStorage(root);')).toEqual([]);
      expect(ports('packages/engine/src/b.ts', "import type { LocalStorage } from './storage.js';\nlet s: LocalStorage; class X implements LocalStorage {}")).toEqual([]);
    });

    it('sees through an import alias, a namespace import and a pattern taking now out of Date', () => {
      // Aliases and namespaces of the ports.
      expect(ports('packages/engine/src/jobs/a.ts', "import { systemClock as sc } from '../clock.js';\nf(sc);")).toEqual(['clock-read packages/engine/src/jobs/a.ts → systemClock outside a root']);
      expect(ports('packages/engine/src/jobs/a.ts', "import * as k from '../clock.js';\nf(k.systemClock);")).toEqual(['clock-read packages/engine/src/jobs/a.ts → systemClock outside a root']);
      expect(ports('packages/engine/src/jobs/a.ts', "import * as p from '../ports.js';\nconst x = p.enginePorts();\nconst y = p['enginePorts']();")).toEqual([
        'clock-read packages/engine/src/jobs/a.ts → enginePorts outside a root',
      ]);
      expect(ports('packages/cli/src/commands/a.ts', "import * as ps from '@retake/engine';\nf(ps.diskProjectStores);")).toEqual([
        'store-new packages/cli/src/commands/a.ts → diskProjectStores outside a root',
      ]);
      // Aliases and namespaces of the store classes.
      expect(ports('packages/engine/src/a.ts', "import { LocalStorage as LS } from './storage.js';\nconst s = new LS(dir);")).toEqual(['store-new packages/engine/src/a.ts → new LocalStorage']);
      expect(ports('packages/engine/src/a.ts', "import * as st from './storage.js';\nconst s = new st.LocalStorage(dir);\nclass M extends st.LocalStorage {}\nconst K = st.LocalStorage;")).toEqual([
        'store-new packages/engine/src/a.ts → new LocalStorage',
        'store-new packages/engine/src/a.ts → extends LocalStorage',
        'store-new packages/engine/src/a.ts → LocalStorage as a value',
      ]);
      // A member of an object that is not a namespace import is not the name (a context's own clock).
      expect(ports('packages/engine/src/jobs/a.ts', 'const s = stampOf(w.clock); const o = ports.systemClock; new ns.LocalStorage(dir);')).toEqual([]);
      // now taken out of Date by a pattern, in a declaration or an assignment, under its name or another.
      const text = 'const { now } = Date;\nconst { now: t } = Date;\n({ now } = Date);\nconst { parse } = Date;';
      expect(ports('packages/engine/src/jobs/b.ts', text)).toEqual(['clock-read packages/engine/src/jobs/b.ts → 3']);
      // The check's titles name what stays unseen.
      const title = (id: string) => lib.CHECKS.find((c: { id: string }) => c.id === id)?.title ?? '';
      for (const word of ['Not seen', 'Reflect', 'another name', 'await import()']) expect(title('clock-read'), word).toContain(word);
      for (const word of ['Not seen', 'Reflect.construct', 'await import()', 'import alias']) expect(title('store-new'), word).toContain(word);
      expect(title('queue')).toContain('`undefined` or `void 0`');
    });

    it('holds today: no product adapter named outside its roots, and the files that read the clock or build a storage each pinned', () => {
      const entries = lib.ratchetEntries(ROOT).filter((e: string) => e.startsWith('clock-read ') || e.startsWith('store-new '));
      expect(entries.filter((e: string) => e.endsWith('outside a root'))).toEqual([]);
      for (const e of entries) expect(e).toMatch(/^(clock-read packages\/engine\/src\/\S+ → \d+ wall-clock reads?|store-new packages\/engine\/src\/\S+ → new LocalStorage)$/);
      // No authored write builds its own store: the project store's disk adapter is built in its own file only.
      expect(entries.filter((e: string) => e.includes('DiskProjectStore'))).toEqual([]);
    });
  });

  describe('loader-use and port-types: the adapters reached through their port only', () => {
    const loaders = (rel: string, text: string): string[] => lib.loaderHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
    const ports = (rel: string, text: string): string[] => lib.portHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).hits.map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);

    it('flags an adapter loader imported from lazy.ts outside its home, under its name or an alias; its home and the editor loader are free', () => {
      expect(loaders('packages/engine/src/jobs/a.ts', "import { review } from '../lazy.js';\nawait review();")).toEqual(['loader-use packages/engine/src/jobs/a.ts → review']);
      expect(loaders('packages/engine/src/a.ts', "import { hooks as h, thumbs } from './lazy.js';")).toEqual([
        'loader-use packages/engine/src/a.ts → hooks',
        'loader-use packages/engine/src/a.ts → thumbs',
      ]);
      expect(loaders('packages/engine/src/comments/a.ts', "import { review } from '../lazy';")).toEqual(['loader-use packages/engine/src/comments/a.ts → review']);
      // The homes (LOADER_HOMES), the loader file itself, a type-only import and the editor's loader (R9's) are free.
      expect(loaders('packages/engine/src/review/review-package.ts', "import { review, thumbs } from '../lazy.js';")).toEqual([]);
      expect(loaders('packages/engine/src/hook-run/package-hooks.ts', "import { hooks } from '../lazy.js';")).toEqual([]);
      expect(loaders('packages/engine/src/review/x.ts', "import { hooks } from '../lazy.js';")).toEqual(['loader-use packages/engine/src/review/x.ts → hooks']);
      // The capture runner's loader (L7.12): free in capture/ only.
      expect(loaders('packages/engine/src/capture/runner-web-capture.ts', "import { runnerWeb } from '../lazy.js';")).toEqual([]);
      expect(loaders('packages/engine/src/jobs/worker.ts', "import { runnerWeb as rw } from '../lazy.js';\nawait rw();")).toEqual(['loader-use packages/engine/src/jobs/worker.ts → runnerWeb']);
      expect(loaders('packages/engine/src/capture/x.ts', "export { runnerWeb } from '../lazy.js';")).toEqual(['loader-use packages/engine/src/capture/x.ts → runnerWeb re-exported']);
      expect(loaders('packages/engine/src/lazy.ts', "export const review = () => import('@retake/review');")).toEqual([]);
      expect(loaders('packages/engine/src/a.ts', "import type { review } from './lazy.js';\nimport { editor } from './lazy.js';\nimport { type hooks } from './lazy.js';")).toEqual([]);
      // Another module of the same name is not the loader file.
      expect(loaders('packages/engine/src/a.ts', "import { review } from './jobs/lazy.js';\nimport { review as r } from './lazy-review.js';")).toEqual([]);
    });

    it('flags the loader file imported whole or by import(), and a loader re-exported anywhere, its home included', () => {
      expect(loaders('packages/engine/src/a.ts', "import * as lazy from './lazy.js';\nawait lazy.review();")).toEqual(['loader-use packages/engine/src/a.ts → * as lazy']);
      expect(loaders('packages/engine/src/review/a.ts', "const { review } = await import('../lazy.js');")).toEqual(['loader-use packages/engine/src/review/a.ts → import() of lazy.ts']);
      expect(loaders('packages/engine/src/jobs/a.ts', "import { editor, review } from '../lazy.js';\nexport { review };")).toEqual([
        'loader-use packages/engine/src/jobs/a.ts → review',
        'loader-use packages/engine/src/jobs/a.ts → review re-exported',
      ]);
      expect(loaders('packages/engine/src/review/a.ts', "import { review as rv } from '../lazy.js';\nexport { rv as loadReview };")).toEqual([
        'loader-use packages/engine/src/review/a.ts → review re-exported',
      ]);
      expect(loaders('packages/engine/src/review/a.ts', "export { thumbs } from '../lazy.js';")).toEqual(['loader-use packages/engine/src/review/a.ts → thumbs re-exported']);
      expect(loaders('packages/engine/src/a.ts', "export * from './lazy.js';")).toEqual(['loader-use packages/engine/src/a.ts → export * from lazy.ts']);
      expect(loaders('packages/engine/src/a.ts', "export * as lazy from './lazy.js';")).toEqual(['loader-use packages/engine/src/a.ts → export * from lazy.ts']);
      // TypeScript's import-equals and a require() of the loader file (L7.11 fix pass); a type-only one loads nothing.
      expect(loaders('packages/engine/src/a.ts', "import lazy = require('./lazy.js');\nawait lazy.review();")).toEqual(['loader-use packages/engine/src/a.ts → * as lazy']);
      expect(loaders('packages/engine/src/review/a.ts', "import type lazy = require('../lazy.js');")).toEqual([]);
      expect(loaders('packages/engine/src/jobs/a.ts', "const lazy = require('../lazy.js');")).toEqual(['loader-use packages/engine/src/jobs/a.ts → require() of lazy.ts']);
      // The limits the title names: a computed name, a loader exported under a name of its own.
      expect(loaders('packages/engine/src/jobs/a.ts', "const p = '../lazy.js';\nawait import(p);")).toEqual([]);
      expect(loaders('packages/engine/src/review/a.ts', "import { review } from '../lazy.js';\nexport const load = review;")).toEqual([]);
      const title = (lib.CHECKS as { id: string; title: string }[]).find((c) => c.id === 'loader-use')!.title;
      for (const words of ['import lazy = require', 'computed at run time', 'export const load = review']) expect(title, words).toContain(words);
      // Outside the engine nothing is read (a shell cannot reach lazy.ts: R13).
      expect(loaders('packages/cli/src/a.ts', "import { review } from '../../engine/src/lazy.js';")).toEqual([]);
    });

    it('flags the hooks and review adapters named as values outside their roots', () => {
      const use = "import { packageHookRunner, packageReviewer } from '@retake/engine';\nconst p = { hooks: packageHookRunner(), reviewer: packageReviewer() };";
      expect(ports('packages/cli/src/commands/a.ts', use)).toEqual([
        'loader-use packages/cli/src/commands/a.ts → packageHookRunner outside a root',
        'loader-use packages/cli/src/commands/a.ts → packageReviewer outside a root',
      ]);
      expect(ports('packages/engine/src/jobs/a.ts', "import * as p from '../hook-run/package-hooks.js';\nf(p.packageHookRunner);")).toEqual([
        'loader-use packages/engine/src/jobs/a.ts → packageHookRunner outside a root',
      ]);
      for (const root of lib.PORT_ROOTS.packageHookRunner) expect(ports(root, 'f(packageHookRunner());'), root).toEqual([]);
      for (const root of lib.PORT_ROOTS.packageReviewer) expect(ports(root, 'f(packageReviewer());'), root).toEqual([]);
      expect(ports('packages/engine/src/index.ts', "export { packageHookRunner } from './hook-run/package-hooks.js';\nexport { packageReviewer } from './review/review-package.js';")).toEqual([]);
      // The capture runner's adapter (L7.12): its file and the bag only; a CLI command names cliPorts.capture.
      expect(ports('packages/cli/src/interrupt.ts', "import { runnerWebCapture } from '@retake/engine';\nrunnerWebCapture().cleanupSync();")).toEqual([
        'loader-use packages/cli/src/interrupt.ts → runnerWebCapture outside a root',
      ]);
      expect(ports('packages/engine/src/jobs/worker.ts', "import { runnerWebCapture as c } from '../capture/runner-web-capture.js';\nconst x = c();")).toEqual([
        'loader-use packages/engine/src/jobs/worker.ts → runnerWebCapture outside a root',
      ]);
      expect(lib.PORT_ROOTS.runnerWebCapture).toEqual(['packages/engine/src/capture/runner-web-capture.ts', 'packages/engine/src/ports.ts']);
      for (const root of lib.PORT_ROOTS.runnerWebCapture) expect(ports(root, 'f(runnerWebCapture());'), root).toEqual([]);
    });

    it('flags a port file naming an adapter package, a type and typeof import() too, not a domain entry nor core', () => {
      const at = (fileImports: Record<string, readonly string[]>): string[] => lib.portTypeHits(fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
      const port = 'packages/engine/src/hook-run/runner.ts';
      expect(at({ [port]: ['@retake/core', '@retake/core/io', '@retake/hooks/describe', '@retake/review/checks', '../errors.js'] })).toEqual([]);
      expect(at({ [port]: ['@retake/hooks', '@retake/review/thumbs', '@retake/hooks'] })).toEqual([`port-types ${port} → @retake/hooks`, `port-types ${port} → @retake/review/thumbs`]);
      // Only the port files are read.
      expect(at({ 'packages/engine/src/hook-run/package-hooks.ts': ['@retake/hooks'] })).toEqual([]);
      // What the scan lists for a type import and a `typeof import()`: both are names of the package.
      const ts = lib.loadTs(ROOT) as typeof import('typescript');
      const specs = lib.specifiersOf(ts, port, "import type { HookResult } from '@retake/hooks';\nlet h: typeof import('@retake/review');") as string[];
      expect(at({ [port]: specs })).toEqual([`port-types ${port} → @retake/hooks`, `port-types ${port} → @retake/review`]);
      expect(lib.PORT_FILES).toContain('packages/engine/src/review/reviewer.ts');
      // The capture runner's port (L7.12): the runner's type-only entry is free, its root is not, types included.
      const capture = 'packages/engine/src/capture/runner.ts';
      expect(lib.PORT_FILES).toContain(capture);
      expect(at({ [capture]: ['@retake/core', '@retake/runner-web/types', '../hook-run/runner.js'] })).toEqual([]);
      expect(at({ [capture]: lib.specifiersOf(ts, capture, "import type { RunOptions } from '@retake/runner-web';") as string[] })).toEqual([`port-types ${capture} → @retake/runner-web`]);
      for (const f of lib.PORT_FILES as string[]) expect(statSync(join(ROOT, f)).isFile(), f).toBe(true);
    });

    it('the Sandboxes port (L7.25): its loader in sandboxes/ only, its adapter named at its roots only, its port file on the types entry of the sandbox package', () => {
      expect(lib.LOADER_HOMES.sandbox).toBe('packages/engine/src/sandboxes/');
      expect(loaders('packages/engine/src/sandboxes/package-sandboxes.ts', "import { sandbox } from '../lazy.js';\nawait sandbox();")).toEqual([]);
      expect(loaders('packages/engine/src/jobs/sandbox-job.ts', "import { sandbox } from '../lazy.js';\nawait sandbox();")).toEqual(['loader-use packages/engine/src/jobs/sandbox-job.ts → sandbox']);
      expect(loaders('packages/engine/src/execute-run.ts', "import { sandbox as sb } from './lazy.js';")).toEqual(['loader-use packages/engine/src/execute-run.ts → sandbox']);
      expect(loaders('packages/engine/src/sandboxes/x.ts', "export { sandbox } from '../lazy.js';")).toEqual(['loader-use packages/engine/src/sandboxes/x.ts → sandbox re-exported']);
      expect(lib.PORT_ROOTS.packageSandboxes).toEqual(['packages/engine/src/sandboxes/package-sandboxes.ts', 'packages/engine/src/ports.ts']);
      expect(lib.PORT_ROOT_RULE.packageSandboxes).toBe('loader-use');
      for (const root of lib.PORT_ROOTS.packageSandboxes) expect(ports(root, 'f(packageSandboxes());'), root).toEqual([]);
      expect(ports('packages/cli/src/commands/sandbox.ts', "import { packageSandboxes } from '@retake/engine';\nconst s = packageSandboxes();")).toEqual([
        'loader-use packages/cli/src/commands/sandbox.ts → packageSandboxes outside a root',
      ]);
      expect(ports('packages/engine/src/jobs/sandbox-job.ts', "import * as ps from '../sandboxes/package-sandboxes.js';\nf(ps.packageSandboxes);")).toEqual([
        'loader-use packages/engine/src/jobs/sandbox-job.ts → packageSandboxes outside a root',
      ]);
      const port = 'packages/engine/src/sandboxes/sandboxes.ts';
      expect(lib.PORT_FILES).toContain(port);
      const at = (fileImports: Record<string, readonly string[]>): string[] => lib.portTypeHits(fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
      expect(at({ [port]: ['@retake/core', '@retake/core/io', '@retake/sandbox/types'] })).toEqual([]);
      expect(at({ [port]: ['@retake/sandbox'] })).toEqual([`port-types ${port} → @retake/sandbox`]);
      // The engine names the sandbox package nowhere but in its loader and through the types entry (R11 holds no sandbox pair).
      const entries = lib.ratchetEntries(ROOT) as string[];
      expect(entries.filter((e) => e.startsWith('R11 ') && e.includes('@retake/sandbox'))).toEqual([]);
    });

    it("holds today: the new ports name no adapter, and the loaders left outside their homes are the review loader's, pinned", () => {
      const entries = lib.ratchetEntries(ROOT) as string[];
      expect(entries.filter((e) => e.startsWith('port-types ')).filter((e) => !e.startsWith('port-types packages/engine/src/render/renderer.ts '))).toEqual([]);
      expect(entries.filter((e) => e.startsWith('loader-use ') && e.endsWith('outside a root'))).toEqual([]);
      for (const e of entries.filter((x) => x.startsWith('loader-use '))) expect(e).toMatch(/ → review( re-exported)?$/);
    });
  });

  describe('browser-registry: one browser-discovery module (L7.25, finding X9)', () => {
    const at = (rel: string, text: string): string[] =>
      (lib.browserRegistryHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Array<{ file: string; count: number }>).map((h) => `${h.file} → ${h.count}`);

    it('counts the private modules of playwright-core named in packages/*/src outside core/io browsers.ts, in strings and templates, not in comments', () => {
      expect(lib.BROWSER_REGISTRY_HOME).toBe('packages/core/src/io/browsers.ts');
      const editor = 'packages/editor/src/render/browser.ts';
      expect(at(editor, "const { registry } = require('playwright-core/lib/server/registry/index');")).toEqual([`${editor} → 1`]);
      expect(at(editor, 'const m = `playwright-core/lib/server/${name}`;\nimport x from "playwright-core/lib/utils";')).toEqual([`${editor} → 2`]);
      // A comment, the public package, its home and anything outside packages/*/src are no use.
      expect(at(editor, "// playwright-core/lib/server/registry is read in core/io\nimport { chromium } from 'playwright-core';")).toEqual([]);
      expect(at('packages/core/src/io/browsers.ts', "export const M = 'playwright-core/lib/server/registry/index';")).toEqual([]);
      expect(at('packages/runner-web/test/a.test.ts', "require('playwright-core/lib/server/registry/index');")).toEqual([]);
      const title = (lib.CHECKS as { id: string; title: string }[]).find((c) => c.id === 'browser-registry')!.title;
      for (const words of ['put together from pieces', 'computed at run time']) expect(title, words).toContain(words);
    });

    it('holds today: the registry is named in its home only', () => {
      expect((lib.ratchetEntries(ROOT) as string[]).filter((e) => e.startsWith('browser-registry '))).toEqual([]);
      expect(readFileSync(join(ROOT, lib.BROWSER_REGISTRY_HOME), 'utf8')).toContain("'playwright-core/lib/server/registry/index'");
    });
  });

  describe("core-context and core-root: core's entries per context, and the packages on them (L7.35, finding D1)", () => {
    type Found = { rule: string; file: string; spec: string };
    const ctx = (rel: string, text: string): string[] => (lib.coreContextHits(ROOT, [{ rel, pkg: 'core', text, specs: [] }]) as Found[]).map((h) => `${h.file} → ${h.spec}`);
    const rootHits = (rel: string, text: string): string[] => (lib.coreRootHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Found[]).map((h) => `${h.file} → ${h.spec}`);
    const contexts = lib.CORE_CONTEXTS as Array<{ name: string; files: string[] }>;

    it('a file imports its own context and the ones before it; a later one is a hit, a type-only import of model is free', () => {
      const f = 'packages/core/src/hook-writes.ts';
      expect(lib.coreContextOf(f)).toBe('hooks');
      // Before it (base, model, environment, policy) and its own (destructive): free.
      expect(
        ctx(
          f,
          "import { formatPath } from './issues.js';\nimport { needFiles } from './file-facts.js';\nimport { hostMatches } from './hosts.js';\nimport { confinementWords } from './confinement.js';\nimport { destructiveReason } from './destructive.js';\n",
        ),
      ).toEqual([]);
      // After it: a value, a type, a re-export and an import() alike.
      expect(
        ctx(
          f,
          "import { parseScenario } from './scenario.js';\nimport type { RunRecord } from './run-record.js';\nexport { renderIdOf } from './render-record.js';\nconst t = await import('./template.js');\n",
        ),
      ).toEqual([`${f} → packages/core/src/scenario.ts`, `${f} → packages/core/src/run-record.ts`, `${f} → packages/core/src/render-record.ts`, `${f} → packages/core/src/template.ts`]);
      // base sits before model: a type of model is free there, a value is not.
      const b = 'packages/core/src/issues.ts';
      expect(ctx(b, "import type { ValidationIssue } from './types.js';\n")).toEqual([]);
      expect(ctx(b, "import { ACTION_NAMES } from './types.js';\n")).toEqual([`${b} → packages/core/src/types.ts`]);
      // Folders resolve: checks/ and schemas/ files are named by their path.
      expect(ctx('packages/core/src/checks/hooks.ts', "import { parseScenario } from '../scenario.js';\nimport { issue } from '../validation/located.js';\n")).toEqual([
        'packages/core/src/checks/hooks.ts → packages/core/src/scenario.ts',
      ]);
      // The io side, other packages and node modules are not this check's (R1 holds io).
      expect(ctx(f, "import { readFileSync } from 'node:fs';\nimport { x } from '@retake/core/io';\nimport { y } from './io/files.js';\n")).toEqual([]);
    });

    it('a file of no context, an entry outside its context, an entry or the root imported by a context file: each a hit', () => {
      expect(ctx('packages/core/src/new-thing.ts', 'export const A = 1;\n')).toEqual(['packages/core/src/new-thing.ts → unassigned']);
      expect(ctx('packages/core/src/entries/hooks.ts', "export * from '../destructive.js';\nexport * from '../scenario.js';\n")).toEqual([
        'packages/core/src/entries/hooks.ts → packages/core/src/scenario.ts (outside its context)',
      ]);
      expect(ctx('packages/core/src/entries/nope.ts', "export * from '../destructive.js';\n")).toEqual(['packages/core/src/entries/nope.ts → an entry of no context']);
      expect(ctx('packages/core/src/steps.ts', "import { x } from './entries/base.js';\nimport { y } from './index.js';\n")).toEqual([
        'packages/core/src/steps.ts → packages/core/src/entries/base.ts (an entry)',
        'packages/core/src/steps.ts → packages/core/src/index.ts (an entry)',
      ]);
      // Core's own package name is an entry too, the root or a sub-path, from a context file or an entry; io is R1's.
      expect(ctx('packages/core/src/steps.ts', "import { x } from '@retake/core';\nimport type { Step } from '@retake/core/model';\nimport { y } from '@retake/core/io';\n")).toEqual([
        'packages/core/src/steps.ts → @retake/core (an entry)',
        'packages/core/src/steps.ts → @retake/core/model (an entry)',
      ]);
      expect(ctx('packages/core/src/entries/hooks.ts', "export * from '@retake/core/base';\n")).toEqual(['packages/core/src/entries/hooks.ts → @retake/core/base (an entry)']);
      // The io side and the root itself are no context's.
      expect(ctx('packages/core/src/io/files.ts', "import { x } from '../scenario.js';\nimport { y } from '@retake/core';\n")).toEqual([]);
      expect(ctx('packages/core/src/index.ts', "export * from './entries/base.js';\n")).toEqual([]);
    });

    it('the contexts are the entries: one file each, every core file in one, every entry an export of the package, and the lists that name them agree', () => {
      const names = contexts.map((c) => c.name);
      expect(names).toEqual(['base', 'model', 'ids', 'language', 'environment', 'policy', 'hooks', 'project', 'sandbox', 'scenario', 'comments', 'run', 'render', 'theme', 'schema']);
      expect(lib.CORE_SHARED_CONTEXT).toBe('model');
      const listed = contexts.flatMap((c) => c.files);
      expect(new Set(listed).size).toBe(listed.length);
      const src = join(ROOT, 'packages', 'core', 'src');
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? (['io', 'entries'].includes(e.name) ? [] : walk(join(d, e.name))) : e.name.endsWith('.ts') ? [join(d, e.name).slice(src.length + 1, -3)] : [],
        );
      expect(
        walk(src)
          .filter((f) => f !== 'index')
          .sort(),
      ).toEqual([...listed].sort());
      const pj = JSON.parse(readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8')) as { exports: Record<string, { source?: string } | string> };
      expect(Object.keys(pj.exports)).toEqual(['.', ...names.map((n) => `./${n}`), './io', './schema/*.json']);
      for (const n of names) expect(pj.exports[`./${n}`], n).toEqual({ source: `./src/entries/${n}.ts`, types: `./dist/entries/${n}.d.ts`, default: `./dist/entries/${n}.js` });
      expect(readdirSync(join(src, 'entries')).sort()).toEqual(names.map((n) => `${n}.ts`).sort());
      // The root is every entry, in order, and nothing else.
      const index = readFileSync(join(src, 'index.ts'), 'utf8')
        .split('\n')
        .filter((l) => l && !/^\s*(\/\*\*|\*)/.test(l));
      expect(index).toEqual(names.map((n) => `export * from './entries/${n}.js';`));
      // vitest's aliases and the test type check's paths name each entry (test-typecheck compares the two).
      const vitest = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
      for (const n of names) expect(vitest, n).toContain(`'@retake/core/${n}': fileURLToPath(new URL('./packages/core/src/entries/${n}.ts', import.meta.url)),`);
    });

    it("core-root: the root, an `import('…')` type of it and an unknown sub-path are hits in a package's sources; an entry, core itself and a test are not", () => {
      const f = 'packages/engine/src/a.ts';
      expect(rootHits(f, "import { parseScenario } from '@retake/core';\n")).toEqual([`${f} → @retake/core`]);
      expect(rootHits(f, "export { parseScenario } from '@retake/core';\n")).toEqual([`${f} → @retake/core`]);
      expect(rootHits(f, "const c = await import('@retake/core');\n")).toEqual([`${f} → @retake/core`]);
      expect(rootHits(f, "let s: import('@retake/core').Step;\n")).toEqual([`${f} → @retake/core`]);
      expect(rootHits(f, "import { x } from '@retake/core/nope';\n")).toEqual([`${f} → @retake/core/nope (no entry)`]);
      expect(
        rootHits(
          f,
          "import { parseScenario } from '@retake/core/scenario';\nimport type { Step } from '@retake/core/model';\nimport { nodeFileFacts } from '@retake/core/io';\nimport s from '@retake/core/schema/scenario.schema.json';\nimport t from '@retake/core/schema/a/b.json';\n",
        ),
      ).toEqual([`${f} → @retake/core/schema/a/b.json (no entry)`]);
      expect(rootHits('packages/core/src/a.ts', "import { x } from '@retake/core';\n")).toEqual([]);
      const title = (lib.CHECKS as { id: string; title: string }[]).find((c) => c.id === 'core-root')!.title;
      expect(title).toContain('computed at run time');
    });

    it('holds today: two imports of a later context, none of the root', () => {
      const today = lib.ratchetEntries(ROOT) as string[];
      expect(today.filter((e) => e.startsWith('core-context '))).toEqual([
        'core-context packages/core/src/checks/scenario.ts → packages/core/src/template-defaults.ts',
        'core-context packages/core/src/script-draft.ts → packages/core/src/inspect.ts',
      ]);
      expect(today.filter((e) => e.startsWith('core-root '))).toEqual([]);
    });
  });

  describe('media-call: the media tools started in one module (L7.31, finding X3)', () => {
    const at = (rel: string, text: string): string[] =>
      (lib.mediaCallHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Array<{ file: string; count: number }>).map((h) => `${h.file} → ${h.count}`);
    const ed = 'packages/editor/src/render/a.ts';

    it('counts the process starts of node:child_process in a file that names ffmpeg or ffprobe, outside core/io media-run.ts', () => {
      expect(lib.MEDIA_RUN_HOME).toBe('packages/core/src/io/media-run.ts');
      expect(at(ed, "import { execFile, spawn } from 'node:child_process';\nexecFile(ffmpegBin(p), args, cb);\nspawn(bin, ['-i', x]);")).toEqual([`${ed} → 2`]);
      // An alias, the module imported whole (a namespace or a default import), a member read by name; a string or a
      // template naming the tool is enough.
      expect(at(ed, "import { spawnSync as run } from 'child_process';\nrun('ffprobe', ['-v', 'error']);")).toEqual([`${ed} → 1`]);
      expect(at(ed, "import * as cp from 'node:child_process';\nconst t = `${dir}/ffmpeg`;\ncp.execFileSync(t, []);\ncp['fork'](t);")).toEqual([`${ed} → 2`]);
      expect(at(ed, "import cp from 'node:child_process';\nconst ffprobe = which();\ncp.exec(ffprobe);")).toEqual([`${ed} → 1`]);
      // Not a media tool, a type import, a comment, the home and anything outside packages/*/src are no use.
      expect(at(ed, "import { execFile } from 'node:child_process';\nexecFile('ps', ['-o', 'pid=']);")).toEqual([]);
      expect(at(ed, "import type { ChildProcess } from 'node:child_process';\nconst bin = ffmpegBin(p);\nlet c: ChildProcess;")).toEqual([]);
      expect(at(ed, "import { spawn } from 'node:child_process';\n// ffmpeg is started in core/io\nspawn('sh', ['-c', cmd]);")).toEqual([]);
      expect(at('packages/core/src/io/media-run.ts', "import { spawn } from 'node:child_process';\nspawn('ffmpeg', []);")).toEqual([]);
      expect(at('packages/editor/test/a.test.ts', "import { spawn } from 'node:child_process';\nspawn('ffmpeg', []);")).toEqual([]);
      const title = (lib.CHECKS as { id: string; title: string }[]).find((c) => c.id === 'media-call')!.title;
      for (const words of ['under another name made in the file', 'await import()', 'names no media tool']) expect(title, words).toContain(words);
    });

    it('reads through parentheses, a comma, a cast or `!`, a template key, and counts .call / .apply / .bind of a starter', () => {
      // (A script's top-level `await (x)(…)` parses as a call of a function named await: the probes use `void`.)
      expect(
        at(ed, "import { spawn, execFile } from 'node:child_process';\nconst b = ffmpegBin(p);\nvoid (spawn)(b, []);\nvoid (0, execFile)(b, []);\nvoid (spawn as F)(b, []);\nvoid spawn!(b, []);"),
      ).toEqual([`${ed} → 4`]);
      expect(
        at(
          ed,
          "import { spawn } from 'node:child_process';\nimport * as cp from 'node:child_process';\nconst b = ffmpegBin(p);\nspawn.call(null, b, []);\nspawn.apply(null, [b, []]);\nconst s = spawn.bind(null, b);\nvoid (cp['execFile']).call(cp, b, []);\ncp[`fork`](b);\nvoid (0, spawn.call)(null, b, []);",
        ),
      ).toEqual([`${ed} → 6`]);
      // Not seen (the title says so): an import-equals alias, a template key with a substitution, a destructured member.
      expect(at(ed, "import cp = require('node:child_process');\nconst b = ffmpegBin(p);\ncp.spawn(b, []);")).toEqual([]);
      expect(at(ed, "import * as cp from 'node:child_process';\nconst b = ffmpegBin(p);\ncp[`exec${'File'}`](b, []);")).toEqual([]);
      expect(at(ed, "import * as cp from 'node:child_process';\nconst { spawn } = cp;\nspawn(ffmpegBin(p), []);")).toEqual([]);
      const title = (lib.CHECKS as { id: string; title: string }[]).find((c) => c.id === 'media-call')!.title;
      for (const words of ['import-equals alias', 'template key with a substitution', 'a destructured member', '`.call` / `.apply` / `.bind`']) expect(title, words).toContain(words);
    });

    it("holds today: one exception, the doctor's exec probe; the wrapper starts them", () => {
      expect((lib.ratchetEntries(ROOT) as string[]).filter((e) => e.startsWith('media-call '))).toEqual(['media-call packages/cli/src/commands/doctor.ts → 2 media tool starts']);
      const home = readFileSync(join(ROOT, lib.MEDIA_RUN_HOME), 'utf8');
      for (const f of ['export function runMediaTool(', 'export function runMediaToolSync(', 'export function startMediaTool(', 'export class MediaToolError ']) expect(home, f).toContain(f);
    });
  });

  describe('shell-op: operations defined in the engine, counted where a shell still defines one (L7.13)', () => {
    const at = (rel: string, text: string): string[] =>
      (lib.shellOpHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Array<{ file: string; count: number }>).map((h) => `${h.file} → ${h.count}`);
    const mcp = 'packages/mcp/src/tools/a.ts';
    const ui = 'packages/ui/src/server/b.ts';

    it('counts each call of a definer in a shell: by its name, an import alias, a namespace member, nested calls too', () => {
      expect(at(mcp, "import { defineTool } from './define.js';\nexport const a = defineTool({ name: 'x' });\nexport const b = defineTool({ name: 'y' });")).toEqual([`${mcp} → 2`]);
      expect(at(ui, "import { defineOperation } from '@retake/engine/contract';\nfunction ops() { return [defineOperation({ name: 'x' })]; }")).toEqual([`${ui} → 1`]);
      expect(at(ui, "import { defineTool as op } from '@retake/engine/contract';\nconst a = op({});\nconst b = op({});\nconst c = op({});")).toEqual([`${ui} → 3`]);
      expect(at(mcp, "import * as c from '@retake/engine/contract';\nconst a = c.defineTool({});\nconst b = c['defineOperation']({});")).toEqual([`${mcp} → 2`]);
      expect(at('packages/ui/src/app/x.ts', 'const a = defineTool({});')).toEqual(['packages/ui/src/app/x.ts → 1']);
    });

    it('a mention is no call: a string, a comment, a type, an import or a re-export; a file outside the shells is not read', () => {
      expect(at(mcp, "import { defineTool } from './define.js';\nexport { defineTool };\n// defineTool({})\nconst s = 'defineTool({})';\ntype T = ReturnType<typeof defineTool>;")).toEqual([]);
      expect(at(ui, "import * as c from 'x';\nconst a = c.defineToolish({});\nconst b = other.defineTool({});")).toEqual([]);
      expect(at('packages/engine/src/operations/project.ts', 'export const a = defineOperation({});')).toEqual([]);
      expect(at('packages/cli/src/commands/a.ts', 'export const a = defineTool({});')).toEqual([]);
    });

    it("flags a definer re-exported under another name outside its homes (the engine's operations, MCP's define.ts), not under its own", () => {
      const spec = (rel: string, text: string): string[] =>
        (lib.shellOpHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Array<{ file: string; spec?: string }>).filter((h) => h.spec).map((h) => `${h.file} → ${h.spec}`);
      expect(spec(mcp, "export { defineTool as tool } from '@retake/engine/contract';")).toEqual([`${mcp} → defineTool re-exported as tool`]);
      expect(spec('packages/engine/src/contract.ts', "import { defineOperation } from './x.js';\nexport { defineOperation as op };")).toEqual([
        'packages/engine/src/contract.ts → defineOperation re-exported as op',
      ]);
      expect(spec(ui, "export { defineTool } from '@retake/engine/contract';\nexport type { defineTool as T } from 'x';")).toEqual([]);
      expect(spec('packages/mcp/src/tools/define.ts', "export { defineTool as tool } from '@retake/engine/contract';")).toEqual([]);
      expect(spec('packages/engine/src/operations/x.ts', "export { defineOperation as op } from './define.js';")).toEqual([]);
    });

    it('holds today: the operations each shell still defines, none in the engine (the counts move as families move)', () => {
      const entries = (lib.ratchetEntries(ROOT) as string[]).filter((e) => e.startsWith('shell-op '));
      const total = (prefix: string) => entries.filter((e) => e.startsWith(`shell-op ${prefix}`)).reduce((n, e) => n + Number(/→ (\d+) operations? defined$/.exec(e)![1]), 0);
      // L7.13: 34 / 65 (the eleven both serve moved); L7.14: 30 / 55 (MCP's four read-only queries — scenario_get,
      // plan_preview, render_status, review_get — and the Studio's ten screen reads); L7.17: 21 / 44 (the theme,
      // component and library family: MCP's nine, the Studio's eleven); L7.15: −7 / −6 (the submits and job controls:
      // MCP's run_dry, run_capture, render, review, export, page_inspect, job_cancel; the Studio's scenario_run,
      // run_pause, sign_in_cancel, scenario_render, render_cancel, review_export); L7.19: MCP −5 (hooks_run, env_reset,
      // sandbox_status, sandbox_up, sandbox_reset).
      // L7.16: MCP −3 (comments_list, comment_reply, comment_resolve), Studio −12 (comment-ops.ts: the twelve).
      // L7.18: −6 / −8 (MCP's scenario_save, scenario_from_script, scenario_record, project_create, project_prune,
      // job_status; the Studio's scenario_edit and its seven record_* ops).
      expect(total('packages/mcp/src/')).toBe(9 - 3 - 6);
      expect(total('packages/ui/src/')).toBe(38 - 12 - 8);
      expect(entries.some((e) => e.includes('packages/engine/'))).toBe(false);
    });
  });

  describe('hook-call: the hooks use cases orchestrated in the engine only (L7.23, U8b)', () => {
    const at = (rel: string, text: string): string[] =>
      (lib.hookCallHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]) as Array<{ file: string; count: number }>).map((h) => `${h.file} → ${h.count}`);
    const cli = 'packages/cli/src/commands/a.ts';

    it('counts createHookContext (its name, an import alias, a namespace member), hooks.run and the replays of the journals, outside the engine', () => {
      expect(at(cli, "import { createHookContext } from '@retake/engine';\nconst m = await createHookContext(project, o);")).toEqual([`${cli} → 1`]);
      expect(at(cli, "import { createHookContext as hc } from '@retake/engine';\nawait hc(p, o);\nawait hc(p, o);")).toEqual([`${cli} → 2`]);
      expect(at(cli, "import * as e from '@retake/engine';\nawait e.createHookContext(p, o);\nawait e['createHookContext'](p, o);")).toEqual([`${cli} → 2`]);
      expect(at(cli, "await cliPorts.hooks.run(list, ctx, o);\nawait hooks.run(list, ctx, o);\nawait ports.hooks['run'](list, ctx, o);")).toEqual([`${cli} → 3`]);
      expect(at(cli, 'await hooks.journals.openPending(dir);\nawait hooks.journals.rollback(list, ctx);\nawait journals.rollbackPending(dir, ctx);')).toEqual([`${cli} → 3`]);
      // A shell replays no journal itself; an adapter does (runner-web's capture, the hooks package).
      expect(at('packages/mcp/src/tools/b.ts', 'await journal.rollbackAll(ctx);')).toEqual(['packages/mcp/src/tools/b.ts → 1']);
      expect(at('packages/runner-web/src/run.ts', 'await h.journal.rollbackAll(h.ctx);')).toEqual([]);
      expect(at('packages/hooks/src/journal.ts', 'await p.journal.rollbackAll(ctx);')).toEqual([]);
    });

    it('reads the callee through parentheses, a comma, a cast or `!`, and counts .call / .apply / .bind of a counted function', () => {
      // (A script's top-level `await (x)(…)` parses as a call of a function named await: the probes use `void`.)
      expect(at(cli, 'void (hooks.run)(l, c, o);\nvoid (0, cliPorts.hooks.run)(l, c, o);\nvoid (hooks.journals as J).rollback(l, c);\nawait hooks!.run(l, c, o);')).toEqual([`${cli} → 4`]);
      expect(at(cli, "import { createHookContext } from '@retake/engine';\nvoid (0, createHookContext)(p, o);\nvoid (createHookContext as F)(p, o);")).toEqual([`${cli} → 2`]);
      expect(
        at(
          cli,
          "import { createHookContext as hc } from '@retake/engine';\nawait hc.call(null, p, o);\nawait hooks.run.apply(h, [l, c, o]);\nconst r = cliPorts.hooks.journals.openPending.bind(j);\nvoid (hooks.journals['rollbackPending']).call(j, d, c);",
        ),
      ).toEqual([`${cli} → 4`]);
      expect(at('packages/ui/src/server/c.ts', 'void (0, journal.rollbackAll)(ctx);\nawait journal.rollbackAll.call(journal, ctx);')).toEqual(['packages/ui/src/server/c.ts → 2']);
      // .call of something not counted, and a counted function's other members, are no hit.
      expect(at(cli, 'await other.run.call(x);\nhooks.run.length;\nconst n = hooks.run.name;')).toEqual([]);
    });

    it("does not see (listed in the check's title): a destructured member, a member held in a variable, a dynamic import's destructuring, an import-equals alias, a computed key", () => {
      expect(at(cli, 'const { run } = cliPorts.hooks;\nawait run(l, c, o);')).toEqual([]);
      expect(at(cli, 'const r = hooks.run;\nawait r(l, c, o);\nconst h = ports.hooks;\nawait h.run(l, c, o);')).toEqual([]);
      expect(at(cli, "const { createHookContext: hc } = await import('@retake/engine');\nawait hc(p, o);")).toEqual([]);
      expect(at(cli, "import * as e from '@retake/engine';\nimport hc = e.createHookContext;\nawait hc(p, o);")).toEqual([]);
      expect(at(cli, "const k = 'run';\nawait hooks[k](l, c, o);")).toEqual([]);
    });

    it('a read, a mention, another member or the engine itself is no hit', () => {
      expect(at(cli, "import type { createHookContext } from '@retake/engine';\n// createHookContext(p, o)\nconst s = 'hooks.run(x)';\ntype T = typeof createHookContext;")).toEqual([]);
      expect(
        at(cli, 'await hooks.journals.find(dir, id);\nawait hooks.journals.standaloneFile(dir, id);\nawait hooks.journals.open(f);\njournal.pending();\nawait other.run(x);\nawait hooks.load();'),
      ).toEqual([]);
      expect(at(cli, 'await hooksRunWork(project, spec, o);\nawait rollbackWork(project, o);\nawait envResetWork(project, o);')).toEqual([]);
      expect(at('packages/engine/src/hooks-work.ts', 'await createHookContext(p, o);\nawait o.hooks.run(l, c, x);\nawait o.hooks.journals.rollback(l, c);\nawait journal.rollbackAll(c);')).toEqual([]);
      expect(at('packages/cli/test/a.test.ts', 'await createHookContext(p, o);')).toEqual([]);
    });

    it("holds today: no file outside the engine orchestrates hooks (L7.23: the CLI's hooks.ts had 6 — 5 of the plan's list and one rollbackAll)", () => {
      expect((lib.ratchetEntries(ROOT) as string[]).filter((e) => e.startsWith('hook-call '))).toEqual([]);
      expect(at('packages/cli/src/commands/hooks.ts', readFileSync(join(ROOT, 'packages/cli/src/commands/hooks.ts'), 'utf8'))).toEqual([]);
    });
  });

  it("flags a submit or a worker's write on the job queue outside packages/engine/src, not a read nor a client's request", () => {
    const at = (rel: string, text: string) => wiring(rel, text);
    expect(at('packages/ui/src/server/a.ts', 'await engine.queue.enqueue(input);')).toEqual(['queue-call packages/ui/src/server/a.ts → queue.enqueue']);
    expect(at('packages/mcp/src/tools/a.ts', "await queue.claim(id, me);\nawait queue.unclaim(id);\nawait this.queue['write'](rec);")).toEqual([
      'queue-call packages/mcp/src/tools/a.ts → queue.claim',
      'queue-call packages/mcp/src/tools/a.ts → queue.unclaim',
      'queue-call packages/mcp/src/tools/a.ts → queue.write',
    ]);
    expect(at('packages/cli/src/commands/a.ts', 'await o.queue.setYield(id, null);\nawait queue.append(id, 0, []);')).toEqual([
      'queue-call packages/cli/src/commands/a.ts → queue.setYield',
      'queue-call packages/cli/src/commands/a.ts → queue.append',
    ]);
    // L7.26: the queue's lock is the engine's admission's, never a shell's.
    expect(at('packages/ui/src/server/a.ts', 'await engine.queue.exclusive(key, fn);')).toEqual(['queue-call packages/ui/src/server/a.ts → queue.exclusive']);
    // Reads and a client's requests are the view's: fine anywhere; the engine's own modules submit and write.
    expect(at('packages/ui/src/server/a.ts', 'await engine.queue.list({});\nawait queue.cancel(id, by);\nawait queue.withOwnMemory().takeHold();\nawait other.write(x);')).toEqual([]);
    expect(at('packages/engine/src/jobs/a.ts', 'await ctx.queue.enqueue(input);\nawait w.queue.write(rec);')).toEqual([]);
  });

  it("flags the editor's render functions named in the engine outside its render folder or in a shell, whatever the syntax, not a type, a comment or a string", () => {
    const at = (rel: string, text: string) => wiring(rel, text);
    const engine = 'packages/engine/src/jobs/a.ts';
    const hit = (name: string, rel = engine) => [`render-call ${rel} → ${name}`];
    // Called, aliased, indexed, destructured (renamed or not, from an awaited loader too), handed on in an object.
    expect(at(engine, 'const r = await (await editor()).renderVideo(o);')).toEqual(hit('renderVideo'));
    expect(at(engine, 'const f = ed.renderStill;\nawait f(o);')).toEqual(hit('renderStill'));
    expect(at(engine, "await ed['exportRender'](o);")).toEqual(hit('exportRender'));
    expect(at(engine, 'await ed[`renderPlan`](o);')).toEqual(hit('renderPlan'));
    expect(at(engine, 'const { renderComponentPreviews } = await editor();')).toEqual(hit('renderComponentPreviews'));
    expect(at(engine, 'const { renderComponentLoops: loops } = await editor();')).toEqual(hit('renderComponentLoops'));
    expect(at(engine, "const { 'renderStills': stills } = ed;")).toEqual(hit('renderStills'));
    expect(at(engine, 'function work({ createRenderer }: Ed) { return createRenderer(); }')).toEqual(hit('createRenderer'));
    expect(at(engine, 'const createRenderer = make;\nconst seams = { createRenderer };')).toEqual(hit('createRenderer'));
    expect(at(engine, 'await a.renderVideo(o);\nawait b.renderVideo(o);\nawait c.renderStill(o);')).toEqual([...hit('renderVideo'), ...hit('renderStill')]);
    // A shell: the same, and the function imported from the editor as a value, under any name.
    const shell = 'packages/cli/src/commands/a.ts';
    expect(at(shell, "import { loadPreviewTheme, renderComponentPreviews } from '@retake/editor';\nawait renderComponentPreviews(o);")).toEqual(hit('renderComponentPreviews', shell));
    expect(at(shell, "import { renderVideo as draw } from '@retake/editor';\nawait draw(o);")).toEqual(hit('renderVideo', shell));
    expect(at('packages/ui/src/server/a.ts', 'await ed.renderStill(o);')).toEqual(hit('renderStill', 'packages/ui/src/server/a.ts'));
    expect(at('packages/mcp/src/tools/a.ts', "import * as ed from '@retake/editor';\nawait ed.exportRender(o);")).toEqual(hit('exportRender', 'packages/mcp/src/tools/a.ts'));
    // Not uses: the render folder itself, an adapter, a type, a comment, a string, a key being defined, the engine's own work.
    expect(at('packages/engine/src/render/work.ts', 'return (await editor()).renderVideo({ ...o, renderer });')).toEqual([]);
    expect(at('packages/editor/src/render/a.ts', 'await renderVideo(o);\nconst { renderStill } = api;')).toEqual([]);
    expect(
      at(
        engine,
        "import type { renderVideo } from '@retake/editor';\nimport { type renderStill, planRun } from '@retake/editor';\ntype F = typeof import('@retake/editor')['renderVideo'];\ninterface Ed { renderVideo(o: O): Promise<R> }",
      ),
    ).toEqual([]);
    expect(
      at(engine, "// the editor's renderVideo\nconst s = 'ed.renderVideo(o)';\nconst seams = { renderVideo: fake };\nawait renderWork(o);\nawait ed.planRun(o);\nawait ed.buildComponentPreview(o);"),
    ).toEqual([]);
    expect(at(shell, "import { renderVideo } from './local.js';\nawait engine.renders.submit(o);")).toEqual([]);
  });

  it("flags the render entries however they are reached: the driver's parts, a key spelt in pieces, an assignment's pattern, an alias, a re-export", () => {
    const at = (rel: string, text: string) => wiring(rel, text);
    const engine = 'packages/engine/src/jobs/a.ts';
    const shell = 'packages/cli/src/commands/a.ts';
    const hit = (name: string, rel = engine) => [`render-call ${rel} → ${name}`];
    // What makes the editor's renderer, or a part of one.
    expect(at(engine, 'const previews = (await editor()).previewDriver(backend);')).toEqual(hit('previewDriver'));
    expect(at(engine, 'const { REMOTION_PREVIEW_BACKEND } = await editor();')).toEqual(hit('REMOTION_PREVIEW_BACKEND'));
    expect(at(shell, 'const d = ed.planDriver();')).toEqual(hit('planDriver', shell));
    // A key spelt in pieces is read like the key it spells.
    expect(at(engine, "await ed['render' + 'Video'](o);")).toEqual(hit('renderVideo'));
    expect(at(engine, "await ed[`render${'Still'}`](o);")).toEqual(hit('renderStill'));
    expect(at(engine, "await ed[('export' + 'Render') as 'exportRender'](o);")).toEqual(hit('exportRender'));
    expect(at(engine, "const { ['renderStills']: stills } = ed;")).toEqual(hit('renderStills'));
    expect(at(engine, "const { ['render' + 'Plan']: plan } = ed;")).toEqual(hit('renderPlan'));
    // An assignment's pattern, nested or in a loop's head.
    expect(at(engine, 'let f;\n({ renderVideo: f } = ed);')).toEqual(hit('renderVideo'));
    expect(at(engine, "let f;\n({ 'createRenderer': f } = ed);")).toEqual(hit('createRenderer'));
    expect(at(engine, 'let g;\n({ ed: { renderComponentLoops: g } } = mods);')).toEqual(hit('renderComponentLoops'));
    expect(at(engine, 'let g;\n[{ renderComponentPreviews: g }] = mods;')).toEqual(hit('renderComponentPreviews'));
    expect(at(engine, 'let f;\nfor ({ renderStill: f } of mods) await f(o);')).toEqual(hit('renderStill'));
    // An alias of a namespace's member.
    expect(at(shell, "import * as ed from '@retake/editor';\nimport draw = ed.renderVideo;")).toEqual(hit('renderVideo', shell));
    // A re-export from the editor: by name (renamed or not), or all of it.
    expect(at(shell, "export { renderVideo } from '@retake/editor';")).toEqual(hit('renderVideo', shell));
    expect(at(shell, "export { exportRender as deliver, planRun } from '@retake/editor';")).toEqual(hit('exportRender', shell));
    expect(at(shell, "export * from '@retake/editor';")).toEqual(hit('export * from @retake/editor', shell));
    expect(at(shell, "export * as ed from '@retake/editor';")).toEqual(hit('export * from @retake/editor', shell));
    // Not uses: a type re-exported, another function re-exported, a re-export of another module, a key defined in an
    // object that is read (spelt in pieces too), an object on the right of an assignment.
    expect(
      at(
        shell,
        "export type { RenderRecord } from '@retake/editor';\nexport { type RenderVideoOptions, planRun } from '@retake/editor';\nexport * from './local.js';\nexport { renderVideo } from './local.js';",
      ),
    ).toEqual([]);
    expect(at(engine, "const a = { ['render' + 'Video']: fake };\nlet b;\nb = { renderStill: fake };\nconst c = [{ exportRender: fake }];")).toEqual([]);
    // The check's limit, on purpose in this test: a key known only at run time names nothing in the text.
    expect(at(engine, 'const f = ed[name];\nconst g = ed[`render${kind}`];')).toEqual([]);
  });

  it('lists every render entry the editor exports: a value whose name says it renders, or makes a renderer, is checked or named here as not one', () => {
    const ts = lib.loadTs(ROOT);
    const index = join(ROOT, 'packages/editor/src/index.ts');
    const sf = ts.createSourceFile(index, readFileSync(index, 'utf8'), ts.ScriptTarget.Latest, true);
    const values: string[] = [];
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const e of st.exportClause.elements) if (!e.isTypeOnly) values.push(e.name.text);
    }
    expect(values).toContain('renderVideo');
    // Names that say "this renders" or "this is (a part of) a renderer".
    const entryLike = values.filter((n) => /^render[A-Z]|^exportRender$|Renderer$|Driver$|_BACKEND$/.test(n)).sort();
    // The editor's values with such a name that draw nothing: the policy and its words, the render browser's identity
    // (doctor, the Studio's settings), a restriction's text.
    const NOT_ENTRIES = ['renderBrowser', 'renderBrowserIdentity', 'renderBundleRestriction', 'renderGpuInfo', 'renderPolicy', 'renderSandboxOff', 'renderSandboxRefusal'];
    expect(entryLike.filter((n) => !lib.RENDER_CALLS.includes(n))).toEqual(NOT_ENTRIES);
    // Every listed entry the index exports is exported as a value (planDriver is the driver's part, not exported).
    expect(lib.RENDER_CALLS.filter((n: string) => !values.includes(n))).toEqual(['planDriver']);
  });

  it('flags a loader that could load the editor unseen in the engine outside its loader: import() of a computed name, a require made with createRequire and called', () => {
    const eng = (name: string, text: string) => [`packages/engine/src/${name}.ts`, { text, specs: [] as string[] }] as const;
    const files = Object.fromEntries([
      eng('lazy', "const name = '@retake/' + 'editor';\nexport const editor = () => import(name);\n"),
      eng('computed', "const name = '@retake/' + 'editor';\nconst ed = await import(name);\n"),
      eng('made-require', "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst ed = load('@retake/editor');\n"),
      eng('made-require-inline', "import { createRequire } from 'node:module';\nconst ed = createRequire(import.meta.url)(name);\n"),
      eng('made-require-later', "import * as m from 'node:module';\nlet load;\nload = m.createRequire(import.meta.url);\nconst ed = (load as NodeRequire)('@retake/editor');\n"),
      eng('builtin', "const m = process.getBuiltinModule('node:module');\n"),
      // Loads nothing: where a module is, asked of a require that is never called.
      eng('resolve-only', "import { createRequire } from 'node:module';\nconst at = createRequire(from).resolve(name);\nconst req = createRequire(from);\nconst other = req.resolve('x');\n"),
      eng('literal', "const core = await import('@retake/core');\n"),
    ]);
    const flagged = hitsOf(files)
      .filter((h) => h.startsWith('R9 '))
      .map((h) => h.replace(/^R9 packages\/engine\/src\/(.+)\.ts → /, '$1: '));
    expect(flagged.sort()).toEqual([
      'builtin: getBuiltinModule()',
      'computed: import()',
      'made-require-inline: createRequire()()',
      'made-require-later: createRequire()()',
      'made-require: createRequire()()',
    ]);
  });

  it('flags a value import of the editor in the engine outside its loader: static, re-export, import(); its types are free', () => {
    const eng = (name: string, text: string, spec = '@retake/editor') => [`packages/engine/src/${name}.ts`, { text, specs: [spec] }] as const;
    const files = Object.fromEntries([
      eng('lazy', "export const editor = () => import('@retake/editor');\n"),
      eng('types', "import type { RenderRecord } from '@retake/editor';\n"),
      eng('named-types', "import { type RenderRecord } from '@retake/editor';\n"),
      eng('plan-types', "import type { EditPlan } from '@retake/editor/plan';\n", '@retake/editor/plan'),
      eng('type-position', "let ed: typeof import('@retake/editor');\n"),
      eng('value', "import { renderVideo } from '@retake/editor';\n"),
      eng('plan-value', "import { planEdit } from '@retake/editor/plan';\n", '@retake/editor/plan'),
      eng('reexport', "export { planRun } from '@retake/editor';\n"),
      eng('dynamic', "const ed = await import('@retake/editor');\n"),
      eng('render/editor-renderer', "import { createRenderer } from '@retake/editor';\n"),
      ['packages/engine/src/review.ts', { text: "import { reviewRender } from '@retake/review';\n", specs: ['@retake/review'] }] as const,
    ]);
    const flagged = hitsOf(files)
      .filter((h) => h.startsWith('R9 '))
      .map((h) => h.replace(/^R9 packages\/engine\/src\/(.+)\.ts → @retake\/editor.*$/, '$1'));
    expect(flagged.sort()).toEqual(['dynamic', 'plan-value', 'reexport', 'render/editor-renderer', 'value']);
  });

  it('flags a value import of an adapter in the engine outside its loader: static, re-export, import(); its types and the domain entries are free', () => {
    const eng = (name: string, text: string, spec: string) => [`packages/engine/src/${name}.ts`, { text, specs: [spec] }] as const;
    const files = Object.fromEntries([
      eng('lazy', "export const sandbox = () => import('@retake/sandbox');\n", '@retake/sandbox'),
      eng('types', "import type { SandboxState } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('named-types', "import { type SandboxState } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('type-position', "let sb: typeof import('@retake/sandbox');\n", '@retake/sandbox'),
      eng('value', "import { pidAlive } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('mixed', "import { type SandboxState, pidAlive } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('reexport', "export { pidAlive } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('reexport-all', "export * from '@retake/hooks';\n", '@retake/hooks'),
      eng('dynamic', "const rw = await import('@retake/runner-web');\n", '@retake/runner-web'),
      eng('reexport-namespace', "export * as hooks from '@retake/hooks';\n", '@retake/hooks'),
      eng('side-effect', "import '@retake/sandbox';\n", '@retake/sandbox'),
      eng('require', "const sb = require('@retake/sandbox');\n", '@retake/sandbox'),
      eng('import-equals', "import sb = require('@retake/sandbox');\n", '@retake/sandbox'),
      eng('dynamic-template', 'const rw = await import(`@retake/runner-web`);\n', '@retake/runner-web'),
      eng('reexport-types', "export type { SandboxState } from '@retake/sandbox';\n", '@retake/sandbox'),
      eng('jobs/thumbs', "import { extractFrames } from '@retake/review/thumbs';\n", '@retake/review/thumbs'),
      eng('root-of-a-domain-entry', "import { loadRegistry } from '@retake/components';\n", '@retake/components'),
      // The domain entries are pure: a value of them loads no adapter code.
      eng('geometry-value', "import { autoFit } from '@retake/components/geometry';\n", '@retake/components/geometry'),
      eng('checks-value', "import { runChecks } from '@retake/review/checks';\n", '@retake/review/checks'),
      // The editor is R9's (its planner entry included), core is no adapter, and another package's file is not the engine's.
      eng('editor-value', "import { renderVideo } from '@retake/editor';\n", '@retake/editor'),
      eng('plan-value', "import { planEdit } from '@retake/editor/plan';\n", '@retake/editor/plan'),
      eng('core-value', "import { parseScenario } from '@retake/core';\n", '@retake/core'),
      ['packages/mcp/src/a.ts', { text: "import { pidAlive } from '@retake/sandbox';\n", specs: ['@retake/sandbox'] }] as const,
    ]);
    const all = hitsOf(files);
    const flagged = all.filter((h) => h.startsWith('R11 ')).map((h) => h.replace(/^R11 packages\/engine\/src\/(.+)\.ts → /, '$1: '));
    expect(flagged.sort()).toEqual([
      'dynamic-template: @retake/runner-web',
      'dynamic: @retake/runner-web',
      'import-equals: @retake/sandbox',
      'jobs/thumbs: @retake/review/thumbs',
      'mixed: @retake/sandbox',
      'reexport-all: @retake/hooks',
      'reexport-namespace: @retake/hooks',
      'reexport: @retake/sandbox',
      'require: @retake/sandbox',
      'root-of-a-domain-entry: @retake/components',
      'side-effect: @retake/sandbox',
      'value: @retake/sandbox',
    ]);
    // The editor's values stay R9's hits, under R9's name only.
    expect(
      all
        .filter((h) => h.includes('editor-value') || h.includes('plan-value'))
        .map((h) => h.split(' ')[0])
        .sort(),
    ).toEqual(['R9', 'R9']);
    // R11 is a rule of the list, with no loader check of its own (R9 owns the loaders of these files).
    const r11 = (lib.RULES as { id: string; typeOnlyCheck?: boolean; loaders?: boolean }[]).find((r) => r.id === 'R11')!;
    expect(r11.typeOnlyCheck).toBe(true);
    expect(r11.loaders).toBeUndefined();
    // So R11's cover of a loader that names nothing rests on R9: it checks loaders, on the very files R11 reads.
    const r9 = (lib.RULES as { id: string; loaders?: boolean; files: (f: string) => boolean }[]).find((r) => r.id === 'R9')!;
    expect(r9.loaders).toBe(true);
    for (const file of ['packages/engine/src/a.ts', 'packages/engine/src/jobs/b.ts', 'packages/engine/src/render/c.ts', lib.ENGINE_LOADER as string, 'packages/mcp/src/a.ts']) {
      expect(r9.files(file), file).toBe((r11 as unknown as { files: (f: string) => boolean }).files(file));
    }
    expect(hitsOf({ 'packages/engine/src/computed.ts': { text: "const name = '@retake/' + 'sandbox';\nconst sb = await import(name);\n", specs: [] } })).toEqual([
      'R9 packages/engine/src/computed.ts → import()',
    ]);
    // A file that cannot be read counts as a value import (the check fails closed).
    expect(hits({ 'packages/engine/src/gone.ts': ['@retake/hooks'] }, join(tmpdir(), 'retake-import-rules-none')).filter((h) => h.startsWith('R11 '))).toEqual([
      'R11 packages/engine/src/gone.ts → @retake/hooks',
    ]);
  });

  it('a shell may import a domain entry, not the package behind it', () => {
    expect(lib.DOMAIN_ENTRIES).toEqual(['@retake/components/geometry', '@retake/editor/plan', '@retake/review/checks', '@retake/hooks/describe', '@retake/runner-web/types', '@retake/sandbox/types']);
    const entries = lib.DOMAIN_ENTRIES as string[];
    for (const shell of ['packages/ui/src/server/a.ts', 'packages/mcp/src/tools/a.ts', 'packages/cli/src/commands/a.ts']) {
      const r4 = (text: string, specs: readonly string[]) =>
        hitsOf({ [shell]: { text, specs } })
          .filter((h) => h.startsWith('R4 '))
          .map((h) => h.replace(`R4 ${shell} → `, ''));
      // The allowance is for types: a shell may be typed against a domain entry, in every type-only form.
      const typed = [
        ...entries.map((e, i) => `import type { T${i} } from '${e}';`),
        "import { type A, type B } from '@retake/components/geometry';",
        "export type { C } from '@retake/review/checks';",
        "export { type D } from '@retake/editor/plan';",
        "let p: typeof import('@retake/editor/plan');",
        "import { parseScenario } from '@retake/core';",
        "import { createEngine } from '@retake/engine';",
      ].join('\n');
      expect(r4(typed, [...entries, '@retake/core', '@retake/engine']), shell).toEqual([]);
      // A value of a domain entry is the shell doing the application's work by itself: a hit, whatever the form.
      const values: Record<string, string> = {
        named: "import { planEdit } from '@retake/editor/plan';",
        mixed: "import { type EditPlan, planEdit } from '@retake/editor/plan';",
        default: "import plan from '@retake/editor/plan';",
        namespace: "import * as plan from '@retake/editor/plan';",
        'side-effect': "import '@retake/editor/plan';",
        reexport: "export { planEdit } from '@retake/editor/plan';",
        'reexport-all': "export * from '@retake/editor/plan';",
        'reexport-namespace': "export * as plan from '@retake/editor/plan';",
        dynamic: "const plan = await import('@retake/editor/plan');",
        require: "const plan = require('@retake/editor/plan');",
        'import-equals': "import plan = require('@retake/editor/plan');",
      };
      for (const [form, text] of Object.entries(values)) expect(r4(`${text}\n`, ['@retake/editor/plan']), `${shell} ${form}`).toEqual(['@retake/editor/plan']);
      expect(
        r4("import { autoFit } from '@retake/components/geometry';\nimport { runChecks } from '@retake/review/checks';\n", ['@retake/components/geometry', '@retake/review/checks']),
        shell,
      ).toEqual(['@retake/components/geometry', '@retake/review/checks']);
      // The package behind an entry stays an adapter import, its types too; a path below an entry is no entry.
      const behind = [
        '@retake/components',
        '@retake/review/thumbs',
        '@retake/components/kit',
        '@retake/editor',
        '@retake/review',
        '@retake/components/geometry/x',
        '@retake/runner-web',
        '@retake/runner-web/types/x',
        '@retake/sandbox',
        '@retake/sandbox/types/x',
      ];
      expect(r4(behind.map((s, i) => `import type { T${i} } from '${s}';`).join('\n'), behind), shell).toEqual(behind);
      // A file that cannot be read counts as a value import (the check fails closed).
      expect(hits({ [shell]: [...entries] }, join(tmpdir(), 'retake-import-rules-none')).filter((h) => h.startsWith('R4 '))).toEqual(entries.map((s) => `R4 ${shell} → ${s}`));
    }
    // The rule says for which specifiers types are free: the domain entries, nothing else.
    const rule = (lib.RULES as { id: string; typeOnlyCheck?: unknown }[]).find((r) => r.id === 'R4')!;
    expect(typeof rule.typeOnlyCheck).toBe('function');
    const typesFree = rule.typeOnlyCheck as (s: string) => boolean;
    expect(
      [
        '@retake/components/geometry',
        '@retake/editor/plan',
        '@retake/review/checks',
        '@retake/hooks/describe',
        '@retake/runner-web/types',
        '@retake/sandbox/types',
        '@retake/components',
        '@retake/review/thumbs',
        '@retake/editor',
        '@retake/sandbox',
        '@retake/hooks',
        '@retake/runner-web',
      ].filter((s) => typesFree(s)),
    ).toEqual(entries);
    // Every domain entry is a real entry of its package (an exports key with a source), and none is a package root.
    for (const entry of lib.DOMAIN_ENTRIES as string[]) {
      const [, pkg, sub] = /^@retake\/([\w-]+)\/([\w-]+)$/.exec(entry)!;
      const exportsOf = (JSON.parse(readFileSync(join(ROOT, 'packages', pkg!, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports;
      expect(exportsOf, entry).toHaveProperty([`./${sub}`]);
    }
  });

  it('flags the components root in a pure module of the review, type or value, not their geometry entry', () => {
    // No type-only allowance: the rule reads the specifier, whatever the import's form.
    expect((lib.RULES as { id: string; typeOnlyCheck?: boolean }[]).find((r) => r.id === 'R12')!.typeOnlyCheck).toBeUndefined();
    const pure = lib.REVIEW_PURE as string[];
    expect(pure).toEqual(['checks-entry', 'checks', 'pixel-checks', 'pixel-maths', 'spans', 'timeline', 'anchor', 'diff', 'types', 'images', 'report-lines']);
    const files = Object.fromEntries([
      ...pure.map(
        (n) =>
          [
            `packages/review/src/${n}.ts`,
            {
              text: "import type { ComponentRegistry } from '@retake/components';\nimport { fitText } from '@retake/components/geometry';\n",
              specs: ['@retake/components', '@retake/components/geometry', '@retake/core', '@retake/editor/plan'],
            },
          ] as const,
      ),
      ['packages/review/src/a/checks.ts', { text: "import { fitText } from '@retake/components/kit';\n", specs: ['@retake/components/kit'] }] as const,
      // The I/O side of the review may: it is not what the entry reaches.
      ['packages/review/src/review.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
      ['packages/review/src/pixels.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
      ['packages/editor/src/checks.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
    ]);
    expect(
      hitsOf(files)
        .filter((h) => h.startsWith('R12 '))
        .sort(),
    ).toEqual(pure.map((n) => `R12 packages/review/src/${n}.ts → @retake/components`).sort());
    expect(hits({ 'packages/review/src/types.ts': ['@retake/components/kit', '@retake/components/geometry/x'] }).filter((h) => h.startsWith('R12 '))).toEqual([
      'R12 packages/review/src/types.ts → @retake/components/kit',
      'R12 packages/review/src/types.ts → @retake/components/geometry/x',
    ]);
    // Every pure module is a file of the review.
    for (const n of pure) expect(() => readFileSync(join(ROOT, 'packages', 'review', 'src', `${n}.ts`)), n).not.toThrow();
  });

  it("the engine's facade never names the file job queue", () => {
    const dir = join(ROOT, 'packages', 'engine', 'src', 'facade');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('context.ts');
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\bFileJobQueue\b/);
    // Nor reads the class's own member off the port under a cast (`(ctx.queue as unknown as { files: … }).files`): the
    // paths are handed beside the queue (`jobFiles`). A word search: a cast spelt another way is the type check's to refuse.
    const READS_FILES = /\bqueue\b(?:\s+as\b[^)\n]*)?\s*[)!?]*\s*\.\s*files\b/;
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(READS_FILES);
    for (const text of ['ctx.queue.files', 'queue!.files', 'queue?.files', '(queue as FileQueue).files', '(ctx.queue as unknown as { files: JobFiles }).files']) expect(text).toMatch(READS_FILES);
    for (const text of ['const { queue, files: jobFiles } = queueOf(root, cli);', '{ queue, client, scope, files: ctx.files }', 'queueOf: (root) => { queue: JobQueue; files: JobFiles }'])
      expect(text).not.toMatch(READS_FILES);
  });

  /** A scratch repository of real files, read by the scan itself: its rule hits (the specifiers are the scan's, not hand-written). */
  const scannedHits = (files: Record<string, string>): string[] => {
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    try {
      for (const [rel, text] of Object.entries(files)) {
        const pkg = rel.split('/')[1]!;
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, 'packages', pkg, 'package.json'), `{"name": "@retake/${pkg}"}\n`);
        writeFileSync(join(root, rel), text);
      }
      return lib
        .ruleHits(root, lib.scan(root).fileImports)
        .map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`)
        .sort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("the scan lists a namespace re-export (export * as ns from), which the compiler's pre-processor does not: every specifier rule sees it", () => {
    const ts = lib.loadTs(ROOT) as typeof import('typescript');
    // The hole this closes, as it is in the compiler today: the pre-processor lists nothing for the form.
    const text = "export * as sb from '@retake/hooks';\n";
    expect(ts.preProcessFile(text, true, true).importedFiles.map((x) => x.fileName)).toEqual([]);
    expect(lib.specifiersOf(ts, 'a.ts', text)).toEqual(['@retake/hooks']);
    // The pre-processor's list first and as it gives it, then what only the declarations have, each once.
    const mixed =
      "import { a } from './a.js';\nimport type { B } from './b.js';\nexport * as c from './c.js';\nexport * from './d.js';\nconst e = await import('./e.js');\nlet f: typeof import('./f.js');\nimport g = require('./g.js');\nexport * as a2 from './a.js';\nexport type * as h from './h.js';\n";
    expect([...lib.specifiersOf(ts, 'a.ts', mixed)].sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js', './h.js']);
    expect(lib.declaredSpecifiers(ts, 'a.ts', mixed)).toEqual(['./a.js', './b.js', './c.js', './d.js', './g.js', './a.js', './h.js']);
    expect(
      scannedHits({
        'packages/core/src/x.ts': "export * as fs from 'node:fs';\n",
        'packages/core/src/y.ts': "export * as io from './io/index.js';\n",
        'packages/core/src/io/index.ts': 'export const r = 1;\n',
        'packages/hooks/src/x.ts': "export * as engine from '@retake/engine';\n",
        'packages/ui/src/server/x.ts': "export * as mcp from '@retake/mcp';\nexport * as plan from '@retake/editor/plan';\nexport * as fs from 'node:fs';\n",
        'packages/ui/src/app/c.ts': "export * as core from '@retake/core';\n",
        'packages/ui/src/app/types.ts': "export type * as core from '@retake/core';\n",
        'packages/editor/src/plan.ts': "export * as r from 'remotion';\n",
        'packages/review/src/spans.ts': "export * as c from '@retake/components';\nexport * as cp from 'node:child_process';\nexport * as e from '@retake/editor';\n",
        'packages/engine/src/x.ts': "export * as sb from '@retake/hooks';\nexport * as ed from '@retake/editor';\n",
        'packages/engine/src/types.ts': "export type * as sb from '@retake/sandbox';\n",
        'packages/engine/src/lazy.ts': "export * as sb from '@retake/sandbox';\n",
      }),
    ).toEqual([
      'R1 packages/core/src/x.ts → node:fs',
      'R1 packages/core/src/y.ts → ./io/index.js',
      'R11 packages/engine/src/x.ts → @retake/hooks',
      'R12 packages/review/src/spans.ts → @retake/components',
      'R2 packages/hooks/src/x.ts → @retake/engine',
      'R3 packages/ui/src/server/x.ts → @retake/mcp',
      'R4 packages/ui/src/server/x.ts → @retake/editor/plan',
      'R5 packages/ui/src/app/c.ts → @retake/core',
      'R6 packages/ui/src/server/x.ts → node:fs',
      'R7 packages/editor/src/plan.ts → remotion',
      'R7 packages/review/src/spans.ts → node:child_process',
      'R8 packages/review/src/spans.ts → @retake/editor',
      'R9 packages/engine/src/x.ts → @retake/editor',
    ]);
    // A cycle through the form is a cycle too (the file graph reads the same list).
    const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
    try {
      mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', 'core', 'package.json'), '{"name": "@retake/core"}\n');
      writeFileSync(join(root, 'packages', 'core', 'src', 'a.ts'), "export * as b from './b.js';\n");
      writeFileSync(join(root, 'packages', 'core', 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n");
      expect(lib.fileCycles(lib.scan(root).fileImports)).toEqual([['packages/core/src/a.ts', 'packages/core/src/b.ts']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the engine's loader only loads on a call: no static import or re-export of a package in lazy.ts", () => {
    const ts = lib.loadTs(ROOT) as typeof import('typescript');
    const loader = lib.ENGINE_LOADER as string;
    const uses = lib.moduleUses(ts, loader, readFileSync(join(ROOT, loader), 'utf8')) as { values: Set<string>; statics: Set<string> };
    // The file is exempt from R9 and R11 whole: a static `export * from '@retake/sandbox'` there would hand every engine
    // file the adapter's values through `./lazy.js`, unseen. What it loads, it loads inside a function.
    expect([...uses.statics]).toEqual([]);
    expect([...uses.values].sort()).toEqual(['@retake/editor', '@retake/hooks', '@retake/review', '@retake/review/thumbs', '@retake/runner-web', '@retake/sandbox']);
    // What `statics` reads, on the forms: a declaration is static, a call is not, a type loads nothing.
    const staticsOf = (text: string): string[] => [...(lib.moduleUses(ts, loader, text) as { statics: Set<string> }).statics];
    for (const text of [
      "export * from '@retake/sandbox';",
      "export * as sb from '@retake/sandbox';",
      "export { pidAlive } from '@retake/sandbox';",
      "import { pidAlive } from '@retake/sandbox';",
      "import '@retake/sandbox';",
      "import sb = require('@retake/sandbox');",
      "import { type S, pidAlive } from '@retake/sandbox';",
    ])
      expect(staticsOf(text), text).toEqual(['@retake/sandbox']);
    for (const text of [
      "export const sandbox = () => import('@retake/sandbox');",
      "import type { S } from '@retake/sandbox';",
      "export type { S } from '@retake/sandbox';",
      "let s: typeof import('@retake/sandbox');",
      "const sb = require('@retake/sandbox');",
    ])
      expect(staticsOf(text), text).toEqual([]);
  });

  it('every package is in exactly one layer; a relative import never leaves its package; a .cts source is read like the others', () => {
    // A new folder of packages/ belongs to no list until someone decides its layer: the rules would not read it.
    const dirs = readdirSync(join(ROOT, 'packages'))
      .filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory())
      .sort();
    const layers = lib.LAYERS as Record<string, string[]>;
    expect(Object.keys(layers)).toEqual(['domain', 'adapters', 'application', 'shells']);
    expect(Object.values(layers).flat().sort()).toEqual(dirs);
    expect(new Set(Object.values(layers).flat()).size).toBe(dirs.length);
    // The lists are the rules' own: R2 reads the adapters, R4 the shells.
    const rules = lib.RULES as { id: string; files: (f: string) => boolean }[];
    for (const p of dirs) {
      expect(rules.find((r) => r.id === 'R2')!.files(`packages/${p}/src/a.ts`), p).toBe(layers.adapters!.includes(p));
      expect(rules.find((r) => r.id === 'R4')!.files(`packages/${p}/src/a.ts`), p).toBe(layers.shells!.includes(p));
    }
    // R13: another package is reached by its name (what the layer rules read), never by a path.
    expect(
      scannedHits({
        'packages/engine/src/jobs/a.ts':
          "import { pidAlive } from '../../../sandbox/dist/index.js';\nimport type { S } from '../../../sandbox/src/index.js';\nexport * as hooks from '../../../hooks/src/index.js';\nconst rw = await import('../../../runner-web/dist/index.js');\nimport { b } from '../b.js';\nimport pkg from '../../package.json';\nimport { c } from './c.js';\n",
        'packages/cli/src/a.ts':
          "import { s } from '../../../scripts/audit/lib.mjs';\nimport { e } from '../../engine/src/index.js';\nimport { self } from '../../cli/src/b.js';\nimport { near } from '../../cli-tools/x.js';\n",
        'packages/core/src/a.cts': "import fs = require('node:fs');\nimport up = require('../../hooks/src/x.js');\n",
        'packages/core/src/types.d.cts': "import fs = require('node:fs');\n",
      }),
    ).toEqual([
      'R1 packages/core/src/a.cts → node:fs',
      'R13 packages/cli/src/a.ts → ../../../scripts/audit/lib.mjs',
      'R13 packages/cli/src/a.ts → ../../cli-tools/x.js',
      'R13 packages/cli/src/a.ts → ../../engine/src/index.js',
      'R13 packages/core/src/a.cts → ../../hooks/src/x.js',
      'R13 packages/engine/src/jobs/a.ts → ../../../hooks/src/index.js',
      'R13 packages/engine/src/jobs/a.ts → ../../../runner-web/dist/index.js',
      'R13 packages/engine/src/jobs/a.ts → ../../../sandbox/dist/index.js',
      'R13 packages/engine/src/jobs/a.ts → ../../../sandbox/src/index.js',
    ]);
    // No entry in the baseline: the repository has none.
    expect((lib.readBaseline(ROOT) as { groups: { rule: string }[] }).groups.filter((g) => g.rule === 'R13')).toEqual([]);
  });

  it('flags the file job queue class passed on as a value outside the composition roots, not its use as a type', () => {
    const value = ['queue packages/ui/src/server/a.ts → FileJobQueue as a value'];
    const at = (text: string) => wiring('packages/ui/src/server/a.ts', text);
    expect(at("import { FileJobQueue } from '@retake/engine';\nconst Q = FileJobQueue;\nconst q = new Q(root);")).toEqual(value);
    expect(at("const { FileJobQueue: Q } = await import('@retake/engine');\nconst q = new Q(root);")).toEqual(value);
    expect(at('const { FileJobQueue } = engine;\nmake(FileJobQueue);')).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nconst Q = e['FileJobQueue'];")).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nregister(e.FileJobQueue);")).toEqual(value);
    expect(at("import { FileJobQueue as F } from '@retake/engine';\nexport const kinds = { F };")).toEqual(value);
    expect(at("import * as e from '@retake/engine';\nimport Q = e.FileJobQueue;")).toEqual(value);
    // Types only: annotations, typeof, generics, implements, type declarations.
    expect(
      at(
        "import { FileJobQueue } from '@retake/engine';\nlet q: FileJobQueue;\ntype Ctor = typeof FileJobQueue;\ninterface I { q: FileJobQueue }\nclass Mine implements FileJobQueue {}\nconst xs: Array<FileJobQueue> = [];\nconst y = q as FileJobQueue;",
      ),
    ).toEqual([]);
    expect(wiring('packages/engine/src/jobs/b.ts', 'const Q = FileJobQueue;')).toEqual(['queue packages/engine/src/jobs/b.ts → FileJobQueue as a value']);
    expect(wiring('packages/engine/src/engine.ts', 'const Q = FileJobQueue;')).toEqual([]);
  });

  it('flags a module-level let / var of core, the engine or an adapter that holds the policy work runs under, and nothing else', () => {
    // The state the process-wide setters held before WorkPolicy, by name or by type.
    expect(wiring('packages/core/src/agent-policy.ts', 'let agentFolders: string[] | null = null;')).toEqual(['policy-state packages/core/src/agent-policy.ts → let agentFolders']);
    expect(wiring('packages/core/src/io/bundle.ts', 'export let workspaceFfmpeg: string | undefined;\nlet programCheck = null;')).toEqual([
      'policy-state packages/core/src/io/bundle.ts → let workspaceFfmpeg',
      'policy-state packages/core/src/io/bundle.ts → let programCheck',
    ]);
    expect(wiring('packages/editor/src/render/policy.ts', "import type { RenderSettings } from '@retake/core';\nvar current: RenderSettings | undefined;")).toEqual([
      'policy-state packages/editor/src/render/policy.ts → let current',
    ]);
    expect(wiring('packages/runner-web/src/launch.ts', 'let { a, b: [held] } = { a: 1, b: [PERSON_POLICY as WorkPolicy] };')).toEqual([
      'policy-state packages/runner-web/src/launch.ts → let a',
      'policy-state packages/runner-web/src/launch.ts → let held',
    ]);
    expect(wiring('packages/engine/src/workspace.ts', 'let opened = workPolicy(ws, { agent: true }) as WorkPolicy;')).toEqual(['policy-state packages/engine/src/workspace.ts → let opened']);
    // A value is not state: a const, a parameter, a local variable, a class field; another package's let (the shells: not checked).
    expect(
      wiring(
        'packages/core/src/a.ts',
        'const PERSON: WorkPolicy = Object.freeze({ agentFolders: null });\nexport function f(policy: WorkPolicy) {\n  let ffmpeg = policy.ffmpeg;\n  return ffmpeg;\n}\nclass C { policy: WorkPolicy | null = null }',
      ),
    ).toEqual([]);
    expect(wiring('packages/hooks/src/a.ts', 'let cached: string | undefined;\nlet seq = 0;')).toEqual([]);
    expect(wiring('packages/cli/src/commands/doctor.ts', 'let renderPolicyFn: (() => string) | undefined;')).toEqual([]);
  });

  describe('R10: the rendering library is named in its seam files only', () => {
    const seam = (rel: string, text: string): string[] => lib.seamHits(ROOT, [{ rel, text }]).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`);
    const EDITOR = 'packages/editor/src/render/other.ts';
    const HOST = 'packages/editor/src/remotion/host.ts';
    const KIT = 'packages/components/src/kit/renderer.ts';
    const LIBRARY = 'packages/editor/src/render/library.ts';

    it('1. a static import in a file that is no seam', () => {
      expect(seam(EDITOR, "import { interpolate } from 'remotion';\nimport { z } from 'zod';")).toEqual([`R10 ${EDITOR} → remotion`]);
      expect(seam('packages/ui/src/app/a.tsx', "import { Player } from '@remotion/player';")).toEqual(['R10 packages/ui/src/app/a.tsx → @remotion/player']);
      expect(seam(EDITOR, "import '@remotion/renderer';")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
    });

    it('2. a type-only import: typing against the library is coupling too', () => {
      expect(seam(EDITOR, "import type { RenderMediaOptions } from '@remotion/renderer';")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
      expect(seam(EDITOR, "import { type Codec } from '@remotion/renderer';")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
      expect(seam(EDITOR, "export type R = typeof import('@remotion/bundler');")).toEqual([`R10 ${EDITOR} → @remotion/bundler`]);
    });

    it('3. a dynamic import()', () => {
      expect(seam(EDITOR, "export const load = () => import('@remotion/renderer');")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
      expect(seam(EDITOR, 'export const load = () => import(`remotion`);')).toEqual([`R10 ${EDITOR} → remotion`]);
    });

    it('4. a require, also one made with createRequire', () => {
      expect(seam(EDITOR, "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const r = req('remotion');")).toEqual([`R10 ${EDITOR} → remotion`]);
      expect(seam(EDITOR, "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url)('@remotion/renderer');")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
      expect(seam(EDITOR, "export const r = require('remotion');\nimport b = require('@remotion/bundler');")).toEqual([`R10 ${EDITOR} → remotion`, `R10 ${EDITOR} → @remotion/bundler`]);
    });

    it('5. a path into the library', () => {
      expect(seam(EDITOR, "import { NoReactInternals } from 'remotion/no-react';")).toEqual([`R10 ${EDITOR} → remotion/no-react`]);
      expect(seam(EDITOR, "import x from '@remotion/renderer/client';")).toEqual([`R10 ${EDITOR} → @remotion/renderer/client`]);
      // Another package whose name only starts the same way is not the library.
      expect(seam(EDITOR, "import x from 'remotion-extras';\nimport y from '@remotionx/a';")).toEqual([]);
    });

    it('6. a seam file naming a package of the library that is not its own', () => {
      expect(seam(HOST, "export { AbsoluteFill } from 'remotion';\nexport { Lottie } from '@remotion/lottie';")).toEqual([`R10 ${HOST} → @remotion/lottie`]);
      expect(seam(KIT, "export { AbsoluteFill } from 'remotion';\nexport { Lottie } from '@remotion/lottie';\nimport { renderMedia } from '@remotion/renderer';")).toEqual([
        `R10 ${KIT} → @remotion/renderer`,
      ]);
      expect(seam(LIBRARY, "export const a = () => import('@remotion/renderer');\nexport const b = () => import('@remotion/bundler');\nimport { Img } from 'remotion';")).toEqual([
        `R10 ${LIBRARY} → remotion`,
      ]);
      expect(seam('packages/ui/src/player/frame-main.tsx', "import { Player } from '@remotion/player';\nimport type { PlayerRef } from '@remotion/player';\nimport { Img } from 'remotion';")).toEqual([
        'R10 packages/ui/src/player/frame-main.tsx → remotion',
      ]);
    });

    it('7. a seam file re-exported wholesale by a file that is no seam', () => {
      const index = 'packages/components/src/kit/index.ts';
      expect(seam(index, "export * from './renderer.js';")).toEqual([`R10 ${index} → export * from ${KIT}`]);
      expect(seam(index, "export * as r from './renderer.js';")).toEqual([`R10 ${index} → export * from ${KIT}`]);
      expect(seam('packages/editor/src/render/index.ts', "export * from './library.js';")).toEqual([`R10 packages/editor/src/render/index.ts → export * from ${LIBRARY}`]);
      expect(seam('packages/editor/src/remotion/all.ts', "export * from './host.js';")).toEqual([`R10 packages/editor/src/remotion/all.ts → export * from ${HOST}`]);
      // The specifier's extension is the compiled one or the source's: the same file.
      expect(seam('packages/ui/src/player/boot.ts', "export * from './frame-main.jsx';")).toEqual(['R10 packages/ui/src/player/boot.ts → export * from packages/ui/src/player/frame-main.tsx']);
      expect(seam('packages/ui/src/player/boot.ts', "export * from './frame-main.tsx';\nexport * from './frame-main';")).toEqual([
        'R10 packages/ui/src/player/boot.ts → export * from packages/ui/src/player/frame-main.tsx',
      ]);
      // Names handed on one by one are a visible line each (how the kit's index works), and another file is no seam.
      expect(seam(index, "export { AbsoluteFill, Img } from './renderer.js';\nexport * from './elements.js';")).toEqual([]);
    });

    it('8. a re-export of the library itself', () => {
      expect(seam(EDITOR, "export { interpolate } from 'remotion';")).toEqual([`R10 ${EDITOR} → remotion`]);
      expect(seam(EDITOR, "export * from 'remotion';\nexport type { Codec } from '@remotion/renderer';")).toEqual([`R10 ${EDITOR} → remotion`, `R10 ${EDITOR} → @remotion/renderer`]);
    });

    /** The ratchet's R10 entries of a scratch repository (so the second file list is read the way the ratchet reads it). */
    const entriesOf = (files: Record<string, string>): string[] => {
      const root = mkdtempSync(join(tmpdir(), 'retake-import-rules-'));
      try {
        mkdirSync(join(root, 'packages/components/src'), { recursive: true });
        writeFileSync(join(root, 'packages/components/package.json'), '{"name":"@retake/components"}');
        for (const [rel, text] of Object.entries(files)) {
          mkdirSync(dirname(join(root, rel)), { recursive: true });
          writeFileSync(join(root, rel), text);
        }
        return lib.ratchetEntries(root).filter((e: string) => e.startsWith('R10 '));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('9. a built-in component naming the library (the ratchet reads the library folder too)', () => {
      const card = 'packages/components/library/studio/card-x/index.tsx';
      expect(entriesOf({ [card]: "import { useCurrentFrame } from 'remotion';\nimport { Title } from '@retake/components/kit';" })).toEqual([`R10 ${card} → remotion`]);
      expect(entriesOf({ [card]: "import { Title, useCurrentFrame } from '@retake/components/kit';" })).toEqual([]);
    });

    it('10. a scaffold naming the library', () => {
      const scaffold = 'packages/components/scaffolds/card/index.tsx';
      expect(entriesOf({ [scaffold]: "import { Lottie } from '@remotion/lottie';" })).toEqual([`R10 ${scaffold} → @remotion/lottie`]);
      // The real folders are read: every built-in and every scaffold.
      const real = lib.libraryFreeSources(ROOT).map((f: { rel: string }) => f.rel);
      expect(real.filter((f: string) => f.startsWith('packages/components/library/studio/')).length).toBeGreaterThanOrEqual(41);
      expect(real.filter((f: string) => f.startsWith('packages/components/scaffolds/')).length).toBeGreaterThanOrEqual(8);
    });

    it("11. the library's path resolved outside the file allowed to", () => {
      expect(seam(EDITOR, "export const p = require.resolve('remotion/package.json');")).toEqual([`R10 ${EDITOR} → resolve(remotion/package.json)`]);
      expect(seam(EDITOR, "export const p = import.meta.resolve('@remotion/bundler');")).toEqual([`R10 ${EDITOR} → resolve(@remotion/bundler)`]);
      expect(seam(EDITOR, "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const p = req.resolve('@remotion/player/package.json');")).toEqual([
        `R10 ${EDITOR} → resolve(@remotion/player/package.json)`,
      ]);
      const player = 'packages/ui/src/player/bundle-player.ts';
      expect(seam(player, "export const p = require.resolve('@remotion/player/package.json');")).toEqual([]);
      // Resolving is all that file may do with it.
      expect(seam(player, "import { Player } from '@remotion/player';")).toEqual([`R10 ${player} → @remotion/player`]);
      expect(seam(player, "export const p = require.resolve('remotion/package.json');")).toEqual([`R10 ${player} → resolve(remotion/package.json)`]);
    });

    it('12. the seam files and what each may name are this list, no more (a new seam is a change here)', () => {
      expect(lib.LIBRARY_SEAMS).toEqual({
        'packages/editor/src/render/library.ts': { load: ['@remotion/renderer', '@remotion/bundler'], resolve: ['remotion'] },
        'packages/editor/src/remotion/host.ts': { load: ['remotion'], resolve: [] },
        'packages/components/src/kit/renderer.ts': { load: ['remotion', '@remotion/lottie'], resolve: [] },
        'packages/ui/src/player/frame-main.tsx': { load: ['@remotion/player'], resolve: [] },
        'packages/ui/src/player/bundle-player.ts': { load: [], resolve: ['@remotion/player'] },
      });
      expect(lib.LIBRARY_SEAM_IMPORTERS).toEqual({
        'packages/editor/src/render/library.ts': 'packages/editor/src/render',
        'packages/editor/src/remotion/host.ts': 'packages/editor/src/remotion',
        'packages/components/src/kit/renderer.ts': 'packages/components/src/kit',
      });
      expect(Object.keys(lib.LIBRARY_COMPUTED_READS)).toEqual(['packages/components/src/compile.ts']);
      expect(lib.LIBRARY_FREE_DIRS).toEqual(['packages/components/library', 'packages/components/scaffolds']);
      // Every seam exists, and the repository has no R10 entry: the baseline starts empty for this rule.
      for (const f of Object.keys(lib.LIBRARY_SEAMS)) expect(readFileSync(join(ROOT, f), 'utf8').length, f).toBeGreaterThan(0);
      expect(lib.ratchetEntries(ROOT).filter((e: string) => e.startsWith('R10 '))).toEqual([]);
      expect((lib.readBaseline(ROOT).groups as { rule: string }[]).filter((g) => g.rule === 'R10')).toEqual([]);
      expect(lib.CHECKS.map((c: { id: string }) => c.id)).toContain('R10');
    });

    it('13. a seam file that hands the library on, imported or re-exported from outside its folder', () => {
      const planner = 'packages/editor/src/planner/a.ts';
      const index = 'packages/editor/src/index.ts';
      expect(seam(planner, "import { Composition } from '../remotion/host.js';")).toEqual([`R10 ${planner} → seam ${HOST}`]);
      expect(seam(planner, "import type { LibraryBrowser } from '../render/library.js';")).toEqual([`R10 ${planner} → seam ${LIBRARY}`]);
      expect(seam(index, "export { Composition } from './remotion/host.js';")).toEqual([`R10 ${index} → seam ${HOST}`]);
      expect(seam(index, "import * as host from './remotion/host.js';\nexport { host };")).toEqual([`R10 ${index} → seam ${HOST}`]);
      expect(seam(index, "export { rendererLibrary } from './render/library.js';")).toEqual([`R10 ${index} → seam ${LIBRARY}`]);
      expect(seam(index, "export const load = () => import('./render/library.js');\nexport type L = typeof import('./render/library.js');")).toEqual([`R10 ${index} → seam ${LIBRARY}`]);
      // Wholesale from outside the folder: one hit, this one.
      expect(seam(index, "export * from './remotion/host.js';\nexport * as l from './render/library.js';")).toEqual([`R10 ${index} → seam ${HOST}`, `R10 ${index} → seam ${LIBRARY}`]);
      expect(seam('packages/components/src/compile.ts', "import { Img } from './kit/renderer.js';")).toEqual([`R10 packages/components/src/compile.ts → seam ${KIT}`]);
      expect(seam('packages/components/library/studio/card-x/index.tsx', "import { Loop } from '../../../src/kit/renderer.js';")).toEqual([
        `R10 packages/components/library/studio/card-x/index.tsx → seam ${KIT}`,
      ]);
      // A nested folder is not the seam's folder; another spelling of the file is the same file.
      expect(seam('packages/editor/src/render/deep/a.ts', "import { rendererLibrary } from '../library.js';")).toEqual([`R10 packages/editor/src/render/deep/a.ts → seam ${LIBRARY}`]);
      expect(seam(planner, "import { Composition } from '../remotion/host.ts';\nimport { x } from '../remotion/host';")).toEqual([`R10 ${planner} → seam ${HOST}`]);
      expect(seam('packages/components/src/kit/index.ts', "export * from './renderer.ts';")).toEqual([`R10 packages/components/src/kit/index.ts → export * from ${KIT}`]);
      // The seam's own folder is where it is used, and a file of the same name elsewhere is no seam.
      expect(seam('packages/editor/src/remotion/Root.tsx', "import { Composition } from './host.js';")).toEqual([]);
      expect(seam('packages/editor/src/render/bundle.ts', "import { bundlerLibrary } from './library.js';")).toEqual([]);
      expect(seam('packages/components/src/kit/media.tsx', "import { Loop } from './renderer.js';")).toEqual([]);
      expect(seam('packages/engine/src/index.ts', "export { x } from './library.js';\nexport type { Renderer } from './render/renderer.js';")).toEqual([]);
      // The player's two seam files hand nothing of the library on: importing them is not ruled.
      expect(seam('packages/ui/src/server/player.ts', "import { bundlePlayer } from '../player/bundle-player.js';")).toEqual([]);
    });

    it('14. a spelling that hides the name from a text search, and files that are not .ts', () => {
      // An escaped specifier is the same name once the compiler has read it.
      expect(seam(EDITOR, "import x from '\\u0072emotion';")).toEqual([`R10 ${EDITOR} → remotion`]);
      expect(seam(EDITOR, "export const load = () => import('@\\x72emotion/renderer');")).toEqual([`R10 ${EDITOR} → @remotion/renderer`]);
      // Plain JavaScript, JSX in it, a declaration file.
      expect(seam('packages/editor/src/render/a.mjs', "import { renderMedia } from '@remotion/renderer';")).toEqual(['R10 packages/editor/src/render/a.mjs → @remotion/renderer']);
      expect(seam('packages/components/library/studio/card-x/part.jsx', 'import { Img } from \'remotion\';\nexport const A = () => <Img src="a.png" />;')).toEqual([
        'R10 packages/components/library/studio/card-x/part.jsx → remotion',
      ]);
      expect(seam('packages/editor/src/render/a.d.ts', "import type { Codec } from '@remotion/renderer';\nexport declare const c: Codec;")).toEqual([
        'R10 packages/editor/src/render/a.d.ts → @remotion/renderer',
      ]);
      // The ratchet reads them where they live: a nested folder of a built-in, a scaffold's .js, a .d.ts and a .mjs under src.
      const nested = 'packages/components/library/studio/card-x/parts/a.jsx';
      const scaffoldJs = 'packages/components/scaffolds/card/helper.js';
      const dts = 'packages/components/src/kit/extra.d.ts';
      const mjs = 'packages/components/src/tool.mjs';
      expect(
        entriesOf({
          [nested]: "import { Img } from 'remotion';",
          [scaffoldJs]: "const { Lottie } = require('@remotion/lottie');",
          [dts]: "export type P = import('remotion').SequenceProps;",
          [mjs]: "export { interpolate } from 'remotion';",
        }),
      ).toEqual([`R10 ${nested} → remotion`, `R10 ${scaffoldJs} → @remotion/lottie`, `R10 ${dts} → remotion`, `R10 ${mjs} → remotion`].sort());
    });

    it('the computed reads it lists are still in the code as described', () => {
      // compile.ts loads react and the library by a name taken from a list: no literal the rule could read.
      const compile = readFileSync(join(ROOT, 'packages/components/src/compile.ts'), 'utf8');
      expect(compile).toMatch(/const STUBBED = \[[^\]]*'remotion'[^\]]*\] as const;/);
      expect(compile).toMatch(/for \(const name of STUBBED\) \{[\s\S]{0,80}await import\(name\)/);
      expect(seam('packages/components/src/compile.ts', compile)).toEqual([]);
      // library.ts no longer has one: its two version reads are literals, allowed by its own entry.
      const library = readFileSync(join(ROOT, LIBRARY), 'utf8');
      expect(library).toContain("require.resolve('remotion/package.json')");
      expect(library).toContain("require.resolve('@remotion/bundler/package.json')");
      expect(library).not.toMatch(/resolve\(`/);
      expect(seam(LIBRARY, library)).toEqual([]);
      // Resolving `remotion` is all that file may do with it, and no other seam may.
      expect(seam(LIBRARY, "export const a = () => import('remotion');")).toEqual([`R10 ${LIBRARY} → remotion`]);
      expect(seam(HOST, "export const p = require.resolve('@remotion/renderer/package.json');")).toEqual([`R10 ${HOST} → resolve(@remotion/renderer/package.json)`]);
    });

    it('says what it does not see: a computed specifier and a name inside a data string are no hit', () => {
      expect(
        seam(
          EDITOR,
          "const name = 'remotion';\nexport const a = () => import(name);\nexport const ALLOWED = ['react', 'remotion'];\nexport const entry = \"import { registerRoot } from 'remotion';\";\nexport const v = (n: string) => require.resolve(`${n}/package.json`);\n// import x from 'remotion'",
        ),
      ).toEqual([]);
      // Nor a require under another name, a module declaration, or a name put together.
      expect(
        seam(
          EDITOR,
          "import { createRequire as cr } from 'node:module';\nexport const a = cr(import.meta.url)('remotion');\nconst { resolve } = require;\nexport const b = resolve('remotion');\nexport const c = () => import('remo' + 'tion');",
        ),
      ).toEqual([]);
      expect(seam('packages/editor/src/render/a.d.ts', "declare module 'remotion' {\n  export const x: number;\n}")).toEqual([]);
    });
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

  it('counts the hand-written layout paths outside the layout module: a path-like string or template anywhere, a layout folder as a node:path argument', () => {
    const layout = (rel: string, text: string): string[] =>
      lib.layoutHits(ROOT, [{ rel, pkg: rel.split('/')[1], text, specs: [] }]).map((h: { file: string; count: number }) => `${h.file} ${h.count}`);
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
      // Anywhere, not only as a path argument: a state folder, a layout file, a folder and a slash, a template part.
      "export const JOURNALS_DIR = '.retake/journals';", // 10
      "for (const part of ['.retake', sub]) dir = mine(dir, part);", // 11
      'const ref = `scenarios/${name}.yaml`;', // 12
      'const folder = `${root}/.retake/records/${id}`;', // 13
      "const file = mine(stateDir(root), 'history.jsonl');", // 14
      'throw new Error(`renders/${id}.json is not a record`);', // 15
      "const j = 'journal.jsonl';", // 16
      // Not counted: other names, an array's join, another module's join, a bare folder word outside a path call, a
      // URL, a module specifier.
      "join(dir, 'project.yaml'); join(dir, 'runsx'); ['runs', 'x'].join('/'); other.join('runs'); f('runs'); mode === 'review';",
      "fetch(`/api/projects/${slug}/runs/${id}`); const m = await import('hooks/x'); export { a } from 'runs/b';",
    ].join('\n');
    expect(layout('packages/engine/src/a.ts', text)).toEqual(['packages/engine/src/a.ts 16']);
    expect(layout('packages/core/src/layout.ts', text)).toEqual([]);
    expect(layout('packages/engine/src/b.ts', "import { join } from 'node:path';\njoin(dir, 'scenarios-old');\nconst x = 'scenarios';\n")).toEqual([]);
    // The names the check looks for are the layout module's.
    expect([...lib.LAYOUT_NAMES].sort()).toEqual([...Object.values(PROJECT_DIRS), STATE_DIR].sort());
    expect([...lib.LAYOUT_FILES].sort()).toEqual([HISTORY_FILE, WORKSPACE_JOURNAL_FILE, PROJECT_SCENARIO_WRITES_FILE].sort());
    // A ratchet entry per file, with its count: one more path in a file is a new entry (and its old count a stale one).
    const entries = lib.ratchetEntries(ROOT).filter((e: string) => e.startsWith('layout '));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^layout packages\/[\w-]+\/src\/\S+ → \d+ hand-written layout paths?$/);
    // The engine, the hooks and the sandbox spell no layout path by hand any more (only messages of the catalogue).
    expect(entries.filter((e: string) => /packages\/(hooks|sandbox|runner-web|cli)\//.test(e) || (/packages\/engine\//.test(e) && !e.includes('catalogue.ts')))).toEqual([]);
  });

  describe('id-grammar: the id grammars are written in their homes only', () => {
    type IdHit = { file: string; count: number; lines: number[]; kinds: number[] };
    const found = (rel: string, lines: string[]): IdHit[] => lib.idGrammarHits(ROOT, [{ rel, pkg: rel.split('/')[1], text: lines.join('\n'), specs: [] }]);
    /** The kind found on each line of a synthetic file (0: no hit), in line order. */
    const kinds = (lines: string[], rel = 'packages/engine/src/a.ts'): number[] => {
      const h = found(rel, lines)[0];
      return lines.map((_, i) => (h ? (h.kinds[h.lines.indexOf(i + 1)] ?? 0) : 0));
    };
    // Source text of the cases is written with String.raw: a backslash here is a backslash of the file read.
    const R = String.raw;

    it('1. a date stamp, a version suffix or the ULID character class, in a regular expression, a string or a template', () => {
      expect(
        kinds([
          R`const A = /^\d{8}-\d{6}-[a-z0-9][a-z0-9-]*$/;`,
          R`const B = /^\d{8}-\d{6}-/.test(id);`,
          R`const C = /-v(\d+)(?:-(vertical|square))?$/;`,
          R`const D = id.replace(/-v\d+(?:-vertical|-square)?$/, '');`,
          R`const E = /^j_[0-9A-HJKMNP-TV-Z]{26}$/;`,
          R`const F = new RegExp('^' + name + '-v\\d+$');`,
          'const G = new RegExp(`^${scenario}-v\\\\d+(?:-vertical|-square)?$`);',
          R`const H = RegExp('^\\d{8}-\\d{6}-(.+)$');`,
          R`const I = '-v(\\d+)';`, // a source held in a variable: the string itself is seen
          'const J = `^c_[0-9A-HJKMNP-TV-Z]{26}\\\\.${ext}$`;',
          // The suffix whatever follows its digit, in a named or a non-capturing group too.
          R`const K = /-v(\d{1,6})(?:-(vertical|square))?$/;`,
          R`const L = /-v(?<n>\d+)$/;`,
          R`const M = /-v(?:\d{1,6})$/;`,
          R`const N = /-v\d$/;`,
          R`const O = new RegExp('-v(\\d{1,6})$');`,
        ]),
      ).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      // Not these: -v before something else than a digit class.
      expect(kinds([R`const P = /-v[a-z]+$/;`, R`const Q = /-vertical$/;`, "const S = ['-v', 'error'];"])).toEqual([0, 0, 0]);
    });

    it('2. the ULID alphabet as a string', () => {
      expect(kinds(["const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';", 'const T = `0123456789ABCDEFGHJKMNPQRSTVWXYZ${x}`;', "const HEX = '0123456789ABCDEF';"])).toEqual([2, 2, 0]);
    });

    it('3. a regular expression or a string that is the run-folder grammar or a theme-name grammar, with or without a final {0,N}', () => {
      expect(
        kinds([
          R`const A = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;`,
          R`const B = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;`,
          R`const C = /^[a-z0-9][a-z0-9-]*$/;`,
          R`const D = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;`,
          R`const E = /^[a-z0-9][a-z0-9-]{0,99}$/i;`,
          // Not these: another class, another quantifier, a longer pattern.
          R`const F = /^[a-z][a-z_]{0,39}$/;`,
          R`const G = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;`,
          R`const H = /^[a-z0-9][a-z0-9-]*\.json$/;`,
        ]),
      ).toEqual([3, 3, 3, 3, 3, 0, 0, 0]);
      // The same grammar as a string — what `new RegExp` is given, or a source held in a variable — is seen too.
      expect(
        kinds([
          "const A = new RegExp('^[A-Za-z0-9][A-Za-z0-9._-]*$');",
          "const B = RegExp('^[A-Za-z0-9][A-Za-z0-9_-]*$');",
          'const C = new RegExp(`^[a-z0-9][a-z0-9-]*$`);',
          "const D = '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$';",
          // Not these: a part of the grammar, a sentence that quotes it.
          "const E = '[a-z0-9-]';",
          "const F = 'a name matches ^[a-z0-9][a-z0-9-]*$ only';",
        ]),
      ).toEqual([3, 3, 3, 3, 0, 0]);
    });

    it('4. a template that builds or tests an id: a part ending in -v (before a substitution, or last), a ULID prefix before a substitution', () => {
      expect(
        kinds([
          'const a = `${scenario}-v${version}${suffix}`;',
          'const b = join(dir, `.${name}-v${version}.lock`);',
          'const c = id.startsWith(`${scenario}-v`);', // the critique's missed shape: nothing after -v
          'const d = `j_${ulid()}`;',
          'const e = `rec_${newJobId().slice(2)}`;',
          'const f = `k_${ulid()}.json`;',
          ...['p_', 'i_', 's_', 'c_', 'r_'].map((x) => `const g = \`${x}\${ulid()}\`;`),
          // Not these: a prefix that is no id's, a ULID prefix that is not the head, -v inside a part.
          'const h = `x_${n}`;',
          'const i = `${a}j_${n}`;',
          'const j = `${a}-vertical-${n}`;',
          "const k = ['-v', 'error'];", // a program's flag: a string, not a template
        ]),
      ).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0, 5, 0]);
      // The prefixes the check knows are the module's.
      expect([...lib.ID_ULID_PREFIXES].sort()).toEqual(Object.values(ULID_PREFIXES).sort());
    });

    it('5. a string or a template part that starts with -vertical or -square: a second suffix table', () => {
      expect(
        kinds([
          "const SUFFIX = { landscape: '', vertical: '-vertical', square: '-square' };",
          "const f = '-vertical.mp4';",
          'const g = `${id}-square.mp4`;',
          "const h = 'vertical'; const i = 'a-vertical';",
        ]),
      ).toEqual([5, 5, 5, 0]);
      // (Line 1 holds two strings: both are counted.)
      expect(found('packages/engine/src/a.ts', ["const SUFFIX = { landscape: '', vertical: '-vertical', square: '-square' };"])[0].count).toBe(2);
    });

    it('6. a capped grammar used without its cap: .test() and .exec() on it, or the grammar handed to a string method or to a schema', () => {
      expect(
        kinds([
          'if (RUN_ID_RE.test(name)) ok();',
          'const m = RENDER_ID_RE.exec(id);',
          'const t = ANY_THEME_NAME_RE.test(x) && x.length <= 100;', // the cap beside it is still a copy of the rule
          'const n = NEW_THEME_NAME_RE.test(m[1]);',
          'const o = core.RUN_ID_RE.test(name);',
          'const p = name.match(RENDER_ID_RE);',
          "const q = name.replace(RUN_ID_RE, '');",
          // A schema written by hand from the grammar, with or without the cap beside it: the z… helpers hold it.
          'const s = z.string().regex(RUN_ID_RE, msg);',
          'const t2 = z.string().max(RUN_ID_MAX).regex(RUN_ID_RE, msg);',
          'const t3 = z.string().min(1).regex(core.ANY_THEME_NAME_RE, msg).optional();',
          // Not these: an uncapped id's grammar (tested, or in a schema), a schema helper, the grammar's source read.
          'const r = JOB_ID_RE.test(id) || SITE_ID_RE.test(id);',
          'const v = z.string().max(40).regex(JOB_ID_RE, msg);',
          'const w = zRunId(msg).optional();',
          'const u = RENDER_ID_RE.source;',
        ]),
      ).toEqual([6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0, 0, 0, 0]);
      expect([...lib.ID_CAPPED_GRAMMARS]).toEqual(['RUN_ID_RE', 'RENDER_ID_RE', 'ANY_THEME_NAME_RE', 'NEW_THEME_NAME_RE']);
    });

    it('the homes and the one mirror are free, and they are this list, no more; a module specifier is not read', () => {
      const all = [R`const A = /^\d{8}-\d{6}-/;`, 'const b = `${s}-v${n}`;', "const c = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';", 'RUN_ID_RE.test(x);'];
      expect(lib.ID_HOMES).toEqual(['packages/core/src/id-grammar.ts', 'packages/core/src/ids.ts']);
      expect(lib.ID_MIRRORS).toEqual(['packages/ui/src/app/id-words.ts']);
      for (const rel of [...lib.ID_HOMES, ...lib.ID_MIRRORS]) expect(found(rel, all), rel).toEqual([]);
      expect(found('packages/engine/src/jobs/job-input.ts', all).map((h) => [h.count, h.kinds])).toEqual([[4, [1, 4, 2, 6]]]);
      expect(found('packages/ui/src/app/route.ts', all)[0].count).toBe(4);
      // The homes and the mirror exist, and the module's grammars are where the check says.
      for (const rel of [...lib.ID_HOMES, ...lib.ID_MIRRORS]) expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
      expect(readFileSync(join(ROOT, lib.ID_HOMES[0]), 'utf8')).toContain('export const RUN_ID_RE = ');
      expect(found('packages/engine/src/a.ts', ["import x from './-vertical.js';", "export { y } from '-square';", "const z = await import('-vertical');"])).toEqual([]);
    });

    it('says what it does not see: another spelling, a pattern made of pieces, a parser by hand, a grammar under another name', () => {
      expect(
        kinds([
          R`const A = /^[0-9]{8}-[0-9]{6}-/;`, // the stamp spelt another way
          R`const B = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;`, // the class in another order
          "const c = scenario + '-v' + version;", // put together by +
          "const d = new RegExp(scenario + '-v' + DIGITS);",
          "const e = id.startsWith('j_') ? id.slice(2) : null;", // a parser by hand
          "const f = id.split('-');",
          'const RE = RUN_ID_RE; const g = RE.test(name);', // under another name
          'const h = ok(RUN_ID_RE, name);', // handed to a helper
          'const i = RUN_ID.test(name);', // the mirror's pattern without its cap
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      // …and nothing outside packages/*/src is scanned (tests, scripts, fixtures, the desktop shell).
      expect(lib.scan(ROOT).files.every((f: { rel: string }) => /^packages\/[\w-]+\/src\//.test(f.rel))).toBe(true);
    });

    it('the repository: no stamp, suffix, alphabet or id template outside the homes; each file left has its count and a reason', () => {
      const scanned = lib.scan(ROOT);
      const today: string[] = lib.ratchetEntries(ROOT, scanned);
      const hits: IdHit[] = lib.idGrammarHits(ROOT, scanned.files);
      // Kinds 1, 2 and 4 are gone from every package; what is left spells another name's grammar (3: at its
      // definition, or mirrored in the Studio front end), the export formats' file suffixes (5) or one grammar used
      // without its cap on purpose (6).
      expect(hits.flatMap((h) => h.kinds.map((k, i) => (k === 3 || k === 5 || k === 6 ? '' : `${h.file}:${h.lines[i]} kind ${k}`))).filter(Boolean)).toEqual([]);
      expect(hits.filter((h) => h.kinds.includes(5)).map((h) => h.file)).toEqual(['packages/editor/src/render/export.ts']);
      expect(hits.filter((h) => h.kinds.includes(6)).map((h) => h.file)).toEqual(['packages/engine/src/brand/create.ts']);
      expect(hits.filter((h) => h.kinds.includes(3)).map((h) => h.file)).toEqual([
        'packages/core/src/project.ts',
        'packages/core/src/schemas/primitives.ts',
        'packages/engine/src/jobs/job-input.ts',
        'packages/engine/src/reviews.ts',
        'packages/engine/src/run-files.ts',
        'packages/ui/src/app/review/review-words.ts',
        'packages/ui/src/app/unsaved-report.ts',
        'packages/ui/src/app/words/record-words.ts',
      ]);
      const entries = today.filter((e: string) => e.startsWith('id-grammar '));
      expect(entries).toEqual(hits.map((h) => `id-grammar ${h.file} → ${h.count} hand-written id pattern${h.count === 1 ? '' : 's'}`).sort());
      // One more pattern in a file is a new entry (and its old count a stale one).
      const more = lib.compareBaseline(
        [
          ...today.filter((e: string) => !e.startsWith('id-grammar packages/engine/src/brand/create.ts')),
          'id-grammar packages/engine/src/brand/create.ts → 2 hand-written id patterns',
          'id-grammar packages/engine/src/jobs/signing.ts → 1 hand-written id pattern',
        ],
        lib.readBaseline(ROOT),
      );
      expect(more.added).toEqual(['id-grammar packages/engine/src/brand/create.ts → 2 hand-written id patterns', 'id-grammar packages/engine/src/jobs/signing.ts → 1 hand-written id pattern']);
      expect(more.stale).toEqual(['id-grammar packages/engine/src/brand/create.ts → 1 hand-written id pattern']);
      // The check's title says what it reads and what it does not.
      const title = lib.CHECKS.find((c: { id: string }) => c.id === 'id-grammar')?.title ?? '';
      for (const word of ['ID_HOMES', 'ID_MIRRORS', 'Not seen', 'another way', 'pieces', 'another name', 'outside packages/*/src']) expect(title, word).toContain(word);
    });
  });

  describe('record-read: a run.json or a timeline.json gets its type from the one reader', () => {
    type ReadHit = { file: string; count: number; lines: number[]; kinds: number[] };
    const found = (rel: string, lines: string[]): ReadHit[] => lib.recordReadHits(ROOT, [{ rel, pkg: rel.split('/')[1], text: lines.join('\n'), specs: [] }]);
    /** The kind found on each line of a synthetic file (0: no hit), in line order. */
    const kinds = (lines: string[], rel = 'packages/engine/src/a.ts'): number[] => {
      const h = found(rel, lines)[0];
      return lines.map((_, i) => (h ? (h.kinds[h.lines.indexOf(i + 1)] ?? 0) : 0));
    };

    it('1. a parsed value cast to a record or a timeline, through await, parentheses, ! and `as unknown`', () => {
      expect(
        kinds(
          [
            'const a = JSON.parse(text) as RunRecord;',
            "const b = JSON.parse(await readFile(f, 'utf8')) as unknown as Timeline;",
            'const c = (await readJson(file)) as Partial<StoredRunRecord>;',
            'const d = (JSON.parse(text)!) as RunRecord | null;',
            'const e = <Timeline>JSON.parse(text);',
            'const f = (await io.readJson(file)) as core.RunRecord[];',
            'const g = JSON.parse(text) as { mode?: string };', // an own shape: not a record's type
            'const h = JSON.parse(text) as PruneRun | null;',
            "const i = JSON.parse(text) as import('@retake/core').RunRecord;", // the type reached without an import
            "const j = JSON.parse(text) as typeof import('@retake/core');",
          ],
          'packages/engine/src/a.ts',
        ),
      ).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 1, 0]);
    });

    it('2. to 4. a type argument, the annotation of the variable it initialises, the return type of the function that returns it', () => {
      expect(
        kinds([
          'const a = await readJson<Timeline>(file);',
          'const b = JSON.parse<RunRecord>(text);',
          'const c: RunRecord = JSON.parse(text);',
          'const d: Promise<Timeline | undefined> = readJson(file);',
          'async function e(): Promise<RunRecord> {',
          "  return JSON.parse(await readFile(f, 'utf8'));",
          '}',
          'const g = (text: string): StoredRunRecord => JSON.parse(text);',
          'const h = async (): Promise<FinishedRun | undefined> => { try { return await readJson(file); } catch { return undefined; } };',
          'const i: unknown = JSON.parse(text);',
          'function j(): unknown { return JSON.parse(text); }',
          'const k = await readJson<{ scenario: string }>(file);',
        ]),
      ).toEqual([2, 2, 3, 3, 0, 4, 0, 4, 4, 0, 0, 0]);
    });

    it('5. any other value cast to a record or a timeline, once per cast', () => {
      expect(
        kinds([
          'const a = value as RunRecord;',
          'const b = value as unknown as Timeline;',
          "const c = { ...rec, status: 'succeeded' } as SucceededRun;",
          'const d = (isObj(v) ? v : undefined) as UnknownStatusRun | undefined;',
          "const e = value as RunRecord['status'];", // a member's type is no record
          'const f = name as keyof Timeline;',
          'const g = value as RunSummary;',
          'const h = [] as const;',
          "const i = value as unknown as import('@retake/core').Timeline;",
        ]),
      ).toEqual([5, 5, 5, 5, 0, 0, 0, 0, 5]);
      // One cast, one hit — also when two record types are named, or the cast is doubled.
      expect(found('packages/engine/src/a.ts', ['const a = value as unknown as RunRecord | Timeline;'])[0].count).toBe(1);
    });

    it("the reader is free, and it is this file, no more; the types are the run record's states and the timeline's", () => {
      const all = ['const a = JSON.parse(text) as RunRecord;', 'const b = value as unknown as Timeline;'];
      // (L7.6b: the render record's parse boundary, the lenient read it shares with the run record's, the reader of
      // renders/ and its file seam, and the editor's one place where a stored plan becomes an edit plan.)
      expect(lib.RECORD_READ_HOME).toEqual([
        'packages/core/src/run-record.ts',
        'packages/core/src/io/run-folder.ts',
        'packages/core/src/render-record.ts',
        'packages/core/src/record-read.ts',
        'packages/core/src/io/render-folder.ts',
        'packages/core/src/io/record-file.ts',
        'packages/editor/src/render-record.ts',
      ]);
      for (const rel of lib.RECORD_READ_HOME) {
        expect(found(rel, all), rel).toEqual([]);
        expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
      }
      expect(found('packages/core/src/io/files.ts', all).map((h) => [h.count, h.kinds])).toEqual([[2, [1, 5]]]);
      expect(found('packages/ui/src/app/a.tsx', all)[0].count).toBe(2);
      // Every state of the union is named, so a cast to one state does not slip by.
      expect([...lib.RECORD_READ_TYPES].sort()).toEqual([
        'CancelledRun',
        'CompleteRender',
        'FailedRun',
        'FinishedRender',
        'FinishedRun',
        'FoundRender',
        'FoundReviewRender',
        'NamedRender',
        'NamedRenderFound',
        'ProjectRender',
        'QueuedRun',
        'RenderAttempt',
        'RenderBase',
        'RenderFields',
        'RenderForWork',
        'RenderRecord',
        'RunRecord',
        'RunRecordOnDisk',
        'RunningRun',
        'StoredRender',
        'StoredRenderBase',
        'StoredRenderRecord',
        'StoredRunRecord',
        'SucceededRun',
        'Timeline',
        'TimelineHead',
        'UnknownStatusRender',
        'UnknownStatusRun',
      ]);
      // Each is a type a module of the lists declares: the run record's states, the render record's (core), the
      // editor's names for a render record with its plan, the engine's names for a read record.
      const declared = [
        'packages/core/src/run-record.ts',
        'packages/core/src/render-record.ts',
        'packages/core/src/io/render-folder.ts',
        'packages/editor/src/render-record.ts',
        'packages/editor/src/render/export.ts',
        'packages/review/src/load.ts',
        'packages/engine/src/renders.ts',
      ]
        .map((f) => readFileSync(join(ROOT, f), 'utf8'))
        .join('\n');
      for (const name of lib.RECORD_READ_TYPES.filter((n: string) => !['Timeline', 'RunRecordOnDisk'].includes(n))) expect(declared, name).toMatch(new RegExp(`export (type|interface) ${name}\\b`));
      // A render record cast, annotated or guarded outside the homes is seen as a run record is (L7.6b).
      expect(
        kinds([
          'const a = JSON.parse(text) as StoredRenderRecord;',
          'const b = value as unknown as RenderRecord;',
          'const c: FinishedRender<EditPlan, EditOverrides> = JSON.parse(text);',
          'const d = (v: unknown): v is NamedRender => true;',
          'const e = StoredRenderRecordSchema.safeParse(value);',
          'const f = record as RenderForWork;',
          "const g: StoredRender['plan'] = value;", // a member's type: not a record
          // (L7.6b fix pass) The base types under their own names, and the answers that hold a record.
          'const h = JSON.parse(t) as RenderBase<unknown, unknown>;',
          "const i = JSON.parse(t) as StoredRenderBase & { status: 'succeeded' };",
          'function j(t: string): RenderFields<unknown, unknown> { return JSON.parse(t); }',
          'const k = value as FoundRender;',
          'const l = value as NamedRenderFound;',
          'const m = value as FoundReviewRender;',
          'const n = JSON.parse(t) as CompleteRender;',
        ]),
      ).toEqual([1, 5, 3, 6, 8, 5, 0, 1, 1, 4, 5, 5, 5, 1]);
      // The parse boundary of renders/ and its reader are free; the same lines anywhere else are entries.
      for (const rel of ['packages/core/src/render-record.ts', 'packages/core/src/io/render-folder.ts', 'packages/editor/src/render-record.ts'])
        expect(found(rel, ['const a = JSON.parse(text) as StoredRenderRecord;']), rel).toEqual([]);
    });

    it('6-9. a type guard, a generic cast helper, a parse through a schema, an interface that extends a state', () => {
      expect(
        kinds([
          "const isRecord = (v: unknown): v is RunRecord => typeof v === 'object';",
          'function assertRecord(v: unknown): asserts v is StoredRunRecord {}',
          'const a = cast<RunRecord>(JSON.parse(text));',
          'const b = asRead<Timeline>(value);',
          'const c = StoredRunRecordSchema.parse(JSON.parse(text));',
          'const d = schemas.RunRecordSchema.safeParse(value);',
          'const e = TimelineSchema.safeParse(value);',
          'interface Mine extends SucceededRun { more: true }',
          // Not one: a guard of another type, a call typed by a member, a schema of something else, another interface.
          'const isSummary = (v: unknown): v is RunSummary => true;',
          "const f = pick<RunRecord['status']>(value);",
          'const g = ScenarioSchema.parse(value);',
          'interface Other extends RunSummary { more: true }',
          'const h = new Map<string, RunRecord>();',
        ]),
      ).toEqual([6, 6, 7, 7, 8, 8, 8, 9, 0, 0, 0, 0, 0]);
      // `readJson<T>` stays kind 2 (a parse typed by its type argument), not the cast helper's.
      expect(kinds(['const a = await readJson<Timeline>(file);'])).toEqual([2]);
    });

    it('10. a file that reads a run folder on its own, on purpose: each JSON.parse there is an entry of its own kind', () => {
      // (L7.6c: the readers of renders/ staged by L7.6b are on the one reader — no own reader of renders/ is left but prune's
      // read through a link, and no function of an own reader is said to parse no record.)
      expect(lib.RECORD_READ_OWN).toEqual(['packages/engine/src/prune.ts', 'packages/engine/src/jobs/run-job.ts']);
      expect(lib.RECORD_READ_NOT_RECORD).toBeUndefined();
      const own = ["const r = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as Mine | null;", 'const again = JSON.parse(text);'];
      for (const rel of lib.RECORD_READ_OWN) {
        expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
        expect(kinds(own, rel), rel).toEqual([10, 10]);
        // Every parse of an own reader is counted, whatever function holds it.
        expect(kinds(['async function captureInfo(f: string) { const j = JSON.parse(out); }', 'class I { private async readHistory() { return JSON.parse(line); } }'], rel), rel).toEqual([10, 10]);
      }
      // Anywhere else a parse into a shape of one's own is not seen (said in the title).
      expect(kinds(own, 'packages/engine/src/runs.ts')).toEqual([0, 0]);
      expect(kinds(own, 'packages/engine/src/index-db/index-db.ts')).toEqual([0, 0]);
      // A record type named there is still the other kind.
      expect(kinds(['const r = JSON.parse(text) as RunRecord;'], lib.RECORD_READ_OWN[0])).toEqual([1]);
    });

    it("the search index, the timeline's version matcher and the frame service read renders/ through the one reader only (L7.6c)", () => {
      const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
      /** The names of the functions (declared, methods, or an arrow given to a variable) that hold each JSON.parse of `text`. */
      const parsesIn = (text: string): string[] => {
        const out: string[] = [];
        const re = /JSON\.parse\(/g;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const before = text.slice(0, m.index);
          const fns = [...before.matchAll(/\n(?:export )?(?:async )?function (\w+)\(|\n  (?:private |static )*(?:async )?(\w+)\([^)]*\)[^\n]*\{\n/g)];
          const last = fns[fns.length - 1];
          out.push(last ? (last[1] ?? last[2]) : '(top)');
        }
        return out;
      };
      // The search index: its parses are history.jsonl's lines and the index's history rows; renders/ comes from the reader
      // (the names as renderEntries lists them, each file read under the listing's rules).
      const index = src('packages/engine/src/index-db/index-db.ts');
      expect(parsesIn(index)).toEqual(['readHistory', 'history']);
      expect(index).toMatch(/await renderEntries\(dir, \(name\) => \(names\.push\(name\), false\)\)/);
      expect(index).toMatch(/const entry = await readListedRender\(projectPath\(dir, 'renders'\), name\)/);
      expect(index).toMatch(/renderOfFile\(entry\)/);
      expect(index).not.toMatch(/readSmall\(dir, projectRef\('renders'|readdir\(projectPath\(dir, 'renders'\)\)/);
      // The timeline: it parses nothing itself (ffprobe's output is core's reader's, L7.31); the record of a pin is read
      // under a listing's rules (readListedRender: no link, the listing's cap) and judged by core's rules; renders/ is
      // named in that one call only.
      const timeline = src('packages/engine/src/timeline-view.ts');
      expect(parsesIn(timeline)).toEqual([]);
      expect(timeline).toMatch(/ffprobePackets\(readFfprobeJson\(text\)\)/);
      expect(timeline).toMatch(/readListedRender\(projectPath\(projectDir, 'renders'\), a\.id\)/);
      expect(timeline.match(/'renders'/g)).toHaveLength(1);
      expect(timeline).toMatch(/renderOfFile\(await entry\)/);
      expect(timeline).toMatch(/sameRender\(record, a\)/);
      // The frame service: it parses nothing itself (probeFd's ffprobe output is core's reader's, L7.31); its record comes
      // from renderForWork; core's identity rule.
      const frames = src('packages/engine/src/render-frames.ts');
      expect(parsesIn(frames)).toEqual([]);
      expect(frames).toMatch(/openVideoFromJson\(readFfprobeJson\(out\)\)/);
      expect(frames).not.toMatch(/readFile|readPlainFile|readJson|readRenders?Folder|readListedRender|readNamedRender|readRenderById/);
      expect(frames).toMatch(/await renderForWork\(project, renderId\)/);
      expect(frames.match(/sameRender\(record, \{/g)).toHaveLength(2);
      expect(frames).not.toMatch(/[!=]== record\.created_at|record\.created_at [!=]==|render_created_at [!=]==/);
    });

    it('says what it does not see: an alias, an own interface, an untyped value that reaches a record without a cast', () => {
      expect(
        kinds([
          'type Rec = RunRecord;',
          'const a = JSON.parse(text) as Rec;', // under an alias
          'const b = JSON.parse(text) as { status: string; mode: string; scenario: string };', // an own shape of the same members
          'const c = JSON.parse(text); const d: RunRecord = c;', // `any`, typed a statement later
          'const e = parseFile(file); use(e);', // behind a helper of another name
          'function f(r: RunRecord) {} f(JSON.parse(text));', // handed to a parameter
          'const g: { record: RunRecord } = { record: JSON.parse(text) };', // a property
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('the repository: no record or timeline typed outside the reader; one more is a new entry', () => {
      const scanned = lib.scan(ROOT);
      const today: string[] = lib.ratchetEntries(ROOT, scanned);
      // No record or timeline is typed outside the reader. The own reads — prune's two (a run.json the reader does not
      // take; a linked record file of renders/, L7.6b) and the job's lenient close, each into a shape of its own, as
      // their comments say — are in sight: one entry per file, with its reason in the baseline (L7.6c: the readers of
      // renders/ L7.6b staged are on the one reader, and no entry).
      expect(lib.recordReadHits(ROOT, scanned.files).map((h: ReadHit) => [h.file, h.kinds])).toEqual([
        ['packages/engine/src/jobs/run-job.ts', [10]],
        ['packages/engine/src/prune.ts', [10, 10]],
      ]);
      const OWN = [
        "record-read packages/engine/src/jobs/run-job.ts → 1 own read of a run folder's or renders/'s file",
        "record-read packages/engine/src/prune.ts → 2 own reads of a run folder's or renders/'s file",
      ];
      expect(today.filter((e: string) => e.startsWith('record-read ')).sort()).toEqual(OWN);
      const groups = (JSON.parse(readFileSync(join(ROOT, 'scripts/audit/baseline.json'), 'utf8')) as { groups: Array<{ rule: string; reason: string; entries: string[] }> }).groups.filter(
        (g) => g.rule === 'record-read',
      );
      expect(groups.flatMap((g) => g.entries).sort()).toEqual(OWN.map((e) => e.slice('record-read '.length)));
      for (const g of groups) expect(g.reason.length, g.entries[0]).toBeGreaterThan(80);
      // The parse boundary itself holds the one cast of a parsed timeline (so the check is not vacuous there).
      const home = scanned.files.find((f: { rel: string }) => f.rel === lib.RECORD_READ_HOME[0]);
      expect(lib.recordReadHits(ROOT, [{ ...home, rel: 'packages/core/src/other.ts' }]).map((h: ReadHit) => h.count >= 1)).toEqual([true]);
      const more = lib.compareBaseline([...today, 'record-read packages/engine/src/runs.ts → 1 record typed without the reader'], lib.readBaseline(ROOT));
      expect(more.added).toEqual(['record-read packages/engine/src/runs.ts → 1 record typed without the reader']);
      expect(more.stale).toEqual([]);
      const title = lib.CHECKS.find((c: { id: string }) => c.id === 'record-read')?.title ?? '';
      for (const word of [
        'RECORD_READ_HOME',
        'RECORD_READ_TYPES',
        'RECORD_READ_SCHEMAS',
        'RECORD_READ_OWN',
        'RenderBase',
        'StoredRenderBase',
        'RenderFields',
        'type guard',
        'generic cast helper',
        'Not seen',
        'alias',
        'handed to the reader',
        'without a cast',
        'outside packages/*/src',
        'render record',
        'parseRenderRecord',
        "a member\'s type",
      ])
        expect(title, word).toContain(word);
    });

    it('the shared lenient read and the file seam of the readers are in no index: imported by path by the parse boundaries and the reader of renders/ only (L7.6b)', () => {
      // The root, core's entries (L7.35: the render record is the render context's) and the io side.
      const entries = readdirSync(join(ROOT, 'packages/core/src/entries')).map((f) => [`entries/${f}`, readFileSync(join(ROOT, 'packages/core/src/entries', f), 'utf8')] as const);
      const index = readFileSync(join(ROOT, 'packages/core/src/entries/render.ts'), 'utf8');
      const io = readFileSync(join(ROOT, 'packages/core/src/io/index.ts'), 'utf8');
      for (const [name, text] of [['index.ts', readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8')], ...entries, ['io/index.ts', io]] as const) {
        expect(text, name).not.toMatch(/record-read\.js/);
        expect(text, name).not.toMatch(/record-file\.js/);
      }
      expect(index).toMatch(/export \* from '\.\.\/render-record\.js';/);
      expect(io).toMatch(/export \* from '\.\/render-folder\.js';/);
      const users = lib
        .scan(ROOT)
        .files.filter((f: { rel: string; text: string }) => /from '\.{1,2}\/(io\/)?record-(read|file)\.js'/.test(f.text))
        .map((f: { rel: string }) => f.rel)
        .sort();
      expect(users).toEqual(['packages/core/src/io/render-folder.ts', 'packages/core/src/render-record.ts', 'packages/core/src/run-record.ts']);
    });
  });

  it('fails on a new entry, a stale entry, a group without a reason, and says how to update the baseline', () => {
    const baseline = {
      groups: [
        { rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] },
        { rule: 'R6', reason: '', entries: ['packages/cli/src/commands/a.ts → node:fs'] },
      ],
    };
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
    expect(lib.compareBaseline([], { groups: [{ rule: 'R99', reason: 'x', entries: ['a → b'] }] }).misfiled).toEqual(['R99 a → b']);
  });

  it('rewrites the baseline keeping reasons, dropping stale entries and grouping new ones to explain', () => {
    const baseline = {
      about: 'a',
      groups: [
        { rule: 'R1', reason: 'Loaders.', entries: ['packages/core/src/a.ts → node:fs', 'packages/core/src/gone.ts → node:fs'] },
        { rule: 'R4', reason: 'Gone.', entries: ['packages/cli/src/x.ts → @retake/editor'] },
      ],
    };
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
