/**
 * The movie's own duration of a QuickTime file (its `moov/mvhd` box: duration / timescale) — for simctl's recording,
 * the span from its first frame to the SIGINT that ended it, on the host's clock (record-video.ts). ffprobe does not
 * say it (its duration is the video track's: up to the last frame). Only the top-level box headers and the `moov` box
 * are read.
 */
import { open } from 'node:fs/promises';

/** The movie duration (s) of an `mvhd` box's payload (after its 8-byte header), or null. Pure. */
export function mvhdDuration(payload: Uint8Array): number | null {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload.byteLength < 20) return null;
  const version = v.getUint8(0);
  if (version === 1) {
    if (payload.byteLength < 32) return null;
    const scale = v.getUint32(20);
    const dur = Number(v.getBigUint64(24));
    return scale > 0 ? dur / scale : null;
  }
  const scale = v.getUint32(12);
  const dur = v.getUint32(16);
  return scale > 0 ? dur / scale : null;
}

/** The `mvhd` duration inside a `moov` box's payload, or null. Pure. */
export function moovDuration(moov: Uint8Array): number | null {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let off = 0;
  while (off + 8 <= moov.byteLength) {
    let size = v.getUint32(off);
    const type = String.fromCharCode(moov[off + 4], moov[off + 5], moov[off + 6], moov[off + 7]);
    let head = 8;
    if (size === 1) {
      if (off + 16 > moov.byteLength) return null;
      size = Number(v.getBigUint64(off + 8));
      head = 16;
    }
    if (size === 0) size = moov.byteLength - off;
    if (size < head || off + size > moov.byteLength) return null;
    if (type === 'mvhd') return mvhdDuration(moov.subarray(off + head, off + size));
    off += size;
  }
  return null;
}

/** The movie duration (s) of a QuickTime / MP4 file, or null when it has none readable. */
export async function movieDuration(file: string): Promise<number | null> {
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const { size: total } = await fh.stat();
    const head = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= total) {
      const { bytesRead } = await fh.read(head, 0, 16, off);
      if (bytesRead < 8) return null;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let hl = 8;
      if (size === 1) {
        if (bytesRead < 16) return null;
        size = Number(head.readBigUInt64BE(8));
        hl = 16;
      }
      if (size === 0) size = total - off;
      if (size < hl) return null;
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) return null;
        const body = Buffer.alloc(size - hl);
        await fh.read(body, 0, body.length, off + hl);
        return moovDuration(body);
      }
      off += size;
    }
    return null;
  } finally {
    await fh.close();
  }
}
