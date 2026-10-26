/**
 * The scenario's YAML tab (L4.3, R-UI-11): the file read-only (YamlView) until the person presses Edit, then a plain
 * textarea (no highlighting: no dependency, no HTML from data) saved through `scenario_edit` `replace_text` — the
 * Studio's one write path: the hash the text was based on as if_match, validated by the server (errors refuse the save
 * and come back with their lines, the draft kept; warnings save), worded "from the Studio".
 *
 * - Draft: kept per scenario while the person moves around the app (drafts.ts `scenario:<slug>/<name>`), with the
 *   file's own line breaks (CR LF stays CR LF) and a final line break added on save (as scenario_save); closing the
 *   tab asks first; the session-ended page keeps it to copy. While it holds unsaved text the Blocks tab says block
 *   editing is off (critique B7: a block edit would make the draft's base stale).
 * - Live issues: `scenario_validate` 400 ms after typing stops, one call in flight at a time.
 * - Changed on disk: the screen re-reads its view when the file changes (events, focus); a new version with no
 *   unsaved text is loaded and announced, with unsaved text a banner offers to load it. A view showing a version this
 *   tab already replaced (a re-read that started before its save ended) is ignored. A save answered 409 opens the
 *   conflict panel (TextEditing.tsx) with the version on disk.
 * - Read-only with why (critique B3) when the Studio may not save the file (the view's `edit.yaml`): not UTF-8, too
 *   large, a carriage return without a line feed (the textarea would show a line break YAML does not read), a link out
 *   of scenarios/, or holding a secret reference / an outside file — each problem with its line; any unsaved text stays
 *   to copy. The draft turns only CR LF into LF (drafts.ts `crlfToLf`).
 * - Hidden characters: lines of the draft that hold a direction control or an invisible character are listed (the
 *   server refuses one it did not have, or one moved to another line).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ValidationIssue } from '@demo-studio/core';
import { CallError, call, errorText } from './api.js';
import { Badge, Notice, plural, Txt } from './bits.js';
import { crlfToLf, detectEol, getDraft, isDirty, scenarioKey, setDraft, toEol } from './drafts.js';
import type { Draft } from './drafts.js';
import type { View } from './scenario-words.js';
import { SessionEnded } from './session.js';
import { DiskBanner, KeptText, TextConflict } from './TextEditing.js';
import { YamlView } from './YamlView.js';

/** The largest scenario the Studio writes (core SCENARIO_EDIT_MAX_CHARS: MCP scenario_save's cap), final line break included. */
export const YAML_MAX = 500_000;

type Disk = Draft['base'];
const diskOf = (v: Pick<View, 'text' | 'hash'>): Disk => ({ text: crlfToLf(v.text), hash: v.hash, eol: detectEol(v.text) });
/** What a save writes: the text with a final line break and the file's own line breaks. */
const fileText = (text: string, eol: Disk['eol']) => toEol(text.endsWith('\n') || text === '' ? text : `${text}\n`, eol);

// The class of core's input rules (scenario-edit.ts, review A L2): controls (tab left out), format and default-ignorable
// characters (direction controls, zero-width, soft hyphen, variation selectors, tags…), line / paragraph separators,
// the Hangul fillers and the braille blank — as property escapes and code points, never literal characters here.
const HIDDEN = /(?!\t)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{115f}\u{1160}\u{2800}\u{3164}\u{ffa0}]/u;
const hex = (c: string) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Lines of `text` holding a hidden character, at most 20: "line 7 (U+202E)". */
function hiddenLines(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((l, i) => {
    if (out.length >= 20) return;
    const m = HIDDEN.exec(i === 0 ? l.replace(/^\u{feff}/u, '') : l);
    if (m) out.push(`line ${i + 1} (${hex(m[0])})`);
  });
  return out;
}

function Issues({ issues, testid }: { issues: ValidationIssue[]; testid: string }) {
  return (
    <ul className="issues" data-testid={testid}>
      {issues.map((i, n) => (
        <li key={n}>
          <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{i.severity}</Badge>{' '}
          {i.line !== undefined && <span className="mono small">{`line ${i.line}${i.col !== undefined ? `:${i.col}` : ''}`} </span>}
          <Txt text={i.message} />
        </li>
      ))}
    </ul>
  );
}

interface SaveAnswer {
  hash: string;
  label: string;
  warnings: ValidationIssue[];
}

function Editor({
  v,
  slug,
  name,
  focus,
  reload,
  onClose,
  onSaved,
}: {
  v: View;
  slug: string;
  name: string;
  focus: { line: number } | null;
  reload: () => void;
  onClose: () => void;
  onSaved?: (hash: string) => void;
}) {
  const key = scenarioKey(slug, name);
  const [draft, setLocal] = useState<Draft>(() => getDraft(key) ?? { text: diskOf(v).text, base: diskOf(v) });
  const [disk, setDisk] = useState<Disk | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ mine: string; disk: Disk } | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; issues: ValidationIssue[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ hash: string; warnings: number } | null>(null);
  const [live, setLive] = useState<{ text: string; issues: ValidationIssue[] } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(false);
  /** Versions this tab replaced by a save: a view still showing one is a re-read from before the save. */
  const superseded = useRef(new Set<string>());
  const area = useRef<HTMLTextAreaElement>(null);

  const update = useCallback(
    (d: Draft) => {
      draftRef.current = d;
      setLocal(d);
      setDraft(key, isDirty(d) ? d : undefined);
    },
    [key],
  );

  // The view changed (an event, a focus, this tab's own save): a new version on disk?
  useEffect(() => {
    if (savingRef.current || superseded.current.has(v.hash)) return;
    const d = diskOf(v);
    const cur = draftRef.current;
    if (d.hash === cur.base.hash) {
      setDisk(null);
      return;
    }
    if (!isDirty(cur)) {
      update({ text: d.text, base: d });
      setDisk(null);
      setSaved(null);
      setNotice(`${v.file} changed on disk: the editor now shows the new version.`);
      return;
    }
    setDisk(d);
  }, [v, update]);

  // "Show in YAML" while editing: the caret to that line.
  useEffect(() => {
    const el = area.current;
    if (!focus || !el) return;
    const lines = el.value.split('\n');
    const at = lines.slice(0, Math.max(0, focus.line - 1)).reduce((n, l) => n + l.length + 1, 0);
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    el.scrollTop = Math.max(0, (focus.line - 4) * (parseFloat(getComputedStyle(el).lineHeight) || 19));
  }, [focus]);

  // Live issues: 400 ms after the last keystroke, one call in flight (the newest text read after it ends).
  const inflight = useRef(false);
  const pending = useRef<string | null>(null);
  const check = useCallback(
    (text: string) => {
      if (inflight.current) {
        pending.current = text;
        return;
      }
      inflight.current = true;
      call<{ issues: ValidationIssue[] }>('scenario_validate', { project: slug, name, yaml: text })
        .then(
          (r) => setLive({ text, issues: r.issues }),
          () => undefined,
        )
        .finally(() => {
          inflight.current = false;
          const next = pending.current;
          pending.current = null;
          if (next !== null && next !== text) check(next);
        });
    },
    [slug, name],
  );
  useEffect(() => {
    if (!isDirty(draft) || draft.text.length > YAML_MAX) return;
    const t = setTimeout(() => check(draft.text), 400);
    return () => clearTimeout(t);
  }, [draft, check]);

  const save = useCallback(
    async (over?: Disk) => {
      if (savingRef.current) return;
      const cur = draftRef.current;
      const text = fileText(cur.text, cur.base.eol);
      if (text.length > YAML_MAX) {
        setError({ message: `A scenario saved from the Studio holds at most ${YAML_MAX.toLocaleString('en')} characters, its final line break included: this text makes ${text.length.toLocaleString('en')}. Shorten it.`, issues: [] });
        return;
      }
      const base = over ?? cur.base;
      if (base.hash === null) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        const r = await call<SaveAnswer>('scenario_edit', { project: slug, name, hash: base.hash, edit: { kind: 'replace_text', text } });
        superseded.current.add(base.hash);
        if (cur.base.hash) superseded.current.add(cur.base.hash);
        superseded.current.delete(r.hash);
        const written = crlfToLf(text);
        const now = draftRef.current;
        update({ text: now.text === cur.text ? written : now.text, base: { text: written, hash: r.hash, eol: cur.base.eol } });
        setDisk(null);
        setConflict(null);
        setNotice(null);
        setSaved({ hash: r.hash, warnings: r.warnings.length });
        onSaved?.(r.hash);
        reload();
      } catch (e) {
        if (e instanceof SessionEnded) return;
        if (e instanceof CallError && e.error.code === 'conflict') {
          try {
            const now = await call<View>('scenario_blocks', { project: slug, name });
            setConflict({ mine: cur.text, disk: diskOf(now) });
          } catch (e2) {
            if (!(e2 instanceof SessionEnded)) setError({ message: errorText(e2), issues: [] });
          }
        } else {
          const issues = e instanceof CallError && Array.isArray(e.error.details?.issues) ? (e.error.details.issues as ValidationIssue[]) : [];
          setError({ message: issues.length ? `${plural(issues.filter((i) => i.severity === 'error').length, 'error')} in this text: nothing was written, your text is kept.` : errorText(e), issues });
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [slug, name, update, reload, onSaved],
  );

  const loadDisk = (d: Disk) => {
    const cur = draftRef.current;
    setKept(isDirty(cur) || conflict ? (conflict?.mine ?? cur.text) : null);
    update({ text: d.text, base: d });
    setDisk(null);
    setConflict(null);
    setNotice(null);
    setSaved(null);
    setError(null);
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
  const state = saving
    ? 'Saving…'
    : conflict
      ? `Not saved: ${v.file} changed on disk`
      : dirty
        ? 'Unsaved changes'
        : saved
          ? `Saved · ${saved.hash.slice(0, 12)}${saved.warnings ? ` · ${plural(saved.warnings, 'warning')}` : ''}`
          : 'No changes';
  const showDisk = disk !== null && !conflict && disk.hash !== dismissed;
  const hidden = hiddenLines(draft.text);
  const liveIssues = dirty && live && live.text === draft.text ? live.issues : null;
  const shownIssues = liveIssues ?? (dirty ? [] : null);

  return (
    <section className="card yaml-card yaml-editor" aria-labelledby="yaml-edit-h" data-testid="yaml-editor">
      <h2 id="yaml-edit-h" className="card-title">
        <Txt className="path" text={v.file} /> <span className="muted small">editing</span>
      </h2>
      {notice && (
        <Notice tone="info">
          <p>{notice}</p>
          <button type="button" className="button small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Notice>
      )}
      {showDisk && <DiskBanner what={v.file} onLoad={() => loadDisk(disk)} onKeep={() => setDismissed(disk.hash)} />}
      {conflict && (
        <TextConflict
          what={v.file}
          mine={conflict.mine}
          disk={conflict.disk.text}
          saving={saving}
          onSaveMine={() => void save(conflict.disk)}
          onLoadDisk={() => loadDisk(conflict.disk)}
          onBack={() => setConflict(null)}
        />
      )}
      {kept !== null && <KeptText text={kept} onDismiss={() => setKept(null)} />}
      {error && (
        <Notice tone="danger" role="alert" title="Not saved">
          <p className="pre-line" data-testid="yaml-save-error">
            <Txt text={error.message} />
          </p>
          {error.issues.length > 0 && <Issues issues={error.issues} testid="yaml-save-issues" />}
        </Notice>
      )}
      {hidden.length > 0 && (
        <Notice tone="warning" role="note" title="Hidden characters">
          <p data-testid="yaml-hidden">
            {hidden.join(', ')} hold a direction control or an invisible character: they can make a line read differently from what it does. The Studio saves only those the file already had.
          </p>
        </Notice>
      )}
      <div className="editor" hidden={conflict !== null}>
        <label htmlFor="yaml-text" className="label">
          YAML of {name}
        </label>
        <textarea
          id="yaml-text"
          ref={area}
          className="yaml-input"
          value={draft.text}
          maxLength={YAML_MAX}
          readOnly={conflict !== null}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby="yaml-count yaml-state"
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
          <button
            type="button"
            className="button quiet"
            disabled={saving || dirty}
            title={dirty ? 'Save or discard your changes first' : undefined}
            onClick={() => {
              setDraft(key, undefined);
              onClose();
            }}
          >
            Close the editor
          </button>
          <span id="yaml-state" className="save-state" role="status" aria-live="polite" data-testid="yaml-state">
            {state}
          </span>
          <span className="spacer" />
          <span id="yaml-count" className={draft.text.length >= YAML_MAX ? 'counter at-limit' : 'counter'}>
            {draft.text.length.toLocaleString('en')} / {YAML_MAX.toLocaleString('en')} characters
          </span>
          <span className="muted small">
            <kbd>⌘S</kbd> / <kbd>Ctrl+S</kbd>
          </span>
        </div>
        {shownIssues !== null && (
          <div className="live-issues" aria-live="polite" data-testid="yaml-live">
            {liveIssues === null ? (
              <p className="muted small">Checking…</p>
            ) : liveIssues.length === 0 ? (
              <p className="muted small">No issue in this text.</p>
            ) : (
              <Issues issues={liveIssues} testid="yaml-live-issues" />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Why the Studio does not save this file, with each problem's line, and any unsaved text to copy. */
function Blocked({ why, problems, draft }: { why: string; problems: Array<{ line?: number; message: string }>; draft: Draft | undefined }) {
  return (
    <div data-testid="yaml-readonly">
      <Notice tone="warning" role="alert" title="The Studio does not save this file">
        <p className="pre-line">
          <Txt text={why} />
        </p>
        {problems.length > 0 && (
          <ul className="issues" data-testid="yaml-readonly-problems">
            {problems.map((p, i) => (
              <li key={i}>
                {p.line !== undefined && <span className="mono small">{`line ${p.line} `}</span>}
                <Txt text={p.message} />
              </li>
            ))}
          </ul>
        )}
      </Notice>
      {draft && isDirty(draft) && (
        <Notice tone="info" title="Your unsaved text">
          <p>Not saved anywhere: copy it before you leave.</p>
          <textarea className="kept" readOnly aria-label="Your unsaved text" value={draft.text} rows={6} />
        </Notice>
      )}
    </div>
  );
}

export function YamlTab({
  v,
  slug,
  name,
  focus,
  issues,
  reload,
  onSaved,
}: {
  v: View;
  slug: string;
  name: string;
  focus: { line: number; end_line: number } | null;
  issues: ValidationIssue[];
  reload: () => void;
  /** A save from this tab (its hash): the Blocks tab's undo history says it in its own words. */
  onSaved?: (hash: string) => void;
}) {
  const key = scenarioKey(slug, name);
  const [editing, setEditing] = useState(() => getDraft(key) !== undefined);
  const ability = v.edit.yaml;
  if (!ability.ok) {
    return (
      <>
        <Blocked why={ability.why} problems={ability.problems ?? []} draft={getDraft(key)} />
        <YamlView v={v} focus={focus} issues={issues} />
      </>
    );
  }
  if (editing) return <Editor v={v} slug={slug} name={name} focus={focus} reload={reload} onClose={() => setEditing(false)} {...(onSaved ? { onSaved } : {})} />;
  return (
    <YamlView
      v={v}
      focus={focus}
      issues={issues}
      readOnly={false}
      actions={
        <button type="button" className="button small" onClick={() => setEditing(true)} data-testid="yaml-edit">
          Edit
        </button>
      }
    />
  );
}
