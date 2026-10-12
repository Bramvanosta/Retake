#!/usr/bin/env node
/**
 * Regenerates the two sample frames that previews of components with `frame` slots show (before / after cards):
 * packages/components/preview/frame-before.jpg and frame-after.jpg (the fixture's sign-up page, empty then sent, at the
 * desktop sample's 1280 × 720) + the "frames" entry of the samples.json "media" block. Generated ONCE from the bundled
 * fixture (fictional "Northfield") and committed small; previews never depend on a running app. Usage: start the
 * fixture (node fixtures/wholesale/server.mjs), then
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/preview-frame-samples.mjs
 */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'components', 'preview');
const require = createRequire(join(ROOT, 'packages', 'runner-web', 'package.json'));
const { chromium } = require('playwright-core');
const SHOP = process.env.SHOP_URL ?? 'http://localhost:4402';

const browser = await chromium.launch({ channel: 'chromium' });
try {
  await fetch(`${SHOP}/api/reset`, { method: 'POST' });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 0.8, locale: 'en' });
  const page = await ctx.newPage();
  await page.goto(`${SHOP}/signup`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'frame-before.jpg'), type: 'jpeg', quality: 80 });
  await page.getByLabel('Café name').fill('Café Lumen');
  await page.getByLabel('Your name').fill('Noa Brandt');
  await page.getByLabel('Work email').fill('noa@cafe-lumen.example');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Check your inbox').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'frame-after.jpg'), type: 'jpeg', quality: 80 });
  await ctx.close();
} finally {
  await browser.close();
  await fetch(`${SHOP}/api/reset`, { method: 'POST' }).catch(() => undefined);
}
const metaFile = join(OUT, 'samples.json');
const meta = JSON.parse(await readFile(metaFile, 'utf8'));
meta.media = {
  ...(meta.media ?? {}),
  frames: [
    { file: 'frame-before.jpg', width: 1280, height: 720, label: 'sign-up form' },
    { file: 'frame-after.jpg', width: 1280, height: 720, label: 'confirmation sent' },
  ],
};
await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
console.log(`wrote frame-before.jpg, frame-after.jpg and samples.json "media.frames" in ${OUT}`);
