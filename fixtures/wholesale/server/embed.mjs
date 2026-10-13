// The shop's "Shipping estimate" widget (GET /embed/shipping?product=<slug>): a self-contained page shown in a
// same-origin <iframe> at the bottom of the product page, so the runner's resolver is filmed acting inside a frame
// (R-ISS-07): a native <select>, a number field and a button, all inside the frame.
//
// The estimate is computed client-side from a fixed rate table: base + per bag, e.g. 12 bags to Norway =
// €24 + 12 × €5 = "12 bags to Norway · €84.00 · 3–5 working days".

export const SHIPPING_RATES = {
  Sweden: { base: 18, perBag: 3.5, days: '1–2' },
  Norway: { base: 24, perBag: 5, days: '3–5' },
  Denmark: { base: 20, perBag: 4, days: '2–3' },
  Finland: { base: 22, perBag: 4.5, days: '2–4' },
  Iceland: { base: 38, perBag: 7.5, days: '5–8' },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** @param {{ name?: string } | null} product */
export function renderShippingEmbed(product) {
  const options = Object.keys(SHIPPING_RATES)
    .map((c) => `<option>${c}</option>`)
    .join('');
  // The script sits in <head> (a script in <body> would be part of the body's text).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipping estimate</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fffefc; }
  body { padding: 24px 28px; font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif; color: #221714; }
  h2 { margin: 0; font-family: ui-serif, 'New York', 'Iowan Old Style', 'Charter', Georgia, serif; font-weight: 500; font-size: 27px; letter-spacing: -0.01em; }
  .sub { margin: 4px 0 18px; color: #8b7e77; font-size: 14.5px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; gap: 14px; align-items: end; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 13px; font-weight: 600; color: #4e423d; }
  select, input { height: 42px; border: 1px solid #ddd1c3; border-radius: 10px; background: #fff; padding: 0 12px; font: inherit; color: #221714; }
  select:focus, input:focus { outline: none; border-color: #6e1f2b; box-shadow: 0 0 0 3px rgba(110, 31, 43, 0.2); }
  button { height: 42px; border: 0; border-radius: 10px; padding: 0 18px; background: #6e1f2b; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #5a1823; }
  .result { margin: 18px 0 0; padding: 13px 16px; border-radius: 12px; background: #f0e9e1; color: #4e423d; font-weight: 600; font-variant-numeric: tabular-nums; }
  .result.ok { background: #e3f0e8; color: #2d6a4b; }
  @media (max-width: 520px) { .grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .grid button { grid-column: 1 / -1; } }
</style>
<script>
  const RATES = ${JSON.stringify(SHIPPING_RATES)};
  document.addEventListener('DOMContentLoaded', () => {
    const dest = document.getElementById('dest');
    const bags = document.getElementById('bags');
    const out = document.getElementById('result');
    document.getElementById('estimate').addEventListener('click', () => {
      const n = Math.max(1, Math.round(Number(bags.value) || 1));
      const r = RATES[dest.value];
      out.textContent = n + ' bag' + (n > 1 ? 's' : '') + ' to ' + dest.value + ' · €' + (r.base + n * r.perBag).toFixed(2) + ' · ' + r.days + ' working days';
      out.classList.add('ok');
    });
  });
</script>
</head>
<body>
  <h2>Shipping estimate</h2>
  <p class="sub">${esc(product?.name ?? 'Your order')} · door to door from the roastery</p>
  <div class="grid">
    <div class="field"><label for="dest">Destination</label><select id="dest">${options}</select></div>
    <div class="field"><label for="bags">Bags</label><input id="bags" type="number" min="1" max="99" value="1"></div>
    <button id="estimate" type="button">Estimate shipping</button>
  </div>
  <p id="result" class="result" aria-live="polite">Choose a destination and a number of bags.</p>
</body>
</html>`;
}
