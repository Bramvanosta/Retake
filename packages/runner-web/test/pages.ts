/** Fixture pages for the runner tests (fictional "Northfield" coffee-wholesale screens). */

const BASE_CSS = `
  *{box-sizing:border-box} body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#f6f3ef;color:#1f1413}
  button{font:inherit;padding:8px 14px;border:1px solid #c9bfb7;border-radius:8px;background:#fff;cursor:pointer}
  main{padding:24px}
`;

function page(title: string, body: string, script = '', css = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}${css}</style></head><body>${body}<script>${script}</script></body></html>`;
}

export const RESOLVER_PAGE = page(
  'Resolver',
  `<main>
  <h1>Resolver fixtures</h1>
  <button id="b-save">Save</button>
  <button id="b-save-changes">Save changes</button>
  <button id="b-hidden" style="display:none">Hidden action</button>
  <button id="b-invisible" style="visibility:hidden">Invisible action</button>
  <button id="b-transparent" style="opacity:0">Transparent action</button>
  <button id="b-offscreen" style="position:absolute;left:-9999px">Offscreen action</button>
  <span id="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen reader only</span>
  <div style="width:200px;height:30px;overflow:hidden;position:relative"><button id="b-clipped" style="position:absolute;top:60px">Clipped away</button></div>
  <a id="l-span" href="#x"><span>Wrapped <b>link</b></span></a>
  <div id="card"><h3>Finca La Esperanza</h3><p>Harvest 2026</p></div>
  <div><a id="card-a" href="#c"><div><h4>Finca El Paraiso</h4><span>Harvest 2025</span></div></a></div>
  <label for="i-email">Email address</label> <input id="i-email">
  <label>Company <input id="i-company"></label>
  <span id="lbl-region">Region</span> <div role="combobox" id="cb-region" aria-labelledby="lbl-region" tabindex="0">Choose a region</div>
  <button id="b-icon" aria-label="Close panel">×</button>
  <input id="i-ph" placeholder="Search coffees">
  <div role="button" id="rb-1" tabindex="0">Custom button</div>
  <button id="b-tid" data-testid="export-btn">Export</button>
  <input type="submit" id="i-submit" value="Submit order">
  <table>
    <tr id="row-iceland"><td>Iceland</td><td><button id="iceland-menu" aria-haspopup="menu" aria-label="Row actions">⋯</button></td></tr>
    <tr id="row-sweden"><td>Sweden</td><td><button id="sweden-edit">Edit</button><button id="sweden-more" aria-label="More options">⋯</button></td></tr>
  </table>
  <div role="dialog" id="dlg" aria-modal="true" aria-labelledby="dlg-title"><h2 id="dlg-title">Edit region</h2><button id="dlg-save">Save</button></div>
  <div role="menu" id="menu1"><div role="menuitem" id="mi-1">Pause</div></div>
  <div role="menu" id="menu2"><div role="menuitem" id="mi-2">Pause</div></div>
  <div id="cal1"><button aria-label="Next month" id="next1">›</button></div>
  <div id="cal2"><button aria-label="Next month" id="next2">›</button></div>
  <div id="cal3" style="display:none"><button aria-label="Next month" id="next3">›</button></div>
  <ul><li id="li-1">Iceland — 12 bags</li><li id="li-2">Norway — 4 bags</li></ul>
  <div style="height:1400px"></div>
  <button id="b-far">Far below</button>
</main>`,
);

export const OVERLAY_A = page(
  'Overlay A',
  `<main><h1>Page A</h1><a id="to-b" href="/overlay-b.html">Go to B</a>
   <dialog id="dlg" style="width:400px;height:300px;background:#204030;border:0;padding:0"><p style="color:#fff">Modal</p></dialog>
   <div id="pop" popover="manual" style="width:400px;height:300px;background:#402020;border:0;margin:0;position:fixed;left:200px;top:150px"></div></main>`,
);

export const OVERLAY_B = page('Overlay B', `<main><h1>Page B</h1><p>Second page</p></main>`);

/** Widgets whose popups only open with specific input (the click strategy chain must find a way). */
export const STRATEGY_PAGE = page(
  'Strategies',
  `<main>
  <h1>Click strategies</h1>
  <p><button id="a" aria-haspopup="listbox" aria-expanded="false">Roast level</button>
     <button id="b" aria-haspopup="menu" aria-expanded="false">Bag actions</button>
     <button id="c" aria-haspopup="dialog" aria-expanded="false">Origin details</button>
     <button id="plain">Plain button</button></p>
  <div id="a-pop" role="listbox" hidden style="width:200px;height:80px;background:#fff;border:1px solid #ccc">Light</div>
  <div id="b-pop" role="menu" hidden style="width:200px;height:80px;background:#fff;border:1px solid #ccc">Archive</div>
  <div id="c-pop" role="dialog" hidden style="width:200px;height:80px;background:#fff;border:1px solid #ccc">Ethiopia</div>
  <p id="log"></p>
</main>`,
  `
  const log = (m) => (document.getElementById('log').textContent += m + ' ');
  function openPop(id) { document.getElementById(id + '-pop').hidden = false; document.getElementById(id).setAttribute('aria-expanded', 'true'); log('open-' + id); }
  function closeAll() { for (const id of ['a', 'b', 'c']) { document.getElementById(id + '-pop').hidden = true; document.getElementById(id).setAttribute('aria-expanded', 'false'); } }
  // a: opens on pointerdown only (el.click() cannot open it; real input can)
  a.addEventListener('pointerdown', (e) => { e.preventDefault(); openPop('a'); });
  // b: ignores trusted input entirely; a DOM click opens it
  b.addEventListener('click', (e) => { if (!e.isTrusted) openPop('b'); });
  // c: only a synthetic pointerdown opens it (ignores real input and plain clicks)
  c.addEventListener('pointerdown', (e) => { if (!e.isTrusted) openPop('c'); });
  plain.addEventListener('click', () => log('plain'));
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('button,[role=listbox],[role=menu],[role=dialog]')) closeAll(); }, true);
`,
);

export const TABS_PAGE = page(
  'Tabs',
  `<main><h1>Quote</h1>
   <a id="blank" href="/doc.html?n=1" target="_blank">Open document</a>
   <a id="prevented" href="/doc.html?n=2" target="_blank">Download quote PDF</a></main>`,
  `document.getElementById('prevented').addEventListener('click', (e) => e.preventDefault());`,
);

export const DOC_PAGE = page(
  'Document',
  `<main><h1>Quote document</h1><p id="n"></p><div id="bar" style="height:8px;background:#8a6a5a;width:10px"></div></main>`,
  `document.getElementById('n').textContent = 'Quote ' + new URLSearchParams(location.search).get('n');
   let w = 10; const t = setInterval(() => { w += 20; document.getElementById('bar').style.width = w + 'px'; if (w > 600) clearInterval(t); }, 30);`,
);

export const DROP_PAGE = page(
  'Imports',
  `<main><h1>New import</h1>
  <div id="zone" style="width:420px;height:140px;border:2px dashed #b9a99d;border-radius:12px;display:grid;place-items:center">Drop your price list here</div>
  <p id="out"></p>
  <label id="zone2" style="display:grid;place-items:center;width:420px;height:100px;border:2px dashed #b9a99d;border-radius:12px;margin-top:16px">Click to choose a file<input type="file" id="file2" hidden></label>
  <p id="out2"></p>
  <div id="zone3" style="width:420px;height:80px;border:1px solid #ccc;margin-top:16px">Explicit input zone</div>
  <input type="file" id="file3" style="display:none">
  <p id="out3"></p>
</main>`,
  `
  zone.addEventListener('dragenter', () => zone.style.background = '#efe6dd');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => { e.preventDefault(); out.textContent = 'dropped:' + [...e.dataTransfer.files].map((f) => f.name + ':' + f.size + ':' + f.type).join(','); });
  file2.addEventListener('change', () => (out2.textContent = 'chosen:' + file2.files[0].name + ':' + file2.files[0].size));
  file3.addEventListener('change', () => (out3.textContent = 'explicit:' + file3.files[0].name));
`,
);

export const SCROLL_PAGE = page(
  'Availability',
  `<main><h1>Availability</h1>
  <div id="inner" style="height:240px;width:360px;overflow:auto;border:1px solid #ccc;background:#fff">
    ${Array.from({ length: 40 }, (_, i) => `<div style="height:40px;padding:8px" id="item-${i + 1}">Region ${i + 1}</div>`).join('')}
    <button id="deep" style="margin:8px">Deep action</button>
  </div>
  <div style="height:1600px"></div>
  <h2 id="awards">Awards</h2>
  <div style="height:800px"></div>
</main>`,
  `deep.addEventListener('click', () => (deep.textContent = 'Deep action done'));`,
);

export const DRY_PAGE = page(
  'Dry',
  `<main><h1>Catalogue</h1><button id="save">Save draft</button><button id="delete">Delete everything</button>
   <button id="after">After</button><button id="other">Other</button><p id="log"></p></main>`,
  `for (const id of ['save', 'delete', 'after', 'other']) document.getElementById(id).addEventListener('click', () => (document.getElementById('log').textContent += id + ' '));`,
);

/** A 1920×1080 mock console for the acceptance capture. */
export const ACCEPT_PAGE = page(
  'Northfield console',
  `<header style="height:64px;background:#1f1413;color:#f3eee8;display:flex;align-items:center;padding:0 32px;gap:24px">
     <strong>Northfield</strong><nav style="display:flex;gap:16px"><a style="color:inherit" href="#">Catalogue</a><a style="color:inherit" href="#">Imports</a></nav></header>
   <main style="display:grid;grid-template-columns:1fr 1fr;gap:32px;padding:40px 64px">
     <section>
       <h1>Price lists</h1>
       <p><button id="new">New import</button> <button id="org" aria-haspopup="listbox" aria-expanded="false">Choose an organisation</button></p>
       <div id="org-list" role="listbox" hidden style="position:absolute;background:#fff;border:1px solid #ccc;border-radius:8px;padding:6px;width:280px">
         <div role="option" style="padding:8px">Northfield Roasters</div><div role="option" style="padding:8px">Harbour Coffee Co.</div></div>
       <p><label for="name">Import name</label><br><input id="name" style="font:inherit;padding:8px;width:360px"></p>
       <p><label><input type="checkbox" id="notify"> Notify buyers</label></p>
       <p id="status">Idle</p>
     </section>
     <section>
       <h2>Regions</h2>
       <table style="border-collapse:collapse;width:100%">
         <tr><td style="padding:10px">Iceland</td><td><button id="r1" aria-haspopup="menu" aria-label="Row actions">⋯</button></td></tr>
         <tr><td style="padding:10px">Sweden</td><td><button id="r2" aria-haspopup="menu" aria-label="Row actions">⋯</button></td></tr>
       </table>
       <div id="menu" role="menu" hidden style="position:absolute;background:#fff;border:1px solid #ccc;border-radius:8px;padding:6px;width:200px">
         <div role="menuitem" style="padding:8px">Pause</div><div role="menuitem" style="padding:8px">Edit</div></div>
       <p style="margin-top:40px"><button id="save">Save changes</button></p>
     </section>
   </main>`,
  `
  const st = (m) => (document.getElementById('status').textContent = m);
  document.getElementById('new').addEventListener('click', () => st('New import started'));
  const org = document.getElementById('org'), list = document.getElementById('org-list');
  org.addEventListener('click', () => { const r = org.getBoundingClientRect(); list.style.left = r.left + 'px'; list.style.top = r.bottom + 6 + 'px'; list.hidden = false; org.setAttribute('aria-expanded', 'true'); });
  list.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; org.textContent = o.textContent; list.hidden = true; org.setAttribute('aria-expanded', 'false'); });
  const menu = document.getElementById('menu');
  for (const b of document.querySelectorAll('[aria-label="Row actions"]')) b.addEventListener('click', () => { const r = b.getBoundingClientRect(); menu.style.left = r.left - 160 + 'px'; menu.style.top = r.bottom + 6 + 'px'; menu.hidden = false; b.setAttribute('aria-expanded', 'true'); });
  menu.addEventListener('click', (e) => { const i = e.target.closest('[role=menuitem]'); if (!i) return; st('Row ' + i.textContent); menu.hidden = true; });
  document.getElementById('save').addEventListener('click', () => st('Saved'));
`,
);

/**
 * Widgets mimicking Radix / Base UI behaviours with plain JS: a searchable listbox select, a multi-select popover
 * inside a modal dialog (outside pointerdown closes the popover, Escape closes the WHOLE dialog), and row menus
 * whose confirmation re-opens the row menu after it closes.
 */
export const WIDGETS_PAGE = page(
  'Availability',
  `<main>
  <h1>Availability</h1>
  <p><label for="grind">Grind</label> <select id="grind"><option>Whole bean</option><option>Filter</option><option>Espresso</option></select></p>
  <p><span id="org-label">Organisation</span> <button id="org" role="combobox" aria-labelledby="org-label" aria-haspopup="listbox" aria-expanded="false">Choose…</button></p>
  <p id="enrich">Enrichment in progress</p>
  <table>
    <tr><td>Iceland</td><td id="ice-state">Active</td><td><button aria-haspopup="menu" aria-label="Row actions" data-row="Iceland">⋯</button></td></tr>
    <tr><td>Sweden</td><td id="swe-state">Active</td><td><button aria-haspopup="menu" aria-label="Row actions" data-row="Sweden">⋯</button></td></tr>
  </table>
  <p><button id="edit">Edit Sweden</button></p>
  <p id="status"></p>
  <div id="dbl" style="width:160px;height:40px;background:#e6ddd4">Double me</div>
  <div id="drag-src" style="width:80px;height:40px;background:#8a6a5a;color:#fff;position:absolute;left:520px;top:420px">Bag</div>
  <div id="drag-dst" style="width:160px;height:80px;border:2px dashed #888;position:absolute;left:700px;top:400px">Shelf</div>
</main>
<div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" hidden style="position:fixed;left:180px;top:60px;width:440px;height:360px;background:#fff;border:1px solid #ccc;border-radius:12px;padding:16px">
  <h2 id="dlg-title">Edit Sweden</h2>
  <div><div id="bags-label">Bag sizes</div><button id="bags" aria-haspopup="dialog" aria-expanded="false">Select…</button></div>
  <p id="bags-value"></p>
  <button id="dlg-save">Save</button>
</div>`,
  `
  const $ = (id) => document.getElementById(id);
  const status = (m) => ($('status').textContent = m);
  setTimeout(() => $('enrich').textContent = 'Tasting notes ready', 600);
  $('grind').addEventListener('change', (e) => status('grind=' + e.target.value));

  // Searchable listbox (portal at the end of body, focus in its search field).
  let lb = null;
  function closeLb() { lb?.remove(); lb = null; $('org').setAttribute('aria-expanded', 'false'); }
  $('org').addEventListener('click', () => {
    if (lb) return closeLb();
    lb = document.createElement('div');
    lb.setAttribute('data-radix-popper-content-wrapper', '');
    const r = $('org').getBoundingClientRect();
    lb.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #ccc;padding:6px;width:260px';
    lb.innerHTML = '<input id="org-q" placeholder="Search"><div role="listbox">' + ['Northfield Roasters', 'Harbour Coffee Co.', 'Northfield Imports'].map((o) => '<div role="option" style="padding:6px">' + o + '</div>').join('') + '</div>';
    document.body.appendChild(lb);
    $('org').setAttribute('aria-expanded', 'true');
    $('org-q').focus();
    $('org-q').addEventListener('input', (e) => { for (const o of lb.querySelectorAll('[role=option]')) o.style.display = o.textContent.toLowerCase().includes(e.target.value.toLowerCase()) ? '' : 'none'; });
    lb.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; $('org').textContent = o.textContent; status('org=' + o.textContent); closeLb(); });
  });

  // Modal dialog with a multi-select popover.
  $('edit').addEventListener('click', () => { $('dialog').hidden = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('dialog').hidden) { $('dialog').hidden = true; closePop(); status('dialog closed by Escape'); } });
  let pop = null; const chosen = new Set();
  function closePop() { pop?.remove(); pop = null; $('bags').setAttribute('aria-expanded', 'false'); }
  $('bags').addEventListener('click', () => {
    if (pop) return closePop();
    pop = document.createElement('div');
    pop.setAttribute('data-radix-popper-content-wrapper', '');
    const r = $('bags').getBoundingClientRect();
    pop.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;';
    pop.innerHTML = '<div role="dialog" data-side="bottom" style="background:#fff;border:1px solid #ccc;padding:6px;width:220px"><input placeholder="Search sizes"><div>' +
      ['250 g', '1 kg', '5 kg'].map((o) => '<div role="option" aria-selected="false" style="padding:6px">' + o + '</div>').join('') + '</div></div>';
    document.body.appendChild(pop);
    $('bags').setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; chosen.has(o.textContent) ? chosen.delete(o.textContent) : chosen.add(o.textContent); o.setAttribute('aria-selected', String(chosen.has(o.textContent))); $('bags-value').textContent = [...chosen].join(', '); });
  });
  document.addEventListener('pointerdown', (e) => {
    if (pop && !pop.contains(e.target) && e.target !== $('bags')) closePop();
    if (lb && !lb.contains(e.target) && e.target !== $('org')) closeLb();
  }, true);
  $('dlg-save').addEventListener('click', () => { $('dialog').hidden = true; status('saved bags=' + $('bags-value').textContent); });

  // Row menus + confirmation; closing the confirmation re-opens the row menu (library quirk).
  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function openMenu(btn) {
    closeMenu();
    menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const r = btn.getBoundingClientRect();
    menu.style.cssText = 'position:fixed;left:' + (r.left - 140) + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #ccc;padding:6px;width:160px';
    menu.innerHTML = '<div role="menuitem" style="padding:6px">Edit</div><div role="menuitem" style="padding:6px">Pause</div>';
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const it = e.target.closest('[role=menuitem]'); if (!it) return;
      closeMenu();
      if (it.textContent === 'Pause') confirmPause(btn);
    });
  }
  function confirmPause(btn) {
    const a = document.createElement('div');
    a.setAttribute('role', 'alertdialog');
    a.style.cssText = 'position:fixed;left:600px;top:200px;background:#fff;border:1px solid #333;padding:16px';
    a.innerHTML = '<p>Pause ' + btn.dataset.row + '?</p><button>Cancel</button> <button>Pause</button>';
    document.body.appendChild(a);
    a.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      a.remove();
      if (b.textContent === 'Pause') { status(btn.dataset.row + ' paused'); $(btn.dataset.row === 'Iceland' ? 'ice-state' : 'swe-state').textContent = 'Paused'; }
      setTimeout(() => openMenu(btn), 80);
    });
  }
  for (const b of document.querySelectorAll('[aria-label="Row actions"]')) b.addEventListener('click', () => openMenu(b));
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('[aria-label="Row actions"]')) closeMenu(); }, true);

  // Double click and pointer-based drag.
  $('dbl').addEventListener('dblclick', () => status('double clicked'));
  let dragging = false;
  $('drag-src').addEventListener('pointerdown', () => { dragging = true; });
  document.addEventListener('pointermove', (e) => { if (dragging) { $('drag-src').style.left = e.clientX - 40 + 'px'; $('drag-src').style.top = e.clientY - 20 + 'px'; } });
  document.addEventListener('pointerup', (e) => {
    if (!dragging) return; dragging = false;
    const r = $('drag-dst').getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) status('dropped on shelf');
  });
`,
);

export const SHOP_PAGE = page('Shop', `<main><h1>Buyer shop</h1><p id="who"></p><button id="quote">Request a quote</button></main>`, `
  document.getElementById('who').textContent = 'Welcome ' + (new URLSearchParams(location.search).get('buyer') || 'guest');
  document.getElementById('quote').addEventListener('click', () => (document.getElementById('who').textContent += ' — quote requested'));
`);
