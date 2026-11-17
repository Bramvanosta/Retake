/**
 * A location (`#/p/<slug>/loc/<env>`) — one environment of the project on a page of its own, read only: its flags
 * in words and what they mean for a take, the pages the video shows (each URL and the one shown instead), a sandbox's
 * state (`sandbox_status`: its services with their health, its last seed and reset, the take lock, its files — nothing
 * here starts, seeds or resets it: the terminal's `retake sandbox` does), and the personas who sign in there (the
 * Cast's rows: Sessions.tsx, with Sign in). Every value from data is text (Txt).
 */
import type { EnvironmentView, ProjectView } from '@retake/engine';
import { useSandboxStatus } from '../data/projects.js';
import type { SandboxAnswer } from '../data/ops.js';
import { Txt, When, plural, shown } from '../bits.js';
import { reloadProject, useCast, useProjectView } from '../project-data.js';
import { envFlagWords } from '../words/board-words.js';
import { Blocker, Callout, EmptyState, Facts, LinkButton, StatusMark } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';
import { SessionRows } from './Sessions.js';

/** What a location's kind means for a take, in one sentence. */
export function locationLede(e: Pick<EnvironmentView, 'production' | 'access' | 'sandbox'>): string {
  if (e.sandbox) return 'A disposable copy of the product, started on ports of its own, seeded, and reset before every take.';
  if (e.production || e.access === 'read-only') return 'Filming here never writes: the browser’s writes are stopped, hooks that write are refused and a capture asks first.';
  return 'The product as it runs at these addresses: a take films it as it is, and its hooks may change its data.';
}

const SANDBOX_STATE: Record<string, [MarkState, string]> = { up: ['ok', 'Up'], partial: ['warn', 'Partly up'], down: ['idle', 'Down'] };
const SERVICE_STATE: Record<string, [MarkState, string]> = { running: ['ok', 'Running'], starting: ['running', 'Starting'], stopped: ['idle', 'Stopped'] };

/** A location's pages: the key, the URL a take opens, the one the video shows instead. */
export function PagesFacts({ e }: { e: EnvironmentView }) {
  if (e.ios) {
    return (
      <Facts
        label={`The app ${e.name} films`}
        rows={[
          { key: 'app', label: 'App', value: <Txt className="k-mono" text={e.ios.app} /> },
          { key: 'device', label: 'Simulator', value: <Txt text={e.ios.device} /> },
          { key: 'schemes', label: 'Deep links', value: <Txt text={e.ios.schemes.length ? e.ios.schemes.map((s) => `${s}://`).join(', ') : 'none'} /> },
        ]}
      />
    );
  }
  const pages = Object.entries(e.pages);
  if (pages.length === 0) return <p className="sc-quiet">No page.</p>;
  return (
    <Facts
      label={`Pages of ${e.name}`}
      rows={pages.map(([key, url]) => ({
        key,
        label: <Txt text={key} />,
        value: (
          <span className="cf-page">
            <Txt className="k-mono" text={url} />
            {e.display?.[key] && <Txt className="sc-quiet" text={`shown as ${e.display[key]}`} />}
          </span>
        ),
      }))}
    />
  );
}

function SandboxPanels({ slug, env }: { slug: string; env: string }) {
  const [s] = useSandboxStatus({ project: slug, env }, `${slug}/${env}`);
  if (s.state === 'loading')
    return (
      <p className="sc-quiet" role="status">
        Reading the sandbox…
      </p>
    );
  if (s.state === 'error')
    return (
      <Callout state="fail" role="alert" title="The sandbox cannot be read">
        <Txt text={s.error} />
      </Callout>
    );
  return (
    <>
      <ServicesPanel d={s.data} />
      <DataPanel d={s.data} />
      <FilesPanel d={s.data} slug={slug} env={env} />
    </>
  );
}

/** What `sandbox_status` answers (the location page's three panels read it). */
type SandboxView = SandboxAnswer;

function ServicesPanel({ d }: { d: SandboxView }) {
  const [state, word] = SANDBOX_STATE[d.state] ?? ['attention', d.state];
  return (
    <section className="cf-panel" aria-labelledby="loc-services">
      <div className="cf-panel-head">
        <h2 id="loc-services" className="sc-h2">
          Services
        </h2>
        <StatusMark state={state} word={`${word} · ${plural(d.services.length, 'service')}`} />
      </div>
      {d.services.length === 0 ? (
        <p className="sc-quiet">No service.</p>
      ) : (
        <ul className="cf-rows" aria-label="Services">
          {d.services.map((x) => {
            const [st, w] = SERVICE_STATE[x.state] ?? ['attention', x.state];
            const health = x.state !== 'running' ? '' : x.healthy ? ' · healthy' : x.healthy === false ? ' · not healthy' : '';
            return (
              <li key={x.name} className="cf-row" data-testid="sandbox-service">
                <Txt className="cf-row-name" text={x.name} />
                <StatusMark state={x.state === 'running' && x.healthy === false ? 'warn' : st} word={<Txt text={`${w}${health}`} />} />
                <span className="sc-quiet">
                  {x.pid !== undefined && <Txt text={`pid ${x.pid}`} />}
                  {x.container && <Txt text={x.container} />}
                  {x.started_at && (
                    <>
                      {' · started '}
                      <When iso={x.started_at} />
                    </>
                  )}
                  {x.changed && ' · changed in sandbox.yaml since it started'}
                  {x.orphan && ' · no longer in sandbox.yaml (the next up or down stops it)'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DataPanel({ d }: { d: SandboxView }) {
  return (
    <section className="cf-panel" aria-labelledby="loc-data">
      <h2 id="loc-data" className="sc-h2">
        Data
      </h2>
      <Facts
        rows={[
          {
            key: 'seed',
            label: 'Seed',
            value: d.seed ? (
              <span>
                <StatusMark state={d.seed.current ? 'ok' : 'warn'} word={d.seed.current ? 'Current' : 'Changed since'} />
                {' · seeded '}
                <When iso={d.seed.at} />
                <Txt text={` in ${(d.seed.ms / 1000).toFixed(1)} s`} />
              </span>
            ) : (
              'never seeded'
            ),
          },
          {
            key: 'reset',
            label: 'Last reset',
            value: d.last_reset ? (
              <span>
                <When iso={d.last_reset.at} />
                <Txt text={` · ${d.last_reset.strategy} · ${(d.last_reset.ms / 1000).toFixed(1)} s · by ${d.last_reset.by}`} />
              </span>
            ) : (
              'never reset'
            ),
          },
          { key: 'lock', label: 'Take lock', value: d.lock ? <Txt text={`in use by ${d.lock.command}`} /> : 'free' },
        ]}
      />
      {d.notes.length > 0 && (
        <ul className="cf-notes">
          {d.notes.map((n) => (
            <li key={n}>
              <Txt text={n} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilesPanel({ d, slug, env }: { d: SandboxView; slug: string; env: string }) {
  return (
    <section className="cf-panel" aria-labelledby="loc-files">
      <h2 id="loc-files" className="sc-h2">
        Files
      </h2>
      <Facts
        rows={[
          { key: 'provider', label: 'Provider', value: <Txt text={d.provider} /> },
          { key: 'file', label: 'Definition', value: <Txt className="k-mono" text={d.file} /> },
          { key: 'logs', label: 'Logs', value: <Txt className="k-mono" text={d.logs} /> },
        ]}
      />
      <Blocker state="idle" fix={{ copy: `retake sandbox status ${slug} ${env}` }}>
        Started, seeded and reset by a take, or from a terminal (retake sandbox up, reset, logs).
      </Blocker>
    </section>
  );
}

function LocationBody({ slug, p, e }: { slug: string; p: ProjectView; e: EnvironmentView }) {
  const cast = useCast(slug);
  const rows = cast.state === 'ready' ? cast.data.personas.filter((x) => x.env === e.name) : [];
  const flags = envFlagWords(e, e.name === p.default_env, e.name);
  return (
    <div className="sc-screen cf" data-testid="location-screen">
      <header className="cf-head">
        <div className="cf-title">
          <h1 className="sc-h1">
            <Txt text={e.name} />
          </h1>
          {flags && <span className="cf-flags">{shown(flags)}</span>}
        </div>
        <p className="sc-quiet">{shown(locationLede(e))}</p>
      </header>
      <div className="cf-grid">
        <section className="cf-panel" aria-labelledby="loc-pages" data-testid="location-pages">
          <h2 id="loc-pages" className="sc-h2">
            Pages the video shows
          </h2>
          <PagesFacts e={e} />
        </section>
        {e.sandbox && <SandboxPanels slug={slug} env={e.name} />}
        <section className="cf-panel is-wide" aria-labelledby="loc-personas">
          <div className="cf-panel-head">
            <h2 id="loc-personas" className="sc-h2">
              Personas
            </h2>
            <LinkButton to={{ name: 'cast', slug }} variant="ghost" size="sm">
              Locations and cast
            </LinkButton>
          </div>
          {e.personas.length === 0 ? (
            <p className="sc-quiet">No persona signs in on this location: its pages open signed out.</p>
          ) : cast.state === 'loading' ? (
            <p className="sc-quiet">Loading the sessions…</p>
          ) : (
            <SessionRows slug={slug} rows={rows} onChanged={() => reloadProject('auth_status', slug)} caption={`Sessions on ${e.name}`} showEnv={false} />
          )}
        </section>
      </div>
    </div>
  );
}

export function LocationScreen({ slug, env }: { slug: string; env: string }) {
  const view = useProjectView(slug);
  if (view.state === 'loading')
    return (
      <div className="sc-screen">
        <p className="sc-quiet" role="status">
          Loading the location…
        </p>
      </div>
    );
  if (view.state === 'error')
    return (
      <div className="sc-screen">
        <Callout state="fail" role="alert" title="This project cannot be read">
          <Txt text={view.error} />
        </Callout>
      </div>
    );
  const e = view.data.environments.find((x) => x.name === env);
  if (!e)
    return (
      <div className="sc-screen">
        <EmptyState title="No such location" level={1}>
          <Txt text={`No location named ${env} in this project.`} />
        </EmptyState>
      </div>
    );
  return <LocationBody slug={slug} p={view.data} e={e} />;
}
