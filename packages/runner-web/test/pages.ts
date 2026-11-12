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
  <div id="card"><h3>Finca Quenaro</h3><p>Harvest 2026</p></div>
  <div><a id="card-a" href="#c"><div><h4>Finca Lirandel</h4><span>Harvest 2025</span></div></a></div>
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
  <p id="content"></p>
  <label id="zone2" style="display:grid;place-items:center;width:420px;height:100px;border:2px dashed #b9a99d;border-radius:12px;margin-top:16px">Click to choose a file<input type="file" id="file2" hidden></label>
  <p id="out2"></p>
  <div id="zone3" style="width:420px;height:80px;border:1px solid #ccc;margin-top:16px">Explicit input zone</div>
  <input type="file" id="file3" style="display:none">
  <p id="out3"></p>
</main>`,
  `
  zone.addEventListener('dragenter', () => zone.style.background = '#efe6dd');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    out.textContent = 'dropped:' + files.map((f) => f.name + ':' + f.size + ':' + f.type).join(',');
    // The bytes themselves (a real file's content; a placeholder is zeros).
    document.getElementById('content').textContent = 'content:' + (await files[0].text()).slice(0, 24).replace(/\0/g, '0');
  });
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

/**
 * Probes for the options of the scenario language (L1.4): a click probe logging every pointer event it gets (button,
 * modifiers, offset from its top-left), a spinner, a client-side route change, a slow fetch and one that hangs, a
 * standalone multi-select popover that closes itself on Escape, the same button in a section and an aside, and a
 * destructive button. `?slow` adds an image that takes 1 s (a `load` waits for it, `domcontentloaded` does not).
 */
export const OPTIONS_PAGE = page(
  'Options',
  `<main>
  <h1 style="margin:0 0 12px">Label options</h1>
  <div class="row"><div id="probe" role="button" tabindex="0">Probe</div><button id="refresh">Refresh</button><span id="spinner" hidden>Loading…</span></div>
  <div class="row"><button id="next">Next step</button><button id="load">Load prices</button><span id="prices"></span><button id="live">Start live feed</button></div>
  <div class="row"><span id="langs-label">Label languages</span><button id="langs" aria-labelledby="langs-label" aria-haspopup="listbox" aria-expanded="false">Choose…</button><span id="langs-value"></span></div>
  <ul class="row" style="list-style:none;padding:0"><li class="item">Arabica</li><li class="item">Robusta</li><li class="item">Liberica</li></ul>
  <div class="row"><section><button id="main-add">Add</button></section><aside><button id="aside-add">Add</button></aside><button id="danger">Delete all labels</button></div>
  <p id="pop-log"></p>
  <p id="log"></p>
</main>`,
  `
  const $ = (id) => document.getElementById(id);
  const log = (m) => ($('log').textContent += m + ' ');
  window.probeLog = [];
  for (const type of ['pointerdown', 'click', 'auxclick', 'contextmenu']) {
    $('probe').addEventListener(type, (e) => {
      if (type === 'contextmenu') e.preventDefault();
      const r = $('probe').getBoundingClientRect();
      const mods = ['shift', 'alt', 'ctrl', 'meta'].filter((m) => e[m + 'Key']).join('+') || 'none';
      window.probeLog.push([type, e.isTrusted, e.button, mods, Math.round(e.clientX - r.left) + ',' + Math.round(e.clientY - r.top)].join(':'));
    });
  }
  // No middle-button autoscroll.
  $('probe').addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  $('refresh').addEventListener('click', () => {
    $('spinner').hidden = false;
    setTimeout(() => { $('spinner').hidden = true; window.spinnerGoneAt = Date.now(); }, 600);
  });
  $('next').addEventListener('click', () => setTimeout(() => { history.pushState({}, '', '?step=2'); document.title = 'Options — step 2'; }, 500));
  $('load').addEventListener('click', () => fetch('/slow').then((r) => r.text()).then(() => ($('prices').textContent = 'prices loaded')));
  $('live').addEventListener('click', () => fetch('/hang').catch(() => undefined));
  $('main-add').addEventListener('click', () => log('add-main'));
  $('aside-add').addEventListener('click', () => log('add-aside'));
  $('danger').addEventListener('click', () => log('danger'));
  if (new URLSearchParams(location.search).has('slow')) { const img = document.createElement('img'); img.src = '/slow.png'; document.body.append(img); }

  // A multi-select popover outside any dialog: options toggle, Escape (its own listener) or a click outside close it.
  let pop = null; const chosen = new Set();
  function closePop(why) { if (!pop) return; pop.remove(); pop = null; $('langs').setAttribute('aria-expanded', 'false'); if (why) $('pop-log').textContent = 'pop closed by ' + why; }
  $('langs').addEventListener('click', () => {
    if (pop) return closePop();
    pop = document.createElement('div');
    pop.setAttribute('data-radix-popper-content-wrapper', '');
    const r = $('langs').getBoundingClientRect();
    pop.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 4) + 'px;background:#fff;border:1px solid #ccc;padding:6px;width:200px';
    pop.innerHTML = '<div role="listbox" aria-multiselectable="true">' + ['English', 'Swedish', 'Danish'].map((o) => '<div role="option" aria-selected="false" style="padding:6px">' + o + '</div>').join('') + '</div>';
    document.body.appendChild(pop);
    $('langs').setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', (e) => {
      const o = e.target.closest('[role=option]'); if (!o) return;
      chosen.has(o.textContent) ? chosen.delete(o.textContent) : chosen.add(o.textContent);
      o.setAttribute('aria-selected', String(chosen.has(o.textContent)));
      $('langs-value').textContent = [...chosen].join(', ');
    });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop('Escape'); });
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && e.target !== $('langs')) closePop('outside'); }, true);
`,
  `.row{display:flex;gap:12px;align-items:center;margin:0 0 14px} #probe{width:180px;height:64px;background:#e6ddd4;display:grid;place-items:center;user-select:none}
   .item{padding:4px 10px;background:#fff;border:1px solid #ddd;border-radius:6px} aside{padding:6px;border-left:3px solid #c9bfb7}`,
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

export const SHOP_PAGE = page(
  'Shop',
  `<main><h1>Buyer shop</h1><p id="who"></p><button id="quote">Request a quote</button></main>`,
  `
  document.getElementById('who').textContent = 'Welcome ' + (new URLSearchParams(location.search).get('buyer') || 'guest');
  document.getElementById('quote').addEventListener('click', () => (document.getElementById('who').textContent += ' — quote requested'));
`,
);

/** Ripple contrast: a primary button of the same colour as the editorial template ripple (burgundy). */
export const RIPPLE_PAGE = page(
  'Ripple',
  `<main><button id="primary" style="position:absolute;left:200px;top:200px;width:360px;height:120px;border:0;border-radius:10px;
    background:rgb(138,35,50);color:#fff;font-weight:600" aria-label="Send proposal"></button>
    <button id="light" style="position:absolute;left:640px;top:200px;width:300px;height:120px">Cancel</button></main>`,
);

/** Scene-start cursor: a small target near the top-left, another one far right, a big block at the bottom. */
export const CURSOR_PAGE = page(
  'Cursor',
  `<main>
    <button id="start" style="position:absolute;left:40px;top:90px">Start</button>
    <button id="far" style="position:absolute;left:640px;top:300px">Far away</button>
    <div id="status" style="position:absolute;left:40px;top:520px">idle</div>
  </main>`,
  `for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => { document.getElementById('status').textContent = b.id + ' clicked'; });`,
);

/**
 * Scene-start cursor in a dialog (R-MAC-06): a field as wide as the dialog, whose far corner is close to the dialog's
 * right edge, and a second field below it.
 */
export const CURSOR_DIALOG_PAGE = page(
  'Cursor in a dialog',
  `<main>
    <button id="outside" style="position:absolute;left:40px;top:40px">Outside</button>
    <div role="dialog" aria-modal="true" aria-label="Request" style="position:absolute;left:200px;top:150px;width:520px;height:340px;background:#fff;border:1px solid #ccc">
      <button id="close" aria-label="Close" style="position:absolute;right:10px;top:10px;width:32px;height:32px">×</button>
      <div style="position:absolute;left:20px;top:30px">Delivery window</div>
      <button id="wide" style="position:absolute;left:20px;top:60px;width:480px;height:40px">Pick dates</button>
      <div style="position:absolute;left:20px;top:150px">Message</div>
      <textarea id="msg" style="position:absolute;left:20px;top:180px;width:470px;height:80px"></textarea>
    </div>
  </main>`,
);

/**
 * Scene-start cursor on a tall page: a corner button, a textarea filling most of the viewport (no rest spot next to
 * it), and a button below the fold.
 */
export const CURSOR_TALL_PAGE = page(
  'Cursor on a tall page',
  `<main style="position:relative;height:2400px">
    <button id="corner" style="position:absolute;left:900px;top:20px">Corner</button>
    <textarea id="big" style="position:absolute;left:20px;top:60px;width:860px;height:540px"></textarea>
    <button id="deep" style="position:absolute;left:60px;top:1500px">Deep button</button>
  </main>`,
);

/**
 * A dense form in a dialog (R-MAC-06): selects above, a full-width field, a short label, a textarea below — none of
 * the usual rest spots next to the field is neutral; the gap with the label is.
 */
export const CURSOR_FORM_PAGE = page(
  'Cursor in a form',
  `<main>
    <div role="dialog" aria-modal="true" aria-label="Form" style="position:absolute;left:200px;top:150px;width:520px;height:260px;background:#fff;border:1px solid #ccc">
      <select style="position:absolute;left:20px;top:16px;width:230px;height:40px"><option>Grind</option></select>
      <select style="position:absolute;left:270px;top:16px;width:230px;height:40px"><option>Label</option></select>
      <button id="dates" style="position:absolute;left:20px;top:70px;width:480px;height:40px">Pick dates</button>
      <div style="position:absolute;left:20px;top:120px;font-size:12px">Message</div>
      <textarea style="position:absolute;left:20px;top:140px;width:470px;height:100px"></textarea>
    </div>
  </main>`,
);

/**
 * A popup that opens late (R-MAC-08): a plain button (no aria-haspopup) opens a dialog 450 ms after the click, as a
 * loaded machine would; another plain button opens nothing.
 */
export const LATE_DIALOG_PAGE = page(
  'Late dialog',
  `<main>
    <button id="later" style="position:absolute;left:60px;top:80px">Open later</button>
    <button id="plain" style="position:absolute;left:260px;top:80px">Plain</button>
    <button id="content" style="position:absolute;left:420px;top:80px">Show later</button>
  </main>`,
  `document.getElementById('later').addEventListener('click', () => setTimeout(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Late');
    d.style.cssText = 'position:absolute;left:200px;top:200px;width:400px;height:200px;background:#fff;border:1px solid #ccc';
    d.innerHTML = '<label style="position:absolute;left:20px;top:30px">Name <input id="name"></label>';
    document.body.appendChild(d);
  }, 450));
  document.getElementById('content').addEventListener('click', () => setTimeout(() => {
    const b = document.createElement('button');
    b.textContent = 'Shown later';
    b.style.cssText = 'position:absolute;left:420px;top:300px';
    document.body.appendChild(b);
  }, 300));`,
);

/** Navigation hold: a SPA route change (pushState), a full navigation and a plain button. */
export const NAV_PAGE = page(
  'Navigation',
  `<main><h1 id="view">View one</h1>
    <button id="plain" style="margin:8px">Plain</button>
    <a id="spa" href="/nav.html?view=2" style="margin:8px">Open view two</a>
    <a id="full" href="/nav2.html" style="margin:8px">Go to page two</a></main>`,
  `document.getElementById('spa').addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', '/nav.html?view=2'); document.getElementById('view').textContent = 'View two'; });
   document.getElementById('plain').addEventListener('click', () => { document.getElementById('view').textContent = 'Plain clicked'; });`,
);
export const NAV2_PAGE = page('Page two', `<main><h1>Page two</h1></main>`);

/** Locale: shows navigator.language and the Accept-Language header the server received (filled in by the server). */
export function localePage(acceptLanguage: string): string {
  return page('Locale', `<main><p id="nav"></p><p id="accept">accept=${acceptLanguage.replace(/[<>&]/g, '')}</p></main>`, `document.getElementById('nav').textContent = 'nav=' + navigator.language;`);
}

// ───────────── open shadow roots and same-origin frames (R-ISS-07, R-KIT-11) ─────────────

/** A page whose script runs in <head>: a script at the end of <body> would put its source in the body's text. */
function headPage(title: string, body: string, script: string, css = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}${css}</style><script>${script}</script></head><body>${body}</body></html>`;
}

/**
 * Custom elements with open shadow roots (each instance prefixes its ids with its `prefix` attribute), a nested one,
 * a slotted button, a closed one and one holding an iframe. Rendered when connected (attributes are known then).
 */
const SHADOW_SCRIPT = `
  const def = (name, mode, html, wire) => customElements.get(name) || customElements.define(name, class extends HTMLElement {
    connectedCallback() {
      if (this.__done) return;
      this.__done = true;
      const p = this.getAttribute('prefix') || 'sh';
      const root = this.attachShadow({ mode });
      root.innerHTML = html(p, this);
      if (wire) wire(root, p);
    }
  });
  const STYLE = '<style>:host{display:block;margin:6px 0} button{cursor:pointer;font:inherit;padding:6px 10px;border:1px solid #c9bfb7;border-radius:8px;background:#fff} .gone{display:none}</style>';
  def('nf-stepper', 'open', (p, host) => STYLE +
    '<button id="' + p + '-add">Add</button> <button id="' + p + '-addbag">Add bag</button> ' +
    '<button id="' + p + '-remove" aria-label="Remove bag">-</button> <output id="' + p + '-out">3 bags</output>' +
    '<p><label>Note <input id="' + p + '-note" placeholder="Tasting note"></label> <span data-testid="' + p + '-tid" id="' + p + '-tidspan">Tagged</span></p>' +
    '<span class="gone">Shadow hidden</span>' +
    (host.hasAttribute('dialog') ? '<div role="dialog" id="' + p + '-dlg" style="border:1px solid #c9bfb7;padding:6px"><button id="' + p + '-confirm">Confirm</button></div>' : ''),
    (root, p) => {
      let n = 3;
      const out = root.getElementById(p + '-out');
      root.getElementById(p + '-addbag').addEventListener('click', () => { n++; out.textContent = n + ' bags'; });
      root.getElementById(p + '-remove').addEventListener('click', () => { n--; out.textContent = n + ' bags'; });
    });
  def('nf-badge', 'open', () => STYLE + '<button id="deep-badge">Deep badge</button>');
  def('nf-card', 'open', () => STYLE + '<h3 style="margin:0"><slot name="title"></slot></h3><nf-badge></nf-badge>');
  def('nf-pill', 'open', () => STYLE + '<button id="pill-btn" style="padding:8px 16px"><slot></slot></button>');
  def('nf-closed', 'closed', () => STYLE + '<button>Closed action</button>');
  def('nf-embed', 'open', () => STYLE +
    '<iframe id="emb-frame" style="width:220px;height:64px;border:0" srcdoc="<body style=&quot;margin:0&quot;><button id=&quot;emb&quot; style=&quot;cursor:pointer;width:140px;height:44px&quot;>Embedded</button></body>"></iframe>');
`;

/** The page shown in the #ship frame (and, from another origin, in #cross). */
export const FRAME_PAGE = headPage(
  'Frame',
  `<label for="dest">Destination</label> <select id="dest"><option>Sweden</option><option>Norway</option></select>
  <label style="margin-left:8px">Bags <input id="fbags" style="width:70px"></label>
  <p><button id="fr-add">Add</button> <button id="estimate" style="cursor:pointer">Estimate</button> <span id="out">-</span></p>
  <nf-stepper prefix="fsh"></nf-stepper>
  <div style="height:500px"></div>
  <button id="far">Far in frame</button>
  <iframe id="nested" style="width:260px;height:70px;border:0" srcdoc="<body style=&quot;margin:0&quot;><button id=&quot;nested-btn&quot; style=&quot;cursor:pointer;width:200px;height:44px&quot;>Nested frame button</button></body>"></iframe>`,
  SHADOW_SCRIPT +
    `
  document.addEventListener('DOMContentLoaded', () => {
    const out = document.getElementById('out');
    const dest = document.getElementById('dest');
    dest.addEventListener('change', () => (out.textContent = 'dest=' + dest.value));
    document.getElementById('estimate').addEventListener('click', (e) => {
      window.lastClick = { x: e.clientX, y: e.clientY, view: e.view === window, trusted: e.isTrusted };
      out.textContent = document.getElementById('fbags').value + ' bags to ' + dest.value;
    });
  });
`,
  'body{margin:0;padding:8px}',
);

/** Web components and frames on one page; `cross` is another origin serving FRAME_PAGE. */
export function deepPage(cross: string): string {
  return headPage(
    'Deep',
    `<main style="width:400px;padding:12px">
    <button id="light-add">Add</button>
    <nf-stepper prefix="sh" dialog></nf-stepper>
    <nf-card><span slot="title" id="slotted">Slotted title</span></nf-card>
    <nf-pill><span id="pill-label">Pill label</span></nf-pill>
    <nf-closed></nf-closed>
    <nf-embed></nf-embed>
  </main>
  <iframe id="ship" title="Shipping estimate" src="/frame.html" style="position:absolute;left:420px;top:140px;width:360px;height:220px;border:6px solid #333;padding:10px"></iframe>
  <iframe id="cross" src="${cross}/frame.html" style="position:absolute;left:420px;top:420px;width:300px;height:90px;border:0"></iframe>
  <div style="height:1400px"></div>
  <iframe id="low" style="width:300px;height:80px;border:0" srcdoc="<body style=&quot;margin:0&quot;><button style=&quot;width:160px;height:44px&quot;>Low button</button></body>"></iframe>
  <div id="cover" style="display:none;position:fixed;left:400px;top:120px;width:440px;height:290px;background:rgba(0,0,0,.2)"></div>`,
    SHADOW_SCRIPT,
  );
}

// ───────────── full-page loads (R-ISS-08) ─────────────

/**
 * A page that paints no content for `ms` (default 1 s): a white body and an animated yellow skeleton — no text, image
 * or SVG, so no first contentful paint — then a green block with "Report ready".
 */
export function latePaintPage(ms = 1000): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Late</title>
<style>body{margin:0;background:#fff}#box{position:absolute;left:0;top:0;width:100%;height:100%;background:#f5d000}
.sk{width:300px;height:40px;margin:60px;background:#e0bb00;animation:p .5s infinite alternate}@keyframes p{to{opacity:.4}}</style>
<script>setTimeout(() => { const b = document.getElementById('box'); b.style.background = '#1fae4b'; b.innerHTML = '<h1 style="margin:0;padding:40px;color:#fff;font:600 40px sans-serif">Report ready</h1>'; }, ${ms});</script>
</head><body><div id="box"><div class="sk"></div></div></body></html>`;
}

/** A page that never paints content: solid blue blocks only. */
export const NO_CONTENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Plain</title></head>
<body style="margin:0;background:#3060d0"><div style="width:400px;height:300px;background:#204090"></div></body></html>`;

/** A grey page linking to the late page here, to the late page on another site (`other`), and to the plain page. */
export function navHomePage(other: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body style="margin:0;background:#dde3ea;font-family:sans-serif">
<a id="late" href="/late" style="position:absolute;left:100px;top:100px;font-size:28px;padding:20px;background:#fff">Late here</a>
<a id="away" href="${other}/late" style="position:absolute;left:400px;top:100px;font-size:28px;padding:20px;background:#fff">Late away</a>
<a id="plain" href="/plain" style="position:absolute;left:100px;top:300px;font-size:28px;padding:20px;background:#fff">Plain</a>
<a id="spa" href="#spa" onclick="event.preventDefault(); history.pushState(null, '', '/spa-route'); document.getElementById('late').textContent = 'Routed';" style="position:absolute;left:400px;top:300px;font-size:28px;padding:20px;background:#fff">Route</a>
</body></html>`;
}

// ───────────── choreography helpers (R-CHO-10/13/14/15/18/21) ─────────────

/**
 * Row menus whose triggers misbehave (Norway ignores clicks for 1.5 s after the first attempt; Denmark's items arrive
 * 3.5 s after it opens; Finland has a clickable icon span, no button; Estonia's trigger shows on hover only, next to a
 * visible "View"; Latvia is a clickable row with nothing else; a card header with a corner icon), a late listbox with
 * a search field, an editable combobox that opens on input, typing fields, a React-like controlled input (value
 * tracker emulation, select-all blocked), a "Save draft" that adds a banner and a toast, and an Awards heading far
 * below. A manual popover (tips) stays open the whole time.
 */
export const CHOREO_PAGE = page(
  'Lots',
  `<main>
  <h1>Lots</h1>
  <table id="tbl">
    <tr><td>Norway</td><td>Active</td><td><button class="late" aria-haspopup="menu" aria-label="Row actions" data-row="Norway">⋯</button></td></tr>
    <tr><td>Denmark</td><td>Active</td><td><button aria-haspopup="menu" aria-label="Row actions" data-row="Denmark" data-slow="1">⋯</button></td></tr>
    <tr><td>Finland</td><td>Active</td><td><span class="kebab" data-row="Finland">⋮</span></td></tr>
    <tr class="hover-row"><td>Estonia</td><td><button class="view">View</button></td><td><button class="reveal" aria-haspopup="menu" aria-label="Row actions" data-row="Estonia">⋯</button></td></tr>
    <tr class="clickable"><td>Latvia</td><td>Active</td><td>12 lots</td></tr>
  </table>
  <div role="menu" id="menu" hidden></div>
  <section class="panel"><header class="panel-head"><h3>Stock report</h3><p>Updated every hour from the roasting plan.</p><span class="corner" data-row="Stock report">⋯</span></header></section>
  <p><button id="late-region" role="combobox" aria-haspopup="listbox" aria-expanded="false">Choose a region</button>
     <input id="origin" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-label="Origin"></p>
  <div id="region-pop" role="listbox" hidden><input id="region-search" placeholder="Search regions"><div role="option">Highlands</div><div role="option">Lowlands</div></div>
  <div id="origin-list" role="listbox" hidden></div>
  <p><input type="search" id="q" placeholder="Search lots"> <input id="filter" placeholder="Filter lots"> <input id="plain" aria-label="Lot name" value="Draft lot"> <input id="empty" aria-label="Batch"></p>
  <p><input id="controlled" aria-label="Producer"> <output id="echo"></output></p>
  <p><textarea id="notes" aria-label="Notes"></textarea></p>
  <p><button id="save">Save draft</button></p>
  <div id="banner-slot"></div>
  <p id="log"></p>
  <div style="height:1400px"></div>
  <h2 id="awards">Awards</h2>
  <div style="height:600px"></div>
</main>
<div id="tips" popover="manual">Tip: every row has actions</div>`,
  `
  const log = (m) => (document.getElementById('log').textContent += m + ' ');
  document.getElementById('tips').showPopover();
  const menu = document.getElementById('menu');
  const ITEMS = { Norway: ['Pause', 'Edit'], Denmark: ['Pause', 'Archive'], Finland: ['Archive'], Estonia: ['Edit'], 'Stock report': ['Export'] };
  let menuFor = null;
  function openMenu(t) {
    menuFor = t;
    const r = t.getBoundingClientRect();
    menu.style.left = Math.max(8, r.right - 170) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    const fill = () => { menu.innerHTML = ITEMS[t.dataset.row].map((i) => '<div role="menuitem" tabindex="-1">' + i + '</div>').join(''); };
    if (t.dataset.slow) { menu.innerHTML = '<div>Loading…</div>'; setTimeout(fill, 3500); } else fill();
    menu.hidden = false;
    if (t.hasAttribute('aria-haspopup')) t.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() { menu.hidden = true; if (menuFor && menuFor.hasAttribute('aria-haspopup')) menuFor.setAttribute('aria-expanded', 'false'); menuFor = null; }
  let firstTry = 0;
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-row]');
    if (!t) return;
    if (t.classList.contains('late')) {
      const now = performance.now();
      if (!firstTry) firstTry = now;
      if (now - firstTry < 1500) { log('ignored'); return; }
    }
    openMenu(t);
  });
  menu.addEventListener('click', (e) => { const i = e.target.closest('[role=menuitem]'); if (!i) return; log(menuFor.dataset.row + ':' + i.textContent); closeMenu(); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('#menu,[data-row]')) closeMenu(); }, true);
  document.querySelector('tr.clickable').addEventListener('click', () => log('Latvia-details'));

  const lr = document.getElementById('late-region'), rp = document.getElementById('region-pop');
  let lrFirst = 0;
  lr.addEventListener('click', () => {
    const now = performance.now();
    if (!lrFirst) lrFirst = now;
    if (now - lrFirst < 1500) { log('region-ignored'); return; }
    const r = lr.getBoundingClientRect();
    rp.style.left = r.left + 'px'; rp.style.top = r.bottom + 4 + 'px';
    rp.hidden = false; lr.setAttribute('aria-expanded', 'true');
    document.getElementById('region-search').focus();
  });
  document.getElementById('region-search').addEventListener('input', (e) => {
    for (const o of rp.querySelectorAll('[role=option]')) o.hidden = !o.textContent.toLowerCase().includes(e.target.value.toLowerCase());
  });
  rp.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; lr.textContent = o.textContent; rp.hidden = true; lr.setAttribute('aria-expanded', 'false'); log('region=' + o.textContent); });

  const og = document.getElementById('origin'), ol = document.getElementById('origin-list');
  og.addEventListener('input', () => {
    const v = og.value.toLowerCase();
    const hits = ['Ethiopia', 'Kenya', 'Colombia'].filter((n) => n.toLowerCase().includes(v));
    ol.innerHTML = hits.map((h) => '<div role="option">' + h + '</div>').join('');
    const r = og.getBoundingClientRect();
    ol.style.left = r.left + 'px'; ol.style.top = r.bottom + 4 + 'px';
    ol.hidden = !v || !hits.length;
    og.setAttribute('aria-expanded', String(!ol.hidden));
  });
  ol.addEventListener('mousedown', (e) => e.preventDefault());
  ol.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (!o) return; og.value = o.textContent; ol.hidden = true; og.setAttribute('aria-expanded', 'false'); log('origin=' + o.textContent); });

  // A React-like controlled input: an instance value setter feeds the value tracker; an input event whose value equals
  // the tracked one changes nothing and the value is restored from the state (as React re-renders it), also on keydown.
  const ct = document.getElementById('controlled'), echo = document.getElementById('echo');
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let state = 'Old value', tracked = '';
  Object.defineProperty(ct, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = String(v); proto.set.call(this, v); } });
  const render = () => { if (proto.get.call(ct) !== state) ct.value = state; else tracked = state; echo.textContent = 'state=' + state; };
  render();
  ct.addEventListener('input', () => { const v = proto.get.call(ct); if (v !== tracked) { tracked = v; state = v; } render(); });
  ct.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); return; } render(); }, true);

  document.getElementById('save').addEventListener('click', () => {
    const b = document.createElement('div'); b.id = 'banner'; b.textContent = 'Draft saved: 3 lots updated'; document.getElementById('banner-slot').appendChild(b);
    const t = document.createElement('div'); t.id = 'toast'; t.textContent = 'Saved'; document.body.appendChild(t);
  });
`,
  `table{border-collapse:collapse} td{padding:6px 12px;border-bottom:1px solid #ddd}
  .kebab{cursor:pointer;padding:2px 8px} .hover-row .reveal{opacity:0} .hover-row:hover .reveal{opacity:1} tr.clickable{cursor:pointer}
  #menu{position:fixed;background:#fff;border:1px solid #ccc;border-radius:8px;padding:4px;width:160px;z-index:5} #menu [role=menuitem]{padding:6px 10px;cursor:pointer}
  .panel{width:420px;border:1px solid #ccc;border-radius:10px;margin:12px 0} .panel-head{position:relative;height:96px;padding:10px 14px} .panel-head h3,.panel-head p{margin:4px 0}
  .corner{position:absolute;right:8px;top:6px;cursor:pointer;padding:2px 6px}
  #region-pop,#origin-list{position:fixed;background:#fff;border:1px solid #ccc;border-radius:8px;padding:4px;width:200px;z-index:5} [role=option]{padding:6px 10px;cursor:pointer}
  #tips{position:fixed;left:8px;bottom:8px;top:auto;right:auto;margin:0;padding:6px 10px;border:1px solid #ccc;background:#fffbe6;font-size:13px}
  #banner{padding:12px;background:#e6f4ea;border:1px solid #9c9;width:360px}
  #toast{position:fixed;right:16px;bottom:16px;padding:10px 14px;background:#222;color:#fff;border-radius:8px}`,
);

// ───────────── calendars (R-CHO-24) ─────────────

/**
 * Date pickers: an inline mini calendar first (January 2027, day cells known by `data-date` only, its own "Next
 * month"), then two range fields whose two-month popover (day cells known by aria-label only: "Sunday, 10 January
 * 2027") has a hidden "Next month" on its left month and a visible one on its right month (and the mirror for
 * "Previous month"); days before 5 October 2026 are disabled. The popover closes 420 ms after the second day with a
 * 250 ms fade. Delivery window opens on October 2026, Roasting window on February 2027. And a native date input.
 */
export const CALENDAR_PAGE = page(
  'Calendar',
  `<main>
  <h1>Delivery</h1>
  <section id="mini"></section>
  <p><span id="dl">Delivery window</span> <button id="delivery" aria-labelledby="dl" aria-haspopup="dialog" aria-expanded="false" data-key="delivery" data-y="2026" data-m="9">Select dates</button>
     <span id="rl">Roasting window</span> <button id="roasting" aria-labelledby="rl" aria-haspopup="dialog" aria-expanded="false" data-key="roasting" data-y="2027" data-m="1">Select dates</button></p>
  <p><label>Tasting day <input type="date" id="tasting" min="2026-10-01"></label></p>
  <p><output id="out"></output></p>
</main>`,
  `
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MIN = '2026-10-05';
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d);
  const label = (y, m, d) => WD[new Date(Date.UTC(y, m, d)).getUTCDay()] + ', ' + d + ' ' + MONTHS[m] + ' ' + y;
  const add = (y, m, n) => { const t = y * 12 + m + n; return [Math.floor(t / 12), t % 12]; };
  const values = { delivery: {}, roasting: {}, mini: null };
  const out = () => { document.getElementById('out').textContent = ['delivery', 'roasting'].map((k) => k + '=' + (values[k].start || '') + '..' + (values[k].end || '')).join(' ') + ' mini=' + (values.mini || ''); };
  function grid(y, m, prev, next, byAria) {
    const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let h = '<div class="month"><div class="mhead"><button class="nav prev" aria-label="Previous month" style="visibility:' + (prev ? 'visible' : 'hidden') + '">‹</button><b>' + MONTHS[m] + ' ' + y + '</b><button class="nav next" aria-label="Next month" style="visibility:' + (next ? 'visible' : 'hidden') + '">›</button></div><div class="grid">';
    for (let d = 1; d <= n; d++) {
      const v = iso(y, m, d);
      h += byAria ? '<button class="day" data-k="' + v + '" aria-label="' + label(y, m, d) + '"' + (v < MIN ? ' disabled' : '') + '>' + d + '</button>' : '<span class="day" data-date="' + v + '">' + d + '</span>';
    }
    return h + '</div></div>';
  }
  // The inline mini calendar (January 2027 and on).
  let mini = [2027, 0];
  const miniEl = document.getElementById('mini');
  const drawMini = () => { miniEl.innerHTML = grid(mini[0], mini[1], false, true, false); };
  drawMini();
  miniEl.addEventListener('click', (e) => {
    if (e.target.closest('.next')) { mini = add(mini[0], mini[1], 1); drawMini(); return; }
    const d = e.target.closest('[data-date]');
    if (d) { values.mini = d.dataset.date; out(); }
  });
  // The range popovers.
  let pop = null;
  function close(now) {
    if (!pop) return;
    const p = pop;
    pop = null;
    document.getElementById(p.key).setAttribute('aria-expanded', 'false');
    if (now) { p.el.remove(); return; }
    p.el.style.transition = 'opacity .25s';
    p.el.style.opacity = '0';
    setTimeout(() => p.el.remove(), 250);
  }
  function draw() {
    const [y2, m2] = add(pop.y, pop.m, 1);
    pop.el.innerHTML = '<div class="months">' + grid(pop.y, pop.m, true, false, true) + grid(y2, m2, false, true, true) + '</div>';
  }
  for (const t of document.querySelectorAll('[data-key]')) {
    t.addEventListener('click', () => {
      if (pop && pop.key === t.dataset.key) { close(true); return; }
      close(true);
      const el = document.createElement('div');
      el.setAttribute('role', 'dialog');
      el.setAttribute('data-side', 'bottom');
      el.setAttribute('aria-label', 'Choose dates');
      el.className = 'pop';
      const r = t.getBoundingClientRect();
      el.style.left = Math.min(r.left, innerWidth - 560) + 'px';
      el.style.top = r.bottom + 6 + 'px';
      document.body.appendChild(el);
      pop = { key: t.dataset.key, y: +t.dataset.y, m: +t.dataset.m, el };
      t.setAttribute('aria-expanded', 'true');
      draw();
      el.addEventListener('click', (e) => {
        if (!pop || pop.el !== el) return;
        if (e.target.closest('.next')) { [pop.y, pop.m] = add(pop.y, pop.m, 1); draw(); return; }
        if (e.target.closest('.prev')) { [pop.y, pop.m] = add(pop.y, pop.m, -1); draw(); return; }
        const b = e.target.closest('.day');
        if (!b || b.disabled) return;
        const day = b.dataset.k;
        const v = values[pop.key];
        if (!v.start || v.end || day < v.start) { v.start = day; v.end = null; }
        else { v.end = day; setTimeout(() => close(false), 420); }
        out();
      });
    });
  }
  document.addEventListener('pointerdown', (e) => { if (pop && !e.target.closest('.pop,[data-key]')) close(true); }, true);
  document.getElementById('tasting').addEventListener('change', (e) => { document.getElementById('out').textContent += ' tasting=' + e.target.value; });
  out();
`,
  `.month{display:inline-block;vertical-align:top;margin:4px 8px;width:250px} .mhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px} .day{padding:4px 0;text-align:center;border:1px solid #eee;border-radius:6px;background:#fff;font-size:13px;cursor:pointer}
  .day:disabled{color:#bbb} .nav{padding:2px 8px}
  .pop{position:fixed;background:#fff;border:1px solid #ccc;border-radius:10px;padding:6px;width:560px;z-index:5}`,
);

// ───────────── review fixes of L1.2 (popovers, editors, library-shaped date pickers) ─────────────

/**
 * A floating "Filters" popover (role=dialog + data-side, as Radix renders one) holding a "Tags" multi-select whose
 * listbox is portaled next to it (a click in it does not dismiss the popover; a click on the popover title closes
 * the listbox only; a click on the page closes both), a rename field, and an "Account" menu shown on hover.
 */
export const POPOVER_PAGE = page(
  'Lots',
  `<main>
  <h1>Lots</h1>
  <p><button id="filters" aria-haspopup="dialog" aria-expanded="false">Filters</button>
     <span class="acct">Account<span role="menu" id="acct-menu"><span role="menuitem">Profile</span><span role="menuitem">Sign out</span></span></span></p>
  <p id="log"></p>
  <div style="height:400px"></div>
</main>
<div id="pop" role="dialog" data-side="bottom" aria-labelledby="pop-t" hidden>
  <h3 id="pop-t">Filter lots</h3>
  <p><span id="tags-l">Tags</span> <button id="tags" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="tags-l">Any tag</button></p>
  <p><label>View name <input id="rename" value="My lots"></label></p>
  <button id="apply">Apply</button>
</div>
<div id="tags-list" role="listbox" aria-multiselectable="true" hidden><div role="option">Washed</div><div role="option">Natural</div><div role="option">Honey</div></div>`,
  `
  const log = (m) => (document.getElementById('log').textContent += m + ' ');
  const f = document.getElementById('filters'), pop = document.getElementById('pop');
  const tags = document.getElementById('tags'), list = document.getElementById('tags-list');
  const chosen = new Set();
  const closeList = () => { list.hidden = true; tags.setAttribute('aria-expanded', 'false'); };
  const closePop = () => { closeList(); pop.hidden = true; f.setAttribute('aria-expanded', 'false'); };
  f.addEventListener('click', () => {
    if (!pop.hidden) { closePop(); return; }
    const r = f.getBoundingClientRect();
    pop.style.left = r.left + 'px'; pop.style.top = r.bottom + 6 + 'px';
    pop.hidden = false; f.setAttribute('aria-expanded', 'true');
  });
  tags.addEventListener('click', () => {
    if (!list.hidden) { closeList(); return; }
    const r = tags.getBoundingClientRect();
    list.style.left = r.left + 'px'; list.style.top = r.bottom + 4 + 'px';
    list.hidden = false; tags.setAttribute('aria-expanded', 'true');
  });
  list.addEventListener('click', (e) => {
    const o = e.target.closest('[role=option]');
    if (!o) return;
    if (chosen.has(o.textContent)) chosen.delete(o.textContent); else chosen.add(o.textContent);
    o.setAttribute('aria-selected', String(chosen.has(o.textContent)));
    log('tags=' + [...chosen].join(','));
  });
  // Dismissable layers: the listbox closes on a press outside it (and its trigger); the popover on a press outside
  // it, its trigger and its portaled listbox.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!list.hidden && !t.closest('#tags-list,#tags')) closeList();
    if (!pop.hidden && !t.closest('#pop,#tags-list,#filters')) { closePop(); log('popover-closed'); }
  }, true);
`,
  `#pop{position:fixed;width:340px;background:#fff;border:1px solid #ccc;border-radius:10px;padding:10px 14px;z-index:5} #pop h3{margin:2px 0 8px}
  #tags-list{position:fixed;width:180px;background:#fff;border:1px solid #999;border-radius:8px;padding:4px;z-index:6} [role=option]{display:block;padding:6px 10px;cursor:pointer}
  .acct{position:relative;margin-left:420px;padding:6px 10px;border:1px solid #ccc;border-radius:8px;cursor:default}
  #acct-menu{display:none;position:absolute;left:0;top:100%;width:140px;background:#fff;border:1px solid #ccc;border-radius:8px;padding:4px}
  .acct:hover #acct-menu{display:block} [role=menuitem]{display:block;padding:6px 10px}`,
);

/**
 * Rich-text editors: a frame whose body is contenteditable (the TinyMCE / CKEditor 4 shape), a frame in designMode,
 * and a code editor drawing its text in a <pre> while the keys go to a textarea clipped to a 3 × 0 px box (the
 * CodeMirror 5 shape: select-all + Backspace empty it, typed text is appended).
 */
export const EDITOR_PAGE = page(
  'Editors',
  `<main>
  <h1>Tasting notes</h1>
  <iframe id="rich" src="/rich-frame.html" title="Notes editor"></iframe>
  <iframe id="design" src="/design-frame.html" title="Summary editor"></iframe>
  <div id="cm" class="cm"><div class="cm-wrap"><textarea id="cm-input" autocorrect="off" spellcheck="false" tabindex="0"></textarea></div><pre id="cm-text">roast(old)</pre></div>
</main>`,
  `
  const input = document.getElementById('cm-input'), text = document.getElementById('cm-text');
  let code = 'roast(old)', all = false;
  const render = () => { text.textContent = code; };
  document.getElementById('cm').addEventListener('mousedown', (e) => { e.preventDefault(); input.focus(); });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); all = true; return; }
    if (e.key === 'Backspace') { e.preventDefault(); code = all ? '' : code.slice(0, -1); all = false; render(); return; }
  });
  input.addEventListener('input', () => { code += input.value; input.value = ''; all = false; render(); });
`,
  `iframe{display:block;width:560px;height:90px;border:1px solid #c9bfb7;margin:8px 0;background:#fff}
  .cm{position:relative;width:560px;border:1px solid #c9bfb7;background:#fff;cursor:text}
  .cm-wrap{overflow:hidden;position:relative;width:3px;height:0;top:4px;left:4px}
  .cm-wrap textarea{position:absolute;bottom:-1em;padding:0;width:1000px;height:1em;outline:none}
  #cm-text{margin:0;padding:8px;font:14px ui-monospace,monospace;min-height:20px}`,
);
export const RICH_FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body contenteditable="true" style="font:15px system-ui;margin:8px"><p>Old rich text</p></body></html>`;
export const DESIGN_FRAME = `<!doctype html><html><head><meta charset="utf-8"><script>document.designMode = 'on';</script></head><body style="font:15px system-ui;margin:8px">Old design text</body></html>`;

/**
 * Date pickers shaped like two common libraries (hand-written markup, no library): an inline calendar inside a wizard
 * form whose month arrows are spans classed prev / next (flatpickr's DOM) above the form's own "Back" and submit
 * "Next" buttons; and a popper (role=dialog) showing two months, each month a role=listbox of role=option days, the
 * month buttons on the popper outside both listboxes (react-datepicker's DOM, monthsShown 2): days before 5 October
 * 2026 disabled, days of adjacent months shown and marked outside-month, closes when a day is chosen.
 */
export const PICKERS_PAGE = page(
  'Pickers',
  `<main>
  <form id="wizard"><h2>Step 2 of 3: roasting</h2>
    <div class="field"><span>Roast date</span>
      <div class="flatpickr-calendar inline">
        <div class="flatpickr-months"><span class="flatpickr-prev-month"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 2 4 7l5 5" stroke="#333" fill="none"/></svg></span><div class="flatpickr-month" id="fp-month"></div><span class="flatpickr-next-month"><svg width="14" height="14" viewBox="0 0 14 14"><path d="m5 2 5 5-5 5" stroke="#333" fill="none"/></svg></span></div>
        <div class="flatpickr-innerContainer"><div class="flatpickr-days"><div class="dayContainer" id="fp-days"></div></div></div>
      </div>
    </div>
    <div class="actions"><button type="button" id="back">Back</button> <button type="submit" id="next">Next</button></div>
  </form>
  <p><label for="dd">Delivery date</label> <input id="dd" readonly placeholder="Choose a date"></p>
  <p id="log"></p>
</main>
<div id="rdp" class="react-datepicker-popper" data-placement="bottom-start" hidden>
  <div class="react-datepicker" role="dialog" aria-label="Choose Date" aria-modal="true">
    <button type="button" class="react-datepicker__navigation react-datepicker__navigation--previous" aria-label="Previous Month"><span class="react-datepicker__navigation-icon react-datepicker__navigation-icon--previous">‹</span></button>
    <button type="button" class="react-datepicker__navigation react-datepicker__navigation--next" aria-label="Next Month"><span class="react-datepicker__navigation-icon react-datepicker__navigation-icon--next">›</span></button>
    <div id="rdp-months" class="rdp-months"></div>
  </div>
</div>`,
  `
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d);
  const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const add = (y, m, n) => { const t = y * 12 + m + n; return [Math.floor(t / 12), t % 12]; };
  const ord = (d) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');
  const log = (m) => (document.getElementById('log').textContent += m + ' ');
  // The inline calendar of the wizard.
  let fp = [2026, 9];
  const drawFp = () => {
    const [y, m] = fp;
    document.getElementById('fp-month').textContent = MONTHS[m] + ' ' + y;
    let h = '';
    for (let d = 1; d <= dim(y, m); d++) h += '<span class="flatpickr-day" tabindex="-1" data-k="' + iso(y, m, d) + '" aria-label="' + MONTHS[m] + ' ' + d + ', ' + y + '">' + d + '</span>';
    document.getElementById('fp-days').innerHTML = h;
  };
  drawFp();
  document.querySelector('.flatpickr-prev-month').addEventListener('click', () => { fp = add(fp[0], fp[1], -1); drawFp(); });
  document.querySelector('.flatpickr-next-month').addEventListener('click', () => { fp = add(fp[0], fp[1], 1); drawFp(); });
  document.getElementById('fp-days').addEventListener('click', (e) => { const d = e.target.closest('.flatpickr-day'); if (d) log('roast=' + d.dataset.k); });
  document.getElementById('wizard').addEventListener('submit', (e) => { e.preventDefault(); log('wizard-submitted'); });
  document.getElementById('back').addEventListener('click', () => log('went-back'));
  // The two-month popper.
  const MIN = '2026-10-05';
  const dd = document.getElementById('dd'), rdp = document.getElementById('rdp');
  let at = [2026, 9], picked = null;
  const day = (y, m, d, outside) => {
    const k = iso(y, m, d), off = k < MIN;
    const wd = WD[new Date(Date.UTC(y, m, d)).getUTCDay()];
    return '<div class="react-datepicker__day react-datepicker__day--0' + pad(d) + (outside ? ' react-datepicker__day--outside-month' : '') + (off ? ' react-datepicker__day--disabled' : '') +
      '" role="option" tabindex="-1" aria-disabled="' + off + '" aria-selected="' + (k === picked) + '" data-k="' + k + '" aria-label="' + (off ? 'Not available ' : 'Choose ') + wd + ', ' + MONTHS[m] + ' ' + ord(d) + ', ' + y + '">' + d + '</div>';
  };
  const month = (y, m) => {
    const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const [py, pm] = add(y, m, -1), [ny, nm] = add(y, m, 1);
    const cells = [];
    for (let i = lead - 1; i >= 0; i--) cells.push(day(py, pm, dim(py, pm) - i, true));
    for (let d = 1; d <= dim(y, m); d++) cells.push(day(y, m, d, false));
    for (let d = 1; cells.length % 7; d++) cells.push(day(ny, nm, d, true));
    let h = '<div class="react-datepicker__month-container"><div class="react-datepicker__header"><h2 class="react-datepicker__current-month">' + MONTHS[m] + ' ' + y + '</h2></div><div class="react-datepicker__month" role="listbox" aria-label="month  ' + y + '-' + pad(m + 1) + '">';
    for (let i = 0; i < cells.length; i += 7) h += '<div class="react-datepicker__week">' + cells.slice(i, i + 7).join('') + '</div>';
    return h + '</div></div>';
  };
  const drawRdp = () => { const [y2, m2] = add(at[0], at[1], 1); document.getElementById('rdp-months').innerHTML = month(at[0], at[1]) + month(y2, m2); };
  const openRdp = () => {
    if (!rdp.hidden) return;
    if (picked) at = [+picked.slice(0, 4), +picked.slice(5, 7) - 1];
    drawRdp();
    const r = dd.getBoundingClientRect();
    rdp.style.left = r.left + 'px'; rdp.style.top = r.bottom + window.scrollY + 4 + 'px';
    rdp.hidden = false;
  };
  dd.addEventListener('click', openRdp);
  rdp.addEventListener('click', (e) => {
    if (e.target.closest('.react-datepicker__navigation--previous')) { at = add(at[0], at[1], -1); drawRdp(); return; }
    if (e.target.closest('.react-datepicker__navigation--next')) { at = add(at[0], at[1], 1); drawRdp(); return; }
    const d = e.target.closest('.react-datepicker__day');
    if (!d || d.getAttribute('aria-disabled') === 'true') return;
    picked = d.dataset.k;
    dd.value = picked.slice(5, 7) + '/' + picked.slice(8) + '/' + picked.slice(0, 4);
    log('delivery=' + picked);
    rdp.hidden = true;
  });
  document.addEventListener('pointerdown', (e) => { if (!rdp.hidden && !e.target.closest('.react-datepicker,#dd')) rdp.hidden = true; }, true);
`,
  `.flatpickr-calendar{width:308px;border:1px solid #ccc;border-radius:8px;background:#fff;padding:6px;margin:6px 0}
  .flatpickr-months{display:flex;justify-content:space-between;align-items:center;height:34px}
  .flatpickr-prev-month,.flatpickr-next-month{display:inline-block;padding:8px 10px;cursor:pointer;line-height:0}
  .dayContainer{display:flex;flex-wrap:wrap} .flatpickr-day{display:inline-block;width:40px;text-align:center;padding:4px 0;cursor:pointer;font-size:13px}
  .actions{margin-top:10px}
  .react-datepicker-popper{position:absolute;z-index:5}
  .react-datepicker{position:relative;display:inline-block;background:#fff;border:1px solid #aaa;border-radius:6px;padding:4px 6px 8px;font-size:13px}
  .react-datepicker__navigation{position:absolute;top:4px;padding:2px 8px;z-index:1} .react-datepicker__navigation--previous{left:6px} .react-datepicker__navigation--next{right:6px}
  .rdp-months{display:flex} .react-datepicker__month-container{width:238px;margin:0 4px}
  .react-datepicker__current-month{font-size:14px;text-align:center;margin:6px 0 8px}
  .react-datepicker__week{display:flex} .react-datepicker__day{width:32px;text-align:center;padding:4px 0;cursor:pointer}
  .react-datepicker__day--outside-month{color:#aaa} .react-datepicker__day--disabled{color:#ccc;cursor:default}`,
);

/**
 * Capture sizes (L1.4, R-GOAL-01): the page writes the size it laid out at and its device pixel ratio; a narrow layout
 * (≤ 600 px, a phone) shows its own button in place of the wide one.
 */
export const SIZES_PAGE = page(
  'Sizes',
  `<main><h1>Price lists</h1><p id="vp"></p>
  <button class="wide" style="position:absolute;left:58%;top:46%">Continue</button>
  <button class="narrow" style="position:absolute;left:34%;top:52%">Menu</button></main>`,
  `const vp = () => (document.getElementById('vp').textContent = 'viewport ' + innerWidth + 'x' + innerHeight + ' @' + devicePixelRatio);
  vp(); addEventListener('resize', vp);`,
  `.narrow{display:none} @media (max-width: 600px){.wide{display:none} .narrow{display:inline-block}}`,
);

/**
 * The cursor and file-chip look (L1.4, R-LOOK-23/24): one flat mid-grey page, so the dark arrow's white outline, the
 * light arrow's dark outline, the soft shadow, the ripple's accent and the white chip all stand out from it (a small
 * label in the corner is the page's first contentful paint: the cursor is drawn from then on).
 */
export const LOOK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Look</title>
<style>html,body{margin:0;height:100%;background:#9aa3ad}</style></head><body><p style="position:absolute;right:8px;bottom:0;margin:0;font:11px system-ui">Look</p></body></html>`;
