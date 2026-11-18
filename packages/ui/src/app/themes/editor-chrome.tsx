/**
 * The theme editor's chrome around its fields and live frame: the browser (sections and components), the heading, the
 * status bar, the theme's problems, the screen shown while the theme cannot be, and the status line after a write.
 */
import { memo } from 'react';
import type { ThemeEditView } from '@retake/engine';
import type { Loaded, OpResult } from '../api.js';
import { Txt } from '../bits.js';
import { okId } from '../words/library-words.js';
import { ShellSlot } from '../shell/slots.js';
import { SECTIONS, showSection } from './ThemeFields.js';
import { EDITOR_KINDS, SOURCE_BADGE, componentRow, kindLabel, usedByWords } from '../words/theme-words.js';
import { Button, Callout, LinkButton, SourceList, StatusMark, Tag } from '../ui-kit/index.js';

export interface Status {
  tone: 'info' | 'warning' | 'danger';
  text: string;
}

/** The select of "Use in a scenario" (the status bar's "Use in a scenario…" brings the focus to it). */
export const USE_SELECT = 'tm-use-scenario';

/** The browser: the theme's sections (anchors into the inspector's fields) and its components (each to the library). */
export const ThemeBrowser = memo(function ThemeBrowser({ slug, v }: { slug: string; v: ThemeEditView }) {
  return (
    <ShellSlot name="browser">
      <SourceList
        label="Theme sections"
        groups={[
          { key: 'sections', heading: <Txt text={v.name} />, label: 'Sections', items: SECTIONS.map((s) => ({ key: s.key, label: s.title, current: false, onSelect: () => showSection(s.key) })) },
          {
            key: 'components',
            heading: 'Components',
            label: 'Components of this theme',
            items: EDITOR_KINDS.map((k) => {
              const picked = componentRow(v, k).picked;
              return {
                key: k,
                label: kindLabel(k),
                current: false,
                detail: <Txt className="k-mono" text={picked ?? 'none'} />,
                quiet: picked === null,
                ...(picked && okId(picked) ? { to: { name: 'library' as const, slug, theme: v.name, component: picked } } : { onSelect: () => showSection('components') }),
              };
            }),
          },
          {
            key: 'back',
            items: [
              { key: 'themes', to: { name: 'themes', slug }, label: 'All themes', icon: 'theme', current: false },
              { key: 'library', to: { name: 'library', slug, theme: v.name }, label: 'Components in this theme', icon: 'components', current: false },
            ],
          },
        ]}
      />
    </ShellSlot>
  );
});

/** The status line after a written edit: its label, what the server removed, kept or dropped, and its warnings. */
export function editStatus(r: OpResult<'theme_edit'>, label: string): Status {
  const extra = [
    r.removed.some((x) => !r.label.includes(x)) ? `removed ${r.removed.join(', ')} (it contradicted the change)` : '',
    r.kept_params && Object.keys(r.kept_params).length ? `kept its params ${Object.keys(r.kept_params).join(', ')}` : '',
    r.dropped_params?.length ? `dropped its params ${r.dropped_params.join(', ')}` : '',
  ].filter(Boolean);
  return { tone: r.warnings.length ? 'warning' : 'info', text: `${label}${extra.length ? ` — ${extra.join('; ')}` : ''}.${r.warnings.length ? ` ${r.warnings.slice(0, 3).join(' · ')}` : ''}` };
}

/** The theme's first problems. */
export function ThemeIssues({ issues }: { issues: string[] }) {
  return (
    <Callout state="fail" role="note" title="This theme has problems">
      <ul className="tm-issues">
        {issues.slice(0, 6).map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the theme's first issues, replaced whole on each read, text only: the index is the identity
          <li key={i}>
            <Txt text={x} />
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** The theme not shown: loading, or why it cannot be opened. */
export function ThemeUnavailable({ view, slug, theme }: { view: Loaded<ThemeEditView>; slug: string; theme: string }) {
  if (view.state === 'loading') {
    return (
      <div className="tm-screen">
        <p className="tm-quiet" role="status">
          <Txt text={`Loading theme ${theme}…`} />
        </p>
      </div>
    );
  }
  return (
    <div className="tm-screen">
      <h1 className="tm-h1">
        <Txt text={theme} />
      </h1>
      <Callout state={view.state === 'error' && view.code === 'not_found' ? 'warn' : 'fail'} role="alert" title="This theme cannot be opened">
        <p className="tm-pre">
          <Txt text={view.state === 'error' ? view.error : ''} />
        </p>
        <LinkButton size="sm" to={{ name: 'themes', slug }}>
          Back to the themes
        </LinkButton>
      </Callout>
    </div>
  );
}

/** The status bar: the editor's state, Undo, Redo, Extract from a website…, Use in a scenario… */
export function ThemeActions({
  slug,
  busy,
  editable,
  canUndo,
  canRedo,
  noScenario,
  onUndo,
  onRedo,
}: {
  slug: string;
  busy: string | null;
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  noScenario: boolean;
  onUndo(): void;
  onRedo(): void;
}) {
  return (
    <ShellSlot name="actions">
      <span className="sh-scenario" data-testid="theme-state">
        {busy ? (
          <StatusMark state="running" word={`Busy: ${busy}`} />
        ) : editable ? (
          <StatusMark state="idle" word="Ready · each change is saved and checked" />
        ) : (
          <StatusMark state="idle" word="Read-only: copy it to edit it" />
        )}
      </span>
      <Button size="sm" variant="ghost" icon="undo" data-testid="theme-undo" disabled={!editable || busy !== null || !canUndo} onClick={onUndo}>
        Undo
      </Button>
      <Button size="sm" variant="ghost" icon="redo" data-testid="theme-redo" disabled={!editable || busy !== null || !canRedo} onClick={onRedo}>
        Redo
      </Button>
      <LinkButton size="sm" variant="ghost" to={{ name: 'themes', slug }}>
        Extract from a website…
      </LinkButton>
      <Button
        size="sm"
        variant="ghost"
        disabled={noScenario}
        onClick={() => {
          const el = document.getElementById(USE_SELECT);
          el?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          el?.focus();
        }}
      >
        Use in a scenario…
      </Button>
    </ShellSlot>
  );
}

/** The heading: the theme's name, whether it can be edited, its source and what uses it. */
export function ThemeHead({ v, slug, editable }: { v: ThemeEditView; slug: string; editable: boolean }) {
  return (
    <header className="tm-head">
      <h1 className="tm-h1">
        <Txt text={v.name} />
      </h1>
      <span className="tm-tags">
        <Tag>{editable ? (v.source === 'project' ? 'Editable · in this project' : 'Editable · in this workspace') : 'Read-only'}</Tag>
        <Tag>
          <Txt text={SOURCE_BADGE[v.source]} />
        </Tag>
        <span className="tm-quiet" data-testid="theme-used-by">
          <Txt text={usedByWords(v.used_by, slug)} />
        </span>
      </span>
    </header>
  );
}
