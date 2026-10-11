/**
 * The Remotion root of a render bundle: the compositions DemoVideo (landscape) and DemoVertical (9:16), both taking
 * `{ plan }` and sized by the plan (calculateMetadata). The generated bundle entry calls
 * `registerRoot(createRoot(modules))` with the generated registry module.
 */
import type { ComponentType } from 'react';
import { Composition } from 'remotion';
import type { CalculateMetadataFunction } from 'remotion';
import { DemoVideo } from './DemoVideo.js';
import type { DemoVideoProps } from './DemoVideo.js';
import { ModulesContext } from './modules.js';
import type { ComponentModules } from './modules.js';

/** Composition ids. */
export const COMPOSITIONS = { landscape: 'DemoVideo', vertical: 'DemoVertical' } as const;

function metadata(variant: 'landscape' | 'vertical'): CalculateMetadataFunction<DemoVideoProps> {
  return ({ props }) => {
    const plan = props.plan;
    if (!plan) return {};
    if (plan.variant !== variant) {
      throw new Error(`${COMPOSITIONS[variant]} renders ${variant} plans; this plan is ${plan.variant} (use ${COMPOSITIONS[plan.variant]})`);
    }
    return { durationInFrames: Math.max(1, plan.durationInFrames), fps: plan.fps, width: plan.width, height: plan.height };
  };
}

export function createRoot(modules: ComponentModules): ComponentType {
  const Video = (props: DemoVideoProps) => (
    <ModulesContext.Provider value={modules}>
      <DemoVideo {...props} />
    </ModulesContext.Provider>
  );
  const defaultProps: DemoVideoProps = { plan: null };
  return function DemoStudioRoot() {
    return (
      <>
        <Composition
          id={COMPOSITIONS.landscape}
          component={Video}
          durationInFrames={1}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={defaultProps}
          calculateMetadata={metadata('landscape')}
        />
        <Composition
          id={COMPOSITIONS.vertical}
          component={Video}
          durationInFrames={1}
          fps={30}
          width={1080}
          height={1920}
          defaultProps={defaultProps}
          calculateMetadata={metadata('vertical')}
        />
      </>
    );
  };
}
