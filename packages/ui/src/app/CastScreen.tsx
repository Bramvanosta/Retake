/**
 * L5.10a: the Cast (`#/p/<slug>/cast`) — the project's personas and their saved sessions: today's Sessions panel (L4.4:
 * each persona's stored state, Sign in, Cancel), hosted as it is until L5.11's preflight rebuilds it; the browser's Cast
 * rows (a shape and a word per persona) link here.
 */
import { SessionsPanel } from './Sessions.js';

export function CastScreen({ slug }: { slug: string }) {
  return (
    <div className="sc-screen cast">
      <h1 className="sc-h1">Cast</h1>
      <p className="sc-quiet">Each persona signs in once; its session is saved on this Mac and reused by every take.</p>
      <SessionsPanel slug={slug} />
    </div>
  );
}
