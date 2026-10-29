/**
 * The themes of a project's workspace (L4.7 part D2, R-UI-07 / R-DEC-04; `#/p/<slug>/themes[/<theme>]`): the list —
 * each theme's colours, where it comes from (Workspace / Starter / Project folder), whether the Studio edits it (by its
 * real path, critique B15: a starter, a theme shipped in the package or the project's own folder theme is read-only,
 * with why) and what uses it; "Copy to edit" on a read-only listed theme (theme_copy); New theme (L3.5's brand form:
 * theme_create, never replacing one); and the site panel — the site extractions of the workspace (host, page title:
 * untrusted text, shown as text; hex roles; logo candidates by name, B11 / C5), the `studio theme from-site` command to
 * copy for a URL (no Studio op queues a site job: the extraction needs a person's approval of the URL in a terminal or
 * in Claude Code), and "New theme from this". With a theme: its editor (ThemeEditor.tsx).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SiteListAnswer, ThemeListAnswer } from '../server/theme-ops.js';
import { call, errorText, useCall } from './api.js';
import { Badge, Loading, Notice, Txt, When, plural, visibleControls } from './bits.js';
import { useUnsavedMark } from './drafts.js';
import { useEvents } from './events.js';
import { copyName, themeNameProblem } from './library-words.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';
import { ThemeEditor } from './ThemeEditor.js';
import { EMPTY_FORM, SOURCE_BADGE, createInput, formFromSite, freeThemeName, newThemeProblem, offersCopy, okHex, opensInEditor, pickerHex, themeEventAction, usedByWords } from './theme-words.js';
import type { NewThemeForm } from './theme-words.js';

function Breadcrumb({ slug, theme }: { slug: string; theme?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <a href={hrefTo({ name: 'project', slug })}>
        <Txt text={slug} />
      </a>
      <span aria-hidden="true"> / </span>
      {theme ? (
        <>
          <a href={hrefTo({ name: 'themes', slug })}>Themes</a>
          <span aria-hidden="true"> / </span>
          <Txt aria-current="page" text={theme} />
        </>
      ) : (
        <span aria-current="page">Themes</span>
      )}
    </nav>
  );
}

/** A colour swatch: only a hex value reaches the style (anything else draws nothing). */
function Swatch({ hex, label }: { hex?: string; label: string }) {
  if (!okHex(hex)) return null;
  return <span className="th-swatch" style={{ background: hex }} title={`${label} ${hex}`} aria-label={`${label} ${hex}`} role="img" />;
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
  return (
    <div className="screen themes-screen" data-testid="themes">
      <Breadcrumb slug={slug} {...(theme ? { theme } : {})} />
      {theme ? <ThemeEditor key={theme} slug={slug} theme={theme} list={list} /> : <ThemeList slug={slug} list={list} reload={reload} />}
    </div>
  );
}

function ThemeList({ slug, list, reload }: { slug: string; list: ReturnType<typeof useCall<ThemeListAnswer>>[0]; reload: () => void }) {
  const [form, setForm] = useState<NewThemeForm | null>(null);
  if (list.state === 'loading') return <Loading what="the themes" />;
  if (list.state === 'error') {
    return (
      <Notice tone="danger" role="alert" title="The themes cannot be shown">
        <p className="pre-line">
          <Txt text={list.error} />
        </p>
      </Notice>
    );
  }
  const d = list.data;
  const taken = d.themes.map((t) => t.name);
  return (
    <>
      <header className="screen-head lib-head">
        <h1>Themes</h1>
        <p className="muted">
          {plural(d.themes.length, 'theme')}. A workspace theme opens in the editor; a starter is copied first. The project's theme is the one project.yaml names
          {d.project_theme ? (
            <>
              {' '}
              (<Txt className="mono" text={d.project_theme} />)
            </>
          ) : null}
          ; a scenario can use another (Use in a scenario, in the editor).
        </p>
      </header>
      <div className="lib-bar">
        <span />
        <div className="actions">
          <a className="button" href={hrefTo({ name: 'library', slug })}>
            Components
          </a>
          <button type="button" className="button primary" onClick={() => setForm({ ...EMPTY_FORM, name: freeThemeName('my-theme', taken) })} data-testid="theme-new-open">
            New theme…
          </button>
        </div>
      </div>
      {form && <NewTheme key={`${form.name}|${form.logo}`} slug={slug} initial={form} taken={taken} themes={d.themes.filter((t) => t.source !== 'project').map((t) => t.name)} onClose={() => setForm(null)} onMade={reload} />}
      <ul className="th-list" data-testid="theme-list">
        {d.themes.map((t) => (
          <ThemeRow key={`${t.source}:${t.name}`} slug={slug} t={t} taken={taken} />
        ))}
      </ul>
      <SitePanel taken={taken} onNewTheme={(f) => setForm(f)} />
    </>
  );
}

function ThemeRow({ slug, t, taken }: { slug: string; t: ThemeListAnswer['themes'][number]; taken: string[] }) {
  const [copying, setCopying] = useState(false);
  return (
    <li className="th-row card" data-testid="theme-row" data-theme={t.name} data-editable={t.editable === true ? 'yes' : 'no'}>
      <div className="th-row-main">
        <span className="th-swatches" aria-hidden={!t.colors.accent}>
          <Swatch hex={t.colors.paper} label="paper" />
          <Swatch hex={t.colors.text} label="text" />
          <Swatch hex={t.colors.accent} label="accent" />
        </span>
        <span className="th-row-name">
          {opensInEditor(t) ? (
            <a href={hrefTo({ name: 'themes', slug, theme: t.name })} data-testid="theme-open">
              <Txt className="mono" text={t.name} />
            </a>
          ) : (
            <Txt className="mono" text={t.name} />
          )}
        </span>
        <span className="lib-badges">
          <Badge>{SOURCE_BADGE[t.source]}</Badge>
          {t.default && <Badge tone="info">The project's theme</Badge>}
          <Badge tone={t.editable === true ? 'success' : 'warning'}>{t.editable === true ? 'Editable' : 'Read-only'}</Badge>
          {t.issues.length > 0 && <Badge tone="danger">does not load</Badge>}
        </span>
        <span className="small muted">{usedByWords(t.used_by, slug)}</span>
        <span className="actions">
          {opensInEditor(t) && (
            <a className="button small" href={hrefTo({ name: 'themes', slug, theme: t.name })}>
              {t.editable === true ? 'Edit' : 'Open'}
            </a>
          )}
          {offersCopy(t) && !copying && (
            <button type="button" className="button small" onClick={() => setCopying(true)} data-testid="theme-row-copy">
              Copy to edit…
            </button>
          )}
        </span>
      </div>
      {t.editable !== true && (
        <p className="small muted" data-testid="theme-row-why">
          <Txt text={t.editable.why} />
        </p>
      )}
      {t.issues.slice(0, 2).map((x, i) => (
        <p key={i} className="small lib-failure">
          <Txt text={x} />
        </p>
      ))}
      {copying && <RowCopy slug={slug} from={t.name} taken={taken} onCancel={() => setCopying(false)} />}
    </li>
  );
}

function RowCopy({ slug, from, taken, onCancel }: { slug: string; from: string; taken: string[]; onCancel: () => void }) {
  const [name, setName] = useState(() => copyName(from, taken));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = themeNameProblem(name, taken);
  const go = async () => {
    if (problem) return setError(problem);
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
    <div className="lib-confirm th-inline">
      <label className="field">
        <span className="label">Name of the copy</span>
        <input className="search-input mono" value={name} maxLength={100} onChange={(e) => setName(e.target.value.trim())} data-testid="theme-row-copy-name" />
      </label>
      <button type="button" className="button primary" disabled={busy || !!problem} onClick={() => void go()} data-testid="theme-row-copy-yes">
        {busy ? 'Copying…' : 'Copy and edit'}
      </button>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
      {(error || problem) && (
        <span className="small lib-failure" role="status">
          <Txt text={error ?? problem ?? ''} />
        </span>
      )}
    </div>
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

/** One colour of the form: a picker and its hex. */
function FormColor({ label, value, set, optional }: { label: string; value: string; set: (v: string) => void; optional?: boolean }) {
  const id = useId();
  return (
    <div className="th-color">
      <input type="color" id={id} value={pickerHex(value) ?? '#ffffff'} onChange={(e) => set(e.target.value)} aria-label={label} />
      <label htmlFor={id} className="th-color-label">
        <span className="label">{label}</span>
        {optional && <span className="small muted">optional</span>}
      </label>
      <input className="search-input mono th-hex" value={value} maxLength={7} placeholder={optional ? 'derived' : ''} onChange={(e) => set(e.target.value.trim())} aria-label={`${label}, hex`} data-testid={`new-${label.toLowerCase()}`} />
    </div>
  );
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
    <section className="card th-new" aria-labelledby="th-new-h" data-testid="theme-new">
      <h2 id="th-new-h" className="card-title">
        New theme
      </h2>
      {state.made ? (
        <div role="status" data-testid="theme-new-made">
          <p>
            Theme <Txt className="mono" text={state.made.name} /> made over <Txt text={state.made.base} />.{' '}
            <a href={hrefTo({ name: 'themes', slug, theme: state.made.name })} data-testid="theme-new-edit">
              Open it in the editor
            </a>
          </p>
          {state.made.palette.adjusted.map((a, i) => (
            <p key={i} className="small">
              Adjusted {a.key}: {a.from} → {a.to} (for {a.check.replace(/_/g, ' ')}).
            </p>
          ))}
          {state.made.palette.suggestions.accent && <p className="small">A stronger accent would pass on the paper: {state.made.palette.suggestions.accent} (not applied).</p>}
          {state.made.warnings.map((w, i) => (
            <p key={i} className="small muted">
              <Txt text={w} />
            </p>
          ))}
          <button type="button" className="button small" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <>
          <p className="small muted">Made as Claude makes one (template_create_from_brand): files of this workspace, never an existing theme replaced.</p>
          <div className="th-new-grid">
            <label className="field">
              <span className="label">Name</span>
              <input className="search-input mono" value={f.name} maxLength={100} onChange={(e) => set('name')(e.target.value.trim())} data-testid="new-name" />
            </label>
            <label className="field">
              <span className="label">Base (components, layout, motion)</span>
              <select value={f.base} onChange={(e) => set('base')(e.target.value)} data-testid="new-base">
                {themes.map((t) => (
                  <option key={t} value={t}>
                    {visibleControls(t)}
                  </option>
                ))}
              </select>
            </label>
            <FormColor label="Accent" value={f.accent} set={set('accent')} />
            <FormColor label="Text" value={f.text} set={set('text')} optional />
            <FormColor label="Paper" value={f.paper} set={set('paper')} optional />
            <FormColor label="Muted" value={f.muted} set={set('muted')} optional />
            <label className="field">
              <span className="label">Logo</span>
              <select value={f.logo} onChange={(e) => set('logo')(e.target.value)} data-testid="new-logo">
                <option value="">{images ? (logos.length ? 'Pick an image file' : 'No image file in the workspace') : 'Loading…'}</option>
                {logos.map((r) => (
                  <option key={r} value={r}>
                    {visibleControls(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Wordmark (optional)</span>
              <select value={f.wordmark} onChange={(e) => set('wordmark')(e.target.value)}>
                <option value="">None (the brand name as text)</option>
                {logos.map((r) => (
                  <option key={r} value={r}>
                    {visibleControls(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Display font (optional)</span>
              <select value={f.display} onChange={(e) => set('display')(e.target.value)}>
                <option value="">The base theme's</option>
                {(fontFiles?.files ?? []).map((x) => (
                  <option key={x.ref} value={x.ref}>
                    {visibleControls(x.ref)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Body font (optional)</span>
              <select value={f.body} onChange={(e) => set('body')(e.target.value)}>
                <option value="">The base theme's</option>
                {(fontFiles?.files ?? []).map((x) => (
                  <option key={x.ref} value={x.ref}>
                    {visibleControls(x.ref)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Brand name (optional)</span>
              <input className="search-input" value={f.brandName} maxLength={80} onChange={(e) => set('brandName')(e.target.value)} data-testid="new-brand-name" />
            </label>
            <label className="field">
              <span className="label">Brand URL (optional)</span>
              <input className="search-input" value={f.brandUrl} maxLength={120} onChange={(e) => set('brandUrl')(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="button primary" disabled={state.busy || !!problem} onClick={() => void create()} data-testid="new-create">
              {state.busy ? 'Making…' : 'Make the theme'}
            </button>
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <span className="small" role="status" data-testid="new-problem">
              {state.error ? <Txt text={state.error} /> : (problem ?? '')}
            </span>
          </div>
        </>
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
    <section className="card th-sites" aria-labelledby="th-sites-h" data-testid="site-panel">
      <h2 id="th-sites-h" className="card-title">
        From a website
      </h2>
      <p className="small muted">
        Colours and logo candidates are extracted from a public page by a command you run (or by Claude, which asks you to approve the URL): the Studio never fetches a site itself.
      </p>
      <div className="th-inline">
        <label className="field th-url">
          <span className="label">Page URL</span>
          <input className="search-input" type="url" value={url} maxLength={2048} placeholder="https://www.example.com" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && void ask()} data-testid="site-url" />
        </label>
        <button type="button" className="button" disabled={!url} onClick={() => void ask()} data-testid="site-command">
          Show the command
        </button>
      </div>
      {error && (
        <p className="small lib-failure" role="status">
          <Txt text={error} />
        </p>
      )}
      {cmd?.url_problem && (
        <p className="small lib-failure" role="status" data-testid="site-url-problem">
          <Txt text={cmd.url_problem} />
        </p>
      )}
      {cmd?.command && (
        <div className="th-command" data-testid="site-command-box">
          <p className="small">
            In a terminal (it extracts <Txt className="mono" text={cmd.command.untrusted.host} /> after you approve it there):
          </p>
          <code ref={line} className="copyable" data-testid="site-command-line">
            <Txt text={cmd.command.line} />
          </code>
          <div className="actions">
            <button type="button" className="button small" onClick={copy} data-testid="site-command-copy">
              Copy the command
            </button>
            <span className="small" role="status" aria-live="polite">
              {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was refused: the command is selected — copy it with ⌘C.' : ''}
            </span>
          </div>
          <p className="small muted">
            <Txt text={cmd.command.claude} />
          </p>
        </div>
      )}
      <h3 className="th-sub">Extractions</h3>
      {sites.state === 'loading' && <Loading what="the extractions" />}
      {sites.state === 'error' && (
        <p className="small lib-failure">
          <Txt text={sites.error} />
        </p>
      )}
      {sites.state === 'ready' && sites.data.sites.length === 0 && <p className="small muted">None yet.</p>}
      {sites.state === 'ready' && sites.data.sites.length > 0 && (
        <ul className="th-site-list">
          {sites.data.sites.map((s) => (
            <li key={s.site_id} className="th-site" data-testid="site-row" data-site={s.site_id}>
              <div className="th-row-main">
                <span className="th-swatches">
                  <Swatch hex={s.palette?.roles.paper} label="paper" />
                  <Swatch hex={s.palette?.roles.text} label="text" />
                  <Swatch hex={s.palette?.roles.accent ?? undefined} label="accent" />
                </span>
                <span>
                  {s.untrusted.host ? <Txt className="mono" text={s.untrusted.host} /> : <span className="muted">(no host)</span>} <When iso={s.at} />
                </span>
                <Badge tone={s.status === 'ok' ? 'success' : 'warning'}>{s.status}</Badge>
                {s.status === 'ok' && (
                  <button type="button" className="button small" onClick={() => onNewTheme(formFromSite(s, freeThemeName('site-theme', taken)))} data-testid="site-new-theme">
                    New theme from this…
                  </button>
                )}
              </div>
              {s.untrusted.title && (
                <p className="small muted" data-testid="site-title">
                  Page title (as the page wrote it): <Txt text={s.untrusted.title} />
                </p>
              )}
              {s.palette && (
                <p className="small">
                  Paper {s.palette.roles.paper} · text {s.palette.roles.text}
                  {s.palette.roles.accent ? ` · accent ${s.palette.roles.accent}` : ''}
                  {s.palette.roles.dark ? ` · dark ${s.palette.roles.dark}` : ''}
                  {s.palette.checks.length > 0 && ` — ${s.palette.checks.filter((c) => c.ok).length}/${s.palette.checks.length} contrast checks pass`}
                </p>
              )}
              {s.candidates.length > 0 && (
                <p className="small muted">
                  Logo candidates:{' '}
                  {s.candidates.map((c, i) => (
                    <span key={c.ref}>
                      {i > 0 ? ', ' : ''}
                      <Txt className="mono" text={c.ref} /> ({c.width}×{c.height})
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
