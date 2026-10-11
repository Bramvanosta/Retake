import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import type { CaptureClock } from './timeline.js';
import { pad } from './util.js';

/** One captured frame: file name inside frames/ and capture time in seconds. */
export interface FrameIndexEntry {
  file: string;
  t: number;
}

export interface RecorderOptions {
  framesDir: string;
  /** frames.jsonl path (one FrameIndexEntry per line, appended as frames are written). */
  indexFile: string;
  format: 'jpeg' | 'png';
  quality: number;
  /** Viewport in CSS px; frames are captured at width·scale × height·scale. */
  width: number;
  height: number;
  scale: number;
  clock: CaptureClock;
  onError?: (message: string) => void;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
}

/**
 * CDP screencast of the active page. Frames are acked immediately and written asynchronously so capture never
 * blocks the action loop; timestamps come from the compositor (epoch seconds, same clock as the runner).
 */
export class ScreencastRecorder {
  readonly frames: FrameIndexEntry[] = [];
  private session: CDPSession | null = null;
  private page: Page | null = null;
  private seq = 0;
  private readonly pending = new Set<Promise<void>>();
  private index: WriteStream | null = null;
  private writeErrors = 0;
  private stopped = false;
  private sizeWarned = false;
  private dropped = 0;

  constructor(private readonly opts: RecorderOptions) {}

  get recordingPage(): Page | null {
    return this.page;
  }

  async start(page: Page): Promise<void> {
    await mkdir(this.opts.framesDir, { recursive: true });
    this.index = createWriteStream(this.opts.indexFile, { flags: 'a' });
    await this.attach(page);
  }

  /**
   * New-headless Chromium sometimes shrinks the captured view (a transient browser-UI layout pass) while the
   * page keeps its emulated viewport: re-asserting the device metrics on our session restores full frames.
   */
  private emulate(session: CDPSession): Promise<unknown> {
    const { width, height, scale } = this.opts;
    return session
      .send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false, screenWidth: width, screenHeight: height })
      .catch(() => undefined);
  }

  private async attach(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    const ext = this.opts.format === 'png' ? 'png' : 'jpg';
    let lastHeal = 0;
    session.on('Page.screencastFrame', (f: ScreencastFrame) => {
      session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      if (this.session !== session || this.stopped) return;
      // A cropped view would distort the video: drop the frame (the previous one holds) and heal. The metadata can
      // claim the full viewport while the image itself is cropped (e.g. 1920×941 right after a navigation), so the
      // real pixel size is checked too.
      const { deviceWidth: dw, deviceHeight: dh } = f.metadata;
      const data = Buffer.from(f.data, 'base64');
      const px = imageSize(data);
      const ew = Math.round(this.opts.width * this.opts.scale);
      const eh = Math.round(this.opts.height * this.opts.scale);
      let wrong: string | null = null;
      if (dw !== undefined && dh !== undefined && (Math.abs(dw - this.opts.width) > 1 || Math.abs(dh - this.opts.height) > 1)) {
        wrong = `${dw}×${dh} CSS px`;
      } else if (px && (Math.abs(px.width - ew) > 1 || Math.abs(px.height - eh) > 1)) {
        wrong = `${px.width}×${px.height} px`;
      }
      if (wrong) {
        this.dropped++;
        const now = Date.now();
        if (now - lastHeal > 250) {
          lastHeal = now;
          void this.emulate(session);
        }
        if (this.dropped === 30 && !this.sizeWarned) {
          this.sizeWarned = true;
          this.opts.onError?.(`screencast frames stay ${wrong} instead of the ${ew}×${eh} px viewport`);
        }
        return;
      }
      const wall = f.metadata.timestamp !== undefined ? f.metadata.timestamp * 1000 : Date.now();
      const entry: FrameIndexEntry = { file: `${pad(++this.seq, 6)}.${ext}`, t: this.opts.clock.at(wall) };
      const write = writeFile(join(this.opts.framesDir, entry.file), data)
        .then(() => {
          this.frames.push(entry);
          this.index?.write(JSON.stringify(entry) + '\n');
        })
        .catch((e: unknown) => {
          this.writeErrors++;
          this.opts.onError?.(`frame ${entry.file} could not be written: ${(e as Error).message}`);
        })
        .finally(() => this.pending.delete(write));
      this.pending.add(write);
    });
    this.session = session;
    this.page = page;
    await this.emulate(session);
    await session.send('Page.startScreencast', {
      format: this.opts.format,
      quality: this.opts.format === 'jpeg' ? this.opts.quality : undefined,
      maxWidth: Math.round(this.opts.width * this.opts.scale),
      maxHeight: Math.round(this.opts.height * this.opts.scale),
      everyNthFrame: 1,
    });
  }

  private async detach(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.page = null;
    if (!s) return;
    await s.send('Page.stopScreencast').catch(() => undefined);
    await s.detach().catch(() => undefined);
  }

  /** Record another page from now on (new tab, page switch). */
  async switchTo(page: Page): Promise<void> {
    if (this.stopped || page === this.page) return;
    await this.detach();
    await this.attach(page);
  }

  /** Stop capturing and wait for every pending frame write. Returns the frames sorted by time. */
  async stop(): Promise<FrameIndexEntry[]> {
    if (!this.stopped) {
      this.stopped = true;
      await this.detach();
      await Promise.all([...this.pending]);
      await new Promise<void>((resolve) => (this.index ? this.index.end(resolve) : resolve()));
      this.index = null;
    }
    this.frames.sort((a, b) => a.t - b.t);
    return this.frames;
  }

  stats(): { frames: number; write_errors: number; dropped: number } {
    return { frames: this.frames.length, write_errors: this.writeErrors, dropped: this.dropped };
  }
}

/** Pixel size of a JPEG (first SOF marker) or PNG (IHDR) image; null when it cannot be read. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
