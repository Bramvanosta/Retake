/**
 * The pieces the app's text editors share (L4.1's README editor, L4.3's scenario YAML; L5.10b: on the kit): the
 * "changed on disk" callout shown while the person has unsaved text, the conflict panel of a save answered 409 (both
 * versions side by side: "Save mine over it" re-sends with the hash of the version shown, "Load the version on disk"
 * keeps the person's text read-only to copy, "Back to editing"), and that kept text. Every string is a text node or a
 * read-only text area's value (their marks: none — no one's unsaved work is in them).
 */
import { shown } from './bits.js';
import { Button, Callout, TextArea } from './ui-kit/index.js';

/** The file changed on disk while the person has unsaved text: load it, or keep editing (the save then asks). */
export function DiskBanner({ what, onLoad, onKeep }: { what: string; onLoad: () => void; onKeep: () => void }) {
  return (
    <Callout state="warn" role="alert" title={`${what} changed on disk`}>
      <p>The file changed while you were editing (in an editor, a terminal or by Claude). Your edits are kept; saving them will ask which version wins.</p>
      <div className="sb-actions">
        <Button size="sm" onClick={onLoad}>
          Load the version on disk
        </Button>
        <Button size="sm" variant="ghost" onClick={onKeep}>
          Keep editing mine
        </Button>
      </div>
    </Callout>
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
    <section className="sb-conflict" role="alert" aria-labelledby="conflict-h" data-testid="conflict">
      <h2 id="conflict-h" className="sc-h2">
        {shown(`${what} changed on disk since your text was loaded`)}
      </h2>
      <p className="sc-quiet">Your text was not saved. Keep one version — copy what you need from the other first.</p>
      <div className="sb-compare">
        <TextArea label="Your text" value={mine} onChange={() => undefined} unsaved={null} readOnly mono rows={12} />
        <TextArea label={disk === null ? `On disk now: no ${what}` : 'On disk now'} value={disk ?? ''} onChange={() => undefined} unsaved={null} readOnly mono rows={12} testId="conflict-disk" />
      </div>
      <div className="sb-actions">
        {onSaveMine && (
          <Button variant="primary" disabled={saving} onClick={onSaveMine}>
            Save mine over it
          </Button>
        )}
        <Button disabled={saving} onClick={onLoadDisk}>
          Load the version on disk
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back to editing
        </Button>
      </div>
    </section>
  );
}

/** The person's previous text after loading the version on disk: to copy from, saved nowhere. */
export function KeptText({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <Callout state="idle" title="Note: your previous text">
      <p>The editor now shows the version on disk. Your text is here to copy from; it is not saved anywhere.</p>
      <TextArea label="Your previous text" labelHidden value={text} onChange={() => undefined} unsaved={null} readOnly mono rows={6} />
      <div>
        <Button size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Callout>
  );
}
