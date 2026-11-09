/**
 * A step of `planEdit`: the layouts — the chain of candidates of a segment's layout (render overrides, the scenario's
 * frames, the theme, the built-in), a layout use's geometry in this variant, and the video's main layout.
 */
import type { FrameSpec } from '@retake/core';
import { GEOMETRY_KEYS, evalLayoutGeometry } from '@retake/components/geometry';
import type { LayoutGeometry } from '@retake/components/geometry';
import { FALLBACK_GEOMETRY, RAW_GEOMETRY, geometryOutside, planLayout } from '../layout.js';
import type { PlanLayout, ResolvedComponent } from '../plan-types.js';
import type { Candidate } from '../resolve.js';
import type { PlanScope } from './scope.js';

export interface PlanLayouts {
  /** The video's frame: the render override's, the scenario's, else the project's. */
  videoFrame: FrameSpec;
  layoutChain: (sceneFrame: FrameSpec | undefined, segmentId?: string) => Candidate[];
  layoutOf: (rc: ResolvedComponent | null, frameSpec: FrameSpec, where: string) => PlanLayout;
  mainLayoutComponent: ResolvedComponent | null;
  mainLayout: PlanLayout;
}

/** The layout chain and geometry of every use, and the video layout resolved once. */
export function planLayouts(s: PlanScope): PlanLayouts {
  const { ov, video, project, resolver, segmentOverride, kindOverride, variant, cssW, cssH, unit, warnings } = s;
  const videoFrame: FrameSpec = ov.frame ?? video.frame ?? project.config.frame;
  const layoutChain = (sceneFrame: FrameSpec | undefined, segmentId?: string): Candidate[] => {
    const chain: Candidate[] = [];
    if (segmentId) chain.push(...segmentOverride(segmentId, 'layout'));
    chain.push(...kindOverride('layout'));
    if (ov.frame !== undefined) chain.push(resolver.frameCandidate(ov.frame, 'override', 'overrides.frame'));
    if (sceneFrame !== undefined) chain.push(resolver.frameCandidate(sceneFrame, 'scenario', 'the scene frame'));
    const vf = video.frame ?? project.config.frame;
    chain.push(resolver.frameCandidate(vf, 'scenario', 'the scenario/project frame'));
    const theme = resolver.themeCandidate('layout');
    if (theme.ref !== null) chain.push(theme);
    chain.push(resolver.builtinCandidate('layout'));
    return chain;
  };
  const layoutOf = (rc: ResolvedComponent | null, frameSpec: FrameSpec, where: string): PlanLayout => {
    const manifest = resolver.manifest(rc);
    const geometryKey = GEOMETRY_KEYS[variant];
    const spec = manifest?.[geometryKey];
    const radius = typeof rc?.params.radius === 'number' ? rc.params.radius : undefined;
    if (spec && rc) {
      // The geometry follows the params of this use (and the capture aspect): e.g. a theme `width` moves the card and
      // the caption / brand mark rects with it.
      let geometry: LayoutGeometry | undefined;
      try {
        geometry = evalLayoutGeometry(spec, rc.params, { aspect: cssW / cssH });
      } catch (e) {
        warnings.add(`${where}: layout ${rc.id}: ${(e as Error).message}: default geometry used`);
      }
      if (geometry) {
        const outside = geometryOutside(geometry, variant);
        if (outside.length > 0) warnings.add(`${where}: layout ${rc.id} with ${JSON.stringify(rc.params)}: ${outside.join(', ')} leave${outside.length === 1 ? 's' : ''} the frame`);
        return planLayout(geometry, { variant, unit, cssWidth: cssW, cssHeight: cssH, radius: geometry.radius ?? radius });
      }
    }
    const raw = frameSpec === 'raw' || rc?.id.endsWith('layout-raw');
    if (rc && !rc.missing) warnings.add(`${where}: layout ${rc.id} declares no ${GEOMETRY_KEYS[variant]}: default geometry used`);
    return planLayout((raw ? RAW_GEOMETRY : FALLBACK_GEOMETRY)[variant], { variant, unit, cssWidth: cssW, cssHeight: cssH, radius, fallback: true });
  };
  const mainLayoutComponent = resolver.resolve('layout', layoutChain(undefined), 'video layout') ?? null;
  const mainLayout = layoutOf(mainLayoutComponent, videoFrame, 'video layout');
  return { videoFrame, layoutChain, layoutOf, mainLayoutComponent, mainLayout };
}
