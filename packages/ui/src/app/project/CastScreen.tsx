/**
 * Locations and cast (`#/p/<slug>/cast`) — where the product is filmed and who is signed in there: every location
 * of the project with its pages and flags, and its personas' saved sessions (Sessions.tsx SessionsPanel: each
 * persona's stored state as a shape and a word, its last check, Sign in… / Cancel / Sign in again — the same rows as
 * Prepare's sessions). A location's name opens its page (LocationScreen.tsx). The browser's row links here.
 */
import { SessionsPanel } from './Sessions.js';

export function CastScreen({ slug }: { slug: string }) {
  return (
    <div className="sc-screen cast">
      <header className="cf-head">
        <h1 className="sc-h1">Locations and cast</h1>
        <p className="sc-quiet">Where the product is filmed, and who is signed in there. Each persona signs in once; its session is saved on this Mac and reused by every take.</p>
      </header>
      <SessionsPanel slug={slug} />
    </div>
  );
}
