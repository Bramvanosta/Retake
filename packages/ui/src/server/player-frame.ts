/**
 * What the player origin (player.ts) answers without reading a file: the frame document and its CSP, and the `forbid`
 * scan of a component preview spec before it is served.
 */
import { playerMaking } from '@retake/engine/shell';
import { isPreviewDisplayText } from '../player/protocol.js';

/** A POSIX absolute path or a Windows one ("C:\…"), not a URL. */
const ABSOLUTE = /^(?:\/(?!\/)|[A-Za-z]:[\\/])/;
/** A string that names a resource by a scheme (or scheme-relative): in a component preview it must be one of this scope's URLs. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:file|blob|data|javascript|about|filesystem|mailto):)/i;

/**
 * The `forbid` scan of a component preview spec (pure): every string checked — no `file:` URL, no absolute path,
 * none holding a folder of `forbid`, and any URL one under `media` (the scope's `/m/<cap>/`) — but the display text of
 * protocol.ts `isPreviewDisplayText` (a fixed list of paths, the frame applies the same). Throws PreviewPlanError.
 */
export async function checkPreviewSpec(spec: unknown, media: string, forbid: readonly string[]): Promise<void> {
  const pm = await playerMaking();
  const dirs = forbid.filter((d) => d.length > 1);
  const scan = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/^file:/i.test(v)) throw pm.planError(`${path} is a file: URL`);
      if (ABSOLUTE.test(v)) throw pm.planError(`${path} is a path of this Mac`);
      for (const d of dirs) if (v.includes(d)) throw pm.planError(`${path} names a folder of this Mac`);
      if (URL_LIKE.test(v) && !v.startsWith(media) && !isPreviewDisplayText(path, v, spec)) throw pm.planError(`${path} names a URL this preview does not serve`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${path}.${k}`);
  };
  scan(spec, 'spec');
}

/** The frame document's CSP (pure; the capability scopes every source). */
export function frameCsp(origin: string, cap: string, studioPort: number): string {
  const m = `${origin}/m/${cap}/`;
  return [
    "default-src 'none'",
    `script-src ${origin}/s/${cap}/`,
    // The Player and the components set inline styles; with img / font / connect pinned to /m/, CSS sends nothing out.
    "style-src 'unsafe-inline'",
    `img-src ${m} data:`,
    // data: the Player's silent audio tag.
    `media-src ${m} data:`,
    `font-src ${m} data:`,
    `connect-src ${m}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors http://127.0.0.1:${studioPort} http://localhost:${studioPort}`,
    'sandbox allow-scripts',
    // No HTML parsing from a string anywhere in the frame (no policy can be created).
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

/** The frame document (pure). */
export function frameHtml(cap: string, hash: string, studioPort: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="retake-parent" content="http://127.0.0.1:${studioPort} http://localhost:${studioPort}">
<title>Preview</title>
<script src="/s/${cap}/boot.${hash}.js"></script>
<script src="/s/${cap}/b.${hash}.js" defer></script>
</head>
<body style="margin:0;background:#000;overflow:hidden">
<div id="root" style="position:fixed;inset:0"></div>
</body>
</html>
`;
}
