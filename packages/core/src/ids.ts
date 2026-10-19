/**
 * ULIDs: 10 Crockford base32 characters of milliseconds, then 16 random ones (80 bits): unique across machines and
 * sortable by creation time. The ids of jobs (`j_`, engine newJobId), previews, inspections, sites, recordings and
 * frame comment threads and entries (`c_` / `r_`, comments.ts) are a prefix + one.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let last = 0;
let lastRandom: number[] = [];

/** A new ULID; ULIDs made in the same millisecond by this process still sort in creation order (monotonic). */
export function ulid(now: number = Date.now()): string {
  let t = Math.max(now, last);
  let rnd: number[];
  if (t === last && lastRandom.length) {
    // Same millisecond: increment the random part (monotonic ULID).
    rnd = [...lastRandom];
    let i = rnd.length - 1;
    while (i >= 0 && rnd[i] === 31) rnd[i--] = 0;
    if (i < 0) {
      t += 1;
      rnd = [...randomBytes(16)].map((b) => b & 31);
    } else rnd[i]++;
  } else {
    rnd = [...randomBytes(16)].map((b) => b & 31);
  }
  last = t;
  lastRandom = rnd;
  let time = '';
  for (let i = 9, v = t; i >= 0; i--, v = Math.floor(v / 32)) time = CROCKFORD[v % 32] + time;
  return `${time}${rnd.map((n) => CROCKFORD[n]).join('')}`;
}
