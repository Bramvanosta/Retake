/**
 * The render bundle's Response.blob() workaround (src/remotion/response-blob.ts): a Blob made from the body's bytes,
 * the same as the one Response.blob() gives, installed by the bundle's root. Chrome for Testing 159 keeps every large
 * body read with Response.blob() until the page closes; Remotion's OffthreadVideo reads every frame that way, and a
 * render on a busy disk then failed with nothing written. The browser half is response-blob-browser.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { installResponseBlobWorkaround } from '../src/remotion/response-blob.js';
import { createRoot } from '../src/remotion/Root.js';

const proto = Response.prototype as Response & { __retakeBlob?: true };
const native = proto.blob;
const restore = () => {
  proto.blob = native;
  delete proto.__retakeBlob;
};

describe("the render bundle's Response.blob() workaround", () => {
  afterEach(() => restore());

  it('gives the bytes and the type Response.blob() gives, and installs once', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    const cases: Array<Record<string, string>> = [{ 'content-type': 'image/bmp' }, { 'content-type': 'Text/Plain; charset=UTF-8' }, {}];
    const expected = await Promise.all(cases.map(async (h) => native.call(new Response(bytes, { headers: h }))));
    installResponseBlobWorkaround();
    const shim = proto.blob;
    expect(shim).not.toBe(native);
    installResponseBlobWorkaround();
    expect(proto.blob, 'a second install keeps the first').toBe(shim);
    for (const [i, h] of cases.entries()) {
      const got = await new Response(bytes, { headers: h }).blob();
      expect(got.type, JSON.stringify(h)).toBe(expected[i].type);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array(await expected[i].arrayBuffer()));
    }
  });

  it("⚑ the render bundle's root installs it", () => {
    expect(proto.blob).toBe(native);
    createRoot({ components: {}, scaffolds: {} } as never);
    expect(proto.blob).not.toBe(native);
    expect(proto.__retakeBlob).toBe(true);
  });
});
