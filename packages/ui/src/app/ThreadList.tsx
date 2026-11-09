/**
 * The comments' list in the browser pane (L4.6 part D1; L5.12b « Épure » 4b, R4-Comments' left pane: was
 * CommentsScreen.tsx's): the scenario's threads — Open (default) · Resolved · All as a segmented control, and "This
 * render only" (the render the viewer shows) — each a link to its thread (the open one `aria-current="page"`): its status
 * as a mark and a word, its time, its render ("render gone" once removed), the first line of the comment (untrusted:
 * text), where it points, its channel and entries, its newest proposal's state. "All" groups them Open, then Resolved,
 * under headings with their counts. The counts, a cut list ("The first 200 of 340") and unreadable files are said.
 * While a new filter is read the list shown stays (marked busy) with its own words — the filter it was read with: the
 * pane never flashes back to "Loading" nor says the new filter's words over the old list.
 * Thread rows carry no thumbnail (a still read per row is a read storm: BL-133).
 */
import { memo, useEffect, useId, useRef } from 'react';
import type { ThreadItem } from '../server/comment-ops.js';
import { useThreadsList } from './data/comments.js';
import type { Loaded } from './api.js';
import { Txt, plural } from './bits.js';
import { channelWords, proposalWords, renderWords, statusWords, whereWords } from './comment-words.js';
import { threadMark } from './ThreadPanel.js';
import { Callout, RowCard, RowList, RowListItem, Segmented, StatusMark, Switch } from './ui-kit/index.js';

export type Filter = 'open' | 'resolved' | 'all';

/** The first line of a text (a row shows one). */
const firstLine = (s: string) => s.split('\n', 1)[0] ?? '';

/** What a list was read with: its words (the groups, the empty sentence) are this one's, not the filter just chosen. */
interface ReadWith {
  filter: Filter;
  render: string | null;
}

/**
 * The list as last read for this scenario, with what it was read with (shown while a new filter is read: the pane never
 * jumps to "Loading", and its words stay those of the list on screen — review B-L1). A newly arrived answer (a new object)
 * is tagged with the props of its request; the old answer still held on the render a filter changes keeps its own tag.
 */
function useSteady<T>(loaded: Loaded<T>, scope: string, now: ReadWith): { data: T | null; read: ReadWith | null; busy: boolean; error: string | null } {
  const last = useRef<{ scope: string; data: T; read: ReadWith } | null>(null);
  if (loaded.state === 'ready' && (!last.current || last.current.data !== loaded.data)) last.current = { scope, data: loaded.data, read: now };
  const kept = last.current && last.current.scope === scope ? last.current : null;
  const stale = kept !== null && (kept.read.filter !== now.filter || kept.read.render !== now.render);
  return { data: kept?.data ?? null, read: kept?.read ?? null, busy: loaded.state === 'loading' || stale, error: loaded.state === 'error' ? loaded.error : null };
}

function ThreadRow({ t, slug, name, current }: { t: ThreadItem; slug: string; name: string; current: boolean }) {
  return (
    <RowListItem testId="thread-item" data={{ id: t.id, status: t.status }}>
      <RowCard
        compact
        to={{ name: 'comments', slug, scenario: name, thread: t.id }}
        selected={current}
        tile={<Txt className="k-mono" text={t.timecode} />}
        title={<Txt text={firstLine(t.untrusted.text)} />}
        meta={
          <>
            <StatusMark state={threadMark(t.status)} word={statusWords(t.status)} />
            <Txt text={` · ${t.render_present ? `on ${renderWords(t.render_id)}` : 'render gone'} · ${whereWords(t.anchor)} · ${channelWords(t.via)}${t.entries_total > 0 ? ` · ${plural(t.entries_total, 'entry', 'entries')}` : ''}`} />
            {t.proposal && (
              <>
                {' · '}
                <StatusMark state={t.proposal.actionable ? 'warn' : 'idle'} word={proposalWords(t.proposal.state)} />
              </>
            )}
          </>
        }
      />
    </RowListItem>
  );
}

/** Memoised (review A-L2): a frame step of the viewer re-renders the screen, never this list (its props are stable). */
export const ThreadList = memo(function ThreadList(p: { slug: string; name: string; filter: Filter; setFilter: (f: Filter) => void; onlyRender: boolean; setOnlyRender: (b: boolean) => void; render: string | null; current?: string; tick: number }) {
  const only = p.onlyRender && p.render !== null;
  const args = { project: p.slug, name: p.name, status: p.filter, ...(only ? { render: p.render! } : {}) };
  const [loaded, reload] = useThreadsList(args, `${p.slug}\0${p.name}\0${p.filter}\0${only ? p.render : ''}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [p.tick, reload]);
  const list = useSteady(loaded, `${p.slug}\0${p.name}`, { filter: p.filter, render: only ? p.render : null });
  const h = useId();
  const d = list.data;
  // The words describe the list on screen: the filter (and render) it was read with.
  const shownFilter = list.read?.filter ?? p.filter;
  const shownRender = list.read?.render ?? null;
  const groups: Array<{ key: string; title: string | null; items: ThreadItem[] }> = !d
    ? []
    : shownFilter === 'all'
      ? [
          { key: 'open', title: `Open (${d.threads.filter((t) => t.status === 'open').length})`, items: d.threads.filter((t) => t.status === 'open') },
          { key: 'resolved', title: `Resolved (${d.threads.filter((t) => t.status !== 'open').length})`, items: d.threads.filter((t) => t.status !== 'open') },
        ].filter((g) => g.items.length > 0)
      : [{ key: shownFilter, title: null, items: d.threads }];
  return (
    <nav className="cm-list" aria-labelledby={h} data-testid="thread-list">
      <h2 id={h} className="cm-list-h">
        {'Comments'}
        {d && (
          <span className="cm-list-counts" data-testid="thread-counts">
            <Txt text={` · ${d.counts.open} open · ${d.counts.resolved} resolved`} />
          </span>
        )}
      </h2>
      <div className="cm-list-filters">
        <Segmented
          label="Show"
          size="sm"
          value={p.filter}
          onChange={p.setFilter}
          options={[
            { value: 'open', label: 'Open', testId: 'filter-open' },
            { value: 'resolved', label: 'Resolved', testId: 'filter-resolved' },
            { value: 'all', label: 'All', testId: 'filter-all' },
          ]}
        />
        <Switch label="This render only" checked={p.onlyRender} disabled={p.render === null} onChange={p.setOnlyRender} testId="filter-render" />
      </div>
      {list.error !== null ? (
        <Callout state="fail" role="alert" title="The threads cannot be read">
          <p className="cm-pre">
            <Txt text={list.error} />
          </p>
        </Callout>
      ) : !d ? (
        <p className="cm-quiet" role="status">
          Loading the threads…
        </p>
      ) : (
        <div className="cm-list-body" aria-busy={list.busy}>
          {d.threads.length === 0 ? (
            <p className="cm-quiet" data-testid="no-threads">
              <Txt text={`${shownFilter === 'open' ? 'No open comment' : shownFilter === 'resolved' ? 'No resolved comment' : 'No comment'}${shownRender !== null ? ` on ${renderWords(shownRender)}` : ' on this scenario'} yet.`} />
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="cm-group" aria-label={g.title ?? undefined}>
                {g.title && (
                  <h3 className="cm-group-h">
                    <Txt text={g.title} />
                  </h3>
                )}
                <RowList className="cm-rows">
                  {g.items.map((t) => (
                    <ThreadRow key={t.id} t={t} slug={p.slug} name={p.name} current={p.current === t.id} />
                  ))}
                </RowList>
              </section>
            ))
          )}
          {d.total > d.threads.length && (
            <p className="cm-quiet">
              <Txt text={`The first ${d.threads.length} of ${d.total} are listed.`} />
            </p>
          )}
          {d.problems > 0 && (
            <p className="cm-quiet">
              <Txt text={`${plural(d.problems, 'thread file')} could not be read (a hand-edited file, or one from a newer Studio).`} />
            </p>
          )}
        </div>
      )}
    </nav>
  );
});
