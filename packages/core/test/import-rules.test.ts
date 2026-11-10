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
import { HISTORY_FILE, PROJECT_DIRS, STATE_DIR, WORKSPACE_JOURNAL_FILE } from '../src/layout.js';
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
    expect(hits({ 'packages/editor/src/a.ts': ['@retake/engine', '@retake/core'], 'packages/hooks/src/a.ts': ['@retake/cli'] })).toEqual(['R2 packages/editor/src/a.ts → @retake/engine', 'R2 packages/hooks/src/a.ts → @retake/cli']);
    expect(hits({ 'packages/ui/src/server/a.ts': ['@retake/mcp', '@retake/engine'], 'packages/cli/src/a.ts': ['@retake/mcp', '@retake/ui'] })).toEqual(['R3 packages/ui/src/server/a.ts → @retake/mcp']);
    expect(hits({ 'packages/mcp/src/a.ts': ['@retake/editor', '@retake/engine', '@retake/core'] })).toEqual(['R4 packages/mcp/src/a.ts → @retake/editor']);
    expect(hits({ 'packages/mcp/src/tools/a.ts': ['node:fs', 'node:path'], 'packages/mcp/src/a.ts': ['node:fs'], 'packages/cli/src/commands/b.ts': ['child_process'] })).toEqual(['R6 packages/mcp/src/tools/a.ts → node:fs', 'R6 packages/cli/src/commands/b.ts → child_process']);
    expect(hits({ 'packages/editor/src/plan.ts': ['remotion', 'node:fs', './timing.js'], 'packages/review/src/checks.ts': ['react'], 'packages/editor/src/render/a.ts': ['remotion'], 'packages/review/src/pixel-maths.ts': ['node:child_process', './types.js'], 'packages/review/src/pixels.ts': ['node:child_process'] })).toEqual(['R7 packages/editor/src/plan.ts → remotion', 'R7 packages/editor/src/plan.ts → node:fs', 'R7 packages/review/src/checks.ts → react', 'R7 packages/review/src/pixel-maths.ts → node:child_process']);
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
        const fn = (i: number): string => lines.slice(0, i + 1).reverse().map((l) => /\bfunction (\w+)/.exec(l)?.[1]).find(Boolean) ?? `line ${i + 1}`;
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
        'io/index.ts': "export const r = 1;\n",
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
      expect(lib.ruleHits(root, scanned.fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`).sort()).toEqual([
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
      'packages/core/src/ip.ts': { text: "import { BlockList, isIP } from 'node:net';\nimport type { Socket } from 'node:net';\nexport const a = [BlockList, isIP];\n", specs: ['node:net', 'node:net'] },
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
    expect(at(engine, "import type { renderVideo } from '@retake/editor';\nimport { type renderStill, planRun } from '@retake/editor';\ntype F = typeof import('@retake/editor')['renderVideo'];\ninterface Ed { renderVideo(o: O): Promise<R> }")).toEqual([]);
    expect(at(engine, "// the editor's renderVideo\nconst s = 'ed.renderVideo(o)';\nconst seams = { renderVideo: fake };\nawait renderWork(o);\nawait ed.planRun(o);\nawait ed.buildComponentPreview(o);")).toEqual([]);
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
    expect(at(shell, "export type { RenderRecord } from '@retake/editor';\nexport { type RenderVideoOptions, planRun } from '@retake/editor';\nexport * from './local.js';\nexport { renderVideo } from './local.js';")).toEqual([]);
    expect(at(engine, "const a = { ['render' + 'Video']: fake };\nlet b;\nb = { renderStill: fake };\nconst c = [{ exportRender: fake }];")).toEqual([]);
    // The check's limit, on purpose in this test: a key known only at run time names nothing in the text.
    expect(at(engine, 'const f = ed[name];\nconst g = ed[`render${kind}`];')).toEqual([]);
  });

  it("lists every render entry the editor exports: a value whose name says it renders, or makes a renderer, is checked or named here as not one", () => {
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

  it("flags a loader that could load the editor unseen in the engine outside its loader: import() of a computed name, a require made with createRequire and called", () => {
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
    const flagged = hitsOf(files).filter((h) => h.startsWith('R9 ')).map((h) => h.replace(/^R9 packages\/engine\/src\/(.+)\.ts → /, '$1: '));
    expect(flagged.sort()).toEqual(['builtin: getBuiltinModule()', 'computed: import()', 'made-require-inline: createRequire()()', 'made-require-later: createRequire()()', 'made-require: createRequire()()']);
  });

  it("flags a value import of the editor in the engine outside its loader: static, re-export, import(); its types are free", () => {
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
    const flagged = hitsOf(files).filter((h) => h.startsWith('R9 ')).map((h) => h.replace(/^R9 packages\/engine\/src\/(.+)\.ts → @retake\/editor.*$/, '$1'));
    expect(flagged.sort()).toEqual(['dynamic', 'plan-value', 'reexport', 'render/editor-renderer', 'value']);
  });

  it("flags a value import of an adapter in the engine outside its loader: static, re-export, import(); its types and the domain entries are free", () => {
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
    expect(all.filter((h) => h.includes('editor-value') || h.includes('plan-value')).map((h) => h.split(' ')[0]).sort()).toEqual(['R9', 'R9']);
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
    expect(hitsOf({ 'packages/engine/src/computed.ts': { text: "const name = '@retake/' + 'sandbox';\nconst sb = await import(name);\n", specs: [] } })).toEqual(['R9 packages/engine/src/computed.ts → import()']);
    // A file that cannot be read counts as a value import (the check fails closed).
    expect(hits({ 'packages/engine/src/gone.ts': ['@retake/hooks'] }, join(tmpdir(), 'retake-import-rules-none')).filter((h) => h.startsWith('R11 '))).toEqual(['R11 packages/engine/src/gone.ts → @retake/hooks']);
  });

  it('a shell may import a domain entry, not the package behind it', () => {
    expect(lib.DOMAIN_ENTRIES).toEqual(['@retake/components/geometry', '@retake/editor/plan', '@retake/review/checks']);
    const entries = lib.DOMAIN_ENTRIES as string[];
    for (const shell of ['packages/ui/src/server/a.ts', 'packages/mcp/src/tools/a.ts', 'packages/cli/src/commands/a.ts']) {
      const r4 = (text: string, specs: readonly string[]) => hitsOf({ [shell]: { text, specs } }).filter((h) => h.startsWith('R4 ')).map((h) => h.replace(`R4 ${shell} → `, ''));
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
      expect(r4("import { autoFit } from '@retake/components/geometry';\nimport { runChecks } from '@retake/review/checks';\n", ['@retake/components/geometry', '@retake/review/checks']), shell).toEqual(['@retake/components/geometry', '@retake/review/checks']);
      // The package behind an entry stays an adapter import, its types too; a path below an entry is no entry.
      const behind = ['@retake/components', '@retake/review/thumbs', '@retake/components/kit', '@retake/editor', '@retake/review', '@retake/components/geometry/x'];
      expect(r4(behind.map((s, i) => `import type { T${i} } from '${s}';`).join('\n'), behind), shell).toEqual(behind);
      // A file that cannot be read counts as a value import (the check fails closed).
      expect(hits({ [shell]: [...entries] }, join(tmpdir(), 'retake-import-rules-none')).filter((h) => h.startsWith('R4 '))).toEqual(entries.map((s) => `R4 ${shell} → ${s}`));
    }
    // The rule says for which specifiers types are free: the domain entries, nothing else.
    const rule = (lib.RULES as { id: string; typeOnlyCheck?: unknown }[]).find((r) => r.id === 'R4')!;
    expect(typeof rule.typeOnlyCheck).toBe('function');
    const typesFree = rule.typeOnlyCheck as (s: string) => boolean;
    expect(['@retake/components/geometry', '@retake/editor/plan', '@retake/review/checks', '@retake/components', '@retake/review/thumbs', '@retake/editor', '@retake/sandbox'].filter((s) => typesFree(s))).toEqual(entries);
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
    expect(pure).toEqual(['checks-entry', 'checks', 'pixel-checks', 'pixel-maths', 'spans', 'timeline', 'anchor', 'diff', 'types']);
    const files = Object.fromEntries([
      ...pure.map((n) => [`packages/review/src/${n}.ts`, { text: "import type { ComponentRegistry } from '@retake/components';\nimport { fitText } from '@retake/components/geometry';\n", specs: ['@retake/components', '@retake/components/geometry', '@retake/core', '@retake/editor/plan'] }] as const),
      ['packages/review/src/a/checks.ts', { text: "import { fitText } from '@retake/components/kit';\n", specs: ['@retake/components/kit'] }] as const,
      // The I/O side of the review may: it is not what the entry reaches.
      ['packages/review/src/review.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
      ['packages/review/src/pixels.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
      ['packages/editor/src/checks.ts', { text: "import { loadRegistry } from '@retake/components';\n", specs: ['@retake/components'] }] as const,
    ]);
    expect(hitsOf(files).filter((h) => h.startsWith('R12 ')).sort()).toEqual(pure.map((n) => `R12 packages/review/src/${n}.ts → @retake/components`).sort());
    expect(hits({ 'packages/review/src/types.ts': ['@retake/components/kit', '@retake/components/geometry/x'] }).filter((h) => h.startsWith('R12 '))).toEqual(['R12 packages/review/src/types.ts → @retake/components/kit', 'R12 packages/review/src/types.ts → @retake/components/geometry/x']);
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
    for (const text of ['const { queue, files: jobFiles } = queueOf(root, cli);', '{ queue, client, scope, files: ctx.files }', 'queueOf: (root) => { queue: JobQueue; files: JobFiles }']) expect(text).not.toMatch(READS_FILES);
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
      return lib.ruleHits(root, lib.scan(root).fileImports).map((h: Hit) => `${h.rule} ${h.file} → ${h.spec}`).sort();
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
    const mixed = "import { a } from './a.js';\nimport type { B } from './b.js';\nexport * as c from './c.js';\nexport * from './d.js';\nconst e = await import('./e.js');\nlet f: typeof import('./f.js');\nimport g = require('./g.js');\nexport * as a2 from './a.js';\nexport type * as h from './h.js';\n";
    expect([...lib.specifiersOf(ts, 'a.ts', mixed)].sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js', './g.js', './h.js']);
    expect(lib.declaredSpecifiers(ts, 'a.ts', mixed)).toEqual(['./a.js', './b.js', './c.js', './d.js', './g.js', './a.js', './h.js']);
    expect(scannedHits({
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
    })).toEqual([
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
    expect([...uses.values].sort()).toEqual(['@retake/editor', '@retake/review']);
    // What `statics` reads, on the forms: a declaration is static, a call is not, a type loads nothing.
    const staticsOf = (text: string): string[] => [...(lib.moduleUses(ts, loader, text) as { statics: Set<string> }).statics];
    for (const text of ["export * from '@retake/sandbox';", "export * as sb from '@retake/sandbox';", "export { pidAlive } from '@retake/sandbox';", "import { pidAlive } from '@retake/sandbox';", "import '@retake/sandbox';", "import sb = require('@retake/sandbox');", "import { type S, pidAlive } from '@retake/sandbox';"]) expect(staticsOf(text), text).toEqual(['@retake/sandbox']);
    for (const text of ["export const sandbox = () => import('@retake/sandbox');", "import type { S } from '@retake/sandbox';", "export type { S } from '@retake/sandbox';", "let s: typeof import('@retake/sandbox');", "const sb = require('@retake/sandbox');"]) expect(staticsOf(text), text).toEqual([]);
  });

  it('every package is in exactly one layer; a relative import never leaves its package; a .cts source is read like the others', () => {
    // A new folder of packages/ belongs to no list until someone decides its layer: the rules would not read it.
    const dirs = readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory()).sort();
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
    expect(scannedHits({
      'packages/engine/src/jobs/a.ts': "import { pidAlive } from '../../../sandbox/dist/index.js';\nimport type { S } from '../../../sandbox/src/index.js';\nexport * as hooks from '../../../hooks/src/index.js';\nconst rw = await import('../../../runner-web/dist/index.js');\nimport { b } from '../b.js';\nimport pkg from '../../package.json';\nimport { c } from './c.js';\n",
      'packages/cli/src/a.ts': "import { s } from '../../../scripts/audit/lib.mjs';\nimport { e } from '../../engine/src/index.js';\nimport { self } from '../../cli/src/b.js';\nimport { near } from '../../cli-tools/x.js';\n",
      'packages/core/src/a.cts': "import fs = require('node:fs');\nimport up = require('../../hooks/src/x.js');\n",
      'packages/core/src/types.d.cts': "import fs = require('node:fs');\n",
    })).toEqual([
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

  it('flags a module-level let / var of core, the engine or an adapter that holds the policy work runs under, and nothing else', () => {
    // The state the process-wide setters held before WorkPolicy, by name or by type.
    expect(wiring('packages/core/src/agent-policy.ts', 'let agentFolders: string[] | null = null;')).toEqual(['policy-state packages/core/src/agent-policy.ts → let agentFolders']);
    expect(wiring('packages/core/src/io/bundle.ts', 'export let workspaceFfmpeg: string | undefined;\nlet programCheck = null;')).toEqual(['policy-state packages/core/src/io/bundle.ts → let workspaceFfmpeg', 'policy-state packages/core/src/io/bundle.ts → let programCheck']);
    expect(wiring('packages/editor/src/render/policy.ts', "import type { RenderSettings } from '@retake/core';\nvar current: RenderSettings | undefined;")).toEqual(['policy-state packages/editor/src/render/policy.ts → let current']);
    expect(wiring('packages/runner-web/src/launch.ts', "let { a, b: [held] } = { a: 1, b: [PERSON_POLICY as WorkPolicy] };")).toEqual(['policy-state packages/runner-web/src/launch.ts → let a', 'policy-state packages/runner-web/src/launch.ts → let held']);
    expect(wiring('packages/engine/src/workspace.ts', 'let opened = workPolicy(ws, { agent: true }) as WorkPolicy;')).toEqual(['policy-state packages/engine/src/workspace.ts → let opened']);
    // A value is not state: a const, a parameter, a local variable, a class field; another package's let (the shells: not checked).
    expect(wiring('packages/core/src/a.ts', "const PERSON: WorkPolicy = Object.freeze({ agentFolders: null });\nexport function f(policy: WorkPolicy) {\n  let ffmpeg = policy.ffmpeg;\n  return ffmpeg;\n}\nclass C { policy: WorkPolicy | null = null }")).toEqual([]);
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
      expect(seam(KIT, "export { AbsoluteFill } from 'remotion';\nexport { Lottie } from '@remotion/lottie';\nimport { renderMedia } from '@remotion/renderer';")).toEqual([`R10 ${KIT} → @remotion/renderer`]);
      expect(seam(LIBRARY, "export const a = () => import('@remotion/renderer');\nexport const b = () => import('@remotion/bundler');\nimport { Img } from 'remotion';")).toEqual([`R10 ${LIBRARY} → remotion`]);
      expect(seam('packages/ui/src/player/frame-main.tsx', "import { Player } from '@remotion/player';\nimport type { PlayerRef } from '@remotion/player';\nimport { Img } from 'remotion';")).toEqual(['R10 packages/ui/src/player/frame-main.tsx → remotion']);
    });

    it('7. a seam file re-exported wholesale by a file that is no seam', () => {
      const index = 'packages/components/src/kit/index.ts';
      expect(seam(index, "export * from './renderer.js';")).toEqual([`R10 ${index} → export * from ${KIT}`]);
      expect(seam(index, "export * as r from './renderer.js';")).toEqual([`R10 ${index} → export * from ${KIT}`]);
      expect(seam('packages/editor/src/render/index.ts', "export * from './library.js';")).toEqual([`R10 packages/editor/src/render/index.ts → export * from ${LIBRARY}`]);
      expect(seam('packages/editor/src/remotion/all.ts', "export * from './host.js';")).toEqual([`R10 packages/editor/src/remotion/all.ts → export * from ${HOST}`]);
      // The specifier's extension is the compiled one or the source's: the same file.
      expect(seam('packages/ui/src/player/boot.ts', "export * from './frame-main.jsx';")).toEqual(['R10 packages/ui/src/player/boot.ts → export * from packages/ui/src/player/frame-main.tsx']);
      expect(seam('packages/ui/src/player/boot.ts', "export * from './frame-main.tsx';\nexport * from './frame-main';")).toEqual(['R10 packages/ui/src/player/boot.ts → export * from packages/ui/src/player/frame-main.tsx']);
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
      expect(seam(EDITOR, "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const p = req.resolve('@remotion/player/package.json');")).toEqual([`R10 ${EDITOR} → resolve(@remotion/player/package.json)`]);
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
      expect(seam('packages/components/library/studio/card-x/index.tsx', "import { Loop } from '../../../src/kit/renderer.js';")).toEqual([`R10 packages/components/library/studio/card-x/index.tsx → seam ${KIT}`]);
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
      expect(seam('packages/components/library/studio/card-x/part.jsx', "import { Img } from 'remotion';\nexport const A = () => <Img src=\"a.png\" />;")).toEqual(['R10 packages/components/library/studio/card-x/part.jsx → remotion']);
      expect(seam('packages/editor/src/render/a.d.ts', "import type { Codec } from '@remotion/renderer';\nexport declare const c: Codec;")).toEqual(['R10 packages/editor/src/render/a.d.ts → @remotion/renderer']);
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
      expect(seam(EDITOR, "const name = 'remotion';\nexport const a = () => import(name);\nexport const ALLOWED = ['react', 'remotion'];\nexport const entry = \"import { registerRoot } from 'remotion';\";\nexport const v = (n: string) => require.resolve(`${n}/package.json`);\n// import x from 'remotion'")).toEqual([]);
      // Nor a require under another name, a module declaration, or a name put together.
      expect(seam(EDITOR, "import { createRequire as cr } from 'node:module';\nexport const a = cr(import.meta.url)('remotion');\nconst { resolve } = require;\nexport const b = resolve('remotion');\nexport const c = () => import('remo' + 'tion');")).toEqual([]);
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
      // Anywhere, not only as a path argument: a state folder, a layout file, a folder and a slash, a template part.
      "export const JOURNALS_DIR = '.retake/journals';", // 10
      "for (const part of ['.retake', sub]) dir = mine(dir, part);", // 11
      "const ref = `scenarios/${name}.yaml`;", // 12
      'const folder = `${root}/.retake/records/${id}`;', // 13
      "const file = mine(stateDir(root), 'history.jsonl');", // 14
      "throw new Error(`renders/${id}.json is not a record`);", // 15
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
    expect([...lib.LAYOUT_FILES].sort()).toEqual([HISTORY_FILE, WORKSPACE_JOURNAL_FILE].sort());
    // A ratchet entry per file, with its count: one more path in a file is a new entry (and its old count a stale one).
    const entries = lib.ratchetEntries(ROOT).filter((e: string) => e.startsWith('layout '));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^layout packages\/[\w-]+\/src\/\S+ → \d+ hand-written layout paths?$/);
    // The engine, the hooks and the sandbox spell no layout path by hand any more (only messages of the catalogue).
    expect(entries.filter((e: string) => /packages\/(hooks|sandbox|runner-web|cli)\//.test(e) || (/packages\/engine\//.test(e) && !e.includes('catalogue.ts')))).toEqual([]);
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
    expect(lib.compareBaseline([], { groups: [{ rule: 'R99', reason: 'x', entries: ['a → b'] }] }).misfiled).toEqual(['R99 a → b']);
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
