/** The Library grid's controls: the title bar's Theme select, the registry notices, the Source / search / Kind filters. */
import { useId } from 'react';
import type { LibraryItem, LibraryViewAnswer } from '../../server/library-ops.js';
import { Txt, plural } from '../bits.js';
import { KIND_ORDER, SOURCE_WORDS, filterCounts, isKind, kindHeading } from '../words/library-words.js';
import type { LibraryFilter, SourceFilter } from '../words/library-words.js';
import { hrefTo } from '../route.js';
import { ChoiceChips, Disclosure, Segmented, Select, StatusMark, TextField } from '../ui-kit/index.js';

export function ThemeSelect({ view, slug }: { view: LibraryViewAnswer; slug: string }) {
  return (
    <Select
      label="Theme"
      layout="inline"
      value={view.theme.name}
      testId="lib-theme"
      onChange={(t) => (location.hash = hrefTo({ name: 'library', slug, theme: t }))}
      options={view.themes.map((t) => ({
        value: t.name,
        label: `${t.name}${t.default ? " — the project's theme" : ''}${t.source === 'starter' ? ' (starter)' : t.by_path ? ' (project folder)' : t.source === 'project' ? ' (project)' : ''}`,
      }))}
    />
  );
}

export function Notices({ notices }: { notices: LibraryViewAnswer['notices'] }) {
  if (!notices.length) return null;
  const errors = notices.filter((n) => n.severity === 'error').length;
  return (
    <Disclosure testId="lib-notices" summary={`${plural(notices.length, 'registry notice')}${errors ? ` — ${plural(errors, 'component')} cannot be loaded` : ''}`}>
      <ul className="lb-notices">
        {notices.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the registry's notices, replaced whole on each read, text only: the index is the identity
          <li key={i}>
            <StatusMark state={n.severity === 'error' ? 'fail' : 'warn'} word={n.severity === 'error' ? 'Not loadable' : 'Warning'} /> {n.id && <Txt className="k-mono" text={n.id} />}{' '}
            <Txt text={n.untrusted.message} />
            {n.issues > 0 && <Txt className="lb-quiet" text={` (${plural(n.issues, 'issue')})`} />}
            {n.command && (
              <>
                {' '}
                <code className="k-mono lb-code">
                  <Txt text={n.command} />
                </code>
              </>
            )}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function Filters({ items, filter, set }: { items: LibraryItem[]; filter: LibraryFilter; set: (f: LibraryFilter) => void }) {
  // A chip counts what choosing it would show under the other filters (a component under every kind it serves).
  const { all, kinds: counts } = filterCounts(items, filter);
  const kinds = [...new Set([...KIND_ORDER.filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !isKind(k)), ...(filter.kind !== 'all' ? [filter.kind] : [])])];
  const kindId = useId();
  return (
    <div className="lb-filters" data-testid="lib-filters">
      <div className="lb-filter-line">
        <Segmented<SourceFilter>
          label="Source"
          size="sm"
          value={filter.source}
          onChange={(s) => set({ ...filter, source: s })}
          options={(['all', 'builtin', 'workspace'] as const).map((s) => ({ value: s, label: s === 'all' ? 'All' : SOURCE_WORDS[s].badge }))}
        />
        <div className="lb-search">
          <TextField
            label="Search components"
            labelHidden
            type="search"
            value={filter.text}
            onChange={(t) => set({ ...filter, text: t })}
            unsaved={null}
            placeholder="Name, id or description"
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            testId="lib-find"
          />
        </div>
      </div>
      <div className="lb-kinds">
        <span id={kindId} className="lb-label">
          Kind
        </span>
        <ChoiceChips
          labelledBy={kindId}
          chips={['all', ...kinds].map((k) => ({ key: k, value: k, checked: filter.kind === k, label: k === 'all' ? `All (${all})` : `${kindHeading(k)} (${counts[k] ?? 0})` }))}
          onPick={(k) => set({ ...filter, kind: k })}
        />
      </div>
    </div>
  );
}
