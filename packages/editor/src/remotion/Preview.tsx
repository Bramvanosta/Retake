/**
 * ComponentPreview: one component rendered in context with sample content, for the committed preview.png of every
 * component (R-CMP-14), the Studio library screen and Claude. Intros, outros and cards render alone; a layout renders
 * the sample screen as its capture with the brand mark and the theme's caption; a caption, an overlay or a transition
 * renders around / over such a scene (a transition between the scene and the theme's card); an interstitial over the
 * scene as its backdrop. Everything comes from the spec (../preview.ts builds it), so the preview is deterministic.
 */
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Img, Sequence } from 'remotion';
import { Logo, Wordmark, backgroundCss } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components';
import { useThemeFonts } from './fonts.js';
import { useModules } from './modules.js';
import type { ComponentPreviewSpec, PreviewScene, PreviewUse } from './preview-types.js';

export interface ComponentPreviewProps extends Record<string, unknown> {
  preview: ComponentPreviewSpec | null;
}

const fill: CSSProperties = { position: 'absolute', inset: 0 };

function UseOf({ use, spec, extra }: { use: PreviewUse; spec: ComponentPreviewSpec; extra?: Partial<ComponentProps> }) {
  const modules = useModules();
  const own = modules.components[use.id] ?? modules.scaffolds[use.kind];
  if (!own) throw new Error(`the preview bundle has no implementation for ${use.id}`);
  const Component = own.component;
  return (
    <Component
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

/** A clip-like scene: layout (sample screen), brand mark, and optionally the caption. */
function Scene({ spec, scene, caption }: { spec: ComponentPreviewSpec; scene: PreviewScene; caption: boolean }) {
  return (
    <AbsoluteFill>
      <UseOf use={scene.layout} spec={spec} extra={{ screen: <SampleScreen scene={scene} />, rects: scene.rects, ...(scene.url ? { url: scene.url } : {}) }} />
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

function Body({ spec }: { spec: ComponentPreviewSpec }) {
  const { main, scene } = spec;
  switch (main.kind) {
    case 'layout':
      return scene ? <Scene spec={spec} scene={scene} caption /> : <UseOf use={main} spec={spec} />;
    case 'caption':
      return scene ? <Scene spec={spec} scene={scene} caption /> : <UseOf use={main} spec={spec} />;
    case 'overlay':
      return (
        <AbsoluteFill>
          {scene ? <Scene spec={spec} scene={scene} caption /> : null}
          <UseOf use={main} spec={spec} extra={{ ...(spec.anchor ? { anchor: spec.anchor } : {}), ...(scene ? { rects: scene.rects } : {}) }} />
        </AbsoluteFill>
      );
    case 'interstitial':
      return <UseOf use={main} spec={spec} extra={scene ? { screen: <Scene spec={spec} scene={scene} caption={false} /> } : {}} />;
    case 'transition': {
      const anchor = spec.anchor ? { anchor: spec.anchor } : {};
      const outgoing: ReactNode = scene ? <Scene spec={spec} scene={scene} caption /> : null;
      const incoming: ReactNode = spec.incoming ? <Incoming spec={spec} use={spec.incoming} /> : null;
      const n = main.durationInFrames;
      if (spec.transitionKind === 'fade-black' && spec.frame >= Math.floor(n / 2)) {
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
    default:
      return <UseOf use={main} spec={spec} />;
  }
}

export function ComponentPreview({ preview }: ComponentPreviewProps) {
  if (!preview) throw new Error('ComponentPreview needs a spec (inputProps: { preview })');
  const ready = useThemeFonts(preview.theme.font_faces);
  return <AbsoluteFill style={{ background: backgroundCss(preview.theme) }}>{ready ? <Body spec={preview} /> : null}</AbsoluteFill>;
}
