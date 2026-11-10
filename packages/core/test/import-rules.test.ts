/**
 * The import-rules ratchet: the layer rules of docs/audit/target-architecture.md (R1–R9), file cycles, who builds the
 * file job queue, and no module-level variable holding the work's policy, held to the committed baseline
 * (scripts/audit/baseline.json).
 * A new violation fails, and so does a stale baseline entry (the count only goes down, in the commit that lowers it).
 * The rules are scripts/audit/lib.mjs, shared with the audit scripts (rules.mjs, imports.mjs).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HISTORY_FILE, PROJECT_DIRS, STATE_DIR, WORKSPACE_JOURNAL_FILE } from '../src/layout.js';
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
