#!/usr/bin/env node
/**
 * Regenerates the neutral sample screens that component previews show in their layouts
 * (packages/components/preview/: screen-desktop.jpg, screen-phone.jpg, screen-tablet.jpg + samples.json).
 * Generated ONCE from the bundled fixture product (fictional "Northfield" shop) and committed small; previews never
 * depend on a running app. Usage: start the fixture (node fixtures/wholesale/server.mjs), then
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/preview-samples.mjs
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'components', 'preview');
const require = createRequire(join(ROOT, 'packages', 'runner-web', 'package.json'));
const { chromium } = require('playwright-core');
const SHOP = process.env.SHOP_URL ?? 'http://localhost:4402';
/** The address the browser layout shows in previews (fictional, reserved .example domain). */
const SHOWN = 'https://shop.northfield.example';

const SAMPLES = [
  // name, CSS viewport, device scale (output px = viewport × scale), page, anchor (overlay previews point at it)
  { name: 'desktop', width: 1600, height: 900, scale: 0.8, path: '/products/selowa-ridge', anchor: { role: 'button', name: 'Request a quote' } },
  { name: 'tablet', width: 820, height: 1180, scale: 1, path: '/', anchor: { role: 'link', name: 'Browse coffees' } },
  { name: 'phone', width: 390, height: 844, scale: 1, path: '/', anchor: { role: 'link', name: 'Browse coffees' } },
];

const browser = await chromium.launch({ channel: 'chromium' });
const meta = {};
try {
  await fetch(`${SHOP}/api/reset`, { method: 'POST' });
  for (const s of SAMPLES) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, locale: 'en' });
    const page = await ctx.newPage();
    await page.goto(SHOP + s.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const box = await page.getByRole(s.anchor.role, { name: s.anchor.name }).first().boundingBox();
    const file = `screen-${s.name}.jpg`;
    await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 82 });
    const r = (v) => Math.round(v * s.scale);
    meta[s.name] = {
      file,
      width: Math.round(s.width * s.scale),
      height: Math.round(s.height * s.scale),
      url: SHOWN + s.path,
      anchor: box ? { x: r(box.x), y: r(box.y), w: r(box.width), h: r(box.height) } : undefined,
    };
    await ctx.close();
  }
} finally {
  await browser.close();
}
await writeFile(join(OUT, 'samples.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(JSON.stringify(meta, null, 2));
