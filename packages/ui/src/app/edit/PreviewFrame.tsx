/**
 * The preview frame (L4.5 part C, DESIGN §4g): the app's one `<iframe>` — the Remotion Player in the sandboxed frame
 * of the player origin, which only displays (every control lives in the page: TimelineScreen.tsx).
 *
 * - Its attributes are fixed literals, the same as player/parent.ts's PREVIEW_FRAME_ATTRS (the source lint checks
 *   both): `sandbox="allow-scripts"` and no other sandbox token, no Referer, autoplay (the music after Unmute), out of
 *   the tab order and the accessibility tree (the page's preview region carries the label).
 * - `src` is `url` only — a frame URL `previewUrls` checked (`http://127.0.0.1:<port>/s/<capability>/frame`) — and only
 *   after `connectPreview` listens for the frame's hello (the frame says hello from its own load event; nothing it
 *   posts before the listener exists could be taken): the first render has no src, the layout effect connects, then
 *   the src is set.
 * - On each hello (a reload says it again) the page sends `load {plan_url, frame}`; on each new plan URL (a switch, a
 *   file changed) it sends `load` again on the same frame — no reload, the media URLs stay (critique B6).
 * - A stopped preview (a flood, an invalid message) has had its iframe removed by parent.ts: the page unmounts this
 *   component (its wrapper goes, never the removed node) and a restart mounts a new one.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { connectPreview } from '../../player/parent.js';
import type { PreviewConnection } from '../../player/parent.js';
import type { FrameMessage } from '../../player/protocol.js';

export interface PreviewFrameProps {
  /** The checked frame URL (previewUrls). */
  url: string;
  /** The checked plan URL of the same capability. */
  planUrl: string;
  /** The frame to show when a plan loads (the page's playhead). */
  frameRef: MutableRefObject<number>;
  onMessage(m: FrameMessage): void;
  /** The frame said hello (a load is sent at once). */
  onHello(): void;
  onStop(reason: string): void;
  /** The connection (null once gone): the page posts seek / play / pause / mute through it. */
  onConnection(c: PreviewConnection | null): void;
}

export function PreviewFrame({ url, planUrl, frameRef, onMessage, onHello, onStop, onConnection }: PreviewFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [armed, setArmed] = useState(false);
  const plan = useRef(planUrl);
  plan.current = planUrl;
  const sent = useRef<string | null>(null);
  const conn = useRef<PreviewConnection | null>(null);
  const on = useRef({ onMessage, onHello, onStop, onConnection });
  on.current = { onMessage, onHello, onStop, onConnection };

  useLayoutEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const c = connectPreview(iframe, {
      onHello: () => {
        sent.current = plan.current;
        c.send({ type: 'load', plan_url: plan.current, frame: frameRef.current });
        on.current.onHello();
      },
      onMessage: (m) => on.current.onMessage(m),
      onStop: (reason) => {
        conn.current = null;
        on.current.onConnection(null);
        on.current.onStop(reason);
      },
    });
    conn.current = c;
    on.current.onConnection(c);
    // Listening: the frame's address may be set now.
    setArmed(true);
    return () => {
      c.close();
      conn.current = null;
      on.current.onConnection(null);
    };
  }, [frameRef]);

  useEffect(() => {
    const c = conn.current;
    if (!c?.connected || sent.current === planUrl) return;
    sent.current = planUrl;
    c.send({ type: 'load', plan_url: planUrl, frame: frameRef.current });
  }, [planUrl, frameRef]);

  const frameSrc = armed ? url : undefined;
  // The wrapper is React's own node: when parent.ts removes the iframe (a stopped preview), unmounting this component
  // removes the wrapper, never the node already gone.
  return (
    <div className="pv-frame-box">
      <iframe
        ref={ref}
        className="pv-frame"
        title="Preview"
        data-testid="preview-frame"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="autoplay"
        aria-hidden="true"
        tabIndex={-1}
        src={frameSrc}
      />
    </div>
  );
}
