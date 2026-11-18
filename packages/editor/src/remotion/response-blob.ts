/**
 * A workaround the render bundle installs (Root.tsx `createRoot`) for a leak of Chrome for Testing 159's
 * `Response.blob()`. The leak was measured on the M4 with the headless shell:
 * - Every large body read that way stays in the browser's blob storage after its object URL is revoked and its Blob
 *   is collected, until the page closes. It is paged to the profile's disk, or fills the 2 GB in-memory limit when
 *   paging is off.
 * - Remotion's `<OffthreadVideo>` reads each frame (an 8 MB BMP at 1080p) that way. One 60 s render grew its profile
 *   by 6.3 GB on 159, and by 29 MB on Chromium 141 (Playwright 1.56).
 * - Chrome pages blobs only while the disk has room. A busy or nearly full disk, for example several renders at once,
 *   leaves the 2 GB limit, and the 258th frame's fetch then fails ("Failed to fetch … disk space is low"): the render
 *   fails with nothing written.
 *
 * A Blob made from the body's bytes (`arrayBuffer()`) is released normally. The function is self-contained, so a
 * browser test can run it in a page (`page.evaluate`). It is idempotent.
 */
export function installResponseBlobWorkaround(): void {
  const proto = Response.prototype as Response & { __retakeBlob?: true };
  if (proto.__retakeBlob) return;
  Object.defineProperty(proto, '__retakeBlob', { value: true, configurable: true });
  proto.blob = async function blob(this: Response): Promise<Blob> {
    // The type Response.blob() gives: the Content-Type, its parameters without spaces (the Blob lower-cases it; ''
    // when there is none).
    const type = (this.headers.get('content-type') ?? '').trim().replace(/\s*;\s*/g, ';');
    return new Blob([await this.arrayBuffer()], { type });
  };
}
