/**
 * L4.9 part A: the accessibility checker's own tests (headless Chromium, `page.setContent`): each rule fires on its
 * planted case and stays silent on its clean twin, and its contrast maths is `contrastRatio`'s
 * (`@demo-studio/components/kit`). The planted cases are the regressions the critique named: text over a picture whose
 * overlay is too thin (only visible when the picture is dark), a chip whose visible ring rule is gone (the invisible
 * input still carries the global outline), text of a disabled container that is not itself a control — and the review's
 * probes (L4.9 fixes): a faded dark card, an unreadable colour space, pseudo-element and submit text, status colour on a
 * mark beside unrelated words or on rows differing by colour alone, a selected state carried by a tint, a transparent /
 * faint / tinted / covered focus indicator, a truncated walk, a lost roving stop, a shared tab stop the arrows do not
 * cross, focusable content under aria-hidden, a picture with no alt, a second level-1 role heading, a non-modal dialog,
 * a screen still loading.
 */
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio } from '@demo-studio/components/kit';
import { auditPage, dialogCheck, familyWalk, formatFindings, pageRatio, settle, tabWalk } from './a11y.js';
import type { Finding, Rule } from './a11y.js';

let browser: Browser;
let page: Page;

const ROOT = ':root{--danger:#b42318;--danger-soft:#fdecea;--warning:#8a5300;--info:#1f5fae;--success:#1d6b3a;--success-soft:#e6f4ea;--online:#2e9a5a} body{margin:0;font:14px/1.5 sans-serif;background:#fff;color:#16181d}';

async function on(html: string, width = 1000): Promise<void> {
  await page.setViewportSize({ width, height: 700 });
  await page.setContent(`<!doctype html><html lang="en"><head><style>${ROOT}</style></head><body><main><h1>Fixture</h1>${html}</main></body></html>`);
}
const of = (findings: Finding[], rule: Rule) => findings.filter((f) => f.rule === rule);
async function audit(html: string, width?: number) {
  await on(html, width);
  return auditPage(page);
}

beforeAll(async () => {
  const executablePath = process.env.DEMO_STUDIO_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe('the checker (L4.9 part A)', () => {
  it('its contrast maths is contrastRatio’s on a dozen pairs', async () => {
    const pairs: Array<[string, string]> = [
      ['#565d69', '#ffffff'],
      ['#2357d9', '#ffffff'],
      ['#2357d9', '#eaf0fd'],
      ['#b42318', '#fdecea'],
      ['#8a5300', '#fdf3e1'],
      ['#1f5fae', '#e8f1fb'],
      ['#1d6b3a', '#e6f4ea'],
      ['#5b3a99', '#f1ebfb'],
      ['#ffffff', '#16181d'],
      ['#999999', '#ffffff'],
      ['#c9ced8', '#16181d'],
      ['#000000', '#ffffff'],
    ];
    for (const [a, b] of pairs) {
      const mine = await pageRatio(page, a, b);
      expect(mine, `${a} on ${b}`).not.toBeNull();
      expect(Math.abs(mine! - contrastRatio(a, b)!), `${a} on ${b}`).toBeLessThan(1e-9);
    }
  });

  it('contrast: grey text fails, muted passes; large text needs 3:1; a half-opaque parent counts', async () => {
    let r = await audit('<p style="color:#999">Grey words</p><p style="color:#565d69">Muted words</p>');
    expect(of(r.findings, 'contrast').map((f) => f.text), formatFindings(r.findings)).toEqual(['Grey words']);
    expect(r.stats.texts).toBe(3);
    // #8a8a8a: 3.45:1 — fails at 14 px, passes at 24 px and at 19 px bold.
    r = await audit('<p style="color:#8a8a8a">Small</p><p style="color:#8a8a8a;font-size:24px">Large</p><p style="color:#8a8a8a;font-size:19px;font-weight:700">Bold</p>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['Small']);
    r = await audit('<div style="opacity:.5"><p style="color:#565d69">Faded</p></div><div style="opacity:.95"><p style="color:#565d69">Nearly</p></div>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['Faded']);
    // A control's value is text too.
    r = await audit('<label>Name <input value="pale value" style="color:#bbb"></label><label>Other <input value="dark value"></label>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['pale value']);
  });

  it('contrast: a gradient counts its worst stop; an image background is unmeasured, not passed', async () => {
    let r = await audit('<div style="background:linear-gradient(90deg,#fff,#222)"><p style="color:#565d69">On a dark stop</p></div><div style="background:repeating-linear-gradient(135deg,#f1f2f5,#f1f2f5 6px,#eceef2 6px,#eceef2 12px)"><p style="color:#565d69">On light stripes</p></div>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['On a dark stop']);
    r = await audit('<div style="background:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"><p>Over a picture</p></div>');
    expect(of(r.findings, 'contrast')).toEqual([]);
    expect(r.stats.unmeasured).toHaveLength(1);
    expect(r.stats.unmeasured[0]).toContain('image background');
  });

  it('⚑ contrast over media: an overlay beside a picture is composited over black and white (the worse kept)', async () => {
    const box = (veil: string, text: string) => `<div style="position:relative;width:320px;background:#fff"><canvas width="320" height="120" style="display:block"></canvas><span style="position:absolute;top:20px;left:20px;color:#16181d;background:${veil}">${text}</span></div>`;
    // Dark text on a thin white veil: fine on a white page, unreadable when the picture under it is dark.
    let r = await audit(box('rgba(255,255,255,.35)', 'Thin veil') + box('rgba(255,255,255,.92)', 'Thick veil'));
    expect(of(r.findings, 'contrast').map((f) => f.text), formatFindings(r.findings)).toEqual(['Thin veil']);
    expect(of(r.findings, 'contrast')[0].detail).toContain('over media');
    expect(r.stats.overMedia).toBe(2);
    // Text straight on the picture (nothing translucent between): unmeasured, never a silent pass.
    r = await audit(box('transparent', 'Bare'));
    expect(of(r.findings, 'contrast')).toEqual([]);
    expect(r.stats.unmeasured.some((u) => u.includes('straight on media'))).toBe(true);
    // A picture painted above the text (it hides it) is not under it; text beside a picture is not over it.
    r = await audit('<div style="position:relative;background:#fff"><p style="color:#16181d;margin:0;background:rgba(255,255,255,.35)">Beside</p><canvas width="100" height="40" style="display:block"></canvas></div>');
    expect(r.stats.overMedia).toBe(0);
    expect(of(r.findings, 'contrast')).toEqual([]);
  });

  it('placeholder: its own colour and opacity on the field', async () => {
    const r = await audit('<style>#a::placeholder{color:#bbb;opacity:1}#b::placeholder{color:#565d69;opacity:1}#c::placeholder{color:#565d69;opacity:.54}</style><label>A <input id="a" placeholder="Pale"></label><label>B <input id="b" placeholder="Muted"></label><label>C <input id="c" placeholder="Faded"></label>');
    expect(of(r.findings, 'placeholder').map((f) => f.text)).toEqual(['Pale', 'Faded']);
    expect(r.stats.placeholders).toBe(3);
  });

  it('a disabled control’s own text is exempt (counted); a disabled container’s other text is not', async () => {
    const r = await audit('<button disabled style="color:#bbb">Off</button><label><input type="radio" disabled> <span style="color:#bbb">Its label</span></label><div role="radiogroup" aria-disabled="true" aria-label="Layout"><span role="radio" aria-checked="true" aria-disabled="true" tabindex="0" style="color:#bbb">Chip</span><span style="color:#bbb">The reason it is off</span></div>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['The reason it is off']);
    expect(r.stats.exempt).toBe(3);
  });

  it('name: a control with no name, or named only by a placeholder or title, is found (accessibility tree)', async () => {
    const r = await audit('<button id="icon"><svg width="10" height="10"></svg></button><button aria-label="Close">×</button><input id="ph" placeholder="Search"><input id="ti" title="Filter"><label>Find <input id="ok"></label><div role="button" tabindex="0" id="bare"></div>');
    const names = of(r.findings, 'name');
    expect(names.map((f) => f.el).sort(), formatFindings(names)).toEqual(['button#icon', 'div#bare', 'input#ph', 'input#ti']);
    expect(names.find((f) => f.el === 'input#ph')!.detail).toContain('placeholder');
    expect(r.stats.controls).toBeGreaterThanOrEqual(6);
  });

  it('reachable: an interactive role the keyboard cannot reach; composites holding the tab stop pass', async () => {
    const r = await audit('<div role="button" id="dead">Go</div><div role="button" tabindex="0">Fine</div><ul role="listbox" tabindex="0" aria-label="Steps" aria-activedescendant="o1"><li role="option" id="o1" aria-selected="true">One</li><li role="option" id="o2" aria-selected="false">Two</li></ul><div role="radiogroup" aria-label="Pick"><span role="radio" aria-checked="true" tabindex="0">A</span><span role="radio" aria-checked="false" tabindex="-1">B</span></div><div role="tablist" aria-label="Tabs"><span role="tab" id="lost">T</span></div>');
    expect(of(r.findings, 'reachable').map((f) => f.el)).toEqual(['div#dead', 'span#lost']);
    // Two step lists sharing one tab stop (the arrows cross from one to the next): reachable; with no stop in the family, not.
    const lists = (first: number) => `<ul role="listbox" class="steps" tabindex="${first}" aria-label="Scene a"><li role="option" id="a1">A1</li></ul><ul role="listbox" class="steps" tabindex="-1" aria-label="Scene b"><li role="option" id="b1">B1</li></ul>`;
    expect(of((await audit(lists(0))).findings, 'reachable')).toEqual([]);
    expect(of((await audit(lists(-1))).findings, 'reachable').map((f) => f.el)).toEqual(['li#a1', 'li#b1']);
  });

  it('⚑ focus ring: a stop must change a visible box — the chip whose ring rule is gone fails though its input has the global outline', async () => {
    const chips = (ring: boolean) => `<style>:focus-visible{outline:2px solid #2357d9;outline-offset:2px} .chip{position:relative;display:inline-flex;padding:4px 10px;border:1px solid #ccc;border-radius:99px} .chip input{position:absolute;opacity:0;width:1px;height:1px;margin:0} ${ring ? '.chip:focus-within{outline:2px solid #2357d9}' : ''}</style><fieldset style="border:0"><legend>Show</legend><label class="chip"><input type="checkbox" id="c1"> One</label><label class="chip"><input type="checkbox" id="c2"> Two</label></fieldset>`;
    await on(chips(true));
    let w = await tabWalk(page);
    expect(w.stops).toBe(2);
    expect(w.findings, formatFindings(w.findings)).toEqual([]);
    await on(chips(false));
    w = await tabWalk(page);
    expect(w.findings.map((f) => f.el)).toEqual(['input#c1', 'input#c2']);
    // outline: none with nothing in its place.
    await on('<style>button:focus-visible{outline:none}</style><button id="b">Go</button><a href="#x" id="l">Link</a>');
    w = await tabWalk(page);
    expect(w.findings.map((f) => f.el)).toEqual(['button#b']);
    // A listbox whose ring is drawn on its active option passes.
    await on('<style>ul:focus-visible{outline:none} ul:focus-visible li[aria-selected=true]{box-shadow:0 0 0 2px #2357d9}</style><ul role="listbox" tabindex="0" aria-label="Steps" aria-activedescendant="o1"><li role="option" id="o1" aria-selected="true">One</li></ul>');
    w = await tabWalk(page);
    expect(w.findings).toEqual([]);
  });

  it('focus ring: text shown only while focused (a tooltip) is contrast-checked then', async () => {
    const pin = (fg: string) => `<style>.tip{display:none;background:#16181d;color:${fg}} .pin:focus-within .tip{display:block}</style><span class="pin"><button>Pin</button><span class="tip">Open thread</span></span>`;
    await on(pin('#555'));
    let w = await tabWalk(page);
    expect(w.findings.map((f) => `${f.rule} ${f.text}`)).toEqual(['contrast Open thread']);
    await on(pin('#c9ced8'));
    w = await tabWalk(page);
    expect(w.findings).toEqual([]);
  });

  it('colour-only: a status colour with no word fails; the same mark hidden beside words passes', async () => {
    let r = await audit('<span id="dot" style="display:inline-block;width:8px;height:8px;background:var(--danger)"></span>');
    expect(of(r.findings, 'colour-only').map((f) => f.el)).toEqual(['span#dot']);
    r = await audit('<span><span aria-hidden="true" style="display:inline-block;width:8px;height:8px;background:var(--danger)"></span> Failed</span><span>Connected <span style="display:inline-block;width:8px;height:8px;background:var(--online)"></span></span><span style="display:inline-block;width:8px;height:8px;background:#2357d9"></span>');
    expect(of(r.findings, 'colour-only'), formatFindings(r.findings)).toEqual([]);
    // A label only a screen reader hears is no word for a sighted person who cannot tell the colours apart.
    r = await audit('<p><span id="sr" role="img" aria-label="Online" style="display:inline-block;width:8px;height:8px;background:var(--online)"></span></p>');
    expect(of(r.findings, 'colour-only').map((f) => f.el)).toEqual(['span#sr']);
    r = await audit('<span><span id="lone" aria-hidden="true" style="display:inline-block;width:8px;height:8px;border:2px solid var(--success)"></span></span>');
    expect(of(r.findings, 'colour-only').map((f) => f.el)).toEqual(['span#lone']);
  });

  it('headings: one h1, no level skipped', async () => {
    let r = await audit('<h1 id="two">Again</h1>');
    expect(of(r.findings, 'headings').map((f) => f.detail)).toEqual(['2 level-1 headings (one expected)']);
    r = await audit('<h3 id="deep">Deep</h3>');
    expect(of(r.findings, 'headings').map((f) => f.el)).toEqual(['h3#deep']);
    r = await audit('<h2>Section</h2><h3>Sub</h3><h2>Next</h2>');
    expect(of(r.findings, 'headings')).toEqual([]);
  });

  it('overflow: a box wider than the window scrolls the page sideways', async () => {
    let r = await audit('<div style="position:relative;margin-left:900px"><span id="wide" style="position:absolute;width:600px">x</span></div>');
    expect(of(r.findings, 'overflow').map((f) => f.el)).toEqual(['document']);
    expect(of(r.findings, 'overflow')[0].detail).toContain('span#wide');
    r = await audit('<div style="margin-left:900px;width:80px">x</div>');
    expect(of(r.findings, 'overflow')).toEqual([]);
  });

  it('a clean page has no finding; a native dialog’s keyboard contract is checked', async () => {
    const r = await audit('<p>Words <a href="#a">a link</a></p><button>Go</button><label>Name <input></label>');
    expect(r.findings, formatFindings(r.findings)).toEqual([]);
    // A dialog: focus moves in, Escape closes it, focus comes back to the opener.
    await on('<button id="open">Open</button><dialog id="d"><button id="close">Close</button></dialog>');
    await page.evaluate(() => document.getElementById('open')!.addEventListener('click', () => (document.getElementById('d') as HTMLDialogElement).showModal()));
    const opener = page.locator('#open');
    expect(await dialogCheck(page, opener, () => page.keyboard.press('Enter'))).toEqual([]);
    // A dialog Escape does not close fails.
    await page.evaluate(() => document.getElementById('d')!.addEventListener('cancel', (e) => e.preventDefault()));
    expect(await dialogCheck(page, opener, () => page.keyboard.press('Enter'))).toEqual(expect.arrayContaining(['Escape did not close the dialog']));
    // Focus back on another control than the opener; a dialog opened without moving focus into it.
    await on('<button id="open">Open</button><button id="other">Other</button><dialog id="d"><button>Close</button></dialog>');
    await page.evaluate(() => document.getElementById('open')!.addEventListener('click', () => (document.getElementById('d') as HTMLDialogElement).showModal()));
    expect(await dialogCheck(page, page.locator('#other'), () => page.locator('#open').click())).toEqual([expect.stringContaining('focus did not return')]);
    // (a fresh opener: the old one's click handler gone)
    await page.evaluate(() => document.getElementById('open')!.replaceWith(document.getElementById('open')!.cloneNode(true)));
    await page.evaluate(() => document.getElementById('open')!.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        (document.getElementById('d') as HTMLDialogElement).open = true;
      }
    }));
    expect(await dialogCheck(page, page.locator('#open'), () => page.keyboard.press('Enter'))).toEqual(expect.arrayContaining(['focus is not inside the open dialog']));
  });
  it('⚑ contrast: a faded dark card counts its opacity on the card too; an unreadable colour is a finding; pseudo and submit text are measured', async () => {
    // White on #16181d at opacity .5 over white: the card shows grey (≈ 3.4:1), not 17:1 nor the 5:1 of fading the text only.
    let r = await audit('<div style="opacity:.5;background:#16181d;padding:8px"><p id="dim" style="color:#fff">Dim on dark</p></div><div style="opacity:.95;background:#16181d;padding:8px"><p style="color:#fff">Nearly opaque</p></div>');
    expect(of(r.findings, 'contrast').map((f) => f.text), formatFindings(r.findings)).toEqual(['Dim on dark']);
    expect(of(r.findings, 'contrast')[0].detail).toMatch(/^3\.\d+:1 < 4\.5:1/);
    // A colour space the checker does not convert: a finding (never transparent, never a silent pass).
    r = await audit('<div style="background:oklch(0.22 0 0);padding:8px"><p style="color:#333">Dark on oklch</p></div>');
    expect(of(r.findings, 'contrast').map((f) => f.detail).join(' '), formatFindings(r.findings)).toContain('cannot be read');
    r = await audit('<div style="background:color-mix(in srgb, #000 90%, #fff);padding:8px"><p style="color:#333">Dark on mix</p></div>');
    expect(of(r.findings, 'contrast').map((f) => f.text)).toEqual(['Dark on mix']);
    // ::before / ::after quoted text and a submit button's value are text too.
    r = await audit('<style>.b::after{content:"Failed";color:#ccc} .g::after{content:"Done";color:#565d69}</style><span class="b"></span><span class="g"></span><form><input type="submit" value="Save" style="color:#ccc;background:#fff"><input type="submit" value="Send" style="color:#16181d;background:#fff"></form>');
    expect(of(r.findings, 'contrast').map((f) => f.text), formatFindings(r.findings)).toEqual(['Save', '::after Failed']);
  });

  it('⚑ colour-only: a status mark needs a state word (never any word); rows differing by a status colour start with a sign', async () => {
    const dot = (bg: string) => `<span aria-hidden="true" style="display:inline-block;width:8px;height:8px;background:${bg}"></span>`;
    // A dot beside an unrelated word; a glyph coloured by status; a ::before dot with no word; a soft background on one row.
    let r = await audit(`<p id="p1">${dot('var(--danger)')} Session 2</p><ul><li><span id="g" aria-hidden="true" style="color:var(--danger)">●</span> Run 3</li><li>Run 4</li></ul><style>.st::before{content:"";display:inline-block;width:8px;height:8px;background:var(--danger)}</style><p><span class="st" id="pseudo"></span></p><ul><li id="soft" style="background:var(--danger-soft)">Run 5</li><li>Run 6</li></ul>`);
    expect(of(r.findings, 'colour-only').map((f) => f.el).sort(), formatFindings(r.findings)).toEqual(['li#soft', 'span', 'span#g', 'span#pseudo.st']);
    // The same with state words or signs: a dot beside "Failed", ✓ / ✗ glyphs (their shape says it), diff rows with + / −.
    r = await audit(`<p>${dot('var(--danger)')} Failed</p><ul><li><span aria-hidden="true" style="color:var(--success)">✓</span> Run 3</li><li><span aria-hidden="true" style="color:var(--danger)">✗</span> Run 4</li></ul><table><tbody><tr style="background:var(--success-soft)"><td><span aria-hidden="true">+</span><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)" class="sr-only">added</span></td><td>  - card: two</td></tr><tr><td> </td><td>  - card: one</td></tr><tr style="background:var(--danger-soft)"><td><span aria-hidden="true">−</span></td><td>  - card: old</td></tr></tbody></table>`);
    expect(of(r.findings, 'colour-only'), formatFindings(r.findings)).toEqual([]);
    // The diff rows' sign dropped (the code itself holds a dash): caught.
    r = await audit('<table><tbody><tr id="add" style="background:var(--success-soft)"><td>12</td><td>  - card: two</td></tr><tr><td>13</td><td>  - card: one</td></tr></tbody></table>');
    expect(of(r.findings, 'colour-only').map((f) => f.el)).toEqual(['tr#add']);
  });

  it('⚑ selected: a selected / current / pressed state must differ from its peer by more than colour (≥ 3:1 for its mark)', async () => {
    const list = (sel: string) => `<style>li{padding:4px;border:1px solid transparent} .selected{background:#eaf0fd;border-color:#b8cbf5;${sel}}</style><ul><li class="selected" id="s">One</li><li>Two</li><li>Three</li></ul>`;
    // A tint and a pale border (1.14:1 and 1.6:1): colour only.
    let r = await audit(list(''));
    expect(of(r.findings, 'selected').map((f) => f.el), formatFindings(r.findings)).toEqual(['li#s.selected']);
    expect(r.stats.selected).toBe(1);
    // Weight, an inset accent bar (3 px at 5:1), a dark fill: each survives greyscale.
    for (const cue of ['font-weight:600', 'box-shadow:inset 3px 0 0 #2357d9', 'background:#2357d9;color:#fff']) expect(of((await audit(list(cue))).findings, 'selected'), cue).toEqual([]);
    // A bar too thin or too pale is still colour only.
    for (const cue of ['box-shadow:inset 1px 0 0 #2357d9', 'box-shadow:inset 3px 0 0 #b8cbf5']) expect(of((await audit(list(cue))).findings, 'selected').length, cue).toBe(1);
    // aria-pressed and aria-current (a tab's underline appears: a mark); a marker child only on the checked radio.
    r = await audit('<div><button aria-pressed="true" id="on" style="background:#eaf0fd;border:1px solid #ccc">1×</button><button aria-pressed="false" style="background:#fff;border:1px solid #ccc">2×</button></div><nav><a href="#a" aria-current="page" style="border-bottom:2px solid #2357d9">A</a> <a href="#b" style="border-bottom:2px solid transparent">B</a></nav><div role="radiogroup" aria-label="L"><button role="radio" aria-checked="true" tabindex="0"><span style="display:inline-block;width:8px;height:8px;border:1px solid #333;background:#333"></span> X</button><button role="radio" aria-checked="false" tabindex="-1"><span style="display:inline-block;width:8px;height:8px;border:1px solid #333"></span> Y</button></div>');
    expect(of(r.findings, 'selected').map((f) => f.el), formatFindings(r.findings)).toEqual(['button#on']);
    expect(r.stats.selected).toBe(3);
  });

  it('⚑ focus ring: a transparent outline, a faint shadow, a 1 % tint, a parent tint, a covered control fail; a thin ring sums its parts', async () => {
    const walk = async (html: string) => {
      await on(html);
      return (await tabWalk(page)).findings;
    };
    expect((await walk('<style>button:focus-visible{outline:2px solid transparent}</style><button id="b">Go</button>')).map((f) => f.el)).toEqual(['button#b']);
    expect((await walk('<style>button{background:#fff;border:1px solid #ccc;outline:none!important} button:focus{background:#fdfdfd}</style><button id="b">Go</button>')).map((f) => f.el)).toEqual(['button#b']);
    const faint = await walk('<style>button{background:#fff;border:1px solid #ccc;outline:none!important} button:focus{box-shadow:0 0 0 2px #f3f4f6}</style><button id="b">Go</button>');
    expect(faint.map((f) => f.el)).toEqual(['button#b']);
    expect(faint[0].detail).toContain('too faint');
    expect((await walk('<style>.p{padding:6px;background:#fff} .p:focus-within{background:#fefefe} input{outline:none!important;border:1px solid #ccc}</style><div class="p"><label>X <input id="i"></label></div>')).map((f) => f.el)).toEqual(['input#i']);
    const covered = await walk('<style>header{position:fixed;top:0;left:0;right:0;height:200px;background:#fff;z-index:9}</style><header><h2>Bar</h2></header><button id="u" style="margin-top:20px">Under</button>');
    expect(covered.map((f) => f.detail).join(' '), formatFindings(covered)).toContain('entirely covered by header');
    // A 1 px border turning accent plus a 1 px shadow: 2 px at 3:1 (the steps' ring); a 1 px shadow alone is too thin.
    expect(await walk('<style>button{background:#fff;border:1px solid #e2e5ea;outline:none!important} button:focus{border-color:#2357d9;box-shadow:0 0 0 1px #2357d9}</style><button>Go</button>')).toEqual([]);
    expect((await walk('<style>button{background:#fff;border:1px solid #e2e5ea;outline:none!important} button:focus{box-shadow:0 0 0 1px #2357d9}</style><button id="b">Go</button>')).map((f) => f.el)).toEqual(['button#b']);
    // The browser's own ring passes.
    expect(await walk('<button>Go</button><a href="#x">Link</a>')).toEqual([]);
  });

  it('⚑ walk: a walk that never comes back to its first stop before its cap is a finding', async () => {
    await on(Array.from({ length: 12 }, (_x, i) => `<button>B${i}</button>`).join(''));
    let w = await tabWalk(page, { max: 5 });
    expect(of(w.findings, 'walk').map((f) => f.detail)).toEqual([expect.stringContaining('truncated at 5 stops')]);
    w = await tabWalk(page, { max: 40 });
    expect(w.stops).toBe(12);
    expect(w.findings).toEqual([]);
  });

  it('⚑ reachable: a native radio with no roving stop; an unrelated tab stop does not excuse a group; a shared stop the arrows must cross', async () => {
    let r = await audit('<div role="radiogroup" aria-label="Lost"><button role="radio" id="r1" aria-checked="false" tabindex="-1">A</button><button role="radio" aria-checked="false" tabindex="-1">B</button></div><div role="tablist" aria-label="T"><span role="tab" id="lost">Lost</span><span tabindex="0">help</span></div>');
    expect(of(r.findings, 'reachable').map((f) => f.el), formatFindings(r.findings)).toEqual(['button#r1', 'button', 'span#lost']);
    // Two step lists sharing one stop: recorded as a family; the arrows must take the focus into the second one.
    const lists = (arrows: boolean) => `<ul role="listbox" class="steps" tabindex="0" aria-label="a" aria-activedescendant="a1"><li role="option" id="a1">A1</li></ul><ul role="listbox" class="steps" tabindex="-1" aria-label="b" aria-activedescendant="b1"><li role="option" id="b1">B1</li></ul>${arrows ? '<script>document.querySelectorAll(".steps").forEach((u, i, all) => u.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && all[i + 1]) { u.tabIndex = -1; all[i + 1].tabIndex = 0; all[i + 1].focus(); } }));</script>' : ''}`;
    r = await audit(lists(false));
    expect(of(r.findings, 'reachable')).toEqual([]);
    expect(r.stats.families).toEqual(['[role="listbox"].steps']);
    expect((await familyWalk(page, r.stats.families[0])).map((f) => f.detail)).toEqual([expect.stringContaining('never reach group 2 of 2')]);
    r = await audit(lists(true));
    expect(await familyWalk(page, r.stats.families[0])).toEqual([]);
  });

  it('⚑ name: focusable content under aria-hidden, a picture with no alt; headings: a second level-1 role heading, a hidden one not counted', async () => {
    let r = await audit('<div aria-hidden="true"><button id="hid">Close</button><button tabindex="-1">Off</button></div><img id="pic" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="40" height="40"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" width="40" height="40">');
    expect(of(r.findings, 'name').map((f) => f.el).sort(), formatFindings(r.findings)).toEqual(['button#hid', 'img#pic']);
    r = await audit('<div role="heading" aria-level="1" id="top">Another top</div>');
    expect(of(r.findings, 'headings').map((f) => f.detail)).toEqual(['2 level-1 headings (one expected)']);
    r = await audit('<div style="display:none"><h1>In a closed panel</h1></div><h2>Section</h2>');
    expect(of(r.findings, 'headings')).toEqual([]);
  });

  it('⚑ a non-modal dialog fails the dialog contract; settle reports what is still loading at its bound', async () => {
    await on('<button id="open">Open</button><dialog id="d"><button>Close</button></dialog>');
    await page.evaluate(() => {
      const d = document.getElementById('d') as HTMLDialogElement;
      document.getElementById('open')!.addEventListener('click', () => {
        d.show();
        d.querySelector('button')!.focus();
      });
      d.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          d.close();
          document.getElementById('open')!.focus();
        }
      });
    });
    expect(await dialogCheck(page, page.locator('#open'), () => page.keyboard.press('Enter'))).toEqual([expect.stringContaining('not modal')]);
    await on('<p role="status">Loading the sessions…</p><p role="status">Saved.</p>');
    expect(await settle(page, 300)).toEqual(['p "Loading the sessions…"']);
    await on('<p role="status">Saved.</p><div aria-busy="false"></div>');
    expect(await settle(page, 300)).toEqual([]);
  });
});
