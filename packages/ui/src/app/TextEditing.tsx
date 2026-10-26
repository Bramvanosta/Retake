/**
 * The pieces the app's text editors share (L4.1's README editor, L4.3's scenario YAML tab): the "changed on disk"
 * banner shown while the person has unsaved text, the conflict panel of a save answered 409 (both versions side by
 * side: "Save mine over it" re-sends with the hash of the version shown, "Load the version on disk" keeps the
 * person's text read-only to copy, "Back to editing"), and that kept text. Every string is a text node or a read-only
 * textarea's value.
 */
import { Notice } from './bits.js';

/** The file changed on disk while the person has unsaved text: load it, or keep editing (the save then asks). */
export function DiskBanner({ what, onLoad, onKeep }: { what: string; onLoad: () => void; onKeep: () => void }) {
  return (
    <Notice tone="warning" role="alert" title={`${what} changed on disk`}>
      <p>The file changed while you were editing (in an editor, a terminal or by Claude). Your edits are kept; saving them will ask which version wins.</p>
      <div className="actions">
        <button type="button" className="button" onClick={onLoad}>
          Load the version on disk
        </button>
        <button type="button" className="button quiet" onClick={onKeep}>
          Keep editing mine
        </button>
      </div>
    </Notice>
  );
}

/** A save answered 409: both versions, and which one wins. `disk` null: the file is gone. */
export function TextConflict({
  what,
  mine,
  disk,
  saving,
  onSaveMine,
  onLoadDisk,
  onBack,
}: {
  what: string;
  mine: string;
  disk: string | null;
  saving: boolean;
  /** Absent: the version on disk cannot be overwritten from here (only loaded). */
  onSaveMine?: () => void;
  onLoadDisk: () => void;
  onBack: () => void;
}) {
  return (
    <section className="conflict" role="alert" aria-labelledby="conflict-h" data-testid="conflict">
      <h2 id="conflict-h">{what} changed on disk since your text was loaded</h2>
      <p>Your text was not saved. Keep one version — copy what you need from the other first.</p>
      <div className="compare">
        <label className="field">
          <span className="label">Your text</span>
          <textarea readOnly value={mine} rows={12} />
        </label>
        <label className="field">
          <span className="label">{disk === null ? `On disk now: no ${what}` : 'On disk now'}</span>
          <textarea readOnly value={disk ?? ''} rows={12} data-testid="conflict-disk" />
        </label>
      </div>
      <div className="actions">
        {onSaveMine && (
          <button type="button" className="button primary" disabled={saving} onClick={onSaveMine}>
            Save mine over it
          </button>
        )}
        <button type="button" className="button" disabled={saving} onClick={onLoadDisk}>
          Load the version on disk
        </button>
        <button type="button" className="button quiet" onClick={onBack}>
          Back to editing
        </button>
      </div>
    </section>
  );
}

/** The person's previous text after loading the version on disk: to copy from, saved nowhere. */
export function KeptText({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Notice tone="info" title="Your previous text">
      <p>The editor now shows the version on disk. Your text is here to copy from; it is not saved anywhere.</p>
      <textarea className="kept" readOnly aria-label="Your previous text" value={text} rows={6} />
      <button type="button" className="button small" onClick={onDismiss}>
        Dismiss
      </button>
    </Notice>
  );
}
