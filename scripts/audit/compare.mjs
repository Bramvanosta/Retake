#!/usr/bin/env node
// Compare two audit summaries (`snapshot.mjs`'s summary.json): every number that changed, with its delta, and every
// list that gained or lost an entry (a package's @retake dependencies). Exit 0 always: it reports, it does not judge.
// Usage: node scripts/audit/compare.mjs <older summary.json> <newer summary.json>
import fs from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
if (!a || !b) {
  console.error('usage: node scripts/audit/compare.mjs <older summary.json> <newer summary.json>');
  process.exit(2);
}
console.log(`${a.date} (${a.commit?.slice(0, 7)}) → ${b.date} (${b.commit?.slice(0, 7)})`);
const walk = (x, y, at) => {
  if (Array.isArray(x) || Array.isArray(y)) {
    const xs = new Set(x ?? []);
    const ys = new Set(y ?? []);
    const added = [...ys].filter((v) => !xs.has(v));
    const removed = [...xs].filter((v) => !ys.has(v));
    if (added.length || removed.length)
      console.log(
        `${at}: ${added
          .map((v) => `+${v}`)
          .concat(removed.map((v) => `-${v}`))
          .join(' ')}`,
      );
    return;
  }
  if (typeof x === 'number' || typeof y === 'number') {
    if (x !== y) console.log(`${at}: ${x ?? '–'} → ${y ?? '–'}${typeof x === 'number' && typeof y === 'number' ? ` (${y - x > 0 ? '+' : ''}${y - x})` : ''}`);
    return;
  }
  if ((x && typeof x === 'object') || (y && typeof y === 'object')) {
    for (const k of new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])) walk(x?.[k], y?.[k], at ? `${at}.${k}` : k);
  }
};
walk({ ...a, commit: undefined, date: undefined }, { ...b, commit: undefined, date: undefined }, '');
