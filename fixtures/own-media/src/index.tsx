/**
 * "Your own motion" for the fixture (L2.12): a tiny, separate Remotion project — like the one a user (or any Claude
 * motion / design skill) would make — whose renders the fixture scenario `own-media` uses instead of the provided
 * components: an intro video (with a chime added by scripts/fixture-media.mjs), an outro end card (a still), an alpha
 * overlay video (a burst, rendered with a transparent background → VP9 + alpha .webm and ProRes 4444 .mov) and a sample
 * image for the studio/media preview. Fictional brand "Northfield" (the fixture's).
 *
 * Rendered by scripts/fixture-media.mjs; nothing here is used by Demo Studio itself.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AbsoluteFill, Composition, continueRender, delayRender, interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from 'remotion';

const INK = '#1d1412';
const ESPRESSO = '#2a1b17';
const CREAM = '#f3e7d8';
const WINE = '#8a2332';
const GOLD = '#e7b45a';

/** The fonts of the editorial starter theme, served from the public dir (templates/editorial/fonts). */
function useFonts(): boolean {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    const faces = [
      new FontFace('Display', `url(${staticFile('InstrumentSerif-Regular.ttf')})`),
      new FontFace('Body', `url(${staticFile('Inter-SemiBold.ttf')})`, { weight: '600' }),
      new FontFace('Body', `url(${staticFile('Inter-Regular.ttf')})`, { weight: '400' }),
    ];
    Promise.all(faces.map((f) => f.load())).then((loaded) => {
      for (const f of loaded) document.fonts.add(f);
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready;
}

/** The brand mark: a coffee bean (two halves and a seam), drawn in SVG. */
function Bean({ size, color, seam }: { size: number; color: string; seam: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <ellipse cx="50" cy="50" rx="30" ry="42" transform="rotate(28 50 50)" fill={color} />
      <path d="M 38 18 C 62 38, 38 62, 62 82" transform="rotate(28 50 50)" fill="none" stroke={seam} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

/** Warm light behind the content. */
function Glow({ opacity }: { opacity: number }): ReactNode {
  return <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 60% at 50% 45%, rgba(231, 180, 90, ${0.22 * opacity}) 0%, rgba(42, 27, 23, 0) 70%)` }} />;
}

/** Intro: the bean drops in on a spring, the name rises letter by letter, a gold rule draws, the line fades in. */
function Intro(): ReactNode {
  const ready = useFonts();
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  if (!ready) return null;
  const bean = spring({ frame: frame - 4, fps, config: { damping: 12, stiffness: 120 } });
  const name = 'Northfield';
  const rule = interpolate(frame, [30, 58], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const line = interpolate(frame, [44, 64], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames - 1], [1, 0.92], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${ESPRESSO} 0%, ${INK} 70%)`, alignItems: 'center', justifyContent: 'center' }}>
      <Glow opacity={bean} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34, transform: `scale(${out})` }}>
        <div style={{ transform: `translateY(${(1 - bean) * -140}px) rotate(${(1 - bean) * -40}deg)`, opacity: Math.min(1, bean * 1.4) }}>
          <Bean size={170} color={GOLD} seam={INK} />
        </div>
        <div style={{ display: 'flex', fontFamily: 'Display', fontSize: 168, color: CREAM, letterSpacing: '-0.01em', lineHeight: 1 }}>
          {name.split('').map((ch, i) => {
            const p = interpolate(frame, [12 + i * 2.2, 30 + i * 2.2], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
            return (
              <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 46}px)` }}>
                {ch}
              </span>
            );
          })}
        </div>
        <div style={{ width: 360 * rule, height: 3, background: GOLD, borderRadius: 2 }} />
        <div style={{ fontFamily: 'Body', fontWeight: 600, fontSize: 30, letterSpacing: '0.22em', color: CREAM, opacity: line * 0.85, textTransform: 'uppercase' }}>
          Wholesale coffee for cafés
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** Outro end card (a still): the mark, the name, a tagline and the address, on espresso. */
function EndCard({ compact }: { compact?: boolean }): ReactNode {
  const ready = useFonts();
  if (!ready) return null;
  const k = compact ? 0.8 : 1;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${ESPRESSO} 0%, ${INK} 75%)`, alignItems: 'center', justifyContent: 'center' }}>
      <Glow opacity={0.9} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30 * k }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 * k }}>
          <Bean size={120 * k} color={GOLD} seam={INK} />
          <div style={{ fontFamily: 'Display', fontSize: 132 * k, color: CREAM, lineHeight: 1 }}>Northfield</div>
        </div>
        <div style={{ width: 300 * k, height: 3, background: WINE, borderRadius: 2 }} />
        <div style={{ fontFamily: 'Display', fontSize: 60 * k, color: CREAM, opacity: 0.92 }}>Coffee, roasted to order.</div>
        <div style={{ fontFamily: 'Body', fontWeight: 600, fontSize: 28 * k, letterSpacing: '0.16em', color: GOLD, textTransform: 'uppercase' }}>shop.northfield.example</div>
      </div>
    </AbsoluteFill>
  );
}

/** Alpha overlay: a gold ring expands and fades while eight sparks fly out — on a transparent background. */
function Burst(): ReactNode {
  const frame = useCurrentFrame();
  const { width, durationInFrames } = useVideoConfig();
  const c = width / 2;
  const t = frame / (durationInFrames - 1);
  const ring = Easing.out(Easing.cubic)(Math.min(1, t * 1.35));
  const fade = interpolate(t, [0.55, 1], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const sparks = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const d0 = c * (0.18 + 0.5 * ring);
    const d1 = c * (0.3 + 0.62 * ring);
    return (
      <line
        key={i}
        x1={c + Math.cos(a) * d0}
        y1={c + Math.sin(a) * d0}
        x2={c + Math.cos(a) * d1}
        y2={c + Math.sin(a) * d1}
        stroke={i % 2 === 0 ? GOLD : WINE}
        strokeWidth={c * 0.05 * (1 - 0.6 * ring)}
        strokeLinecap="round"
        opacity={fade}
      />
    );
  });
  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
      <svg width={width} height={width} viewBox={`0 0 ${width} ${width}`}>
        <circle cx={c} cy={c} r={c * (0.12 + 0.62 * ring)} fill="none" stroke={GOLD} strokeWidth={c * 0.06 * (1 - ring) + 2} opacity={fade} />
        <circle cx={c} cy={c} r={c * 0.1 * (1 - ring)} fill={GOLD} opacity={fade} />
        {sparks}
      </svg>
    </AbsoluteFill>
  );
}

function Root(): ReactNode {
  return (
    <>
      <Composition id="intro" component={Intro} width={1920} height={1080} fps={30} durationInFrames={108} />
      <Composition id="end-card" component={EndCard} width={1920} height={1080} fps={30} durationInFrames={1} />
      <Composition id="media-sample" component={() => <EndCard compact />} width={1200} height={900} fps={30} durationInFrames={1} />
      <Composition id="burst" component={Burst} width={480} height={480} fps={30} durationInFrames={36} />
    </>
  );
}

registerRoot(Root);
