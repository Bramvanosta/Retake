#!/usr/bin/env node
/**
 * Regenerates the sample artefacts that component previews show for `email` / `document` slots
 * (packages/components/preview/: email-sample.jpg, document-sample-p1.jpg + the "media" block of samples.json).
 * Generated ONCE from the bundled fixture (fictional "Northfield"): its sign-up confirmation email (rendered like
 * wait_for_email does: 600 px, 2×) and a real quote PDF (rasterised with pdf.js like download does), committed small
 * as JPEG; previews never depend on a running app. Usage: start the fixture (node fixtures/wholesale/server.mjs), then
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/preview-media-samples.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'components', 'preview');
const SHOP = process.env.SHOP_URL ?? 'http://localhost:4402';
const { ArtefactRenderer, inlineCids, previewText } = await import(join(ROOT, 'packages', 'runner-web', 'dist', 'index.js'));

const tmp = await mkdtemp(join(tmpdir(), 'ds-media-samples-'));
const renderer = new ArtefactRenderer();
const jpeg = (src, out, width) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `scale=${width}:-2:flags=lanczos`, '-q:v', '4', out]);
const size = (file) => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
};
try {
  await fetch(`${SHOP}/api/reset`, { method: 'POST' });
  await fetch(`${SHOP}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cafe: 'Café Lumen', name: 'Noa Brandt', email: 'noa@cafe-lumen.example' }),
  });
  await new Promise((r) => setTimeout(r, 900));
  const box = `${SHOP}/mailbox/api/v1`;
  const list = await (await fetch(`${box}/messages`)).json();
  const m = await (await fetch(`${box}/message/${list.messages[0].ID}`)).json();
  const inline = [];
  for (const p of m.Inline ?? []) {
    const bytes = Buffer.from(await (await fetch(`${box}/message/${m.ID}/part/${p.PartID}`)).arrayBuffer());
    inline.push({ cid: p.ContentID, mime: p.ContentType, data: `data:${p.ContentType};base64,${bytes.toString('base64')}` });
  }
  const png = join(tmp, 'email.png');
  await renderer.email(inlineCids(m.HTML, inline), png);
  jpeg(png, join(OUT, 'email-sample.jpg'), 1200);

  const quotes = await (await fetch(`${SHOP}/api/quotes`)).json();
  const q = quotes.find((x) => x.proposal);
  const pdf = Buffer.from(await (await fetch(`${SHOP}/quotes/${q.id}/quote.pdf`)).arrayBuffer());
  await writeFile(join(tmp, 'quote.pdf'), pdf);
  const pages = await renderer.pdf(join(tmp, 'quote.pdf'), tmp);
  jpeg(pages[0].file, join(OUT, 'document-sample-p1.jpg'), 1100);

  const metaFile = join(OUT, 'samples.json');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  meta.media = {
    email: {
      file: 'email-sample.jpg',
      ...size(join(OUT, 'email-sample.jpg')),
      from: m.From.Address,
      from_name: m.From.Name,
      to: m.To.map((t) => t.Address),
      subject: m.Subject,
      date: '2026-10-12T09:41:00.000Z',
      preview: previewText(m.Text),
    },
    document: {
      file_name: `Quote_${q.reference}.pdf`,
      pages: [{ file: 'document-sample-p1.jpg', ...size(join(OUT, 'document-sample-p1.jpg')), width_pt: pages[0].width_pt, height_pt: pages[0].height_pt }],
    },
  };
  await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`wrote email-sample.jpg, document-sample-p1.jpg and samples.json "media" in ${OUT}`);
} finally {
  await renderer.close();
  await rm(tmp, { recursive: true, force: true });
}
