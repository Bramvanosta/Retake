/**
 * The themes of a project's workspace (L4.7 part D2, R-UI-07 / R-DEC-04; L5.12c « Épure » 4c, R4-Theme, R-UI-49 —
 * `#/p/<slug>/themes[/<theme>]`): the list — each theme's colours, where it comes from (Workspace / Starter / Project
 * folder), whether the Studio edits it (by its real path, critique B15: a starter, a theme shipped in the package or the
 * project's own folder theme is read-only, with why) and what uses it; "Copy to edit…" on a read-only listed theme (a
 * kit Sheet asks for the copy's name: theme_copy); New theme (L3.5's brand form: theme_create, never replacing one; a
 * changed form is unsaved for the desktop app's quit question: `new_theme`); and the site panel — the site extractions
 * of the workspace (host, page title: untrusted text, shown as text; hex roles; logo candidates by name, B11 / C5), the
 * `retake theme from-site` command to copy for a URL (no Studio op queues a site job: the extraction needs a person's
 * approval of the URL in a terminal or in Claude Code), and "New theme from this". With a theme: its editor
 * (ThemeEditor.tsx).
 * In the shell: the browser is the Library's (LibraryBrowser.tsx: each theme opens its editor); the status bar says how
 * many themes and which one the project uses.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SiteListAnswer, ThemeListAnswer } from '../server/theme-ops.js';
import { call, errorText, useCall } from './api.js';
import type { Loaded } from './api.js';
import { Txt, When, plural } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { useEvents } from './events.js';
import { LibraryBrowser } from './LibraryBrowser.js';
import { copyName, themeNameProblem } from './library-words.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { ShellSlot } from './shell/slots.js';
import { ThemeEditor } from './ThemeEditor.js';
import { EMPTY_FORM, SOURCE_BADGE, createInput, formFromSite, freeThemeName, newThemeProblem, offersCopy, okHex, opensInEditor, pickerValue, themeEventAction, usedByWords } from './theme-words.js';
import type { NewThemeForm } from './theme-words.js';
import { Button, Callout, ColorField, EmptyState, LinkButton, Select, Sheet, StatusMark, Tag, TextField } from './ui-kit/index.js';

type ListTheme = ThemeListAnswer['themes'][number];

/** A colour swatch: only a hex value reaches the style (anything else draws nothing). Theme data, not the Studio's chrome. */
function Swatch({ hex, label }: { hex?: string | null; label: string }) {
  if (!okHex(hex)) return null;
  return <span className="tm-swatch" style={{ background: hex }} title={`${label} ${hex}`} aria-label={`${label} ${hex}`} role="img" />;
}

export function ThemesScreen({ slug, theme }: { slug: string; theme?: string }) {
  const [list, reload] = useCall<ThemeListAnswer>('theme_list', { project: slug }, slug);
  const timer = useRef<number | null>(null);
  useEvents((e) => {
    if (!themeEventAction(e, slug) || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      reload();
    }, 250);
  });
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);
  // Back on the list from an editor: read it again (a copy, a write).
  const first = useRef(true);
  useEffect(() => {
    if (!first.current && theme === undefined) reload();
    first.current = false;
  }, [theme, reload]);
  return <div data-testid="themes">{theme ? <ThemeEditor key={theme} slug={slug} theme={theme} list={list} /> : <ThemeList slug={slug} list={list} reload={reload} />}</div>;
}

function ThemeList({ slug, list, reload }: { slug: string; list: Loaded<ThemeListAnswer>; reload: () => void }) {
  const [form, setForm] = useState<NewThemeForm | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const d = list.state === 'ready' ? list.data : null;
  const taken = useMemo(() => d?.themes.map((t) => t.name) ?? [], [d]);
  return (
    <div className="tm-screen">
      {d && <LibraryBrowser slug={slug} at="themes" themes={d.themes.map((t) => ({ name: t.name, source: t.source, default: t.default === true, opens: opensInEditor(t) }))} />}
      {d && (
        <ShellSlot name="actions">
          <span className="sh-scenario" data-testid="themes-state">
            <Txt text={plural(d.themes.length, 'theme')} />
            {d.project_theme && <Txt className="sh-seg" text={` · the project uses ${d.project_theme}`} />}
          </span>
        </ShellSlot>
      )}
      <header className="tm-head">
        <h1 className="tm-h1">Themes</h1>
        <span className="tm-head-end">
          <Button size="sm" variant="primary" icon="plus" disabled={!d} onClick={() => setForm({ ...EMPTY_FORM, name: freeThemeName('my-theme', taken) })} data-testid="theme-new-open">
            New theme…
          </Button>
        </span>
      </header>
      {list.state === 'loading' && (
        <p className="tm-quiet" role="status">
          Loading the themes…
        </p>
      )}
      {list.state === 'error' && (
        <Callout state="fail" role="alert" title="The themes cannot be shown">
          <p className="tm-pre">
            <Txt text={list.error} />
          </p>
        </Callout>
      )}
      {d && (
        <>
          <p className="tm-quiet">
            <Txt text={`${plural(d.themes.length, 'theme')}. A workspace theme opens in the editor; a starter is copied first. The project's theme is the one project.yaml names`} />
            {d.project_theme && (
              <>
                {' ('}
                <Txt className="k-mono" text={d.project_theme} />
                {')'}
              </>
            )}
            {'; a scenario can use another (Use in a scenario, in the editor).'}
          </p>
          {form && <NewTheme key={`${form.name}|${form.logo}`} slug={slug} initial={form} taken={taken} themes={d.themes.filter((t) => t.source !== 'project').map((t) => t.name)} onClose={() => setForm(null)} onMade={reload} />}
          <ul className="tm-list" data-testid="theme-list">
            {d.themes.map((t) => (
              <ThemeRow key={`${t.source}:${t.name}`} slug={slug} t={t} onCopy={() => setCopying(t.name)} />
            ))}
          </ul>
          <SitePanel taken={taken} onNewTheme={(f) => setForm(f)} />
          <RowCopy key={copying ?? ''} slug={slug} from={copying} taken={taken} onCancel={() => setCopying(null)} />
        </>
      )}
    </div>
  );
}

function ThemeRow({ slug, t, onCopy }: { slug: string; t: ListTheme; onCopy: () => void }) {
  return (
    <li className="tm-row" data-testid="theme-row" data-theme={t.name} data-editable={t.editable === true ? 'yes' : 'no'}>
      <div className="tm-row-main">
        <span className="tm-swatches" aria-hidden={!t.colors.accent}>
          <Swatch hex={t.colors.paper} label="paper" />
          <Swatch hex={t.colors.text} label="text" />
          <Swatch hex={t.colors.accent} label="accent" />
        </span>
        <span className="tm-row-name">
          {opensInEditor(t) ? (
            <a href={hrefTo({ name: 'themes', slug, theme: t.name })} className="tm-link" data-testid="theme-open">
              <Txt className="k-mono" text={t.name} />
            </a>
          ) : (
            <Txt className="k-mono" text={t.name} />
          )}
        </span>
        <span className="tm-tags">
          <Tag testId="theme-tag">
            <Txt text={SOURCE_BADGE[t.source]} />
          </Tag>
          {t.default && <Tag testId="theme-tag">The project's theme</Tag>}
          <Tag testId="theme-tag">
            <Txt text={t.editable === true ? 'Editable' : 'Read-only'} />
          </Tag>
          {t.issues.length > 0 && <StatusMark state="fail" word="Broken: it does not load" />}
        </span>
        <Txt className="tm-quiet" text={usedByWords(t.used_by, slug)} />
        <span className="tm-row-actions">
          {opensInEditor(t) && (
            <LinkButton size="sm" variant="ghost" to={{ name: 'themes', slug, theme: t.name }} label={`${t.editable === true ? 'Edit' : 'Open'} ${t.name}`}>
              {t.editable === true ? 'Edit' : 'Open'}
            </LinkButton>
          )}
          {offersCopy(t) && (
            <Button size="sm" onClick={onCopy} data-testid="theme-row-copy">
              Copy to edit…
            </Button>
          )}
        </span>
      </div>
      {t.editable !== true && (
        <p className="tm-quiet" data-testid="theme-row-why">
          <Txt text={t.editable.why} />
        </p>
      )}
      {t.issues.slice(0, 2).map((x, i) => (
        <p key={i} className="tm-failure">
          <Txt text={x} />
        </p>
      ))}
    </li>
  );
}

/** "Copy to edit…" of a listed read-only theme: a kit Sheet asks for the copy's name; theme_copy, then its editor. */
function RowCopy({ slug, from, taken, onCancel }: { slug: string; from: string | null; taken: string[]; onCancel: () => void }) {
  // Keyed by the theme to copy (the list's): a new one starts with its free copy name.
  const [name, setName] = useState(() => (from === null ? '' : copyName(from, taken)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = from === null ? null : themeNameProblem(name, taken);
  const go = async () => {
    if (from === null || problem) return setError(problem);
    setBusy(true);
    try {
      const c = await call<{ name: string }>('theme_copy', { from, name });
      location.hash = hrefTo({ name: 'themes', slug, theme: c.name });
    } catch (e) {
      if (!(e instanceof SessionEnded)) setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={from !== null}
      testId="theme-row-copy-sheet"
      title={`Copy ${from ?? ''} to edit it`}
      actions={[
        { id: 'copy', label: busy ? 'Copying…' : 'Copy and edit', variant: 'primary', isDefault: true, disabled: busy || problem !== null, testId: 'theme-row-copy-yes' },
        { id: 'cancel', label: 'Cancel', isCancel: true },
      ]}
      onAction={(id) => (id === 'copy' ? void go() : onCancel())}
      content={
        <>
          <TextField label="Name of the copy" value={name} onChange={(v) => setName(v.trim())} unsaved={null} mono maxLength={100} autoComplete="off" spellCheck={false} testId="theme-row-copy-name" error={problem ?? undefined} />
          {error && (
            <p className="tm-failure" role="status">
              <Txt text={error} />
            </p>
          )}
        </>
      }
    >
      A copy is a theme of this workspace: the Studio edits it; the starter stays as it is.
    </Sheet>
  );
}

interface BrandFiles {
  files: Array<{ ref: string; bytes: number }>;
  truncated: boolean;
}

interface Created {
  name: string;
  base: string;
  palette: { adjusted: Array<{ key: string; from: string; to: string; check: string }>; suggestions: { accent?: string } };
  warnings: string[];
}

/**
 * One colour of the form: the kit's ColorField — a move or each keystroke sets the form's value (the form owns the text:
 * a value that is not a hex stays as typed and the form's line says why, review B-M2); nothing is written.
 */
function FormColor({ label, value, set, optional, testId }: { label: string; value: string; set: (v: string) => void; optional?: boolean; testId: string }) {
  return <ColorField label={label} hint={optional ? 'optional: derived when empty' : undefined} value={value} picker={pickerValue(value)} unset={!okHex(value)} removable={optional ?? false} onDraft={set} onCommit={set} onRemove={() => set('')} onText={set} testId={testId} layout="stack" />;
}

/**
 * New theme (theme_create = L3.5's create under trust `mcp`, exactly as Claude's template_create_from_brand; never
 * replacing a theme): name, base, colours, logo / wordmark among the workspace's image files or a site's candidates,
 * fonts among its font files, brand name and URL. Its palette adjustments and warnings are shown after.
 */
function NewTheme({ slug, initial, taken, themes, onClose, onMade }: { slug: string; initial: NewThemeForm; taken: string[]; themes: string[]; onClose: () => void; onMade: () => void }) {
  const [f, setF] = useState<NewThemeForm>(initial);
  const [images, setImages] = useState<BrandFiles | null>(null);
  const [fontFiles, setFontFiles] = useState<BrandFiles | null>(null);
  const [state, setState] = useState<{ busy?: boolean; error?: string; made?: Created }>({});
  const headId = useId();
  // L5.2b (review B L7): a form changed and not made yet is unsaved text the desktop app's quit question names.
  useUnsavedMark(!state.made && JSON.stringify(f) !== JSON.stringify(initial) ? { kind: 'new_theme', project: slug } : null);
  const set = (k: keyof NewThemeForm) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    let live = true;
    call<BrandFiles>('brand_files', { kind: 'image' }).then((d) => live && setImages(d), () => live && setImages({ files: [], truncated: false }));
    call<BrandFiles>('brand_files', { kind: 'font' }).then((d) => live && setFontFiles(d), () => live && setFontFiles({ files: [], truncated: false }));
    return () => {
      live = false;
    };
  }, []);
  const logos = useMemo(() => {
    const refs = (images?.files ?? []).map((x) => x.ref);
    return initial.logo && !refs.includes(initial.logo) ? [initial.logo, ...refs] : refs;
  }, [images, initial.logo]);
  const fonts = (fontFiles?.files ?? []).map((x) => ({ value: x.ref, label: x.ref }));
  const problem = newThemeProblem(f, taken);
  const create = async () => {
    if (problem) return setState({ error: problem });
    setState({ busy: true });
    try {
      const made = await call<Created>('theme_create', createInput(f));
      setState({ made });
      onMade();
    } catch (e) {
      if (!(e instanceof SessionEnded)) setState({ error: errorText(e) });
    }
  };
  return (
    <section className="tm-panel" aria-labelledby={headId} data-testid="theme-new">
      <h2 id={headId} className="tm-h2">
        New theme
      </h2>
      {state.made ? (
        <div className="tm-panel-body" role="status" data-testid="theme-new-made">
          <p className="tm-line">
            {'Theme '}
            <Txt className="k-mono" text={state.made.name} />
            {' made over '}
            <Txt text={state.made.base} />
            {'. '}
            <LinkButton size="sm" variant="primary" to={{ name: 'themes', slug, theme: state.made.name }} testId="theme-new-edit">
              Open it in the editor
            </LinkButton>
          </p>
          {state.made.palette.adjusted.map((a, i) => (
            <p key={i} className="tm-line">
              <Txt text={`Adjusted ${a.key}: ${a.from} → ${a.to} (for ${a.check.replace(/_/g, ' ')}).`} />
            </p>
          ))}
          {state.made.palette.suggestions.accent && (
            <p className="tm-line">
              <Txt text={`A stronger accent would pass on the paper: ${state.made.palette.suggestions.accent} (not applied).`} />
            </p>
          )}
          {state.made.warnings.map((w, i) => (
            <p key={i} className="tm-quiet">
              <Txt text={w} />
            </p>
          ))}
          <span>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </span>
        </div>
      ) : (
        <div className="tm-panel-body">
          <p className="tm-quiet">Made as Claude makes one (template_create_from_brand): files of this workspace, never an existing theme replaced.</p>
          <div className="tm-new-grid">
            <TextField label="Name" value={f.name} onChange={(v) => set('name')(v.trim())} unsaved={null} mono maxLength={100} autoComplete="off" spellCheck={false} testId="new-name" />
            <Select label="Base (components, layout, motion)" value={f.base} onChange={set('base')} testId="new-base" options={themes.map((t) => ({ value: t, label: t }))} />
            <FormColor label="Accent" value={f.accent} set={set('accent')} testId="new-accent" />
            <FormColor label="Text" value={f.text} set={set('text')} optional testId="new-text" />
            <FormColor label="Paper" value={f.paper} set={set('paper')} optional testId="new-paper" />
            <FormColor label="Muted" value={f.muted} set={set('muted')} optional testId="new-muted" />
            <Select label="Logo" value={f.logo} onChange={set('logo')} testId="new-logo" options={[{ value: '', label: images ? (logos.length ? 'Pick an image file' : 'No image file in the workspace') : 'Loading…' }, ...logos.map((r) => ({ value: r, label: r }))]} />
            <Select label="Wordmark (optional)" value={f.wordmark} onChange={set('wordmark')} options={[{ value: '', label: 'None (the brand name as text)' }, ...logos.map((r) => ({ value: r, label: r }))]} />
            <Select label="Display font (optional)" value={f.display} onChange={set('display')} options={[{ value: '', label: "The base theme's" }, ...fonts]} />
            <Select label="Body font (optional)" value={f.body} onChange={set('body')} options={[{ value: '', label: "The base theme's" }, ...fonts]} />
            <TextField label="Brand name (optional)" value={f.brandName} onChange={set('brandName')} unsaved={null} maxLength={80} testId="new-brand-name" />
            <TextField label="Brand URL (optional)" value={f.brandUrl} onChange={set('brandUrl')} unsaved={null} maxLength={120} autoComplete="off" spellCheck={false} />
          </div>
          <div className="tm-actions">
            <Button variant="primary" busy={state.busy} disabled={!!problem} onClick={() => void create()} data-testid="new-create">
              {state.busy ? 'Making…' : 'Make the theme'}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <span className="tm-line" role="status" data-testid="new-problem">
              {state.error ? <Txt text={state.error} /> : problem ? <Txt text={problem} /> : ''}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * From a website: the extractions already made (newest first; every page string untrusted, shown as text), the
 * command a person runs for a new URL (copied, never run from here), and New theme from an extraction.
 */
function SitePanel({ taken, onNewTheme }: { taken: string[]; onNewTheme: (f: NewThemeForm) => void }) {
  const [sites, reload] = useCall<SiteListAnswer>('site_list', {}, 'sites');
  const [url, setUrl] = useState('');
  const [cmd, setCmd] = useState<SiteListAnswer | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const [error, setError] = useState<string | null>(null);
  const line = useRef<HTMLElement>(null);
  const headId = useId();
  const listId = useId();
  useEvents((e) => {
    if (e.type === 'resync' || (e.type === 'workspace' && e.site === true)) reload();
  });
  const ask = async () => {
    setCopied('no');
    setError(null);
    try {
      setCmd(await call<SiteListAnswer>('site_list', { url }));
    } catch (e) {
      if (!(e instanceof SessionEnded)) setError(errorText(e));
    }
  };
  const copy = () => {
    const text = cmd?.command?.line;
    if (!text) return;
    const fail = () => {
      setCopied('failed');
      const el = line.current;
      if (el) window.getSelection()?.selectAllChildren(el);
    };
    try {
      navigator.clipboard.writeText(text).then(() => setCopied('yes'), fail);
    } catch {
      fail();
    }
  };
  return (
    <section className="tm-panel" aria-labelledby={headId} data-testid="site-panel">
      <h2 id={headId} className="tm-h2">
        From a website
      </h2>
      <div className="tm-panel-body">
        <p className="tm-quiet">Colours and logo candidates are extracted from a public page by a command you run (or by Claude, which asks you to approve the URL): the Studio never fetches a site itself.</p>
        <div className="tm-url-line">
          <div className="tm-url">
            <TextField label="Page URL" type="url" value={url} onChange={setUrl} unsaved={null} maxLength={2048} placeholder="https://www.example.com" autoComplete="off" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && url && void ask()} testId="site-url" />
          </div>
          <Button disabled={!url} onClick={() => void ask()} data-testid="site-command">
            Show the command
          </Button>
        </div>
        {error && (
          <p className="tm-failure" role="status">
            <Txt text={error} />
          </p>
        )}
        {cmd?.url_problem && (
          <p className="tm-failure" role="status" data-testid="site-url-problem">
            <Txt text={cmd.url_problem} />
          </p>
        )}
        {cmd?.command && (
          <div className="tm-command" data-testid="site-command-box">
            <p className="tm-line">
              {'In a terminal (it extracts '}
              <Txt className="k-mono" text={cmd.command.untrusted.host} />
              {' after you approve it there):'}
            </p>
            <code ref={line} className="k-mono tm-code" data-testid="site-command-line">
              <Txt text={cmd.command.line} />
            </code>
            <div className="tm-actions">
              <Button size="sm" icon="copy" onClick={copy} data-testid="site-command-copy">
                Copy the command
              </Button>
              <span className="tm-line" role="status">
                {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was refused: the command is selected — copy it with ⌘C.' : ''}
              </span>
            </div>
            <p className="tm-quiet">
              <Txt text={cmd.command.claude} />
            </p>
          </div>
        )}
        <h3 id={listId} className="tm-h3">
          Extractions
        </h3>
        {sites.state === 'loading' && (
          <p className="tm-quiet" role="status">
            Loading the extractions…
          </p>
        )}
        {sites.state === 'error' && (
          <p className="tm-failure">
            <Txt text={sites.error} />
          </p>
        )}
        {sites.state === 'ready' && sites.data.sites.length === 0 && <EmptyState level={3} title="None yet" />}
        {sites.state === 'ready' && sites.data.sites.length > 0 && (
          <ul className="tm-list" aria-labelledby={listId}>
            {sites.data.sites.map((s) => (
              <li key={s.site_id} className="tm-row" data-testid="site-row" data-site={s.site_id}>
                <div className="tm-row-main">
                  <span className="tm-swatches">
                    <Swatch hex={s.palette?.roles.paper} label="paper" />
                    <Swatch hex={s.palette?.roles.text} label="text" />
                    <Swatch hex={s.palette?.roles.accent} label="accent" />
                  </span>
                  <span className="tm-row-name">
                    {s.untrusted.host ? <Txt className="k-mono" text={s.untrusted.host} /> : '(no host)'} <When iso={s.at} />
                  </span>
                  <StatusMark state={s.status === 'ok' ? 'ok' : 'warn'} word={s.status === 'ok' ? 'Done' : `Warning: ${s.status}`} />
                  {s.status === 'ok' && (
                    <span className="tm-row-actions">
                      <Button size="sm" onClick={() => onNewTheme(formFromSite(s, freeThemeName('site-theme', taken)))} data-testid="site-new-theme">
                        New theme from this…
                      </Button>
                    </span>
                  )}
                </div>
                {s.untrusted.title && (
                  <p className="tm-quiet" data-testid="site-title">
                    {'Page title (as the page wrote it): '}
                    <Txt text={s.untrusted.title} />
                  </p>
                )}
                {s.palette && (
                  <p className="tm-line">
                    <Txt
                      text={`Paper ${s.palette.roles.paper} · text ${s.palette.roles.text}${s.palette.roles.accent ? ` · accent ${s.palette.roles.accent}` : ''}${s.palette.roles.dark ? ` · dark ${s.palette.roles.dark}` : ''}${s.palette.checks.length > 0 ? ` — ${s.palette.checks.filter((c) => c.ok).length}/${s.palette.checks.length} contrast checks pass` : ''}`}
                    />
                  </p>
                )}
                {s.candidates.length > 0 && (
                  <p className="tm-quiet">
                    {'Logo candidates: '}
                    {s.candidates.map((c, i) => (
                      <span key={c.ref}>
                        {i > 0 ? ', ' : ''}
                        <Txt className="k-mono" text={c.ref} />
                        <Txt text={` (${c.width}×${c.height})`} />
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
