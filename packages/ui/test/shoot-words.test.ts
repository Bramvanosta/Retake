/**
 * L5.11a: Shoot's pure parts — the status bar's blocker words keyed on the gate that refused (critique H3: one case per
 * kind, an unknown kind's honest fallback; a planted swap of two kinds fails here), every state of the status bar with
 * a shape AND a word (M15), the mode's names, and the command bus's ownership by priority (critique H1: never by the
 * order the registrations came in — a fresh load registers the screen's handler BEFORE the status bar's defaults).
 */
import { describe, expect, it } from 'vitest';
import { MARK_STATES } from '../src/app/ui-kit/index.js';
import { REHEARSE_MAPPING, SHOOT_STATES, blockerShort, modeWord, shootState } from '../src/app/words/shoot-words.js';
import type { ShootState } from '../src/app/words/shoot-words.js';
import { PRIORITY, ownerOf, registerShellCommand, runShellCommand } from '../src/app/shell/command-bus.js';

describe('blocker words by kind (critique H3)', () => {
  it('⚑ each gate its own words and action: hooks to approve (counted), a protected location, agent trust, refused hooks, a read-only location, the file, and an honest fallback', () => {
    const fix = 'retake run p quote';
    expect(blockerShort({ kind: 'needs_approval', count: 1, fix })).toEqual({ words: '1 hook to approve', action: 'copy' });
    expect(blockerShort({ kind: 'needs_approval', count: 3, fix })).toEqual({ words: '3 hooks to approve', action: 'copy' });
    expect(blockerShort({ kind: 'needs_approval', fix })).toEqual({ words: 'hooks to approve', action: 'copy' });
    expect(blockerShort({ kind: 'too_long', count: 2, fix })).toEqual({ words: '2 hooks too long to approve here', action: 'copy' });
    expect(blockerShort({ kind: 'protected_host', fix })).toEqual({ words: 'protected location', action: 'copy' });
    expect(blockerShort({ kind: 'agent_trust', fix })).toEqual({ words: 'uses a secret or an outside file', action: 'copy' });
    expect(blockerShort({ kind: 'opens_other_site', fix })).toEqual({ words: 'opens another site · add it to project.yaml', action: 'copy' });
    expect(blockerShort({ kind: 'hook_refused', count: 2, fix })).toEqual({ words: '2 hooks refused', action: 'copy' });
    expect(blockerShort({ kind: 'read_only', count: 1, fix })).toEqual({ words: 'read-only location refuses its hooks', action: 'copy' });
    expect(blockerShort({ kind: 'invalid', fix_file: true })).toEqual({ words: 'the file has errors', action: 'yaml' });
    expect(blockerShort({ kind: 'invalid', fix })).toEqual({ words: 'does not check', action: 'copy' });
    expect(blockerShort({ kind: 'prepare', fix })).toEqual({ words: 'needs the terminal', action: 'copy' });
    // An unknown kind (an older or newer engine) never borrows another gate's reason.
    expect(blockerShort({ kind: 'something_new' as 'prepare' })).toEqual({ words: 'needs the terminal', action: null });
    expect(blockerShort({})).toEqual({ words: 'needs the terminal', action: null });
    // A safety reason is never said for another gate (the review's worry: "protected location" for a secret).
    const words = (['agent_trust', 'opens_other_site', 'protected_host', 'hook_refused', 'read_only', 'needs_approval'] as const).map((kind) => blockerShort({ kind, count: 1, fix }).words);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('the status bar\'s states (M15)', () => {
  it('⚑ every state has a shape of the kit and a word that says it', () => {
    const states = Object.keys(SHOOT_STATES) as ShootState[];
    expect(states.sort()).toEqual(['cancelled', 'failed', 'idle', 'interrupted', 'paused', 'queued', 'running', 'stopping', 'succeeded', 'unknown']);
    for (const st of states) {
      expect(MARK_STATES, st).toContain(SHOOT_STATES[st].mark);
      for (const mode of ['dry', 'capture']) expect(SHOOT_STATES[st].word(mode).length, `${st} ${mode}`).toBeGreaterThan(3);
    }
    expect(SHOOT_STATES.running.word('dry')).toBe('Rehearsing');
    expect(SHOOT_STATES.running.word('capture')).toBe('Capturing');
    expect(SHOOT_STATES.paused.word('dry')).toBe('Rehearsal paused');
    expect(SHOOT_STATES.succeeded.word('capture')).toBe('Last take succeeded');
  });

  it('a run\'s state: queued, running, paused, stopping, finished by its status, anything else unknown', () => {
    expect(shootState(null)).toBe('idle');
    expect(shootState({ status: 'queued' })).toBe('queued');
    expect(shootState({ status: 'queued', stopping: true })).toBe('stopping');
    expect(shootState({ status: 'running' })).toBe('running');
    expect(shootState({ status: 'running', paused: true })).toBe('paused');
    expect(shootState({ status: 'running', paused: true, stopping: true })).toBe('stopping');
    for (const s of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) expect(shootState({ status: s })).toBe(s);
    expect(shootState({ status: '<b>x</b>' })).toBe('unknown');
  });

  it('the mode\'s names: Rehearsal / Capture; the one mapping line names the terminal\'s flag', () => {
    expect([modeWord('dry'), modeWord('capture'), modeWord('dry', true)]).toEqual(['Rehearsal', 'Capture', 'rehearsal']);
    expect(REHEARSE_MAPPING).toContain('--dry');
    expect(REHEARSE_MAPPING).toContain('run_dry');
  });
});

describe('⚑ the command bus (critique H1)', () => {
  it('the owner is the highest priority whatever the order of registration; a tie goes to the latest; one owner acts', () => {
    const calls: string[] = [];
    const h = (name: string) => ({ current: () => void calls.push(name) });
    // A fresh load: the screen's handler (a child) registers BEFORE the status bar's defaults.
    const screen = registerShellCommand('stop', h('live screen'), PRIORITY.screen);
    const defaults = registerShellCommand('stop', h('defaults'), PRIORITY.defaults);
    expect(ownerOf('stop')).toEqual({ priority: PRIORITY.screen });
    expect(runShellCommand('stop')).toBe(true);
    expect(calls).toEqual(['live screen']);
    // A live recording outranks both.
    const rec = registerShellCommand('stop', h('recording'), PRIORITY.recording);
    runShellCommand('stop');
    expect(calls).toEqual(['live screen', 'recording']);
    rec();
    screen();
    runShellCommand('stop');
    expect(calls).toEqual(['live screen', 'recording', 'defaults']);
    // Equal priorities: the latest.
    const a = registerShellCommand('render', h('a'), PRIORITY.screen);
    const b = registerShellCommand('render', h('b'), PRIORITY.screen);
    runShellCommand('render');
    expect(calls.at(-1)).toBe('b');
    a();
    b();
    defaults();
    expect(runShellCommand('stop')).toBe(false);
    expect(ownerOf('render')).toBeNull();
  });
});
