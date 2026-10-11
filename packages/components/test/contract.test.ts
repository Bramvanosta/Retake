import { describe, expect, it } from 'vitest';
import * as core from '@demo-studio/core';
import { COMPONENT_KINDS } from '@demo-studio/components';
import type { ComponentKind, ComponentManifest, ComponentRef } from '@demo-studio/components';

describe('@demo-studio/components contract', () => {
  it('re-exports the component kinds and references of @demo-studio/core (single source of truth)', () => {
    expect(COMPONENT_KINDS).toBe(core.COMPONENT_KINDS);
    expect([...COMPONENT_KINDS]).toEqual(['intro', 'outro', 'card', 'interstitial', 'caption', 'layout', 'overlay', 'transition']);
    // Types are the core ones: a core ComponentRef/ComponentKind is assignable both ways.
    const ref: ComponentRef = { id: 'studio/layout-card', params: { width: 1560 } } satisfies core.ComponentRef;
    const kind: core.ComponentKind = 'layout' satisfies ComponentKind;
    const manifest: Pick<ComponentManifest, 'id' | 'kind'> = { id: core.componentRefId(ref), kind };
    expect(core.COMPONENT_ID_RE.test(manifest.id)).toBe(true);
  });
});
