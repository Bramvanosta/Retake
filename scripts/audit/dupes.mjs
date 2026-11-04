// Duplicate-block finder (read-only), a small jscpd stand-in.
// Usage: node scripts/audit/dupes.mjs <repo-root> [--window 8] [--cross-only] [--top 30] [--json out.json]
// Lines are normalised (trimmed, whitespace collapsed; comment-only, blank, import and lone-brace lines dropped),
// a rolling window of N consecutive kept lines is hashed, matching windows are merged into maximal blocks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] ?? '.');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > 0 ? process.argv[i + 1] : undefined; })();
const W = arg('--window', 8); const TOP = arg('--top', 30); const CROSS = process.argv.includes('--cross-only');
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
};
const files = fs.readdirSync(path.join(root, 'packages')).flatMap((p) => walk(path.join(root, 'packages', p, 'src')));
const norm = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8').split('\n');
  const kept = [];
  let inBlock = false;
  raw.forEach((l, i) => {
    let s = l.trim();
    if (inBlock) { if (s.includes('*/')) inBlock = false; return; }
    if (s.startsWith('/*')) { if (!s.includes('*/')) inBlock = true; return; }
    if (s.startsWith('//') || s.startsWith('*')) return;
    s = s.replace(/\s+/g, ' ');
    if (!s || /^[{}()\[\];,]+$/.test(s) || s.startsWith('import ') || s.startsWith('export {') || s.startsWith('} from')) return;
    if (s.length < 4) return;
    kept.push({ s, line: i + 1 });
  });
  norm.push({ f: path.relative(root, f), pkg: path.relative(root, f).split('/')[1], kept });
}
const idx = new Map();
for (const [fi, n] of norm.entries()) {
  for (let i = 0; i + W <= n.kept.length; i++) {
    const h = crypto.createHash('sha1').update(n.kept.slice(i, i + W).map((x) => x.s).join('\n')).digest('hex');
    (idx.get(h) ?? idx.set(h, []).get(h)).push([fi, i]);
  }
}
// merge: for each pair of files, collect matching window starts and extend into blocks
const pairs = new Map();
for (const occ of idx.values()) {
  if (occ.length < 2 || occ.length > 12) continue; // >12: boilerplate
  for (let a = 0; a < occ.length; a++) for (let b = a + 1; b < occ.length; b++) {
    const [fa, ia] = occ[a]; const [fb, ib] = occ[b];
    if (fa === fb && Math.abs(ia - ib) < W) continue;
    const key = `${fa}|${fb}`;
    (pairs.get(key) ?? pairs.set(key, []).get(key)).push([ia, ib]);
  }
}
const blocks = [];
for (const [key, list] of pairs) {
  const [fa, fb] = key.split('|').map(Number);
  list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = null;
  for (const [ia, ib] of list) {
    if (cur && ia === cur.ea + 1 && ib === cur.eb + 1) { cur.ea = ia; cur.eb = ib; continue; }
    if (cur) blocks.push(cur);
    cur = { fa, fb, sa: ia, sb: ib, ea: ia, eb: ib };
  }
  if (cur) blocks.push(cur);
}
const out = blocks.map((b) => {
  const A = norm[b.fa]; const B = norm[b.fb];
  const len = b.ea - b.sa + W;
  return { len, cross: A.pkg !== B.pkg, a: `${A.f}:${A.kept[b.sa].line}-${A.kept[b.ea + W - 1].line}`, b: `${B.f}:${B.kept[b.sb].line}-${B.kept[b.eb + W - 1].line}`, sample: A.kept[b.sa].s.slice(0, 90) };
}).filter((x) => !CROSS || x.cross).sort((x, y) => y.len - x.len);
const total = out.reduce((a, b) => a + b.len, 0);
console.log(`# duplicate blocks (window ${W} normalised lines): ${out.length}, ${total} duplicated lines; cross-package: ${out.filter((x) => x.cross).length} blocks, ${out.filter((x) => x.cross).reduce((a, b) => a + b.len, 0)} lines`);
const pkgPairs = {};
for (const x of out.filter((x) => x.cross)) { const k = [x.a.split('/')[1], x.b.split('/')[1]].sort().join('<->'); pkgPairs[k] = (pkgPairs[k] ?? 0) + x.len; }
console.log('cross-package duplicated lines by pair:', JSON.stringify(Object.fromEntries(Object.entries(pkgPairs).sort((a, b) => b[1] - a[1]))));
for (const x of out.slice(0, TOP)) console.log(`${String(x.len).padStart(4)} ${x.cross ? 'X' : ' '} ${x.a}  ==  ${x.b}   | ${x.sample}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ window: W, blocks: out.length, lines: total, crossBlocks: out.filter((x) => x.cross).length, crossLines: out.filter((x) => x.cross).reduce((a, b) => a + b.len, 0), crossByPair: pkgPairs, top: out.slice(0, TOP) }, null, 1) + '\n');
