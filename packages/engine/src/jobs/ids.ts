/** Job ids: "j_" + a ULID (10 Crockford base32 characters of milliseconds, 16 random), sortable by creation time. */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let last = 0;
let lastRandom: number[] = [];

/** A new job id; ids made in the same millisecond by this process still sort in creation order. */
export function newJobId(now: number = Date.now()): string {
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
  return `j_${time}${rnd.map((n) => CROCKFORD[n]).join('')}`;
}
