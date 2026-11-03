import { describe, expect, it } from 'vitest';
import { SLOT_SOURCES, fillSlots, parseManifest, slotSource } from '@retake/components';
import type { SlotContext } from '@retake/components';
import { DARK, LIGHT } from './helpers.js';

const MANIFEST = parseManifest(`id: acme/outro
version: 1.0.0
kind: outro
name: Outro
description: Outro.
slots:
  tagline: {type: text, required: true, default_from: scenario.outro.tagline, max_chars: 20}
  url: {type: url, default_from: theme.brand.url}
  logo: {type: image, default_from: theme.logo}
  name: {type: text, default_from: theme.brand.name}
preview:
  slots: {tagline: Ready.}
`).manifest!;

const CTX: SlotContext = {
  theme: DARK,
  templateOutro: { tagline: 'Theme tagline', url: 'theme.example' },
  scenario: { title: { text: 'Video title', kicker: 'Kicker' }, outro: { tagline: 'Scenario tagline', url: 'scenario.example' } },
  scene: { caption: { text: 'Caption line', kicker: 'Caption kicker' } },
  interstitial: { text: 'Later', kicker: 'Meanwhile' },
};

describe('fillSlots (R-CMP-10)', () => {
  it('given values win, then each slot default_from source', () => {
    const r = fillSlots(MANIFEST, { url: 'given.example' }, CTX);
    expect(r.slots).toEqual({ tagline: 'Scenario tagline', url: 'given.example', logo: 'http://assets.local/logo.svg', name: 'Pulse' });
    expect(r.from).toEqual({ tagline: 'scenario.outro.tagline', url: 'given', logo: 'theme.logo', name: 'theme.brand.name' });
    expect(r.missing).toEqual([]);
    expect(r.tooLong).toEqual([]);
  });

  it('reports missing required slots, too long texts and unknown given slots', () => {
    const r = fillSlots(MANIFEST, { tagline: 'A tagline that is far too long', titel: 'x' }, { theme: LIGHT });
    expect(r.tooLong).toEqual([{ slot: 'tagline', length: 30, max: 20 }]);
    expect(r.unknown).toEqual(['titel']);
    expect(r.slots.logo).toBeUndefined();
    const empty = fillSlots(MANIFEST, {}, { theme: LIGHT, scenario: { outro: false } });
    expect(empty.missing).toEqual(['tagline']);
  });

  it('every known source reads from its context', () => {
    const expected: Record<string, string | undefined> = {
      'theme.logo': 'http://assets.local/logo.svg',
      'theme.wordmark': 'http://assets.local/wordmark.svg',
      'theme.brand.name': 'Pulse',
      'theme.brand.url': 'example.org',
      'theme.outro.tagline': 'Theme tagline',
      'theme.outro.url': 'theme.example',
      'scenario.title.text': 'Video title',
      'scenario.title.kicker': 'Kicker',
      'scenario.outro.tagline': 'Scenario tagline',
      'scenario.outro.url': 'scenario.example',
      'scene.caption.text': 'Caption line',
      'scene.caption.kicker': 'Caption kicker',
      'interstitial.text': 'Later',
      'interstitial.kicker': 'Meanwhile',
    };
    expect(Object.keys(expected).sort()).toEqual([...SLOT_SOURCES].sort());
    for (const source of SLOT_SOURCES) expect(slotSource(source, CTX), source).toBe(expected[source]);
    expect(slotSource('theme.wordmark', { theme: LIGHT })).toBe('Atelier');
    expect(slotSource('scene.caption.text', { scene: { caption: 'Plain caption' } })).toBe('Plain caption');
    expect(slotSource('nowhere.x', CTX)).toBeUndefined();
  });
});
