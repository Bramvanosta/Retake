/** The Library grid's one tab stop: the selection, the card the arrows move to, and the grid's key handler. */
import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { gridColumns } from '../ui-kit/index.js';

/**
 * The grid's keys (one tab stop): the next card in a direction among the sections' cards, by component.
 * ← → one card (across sections), ↑ ↓ a row of the section (the columns the browser laid out; past its first or last
 * row, the same column of the section before or after), Home / End the first and the last.
 */
export function nextCard(sections: string[][], at: string, key: string, columns: number): string | null {
  const s = sections.findIndex((x) => x.includes(at));
  if (s < 0) return null;
  const flat = sections.flat();
  const i = flat.indexOf(at);
  const k = sections[s].indexOf(at);
  const len = sections[s].length;
  const cols = Math.max(1, columns);
  if (key === 'ArrowRight') return flat[Math.min(flat.length - 1, i + 1)];
  if (key === 'ArrowLeft') return flat[Math.max(0, i - 1)];
  if (key === 'Home') return flat[0];
  if (key === 'End') return flat[flat.length - 1];
  if (key === 'ArrowDown') {
    if (k + cols < len) return sections[s][k + cols];
    if (Math.floor(k / cols) < Math.floor((len - 1) / cols)) return sections[s][len - 1];
    const next = sections[s + 1];
    return next ? next[Math.min(k % cols, next.length - 1)] : at;
  }
  if (key === 'ArrowUp') {
    if (k - cols >= 0) return sections[s][k - cols];
    const prev = sections[s - 1];
    if (!prev) return at;
    const lastRow = Math.floor((prev.length - 1) / cols) * cols;
    return prev[Math.min(lastRow + (k % cols), prev.length - 1)];
  }
  return null;
}

/** The grid's key handler (one tab stop): the arrows move the selection, Enter reaches the inspector, Escape clears. */
export function gridKeyHandler(sections: string[][], selected: string | null, select: (c: string | null) => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.lb-card > .k-card');
    const card = btn?.closest<HTMLElement>('[data-testid="lib-card"]');
    const at = card?.dataset.component;
    if (!btn || !card || !at) return;
    if (e.key === 'Enter') {
      if (at !== selected) return;
      // Enter on the selected card: its inspector (the pane, or in place when the person hid it).
      e.preventDefault();
      const target = document.querySelector<HTMLElement>('[data-lib-focus]');
      target?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      target?.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (selected === null) return;
      e.preventDefault();
      select(null);
      return;
    }
    const next = nextCard(sections, at, e.key, e.key === 'ArrowDown' || e.key === 'ArrowUp' ? gridColumns(card.parentElement) : 1);
    if (next === null) return;
    e.preventDefault();
    if (next !== at || selected !== at) select(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="lib-card"][data-component="${CSS.escape(next)}"] > .k-card`)?.focus();
  };
}

/** The selected card, and the card picked last (the grid's tab stop when nothing is selected; Escape keeps it). */
export function useSelection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const select = useCallback((c: string | null) => {
    setSelected(c);
    if (c !== null) setCursor(c);
  }, []);
  return { selected, cursor, select };
}

/** The grid's one tab stop: the selected card when shown, else the card picked last, else the first. */
export function gridTabStop(sections: string[][], selected: string | null, cursor: string | null) {
  const isShown = (c: string | null) => c !== null && sections.some((x) => x.includes(c));
  return isShown(selected) ? selected : isShown(cursor) ? cursor : (sections[0]?.[0] ?? null);
}
