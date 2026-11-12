/**
 * L5.10b: the scenario's browser (B32-Scenario: the shell's `browser` slot while a scenario is open) — the video, then
 * the entries in file order: Before filming (its hooks), each filmed scene (its number, its title, its captured length
 * and a bar of it against the longest scene: decorative, the length says it), the cards and interstitials (quieter, their
 * length), After filming. A row selects its entry into the inspector and brings it into view (on the board: the entry;
 * in the YAML view: its lines). The current row is the selection's entry (a step: its scene). Every name is text.
 */
import type { SceneBlock } from '@retake/core';
import { Txt, plural } from '../bits.js';
import { entryTitle, hooksLine, sceneLength } from './Storyboard.js';
import type { Subject } from './Storyboard.js';
import type { View } from '../words/scenario-words.js';
import { SourceList } from '../ui-kit/index.js';
import type { SourceItem } from '../ui-kit/index.js';

/** "1:00.0" / "9.3 s": a total length. */
function total(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function ScenesBrowser({ v, current, onPick }: { v: View; /** The selection's row: 'video', 'before', 'after', `scene:<id>` (a step: its scene's) or `entry:<index>`. */ current: string; onPick: (s: Subject, at: string) => void }) {
  const scenes = v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene');
  const lengths = scenes.map((s) => v.scenes[s.id]?.captured_s ?? 0);
  const longest = Math.max(0, ...lengths);
  const sum = lengths.reduce((a, b) => a + b, 0);
  const { setup, teardown, named } = v.blocks.hooks;
  const items: SourceItem[] = [];
  items.push({ key: 'video', label: 'Video', icon: 'film', current: current === 'video', onSelect: () => onPick({ kind: 'video' }, 'entry-before'), ...(sum > 0 ? { value: total(sum) } : {}), testId: 'scenes-video' });
  if (setup.length > 0 || named.length > 0) {
    items.push({ key: 'before', label: `Before filming · ${hooksLine(setup.length, [])}`, quiet: true, current: current === 'before', onSelect: () => onPick({ kind: 'before' }, 'entry-before') });
  }
  let n = 0;
  for (const e of v.blocks.entries) {
    if (e.type === 'scene') {
      n++;
      const len = sceneLength(v, e.id);
      const s = v.scenes[e.id]?.captured_s;
      items.push({
        key: `scene-${e.index}`,
        lead: String(n),
        label: <Txt text={e.caption?.kicker ?? e.id} />,
        current: current === `scene:${e.id}`,
        onSelect: () => onPick({ kind: 'scene', id: e.id }, `entry-${e.index}`),
        ...(len ? { value: len } : {}),
        ...(s !== undefined && longest > 0 ? { bar: s / longest } : {}),
      });
    } else {
      const len = e.type !== 'unknown' && e.duration !== undefined ? `${e.duration} s` : undefined;
      items.push({
        key: `entry-${e.index}`,
        label: <Txt text={`${e.type === 'card' ? 'Card' : e.type === 'interstitial' ? 'Text' : 'Entry'} · ${entryTitle(e)}`} />,
        quiet: true,
        current: current === `entry:${e.index}`,
        onSelect: () => onPick({ kind: 'entry', index: e.index }, `entry-${e.index}`),
        ...(len ? { value: len } : {}),
      });
    }
  }
  if (teardown.length > 0) {
    items.push({ key: 'after', label: `After filming · ${plural(teardown.length, 'hook')}`, quiet: true, current: current === 'after', onSelect: () => onPick({ kind: 'after' }, 'entry-after') });
  }
  return <SourceList label="Scenes" groups={[{ key: 'scenes', heading: 'Scenes', label: 'Entries of the scenario', items }]} />;
}
