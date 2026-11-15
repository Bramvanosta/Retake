/** Reading a growing JSON-lines file from byte offsets (the Run screen's stream, run-live.ts): complete lines only, bounded. */
import type { RangeRead } from '@retake/engine';

/** Bytes read from one file per read, at most. */
export const LIVE_READ_CHUNK = 256 * 1024;
/** A line of log.jsonl / events.jsonl longer than this is skipped (with a note). */
export const LIVE_LINE_MAX = 64 * 1024;
/** On connect, a log longer than this is read from its last LIVE_TAIL_MAX bytes. */
export const LIVE_TAIL_MAX = 8 * 1024 * 1024;

// ─── reading a growing JSON-lines file from byte offsets ─────────────────────────────────────────────────────────────

/** A ranged read of a growing file: its bytes from an offset and its size, or why none. */
type TailRead = RangeRead | { ok: false; reason: string };

/** Lines of a growing file, from a byte offset: complete lines only, each with the offset of its end. */
export class JsonlTail {
  private partial: Buffer[] = [];
  private partialLen = 0;
  /** In a line to drop up to its end: one longer than LIVE_LINE_MAX (said in a note), or the cut line at a tail start. */
  private skipping: 'long' | 'cut' | null;
  /** Where the next read starts. */
  private next: number;
  /** The end of the last complete line handed out. */
  cursor: number;
  /** The read failed for a reason other than "not there yet" (a link, not a file): no further read. */
  broken: string | null = null;

  constructor(
    private readonly read: (offset: number, max: number) => TailRead | Promise<TailRead>,
    start: number,
    /** True when `start` may fall inside a line (a tail start): its rest is dropped. */
    cut = false,
  ) {
    this.next = start;
    this.cursor = start;
    this.skipping = cut ? 'cut' : null;
  }

  /** New complete lines (at most `budget` bytes read); `notes` says what was skipped. */
  async pull(budget: number): Promise<{ lines: Array<{ text: string; end: number }>; notes: string[]; size: number | null }> {
    const lines: Array<{ text: string; end: number }> = [];
    const notes: string[] = [];
    let size: number | null = null;
    while (!this.broken && budget > 0) {
      const r = await this.read(this.next, Math.min(LIVE_READ_CHUNK, budget));
      if (!r.ok) {
        if (r.reason !== 'missing') this.broken = r.reason;
        break;
      }
      size = r.size;
      if (r.size < this.next) {
        // The file is shorter than what was read: it was replaced — nothing of it is trusted to line up any more.
        this.broken = 'replaced';
        notes.push('the run log was replaced while it was read: reopen the run');
        break;
      }
      if (r.bytes.length === 0) break;
      const base = this.next;
      this.next += r.bytes.length;
      budget -= r.bytes.length;
      let from = 0;
      for (;;) {
        const nl = r.bytes.indexOf(0x0a, from);
        if (nl < 0) break;
        const end = base + nl + 1;
        if (this.skipping) {
          if (this.skipping === 'long') notes.push(`a line longer than ${LIVE_LINE_MAX / 1024} KiB was skipped`);
          this.skipping = null;
        } else if (this.partialLen + (nl - from) > LIVE_LINE_MAX) {
          notes.push(`a line longer than ${LIVE_LINE_MAX / 1024} KiB was skipped`);
        } else {
          const piece = r.bytes.subarray(from, nl);
          const text = this.partialLen ? Buffer.concat([...this.partial, piece]).toString('utf8') : piece.toString('utf8');
          lines.push({ text, end });
        }
        this.partial = [];
        this.partialLen = 0;
        this.cursor = end;
        from = nl + 1;
      }
      if (from < r.bytes.length && !this.skipping) {
        const rest = r.bytes.subarray(from);
        if (this.partialLen + rest.length > LIVE_LINE_MAX) {
          this.partial = [];
          this.partialLen = 0;
          this.skipping = 'long';
        } else {
          this.partial.push(Buffer.from(rest));
          this.partialLen += rest.length;
        }
      }
      if (r.bytes.length < LIVE_READ_CHUNK) break;
    }
    return { lines, notes, size };
  }
}
