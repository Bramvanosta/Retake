# Component code: the manifest, the props and the kit

A component is a folder `components/<namespace>/<name>/` of the workspace: `component.yaml` (the manifest),
`index.tsx` (the code), `README.md`, and the `preview.png` / `preview.json` the user's terminal generates.
`component_create` writes all of it from the scaffold of its kind; you then change it with the user's agreement.

## component.yaml

```yaml
id: acme/intro-split              # = the folder <namespace>/<name>
version: 0.1.0                    # semver
kind: intro                       # intro | outro | card | interstitial | caption | layout | overlay | transition
name: Split intro
description: Logo on the left, title on the right, sliding in one after the other.
slots:                            # the values it shows
  title: {type: text, required: true, default_from: scenario.title.text, max_chars: 60}
  kicker: {type: text, default_from: scenario.title.kicker, max_chars: 40}
  logo: {type: image, default_from: theme.logo}
params:                           # JSON Schema (an object) with a default for every property
  type: object
  properties:
    align: {type: string, enum: [center, left], default: left}
    stagger: {type: number, minimum: 0, maximum: 0.5, default: 0.12}
tokens: [colors.accent, colors.text, background, fonts.display, fonts.body, logo]
duration: {default: 3.2, min: 1.5, max: 8}
variants: [landscape, vertical]
preview:                          # samples: a preview renders with any theme, without a scenario
  slots: {title: Quotes in two clicks, kicker: Product tour}
  at: [0.4, 1.6, 2.8]
```

- Slot types: `text`, `image`, `url` (shown as text), `color`, `screen` (the capture, for layouts, interstitials and
  transitions). `default_from` fills a slot from the theme (`theme.logo`, `theme.brand.name`…), the scenario
  (`scenario.title.text`…) or the scene (`scene.caption.text`).
- `params` is closed: every property needs a `default` that matches its schema. A theme, a scenario or a render passes
  params by name and they are validated against it.
- `preview.slots` gives a sample for every required slot the theme does not fill; `preview.at` the seconds shown.
- Layouts also declare their `geometry` (the screen, caption and brand-mark rects in the 1920 x 1080 design space);
  start from the layout scaffold, which has one, rather than writing it from nothing.

## index.tsx

```tsx
import { Background, FitText, Logo, rise, stagger, useCurrentFrame } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { align: 'center' | 'left'; stagger: number };

export default function SplitIntro({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame(); // frames from the start of this component's segment
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { step: params.stagger }), unit });
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 64 * unit, padding: 160 * unit,
                    justifyContent: params.align === 'center' ? 'center' : 'flex-start' }}>
        <div style={enter(0)}><Logo theme={theme} size={96} unit={unit} /></div>
        <div style={enter(1)}>
          <FitText text={slots.title ?? ''} width={width * 0.5} maxFontSize={96 * unit} maxLines={2}
                   fontFamily={theme.fonts.display} color={theme.colors.text} />
        </div>
      </div>
    </Background>
  );
}
```

The rules `component_validate` checks (it compiles the code; nothing runs):

- Import only `react`, `@retake/components/kit` and the component's own files. Take the renderer primitives
  (`useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random`) from the kit, like the
  scaffolds; `remotion` itself stays allowed for what the kit does not re-export (`interpolate`, `spring`).
- Deterministic: everything follows `useCurrentFrame` - no `Math.random` (use `random` with a seed: `random(null)` is
  `Math.random` and is refused), no `Date`, no timers, no `fetch` or other network.
- Every colour, font and image comes from `theme` (never a brand's hex or font name in the code); every size is in
  1920-wide design px times `unit` (2 for 4K, 0.5 for previews).
- Text goes through `FitText` or `CapText`, so it never overflows.

## Props (`ComponentProps`)

- `theme` (`ThemeTokens`): `colors` (accent, text, muted, paper, dark), `background`, `fonts` (display, body),
  `logo`, `wordmark`, `brand` (name, url), `captions`, `style_bias` (`real`, `balanced` or `motion`).
- `slots`, `params` (defaults applied), `unit`, `width`, `height`, `fps`, `durationInFrames`, `variant` (landscape,
  vertical, square).
- Per kind: `screen` (layout: the capture; interstitial: the last frame; transition: the wrapped segment), `rects`
  (layout: `LayoutRects`, its evaluated geometry), `url` (browser chrome: the page's display URL), `cues` and `area`
  (caption: `CaptionCue` list), `anchor` (overlay: the target box), `direction` (transition: `exiting` or
  `entering`).

## The kit (`@retake/components/kit`)

| Group | Exports |
|---|---|
| Renderer primitives | `useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random` |
| Motion | `progress`, `fadeIn`, `fadeOut`, `fade`, `rise`, `stagger`, `activeIndex`, `easing`, `EASINGS`, `cubicBezier`, `themeEasing`, `biasMotion` |
| Text that fits | `FitText`, `fitText`, `wrapText`, `balanceLines`, `measureText`, `CapText`, `capTextLayout`, `fontMetrics`, `capOffset` |
| Theme elements | `Background`, `Logo`, `Wordmark`, `SafeArea`, `Icon`, `ICON_NAMES`, `Picture` |
| CSS and colours | `backgroundCss`, `cssFontFamily`, `textStyleCss`, `withAlpha`, `mixColors`, `darkLight`, `nightTone`, `contrastRatio`, `readableOn`, `isDarkBackground` |
| Layout helpers | `safeAreaRect`, `scaleRect`, `roundTo`, `placeBeside`, `cardShadow`, `deviceTones`, `addressParts`, `captionBandBox`, `formatMetrics`, `captionMaxLines` |
| Figures, keys, codes | `parseFigure`, `formatFigure`, `figureAt`, `parseShortcut`, `shortcutText`, `qrEncode`, `qrPath` |

`biasMotion` turns `style_bias` into how lively a component may move (`real` is the calm reference look).
`formatMetrics` gives the type scale and margins of the vertical and square formats.
