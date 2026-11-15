/**
 * The scenario's YAML view (R-UI-11; R4-Source on the kit, its File in the inspector): the file read-only
 * (YamlView) until the person presses Edit, then the kit's text area (no highlighting: no dependency, no HTML from data;
 * its unsaved mark is the draft's, drafts.ts — never twice) saved through `scenario_edit` `replace_text` — the
 * Studio's one write path: the hash the text was based on as if_match, validated by the server (errors refuse the save
 * and come back with their lines, the draft kept; warnings save), worded "from the Studio".
 *
 * - Draft: kept per scenario while the person moves around the app (drafts.ts `scenario:<slug>/<name>`), with the
 *   file's own line breaks (CR LF stays CR LF) and a final line break added on save (as scenario_save); closing the
 *   tab asks first; the session-ended page keeps it to copy. While it holds unsaved text the Blocks tab says block
 *   editing is off (a block edit would make the draft's base stale).
 * - Live issues: `scenario_validate` 400 ms after typing stops, one call in flight at a time.
 * - Changed on disk: the screen re-reads its view when the file changes (events, focus); a new version with no
 *   unsaved text is loaded and announced, with unsaved text a banner offers to load it. A view showing a version this
 *   tab already replaced (a re-read that started before its save ended) is ignored. A save answered 409 opens the
 *   conflict panel (TextEditing.tsx) with the version on disk.
 * - Read-only with why when the Studio may not save the file (the view's `edit.yaml`): not UTF-8, too
 *   large, a carriage return without a line feed (the textarea would show a line break YAML does not read), a link out
 *   of scenarios/, or holding a secret reference / an outside file — each problem with its line; any unsaved text stays
 *   to copy. The draft turns only CR LF into LF (drafts.ts `crlfToLf`).
 * - Hidden characters: lines of the draft that hold a direction control or an invisible character are listed (the
 *   server refuses one it did not have, or one moved to another line).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ValidationIssue } from '@retake/core/base';
import { CallError, errorText } from '../api.js';
import { scenarioBlocks, scenarioEdit, scenarioValidate } from '../data/scenarios.js';
import { plural } from '../bits.js';
import { crlfToLf, detectEol, getDraft, isDirty, scenarioKey, setDraft, toEol } from '../drafts.js';
import type { Draft } from '../drafts.js';
import type { View } from '../words/scenario-words.js';
import { SessionEnded } from '../session.js';
import { DiskBanner, KeptText, TextConflict } from './TextEditing.js';
import { YamlView } from './YamlView.js';
import { Button, Callout } from '../ui-kit/index.js';
import { Blocked, EditPane, EditorHead, EditorWarnings, Head, YAML_MAX, hiddenLines } from './yaml-panes.js';
import type { SaveError } from './yaml-panes.js';

export { FileInspector, YAML_MAX, hiddenLines } from './yaml-panes.js';

type Disk = Draft['base'];
const diskOf = (v: Pick<View, 'text' | 'hash'>): Disk => ({ text: crlfToLf(v.text), hash: v.hash, eol: detectEol(v.text) });
/** What a save writes: the text with a final line break and the file's own line breaks. */
const fileText = (text: string, eol: Disk['eol']) => toEol(text.endsWith('\n') || text === '' ? text : `${text}\n`, eol);

type Conflict = { mine: string; disk: Disk };

/** The editor's state: the draft (kept in drafts.ts), what is on disk, and what the screen says about a save. */
function useYamlState(v: View, key: string) {
  const [draft, setLocal] = useState<Draft>(() => getDraft(key) ?? { text: diskOf(v).text, base: diskOf(v) });
  const [disk, setDisk] = useState<Disk | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<SaveError | null>(null);
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
  return {
    draft,
    disk,
    setDisk,
    dismissed,
    setDismissed,
    conflict,
    setConflict,
    kept,
    setKept,
    notice,
    setNotice,
    error,
    setError,
    saving,
    setSaving,
    saved,
    setSaved,
    live,
    setLive,
    draftRef,
    savingRef,
    superseded,
    area,
    update,
  };
}

type YamlState = ReturnType<typeof useYamlState>;

/** The view changed (an event, a focus, this tab's own save): a new version on disk? */
function useDiskFollow(v: View, s: YamlState): void {
  const { savingRef, superseded, draftRef, update, setDisk, setSaved, setNotice } = s;
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
  }, [v, update, savingRef, superseded, draftRef, setDisk, setSaved, setNotice]);
}

/** "Show in YAML" while editing: the caret to that line. */
function useCaretAt(area: RefObject<HTMLTextAreaElement | null>, focus: { line: number } | null): void {
  useEffect(() => {
    const el = area.current;
    if (!focus || !el) return;
    const lines = el.value.split('\n');
    const at = lines.slice(0, Math.max(0, focus.line - 1)).reduce((n, l) => n + l.length + 1, 0);
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    el.scrollTop = Math.max(0, (focus.line - 4) * (parseFloat(getComputedStyle(el).lineHeight) || 19));
  }, [focus, area]);
}

/** Live issues: 400 ms after the last keystroke, one call in flight (the newest text read after it ends). */
function useLiveCheck(slug: string, name: string, draft: Draft, setLive: YamlState['setLive']): void {
  const inflight = useRef(false);
  const pending = useRef<string | null>(null);
  const check = useCallback(
    (text: string) => {
      if (inflight.current) {
        pending.current = text;
        return;
      }
      inflight.current = true;
      scenarioValidate({ project: slug, name, yaml: text })
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
    [slug, name, setLive],
  );
  useEffect(() => {
    if (!isDirty(draft) || draft.text.length > YAML_MAX) return;
    const t = setTimeout(() => check(draft.text), 400);
    return () => clearTimeout(t);
  }, [draft, check]);
}

/** A save answered 409: the version on disk beside the person's text, or why it could not be read. */
async function showConflict(slug: string, name: string, mine: string, setConflict: (c: Conflict) => void, setError: (e: SaveError) => void): Promise<void> {
  try {
    const now = await scenarioBlocks({ project: slug, name });
    setConflict({ mine, disk: diskOf(now) });
  } catch (e2) {
    if (!(e2 instanceof SessionEnded)) setError({ message: errorText(e2), issues: [] });
  }
}

/** Why a save failed, in words, with the issues the server sent back. */
function saveError(e: unknown): SaveError {
  const issues = e instanceof CallError && Array.isArray(e.error.details?.issues) ? (e.error.details.issues as ValidationIssue[]) : [];
  return { message: issues.length ? `${plural(issues.filter((i) => i.severity === 'error').length, 'error')} in this text: nothing was written, your text is kept.` : errorText(e), issues };
}

/** The save through `scenario_edit` `replace_text`: over the version the text was based on, or over `over`. */
function useYamlSave(slug: string, name: string, s: YamlState, reload: () => void, onSaved: ((hash: string) => void) | undefined) {
  const { savingRef, draftRef, superseded, update, setError, setSaving, setDisk, setConflict, setNotice, setSaved } = s;
  return useCallback(
    async (over?: Disk) => {
      if (savingRef.current) return;
      const cur = draftRef.current;
      const text = fileText(cur.text, cur.base.eol);
      if (text.length > YAML_MAX) {
        setError({
          message: `A scenario saved from the Studio holds at most ${YAML_MAX.toLocaleString('en')} characters, its final line break included: this text makes ${text.length.toLocaleString('en')}. Shorten it.`,
          issues: [],
        });
        return;
      }
      const base = over ?? cur.base;
      if (base.hash === null) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        const r = await scenarioEdit({ project: slug, name, hash: base.hash, edit: { kind: 'replace_text', text } });
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
        if (e instanceof CallError && e.error.code === 'conflict') await showConflict(slug, name, cur.text, setConflict, setError);
        else setError(saveError(e));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [slug, name, update, reload, onSaved, savingRef, draftRef, superseded, setError, setSaving, setDisk, setConflict, setNotice, setSaved],
  );
}

/** Cmd/Ctrl+S saves. */
function useSaveKey(save: () => Promise<void>): void {
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
}

/** The save state in words. */
function stateWords(file: string, saving: boolean, conflict: boolean, dirty: boolean, saved: { hash: string; warnings: number } | null): string {
  return saving
    ? 'Saving…'
    : conflict
      ? `Not saved: ${file} changed on disk`
      : dirty
        ? 'Unsaved changes'
        : saved
          ? `Saved · ${saved.hash.slice(0, 12)}${saved.warnings ? ` · ${plural(saved.warnings, 'warning')}` : ''}`
          : 'No changes';
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
  const s = useYamlState(v, key);
  const { draft, disk, setDisk, dismissed, setDismissed, conflict, setConflict, kept, setKept, notice, setNotice, error, setError, saving, saved, setSaved, live, draftRef, area, update } = s;
  useDiskFollow(v, s);
  useCaretAt(area, focus);
  useLiveCheck(slug, name, draft, s.setLive);
  const save = useYamlSave(slug, name, s, reload, onSaved);

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

  useSaveKey(save);

  const dirty = isDirty(draft);
  const state = stateWords(v.file, saving, conflict !== null, dirty, saved);
  const showDisk = disk !== null && !conflict && disk.hash !== dismissed;
  const hidden = hiddenLines(draft.text);
  const liveIssues = dirty && live && live.text === draft.text ? live.issues : null;
  const shownIssues = liveIssues ?? (dirty ? [] : null);

  return (
    <section className="yv-editor" aria-label={`Editing ${v.file}`} data-testid="yaml-editor">
      <EditorHead
        file={v.file}
        saving={saving}
        dirty={dirty}
        conflict={conflict !== null}
        onSave={() => void save()}
        onDiscard={() => update({ text: draft.base.text, base: draft.base })}
        onClose={() => {
          setDraft(key, undefined);
          onClose();
        }}
      />
      {notice && (
        <Callout state="idle" title={notice}>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        </Callout>
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
      <EditorWarnings error={error} hidden={hidden} />
      <EditPane
        name={name}
        draft={draft}
        area={area}
        conflict={conflict !== null}
        state={state}
        liveIssues={liveIssues}
        shownIssues={shownIssues}
        onChange={(text) => {
          setError(null);
          setNotice(null);
          update({ text, base: draftRef.current.base });
        }}
      />
    </section>
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
  /** A save from this view (its hash): the board's undo history says it in its own words. */
  onSaved?: (hash: string) => void;
}) {
  const key = scenarioKey(slug, name);
  const [editing, setEditing] = useState(() => getDraft(key) !== undefined);
  const ability = v.edit.yaml;
  if (!ability.ok) {
    return (
      <div className="sb-stack">
        <Head file={v.file}>{null}</Head>
        <Blocked why={ability.why} problems={ability.problems ?? []} draft={getDraft(key)} />
        <YamlView v={v} focus={focus} issues={issues} />
      </div>
    );
  }
  if (editing) return <Editor v={v} slug={slug} name={name} focus={focus} reload={reload} onClose={() => setEditing(false)} {...(onSaved ? { onSaved } : {})} />;
  return (
    <div className="sb-stack">
      <Head file={v.file}>
        <Button size="sm" onClick={() => setEditing(true)} data-testid="yaml-edit">
          Edit
        </Button>
      </Head>
      <YamlView v={v} focus={focus} issues={issues} />
    </div>
  );
}
