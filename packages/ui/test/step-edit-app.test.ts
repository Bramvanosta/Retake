/**
 * L4.3 part 2, the app's pure step-edit logic (step-edit.ts): where Alt+↑/↓ and a drop move a step, the words of an
 * edit, the undo / redo history (caps, the versions this screen made), what counts as a field for the shortcuts.
 */
import { describe, expect, it } from 'vitest';
import { EditHistory, HISTORY_MAX_CHARS, HISTORY_MAX_ENTRIES, dropMove, editWords, inField, keyboardMove } from '../src/app/step-edit.js';
import type { HistoryEntry } from '../src/app/step-edit.js';

const scenes = [
  { id: 'a', count: 2, locked: false },
  { id: 'flow', count: 2, locked: true },
  { id: 'b', count: 0, locked: false },
  { id: 'c', count: 3, locked: false },
];

describe('keyboardMove', () => {
  it('one place within the scene; past its edge to the end / start of the next scene that takes steps (locked ones skipped); none past the ends', () => {
    expect(keyboardMove(scenes, { scene: 'a', index: 0 }, 1)).toEqual({ scene: 'a', index: 1 });
    expect(keyboardMove(scenes, { scene: 'a', index: 1 }, 1)).toEqual({ scene: 'b', index: 0 });
    expect(keyboardMove(scenes, { scene: 'c', index: 0 }, -1)).toEqual({ scene: 'b', index: 0 });
    expect(keyboardMove([scenes[0], scenes[3]], { scene: 'c', index: 0 }, -1)).toEqual({ scene: 'a', index: 2 });
    expect(keyboardMove(scenes, { scene: 'a', index: 0 }, -1)).toBeNull();
    expect(keyboardMove(scenes, { scene: 'c', index: 2 }, 1)).toBeNull();
    expect(keyboardMove(scenes, { scene: 'flow', index: 0 }, 1)).toBeNull();
    expect(keyboardMove(scenes, { scene: 'zz', index: 0 }, 1)).toBeNull();
  });
});

describe('dropMove', () => {
  it('a gap in its own scene counted without the step (no move when it lands where it is); another scene takes the gap as the index', () => {
    expect(dropMove({ scene: 'a', index: 1 }, { scene: 'a', index: 0 })).toEqual({ scene: 'a', index: 0 });
    expect(dropMove({ scene: 'a', index: 0 }, { scene: 'a', index: 2 })).toEqual({ scene: 'a', index: 1 });
    expect(dropMove({ scene: 'a', index: 0 }, { scene: 'a', index: 0 })).toBeNull();
    expect(dropMove({ scene: 'a', index: 0 }, { scene: 'a', index: 1 })).toBeNull();
    expect(dropMove({ scene: 'a', index: 0 }, { scene: 'b', index: 0 })).toEqual({ scene: 'b', index: 0 });
  });
});

describe('editWords', () => {
  it('names the edit before it is made, 1-based', () => {
    const at = { scene: 'a', index: 2, guard: '0'.repeat(16) };
    expect(editWords({ kind: 'move_step', from: at, to: { scene: 'a', index: 0 } })).toBe('Move step 3 of a to position 1');
    expect(editWords({ kind: 'move_step', from: at, to: { scene: 'b', index: 1 } })).toBe('Move step 3 of a to position 2 of b');
    expect(editWords({ kind: 'delete_step', at })).toBe('Delete step 3 of a');
    expect(editWords({ kind: 'duplicate_step', at })).toBe('Duplicate step 3 of a');
  });
});

describe('EditHistory', () => {
  const entry = (n: number, size = 1): HistoryEntry => ({ label: `edit ${n}`, before: 'x'.repeat(size), hashBefore: `h${n}`, after: null, hashAfter: `h${n + 1}` });

  it('push / undone / redone move entries between the stacks; a new edit empties redo; the versions made are known', () => {
    const h = new EditHistory();
    h.know('h0');
    h.push(entry(0));
    h.push(entry(1));
    expect(h.knows('h2')).toBe(true);
    expect(h.knows('zz')).toBe(false);
    h.undone('after-1');
    expect(h.undo.map((e) => e.label)).toEqual(['edit 0']);
    expect(h.redo).toEqual([{ ...entry(1), after: 'after-1' }]);
    h.redone();
    expect(h.undo.map((e) => e.label)).toEqual(['edit 0', 'edit 1']);
    h.undone('after-1');
    h.push(entry(5));
    expect(h.redo).toEqual([]);
    h.clear();
    expect(h.size).toBe(0);
  });

  it(`keeps at most ${HISTORY_MAX_ENTRIES} entries and ${HISTORY_MAX_CHARS / 1024 / 1024} MiB of text, dropping the oldest`, () => {
    const h = new EditHistory();
    for (let n = 0; n < HISTORY_MAX_ENTRIES + 7; n++) h.push(entry(n));
    expect(h.undo).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(h.undo[0].label).toBe('edit 7');
    const big = new EditHistory();
    for (let n = 0; n < 5; n++) big.push(entry(n, 5 * 1024 * 1024));
    expect(big.undo.map((e) => e.label)).toEqual(['edit 2', 'edit 3', 'edit 4']);
  });
});

describe('inField', () => {
  it('inputs, text areas, selects and editable content are fields; the rest is not', () => {
    expect(inField({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(inField({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(inField({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(inField({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(inField({ tagName: 'UL' } as unknown as EventTarget)).toBe(false);
    expect(inField(null)).toBe(false);
  });
});
