/**
 * Steps of `planEdit`: how components are resolved (the resolver over the registry and the theme, the candidates of a
 * render override, the slot context) and the tutorial overlays' switches (L2.10: scenario → scene → step, the render
 * override over the scenario's).
 */
import { TUTORIAL_COMPONENTS } from '@retake/core/model';
import type { ComponentKind } from '@retake/core/model';
import type { SlotContext } from '@retake/components/geometry';
import type { PlanTutorial } from '../plan-types.js';
import { ComponentResolver } from '../resolve.js';
import type { Candidate } from '../resolve.js';
import { tutorialRequested, tutorialStateOf } from '../tutorial.js';
import type { TutorialResolve } from '../tutorial.js';
import type { PlanComponents, PlanContext, PlanSources, SlotMedia, TutorialSetup } from './scope.js';

/** The resolver (its slot media from `planSlotMedia`), the override candidates and the slot context of every use. */
export function planComponents(c: PlanContext & PlanSources & SlotMedia): PlanComponents {
  const { registry, template, warnings, mediaOf, ov, video, tokens, t } = c;
  const resolver = new ComponentResolver(registry, template, warnings, mediaOf);
  const overrideRefs = ov.components ?? {};
  const kindOverride = (kind: ComponentKind): Candidate[] => (overrideRefs[kind] !== undefined ? [{ ref: overrideRefs[kind], source: 'override', label: `overrides.components.${kind}` }] : []);
  const segmentOverride = (id: string, kind: ComponentKind): Candidate[] =>
    id !== kind && overrideRefs[id] !== undefined ? [{ ref: overrideRefs[id], source: 'override', label: `overrides.components["${id}"]` }] : [];
  const themeAndBuiltin = (kind: ComponentKind): Candidate[] => [resolver.themeCandidate(kind), resolver.builtinCandidate(kind)];

  const outro = video.outro === false ? undefined : video.outro;
  const slotBase: SlotContext = {
    theme: tokens,
    templateOutro: { tagline: t.outro.tagline, url: t.outro.url },
    scenario: { title: video.title, outro: video.outro === false ? false : outro ? { tagline: outro.tagline, url: outro.url } : undefined },
  };
  return { resolver, overrideRefs, kindOverride, segmentOverride, themeAndBuiltin, outro, slotBase };
}

/** The tutorial switches of the video and the resolution of a tutorial overlay's component. */
export function planTutorialSetup(c: PlanContext & PlanComponents): TutorialSetup {
  const { video, ov, timeline, notes, overrideRefs, resolver, slotBase } = c;
  const stateOf = tutorialStateOf(video.tutorial, ov.tutorial);
  const tutorialOn = tutorialRequested(timeline, ov.tutorial);
  if (ov.tutorial === false && tutorialRequested(timeline, undefined)) notes.add('tutorial overlays disabled (overrides.tutorial = false)');
  const tutorial: PlanTutorial = { uses: {}, skipped: [] };
  const tutorialResolve: TutorialResolve = (feature, state, slots, where) => {
    const chain: Candidate[] = [];
    const key = `tutorial-${feature}`;
    if (overrideRefs[key] !== undefined) chain.push({ ref: overrideRefs[key], source: 'override', label: `overrides.components["${key}"]` });
    const builtin = TUTORIAL_COMPONENTS[feature];
    const custom = state.component !== builtin || Object.keys(state.params).length > 0;
    chain.push({ ref: { id: state.component, params: state.params }, source: custom ? 'scenario' : 'builtin-default', label: `the tutorial ${feature}` });
    if (state.component !== builtin) chain.push({ ref: builtin, source: 'builtin-default', label: 'the built-in default' });
    return resolver.resolve('overlay', chain, where, { explicit: slots, ctx: slotBase });
  };
  const videoBadges = { video: 0 };
  return { stateOf, tutorialOn, tutorial, tutorialResolve, videoBadges };
}
