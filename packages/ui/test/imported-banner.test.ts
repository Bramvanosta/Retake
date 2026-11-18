/**
 * R-SHR-39: the Project screen of a project imported from a project archive and not trusted — the banner (a region with
 * its heading, the command a person runs, as text) and a production's Render disabled with that reason.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BoardScenario, ProjectView } from '@retake/engine';
import { IMPORTED_BANNER_ID, ImportedBanner } from '../src/app/project/ProductionsScreen.js';
import { ProductionInspector } from '../src/app/project/production-inspectors.js';

describe('the imported-project banner', () => {
  it('a region with its heading (not a live region), saying the project is not trusted and naming the command, as text', () => {
    const html = renderToStaticMarkup(createElement(ImportedBanner, { imported: { trusted: false, command: 'retake project trust <b>x</b>' } }));
    expect(html).toMatch(new RegExp(`^<section [^>]*id="${IMPORTED_BANNER_ID}" aria-labelledby="${IMPORTED_BANNER_ID}-h"`));
    expect(html).toMatch(new RegExp(`<h2 id="${IMPORTED_BANNER_ID}-h"[^>]*>.*Imported — not trusted.*</h2>`));
    expect(html).not.toContain('role="status"');
    expect(html).toContain('until a person reads its code files and trusts it, in a terminal');
    expect(html).toMatch(/<code>(<[^>]+>)*retake project trust &lt;b&gt;x&lt;\/b&gt;(<\/[^>]+>)*<\/code>/);
    expect(html).not.toContain('<b>');
  });

  it("a production's Render is disabled on an untrusted import, its reason (the command) read with it", () => {
    const s = { name: 'quote', file: { parsed: true, ok: true, errors: 0, warnings: 0 }, content: {}, untrusted: {}, capture: { run: 'r', finished_at: '2026-11-18T00:00:00Z', current: true } } as unknown as BoardScenario;
    const p = { slug: 'nf2', name: 'Nf2', environments: [], scenarios: ['quote'], warnings: [] } as unknown as ProjectView;
    const render = (imported?: string) => renderToStaticMarkup(createElement(ProductionInspector, { s, p, live: new Map(), ...(imported ? { imported } : {}) }));
    const html = render('retake project trust nf2');
    const button = /<button[^>]*data-testid="production-render"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toMatch(/disabled=""/);
    const described = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    const at = html.indexOf(`id="${described}"`);
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at, at + 200)).toContain('Imported, not trusted: a person runs retake project trust nf2 in a terminal first.');
    expect(/<button[^>]*data-testid="production-render"[^>]*>/.exec(render())?.[0]).not.toMatch(/disabled/);
  });
});
