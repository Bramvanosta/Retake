/**
 * A project (`project_get`): its README (as plain text — no Markdown rendering), environments with their pages, display
 * URLs, flags and personas, scenarios, recent runs (`run_list`), its recent activity (the index) and project.yaml
 * warnings. URLs are text, never links. It re-reads when the project's files change (events.ts).
 */
import type { EnvironmentView, ProjectView, RunListItem } from '@demo-studio/engine';
import { useCall } from './api.js';
import { ActivityPanel } from './Activity.js';
import { useProjectEvents } from './events.js';
import { Badge, EnvFlags, Loading, Notice, plural, RunState, Txt, When } from './bits.js';
import { hrefTo } from './route.js';

const README_PREVIEW_LINES = 40;

function Breadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <a href={hrefTo({ name: 'projects' })}>Projects</a>
      <span aria-hidden="true"> / </span>
      <Txt aria-current="page" text={name} />
    </nav>
  );
}

function Environment({ e, isDefault }: { e: EnvironmentView; isDefault: boolean }) {
  return (
    <li className="env">
      <p className="env-head">
        <Txt className="env-name" text={e.name} />
        {isDefault && <Badge>default</Badge>}
        <EnvFlags env={e} />
      </p>
      <table className="pages">
        <caption className="sr-only">Pages of {e.name}</caption>
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col">URL</th>
            <th scope="col">Shown as</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(e.pages).map(([key, url]) => (
            <tr key={key}>
              <th scope="row">
                <Txt text={key} />
              </th>
              <td>
                <Txt className="url" text={url} />
              </td>
              <td>{e.display?.[key] ? <Txt className="url" text={e.display[key]} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.personas.length > 0 && (
        <p className="muted small">
          Personas:{' '}
          {e.personas.map((p, i) => (
            <span key={p.name}>
              {i > 0 && ', '}
              <Txt text={p.name} />
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

function RecentRuns({ slug }: { slug: string }) {
  const [runs, reload] = useCall<{ runs: RunListItem[] }>('run_list', { project: slug, limit: 5 }, slug);
  useProjectEvents(slug, reload);
  if (runs.state === 'loading') return <Loading what="the runs" />;
  if (runs.state === 'error') return <p className="muted">{runs.error}</p>;
  if (runs.data.runs.length === 0) return <p className="muted">No run yet.</p>;
  return (
    <ul className="runs">
      {runs.data.runs.map((r) => (
        <li key={r.id}>
          {r.newer ? (
            <span className="muted">
              <Txt className="mono" text={r.id} />: written by a newer Demo Studio
            </span>
          ) : (
            <>
              <span className="run-what">
                <Txt text={r.scenario} /> · {r.mode === 'dry' ? 'dry run' : 'capture'} · <Txt text={r.env} />
              </span>
              <RunState status={r.status} />
              <span className="muted small">
                {r.steps_done}/{r.steps_total} steps · <When iso={r.started_at} />
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProjectPage({ slug }: { slug: string }) {
  const [view, reload] = useCall<ProjectView>('project_get', { project: slug }, slug);
  useProjectEvents(slug, reload);
  if (view.state === 'loading') return <div className="screen"><Loading what="the project" /></div>;
  if (view.state === 'error') {
    return (
      <div className="screen">
        <Breadcrumb name={slug} />
        <Notice tone="danger" role="alert" title="This project cannot be opened">
          <p className="pre-line">
            <Txt text={view.error} />
          </p>
        </Notice>
      </div>
    );
  }
  const p = view.data;
  const lines = p.readme?.split('\n') ?? [];
  return (
    <div className="screen">
      <Breadcrumb name={p.name} />
      <header className="screen-head">
        <h1>
          <Txt text={p.name} />
        </h1>
        <p className="muted">
          <Txt className="slug" text={p.slug} /> · <Txt className="path" text={p.dir} />
        </p>
      </header>
      {p.warnings.length > 0 && (
        <Notice tone="warning" role="note" title={`project.yaml: ${plural(p.warnings.length, 'warning')}`}>
          <ul>
            {p.warnings.map((w, i) => (
              <li key={i}>
                <Txt text={w.message} />
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="columns">
        <section className="card" aria-labelledby="readme-h">
          <div className="card-head">
            <h2 id="readme-h" className="card-title">
              README
            </h2>
            <a className="button" href={hrefTo({ name: 'readme', slug: p.slug })}>
              {p.readme_error ? 'Open the README' : p.readme === null ? 'Write the README' : 'Edit the README'}
            </a>
          </div>
          {p.readme_error && (
            <Notice tone="warning" role="note" title="README.md cannot be edited here">
              <p className="pre-line">
                <Txt text={p.readme_error} />
              </p>
            </Notice>
          )}
          {p.readme === null ? (
            !p.readme_error && <p className="muted">No README.md yet. It tells Claude the product, the audience, the goals and the tone.</p>
          ) : (
            <>
              <pre className="readme-text" data-testid="readme-preview">
                {lines.slice(0, README_PREVIEW_LINES).join('\n')}
              </pre>
              {lines.length > README_PREVIEW_LINES && <p className="muted small">{plural(lines.length - README_PREVIEW_LINES, 'more line')} in the editor.</p>}
            </>
          )}
        </section>
        <div className="stack">
          <section className="card" aria-labelledby="envs-h">
            <h2 id="envs-h" className="card-title">
              Environments
            </h2>
            {p.environments.length === 0 ? (
              <p className="muted">No environment.</p>
            ) : (
              <ul className="envs">
                {p.environments.map((e) => (
                  <Environment key={e.name} e={e} isDefault={e.name === p.default_env} />
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="scen-h">
            <h2 id="scen-h" className="card-title">
              Scenarios <span className="muted">({p.scenarios.length})</span>
            </h2>
            {p.scenarios.length === 0 ? (
              <p className="muted">No scenario yet.</p>
            ) : (
              <ul className="scenarios">
                {p.scenarios.map((s) => (
                  <li key={s}>
                    <Txt className="mono" text={s} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="runs-h">
            <h2 id="runs-h" className="card-title">
              Recent runs
            </h2>
            <RecentRuns slug={p.slug} />
          </section>
          <ActivityPanel project={p.slug} limit={6} />
        </div>
      </div>
    </div>
  );
}
