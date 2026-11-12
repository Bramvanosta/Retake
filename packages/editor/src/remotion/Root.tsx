/**
 * The Remotion root of a render bundle: the compositions DemoVideo (landscape), DemoVertical (9:16) and DemoSquare
 * (1:1), all taking `{ plan }` and sized by the plan (calculateMetadata). The generated bundle entry calls
 * `registerRoot(createRoot(modules))` with the generated registry module. The ids and the props are ./contract.ts's:
 * each composition's calculateMetadata reads its input through it (a payload of another props version is refused
 * there, when a render selects the composition; the Studio player mounts DemoVideo / ComponentPreview itself).
 */
import type { ComponentType } from 'react';
import { COMPOSITIONS, readPreviewProps, readVideoProps } from './contract.js';
import { Composition } from './host.js';
import type { CalculateMetadataFunction } from './host.js';
import { DemoVideo } from './DemoVideo.js';
import type { DemoVideoProps } from './DemoVideo.js';
import { ModulesContext } from './modules.js';
import type { ComponentModules } from './modules.js';
import { ComponentPreview } from './Preview.js';
import type { ComponentPreviewProps } from './Preview.js';

const previewMetadata: CalculateMetadataFunction<ComponentPreviewProps> = ({ props }) => {
  const p = readPreviewProps(props);
  if (!p) return {};
  return { durationInFrames: Math.max(1, p.durationInFrames), fps: p.fps, width: p.width, height: p.height };
};

function metadata(variant: 'landscape' | 'vertical' | 'square'): CalculateMetadataFunction<DemoVideoProps> {
  return ({ props }) => {
    const plan = readVideoProps(props);
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
  const Preview = (props: ComponentPreviewProps) => (
    <ModulesContext.Provider value={modules}>
      <ComponentPreview {...props} />
    </ModulesContext.Provider>
  );
  const previewDefaults: ComponentPreviewProps = { preview: null };
  return function RetakeRoot() {
    return (
      <>
        <Composition id={COMPOSITIONS.landscape} component={Video} durationInFrames={1} fps={30} width={1920} height={1080} defaultProps={defaultProps} calculateMetadata={metadata('landscape')} />
        <Composition id={COMPOSITIONS.vertical} component={Video} durationInFrames={1} fps={30} width={1080} height={1920} defaultProps={defaultProps} calculateMetadata={metadata('vertical')} />
        <Composition id={COMPOSITIONS.square} component={Video} durationInFrames={1} fps={30} width={1080} height={1080} defaultProps={defaultProps} calculateMetadata={metadata('square')} />
        <Composition id={COMPOSITIONS.preview} component={Preview} durationInFrames={1} fps={30} width={1920} height={1080} defaultProps={previewDefaults} calculateMetadata={previewMetadata} />
      </>
    );
  };
}
