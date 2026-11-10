/**
 * ComponentPreview: one component rendered in context with sample content, for the committed preview.png of every
 * component (R-CMP-14), the Studio library screen and Claude. Intros, outros and cards render alone; a layout renders
 * the sample screen as its capture with the brand mark and the theme's caption; a caption, an overlay or a transition
 * renders around / over such a scene (a transition between the scene and the theme's card); an interstitial over the
 * scene as its backdrop. Everything comes from the spec (../preview.ts builds it), so the preview is deterministic.
 */
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Img, Sequence, useCurrentFrame } from './host.js';
import { Logo, Wordmark, backgroundCss } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components';
import type { PreviewProps } from './contract.js';
import { useThemeFonts } from './fonts.js';
import { useModules } from './modules.js';
import type { ComponentPreviewSpec, PreviewScene, PreviewUse } from './preview-types.js';

export type ComponentPreviewProps = PreviewProps;

const fill: CSSProperties = { position: 'absolute', inset: 0 };

function UseOf({ use, spec, extra }: { use: PreviewUse; spec: ComponentPreviewSpec; extra?: Partial<ComponentProps> }) {
  const modules = useModules();
  const own = modules.components[use.id] ?? modules.scaffolds[use.kind];
  if (!own) throw new Error(`the preview bundle has no implementation for ${use.id}`);
  const Component = own.component;
  return (
    <Component
      as={use.kind}
      theme={spec.theme}
      unit={spec.width / 1920}
      width={spec.width}
      height={spec.height}
      fps={spec.fps}
      variant="landscape"
      slots={use.slots}
      params={use.params}
      durationInFrames={use.durationInFrames}
      {...(use.media ? { media: use.media } : {})}
      {...extra}
    />
  );
}

function Brandmark({ spec, scene }: { spec: ComponentPreviewSpec; scene: PreviewScene }) {
  const b = scene.brandmark;
  if (!b) return null;
  const unit = spec.width / 1920;
  return (
    <div
      style={{
        position: 'absolute',
        left: b.rect.x,
        top: b.rect.y,
        width: b.rect.w,
        height: b.rect.h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: b.align === 'right' ? 'flex-end' : 'flex-start',
        gap: 10 * unit,
        opacity: b.opacity,
      }}
    >
      <Logo theme={spec.theme} size={b.size} unit={unit} />
      <Wordmark theme={spec.theme} height={b.size * 0.8} unit={unit} />
    </div>
  );
}

/** The sample screen as a capture: the image filling the layout's screen rect (it has the same aspect). */
function SampleScreen({ scene }: { scene: PreviewScene }) {
  return <Img src={scene.screen.url} style={{ ...fill, width: '100%', height: '100%', display: 'block' }} />;
}

/** A region of the sample screen (sample px) filling its parent box: the `screen` of a loupe preview. */
function SampleRegion({ scene, region }: { scene: PreviewScene; region: { x: number; y: number; w: number; h: number } }) {
  const W = scene.screen.width;
  const H = scene.screen.height;
  return (
    <div style={{ ...fill, overflow: 'hidden' }}>
      <Img
        src={scene.screen.url}
        style={{
          position: 'absolute',
          left: `${(-region.x / region.w) * 100}%`,
          top: `${(-region.y / region.h) * 100}%`,
          width: `${(W / region.w) * 100}%`,
          height: `${(H / region.h) * 100}%`,
          display: 'block',
        }}
      />
    </div>
  );
}

/** A clip-like scene: layout (sample screen), brand mark, and optionally the caption. */
function Scene({ spec, scene, caption }: { spec: ComponentPreviewSpec; scene: PreviewScene; caption: boolean }) {
  return (
    <AbsoluteFill>
      <UseOf
        use={scene.layout}
        spec={spec}
        extra={
          scene.screens
            ? { screens: scene.screens.map((sc, i) => <Img key={i} src={sc.url} style={{ ...fill, width: '100%', height: '100%', display: 'block' }} />), rects: scene.rects }
            : { screen: <SampleScreen scene={scene} />, rects: scene.rects, ...(scene.url ? { url: scene.url } : {}) }
        }
      />
      <Brandmark spec={spec} scene={scene} />
      {caption && scene.caption ? (
        <UseOf use={scene.caption} spec={spec} extra={{ cues: scene.caption.cues, rects: scene.rects, ...(scene.rects.caption ? { area: scene.rects.caption } : {}) }} />
      ) : null}
    </AbsoluteFill>
  );
}

/** The segment entering a transition, shown settled (its own time is advanced by two seconds). */
function Incoming({ spec, use }: { spec: ComponentPreviewSpec; use: PreviewUse }) {
  return (
    <Sequence from={-2 * spec.fps} layout="none" name="incoming">
      <AbsoluteFill style={{ background: backgroundCss(spec.theme) }}>
        <UseOf use={use} spec={spec} />
      </AbsoluteFill>
    </Sequence>
  );
}

/**
 * The transition component over both segments at transition frame `at`: fade-black shows the outgoing half before
 * ⌊n/2⌋ and the incoming one from it; a crossfade draws both (the entering one on top).
 */
function TransitionAt({ spec, at, outgoing, incoming }: { spec: ComponentPreviewSpec; at: number; outgoing: ReactNode; incoming: ReactNode }) {
  const main = spec.main;
  const anchor = spec.anchor ? { anchor: spec.anchor } : {};
  const n = main.durationInFrames;
  if (spec.transitionKind === 'fade-black' && at >= Math.floor(n / 2)) {
    return <UseOf use={main} spec={spec} extra={{ direction: 'entering', screen: incoming, ...anchor }} />;
  }
  if (spec.transitionKind === 'fade-black') return <UseOf use={main} spec={spec} extra={{ direction: 'exiting', screen: outgoing, ...anchor }} />;
  return (
    <AbsoluteFill>
      <UseOf use={main} spec={spec} extra={{ direction: 'exiting', screen: outgoing, ...anchor }} />
      <AbsoluteFill>
        <UseOf use={main} spec={spec} extra={{ direction: 'entering', screen: incoming, ...anchor }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Inside the transition's Sequence: its own frame picks the half (motion mode). */
function TransitionNow({ spec, outgoing, incoming }: { spec: ComponentPreviewSpec; outgoing: ReactNode; incoming: ReactNode }) {
  return <TransitionAt spec={spec} at={useCurrentFrame()} outgoing={outgoing} incoming={incoming} />;
}

/**
 * Motion mode (a looping transition preview): the outgoing scene for `lead` frames, the transition — its component
 * sees transition frames 0…n−1, the outgoing scene inside keeps the composition's frames — then the settled card for
 * `tail` frames. The card keeps the still's two-second advance, counted from the transition's start.
 */
function MotionTransition({ spec, motion }: { spec: ComponentPreviewSpec; motion: { lead: number; tail: number } }) {
  const frame = useCurrentFrame();
  const n = spec.main.durationInFrames;
  const scene = spec.scene;
  const outgoing: ReactNode = scene ? <Scene spec={spec} scene={scene} caption /> : null;
  const incoming: ReactNode = spec.incoming ? <Incoming spec={spec} use={spec.incoming} /> : null;
  if (frame < motion.lead) return <AbsoluteFill>{outgoing}</AbsoluteFill>;
  if (frame >= motion.lead + n) {
    return (
      <Sequence from={motion.lead} layout="none" name="settled">
        {incoming}
      </Sequence>
    );
  }
  const held = (
    <Sequence from={-motion.lead} layout="none" name="outgoing">
      {outgoing}
    </Sequence>
  );
  return (
    <Sequence from={motion.lead} durationInFrames={n} layout="none" name="transition">
      <TransitionNow spec={spec} outgoing={held} incoming={incoming} />
    </Sequence>
  );
}

function Body({ spec }: { spec: ComponentPreviewSpec }) {
  const { main, scene } = spec;
  switch (main.kind) {
    case 'layout':
      return scene ? <Scene spec={spec} scene={scene} caption /> : <UseOf use={main} spec={spec} />;
    case 'caption':
      return scene ? <Scene spec={spec} scene={scene} caption /> : <UseOf use={main} spec={spec} />;
    case 'overlay': {
      const extra: Partial<ComponentProps> = { ...(spec.anchor ? { anchor: spec.anchor } : {}), ...(scene ? { rects: scene.rects } : {}) };
      if (spec.moment !== undefined) extra.moment = spec.moment;
      if (spec.chapters) extra.chapters = spec.chapters;
      if (spec.region && scene) {
        extra.region = spec.region;
        extra.screen = <SampleRegion scene={scene} region={spec.region} />;
      }
      return (
        <AbsoluteFill>
          {scene ? <Scene spec={spec} scene={scene} caption /> : null}
          <UseOf use={main} spec={spec} extra={extra} />
        </AbsoluteFill>
      );
    }
    case 'interstitial':
      return <UseOf use={main} spec={spec} extra={scene ? { screen: <Scene spec={spec} scene={scene} caption={false} /> } : {}} />;
    case 'transition': {
      if (spec.motion) return <MotionTransition spec={spec} motion={spec.motion} />;
      const outgoing: ReactNode = scene ? <Scene spec={spec} scene={scene} caption /> : null;
      const incoming: ReactNode = spec.incoming ? <Incoming spec={spec} use={spec.incoming} /> : null;
      return <TransitionAt spec={spec} at={spec.frame} outgoing={outgoing} incoming={incoming} />;
    }
    default:
      return <UseOf use={main} spec={spec} />;
  }
}

export function ComponentPreview({ preview }: ComponentPreviewProps) {
  if (!preview) throw new Error('ComponentPreview needs a spec (inputProps: { preview })');
  const ready = useThemeFonts(preview.theme.font_faces);
  return <AbsoluteFill style={{ background: backgroundCss(preview.theme) }}>{ready ? <Body spec={preview} /> : null}</AbsoluteFill>;
}
