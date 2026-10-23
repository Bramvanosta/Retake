/**
 * The Studio app, bundled in memory (L4.1): esbuild turns `src/app/main.tsx` (and the CSS it imports) into one ES
 * module and one stylesheet, minified, for the browsers of the target list; the document is a static string with no
 * inline script or style (the CSP allows neither). Built once per server start, served from memory: no file is read
 * per request, so no request path ever reaches the file system. The sources ship with the package (`files: src`), so
 * the built CLI bundles them too; a broken app source breaks `studio ui` only (the CLI imports this package lazily).
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface UiAsset {
  bytes: Buffer;
  type: string;
  /** Strong ETag: a digest of the bytes. */
  etag: string;
}

/** The package folder (this file is src/bundle.ts, or dist/bundle.js once built). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const APP_ENTRY = join(PACKAGE_DIR, 'src', 'app', 'main.tsx');

/** Browsers the bundle targets (the user opens the Studio in Safari, Chrome or Firefox). */
export const UI_TARGETS = ['chrome120', 'safari17', 'firefox120'];

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Demo Studio</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<div id="root"></div>
<noscript>Demo Studio needs JavaScript.</noscript>
</body>
</html>
`;

function asset(bytes: Buffer, type: string): UiAsset {
  return { bytes, type, etag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"` };
}

/** `/`, `/app.js` and `/app.css`, in memory. */
export async function buildUi(entry = APP_ENTRY): Promise<Map<string, UiAsset>> {
  const { build } = await import('esbuild');
  const out = await build({
    entryPoints: { app: entry },
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'esm',
    platform: 'browser',
    target: UI_TARGETS,
    minify: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'silent',
    absWorkingDir: PACKAGE_DIR,
  });
  const assets = new Map<string, UiAsset>([['/', asset(Buffer.from(INDEX_HTML, 'utf8'), 'text/html; charset=utf-8')]]);
  for (const f of out.outputFiles) {
    if (f.path.endsWith('/app.js')) assets.set('/app.js', asset(Buffer.from(f.contents), 'text/javascript; charset=utf-8'));
    else if (f.path.endsWith('/app.css')) assets.set('/app.css', asset(Buffer.from(f.contents), 'text/css; charset=utf-8'));
  }
  if (!assets.has('/app.js')) throw new Error(`the Studio app did not bundle (${entry})`);
  if (!assets.has('/app.css')) assets.set('/app.css', asset(Buffer.alloc(0), 'text/css; charset=utf-8'));
  return assets;
}
