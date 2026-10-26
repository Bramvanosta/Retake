/**
 * Server-sent events read from a fetch response (L4.4: the Run screen's stream; the event stream of events.ts has its
 * own loop and shares parseSseBlock). Blocks are split on a blank line; `event:` names the event, `data:` holds one JSON line;
 * comment lines (keepalives) are skipped. A block that is not JSON is dropped: the page never evaluates what it reads.
 */

export type SseEnd = 'closed' | 'failed';

/**
 * One event block: its `event:` and `data:` lines, split on `\n` only (review A M1: a `/^…$/m` match also ends a line
 * at U+2028 / U+2029, which JSON leaves raw in a page's text — the event was lost). Null for a comment-only block.
 */
export function parseSseBlock(block: string): { type: string; data: string } | null {
  let type: string | undefined;
  let data: string | undefined;
  for (const line of block.split('\n')) {
    if (type === undefined && line.startsWith('event: ')) type = line.slice(7);
    else if (data === undefined && line.startsWith('data: ')) data = line.slice(6);
  }
  return type && data !== undefined ? { type, data } : null;
}

/** Read `res` until it ends, calling `on(type, data)` for each event; `false` from `on` stops reading. */
export async function readSse(res: Response, on: (type: string, data: unknown) => boolean | void): Promise<SseEnd> {
  if (!res.body) return 'failed';
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'closed';
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseSseBlock(block);
        if (!ev) continue;
        const { type } = ev;
        let body: unknown;
        try {
          body = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (on(type, body) === false) {
          await reader.cancel().catch(() => undefined);
          return 'closed';
        }
      }
    }
  } catch {
    return 'failed';
  } finally {
    reader.releaseLock();
  }
}
