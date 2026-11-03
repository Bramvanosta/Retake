import { describe, expect, it } from 'vitest';
import {
  ACTION_NAMES,
  StepError,
  describeTarget,
  listSteps,
  looksLikeCss,
  normalizeStep,
  normalizeTarget,
  parseScenario,
  resolveStepRef,
} from '@retake/core';
import type { ActionName, Scenario, Step } from '@retake/core';
import { SPEC_EXAMPLE } from './helpers.js';

describe('normalizeStep shorthands', () => {
  const cases: Array<[Step, ActionName, unknown]> = [
    [{ open: '/imports' }, 'open', { url: '/imports' }],
    [{ open: { url: '/x', page: 'shop' } }, 'open', { url: '/x', page: 'shop' }],
    [{ click: 'New import' }, 'click', { text: 'New import' }],
    [{ click: '#save' }, 'click', { css: '#save' }],
    [{ click: { text: 'Save', in: 'dialog' } }, 'click', { text: 'Save', in: 'dialog' }],
    [{ double_click: '.row > td' }, 'double_click', { css: '.row > td' }],
    [{ hover: 'Start import' }, 'hover', { text: 'Start import' }],
    [{ hover: { text: 'Start', ms: 400 } }, 'hover', { text: 'Start', ms: 400 }],
    [{ type: { text: 'Finca', cps: 10 } }, 'type', { text: 'Finca', cps: 10 }],
    [{ type: 'hello' } as unknown as Step, 'type', { text: 'hello' }],
    [{ press: 'Enter' }, 'press', { key: 'Enter' }],
    [{ press: { key: 'Tab', times: 2 } }, 'press', { key: 'Tab', times: 2 }],
    [{ select: { combobox: '#org', option: 'A' } }, 'select', { combobox: '#org', option: 'A' }],
    [{ pick: { field: 'Bag sizes', option: '1 kg' } }, 'pick', { field: 'Bag sizes', option: '1 kg' }],
    [{ menu: { row: 'Iceland', item: 'Pause' } }, 'menu', { row: 'Iceland', item: 'Pause' }],
    [{ date: '14 March 2027' }, 'date', { day: '14 March 2027' }],
    [{ date: { field: 'Delivery window', day: ['10 January 2027', '24 January 2027'], close: 'none' } }, 'date', { field: 'Delivery window', day: ['10 January 2027', '24 January 2027'], close: 'none' }],
    [{ scroll: 560 }, 'scroll', { to: 560 }],
    [{ scroll: 'bottom' } as unknown as Step, 'scroll', { to: 'bottom' }],
    [{ scroll: 'Awards' } as unknown as Step, 'scroll', { to: { text: 'Awards' } }],
    [{ scroll: { by: 300 } }, 'scroll', { by: 300 }],
    [{ drag: { from: 'A', to: { x: 1, y: 2 } } }, 'drag', { from: 'A', to: { x: 1, y: 2 } }],
    [{ drop_file: { zone: 'Drop', name: 'a.xlsx', fake: true } }, 'drop_file', { zone: 'Drop', name: 'a.xlsx', fake: true }],
    [{ wait: 1.5 }, 'wait', { seconds: 1.5 }],
    [{ wait_for: 'Ready' }, 'wait_for', { text: 'Ready' }],
    [{ wait_for: { not_text: 'Loading', timeout: 30 } }, 'wait_for', { not_text: 'Loading', timeout: 30 }],
    [{ hold: 2 }, 'hold', { seconds: 2 }],
    [{ assert: 'Saved' }, 'assert', { text: 'Saved' }],
    [{ screenshot: 'after-save' }, 'screenshot', { name: 'after-save' }],
    [{ new_tab: '/quotes/1.pdf' }, 'new_tab', { href: '/quotes/1.pdf' }],
    [{ new_tab: 'https://example.com/x' }, 'new_tab', { href: 'https://example.com/x' }],
    [{ new_tab: 'Download quote PDF' }, 'new_tab', { target: { text: 'Download quote PDF' } }],
    [{ new_tab: { text: 'Download' } }, 'new_tab', { target: { text: 'Download' } }],
    [{ new_tab: { target: 'Download', as: 'pdf' } }, 'new_tab', { target: 'Download', as: 'pdf' }],
    [{ switch_page: 'shop' }, 'switch_page', { to: 'shop' }],
    [{ eval: 'return 1' }, 'eval', { js: 'return 1' }],
    [{ notify: 'Quote received' }, 'notify', { message: 'Quote received' }],
    [{ emit: 'checkpoint' }, 'emit', { name: 'checkpoint' }],
    [{ cursor: 'hide' }, 'cursor', { mode: 'hide' }],
    [{ cursor: { move: { x: 10, y: 20 }, duration: 1 } }, 'cursor', { mode: 'move', to: { x: 10, y: 20 }, duration: 1 }],
    [{ cursor: { move: 'Save' } }, 'cursor', { mode: 'move', to: { text: 'Save' } }],
    [{ cursor: { set: { x: 0, y: 0 } } }, 'cursor', { mode: 'set', to: { x: 0, y: 0 } }],
    [{ cursor: { show: false } }, 'cursor', { mode: 'hide' }],
    [{ wait_for_email: { to: 'buyer@', subject: 'Confirm', as: 'welcome' } }, 'wait_for_email', { to: 'buyer@', subject: 'Confirm', as: 'welcome' }],
    [{ download: { click: 'Download quote PDF', as: 'quote' } }, 'download', { click: { text: 'Download quote PDF' }, as: 'quote' }],
    [{ capture_text: { target: { testid: 'total' }, as: 'total', pattern: '[\\d.,]+' } }, 'capture_text', { target: { testid: 'total' }, as: 'total', pattern: '[\\d.,]+' }],
    [{ hook: 'mark-paid' }, 'hook', { name: 'mark-paid' }],
    [{ hook: { name: 'mark-paid' } }, 'hook', { name: 'mark-paid' }],
  ];

  it.each(cases)('%j', (step, action, args) => {
    const n = normalizeStep(step, 3);
    expect(n.action).toBe(action);
    expect(n.args).toEqual(args);
    expect(n.index).toBe(3);
    expect(n.raw).toBe(step);
  });

  it('covers every action', () => {
    expect(new Set(cases.map((c) => c[1]))).toEqual(new Set(ACTION_NAMES));
  });

  it('keeps the common modifiers', () => {
    const n = normalizeStep({ click: 'Save', id: 'save', hold: 1.2, mark: 'saved', speed: 1.5, camera: { zoom: 1.2 }, park: true }, 0);
    expect(n).toMatchObject({ action: 'click', id: 'save', hold: 1.2, mark: 'saved', speed: 1.5, camera: { zoom: 1.2 }, park: true });
  });

  it('a hold action is not also a hold modifier', () => {
    const n = normalizeStep({ hold: 2 }, 0);
    expect(n.args).toEqual({ seconds: 2 });
    expect(n.hold).toBeUndefined();
  });

  it('rejects zero or several actions', () => {
    expect(() => normalizeStep({ id: 'x' } as Step, 0)).toThrow(StepError);
    expect(() => normalizeStep({ click: 'a', hover: 'b' }, 1)).toThrow(/several actions \(click, hover\)/);
  });
});

describe('targets', () => {
  it('string targets: visible text unless it looks like CSS', () => {
    expect(normalizeTarget('Save')).toEqual({ text: 'Save' });
    for (const css of ['#import-organization', '.btn-primary', '[data-x="1"]', 'li.active', 'button:hover', 'form > button']) {
      expect(looksLikeCss(css), css).toBe(true);
    }
    for (const text of ['Table', 'Status: active', 'Node.js', '#1 seller', 'Save', 'A few hours later']) {
      expect(looksLikeCss(text), text).toBe(false);
    }
  });

  it('describeTarget', () => {
    expect(describeTarget({ text: 'Save', in: 'dialog' })).toBe('text="Save" in dialog');
    expect(describeTarget({ role: 'button', name: 'OK', nth: 2 })).toBe('role=button name="OK" nth=2');
    expect(describeTarget({ contains: ['Finca', '2026'], in: { row: 'Iceland' } })).toBe('contains=["Finca", "2026"] in row "Iceland"');
    expect(describeTarget({ x: 3, y: 4 })).toBe('point(3,4)');
  });
});

describe('step refs', () => {
  const { scenario } = parseScenario(SPEC_EXAMPLE);
  const s = scenario as Scenario;
  const withIds: Scenario = {
    video: 'x',
    scenes: [
      { id: 'a', open: '/', steps: [{ click: 'A', id: 'first' }, { hold: 1 }] },
      { interstitial: { text: 'Later' } },
      { id: 'b', steps: [{ click: 'B', id: 'dup' }, { click: 'C', id: 'dup' }, { hold: 1, id: 'last' }] },
    ],
  };

  it('listSteps refs use step ids or indexes and skip interstitials', () => {
    expect(listSteps(withIds).map((l) => l.ref)).toEqual(['a.first', 'a.1', 'b.dup', 'b.dup', 'b.last']);
    expect(listSteps(s)).toHaveLength(6 + 8 + 6);
  });

  it('resolveStepRef forms', () => {
    expect(resolveStepRef(withIds, 'a.first')).toEqual({ sceneIndex: 0, stepIndex: 0 });
    expect(resolveStepRef(withIds, 'a.1')).toEqual({ sceneIndex: 0, stepIndex: 1 });
    expect(resolveStepRef(withIds, 'first')).toEqual({ sceneIndex: 0, stepIndex: 0 });
    expect(resolveStepRef(withIds, 'last')).toEqual({ sceneIndex: 2, stepIndex: 2 });
    expect(resolveStepRef(withIds, 'b')).toEqual({ sceneIndex: 2, stepIndex: 2 });
    expect(resolveStepRef(s, 'availability')).toEqual({ sceneIndex: 1, stepIndex: 7 });
    expect(resolveStepRef(s, 'add-product.3')).toEqual({ sceneIndex: 2, stepIndex: 3 });
  });

  it('resolveStepRef returns null for unknown or ambiguous refs', () => {
    expect(resolveStepRef(withIds, 'dup')).toBeNull();
    expect(resolveStepRef(withIds, 'a.9')).toBeNull();
    expect(resolveStepRef(withIds, 'a.nope')).toBeNull();
    expect(resolveStepRef(withIds, 'nope')).toBeNull();
  });
});
