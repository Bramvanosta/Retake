/**
 * L5.10a: the Cast (`#/p/<slug>/cast`) — the project's personas and their saved sessions; L5.11a: on the kit
 * (Sessions.tsx SessionsPanel: one section per location, each persona's stored state as a shape and a word, its last
 * check, Sign in… / Cancel / Sign in again — the same rows as Prepare's sessions). The browser's Cast rows link here.
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
