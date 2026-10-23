/**
 * The Studio's two reads of the workspace index (L4.1 part 3): recent activity (`activity_list`: unfinished jobs live
 * from the queue, then finished jobs and terminal commands from the history) and a search box (`search`: projects,
 * READMEs, scenarios, runs, renders). Both re-read on the events that concern them. Every value is a text node; a hit
 * links only to an in-app route (hrefTo). Without node:sqlite (Node.js before 22.13) the server says so and both
 * panels show it.
 */
import { useEffect, useState } from 'react';
import type { ActivityItem, SearchHit } from '@demo-studio/engine';
import { call, errorText, useCall } from './api.js';
import { Badge, Loading, RunState, Txt, When } from './bits.js';
import { useEvents } from './events.js';
import { hrefTo } from './route.js';
import { SessionEnded } from './session.js';

const BY: Record<string, string> = { cli: 'from a terminal', mcp: 'by Claude', ui: 'from the Studio', test: 'by a test' };

/** "capture quote", "render quote-v1", "review quote-v1", "hooks"… */
function what(i: ActivityItem): string {
  if (i.run) return `${i.run.mode === 'dry' ? 'dry run' : 'capture'} of ${i.run.scenario}`;
  if (i.render) return `${i.kind} ${i.render.id}`;
  return i.kind.replace(/_/g, ' ');
}

function Item({ i, showProject }: { i: ActivityItem; showProject: boolean }) {
  const p = i.progress;
  const progress = i.state === 'running' && p ? (p.fraction !== undefined ? `${Math.round(p.fraction * 100)} %` : p.steps_total ? `${p.steps_done}/${p.steps_total} steps` : p.phase) : undefined;
  return (
    <li className="activity-item" data-testid="activity-item">
      {/* A finished run job "succeeded" when it ran to its end: the run's own status says how it went. */}
      <RunState status={i.source === 'history' && i.state === 'succeeded' && i.run?.status ? i.run.status : i.state} />
      <span className="activity-what">
        <Txt text={what(i)} />
        {showProject && i.project && (
          <>
            {' · '}
            <a href={hrefTo({ name: 'project', slug: i.project })}>
              <Txt text={i.project} />
            </a>
          </>
        )}
      </span>
      <span className="muted small">
        {progress && <>{progress} · </>}
        {BY[i.submitted_by] ?? i.submitted_by} · <When iso={i.at} />
      </span>
    </li>
  );
}

/** Recent activity of the workspace, or of one project. */
export function ActivityPanel({ project, limit = 8 }: { project?: string; limit?: number }) {
  const [v, reload] = useCall<{ items: ActivityItem[] }>('activity_list', { ...(project ? { project } : {}), limit }, project ?? '*');
  useEvents((e) => {
    if (e.type === 'jobs' || e.type === 'index' || e.type === 'resync') reload();
  });
  return (
    <section className="card" aria-labelledby={`activity-h-${project ?? 'all'}`} data-testid="activity">
      <h2 id={`activity-h-${project ?? 'all'}`} className="card-title">
        Recent activity
      </h2>
      {v.state === 'loading' && <Loading what="the activity" />}
      {v.state === 'error' && <p className="muted">{v.error}</p>}
      {v.state === 'ready' && v.data.items.length === 0 && <p className="muted">Nothing yet: captures, renders and other jobs show here.</p>}
      {v.state === 'ready' && v.data.items.length > 0 && (
        <ul className="activity">
          {v.data.items.map((i) => (
            <Item key={`${i.source}:${i.job ?? ''}:${i.at}:${i.kind}`} i={i} showProject={!project} />
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND: Record<SearchHit['kind'], string> = { project: 'project', scenario: 'scenario', run: 'run', render: 'render' };

/** The search box: hits as the person types (a short pause first), each linking to its project. */
export function SearchBox() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ q: string; hits: SearchHit[] } | { q: string; error: string } | null>(null);
  const [tick, setTick] = useState(0);
  useEvents((e) => {
    if (e.type === 'index' || e.type === 'resync') setTick((t) => t + 1);
  });
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      call<{ hits: SearchHit[] }>('search', { q: query.slice(0, 200), limit: 20 }).then(
        (d) => live && setHits({ q: query, hits: d.hits }),
        (e: unknown) => live && !(e instanceof SessionEnded) && setHits({ q: query, error: errorText(e) }),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, tick]);
  return (
    <section className="search" role="search" aria-label="Search the workspace">
      <label htmlFor="search-q" className="label">
        Search
      </label>
      <input
        id="search-q"
        type="search"
        className="search-input"
        value={q}
        maxLength={200}
        placeholder="Projects, READMEs, scenarios, runs, renders"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
      />
      {hits && 'error' in hits && <p className="muted">{hits.error}</p>}
      {hits && 'hits' in hits && (
        <div aria-live="polite">
          {hits.hits.length === 0 ? (
            <p className="muted" data-testid="search-empty">
              Nothing matches “<Txt text={hits.q} />”.
            </p>
          ) : (
            <ul className="search-hits" data-testid="search-hits">
              {hits.hits.map((h) => (
                <li key={`${h.kind}:${h.project}:${h.ref}`} data-testid="search-hit">
                  <Badge>{KIND[h.kind]}</Badge>
                  <a href={hrefTo({ name: 'project', slug: h.project })}>
                    <Txt text={h.title} />
                  </a>
                  {h.kind !== 'project' && h.ref !== h.title && <Txt className="mono small" text={h.ref} />}
                  {h.kind !== 'project' && (
                    <span className="muted small">
                      in <Txt text={h.project} />
                    </span>
                  )}
                  {h.snippet && <Txt className="snippet muted small" text={h.snippet} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
