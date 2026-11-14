/**
 * L7.2 the props a render bundle takes (src/remotion/contract.ts): the Node side stamps a version, the root reads it
 * — no payload is fine (the root's own defaults), a payload with no version or another one is refused. Pure: no
 * browser, no bundle. The root reads every composition's input through these readers (pinned on its source), and the
 * refusal is shown where a render meets it: the `calculateMetadata` function of each composition the root registers,
 * called the way the library's composition selection calls it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { EDITOR_DIR } from '@retake/editor';
import type { EditPlan } from '@retake/editor';
import { COMPOSITIONS, PROPS_VERSION, previewProps, readPreviewProps, readVideoProps, videoProps } from '../src/remotion/contract.js';
import { createRoot } from '../src/remotion/Root.js';
import type { ComponentPreviewSpec } from '../src/remotion/preview-types.js';

const plan = { variant: 'landscape', durationInFrames: 3 } as unknown as EditPlan;
const spec = { frame: 2, durationInFrames: 3 } as unknown as ComponentPreviewSpec;

describe('L7.2 the versioned props of a render bundle', () => {
  it('the builders stamp the version and the readers give the payload back, the same object', () => {
    expect(PROPS_VERSION).toBe(1);
    expect(videoProps(plan)).toEqual({ v: PROPS_VERSION, plan });
    expect(previewProps(spec)).toEqual({ v: PROPS_VERSION, preview: spec });
    expect(readVideoProps(videoProps(plan))).toBe(plan);
    expect(readPreviewProps(previewProps(spec))).toBe(spec);
  });

  it("no payload is no refusal: the root's default props carry no version", () => {
    expect(readVideoProps({ plan: null })).toBeNull();
    expect(readPreviewProps({ preview: null })).toBeNull();
    expect(readVideoProps({})).toBeNull();
    // A version alone refuses nothing either: there is nothing to misread.
    expect(readVideoProps({ v: 99, plan: null })).toBeNull();
  });

  it('a payload with no version, another version or a version that is not a number is refused, saying what to do', () => {
    expect(() => readVideoProps({ plan })).toThrow(`render props version none does not match this bundle (${PROPS_VERSION}): rebuild the bundle`);
    expect(() => readPreviewProps({ preview: spec })).toThrow(`render props version none does not match this bundle (${PROPS_VERSION}): rebuild the bundle`);
    expect(() => readVideoProps({ v: PROPS_VERSION + 1, plan })).toThrow(`render props version ${PROPS_VERSION + 1} does not match this bundle (${PROPS_VERSION}): rebuild the bundle`);
    expect(() => readPreviewProps({ v: 0, preview: spec })).toThrow('render props version 0 does not match this bundle');
    expect(() => readVideoProps({ v: String(PROPS_VERSION), plan })).toThrow('render props version string does not match this bundle');
    // What is refused is never echoed: only a number or the type of what stood there.
    expect(() => readVideoProps({ v: '<b>x</b>', plan })).toThrow(/version string does/);
  });

  it('props that are not an object are refused', () => {
    for (const bad of [null, undefined, 'plan', 3]) {
      expect(() => readVideoProps(bad)).toThrow('render props must be an object ({ v, plan })');
      expect(() => readPreviewProps(bad)).toThrow('render props must be an object ({ v, preview })');
    }
  });

  /** What the root registers, read off its element tree (the root uses no hook: it is called, not mounted). */
  type Registered = { id: string; defaultProps: Record<string, unknown>; calculateMetadata: (o: { props: unknown }) => unknown };
  const registered = (): Registered[] => {
    const Root = createRoot({ components: {}, scaffolds: {} }) as () => ReactElement<{ children: ReactElement<Registered>[] }>;
    return Root().props.children.map((c) => c.props);
  };

  it("the root's calculateMetadata refuses a payload of another version with the clear message, on every composition", () => {
    const comps = registered();
    expect(comps.map((c) => c.id).sort()).toEqual(Object.values(COMPOSITIONS).sort());
    const refusal = (got: string): string => `render props version ${got} does not match this bundle (${PROPS_VERSION}): rebuild the bundle`;
    for (const c of comps) {
      const key = c.id === COMPOSITIONS.preview ? 'preview' : 'plan';
      const body = c.id === COMPOSITIONS.preview ? spec : plan;
      expect(() => c.calculateMetadata({ props: { v: PROPS_VERSION + 1, [key]: body } }), c.id).toThrow(refusal(String(PROPS_VERSION + 1)));
      expect(() => c.calculateMetadata({ props: { [key]: body } }), c.id).toThrow(refusal('none'));
    }
  });

  it("the root's own default props pass calculateMetadata untouched, and props of this version size the composition", () => {
    const comps = registered();
    for (const c of comps) expect(c.calculateMetadata({ props: c.defaultProps }), c.id).toEqual({});
    const sized = { variant: 'landscape', durationInFrames: 3, fps: 30, width: 1920, height: 1080 } as unknown as EditPlan;
    const video = comps.find((c) => c.id === COMPOSITIONS.landscape)!;
    expect(video.calculateMetadata({ props: videoProps(sized) })).toEqual({ durationInFrames: 3, fps: 30, width: 1920, height: 1080 });
    // The version is checked before the variant: a wrong-version payload never reaches the plan's fields.
    const vertical = comps.find((c) => c.id === COMPOSITIONS.vertical)!;
    expect(() => vertical.calculateMetadata({ props: videoProps(sized) })).toThrow('DemoVertical renders vertical plans; this plan is landscape (use DemoVideo)');
    expect(() => vertical.calculateMetadata({ props: { v: 0, plan: sized } })).toThrow('render props version 0 does not match this bundle');
    const preview = comps.find((c) => c.id === COMPOSITIONS.preview)!;
    const previewSpec = { durationInFrames: 0, fps: 25, width: 640, height: 360 } as unknown as ComponentPreviewSpec;
    expect(preview.calculateMetadata({ props: previewProps(previewSpec) })).toEqual({ durationInFrames: 1, fps: 25, width: 640, height: 360 });
  });

  it('the root reads every composition through the readers, and its defaults carry no version; the Node side builds props with the builders only', () => {
    // L7.34 (finding C4): the root held by what it registers instead of its statements. Its defaults are the readers'
    // "no payload" (no version); a payload of this version is read back through the reader by every composition (the
    // refusals of another version are the cases above), and one under a key the reader does not read sizes nothing.
    const comps = registered();
    for (const c of comps) expect(c.defaultProps, c.id).toEqual(c.id === COMPOSITIONS.preview ? { preview: null } : { plan: null });
    expect(comps.filter((c) => 'v' in c.defaultProps).map((c) => c.id)).toEqual([]);
    const sized = (variant: string) => ({ variant, durationInFrames: 0, fps: 24, width: 720, height: 1280 }) as unknown as EditPlan;
    for (const variant of ['landscape', 'vertical', 'square'] as const) {
      const c = comps.find((x) => x.id === COMPOSITIONS[variant])!;
      expect(c.calculateMetadata({ props: videoProps(sized(variant)) }), variant).toEqual({ durationInFrames: 1, fps: 24, width: 720, height: 1280 });
      expect(c.calculateMetadata({ props: { v: PROPS_VERSION, preview: sized(variant) } }), variant).toEqual({});
    }
    const preview = comps.find((c) => c.id === COMPOSITIONS.preview)!;
    expect(preview.calculateMetadata({ props: { v: PROPS_VERSION, plan: sized('landscape') } })).toEqual({});
    // The Node side: the props handed to the bundle are built by the builders, never written out (kept as a lint of
    // the two render modules: what they hand reaches the bundle's browser only — render-real.test renders through it).
    const src = (rel: string) => readFileSync(join(EDITOR_DIR, 'src', rel), 'utf8');
    for (const rel of ['render/render.ts', 'render/preview.ts']) {
      const s = src(rel);
      expect(s, rel).not.toMatch(/inputProps(:| =) \{/);
      expect(s, rel).toMatch(/inputProps(: previewProps\(spec\)| = videoProps\(session\.served\))/);
    }
  });
});
