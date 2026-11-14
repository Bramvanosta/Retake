#!/usr/bin/env node
/**
 * Line coverage on demand, with no coverage dependency: `node scripts/coverage.mjs [vitest arguments]` runs vitest (the
 * files given, else the whole suite) with
 *   - scripts/coverage-setup.mjs in every test worker (V8's precise coverage through the inspector, written when the
 *     file ends: vitest's forks are killed, so NODE_V8_COVERAGE never writes theirs), and
 *   - NODE_V8_COVERAGE for the processes the tests start (the CLI, MCP servers, job workers: packages/<name>/dist),
 * then maps every covered byte range back to the TypeScript lines of packages/<name>/src through the source maps (the
 * inline maps of vitest's transform, the .js.map files of dist/) with @jridgewell/trace-mapping, which vitest already
 * brings. A line counts when it carries a mapping; comment lines and lone closing brackets are left out; a source file
 * no test loaded counts all its code lines as uncovered. Raw files are merged while the tests run and then deleted.
 *
 * Blind spots: code that runs in a browser (the Studio's app, the capture kit, the page scripts, the Remotion
 * compositions) is not measured; a child process killed by a signal writes nothing; gated tests count only when their
 * variable is set.
 *
 *   node scripts/coverage.mjs                                   # the whole suite (about 35 min), then the table
 *   node scripts/coverage.mjs packages/review/test              # some files
 *   node scripts/coverage.mjs --files 'engine/src/operations' -- packages/engine/test   # the least covered files too
 *   node scripts/coverage.mjs --json coverage.json -- …          # every file's covered and uncovered lines, as JSON
 *   node scripts/coverage.mjs --report <state.json> [--files <re>]   # the table again from a kept state, no run
 * Nothing is left behind: the raw files and the work folder are removed after the report; --state <file> keeps the
 * merged counts (per file, line → covered) for --report.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @jridgewell/trace-mapping from vitest's own dependencies (no dependency of ours). */
function traceMapping() {
  const fromVitest = createRequire(createRequire(join(ROOT, 'package.json')).resolve('vitest/package.json'));
  for (const r of [fromVitest, createRequire(fromVitest.resolve('vite-node/package.json'))]) {
    try {
      return r('@jridgewell/trace-mapping');
    } catch {
      // Next place.
    }
  }
  throw new Error('coverage: @jridgewell/trace-mapping not found next to vitest (run pnpm install)');
}

/** The `root`-relative path of an absolute one under `root`, else null. */
const relTo = (root, p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null);
const SOURCE = /^(packages|apps)\/[^/]+\/src\//;
const RUNTIME = /^(packages|apps)\/[^/]+\/(src|dist)\//;

/**
 * The merger: raw V8 coverage files (the setup's and NODE_V8_COVERAGE's) into `state.files[<src path>][<line>] = 0 | 1`.
 */
export function createMerger(state, rawDir, root = ROOT) {
  const { TraceMap, eachMapping } = traceMapping();
  const rel = (p) => relTo(root, p);
  const maps = new Map();
  const prepared = (key, code, mapJson, base) => {
    if (maps.has(key)) return maps.get(key);
    let out = null;
    try {
      const tm = new TraceMap(mapJson);
      const lineStarts = [0];
      for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
      const segs = [];
      eachMapping(tm, (m) => {
        if (m.source == null || m.originalLine == null) return;
        let src = m.source.startsWith('file://') ? fileURLToPath(m.source) : m.source;
        src = src.startsWith('/') ? src : resolve(base, src);
        const r = rel(src);
        if (!r || r.includes('node_modules') || !SOURCE.test(r)) return;
        segs.push([(lineStarts[m.generatedLine - 1] ?? 0) + m.generatedColumn, r, m.originalLine]);
      });
      out = { len: code.length, segs };
    } catch {
      out = null;
    }
    if (maps.size > 400) maps.clear();
    maps.set(key, out);
    return out;
  };
  const inlineMap = (code) => {
    const m = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/m.exec(code);
    return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
  };
  const apply = (script, prep) => {
    const covered = new Uint8Array(prep.len + 1);
    const ranges = script.functions.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) covered.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(prep.len, r.endOffset));
    for (const [off, file, line] of prep.segs) {
      const f = (state.files[file] ??= {});
      if (covered[off]) f[line] = 1;
      else if (f[line] === undefined) f[line] = 0;
    }
  };
  const merge = (file) => {
    let j;
    try {
      j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
    for (const s of j.result ?? []) {
      const p = s.url.startsWith('file://') ? fileURLToPath(s.url) : s.url;
      const r = rel(p);
      if (!r || r.includes('node_modules') || !RUNTIME.test(r)) continue;
      let prep = null;
      if (s.src) {
        const sp = join(rawDir, 'src', `${s.src}.js`);
        if (maps.has(s.src)) prep = maps.get(s.src);
        else if (existsSync(sp)) {
          const code = readFileSync(sp, 'utf8');
          const mj = inlineMap(code);
          prep = mj ? prepared(s.src, code, mj, dirname(p)) : (maps.set(s.src, null), null);
        }
      } else if (/\/dist\//.test(r) && p.endsWith('.js')) {
        const key = `dist:${p}`;
        if (maps.has(key)) prep = maps.get(key);
        else if (existsSync(p) && existsSync(`${p}.map`)) prep = prepared(key, readFileSync(p, 'utf8'), JSON.parse(readFileSync(`${p}.map`, 'utf8')), dirname(p));
        else maps.set(key, null);
      }
      if (prep) apply(s, prep);
    }
    return true;
  };
  /** Merges (and deletes) the raw files; `all`: also the ones written in the last seconds. */
  return (all) => {
    const dirs = [rawDir, join(rawDir, 'children')];
    for (const d of dirs) {
      let names = [];
      try {
        names = readdirSync(d).filter((n) => n.endsWith('.json'));
      } catch {
        continue;
      }
      for (const n of names) {
        const p = join(d, n);
        try {
          if (!all && Date.now() - statSync(p).mtimeMs < 5000) continue;
        } catch {
          continue;
        }
        if (merge(p)) unlinkSync(p);
      }
    }
  };
}

/** Per package and per file: lines with a mapping, covered ones; a source file never loaded counts its code lines. */
export function summarise(state, root = ROOT) {
  const sources = execFileSync('git', ['ls-files', 'packages/*/src/**'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('packages/test-support/'));
  const codeLines = (lines) => lines.filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*\*?)/.test(l) && !/^\s*(import|export \{|export type|export \*)/.test(l)).length;
  const packages = {};
  const files = [];
  for (const f of sources) {
    const lines = readFileSync(join(root, f), 'utf8').split('\n');
    const seen = state.files[f];
    let total;
    let covered = 0;
    const uncovered = [];
    if (seen) {
      const kept = Object.entries(seen).filter(([k]) => {
        const t = (lines[Number(k) - 1] ?? '').trim();
        return t && !/^(\/\/|\*|\/\*)/.test(t) && !/^[}\])]+[;,)]*$/.test(t);
      });
      total = kept.length;
      for (const [k, v] of kept) {
        if (v) covered++;
        else uncovered.push(Number(k));
      }
    } else total = codeLines(lines);
    const pkg = f.split('/')[1];
    const e = (packages[pkg] ??= { files: 0, never: 0, lines: 0, covered: 0 });
    e.files++;
    if (!seen) e.never++;
    e.lines += total;
    e.covered += covered;
    files.push({ file: f, lines: total, covered, never: !seen, uncovered: uncovered.sort((a, b) => a - b) });
  }
  return { packages, files };
}

const pct = (c, n) => (n ? `${((100 * c) / n).toFixed(1)} %` : '—');

export function report(summary, filesRe) {
  const out = ['package        lines    covered   files (never loaded)'];
  let lines = 0;
  let covered = 0;
  for (const [p, e] of Object.entries(summary.packages).sort()) {
    lines += e.lines;
    covered += e.covered;
    out.push(`${p.padEnd(14)} ${String(e.lines).padStart(6)}  ${pct(e.covered, e.lines).padStart(8)}   ${e.files} (${e.never})`);
  }
  out.push(`${'all'.padEnd(14)} ${String(lines).padStart(6)}  ${pct(covered, lines).padStart(8)}`);
  if (filesRe) {
    const re = new RegExp(filesRe);
    out.push('', 'least covered first:');
    for (const f of summary.files.filter((x) => re.test(x.file)).sort((a, b) => a.covered / (a.lines || 1) - b.covered / (b.lines || 1) || b.lines - b.covered - (a.lines - a.covered))) {
      out.push(`${pct(f.covered, f.lines).padStart(8)}  ${f.covered}/${f.lines}  ${f.never ? 'never loaded  ' : ''}${f.file}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const take = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const filesRe = take('--files');
  const json = take('--json');
  const reportOnly = take('--report');
  const stateFile = take('--state');
  const vitestArgs = argv.filter((a) => a !== '--');
  if (reportOnly) {
    console.log(report(summarise(JSON.parse(readFileSync(reportOnly, 'utf8'))), filesRe));
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'retake-coverage-'));
  const rawDir = join(work, 'raw');
  mkdirSync(join(rawDir, 'children'), { recursive: true });
  const state = { files: {} };
  const pass = createMerger(state, rawDir);
  const timer = setInterval(() => pass(false), 10_000);
  const vitest = createRequire(join(ROOT, 'package.json')).resolve('vitest/vitest.mjs');
  const env = { ...process.env, RETAKE_COVERAGE_RAW: rawDir, NODE_V8_COVERAGE: join(rawDir, 'children') };
  const t0 = Date.now();
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [vitest, 'run', ...vitestArgs], { cwd: ROOT, env, stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0)));
  });
  clearInterval(timer);
  pass(true);
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
  rmSync(work, { recursive: true, force: true });
  const summary = summarise(state);
  console.log(`\ncoverage (${Math.round((Date.now() - t0) / 1000)} s; tests exited ${code}):\n${report(summary, filesRe)}`);
  if (json) writeFileSync(json, `${JSON.stringify(summary.files, null, 1)}\n`);
  if (stateFile || json) console.log(`\n${[stateFile && `state: ${stateFile}`, json && `per file: ${json}`].filter(Boolean).join('; ')}`);
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
