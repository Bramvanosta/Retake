// Real PDFs for the fixture: the quote document (the same HTML the viewer page shows) printed to A4 with Chromium's
// page.pdf (playwright-core, the browser Retake already uses). The browser is launched on the first request and
// kept; documents are cached by their HTML, so a quote prints once per state.

import { createHash } from 'node:crypto';

let browserPromise = null;
const cache = new Map();

async function browser() {
  if (!browserPromise) {
    browserPromise = import('playwright-core').then(({ chromium }) => chromium.launch({ headless: true })).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** A4 PDF of a standalone HTML document. */
export async function htmlToPdf(html) {
  const key = createHash('sha256').update(html).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    if (cache.size > 50) cache.clear();
    cache.set(key, pdf);
    return pdf;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Close the PDF browser (fixture shutdown). */
export async function closePdfBrowser() {
  const p = browserPromise;
  browserPromise = null;
  cache.clear();
  if (p) await (await p.catch(() => null))?.close().catch(() => undefined);
}
