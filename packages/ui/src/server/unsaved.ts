/**
 * Unsaved text in the Studio's tabs (L5.2b, DESIGN §4j): each tab session reports what it holds unsaved — enums and
 * slugs only, never the text — through the own op `unsaved_report`, and the server keeps the latest report of each tab
 * on a board. The desktop shell's quit question reads the board through the supervised pipe (supervise.ts); a browser
 * tab's report is harmless and lets the app's server know about a second tab.
 *
 * - A report names kinds (UNSAVED_KINDS) with a project and a scenario that must pass the slug rules (≤ 100 characters)
 *   and exist (`<projects>/<project>/project.yaml`, `scenarios/<scenario>.yaml`): a name that does not is dropped, the
 *   item kept (review A L4: one bad name never refuses the tab's whole report). The op's input is strict in its shape
 *   (an extra field such as a label is a 400): no page text reaches the board.
 * - A report never outlives its tab session (critique L8): an empty report clears the tab (the page sends one when its
 *   set empties and on `pagehide`), and the board ends with its server. Reports of one tab apply in the order they
 *   came (reviews A M1 / B M3): each call takes the tab's next number on entry, and a report whose existence checks
 *   finish after a newer call of its tab is dropped — a late report never re-adds a tab its `pagehide` cleared. No
 *   timer: a hidden window's throttled timers cannot expire a report the person still needs. Worst case, a tab killed
 *   without `pagehide` (a WebContent crash) leaves one needless question until the server stops.
 * - At most UNSAVED_TABS_MAX tabs (critique L3): a new tab id beyond them is refused, never an older tab evicted (the
 *   oldest report is the hidden app window's — the one this exists for).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PROJECT_SLUG_RE, SLUG_RE, projectPath } from '@retake/core';
import { EngineError } from '@retake/engine';
import type { ToolDef } from '@retake/engine/contract';

export const UNSAVED_KINDS = ['readme', 'yaml_draft', 'step_form', 'comment', 'component_brief', 'new_theme', 'theme_draft'] as const;
export type UnsavedKind = (typeof UNSAVED_KINDS)[number];
/** Tabs the board keeps at most. */
export const UNSAVED_TABS_MAX = 16;
/** Items one report may name. */
export const UNSAVED_ITEMS_MAX = 16;
/** The longest name the op takes (longer: a 400); a name the board keeps is at most NAME_MAX. */
const NAME_INPUT_MAX = 1000;
/** The longest project or scenario name kept (the other ops' cap, the shell's slug rule). */
export const NAME_MAX = 100;
/** A tab session's id: 22 base64url characters (16 random bytes), made by the page per load. */
export const TAB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export interface UnsavedItem {
  kind: UnsavedKind;
  project?: string;
  scenario?: string;
}

export const UnsavedReportInput = z.strictObject({
  tab: z.string().regex(TAB_ID_RE, 'a tab session id (22 base64url characters)'),
  hidden: z.boolean().describe('The tab is hidden (its window closed or in the background).'),
  items: z
    .array(
      z.strictObject({
        kind: z.enum(UNSAVED_KINDS),
        // Any short text: one that is no name (no slug, too long) is dropped by the board, the item kept (review A L4).
        project: z.string().max(NAME_INPUT_MAX).optional(),
        scenario: z.string().max(NAME_INPUT_MAX).optional(),
      }),
    )
    .max(UNSAVED_ITEMS_MAX)
    .describe('What the tab holds unsaved now (empty: nothing, or the tab is going away).'),
});

const itemKey = (i: UnsavedItem) => `${i.kind}\u0000${i.project ?? ''}\u0000${i.scenario ?? ''}`;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export class UnsavedBoard {
  private readonly tabs = new Map<string, { items: UnsavedItem[]; hidden: boolean }>();
  private readonly listeners = new Set<() => void>();
  /** Each tab's latest call number (A M1 / B M3): a report applies only if no newer call of its tab came meanwhile. */
  private readonly seq = new Map<string, number>();
  private calls = 0;

  /** `projectsDir`: the workspace's projects folder (names are kept only for what exists there). */
  constructor(private readonly projectsDir: string) {}

  /** The names of `item` that exist; a name that does not is dropped (the item stays). */
  private async checked(item: UnsavedItem): Promise<UnsavedItem> {
    const out: UnsavedItem = { kind: item.kind };
    if (item.project === undefined || item.project.length > NAME_MAX || !PROJECT_SLUG_RE.test(item.project)) return out;
    const dir = join(this.projectsDir, item.project);
    if (!(await exists(join(dir, 'project.yaml')))) return out;
    out.project = item.project;
    if (item.scenario !== undefined && item.scenario.length <= NAME_MAX && SLUG_RE.test(item.scenario) && (await exists(projectPath(dir, 'scenarios', `${item.scenario}.yaml`)))) out.scenario = item.scenario;
    return out;
  }

  /** The latest report of tab `tab` (an empty one clears it). Throws `busy` for a new tab beyond UNSAVED_TABS_MAX. */
  async report(tab: string, hidden: boolean, items: readonly UnsavedItem[]): Promise<void> {
    if (items.length > 0 && !this.tabs.has(tab) && this.tabs.size >= UNSAVED_TABS_MAX) {
      throw new EngineError('busy', `${UNSAVED_TABS_MAX} tabs already report unsaved text: close one`);
    }
    const n = ++this.calls;
    this.seq.set(tab, n);
    if (items.length === 0) {
      // No report left: the tab's number goes too — a late call of the tab then finds none and is dropped.
      this.seq.delete(tab);
      if (this.tabs.delete(tab)) this.changed();
      return;
    }
    const seen = new Set<string>();
    const kept: UnsavedItem[] = [];
    for (const i of await Promise.all(items.slice(0, UNSAVED_ITEMS_MAX).map((x) => this.checked(x)))) {
      const k = itemKey(i);
      if (seen.has(k)) continue;
      seen.add(k);
      kept.push(i);
    }
    // A newer call of this tab came during the checks (its pagehide's empty report, or a newer state): this one is stale.
    if (this.seq.get(tab) !== n) return;
    // Other new tabs filled the board during the checks.
    if (!this.tabs.has(tab) && this.tabs.size >= UNSAVED_TABS_MAX) {
      this.seq.delete(tab);
      throw new EngineError('busy', `${UNSAVED_TABS_MAX} tabs already report unsaved text: close one`);
    }
    const before = this.tabs.get(tab);
    this.tabs.set(tab, { items: kept, hidden });
    if (!before || JSON.stringify(before.items) !== JSON.stringify(kept)) this.changed();
  }

  /** Every tab's items, deduplicated across tabs, in a stable order. */
  items(): UnsavedItem[] {
    const all = new Map<string, UnsavedItem>();
    for (const t of this.tabs.values()) for (const i of t.items) all.set(itemKey(i), i);
    return [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, i]) => i);
  }

  /** Tabs with a report now. */
  get tabCount(): number {
    return this.tabs.size;
  }

  /** Called on every change of `items()`; returns the unsubscribe. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }
}

/** The own op `unsaved_report` on `board`. Not read-only (the board changes), idempotent; never nudges the job watch. */
export function unsavedOps(board: UnsavedBoard): ToolDef[] {
  const op: ToolDef<typeof UnsavedReportInput> = {
    name: 'unsaved_report',
    title: 'Report unsaved text',
    description: "What this tab holds unsaved (kinds and names only, never the text): the desktop app's quit question names it.",
    input: UnsavedReportInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      await board.report(a.tab, a.hidden, a.items);
      return { summary: `${board.items().length} unsaved item(s) across ${board.tabCount} tab(s)`, data: { tabs: board.tabCount } };
    },
  };
  return [op as unknown as ToolDef];
}

export const UNSAVED_OPS = ['unsaved_report'] as const;
