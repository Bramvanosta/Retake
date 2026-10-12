// "Download quote PDF" target: an HTML page dressed as a browser PDF viewer showing the quote
// document. It is server-rendered (a new tab is a separate document, like a real PDF).

import { date, dateLong, eur, num, range } from '../src/shared/format.js';
import { BUYER, ORGANIZATIONS } from './seed.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SUPPLIER_ADDRESS = ['Rostervägen 12', '414 51 Gothenburg', 'Sweden'];

const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  fit: '<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/>',
  rotate: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/>',
  more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#525659;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;color:#1f1613;-webkit-font-smoothing:antialiased}
.bar{position:fixed;inset:0 0 auto 0;height:56px;background:#323639;color:#f1f1f1;display:flex;align-items:center;padding:0 12px;gap:8px;box-shadow:0 1px 4px rgba(0,0,0,.35);z-index:2}
.bar .name{font-size:14px;font-weight:500;margin-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px}
.bar .center{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;font-size:13px}
.bar .pages{display:flex;align-items:center;gap:6px}
.bar .box{background:#191b1c;border-radius:2px;padding:3px 7px;min-width:28px;text-align:center}
.bar .sep{width:1px;height:20px;background:#5f6368}
.bar .right{margin-left:auto;display:flex;gap:4px}
.bar button{all:unset;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;color:#f1f1f1;cursor:pointer}
.bar button:hover{background:rgba(255,255,255,.1)}
.viewer{position:absolute;inset:56px 0 0 0;overflow:auto;padding:28px 0 60px}
.page{width:820px;min-height:1160px;margin:0 auto;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.25);padding:64px 68px 56px;position:relative;font-size:12.5px;line-height:1.55}
.head{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:28px;border-bottom:2px solid #6b1e2a}
.brand{display:flex;gap:12px;align-items:center}
.mark{width:42px;height:42px;border-radius:11px;background:linear-gradient(145deg,#7d2633,#4a1219);display:grid;place-items:center}
.brand b{display:block;font-size:17px;letter-spacing:-.01em}
.brand span{color:#7a6c66;font-size:11.5px}
.doc-title{text-align:right}
.doc-title h1{margin:0;font-family:ui-serif,"New York","Iowan Old Style",Caladea,Georgia,serif;font-weight:500;font-size:30px;letter-spacing:.02em;color:#6b1e2a}
.doc-title p{margin:4px 0 0;color:#5c4f49}
.meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin:28px 0 30px}
.meta h4{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#8a7d75;font-weight:600}
.meta p{margin:0}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#8a7d75;font-weight:600;text-align:left;padding:10px 8px;border-bottom:1px solid #e3d9ce}
td{padding:14px 8px;border-bottom:1px solid #efe8e0;vertical-align:top}
td small{display:block;color:#7a6c66;font-size:11.5px;margin-top:2px}
.r{text-align:right;white-space:nowrap}
.totals{margin:18px 0 0 auto;width:300px}
.totals div{display:flex;justify-content:space-between;padding:6px 8px}
.totals .grand{border-top:2px solid #1f1613;margin-top:6px;padding-top:12px;font-size:16px;font-weight:700}
.note{margin-top:34px;padding:16px 18px;background:#faf6f1;border-radius:8px;border:1px solid #efe6dc}
.note h4,.terms h4{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#8a7d75;font-weight:600}
.terms{margin-top:26px;color:#5c4f49}
.terms ul{margin:0;padding-left:18px}
.foot{position:absolute;left:68px;right:68px;bottom:40px;display:flex;justify-content:space-between;color:#9a8d85;font-size:10.5px;border-top:1px solid #efe8e0;padding-top:12px}
.sign{margin-top:40px;display:flex;justify-content:space-between;align-items:flex-end}
.sign .who{font-family:ui-serif,"New York","Iowan Old Style",Caladea,Georgia,serif;font-size:22px;color:#3b2a26;font-style:italic}
.stamp{border:2px solid #2f6b4f;color:#2f6b4f;border-radius:8px;padding:6px 12px;font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase;transform:rotate(-4deg)}
.empty{color:#f1f1f1;text-align:center;margin-top:160px;font-size:15px}
`;

const LOGO = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3c4.4 0 7 3.6 7 8.5S16.1 21 12 21s-7-4.6-7-9.5S7.6 3 12 3Z" fill="#f6e7d8"/><path d="M12.6 4.2c-2.6 2.7-2.7 5.4-.6 8 2 2.4 1.8 5-.6 7.6" fill="none" stroke="#6b1e2a" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg"><style>${STYLE}</style></head>
<body>
<div class="bar" role="toolbar" aria-label="PDF toolbar">
  <button aria-label="Menu">${icon('menu')}</button>
  <span class="name">${esc(title)}</span>
  <div class="center"><span class="pages"><span class="box">1</span><span>/</span><span>1</span></span><span class="sep"></span>
  <button aria-label="Zoom out">${icon('minus')}</button><span class="box">100%</span><button aria-label="Zoom in">${icon('plus')}</button>
  <span class="sep"></span><button aria-label="Fit to page">${icon('fit')}</button><button aria-label="Rotate">${icon('rotate')}</button></div>
  <div class="right"><button aria-label="Download">${icon('download')}</button><button aria-label="Print">${icon('print')}</button><button aria-label="More actions">${icon('more')}</button></div>
</div>
<div class="viewer">${body}</div>
</body></html>`;
}

export function quotePdfFileName(quote) {
  return `Northfield_Quote_${quote.reference}.pdf`;
}

/** @param {any} quote public quote (store.getQuote) */
export function renderQuotePdf(quote) {
  const title = quotePdfFileName(quote);
  const article = quoteArticle(quote);
  if (!article) {
    return shell(title, `<p class="empty">No PDF yet — ${esc(quote.supplier)} has not sent a proposal for ${esc(quote.reference)}.</p>`);
  }
  return shell(title, article);
}

/**
 * The quote as a printable A4 document (no viewer chrome): what `/quotes/:id/quote.pdf` prints with Chromium.
 * Null when the quote has no proposal yet.
 * @param {any} quote public quote (store.getQuote)
 */
export function renderQuotePrint(quote) {
  const article = quoteArticle(quote);
  if (!article) return null;
  const print = `@page{size:A4;margin:0}html,body{background:#fff}body{margin:0}
.page{width:210mm;height:297mm;min-height:0;margin:0;box-shadow:none;padding:52px 60px 48px;overflow:hidden}
.head{padding-bottom:22px}.meta{margin:22px 0 20px}td{padding:11px 8px}.totals{margin-top:12px}
.note{margin-top:20px;padding:12px 16px}.terms{margin-top:18px}.sign{margin-top:22px}.foot{left:60px;right:60px;bottom:30px}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(quotePdfFileName(quote))}</title><style>${STYLE}${print}</style></head>
<body>${article}</body></html>`;
}

function quoteArticle(quote) {
  const p = quote.proposal;
  if (!p) return null;
  const org = ORGANIZATIONS[0];
  const product = quote.product ?? { name: quote.product_slug, origin: '', region: '', process: '', variety: '' };
  const body = `
<article class="page" aria-label="Quote ${esc(quote.reference)}">
  <header class="head">
    <div class="brand"><div class="mark">${LOGO}</div><div><b>${esc(org.name)}</b><span>Specialty coffee roasters · ${esc(org.city)}</span></div></div>
    <div class="doc-title"><h1>Quotation</h1><p>${esc(quote.reference)} · ${esc(dateLong(p.created_at))}</p></div>
  </header>
  <section class="meta">
    <div><h4>From</h4><p><b>${esc(org.name)} AB</b><br>${SUPPLIER_ADDRESS.map(esc).join('<br>')}<br>VAT SE 5567 8901 2301</p></div>
    <div><h4>Prepared for</h4><p><b>${esc(BUYER.name)}</b><br>${BUYER.address.map(esc).join('<br>')}<br>Attn. ${esc(BUYER.contact)}</p></div>
    <div><h4>Details</h4><p>Requested ${esc(date(quote.created_at))}<br>Valid until ${esc(date(p.valid_until))}<br>Delivery ${esc(range(quote.window_start, quote.window_end))}</p></div>
  </section>
  <table>
    <thead><tr><th>Description</th><th class="r">Quantity</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr><td><b>${esc(product.name)}</b><small>${esc([product.origin, product.region].filter(Boolean).join(', '))} · ${esc(product.variety)} · ${esc(product.process)}</small><small>Roasted to order · ${esc(quote.grind.toLowerCase())} · ${num(quote.bags)} × ${esc(quote.bag_size)} bags · ${esc(quote.label_language)} labels</small></td>
        <td class="r">${num(p.quantity_kg)} kg</td><td class="r">${eur(p.unit_price_eur)} / kg</td><td class="r">${eur(p.goods_eur)}</td></tr>
      <tr><td><b>Delivery</b><small>Pallet freight to ${esc(BUYER.address[1])}, ${esc(range(quote.window_start, quote.window_end))}</small></td>
        <td class="r">1</td><td class="r">${eur(p.shipping_eur)}</td><td class="r">${eur(p.shipping_eur)}</td></tr>
    </tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${eur(p.net_eur)}</span></div>
    <div><span>VAT ${Math.round(p.vat_rate * 100)}%</span><span>${eur(p.vat_eur)}</span></div>
    <div class="grand"><span>Total incl. VAT</span><span>${eur(p.total_eur)}</span></div>
  </div>
  ${p.note ? `<div class="note"><h4>Note from the roaster</h4><p>${esc(p.note)}</p></div>` : ''}
  ${quote.message ? `<div class="note"><h4>Your message</h4><p>${esc(quote.message)}</p></div>` : ''}
  <div class="terms"><h4>Terms</h4><ul><li>Payment 30 days net, prices in EUR.</li><li>Coffee is roasted within five days before delivery.</li><li>This quotation is valid until ${esc(dateLong(p.valid_until))}.</li></ul></div>
  <div class="sign"><div><div class="who">Maja Lindqvist</div><div>Supply manager, ${esc(org.name)}</div></div>${quote.status === 'accepted' ? '<div class="stamp">Accepted</div>' : ''}</div>
  <footer class="foot"><span>${esc(org.name)} AB · ${esc(SUPPLIER_ADDRESS.join(', '))}</span><span>Page 1 of 1</span></footer>
</article>`;
  return body;
}

export function renderNotFoundPdf(id) {
  return shell(`Quote ${id}`, `<p class="empty">Quote ${esc(id)} was not found.</p>`);
}
