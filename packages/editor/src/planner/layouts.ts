/**
 * A step of `planEdit`: the layouts — the chain of candidates of a segment's layout (render overrides, the scenario's
 * frames, the theme, the built-in), a layout use's geometry in this variant, and the video's main layout.
 */
import type { FrameSpec } from '@retake/core/language';
import { DEFAULT_FRAME } from '@retake/core/project';
import { GEOMETRY_KEYS, evalLayoutGeometry } from '@retake/components/geometry';
import type { LayoutGeometry } from '@retake/components/geometry';
import { FALLBACK_GEOMETRY, RAW_GEOMETRY, geometryOutside, planLayout } from '../layout.js';
import type { PlanLayout, ResolvedComponent } from '../plan-types.js';
import type { Candidate } from '../resolve.js';
import type { PlanScope } from './scope.js';
import { errorMessage } from '@retake/core/base';

export interface PlanLayouts {
  /** The video's frame: the render override's, the scenario's, else the project's. */
  videoFrame: FrameSpec;
  layoutChain: (sceneFrame: FrameSpec | undefined, segmentId?: string) => Candidate[];
  layoutOf: (rc: ResolvedComponent | null, frameSpec: FrameSpec, where: string) => PlanLayout;
  mainLayoutComponent: ResolvedComponent | null;
  mainLayout: PlanLayout;
}

/** The phone layout: a device's capture fills its display (the device's own status bar is in the picture). */
const PHONE_LAYOUT = 'studio/layout-phone';
/** Layouts that frame a desktop browser: a device's capture in one is a warning. */
const BROWSER_LAYOUTS = ['studio/layout-browser', 'studio/layout-laptop'];

/**
 * A device's capture (timeline `capture.device`) framed as a phone: when no frame was written (the timeline's
 * `video.frame_default`: the scenario and the project write none, the default `card` applies) it becomes `phone` — a
 * frame written, even `card`, is kept —, and a phone layout without its own `status_bar` gets `status_bar: false` —
 * the device's status bar and island are in the picture.
 */
function deviceFrame(frame: FrameSpec, cap: PlanScope['cap'], defaulted: boolean): FrameSpec {
  if (!cap.device || !defaulted || frame !== DEFAULT_FRAME) return frame;
  return 'phone';
}

function deviceCandidate(c: Candidate, device: boolean): Candidate {
  if (!device || c.ref === null) return c;
  const ref = typeof c.ref === 'string' ? { id: c.ref } : c.ref;
  if (ref.id !== PHONE_LAYOUT || (ref.params && Object.hasOwn(ref.params, 'status_bar'))) return c;
  return { ...c, ref: { ...ref, params: { ...ref.params, status_bar: false } } };
}

/** The layout chain and geometry of every use, and the video layout resolved once. */
export function planLayouts(s: PlanScope): PlanLayouts {
  const { ov, video, project, resolver, segmentOverride, kindOverride, variant, cssW, cssH, unit, warnings } = s;
  const device = s.cap.device !== undefined;
  const written = video.frame ?? project.config.frame;
  const vf = deviceFrame(written, s.cap, video.frame_default === true);
  if (vf !== written && ov.frame === undefined) {
    s.notes.add(`a device capture (${s.cap.device!.name}): framed as a phone (no frame written — \`frame: card\` in the scenario, or --frame card, keeps the card)`);
  }
  const videoFrame: FrameSpec = ov.frame ?? vf;
  const layoutChain = (sceneFrame: FrameSpec | undefined, segmentId?: string): Candidate[] => {
    const chain: Candidate[] = [];
    if (segmentId) chain.push(...segmentOverride(segmentId, 'layout'));
    chain.push(...kindOverride('layout'));
    if (ov.frame !== undefined) chain.push(resolver.frameCandidate(ov.frame, 'override', 'overrides.frame'));
    if (sceneFrame !== undefined) chain.push(resolver.frameCandidate(sceneFrame, 'scenario', 'the scene frame'));
    chain.push(resolver.frameCandidate(vf, 'scenario', 'the scenario/project frame'));
    const theme = resolver.themeCandidate('layout');
    if (theme.ref !== null) chain.push(theme);
    chain.push(resolver.builtinCandidate('layout'));
    return chain.map((c) => deviceCandidate(c, device));
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
        warnings.add(`${where}: layout ${rc.id}: ${errorMessage(e)}: default geometry used`);
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
  if (device && mainLayoutComponent && BROWSER_LAYOUTS.includes(mainLayoutComponent.id)) {
    warnings.add(`a device capture (${s.cap.device!.name}) framed by ${mainLayoutComponent.id}, a desktop window: use \`frame: phone\` (or raw)`);
  }
  const mainLayout = layoutOf(mainLayoutComponent, videoFrame, 'video layout');
  return { videoFrame, layoutChain, layoutOf, mainLayoutComponent, mainLayout };
}
