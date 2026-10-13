// <nf-brew-guide coffee="…">: a vanilla web component with an OPEN shadow root and its own stylesheet, so the
// runner's resolver is filmed finding targets inside a component (R-ISS-07). Its buttons get their pointer cursor
// from the shadow stylesheet only (the page's styles do not reach them).
//
// State: a method (Filter or Espresso, each starting at 18 g of coffee) and a dose stepped by 1 g.
//   Filter   → "18 g coffee · 300 g water · 2:30"  (1:16.7)
//   Espresso → "18 g coffee · 36 g out · 28 s"     (1:2); twice "More coffee" → "20 g coffee · 40 g out · 28 s"

const METHODS = {
  filter: { label: 'Filter', ratio: 50 / 3, min: 10, max: 30, line: (dose, out) => `${dose} g coffee · ${out} g water · 2:30` },
  espresso: { label: 'Espresso', ratio: 2, min: 14, max: 24, line: (dose, out) => `${dose} g coffee · ${out} g out · 28 s` },
};
const START_DOSE = 18;

const STYLE = `
  :host { display: block; }
  .card { background: var(--surface, #fffefc); border: 1px solid var(--line, #ece4da); border-radius: 18px; padding: 26px 28px;
          box-shadow: var(--shadow-sm, none); font-family: var(--font-sans, system-ui, sans-serif); color: var(--text, #221714); }
  h2 { margin: 0; font-family: var(--font-serif, Georgia, serif); font-weight: 500; font-size: 27px; letter-spacing: -0.01em; }
  .sub { margin: 4px 0 20px; color: var(--muted, #8b7e77); font-size: 14.5px; }
  .row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .seg { display: inline-flex; padding: 3px; border-radius: 11px; background: var(--bg-sunken, #f0e9e1); }
  .seg button { border: 0; background: transparent; padding: 8px 16px; border-radius: 8px; font: inherit; font-weight: 600;
                font-size: 14px; color: var(--text-2, #4e423d); cursor: pointer; }
  .seg button[aria-pressed='true'] { background: var(--surface, #fff); color: var(--text, #221714); box-shadow: var(--shadow-sm, none); }
  .dose { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong, #ddd1c3); border-radius: 11px; padding: 3px; }
  .dose button { width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent; font: inherit; font-size: 19px;
                 line-height: 1; color: var(--text, #221714); cursor: pointer; }
  .dose button:hover, .seg button:hover { background: var(--surface-hover, #f8f3ed); }
  .dose output { min-width: 52px; text-align: center; font-weight: 650; font-variant-numeric: tabular-nums; }
  .recipe { margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: var(--accent-tint, #fbf3f1);
            color: var(--accent-700, #46121b); font-weight: 600; font-size: 16px; font-variant-numeric: tabular-nums; }
  .foot { margin-top: 16px; display: flex; align-items: center; gap: 12px; }
  .copy { border: 1px solid var(--line-strong, #ddd1c3); background: var(--surface, #fff); border-radius: 10px; padding: 9px 15px;
          font: inherit; font-weight: 600; font-size: 14px; color: var(--text, #221714); cursor: pointer; }
  .done { color: var(--green, #2d6a4b); font-weight: 600; font-size: 14px; }
`;

class BrewGuide extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.method = 'filter';
    this.dose = START_DOSE;
    const root = this.attachShadow({ mode: 'open' });
    const coffee = this.getAttribute('coffee') || 'this coffee';
    root.innerHTML = `<style>${STYLE}</style>
      <div class="card">
        <h2>Brew guide</h2>
        <p class="sub"></p>
        <div class="row">
          <div class="seg" role="group" aria-label="Brew method">
            <button type="button" data-method="filter">Filter</button><button type="button" data-method="espresso">Espresso</button>
          </div>
          <div class="dose">
            <button type="button" aria-label="Less coffee">−</button><output></output><button type="button" aria-label="More coffee">+</button>
          </div>
        </div>
        <div class="recipe" aria-live="polite"></div>
        <div class="foot"><button type="button" class="copy">Copy recipe</button><span class="done" hidden>Recipe copied</span></div>
      </div>`;
    root.querySelector('.sub').textContent = `Dial in ${coffee} for your bar.`;
    for (const b of root.querySelectorAll('[data-method]')) {
      b.addEventListener('click', () => {
        this.method = b.dataset.method;
        this.dose = START_DOSE;
        this.render();
      });
    }
    const step = (d) => () => {
      const m = METHODS[this.method];
      this.dose = Math.min(m.max, Math.max(m.min, this.dose + d));
      this.render();
    };
    root.querySelector('[aria-label="Less coffee"]').addEventListener('click', step(-1));
    root.querySelector('[aria-label="More coffee"]').addEventListener('click', step(1));
    const done = root.querySelector('.done');
    root.querySelector('.copy').addEventListener('click', () => {
      done.hidden = false;
      clearTimeout(this.doneTimer);
      this.doneTimer = setTimeout(() => (done.hidden = true), 4000);
    });
    this.render();
  }

  render() {
    const root = this.shadowRoot;
    const m = METHODS[this.method];
    for (const b of root.querySelectorAll('[data-method]')) b.setAttribute('aria-pressed', String(b.dataset.method === this.method));
    root.querySelector('output').textContent = `${this.dose} g`;
    root.querySelector('.recipe').textContent = m.line(this.dose, Math.round(this.dose * m.ratio));
    root.querySelector('.done').hidden = true;
  }
}

if (!customElements.get('nf-brew-guide')) customElements.define('nf-brew-guide', BrewGuide);
