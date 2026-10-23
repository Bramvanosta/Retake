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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectView } from '@demo-studio/engine';
import { CallError, call, errorText, useCall } from './api.js';
import { useEvents } from './events.js';
import { Loading, Notice, Txt } from './bits.js';
import { detectEol, getDraft, isDirty, normalizeEol, setDraft, toEol } from './drafts.js';
import type { Draft } from './drafts.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';

/** project_update_readme's cap: README.md's characters, its final line break included. */
export const README_MAX = 200_000;

/** README.md as on disk: LF text, its hash and its own line breaks. */
type Disk = Draft['base'];

const diskOf = (v: ProjectView): Disk => ({ text: normalizeEol(v.readme ?? ''), hash: v.readme_hash, eol: detectEol(v.readme ?? '') });

/** What a save writes: the text with a final line break (the tool would add it) and the file's own line breaks. */
const fileText = (text: string, eol: Draft['base']['eol']) => toEol(text.endsWith('\n') ? text : `${text}\n`, eol);

function Breadcrumb({ slug, name }: { slug: string; name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={name} />
      </a>
      <span aria-hidden="true"> / </span>
      <span aria-current="page">README</span>
    </nav>
  );
}

function Editor({ view }: { view: ProjectView }) {
  const slug = view.slug;
  const [draft, setLocal] = useState<Draft>(() => getDraft(slug) ?? { text: diskOf(view).text, base: diskOf(view) });
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
      setDraft(slug, isDirty(d) ? d : undefined);
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
      const v = await call<ProjectView>('project_get', { project: slug });
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
        const r = await call<{ hash: string }>('project_update_readme', { project: slug, markdown, if_match: over ? over.hash : cur.base.hash });
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
            const v = await call<ProjectView>('project_get', { project: slug });
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
  const state = saving ? 'Saving…' : conflict ? 'Not saved: README.md changed on disk' : dirty ? 'Unsaved changes' : savedHash ? `Saved · ${savedHash.slice(0, 12)}` : missing ? 'No README.md yet' : 'No changes';
  const showDisk = disk !== null && !conflict && disk.hash !== dismissed;

  return (
    <div className="screen editor-screen">
      <Breadcrumb slug={slug} name={view.name} />
      <header className="screen-head">
        <h1>README.md</h1>
        <p className="muted">
          Of <Txt text={view.name} /> — plain text (Markdown), what Claude reads first about the product, the audience, the goals and the tone.
        </p>
      </header>

      {missing && !conflict && (
        <p className="muted" data-testid="readme-missing">
          This project has no README.md yet: what you write here creates it when you save.
        </p>
      )}
      {notice && (
        <Notice tone="info">
          <p>{notice}</p>
          <button type="button" className="button small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Notice>
      )}
      {showDisk && (
        <Notice tone="warning" role="alert" title="README.md changed on disk">
          <p>The file changed while you were editing (in an editor, a terminal or by Claude). Your edits are kept; saving them will ask which version wins.</p>
          <div className="actions">
            <button type="button" className="button" onClick={() => loadDisk(disk)}>
              Load the version on disk
            </button>
            <button type="button" className="button quiet" onClick={() => setDismissed(disk.hash)}>
              Keep editing mine
            </button>
          </div>
        </Notice>
      )}
      {conflict && (
        <section className="conflict" role="alert" aria-labelledby="conflict-h" data-testid="conflict">
          <h2 id="conflict-h">README.md changed on disk since your text was loaded</h2>
          <p>Your text was not saved. Keep one version — copy what you need from the other first.</p>
          <div className="compare">
            <label className="field">
              <span className="label">Your text</span>
              <textarea readOnly value={conflict.mine} rows={12} />
            </label>
            <label className="field">
              <span className="label">{conflict.disk.hash === null ? 'On disk now: no README.md' : 'On disk now'}</span>
              <textarea readOnly value={conflict.disk.text} rows={12} data-testid="conflict-disk" />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="button primary" disabled={saving} onClick={() => void save(conflict.disk)}>
              Save mine over it
            </button>
            <button type="button" className="button" disabled={saving} onClick={() => loadDisk(conflict.disk)}>
              Load the version on disk
            </button>
            <button type="button" className="button quiet" onClick={() => setConflict(null)}>
              Back to editing
            </button>
          </div>
        </section>
      )}
      {kept !== null && (
        <Notice tone="info" title="Your previous text">
          <p>The editor now shows the version on disk. Your text is here to copy from; it is not saved anywhere.</p>
          <textarea className="kept" readOnly aria-label="Your previous text" value={kept} rows={6} />
          <button type="button" className="button small" onClick={() => setKept(null)}>
            Dismiss
          </button>
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert" title="Not saved">
          <p>{error}</p>
        </Notice>
      )}

      <div className="editor" hidden={conflict !== null}>
        <label htmlFor="readme-text" className="label">
          Text of README.md
        </label>
        <textarea
          id="readme-text"
          className="readme-input"
          value={draft.text}
          maxLength={README_MAX}
          readOnly={conflict !== null}
          spellCheck
          aria-describedby="readme-count readme-state"
          onChange={(e) => {
            setError(null);
            setNotice(null);
            update({ text: e.target.value, base: draftRef.current.base });
          }}
        />
        <div className="editor-bar">
          <button type="button" className="button primary" disabled={saving || !dirty || conflict !== null} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="button quiet" disabled={saving || !dirty || conflict !== null} onClick={() => update({ text: draft.base.text, base: draft.base })}>
            Discard changes
          </button>
          <span id="readme-state" className="save-state" role="status" aria-live="polite" data-testid="save-state">
            {state}
          </span>
          <span className="spacer" />
          <span id="readme-count" className={draft.text.length >= README_MAX ? 'counter at-limit' : 'counter'}>
            {draft.text.length.toLocaleString('en')} / {README_MAX.toLocaleString('en')} characters
          </span>
          <span className="muted small">
            <kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A README the editor must not rewrite (project_get's readme_error): why, the text when it could be read (read-only),
 * and any unsaved text of this project, kept to copy.
 */
function ReadOnly({ view }: { view: ProjectView }) {
  const mine = getDraft(view.slug);
  return (
    <div className="screen editor-screen">
      <Breadcrumb slug={view.slug} name={view.name} />
      <header className="screen-head">
        <h1>README.md</h1>
      </header>
      <div data-testid="readme-readonly">
        <Notice tone="warning" role="alert" title="README.md cannot be edited here">
          <p className="pre-line">
            <Txt text={view.readme_error ?? ''} />
          </p>
        </Notice>
      </div>
      {view.readme !== null && <textarea className="readme-input" readOnly aria-label="README.md (read-only)" value={view.readme} />}
      {mine && isDirty(mine) && (
        <Notice tone="info" title="Your unsaved text">
          <p>Not saved anywhere: copy it before you leave.</p>
          <textarea className="kept" readOnly aria-label="Your unsaved text" value={mine.text} rows={6} />
        </Notice>
      )}
    </div>
  );
}

export function ReadmeEditor({ slug }: { slug: string }) {
  const [view, reload] = useCall<ProjectView>('project_get', { project: slug }, slug);
  // README.md may become (or stop being) one the editor must not rewrite: the view follows it.
  useEvents((e) => {
    if ((e.type === 'workspace' && e.readme.includes(slug)) || e.type === 'resync') reload();
  });
  if (view.state === 'loading') {
    return (
      <div className="screen">
        <Loading what="the README" />
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="screen">
        <Breadcrumb slug={slug} name={slug} />
        <Notice tone="danger" role="alert" title="This README cannot be opened">
          <p className="pre-line">
            <Txt text={view.error} />
          </p>
        </Notice>
      </div>
    );
  }
  if (view.data.readme_error) return <ReadOnly view={view.data} />;
  return <Editor key={slug} view={view.data} />;
}
