/**
 * A device's capture through the planner (timeline `capture.device`: an iOS simulator's 402×874 pt at 3): the output
 * stays at the design size (scale 1 unless the render asks), the default frame becomes a phone whose display the
 * capture fills (`status_bar: false`) — an older run without its video block too —, an explicit frame or status bar is
 * kept, a desktop window frame is a warning.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import type { LoadedProject, LoadedTemplate, Timeline } from '@retake/core';
import { planEdit } from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '../src/plan-entry.js';
import { REPO } from '@retake/test-support/repo';
import { deviceTimeline, fixtureProject, template } from '@retake/test-support/timeline';

let registry: ComponentRegistry;
let project: LoadedProject;
let editorial: LoadedTemplate;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  project = await fixtureProject();
  editorial = await template('editorial');
});

function plan(timeline: Timeline, overrides?: EditOverrides): EditPlan {
  return planEdit({ timeline, template: editorial, project, registry, captureFile: '/captures/capture.mp4', ...(overrides ? { overrides } : {}) });
}

const clip = (p: EditPlan) => p.segments.find((s): s is ClipSegment => s.kind === 'clip')!;

describe('a device capture through the planner', () => {
  it('keeps the design size (scale 1), its source at 1206×2622, framed as a phone filled by the capture', () => {
    const p = plan(deviceTimeline());
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(p.source).toMatchObject({ width: 1206, height: 2622, cssWidth: 402, cssHeight: 874, scale: 3 });
    expect(p.frame).toBe('phone');
    expect(clip(p).component.id).toBe('studio/layout-phone');
    expect(clip(p).component.params.status_bar).toBe(false);
    expect(p.notes.join('\n')).toContain('a device capture (iPhone 17 Pro): framed as a phone');
    expect(p.warnings).toEqual([]);
  });

  it('the render may ask for another scale; a browser capture keeps its own scale as before', () => {
    expect(plan(deviceTimeline(), { scale: 2 }).width).toBe(3840);
    const browser = plan(deviceTimeline({ device: false }));
    expect(browser.width).toBe(5760);
    expect(browser.frame).toBe('card');
  });

  it('an explicit frame is kept: phone with its status bar given, raw, a desktop window with a warning', () => {
    const own = plan(deviceTimeline(), { components: { layout: { id: 'studio/layout-phone', params: { status_bar: true } } } });
    expect(clip(own).component.params.status_bar).toBe(true);
    expect(plan(deviceTimeline({ frame: 'raw' })).frame).toBe('raw');
    const browser = plan(deviceTimeline({ frame: 'browser' }));
    expect(browser.frame).toBe('browser');
    expect(browser.warnings.join('\n')).toContain('a device capture (iPhone 17 Pro) framed by studio/layout-browser, a desktop window: use `frame: phone`');
    expect(plan(deviceTimeline(), { frame: 'laptop' }).warnings.join('\n')).toContain('framed by studio/layout-laptop');
  });

  it('a written `frame: card` stays a card (only the default becomes a phone); --frame card too, with no phone note', () => {
    const card = plan(deviceTimeline({ frame: 'card' }));
    expect(card.frame).toBe('card');
    expect(card.notes.join('\n')).not.toContain('framed as a phone');
    const given = plan(deviceTimeline(), { frame: 'card' });
    expect(given.frame).toBe('card');
    expect(given.notes.join('\n')).not.toContain('framed as a phone');
    expect(plan(deviceTimeline()).notes.join('\n')).toContain('`frame: card` in the scenario, or --frame card, keeps the card');
  });

  it('an older run without its video block: the project writing no frame, the device capture is still framed as a phone', () => {
    const { video: _video, ...older } = deviceTimeline();
    const unframed = { ...project, config: { ...project.config, frame: 'card' as const, frame_defaulted: true as const } };
    const p = planEdit({ timeline: older as Timeline, template: editorial, project: unframed, registry, captureFile: '/captures/capture.mp4' });
    expect(p.frame).toBe('phone');
    expect(p.notes.join('\n')).toContain('framed as a phone');
    // The project writes one: kept.
    expect(plan(older as Timeline).frame).toBe(project.config.frame);
  });
});
