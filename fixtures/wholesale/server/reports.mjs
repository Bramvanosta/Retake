// The console's "Sales reports" (R-ISS-08): classic server-rendered pages — every link is a full page load — so the
// runner films navigations between documents in the middle of a scene.
//
//   GET /reports            two months, and "Back to the console" (→ /products: the single-page app's empty shell,
//                           which paints only once its bundle and data arrived)
//   GET /reports/<yyyy-mm>  answered after NORTHFIELD_REPORT_MS (default 400 ms); the page first paints an animated
//                           skeleton only — no text, image or SVG, so no contentful paint — while its script fetches
//                           the figures, then renders the report (heading, "Total sales", sales by market)
//   GET /reports/<yyyy-mm>/data  the report's figures as HTML in JSON, answered after NORTHFIELD_REPORT_DATA_MS
//                           (default 1200 ms: a slow report query)
//
// Figures are invented.

export const REPORT_MS = 400;
export const REPORT_DATA_MS = 1200;

export const REPORTS = {
  '2026-10': {
    label: 'October 2026',
    markets: [
      ['Sweden', 412, 18_940],
      ['Norway', 268, 13_210],
      ['Denmark', 174, 8_120],
      ['Finland', 133, 6_470],
      ['Iceland', 31, 1_580],
    ],
  },
  '2026-09': {
    label: 'September 2026',
    markets: [
      ['Sweden', 386, 17_660],
      ['Norway', 241, 11_870],
      ['Denmark', 162, 7_590],
      ['Finland', 118, 5_740],
      ['Iceland', 27, 1_390],
    ],
  },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const eur = (n) => '€' + n.toLocaleString('en-US');

const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #f7f3ee; }
  body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif; color: #221714; }
  .top { height: 64px; background: #2a1715; }
  main { max-width: 980px; margin: 0 auto; padding: 40px 32px; }
  h1 { margin: 0 0 6px; font-family: ui-serif, 'New York', 'Iowan Old Style', 'Charter', Georgia, serif; font-weight: 500; font-size: 34px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 28px; color: #8b7e77; }
  a { color: #6e1f2b; font-weight: 600; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .months { display: grid; gap: 12px; margin: 0 0 32px; padding: 0; list-style: none; }
  .months a { display: block; padding: 18px 22px; border: 1px solid #e6dbcf; border-radius: 14px; background: #fff; font-size: 18px; }
  .card { padding: 22px 24px; border: 1px solid #e6dbcf; border-radius: 16px; background: #fff; margin: 0 0 22px; }
  .total { font-size: 13px; font-weight: 600; color: #8b7e77; text-transform: uppercase; letter-spacing: 0.08em; }
  .figure { font-size: 40px; font-weight: 650; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 11px 6px; border-bottom: 1px solid #efe6dc; text-align: left; }
  th { font-size: 12.5px; color: #8b7e77; font-weight: 600; }
  td.n, th.n { text-align: right; }
  .links { display: flex; gap: 24px; }
  .sk { border-radius: 10px; background: linear-gradient(90deg, #e9e0d6 0%, #f3ece4 50%, #e9e0d6 100%); background-size: 200% 100%; animation: sk 1.1s linear infinite; }
  @keyframes sk { from { background-position: 100% 0; } to { background-position: -100% 0; } }
`;

function shell(title, body, head = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Northfield</title>
<link rel="icon" href="/favicon.svg">
<style>${STYLE}</style>
${head}
</head>
<body>
<div class="top"></div>
${body}
</body>
</html>`;
}

export function renderReportList() {
  const items = Object.entries(REPORTS)
    .map(([key, r]) => `<li><a href="/reports/${key}">${esc(r.label)}</a></li>`)
    .join('');
  return shell(
    'Sales reports',
    `<main><h1>Sales reports</h1><p class="sub">Monthly sales by market, for Northfield Roasters.</p>
<ul class="months">${items}</ul>
<div class="links"><a href="/products">Back to the console</a></div></main>`,
  );
}

/** A report page: an empty skeleton (no contentful paint) whose script fetches the report; null for an unknown month. */
export function renderReport(key) {
  if (!REPORTS[key]) return null;
  const skeleton =
    '<div class="sk" style="width:320px;height:40px;margin:0 0 14px"></div><div class="sk" style="width:240px;height:18px;margin:0 0 30px"></div>' +
    '<div class="sk" style="height:120px;margin:0 0 22px"></div><div class="sk" style="height:300px"></div>';
  // The script sits in <head>: the report replaces the skeleton once its figures arrived.
  const head = `<script>
  fetch(${JSON.stringify(`/reports/${key}/data`)}).then((r) => r.json()).then((d) => { document.getElementById('report').innerHTML = d.html; });
</script>`;
  return shell(REPORTS[key].label, `<main id="report">${skeleton}</main>`, head);
}

/** The report itself (heading, total, sales by market) as an HTML fragment; null for an unknown month. */
export function reportFragment(key) {
  const r = REPORTS[key];
  if (!r) return null;
  const bags = r.markets.reduce((n, m) => n + m[1], 0);
  const total = r.markets.reduce((n, m) => n + m[2], 0);
  const rows = r.markets.map(([market, b, e]) => `<tr><td>${esc(market)}</td><td class="n">${b}</td><td class="n">${eur(e)}</td></tr>`).join('');
  const report =
    `<h1>${esc(r.label)}</h1><p class="sub">Sales by market, Northfield Roasters.</p>` +
    `<div class="card"><div class="total">Total sales</div><div class="figure">${eur(total)}</div><div class="sub">${bags} bags</div></div>` +
    `<div class="card"><table><thead><tr><th>Market</th><th class="n">Bags</th><th class="n">Sales</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<div class="links"><a href="/reports">All reports</a><a href="/products">Back to the console</a></div>`;
  return report;
}
