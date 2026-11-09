/**
 * L5.12c « Épure » 4c: the Library's inspector (R4-Library; was LibraryScreen.tsx's detail cards) — the selected card's
 * (or the open component's) facts and actions:
 * - its picture, kind, slots, length, kit compatibility, the themes that pick it; Play in the theme (the same play state
 *   as its card: a toggle with one name), Create with Claude… (a new one like it), Open the details; About (the
 *   manifest's description: untrusted, text);
 * - Theme default: "Set as default of <theme>…" — theme_view of the theme shown, then a kit Sheet that says what the
 *   write does (Return = Set as default) → one `set_component` through theme_edit with `if_match` the view's sha256; Undo
 *   restores the exact bytes shown (theme_edit `restore`, if_match the write's sha256). A starter or a read-only theme:
 *   a Sheet asks for the copy's name ("Copy as <name> and set"), theme_copy, then the copy is written and the Library
 *   moves to it (the state here survives the move: the inspector has one place in the screen's tree, keyed by the
 *   component, from the grid as from the component's page — review B-H1).
 * L5.12c fixes: Enter on the selected card brings the focus here (`data-lib-focus`, review A-M3); Play in the theme has
 * the card's rule — off when the loop cannot play, unless it plays (it can always be stopped: review A-L6 / B-L4).
 * Nothing selected: the theme's summary.
 */
import { useId, useState } from 'react';
import type { ThemeEditResult, ThemeEditView } from '@retake/engine';
import type { LibraryComponentAnswer, LibraryItem, LibraryViewAnswer } from '../server/library-ops.js';
import { CallError, errorText } from './api.js';
import type { Loaded } from './api.js';
import { themeCopy, themeEdit, themeView } from './data/themes.js';
import type { ThemeEditInput } from './data/themes.js';
import { APP_NAME } from './brand.js';
import { Txt, plural } from './bits.js';
import { DefaultTag, PictureBox, SourceTag, useLibrary } from './LibraryCards.js';
import { canPlay, copyName, isKind, kindHeading, kindsOf, okTheme, setDefaultPlan, setDefaultWords, themeNameProblem } from './library-words.js';
import type { SetDefaultPlan } from './library-words.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { Button, Callout, Facts, InspectorSection, LinkButton, Select, Sheet, StatusMark, TextField } from './ui-kit/index.js';

type SetState =
  | { s: 'idle' }
  | { s: 'busy'; what: string }
  | { s: 'plan'; view: ThemeEditView; plan: SetDefaultPlan; kind: string }
  | { s: 'done'; theme: string; before: ThemeEditView; result: ThemeEditResult; copied?: string }
  | { s: 'undone'; theme: string }
  | { s: 'error'; message: string };

/** "Set as theme default" with its two sheets (confirm; copy a read-only theme first). */
function SetDefault({ item, view }: { item: LibraryItem; view: LibraryViewAnswer }) {
  const lib = useLibrary();
  const kinds = kindsOf(item).filter(isKind);
  const [kind, setKind] = useState<string>(kinds[0] ?? item.kind);
  const [st, setSt] = useState<SetState>({ s: 'idle' });
  const [copyAs, setCopyAs] = useState(() => copyName(view.theme.name, view.themes.map((t) => t.name)));
  const theme = view.theme.name;
  const taken = view.themes.map((t) => t.name);
  const fail = (e: unknown) => {
    if (e instanceof SessionEnded) return;
    setSt({ s: 'error', message: e instanceof CallError && e.error.code === 'conflict' ? 'The theme changed meanwhile: nothing was written. Try again.' : errorText(e) });
  };
  const start = async () => {
    setSt({ s: 'busy', what: 'Reading the theme…' });
    try {
      const tv = await themeView({ theme });
      setSt({ s: 'plan', view: tv, plan: setDefaultPlan(tv, kind, item.component), kind });
    } catch (e) {
      fail(e);
    }
  };
  const write = async (target: string, tv: ThemeEditView, copied?: string) => {
    const plan = setDefaultPlan(tv, kind, item.component);
    if (!('edit' in plan)) {
      setSt({ s: 'plan', view: tv, plan, kind });
      return;
    }
    setSt({ s: 'busy', what: 'Writing the theme…' });
    const result = await themeEdit({ theme: target, if_match: tv.sha256, edit: plan.edit as ThemeEditInput });
    setSt({ s: 'done', theme: target, before: tv, result, ...(copied ? { copied } : {}) });
    if (copied) location.hash = hrefTo({ name: 'library', slug: lib.slug, theme: copied, component: item.component });
    else lib.reload();
  };
  const copyThenWrite = async () => {
    const problem = themeNameProblem(copyAs, taken);
    if (problem) return setSt({ s: 'error', message: problem });
    setSt({ s: 'busy', what: `Copying ${theme} to ${copyAs}…` });
    try {
      const c = await themeCopy({ from: theme, name: copyAs });
      const tv = await themeView({ theme: c.name });
      await write(c.name, tv, c.name);
    } catch (e) {
      fail(e);
    }
  };
  const undo = async (d: Extract<SetState, { s: 'done' }>) => {
    if (d.before.yaml === null) return;
    setSt({ s: 'busy', what: 'Undoing…' });
    try {
      await themeEdit({ theme: d.theme, if_match: d.result.sha256, edit: { kind: 'restore', text: d.before.yaml, text_hash: d.before.sha256 } });
      setSt({ s: 'undone', theme: d.theme });
      lib.reload();
    } catch (e) {
      fail(e);
    }
  };
  const confirming = st.s === 'plan' && 'edit' in st.plan ? st : null;
  const copying = st.s === 'plan' && 'copy' in st.plan ? st.plan : null;
  const copyProblem = copying ? themeNameProblem(copyAs, taken) : null;
  return (
    <InspectorSection title="Theme default" testId="lib-set-default">
      <p className="lb-line">
        {item.theme_default.length > 0 ? (
          <>
            <Txt text={theme} />
            <Txt text={` uses it by default as its ${item.theme_default.join(', ')}.`} />
          </>
        ) : (
          <>
            <Txt text={theme} />
            {' does not use it by default.'}
          </>
        )}
      </p>
      {kinds.length > 1 && <Select label="As the theme's" layout="row" value={kind} onChange={setKind} testId="lib-set-kind" options={kinds.map((k) => ({ value: k, label: kindHeading(k, 1).toLowerCase() }))} />}
      {(st.s === 'idle' || st.s === 'undone' || st.s === 'error' || (st.s === 'plan' && !('edit' in st.plan) && !('copy' in st.plan))) && (
        <div className="lb-actions">
          <Button size="sm" onClick={() => void start()} data-testid="lib-set-start">
            <Txt text={`Set as default of ${theme}…`} />
          </Button>
        </div>
      )}
      <div role="status" className="lb-line" data-testid="lib-set-state">
        {st.s === 'busy' && <Txt text={st.what} />}
        {st.s === 'undone' && (
          <>
            {'Undone: '}
            <Txt text={st.theme} />
            {' is back to the version before.'}
          </>
        )}
        {st.s === 'error' && (
          <span className="lb-failure">
            <Txt text={st.message} />
          </span>
        )}
        {st.s === 'done' && (
          <>
            <Txt text={st.result.label} />
            {st.result.removed.length > 0 && <Txt text={` — removed ${st.result.removed.join(', ')} (they contradicted it)`} />}
            {'.'}
            {st.copied && (
              <>
                {' The copy '}
                <Txt text={st.copied} />
                {' is a new theme: the project still uses its own until '}
                <code className="k-mono">template:</code>
                {' names the copy (in project.yaml, or per scenario).'}
              </>
            )}
          </>
        )}
      </div>
      {st.s === 'done' && (
        <div className="lb-actions">
          {st.before.yaml !== null ? (
            <Button size="sm" onClick={() => void undo(st)} data-testid="lib-set-undo">
              Undo
            </Button>
          ) : (
            <span className="lb-quiet">No undo: the theme's file was not shown whole.</span>
          )}
          {st.copied && okTheme(st.copied) && (
            // The next step (review B L5 of L4.7): the copy is used once a scenario or the project names it.
            <LinkButton size="sm" variant="primary" to={{ name: 'themes', slug: lib.slug, theme: st.copied }} testId="lib-set-next">
              Open the copy: use it in a scenario
            </LinkButton>
          )}
          {st.result.warnings.map((w, i) => (
            <span key={i} className="lb-quiet">
              <Txt text={w} />
            </span>
          ))}
        </div>
      )}
      {st.s === 'plan' && 'already' in st.plan && (
        <p className="lb-line" data-testid="lib-set-already">
          <Txt text={`It is already the ${st.kind} of `} />
          <Txt text={theme} />
          {'.'}
        </p>
      )}
      {st.s === 'plan' && 'why' in st.plan && (
        <p className="lb-line lb-failure" data-testid="lib-set-why">
          <Txt text={st.plan.why} />
        </p>
      )}
      <Sheet
        open={confirming !== null}
        testId="lib-set-confirm"
        title={`Set the default of ${theme}?`}
        actions={[
          { id: 'set', label: 'Set as default', variant: 'primary', isDefault: true, testId: 'lib-set-confirm-yes' },
          { id: 'cancel', label: 'Cancel', isCancel: true },
        ]}
        onAction={(id) => {
          if (!confirming) return;
          if (id === 'set') void write(theme, confirming.view).catch(fail);
          else setSt({ s: 'idle' });
        }}
      >
        {confirming && 'edit' in confirming.plan ? <Txt text={setDefaultWords(theme, confirming.kind, item.component, confirming.plan)} /> : null}
      </Sheet>
      <Sheet
        open={copying !== null}
        testId="lib-set-copy"
        title={`Copy ${theme} first?`}
        actions={[
          { id: 'copy', label: `Copy as ${copyAs || '…'} and set`, variant: 'primary', isDefault: true, disabled: copyProblem !== null, testId: 'lib-set-copy-yes' },
          { id: 'cancel', label: 'Cancel', isCancel: true },
        ]}
        onAction={(id) => {
          if (id === 'copy') void copyThenWrite();
          else setSt({ s: 'idle' });
        }}
        content={<TextField label="Name of the copy" value={copyAs} onChange={(v) => setCopyAs(v.trim())} unsaved={null} mono maxLength={100} autoComplete="off" spellCheck={false} testId="lib-set-copy-name" error={copyProblem ?? undefined} />}
      >
        {copying ? (
          <>
            <Txt text={theme} />
            {' cannot be changed here ('}
            <Txt text={copying.copy} />
            {'). Copy it to a theme of this workspace, then set the default there.'}
          </>
        ) : null}
      </Sheet>
    </InspectorSection>
  );
}

/** The selected card's (or the open component's) inspector. */
export function ComponentInspector({ item, view, d, playing, onCreate, detail }: { item: LibraryItem; view: LibraryViewAnswer; d: Loaded<LibraryComponentAnswer>; playing: boolean; onCreate: (kind: string, like: string) => void; detail: boolean }) {
  const lib = useLibrary();
  const nameId = useId();
  const data = d.state === 'ready' ? d.data : null;
  const length = data?.duration ? `${data.duration.default} s` : null;
  return (
    <div className="lb-insp" tabIndex={-1} data-lib-focus="" role="group" aria-labelledby={nameId}>
      <InspectorSection title={<span id={nameId}><Txt text={item.untrusted.name} /></span>} testId="lib-inspector">
        {!detail && (
          <div className="lb-insp-picture">
            <PictureBox item={item} playing={playing} />
          </div>
        )}
        <p className="lb-insp-id">
          <Txt className="k-mono" text={item.component} />
          <SourceTag source={item.source} />
          <DefaultTag item={item} />
        </p>
        <Facts
          rows={[
            { key: 'kind', label: 'Kind', value: <Txt text={`${kindHeading(item.kind, 1)}${item.kinds?.length ? ` · also ${item.kinds.join(', ')}` : ''}`} /> },
            { key: 'slots', label: 'Slots', value: item.slots.length ? <Txt text={item.slots.join(' · ')} /> : 'none' },
            { key: 'length', label: 'Length', value: length ? <Txt className="k-mono" text={length} /> : d.state === 'loading' ? 'reading…' : '—' },
            {
              key: 'kit',
              label: 'Kit',
              value: data ? <StatusMark state={data.kit.compatible ? 'ok' : 'fail'} word={data.kit.compatible ? `Ready · kit API ${data.kit.needs}` : `Broken: needs kit API ${data.kit.needs}, ${APP_NAME} provides ${data.kit.provided}`} /> : d.state === 'error' ? 'cannot be read' : 'reading…',
            },
            { key: 'used', label: 'Picked by', value: item.picked_by.length ? <Txt text={item.picked_by.join(', ')} /> : 'no theme of this project' },
          ]}
        />
        <div className="lb-actions">
          <Button size="sm" icon={playing ? 'pause' : 'play'} aria-pressed={playing} disabled={!canPlay(item.loop) && !playing} data-testid="lib-inspector-play" onClick={() => {
            lib.setPlaying(item.component, !playing);
            if (!playing) lib.pump.wantLoops([item.component]);
          }}>
            Play in the theme
          </Button>
          {!detail && (
            <LinkButton size="sm" variant="ghost" to={{ name: 'library', slug: lib.slug, theme: view.theme.name, component: item.component }} testId="lib-open" label={`Open the details of ${item.component}`}>
              Open the details
            </LinkButton>
          )}
          <Button size="sm" variant="ghost" onClick={() => onCreate(item.kind, item.component)} data-testid="lib-detail-create">
            Create with Claude…
          </Button>
        </div>
        <p className="lb-quiet">
          <Txt text={`A new one like it: a prompt for Claude Code. ${APP_NAME} itself calls no model.`} />
        </p>
      </InspectorSection>
      <SetDefault key={item.component} item={item} view={view} />
      <InspectorSection title="About">
        <p className="lb-line">
          <Txt text={item.untrusted.description} />
        </p>
      </InspectorSection>
    </div>
  );
}

/** Nothing selected: the theme shown, what the cards do. */
export function LibraryInspector({ view, shown }: { view: LibraryViewAnswer; shown: number }) {
  return (
    <InspectorSection title="Library" testId="lib-inspector-none">
      <Facts
        rows={[
          { key: 'theme', label: 'Theme', value: <Txt text={`${view.theme.name}${view.theme.project_default ? " — the project's" : ''}`} /> },
          { key: 'n', label: 'Components', value: <Txt text={`${plural(view.items.length, 'component')}${shown !== view.items.length ? `, ${shown} shown` : ''}`} /> },
          { key: 'queued', label: 'Previews', value: view.queued > 0 ? <StatusMark state="running" word={`${plural(view.queued, 'preview')} queued`} /> : <StatusMark state="idle" word="None queued" /> },
        ]}
      />
      <p className="lb-quiet">Select a card: its facts and actions show here. Posters render while their cards are on screen; Play shows a component moving.</p>
      {view.notices.some((n) => n.severity === 'error') && <Callout state="warn" title="Some components do not load" role="note">The registry notices under the filters say why.</Callout>}
    </InspectorSection>
  );
}
