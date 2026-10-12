/**
 * Two small Lottie (bodymovin JSON) animations for the fixture (L2.12), written by hand — like the output of any Lottie
 * tool: a coffee cup with rising steam (a card) and a check badge (an overlay). Their colours are three "source"
 * colours that a scenario maps to theme colours with studio/lottie's `colors` param:
 *   #ff5a1f (the cup, the badge) → accent · #2b2b33 (coffee, saucer) → text · #f2c14e (steam) → muted
 */

const ORANGE = [1, 0x5a / 255, 0x1f / 255, 1];
const DARK = [0x2b / 255, 0x2b / 255, 0x33 / 255, 1];
const GOLD = [0xf2 / 255, 0xc1 / 255, 0x4e / 255, 1];
const WHITE = [1, 1, 1, 1];

const still = (k) => ({ a: 0, k });
/** An animated property from [frame, value] keys (ease in-out between keys). */
const anim = (keys) => ({
  a: 1,
  k: keys.map(([t, v], i) => {
    const s = Array.isArray(v) ? v : [v];
    if (i === keys.length - 1) return { t, s };
    const n = s.length;
    return { t, s, o: { x: Array(n).fill(0.33), y: Array(n).fill(0) }, i: { x: Array(n).fill(0.67), y: Array(n).fill(1) } };
  }),
});

const transform = (o = {}) => ({
  ty: 'tr',
  p: o.p ?? still([0, 0]),
  a: o.a ?? still([0, 0]),
  s: o.s ?? still([100, 100]),
  r: o.r ?? still(0),
  o: o.o ?? still(100),
  sk: still(0),
  sa: still(0),
  nm: 'Transform',
});
const group = (nm, items, tr) => ({ ty: 'gr', nm, it: [...items, transform(tr)] });
const fill = (c) => ({ ty: 'fl', c: still(c), o: still(100), r: 1, nm: 'Fill' });
const stroke = (c, w) => ({ ty: 'st', c: still(c), o: still(100), w: still(w), lc: 2, lj: 2, nm: 'Stroke' });
const ellipse = (w, h, x = 0, y = 0) => ({ ty: 'el', d: 1, s: still([w, h]), p: still([x, y]), nm: 'Ellipse' });
const rect = (w, h, r, x = 0, y = 0) => ({ ty: 'rc', d: 1, s: still([w, h]), p: still([x, y]), r: still(r), nm: 'Rect' });
/** An open path through vertices with in / out tangents. */
const path = (v, i, o, closed = false) => ({ ty: 'sh', ks: still({ i, o, v, c: closed }), nm: 'Path' });
const trim = (s, e) => ({ ty: 'tm', s, e, o: still(0), m: 1, nm: 'Trim' });

const layer = (ind, nm, shapes, ks, ip, op) => ({
  ddd: 0,
  ind,
  ty: 4,
  nm,
  sr: 1,
  ks: { o: ks.o ?? still(100), r: still(0), p: ks.p ?? still([0, 0, 0]), a: ks.a ?? still([0, 0, 0]), s: ks.s ?? still([100, 100, 100]) },
  ao: 0,
  shapes,
  ip,
  op,
  st: 0,
  bm: 0,
});

/** A coffee cup on its saucer (pops in), three wisps of steam drawn up and away, staggered. 600 × 500, 30 fps, 3.2 s. */
export function cupSteam() {
  const op = 96;
  const cup = layer(
    1,
    'cup',
    [
      // Drawing order: the first item is on top (the coffee over the cup's rim, the saucer over its foot).
      group('coffee', [ellipse(196, 30), fill(DARK)], { p: still([0, -84]) }),
      group('saucer', [ellipse(360, 44), fill(DARK)], { p: still([0, 92]) }),
      group('handle', [ellipse(84, 96), stroke(ORANGE, 20)], { p: still([118, -4]) }),
      group('body', [rect(232, 186, 46), fill(ORANGE)], { p: still([0, -4]) }),
    ],
    {
      p: still([300, 350, 0]),
      s: anim([
        [0, [70, 70, 100]],
        [10, [104, 104, 100]],
        [16, [100, 100, 100]],
      ]),
      o: anim([
        [0, 0],
        [8, 100],
      ]),
    },
    0,
    op,
  );
  // A wisp: an S-curve 170 px tall, drawn from the bottom up (end of the trim), then erased (its start), rising.
  const wisp = (ind, x, start) =>
    layer(
      ind,
      `steam ${ind - 1}`,
      [
        group(
          'wisp',
          [
            path(
              [
                [0, 0],
                [18, -60],
                [-14, -118],
                [8, -170],
              ],
              [
                [0, 0],
                [0, 22],
                [0, 22],
                [-6, 14],
              ],
              [
                [0, -22],
                [0, -22],
                [0, -22],
                [0, 0],
              ],
            ),
            stroke(GOLD, 12),
            trim(
              anim([
                [start + 26, 0],
                [start + 54, 100],
              ]),
              anim([
                [start, 0],
                [start + 28, 100],
              ]),
            ),
          ],
          {},
        ),
      ],
      {
        p: anim([
          [start, [x, 236, 0]],
          [start + 54, [x, 196, 0]],
        ]),
      },
      0,
      op,
    );
  return {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op,
    w: 600,
    h: 500,
    nm: 'cup-steam',
    ddd: 0,
    assets: [],
    layers: [wisp(2, 252, 10), wisp(3, 300, 24), wisp(4, 348, 38), cup],
  };
}

/** A check badge: a disc pops in, a check mark draws itself, holds, then the badge fades. 240 × 240, 30 fps, 2 s. */
export function checkBadge() {
  const op = 60;
  const badge = layer(
    2,
    'disc',
    [group('disc', [ellipse(196, 196), fill(ORANGE)], {})],
    {
      p: still([120, 120, 0]),
      s: anim([
        [0, [0, 0, 100]],
        [9, [112, 112, 100]],
        [15, [100, 100, 100]],
      ]),
      o: anim([
        [48, 100],
        [59, 0],
      ]),
    },
    0,
    op,
  );
  const check = layer(
    1,
    'check',
    [
      group(
        'mark',
        [
          path(
            [
              [-46, 2],
              [-14, 34],
              [48, -32],
            ],
            [
              [0, 0],
              [0, 0],
              [0, 0],
            ],
            [
              [0, 0],
              [0, 0],
              [0, 0],
            ],
          ),
          stroke(WHITE, 20),
          trim(
            still(0),
            anim([
              [11, 0],
              [26, 100],
            ]),
          ),
        ],
        {},
      ),
    ],
    {
      p: still([120, 120, 0]),
      o: anim([
        [48, 100],
        [59, 0],
      ]),
    },
    0,
    op,
  );
  return { v: '5.7.4', fr: 30, ip: 0, op, w: 240, h: 240, nm: 'check-badge', ddd: 0, assets: [], layers: [check, badge] };
}
