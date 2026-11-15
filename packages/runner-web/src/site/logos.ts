/** The logo candidates of a site extraction: their bytes, drawn in a raster page as transparent PNGs (extract.ts). */
import { SITE_CANDIDATES_MAX } from './report.js';
import type { SiteCandidateView } from './report.js';
import { stopped, writeNew } from './extraction.js';
import type { Extraction, OpenedSitePage } from './extraction.js';
import type { BrowserContext, Page, Response } from 'playwright-core';
import { BRAND_IMAGE_MIN_HEIGHT } from '@retake/core/theme';
import type { LogoCandidate, PageFacts } from './page-script.js';

/** A candidate's source bytes (as the page received them), at most. */
const CANDIDATE_BYTES_MAX = 5 * 1024 * 1024;
/** A candidate's URL: a data: URL of CANDIDATE_BYTES_MAX in base64, an https URL. */
export const CANDIDATE_DATA_URL_MAX = Math.ceil((CANDIDATE_BYTES_MAX * 4) / 3) + 256;
export const CANDIDATE_URL_MAX = 4096;
/** Downsizing steps of a candidate PNG larger than a create accepts (BRAND_IMAGE_MAX_BYTES). */
const CANDIDATE_SHRINK = 0.7;
const CANDIDATE_SHRINK_STEPS = 5;
const LOGO_MAX_HEIGHT = 1024;
const LOGO_MIN_HEIGHT = 128;
const LOGO_MAX_WIDTH = 2048;
const SVG_LOGO_HEIGHT = 512;

/** The image type of a candidate's bytes (by their first bytes), or null. */
export function imageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (b.length >= 12 && b.toString('latin1', 4, 12) === 'ftypavif') return 'image/avif';
  const head = b
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** PNG size from its header (a Chromium screenshot). */
function pngSize(b: Buffer): { width: number; height: number } {
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const sourceOf = (c: LogoCandidate): SiteCandidateView['source'] =>
  c.kind === 'icon' ? 'icon' : c.kind === 'og' ? 'og-image' : `${c.where === 'header' ? 'header' : 'page'}-${c.kind === 'svg' ? 'svg' : 'img'}`;

/** A candidate's bytes: as the page received them, else one GET through the same route and proxy. */
async function candidateBytes(ex: Extraction, fetchPage: Page, images: Map<string, Response>, c: LogoCandidate): Promise<Buffer | null> {
  if (c.kind === 'svg') return Buffer.from(c.markup, 'utf8');
  if (c.url.startsWith('data:')) {
    if (c.url.length > CANDIDATE_DATA_URL_MAX) return null;
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(c.url);
    if (!m) return null;
    let b: Buffer;
    try {
      b = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    } catch {
      return null;
    }
    return b.length <= CANDIDATE_BYTES_MAX ? b : null;
  }
  if (c.url.length > CANDIDATE_URL_MAX) return null;
  try {
    const seen = images.get(c.url);
    const r = seen ?? (await ex.call(fetchPage.goto(c.url, { timeout: 10_000 }), 'a logo candidate'));
    if (!r || r.status() >= 400) return null;
    const len = Number(r.headers()['content-length'] ?? 0);
    if (len > CANDIDATE_BYTES_MAX) return null;
    const b = await ex.call(r.body(), 'a logo candidate');
    return b.length <= CANDIDATE_BYTES_MAX ? b : null;
  } catch (e) {
    if (ex.stop.signal.aborted) throw e;
    return null;
  }
}

/** The candidate drawn at w × h, as a PNG (transparent background), or null. */
async function shootCandidate(ex: Extraction, rp: Page, w: number, h: number): Promise<Buffer | null> {
  await ex.call(
    rp.evaluate(
      ({ w, h }: { w: number; h: number }) => {
        const i = document.getElementById('i') as HTMLImageElement;
        i.style.width = `${w}px`;
        i.style.height = `${h}px`;
      },
      { w, h },
    ),
    'drawing a logo candidate',
  );
  return ex.call(rp.locator('#i').screenshot({ omitBackground: true, type: 'png', timeout: ex.callMs }), 'drawing a logo candidate').catch((e: unknown) => {
    if (ex.stop.signal.aborted) throw e;
    return null;
  });
}

/** A candidate's image decoded in the raster page and drawn as a PNG a create accepts, or null. */
async function drawCandidate(ex: Extraction, rp: Page, b: Buffer, mime: string): Promise<{ png: Buffer; size: { width: number; height: number } } | null> {
  const src = `data:${mime};base64,${b.toString('base64')}`;
  await ex.call(
    rp.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head><body><img id="i" alt=""></body></html>`),
    'drawing a logo candidate',
  );
  const loaded = await ex
    .call(
      rp.evaluate(async (s: string) => {
        const i = document.getElementById('i') as HTMLImageElement;
        i.src = s;
        try {
          await i.decode();
        } catch {
          return null;
        }
        return { w: i.naturalWidth, h: i.naturalHeight };
      }, src),
      'decoding a logo candidate',
    )
    .catch((e: unknown) => {
      if (ex.stop.signal.aborted) throw e;
      return null;
    });
  if (!loaded || loaded.w < 1 || loaded.h < 1) return null;
  let h = mime === 'image/svg+xml' ? SVG_LOGO_HEIGHT : Math.min(LOGO_MAX_HEIGHT, Math.max(LOGO_MIN_HEIGHT, loaded.h));
  let w = Math.round((loaded.w * h) / loaded.h);
  if (w > LOGO_MAX_WIDTH) {
    w = LOGO_MAX_WIDTH;
    h = Math.max(1, Math.round((loaded.h * w) / loaded.w));
  }
  // What a create would refuse (template_create_from_brand: 64 px high at least, 2 MB at most) is never made:
  // too low is dropped, too heavy is drawn smaller while it stays high enough.
  if (w < 1 || h < BRAND_IMAGE_MIN_HEIGHT) return null;
  let png = await shootCandidate(ex, rp, w, h);
  for (let i = 0; png && png.length > ex.candidateMax && i < CANDIDATE_SHRINK_STEPS; i++) {
    const nh = Math.round(h * CANDIDATE_SHRINK);
    if (nh < BRAND_IMAGE_MIN_HEIGHT) {
      png = null;
      break;
    }
    w = Math.max(1, Math.round(w * CANDIDATE_SHRINK));
    h = nh;
    png = await shootCandidate(ex, rp, w, h);
  }
  if (!png || png.length > ex.candidateMax) return null;
  const size = pngSize(png);
  if (size.height < BRAND_IMAGE_MIN_HEIGHT) return null;
  return { png, size };
}

/** The logo candidates, as transparent PNGs written to the folder (logo-<n>.png). */
export async function writeLogos(ex: Extraction, opened: OpenedSitePage, facts: PageFacts): Promise<void> {
  const { o, report, callMs } = ex;
  opened.nav.fetcher = await opened.context.newPage();
  const fetchPage = opened.nav.fetcher;
  // Rasterised with JavaScript off and no network: Chromium decodes the image, the PNG is its screenshot.
  const raster: BrowserContext = await ex.browser!.newContext({
    javaScriptEnabled: false,
    offline: true,
    viewport: { width: LOGO_MAX_WIDTH + 16, height: LOGO_MAX_HEIGHT + 16 },
    deviceScaleFactor: 1,
  });
  raster.setDefaultTimeout(callMs);
  await raster.route('**/*', (r) => r.abort());
  const rp = await raster.newPage();
  const alts: Array<{ file: string; alt: string }> = [];
  for (const c of facts.candidates) {
    if (report.candidates.length >= SITE_CANDIDATES_MAX) break;
    stopped(ex.stop.signal);
    const b = await candidateBytes(ex, fetchPage, opened.images, c);
    const mime = b ? imageMime(b) : null;
    if (!b || !mime) continue;
    const drawn = await drawCandidate(ex, rp, b, mime);
    if (!drawn) continue;
    const { png, size } = drawn;
    const n = report.candidates.length + 1;
    const file = `logo-${n}.png`;
    await writeNew(o.outDir, file, png);
    report.candidates.push({ file, source: sourceOf(c), width: size.width, height: size.height, drawn: { width: c.width, height: c.height } });
    if (c.alt) alts.push({ file, alt: c.alt });
  }
  await raster.close().catch(() => undefined);
  if (alts.length) report.untrusted.alts = alts;
}
