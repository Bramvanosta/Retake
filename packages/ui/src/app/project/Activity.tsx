/**
 * The Studio's two reads of the workspace index (L4.1 part 3; L5.10a: rebuilt on the kit): "Lately" (`activity_list`:
 * unfinished jobs live from the queue, then finished jobs and terminal commands from the history — of the workspace, a
 * project, or one production filtered on the page) and the search (`search`: projects, READMEs, scenarios, runs,
 * renders). Both re-read on the events that concern them. Every value is text (Txt / a kit slot); a hit links only to
 * an in-app route (hrefTo). Without node:sqlite (Node.js before 22.13) the server says so and both show it.
 */
import { useEffect, useState } from 'react';
import type { ActivityItem, SearchHit } from '@retake/engine';
import { errorText } from '../api.js';
import { search, useActivityList } from '../data/projects.js';
import { Txt, When, shown } from '../bits.js';
import { useEvents } from '../events.js';
import { yieldWords } from '../words/render-words.js';
import { hrefTo } from '../route.js';
import { SessionEnded } from '../session.js';
import { StatusMark, TextField } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';

const BY: Record<string, string> = { cli: 'from a terminal', mcp: 'by Claude', ui: 'from the Studio', test: 'by a test' };
const STATE: Record<string, [MarkState, string]> = {
  queued: ['waiting', 'Queued'],
  running: ['running', 'Running'],
  succeeded: ['ok', 'Succeeded'],
  failed: ['fail', 'Failed'],
  cancelled: ['idle', 'Cancelled'],
  interrupted: ['fail', 'Interrupted'],
};

/** "capture of quote", "render quote-v1", "review quote-v1", "hooks"… */
function what(i: ActivityItem): string {
  if (i.run) return `${i.run.mode === 'dry' ? 'rehearsal' : 'capture'} of ${i.run.scenario}`;
  if (i.render) return `${i.kind} ${i.render.id}`;
  return i.kind.replace(/_/g, ' ');
}

function Item({ i, showProject }: { i: ActivityItem; showProject: boolean }) {
  const p = i.progress;
  const progress = i.state === 'running' && p ? (p.fraction !== undefined ? `${Math.round(p.fraction * 100)} %` : p.steps_total ? `${p.steps_done}/${p.steps_total} steps` : p.phase) : undefined;
  // L5.14: a heavy job a filming take holds (waiting, slowed, or going on past the cap).
  const held = i.source === 'queue' && i.yield ? yieldWords(i.yield) : undefined;
  // A finished run job "succeeded" when it ran to its end: the run's own status says how it went.
  const status = i.source === 'history' && i.state === 'succeeded' && i.run?.status ? i.run.status : i.state;
  const [state, word] = STATE[status] ?? ['attention', 'Status unknown'];
  return (
    <li className="sc-lately-item" data-testid="activity-item">
      <StatusMark state={state} word={word} />
      <span className="sc-lately-what">
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
      <span className="sc-lately-meta">
        {progress && <>{shown(progress)} · </>}
        {held && <>{shown(held)} · </>}
        {shown(BY[i.submitted_by] ?? i.submitted_by)} · <When iso={i.at} />
      </span>
    </li>
  );
}

/** Lately: the recent activity of the workspace, a project, or one of its productions (`scenario`, filtered here). */
export function Lately({ project, scenario, limit = 8, label = 'Lately' }: { project?: string; scenario?: string; limit?: number; label?: string }) {
  const [v, reload] = useActivityList({ ...(project ? { project } : {}), limit: scenario ? 20 : limit }, project ?? '*');
  useEvents((e) => {
    if (e.type === 'jobs' || e.type === 'index' || e.type === 'resync') reload();
  });
  const items = v.state === 'ready' ? (scenario ? v.data.items.filter((i) => i.run?.scenario === scenario || i.render?.scenario === scenario).slice(0, limit) : v.data.items) : [];
  return (
    <div className="sc-lately" data-testid="activity" role="group" aria-label={label}>
      {v.state === 'loading' && <p className="sc-quiet">Loading the activity…</p>}
      {v.state === 'error' && <Txt className="sc-quiet" text={v.error} />}
      {v.state === 'ready' && items.length === 0 && (
        <p className="sc-quiet">{scenario ? 'Nothing for this production in the project’s recent activity.' : 'Nothing yet: captures, renders and other jobs show here.'}</p>
      )}
      {items.length > 0 && (
        <ul className="sc-lately-list">
          {items.map((i) => (
            <Item key={`${i.source}:${i.job ?? ''}:${i.at}:${i.kind}`} i={i} showProject={!project} />
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND: Record<SearchHit['kind'], string> = { project: 'project', scenario: 'scenario', run: 'run', render: 'render' };

/** The search: hits as the person types (a short pause first), each linking to its project. */
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
      search({ q: query.slice(0, 200), limit: 20 }).then(
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
    <section className="sc-search" role="search" aria-label="Search the workspace">
      <TextField
        label="Search"
        type="search"
        value={q}
        onChange={setQ}
        unsaved={null}
        placeholder="Projects, READMEs, scenarios, runs, renders"
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
      />
      {hits && 'error' in hits && <Txt className="sc-quiet" text={hits.error} />}
      {hits && 'hits' in hits && (
        <div aria-live="polite">
          {hits.hits.length === 0 ? (
            <p className="sc-quiet" data-testid="search-empty">
              Nothing matches “<Txt text={hits.q} />
              ”.
            </p>
          ) : (
            <ul className="sc-hits" data-testid="search-hits">
              {hits.hits.map((h) => (
                <li key={`${h.kind}:${h.project}:${h.ref}`} className="sc-hit" data-testid="search-hit">
                  <span className="sc-hit-kind">{shown(KIND[h.kind])}</span>
                  <a href={hrefTo({ name: 'project', slug: h.project })}>
                    <Txt text={h.title} />
                  </a>
                  {h.kind !== 'project' && h.ref !== h.title && <Txt className="k-mono sc-quiet" text={h.ref} />}
                  {h.kind !== 'project' && (
                    <span className="sc-quiet">
                      in <Txt text={h.project} />
                    </span>
                  )}
                  {h.snippet && <Txt className="sc-hit-snippet" text={h.snippet} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
