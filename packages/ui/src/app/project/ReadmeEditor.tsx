/**
 * The README editor (L4.1): a plain textarea (no Markdown rendering: a renderer is the largest script-injection
 * surface), saved through `project_update_readme` — the tool's atomic write — always with `if_match` (the hash the text
 * was based on; null only when there was no README).
 *
 * - Changed on disk: the event stream says when README.md changed (a `workspace` event naming this project, or a
 *   `resync` after a reconnection or a polling tick: events.ts), and on focus; the editor then re-reads the project —
 *   never while a save runs, and a re-read started before a save ended is ignored (it says nothing about the saved
 *   file). A new version with no unsaved text is loaded and announced; with unsaved text a banner offers to load it,
 *   and the edits are kept.
 * - Conflict: a save answered 409 shows both versions; "Save mine over it" re-sends with the hash of the version shown,
 *   "Load the version on disk" keeps the person's text in a read-only box to copy from.
 * - Size: the tool's cap (200,000 characters, the final line break included — the editor adds it, as the tool would)
 *   is the textarea's maxLength, with a counter; a text over it is never sent.
 * - Bytes kept: the file's line breaks (CR LF or LF) are saved as they were (drafts.ts); a README that is not UTF-8, or
 *   a symbolic link leading out of the project (project_get's readme_error), is shown read-only with why — never
 *   rewritten with replacement characters. A project with no README.md says that saving creates it.
 * - Unsaved text survives moving around the app (drafts.ts) and the end of the session (main.tsx); Cmd/Ctrl+S saves;
 *   closing the tab asks first.
 * L5.12b « Épure » 4b (R-UI-48): on the kit — a tall text area, Callouts for what changed or failed, the shared conflict
 * panel and kept text (TextEditing.tsx), the save state in words; the title bar names the project, the browser marks the
 * README "unsaved". Still no Markdown preview (deliberate: see above).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectView } from '@retake/engine';
import { CallError, errorText } from '../api.js';
import { projectGet, projectUpdateReadme, useProjectGet } from '../data/projects.js';
import { useEvents } from '../events.js';
import { Txt } from '../bits.js';
import { detectEol, getDraft, isDirty, normalizeEol, readmeKey, setDraft, toEol } from '../drafts.js';
import type { Draft } from '../drafts.js';
import { SessionEnded } from '../session.js';
import { DiskBanner, KeptText, TextConflict } from '../script/TextEditing.js';
import { Button, Callout, Kbd, TextArea } from '../ui-kit/index.js';

/** project_update_readme's cap: README.md's characters, its final line break included. */
export const README_MAX = 200_000;

/** README.md as on disk: LF text, its hash and its own line breaks. */
type Disk = Draft['base'];

const diskOf = (v: ProjectView): Disk => ({ text: normalizeEol(v.readme ?? ''), hash: v.readme_hash, eol: detectEol(v.readme ?? '') });

/** What a save writes: the text with a final line break (the tool would add it) and the file's own line breaks. */
const fileText = (text: string, eol: Draft['base']['eol']) => toEol(text.endsWith('\n') ? text : `${text}\n`, eol);

function Editor({ view }: { view: ProjectView }) {
  const slug = view.slug;
  const [draft, setLocal] = useState<Draft>(() => getDraft(readmeKey(slug)) ?? { text: diskOf(view).text, base: diskOf(view) });
  const [disk, setDisk] = useState<Disk | null>(null);
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  const [conflict, setConflict] = useState<{ mine: string; disk: Disk } | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);
  /** Bumped by every save: a re-read started before it ended says nothing about the saved file. */
  const epoch = useRef(0);

  const update = useCallback(
    (d: Draft) => {
      draftRef.current = d;
      setLocal(d);
      setDraft(readmeKey(slug), isDirty(d) ? d : undefined);
    },
    [slug],
  );

  const seeDisk = useCallback(
    (d: Disk) => {
      const cur = draftRef.current;
      if (d.hash === cur.base.hash) {
        setDisk(null);
        return;
      }
      if (!isDirty(cur)) {
        update({ text: d.text, base: d });
        setDisk(null);
        setSavedHash(null);
        setNotice(d.hash === null ? 'README.md was removed on disk.' : 'README.md changed on disk: the editor now shows the new version.');
        return;
      }
      setDisk(d);
    },
    [update],
  );

  const mounted = useRef(true);
  /** Read the file again (an event or a focus said it may have changed). */
  const reread = useCallback(async () => {
    if (savingRef.current) return;
    const e = epoch.current;
    try {
      const v = await projectGet({ project: slug });
      if (mounted.current && e === epoch.current && !savingRef.current) seeDisk(diskOf(v));
    } catch {
      // offline or the session ended: the shell says so
    }
  }, [slug, seeDisk]);

  useEffect(() => {
    mounted.current = true;
    seeDisk(diskOf(view));
    const onFocus = () => void reread();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
    };
    // The view of the first load only: later re-reads come from events and focus.
  }, [slug, seeDisk, reread]);

  useEvents((e) => {
    if ((e.type === 'workspace' && e.readme.includes(slug)) || e.type === 'resync') void reread();
  });

  const save = useCallback(
    async (over?: Disk) => {
      if (savingRef.current) return;
      const cur = draftRef.current;
      const markdown = fileText(cur.text, cur.base.eol);
      if (markdown.length > README_MAX) {
        setError(
          `README.md is limited to ${README_MAX.toLocaleString('en')} characters, its final line break included${cur.base.eol === '\r\n' ? ' (its line breaks are CR LF: two characters each)' : ''}: this text makes ${markdown.length.toLocaleString('en')}. Shorten it.`,
        );
        return;
      }
      savingRef.current = true;
      epoch.current++;
      setSaving(true);
      setError(null);
      try {
        const r = await projectUpdateReadme({ project: slug, markdown, if_match: over ? over.hash : cur.base.hash });
        // What was written, as the editor shows it; text typed during the save stays as it is.
        const text = normalizeEol(markdown);
        const now = draftRef.current;
        update({ text: now.text === cur.text ? text : now.text, base: { text, hash: r.hash, eol: cur.base.eol } });
        setDisk(null);
        setConflict(null);
        setNotice(null);
        setSavedHash(r.hash);
      } catch (e) {
        if (e instanceof SessionEnded) return;
        if (e instanceof CallError && e.error.code === 'conflict') {
          try {
            const v = await projectGet({ project: slug });
            setConflict({ mine: cur.text, disk: diskOf(v) });
          } catch (e2) {
            if (!(e2 instanceof SessionEnded)) setError(errorText(e2));
          }
        } else setError(errorText(e));
      } finally {
        savingRef.current = false;
        epoch.current++;
        setSaving(false);
      }
    },
    [slug, update],
  );

  const loadDisk = (d: Disk) => {
    const cur = draftRef.current;
    setKept(isDirty(cur) || conflict ? (conflict?.mine ?? cur.text) : null);
    update({ text: d.text, base: d });
    setDisk(null);
    setConflict(null);
    setNotice(null);
    setSavedHash(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const dirty = isDirty(draft);
  const missing = draft.base.hash === null;
  const state = saving
    ? 'Saving…'
    : conflict
      ? 'Not saved: README.md changed on disk'
      : dirty
        ? 'Unsaved changes'
        : savedHash
          ? `Saved · ${savedHash.slice(0, 12)}`
          : missing
            ? 'No README.md yet'
            : 'No changes';
  const showDisk = disk !== null && !conflict && disk.hash !== dismissed;

  return (
    <div className="rd-screen">
      <header className="rd-head">
        <h1 className="rd-h1">README.md</h1>
        <p className="rd-quiet">
          {'Of '}
          <Txt text={view.name} />
          {' — plain text (Markdown), what Claude reads first about the product, the audience, the goals and the tone.'}
        </p>
      </header>

      {missing && !conflict && (
        <Callout state="idle" role="note" title="Note: no README.md yet" testId="readme-missing">
          This project has no README.md yet: what you write here creates it when you save.
        </Callout>
      )}
      {notice && (
        <Callout state="idle" title={notice}>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        </Callout>
      )}
      {showDisk && <DiskBanner what="README.md" onLoad={() => loadDisk(disk)} onKeep={() => setDismissed(disk.hash)} />}
      {conflict && (
        <TextConflict
          what="README.md"
          mine={conflict.mine}
          disk={conflict.disk.hash === null ? null : conflict.disk.text}
          saving={saving}
          onSaveMine={() => void save(conflict.disk)}
          onLoadDisk={() => loadDisk(conflict.disk)}
          onBack={() => setConflict(null)}
        />
      )}
      {kept !== null && <KeptText text={kept} onDismiss={() => setKept(null)} />}
      {error && (
        <Callout state="fail" role="alert" title="Not saved">
          <p data-testid="readme-save-error">
            <Txt text={error} />
          </p>
        </Callout>
      )}

      <div className="rd-edit" hidden={conflict !== null}>
        <div className="rd-bar">
          <Button size="sm" variant="primary" disabled={saving || !dirty || conflict !== null} onClick={() => void save()} aria-keyshortcuts="Meta+S Control+S">
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" disabled={saving || !dirty || conflict !== null} onClick={() => update({ text: draft.base.text, base: draft.base })}>
            Discard changes
          </Button>
          <span id="readme-state" className="rd-state" role="status" aria-live="polite" data-testid="save-state">
            <Txt text={state} />
          </span>
          <span className="rd-spacer" />
          <span id="readme-count" className={draft.text.length >= README_MAX ? 'rd-count is-at-limit' : 'rd-count'}>
            <Txt text={`${draft.text.length.toLocaleString('en')} / ${README_MAX.toLocaleString('en')} characters`} />
          </span>
          <span className="rd-keys">
            <Kbd keys={['⌘', 'S']} />
            {' / '}
            <Kbd keys={['Ctrl', 'S']} />
          </span>
        </div>
        <TextArea
          id="readme-text"
          label="Text of README.md"
          labelHidden
          tall
          rows={24}
          value={draft.text}
          maxLength={README_MAX}
          readOnly={conflict !== null}
          spellCheck
          unsaved={null}
          describedBy="readme-count readme-state"
          onChange={(text) => {
            setError(null);
            setNotice(null);
            update({ text, base: draftRef.current.base });
          }}
        />
      </div>
    </div>
  );
}

/**
 * A README the editor must not rewrite (project_get's readme_error): why, the text when it could be read (read-only),
 * and any unsaved text of this project, kept to copy.
 */
function ReadOnly({ view }: { view: ProjectView }) {
  const mine = getDraft(readmeKey(view.slug));
  return (
    <div className="rd-screen">
      <header className="rd-head">
        <h1 className="rd-h1">README.md</h1>
      </header>
      <div data-testid="readme-readonly">
        <Callout state="warn" role="alert" title="README.md cannot be edited here">
          <p className="rd-pre">
            <Txt text={view.readme_error ?? ''} />
          </p>
        </Callout>
      </div>
      {view.readme !== null && <TextArea label="README.md (read-only)" labelHidden tall rows={24} value={view.readme} onChange={() => undefined} unsaved={null} readOnly />}
      {mine && isDirty(mine) && (
        <Callout state="idle" title="Note: your unsaved text">
          <p>Not saved anywhere: copy it before you leave.</p>
          <TextArea label="Your unsaved text" labelHidden rows={6} value={mine.text} onChange={() => undefined} unsaved={null} readOnly />
        </Callout>
      )}
    </div>
  );
}

export function ReadmeEditor({ slug }: { slug: string }) {
  const [view, reload] = useProjectGet({ project: slug }, slug);
  // README.md may become (or stop being) one the editor must not rewrite: the view follows it.
  useEvents((e) => {
    if ((e.type === 'workspace' && e.readme.includes(slug)) || e.type === 'resync') reload();
  });
  if (view.state === 'loading') {
    return (
      <div className="rd-screen">
        <p className="rd-quiet" role="status">
          Loading the README…
        </p>
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="rd-screen">
        <h1 className="k-sr">README.md</h1>
        <Callout state="fail" role="alert" title="This README cannot be opened">
          <p className="rd-pre">
            <Txt text={view.error} />
          </p>
        </Callout>
      </div>
    );
  }
  if (view.data.readme_error) return <ReadOnly view={view.data} />;
  return <Editor key={slug} view={view.data} />;
}
