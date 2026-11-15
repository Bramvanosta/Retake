/**
 * The project's settings (`#/p/<slug>/settings`) — how the project is filmed, as project.yaml says it, read only (the
 * file is changed in an editor or by Claude; the page shows `project_get`'s view: the config with its defaults, without
 * `auth`'s login steps and with a password written in a URL masked). Panels: the video (capture, frame, theme, language,
 * clock), the locations (each a link to its page), the sandboxes, who signs in where, the reset hooks and the named
 * hooks every scenario may call (hook lines: settings-words.ts — never a header, body or environment), the test
 * mailbox, the browser, the pacing and step defaults, what a hook may reach (hosts, databases, variables: their names
 * only) and the raw export's defaults; project.yaml's warnings first. Every value from data is text (Txt).
 */
import type { ReactNode } from 'react';
import type { ProjectView } from '@retake/engine';
import { Txt, plural, shown } from '../bits.js';
import { useProjectView } from '../project-data.js';
import { hrefTo } from '../route.js';
import { envFlagWords } from '../words/board-words.js';
import { captureWords, hookLine, namedHookLines } from '../words/settings-words.js';
import type { HookLine } from '../words/settings-words.js';
import { Callout, Facts, StatusMark } from '../ui-kit/index.js';

function Panel({ id, title, children, wide }: { id: string; title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'cf-panel is-wide' : 'cf-panel'} aria-labelledby={id} data-testid={`settings-${id}`}>
      <h2 id={id} className="sc-h2">
        {shown(title)}
      </h2>
      {shown(children)}
    </section>
  );
}

/** A hook as a row: its kind, name, what it does, its rollback and flags. */
export function HookRow({ h, index }: { h: HookLine; index?: number }) {
  return (
    <li className="cf-hook">
      <div className="cf-hook-head">
        {index !== undefined && <span className="cf-hook-n">{shown(String(index))}</span>}
        {h.name && <Txt className="cf-row-name" text={h.name} />}
        <span className="cf-tag">{shown(h.kind)}</span>
        {h.flags.map((f) => (
          <span key={f} className="cf-tag">
            {shown(f)}
          </span>
        ))}
      </div>
      <Txt className="cf-code k-mono" text={h.summary} />
      {h.rollback && <Txt className="cf-code k-mono sc-quiet" text={`Rollback: ${h.rollback}`} />}
    </li>
  );
}

function SettingsBody({ p }: { p: ProjectView }) {
  return (
    <div className="sc-screen cf" data-testid="settings-screen">
      <header className="cf-head">
        <div className="cf-title">
          <h1 className="sc-h1">Settings</h1>
          {p.warnings.length === 0 ? (
            <StatusMark state="ok" word={<Txt text={`${p.file} is valid · no warning`} />} />
          ) : (
            <StatusMark state="warn" word={<Txt text={`${p.file}: ${plural(p.warnings.length, 'warning')}`} />} />
          )}
        </div>
        <p className="sc-quiet">
          {'How this project is filmed, as '}
          <Txt className="k-mono" text={p.file} />
          {' says it: read here, changed in the file (an editor, or ask Claude).'}
        </p>
      </header>
      {p.warnings.length > 0 && (
        <Callout state="warn" title="Warnings of project.yaml">
          <ul>
            {p.warnings.map((w) => (
              <li key={`${w.path}:${w.message}`}>
                <Txt text={`${w.path ? `${w.path}: ` : ''}${w.message}`} />
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <div className="cf-grid">
        <PlacePanels p={p} />
        <HookPanels p={p} />
      </div>
    </div>
  );
}

export function SettingsScreen({ slug }: { slug: string }) {
  const view = useProjectView(slug);
  if (view.state === 'loading')
    return (
      <div className="sc-screen">
        <p className="sc-quiet" role="status">
          Loading the settings…
        </p>
      </div>
    );
  if (view.state === 'error')
    return (
      <div className="sc-screen">
        <h1 className="sc-h1">Settings</h1>
        <Callout state="fail" role="alert" title="This project cannot be read">
          <Txt text={view.error} />
        </Callout>
      </div>
    );
  return <SettingsBody p={view.data} />;
}

/** The video, the locations and sandboxes, who signs in where. */
function PlacePanels({ p }: { p: ProjectView }) {
  const c = p.config;
  const sandboxes = Object.entries(c.sandboxes ?? {});
  const signIns = p.environments.filter((e) => e.personas.length > 0);
  return (
    <>
      <Panel id="video" title="Video">
        <Facts
          rows={[
            { key: 'capture', label: 'Capture', value: <Txt text={captureWords(c.capture)} /> },
            { key: 'frame', label: 'Frame', value: <Txt text={typeof c.frame === 'string' ? c.frame : 'custom frame'} /> },
            {
              key: 'theme',
              label: 'Theme',
              value: (
                <a href={hrefTo({ name: 'themes', slug: p.slug, theme: c.template })}>
                  <Txt text={c.template} />
                </a>
              ),
            },
            { key: 'locale', label: 'Language', value: <Txt text={c.locale ?? 'en (default)'} /> },
            ...(c.clock ? [{ key: 'clock', label: 'Clock', value: <Txt text={typeof c.clock === 'string' ? c.clock : JSON.stringify(c.clock)} /> }] : []),
          ]}
        />
      </Panel>
      <Panel id="locations" title="Locations">
        <ul className="cf-rows" aria-label="Locations">
          {p.environments.map((e) => {
            const flags = envFlagWords(e, e.name === p.default_env, e.name);
            return (
              <li key={e.name} className="cf-row">
                <a className="cf-row-name" href={hrefTo({ name: 'location', slug: p.slug, env: e.name })}>
                  <Txt text={e.name} />
                </a>
                <span className="sc-quiet">
                  <Txt text={[...(flags ? [flags] : []), plural(Object.keys(e.pages).length, 'page'), plural(e.personas.length, 'persona')].join(' · ')} />
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
      {sandboxes.length > 0 && (
        <Panel id="sandboxes" title="Sandboxes">
          <ul className="cf-rows" aria-label="Sandboxes">
            {sandboxes.map(([env, file]) => (
              <li key={env} className="cf-row">
                <a className="cf-row-name" href={hrefTo({ name: 'location', slug: p.slug, env })}>
                  <Txt text={env} />
                </a>
                <Txt className="k-mono sc-quiet" text={file} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel id="sign-in" title="Who signs in where">
        {signIns.length === 0 ? (
          <p className="sc-quiet">No persona: every page opens signed out.</p>
        ) : (
          <ul className="cf-rows" aria-label="Personas by location">
            {signIns.map((e) => (
              <li key={e.name} className="cf-row">
                <Txt className="cf-row-name" text={e.name} />
                <span className="sc-quiet">
                  <Txt
                    text={e.personas
                      .map((x) => `${x.name} (${x.sandbox ? 'sandbox account' : x.login_steps ? 'login steps' : 'signs in by hand'}${x.pages.length ? ` · ${x.pages.join(', ')}` : ''})`)
                      .join(' · ')}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="sc-quiet">Passwords and login steps stay in project.yaml and the keychain: never shown here.</p>
      </Panel>
    </>
  );
}

/** The hooks every scenario may run, the mailbox, the browser and pacing, what a hook may reach, the raw export. */
function HookPanels({ p }: { p: ProjectView }) {
  const c = p.config;
  const reset = (c.reset ?? []).map(hookLine);
  const named = namedHookLines(c.hooks);
  const hosts = c.allow_hosts ?? [];
  const dbs = Object.keys(c.databases ?? {});
  const vars = Object.keys(c.vars ?? {});
  const passEnv = c.pass_env ?? [];
  return (
    <>
      <Panel id="reset" title="Reset hooks">
        {reset.length === 0 ? (
          <p className="sc-quiet">None: a reset (env_reset) only rolls back what the hooks left.</p>
        ) : (
          <ol className="cf-hooks" aria-label="Reset hooks">
            {reset.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: project.yaml's reset hooks in their order, read whole each time: the place is part of the identity
              <HookRow key={`${i}-${h.summary}`} h={h} index={i + 1} />
            ))}
          </ol>
        )}
        <p className="sc-quiet">Run by a reset of a location. A scenario adds its own hooks: see its Hooks view.</p>
      </Panel>
      <Panel id="named-hooks" title="Named hooks of every scenario">
        {named.length === 0 ? (
          <p className="sc-quiet">None: a scenario's hook steps call its own named hooks.</p>
        ) : (
          <ul className="cf-hooks" aria-label="Named hooks">
            {named.flatMap((n) =>
              // biome-ignore lint/suspicious/noArrayIndexKey: a named hook's entries in their order (a name may run a list): the place is part of the identity
              n.lines.map((h, i) => <HookRow key={`${n.name}-${i}`} h={{ ...h, name: n.lines.length > 1 ? `${n.name} · ${i + 1}` : n.name }} />),
            )}
          </ul>
        )}
      </Panel>
      {c.mailbox && (
        <Panel id="mailbox" title="Test mailbox">
          <Facts
            rows={[
              { key: 'provider', label: 'Provider', value: <Txt text={c.mailbox.provider} /> },
              { key: 'url', label: 'Address', value: <Txt className="k-mono" text={c.mailbox.url} /> },
            ]}
          />
          <p className="sc-quiet">Read by the steps that wait for an email.</p>
        </Panel>
      )}
      <Panel id="browser" title="Browser and pacing">
        <Facts
          rows={[
            { key: 'channel', label: 'Browser', value: <Txt text={c.browser?.channel ?? 'chromium (default)'} /> },
            ...(c.browser?.locale ? [{ key: 'blocale', label: 'Its language', value: <Txt text={c.browser.locale} /> }] : []),
            ...(c.browser?.timezone ? [{ key: 'tz', label: 'Time zone', value: <Txt text={c.browser.timezone} /> }] : []),
            ...(c.browser?.color_scheme ? [{ key: 'scheme', label: 'Colour scheme', value: <Txt text={c.browser.color_scheme} /> }] : []),
            { key: 'timeout', label: 'Step timeout', value: <Txt text={c.defaults?.timeout_s !== undefined ? `${c.defaults.timeout_s} s` : '15 s (default)'} /> },
            {
              key: 'pacing',
              label: 'Pacing',
              value: <Txt text={c.pacing && Object.keys(c.pacing).length > 0 ? `${plural(Object.keys(c.pacing).length, 'value')} set: ${Object.keys(c.pacing).join(', ')}` : 'the defaults'} />,
            },
          ]}
        />
      </Panel>
      <Panel id="reach" title="What a hook may reach">
        <Facts
          rows={[
            { key: 'hosts', label: 'Extra hosts', value: <Txt text={hosts.length ? hosts.join(', ') : 'none (the locations, localhost)'} /> },
            { key: 'dbs', label: 'Databases', value: <Txt text={dbs.length ? dbs.join(', ') : 'none'} /> },
            { key: 'vars', label: 'Variables', value: <Txt text={vars.length ? vars.join(', ') : 'none'} /> },
            { key: 'env', label: 'Passed on', value: <Txt text={passEnv.length ? passEnv.join(', ') : 'none'} /> },
          ]}
        />
      </Panel>
      {c.raw && (
        <Panel id="raw" title="Raw export">
          <Facts rows={Object.entries(c.raw).map(([k, v]) => ({ key: k, label: <Txt text={k} />, value: <Txt text={String(v)} /> }))} />
        </Panel>
      )}
    </>
  );
}
