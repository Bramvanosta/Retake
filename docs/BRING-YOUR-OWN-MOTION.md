# Bring your own motion

Templates never lock you in. Every piece of the edit that Demo Studio draws with a provided component — the intro, the
outro, a card, an interstitial, an overlay over the capture — can be **your own work** instead: a video or an image
file, a transparent video composited over the capture, a Lottie animation, or your own Remotion component. A theme can
even have no intro component at all and use a file.

This page is practical: copy the snippets, change the paths. Paths are relative to the project folder (a theme's own
files: relative to the template folder). Run `studio validate <project> <scenario>` after each change — every mistake
is reported where it is written (missing file, wrong container, unsupported codec, `from` / `to` outside the file,
an overlay video without an alpha channel…).

- [1. A video or an image instead of a segment](#1-a-video-or-an-image-instead-of-a-segment)
- [2. Transparent videos over the capture](#2-transparent-videos-over-the-capture)
- [3. Lottie animations](#3-lottie-animations)
- [4. Your own Remotion components](#4-your-own-remotion-components)
- [5. The output of a Claude motion or design skill](#5-the-output-of-a-claude-motion-or-design-skill)
- [6. Converting and checking files](#6-converting-and-checking-files)
- [7. A complete example](#7-a-complete-example)

## 1. A video or an image instead of a segment

Write `video:`, `image:` or `lottie:` (§3) where you would name a component:

```yaml
intro: {video: assets/intro.mp4}                         # your intro, with its own sound
outro: {image: assets/end-card.png, duration: 3}         # an end card, 3 s
scenes:
  - card: {video: assets/feature-teaser.mp4, from: 2, to: 6.5, volume: 0.6}
    id: teaser
  - interstitial: {image: assets/later.png, fit: contain, background: dark, duration: 2}
  - id: checkout
    # …
```

| Field | Applies to | Meaning |
|---|---|---|
| `video` | intro, outro, card, interstitial, overlay | `.mp4`, `.mov`, `.webm`, `.m4v` — H.264, HEVC, VP8, VP9, AV1 or ProRes |
| `image` | same | `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg` |
| `lottie` | same | a Lottie animation (bodymovin `.json`), see §3 |
| `from`, `to` | video | the part of the file shown, in seconds of the file (default: all of it) |
| `duration` | all | seconds on screen; default: a video's or a Lottie's own length, an image the kind's duration (theme `intro.duration`, `outro.duration`…). A video shorter than `duration` holds its last frame |
| `fit` | all | `cover` (fills the frame, cropped) or `contain` (whole, on `background`). Default: `cover` when the file has about the frame's shape (covering keeps ≥ 80 % of each side), else `contain` — so a 16:9 intro shows whole in the vertical and square variants; write `fit: cover` to fill them anyway |
| `background` | segments | around a contained or transparent file: `theme` (the theme background, default), a theme colour key (`paper`, `dark`, `accent`…), a CSS colour, or `none` |
| `volume` | video | the file's own sound, 0–1 (default 1). A file without sound stays silent |
| `params` | all | params of the component that plays the file (`studio/media`, `studio/lottie`) |

What Demo Studio does around your file:

- **The theme's transitions apply** into and out of your file (the editorial theme crossfades, the motion theme dips
  to black): your file is a segment like any other.
- **Its shape**: `fit` unset, a file of about the frame's shape fills it; a 16:9 file in the vertical or square variant
  is shown whole on the `background` (a plan note says so) — write `fit: cover` to fill those frames anyway, or
  `background: dark` when your file is dark.
- **Sound**: your file's own sound plays (at `volume`). The music bed, when the video has one, **ducks under it** like
  it ducks under the product footage; it plays at its base level under an image, a Lottie or a silent video.
- `studio plan` lists every file (`file: "assets/intro.mp4"`, its length, sound, alpha), the review (`studio review`)
  reports a file that could not be read (`media-missing`, an error) or that shows a uniform frame (`empty-segment`).

**In a theme** (`templates/<name>/template.yaml`): intro, outro and interstitial may be the theme's own files — every
video made with that theme opens on the brand's intro, without any intro component:

```yaml
components:
  intro: {video: media/brand-intro.mp4}                  # relative to the template folder
  outro: {image: media/end-card.png, duration: 3}
  interstitial: {lottie: media/clock.json, params: {colors: {"#ff5a1f": accent}}}
```

A scenario's own `intro:` / `outro:` still wins over the theme's.

Under the hood a file segment is the built-in component `studio/media` (videos and images) or `studio/lottie`, with
the file in its `file` slot — so `overrides.components` and component switching work on it like on any segment.

## 2. Transparent videos over the capture

A step `overlay` can be a file instead of a component. A video with an **alpha channel** is composited over the
capture — a burst on a button, a hand-drawn circle around a total, a sticker in a corner:

```yaml
steps:
  - click: {text: Send request, in: dialog}
    overlay: {video: assets/sparkle-burst.webm, at: click, anchor: target, scale: 0.9}
  - hover: {text: Selowa Ridge}
    overlay: {lottie: assets/check-badge.json, anchor: top-right, scale: 0.9}
  - wait_for: {text: Total}
    overlay: {image: assets/arrow.png, rect: {x: 1240, y: 610, w: 220, h: 160}, at: 0.4, duration: 2.5}
```

| Field | Meaning |
|---|---|
| `video`, `image`, `lottie` | the file (an overlay video should carry alpha: ProRes 4444 `.mov`, or VP9 / VP8 with alpha `.webm`; without alpha it covers the capture inside its box — the validation warns) |
| `at` | when it starts: `end` / `step` (the end of the step, default), `start`, `click` (the click of a pointer step), `mark:<name>` (a marked step), or seconds after the step starts (`0.4`) |
| `anchor` | where its box goes: `target` (centred on the step's target — default when the step has one; `target:` picks another element), `cursor`, `screen` (the whole visible capture), `center`, `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right` (a margin inside the visible capture) |
| `rect` | instead of `anchor`: a box of the page in CSS px `{x, y, w, h}` |
| `scale` | size of the box relative to the file's own pixels taken as page CSS px (a 480 × 480 video = 480 CSS px wide at `scale: 1`; a 2× capture halves it) |
| `fit` | `contain` (default) or `cover` inside the box |
| `duration` | seconds (≤ 30); default: the file's own length (an image: 3 s) |
| `loop` | replay the video or the Lottie for the whole `duration` (without `duration`: to the end of the clip) |
| `volume` | the overlay video's own sound |

The box is **mapped through the layout, the camera and the reframe** like every overlay: a target, cursor or `rect`
box zooms with the camera and stays on its element in the vertical and square variants (which keep that box in view
for as long as the overlay really shows — from its `at`, for its own length); a screen position stays at that place of
the visible capture. A file placed at a corner or a side keeps clear of what the viewer looks at — the target of its
step and of the steps that come while it shows, around the cursor — in the framing of each variant: when the corner
you asked for would cover it (a vertical crop can put the top-right corner right over a list row that the landscape
frame leaves free), the file moves to the nearest free corner (a side to the opposite side) and the plan notes it;
with no free one it stays and the note says what it covers (the review flags it as `overlay-covers-target`). Overlays
are drawn over the capture, under the caption and the brand mark, and clipped to the capture's card. In a
picture-in-picture scene the overlay belongs to the page its step acted on. A kind-wide `overrides.components.overlay`
restyles the provided overlays (callouts…), never your own files.

### Exporting video with alpha

Two formats work everywhere Demo Studio renders: **ProRes 4444** in a `.mov` (large, lossless-looking: the usual
export of video tools) and **VP9 with alpha** in a `.webm` (small: ideal to commit next to your scenarios).

| Tool | How |
|---|---|
| After Effects | Render Queue → Output Module: *QuickTime*, Format Options *Apple ProRes 4444*, Channels **RGB + Alpha**, Color **Straight (Unmatted)** — premultiplied alpha leaves dark fringes |
| Premiere Pro / Media Encoder | Format *QuickTime*, Video Codec *Apple ProRes 4444*, Depth *8-bpc + alpha* (the sequence must have nothing under the graphics) |
| DaVinci Resolve | Deliver → Format *QuickTime*, Codec *Apple ProRes 4444*, tick **Export Alpha** (Straight) |
| Final Cut Pro / Motion | Share → Export File → Video codec *Apple ProRes 4444* (Motion: *Color + Alpha*) on a project without a background |
| Blender | Render → Film → *Transparent*; Output: *FFmpeg Video*, Container *QuickTime*, Codec *ProRes*, Profile *4444*, Color **RGBA** (or Container *WebM*, Codec *VP9*, RGBA) |
| A Remotion project | `npx remotion render src/index.ts Burst out.webm --codec=vp9 --image-format=png --pixel-format=yuva420p` — or ProRes: `--codec=prores --prores-profile=4444 --image-format=png --pixel-format=yuva444p10le`. The composition must not paint a background |
| A PNG sequence (any tool) | `ffmpeg -framerate 30 -i frame_%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 burst.webm` |

Check a file: `ffprobe -v error -show_entries stream=codec_name,pix_fmt:stream_tags=alpha_mode -of default=nw=1 burst.webm`
→ ProRes shows a `yuva…` pixel format, VP9 / VP8 show `alpha_mode=1`.

## 3. Lottie animations

A Lottie file (the bodymovin JSON that After Effects exports with the Bodymovin or LottieFiles plugin, or that any
Lottie tool saves) plays as a card, an intro, an outro, an interstitial — full frame on the theme background — or as
an overlay in its box (§2). It is played by the built-in `studio/lottie`: seeked frame by frame (its own frame rate
mapped to the video's), once — holding its last frame — or looped.

```yaml
scenes:
  - card:
      lottie: assets/cup-steam.json
      params:
        size: 0.7                                          # the animation box: 70 % of the frame, centred
        colors: {"#ff5a1f": accent, "#2b2b33": text, "#f2c14e": muted}
    id: brewing
```

`colors` replaces colours of the animation by theme colours (a theme colour key — `accent`, `text`, `muted`,
`paper`, `dark` — or any CSS colour): fills, strokes, gradient stops, solid layers and text colours that match the
source colour. Design a generic animation once in a few flat "source" colours and every theme paints it in its palette.

| `studio/lottie` param | Default | Meaning |
|---|---|---|
| `fit` | `contain` | `contain` or `cover` inside its box |
| `background` | `theme` | full frame: `theme`, a theme colour key, a CSS colour or `none` |
| `size` | 1 | full frame: share of the frame the animation box takes |
| `loop` | false | replay it for the whole use |
| `colors` | `{}` | source colour → theme colour key or CSS colour |

Tips: export the **JSON** (a `.lottie` file is a zip: not read), embed images as base64 or avoid them (images that
point at external files do not show — the validation warns), convert text layers to shapes (fonts are not loaded).

## 4. Your own Remotion components

When a file is not enough — the motion should take the theme's colours and fonts, the video's title, the captured
data — write a component. It lives in your workspace (`components/<namespace>/<name>/`) and is used exactly like the
built-in ones.

```bash
studio components new acme/launch-intro --kind intro --description "Our launch intro: logo burst, then the title."
# → components/acme/launch-intro/{component.yaml, index.tsx, README.md, preview.png}, validated
```

```tsx
// components/acme/launch-intro/index.tsx
import { interpolate, spring } from 'remotion';
import { AbsoluteFill, Logo, backgroundCss, useCurrentFrame } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

export default function LaunchIntro({ theme, slots, unit, fps }: ComponentProps<{ accent_ring: boolean }>) {
  const frame = useCurrentFrame();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const title = interpolate(frame, [12, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: backgroundCss(theme), alignItems: 'center', justifyContent: 'center', gap: 40 * unit }}>
      <div style={{ transform: `scale(${pop})` }}>
        <Logo theme={theme} size={140} unit={unit} />
      </div>
      <div style={{ opacity: title, fontFamily: theme.fonts.display, fontSize: 96 * unit, color: theme.colors.text }}>{slots.title}</div>
    </AbsoluteFill>
  );
}
```

Rules (checked by `studio components validate`): import only `react`, `remotion` and `@demo-studio/components/kit` (and
your own files) — the renderer primitives (`useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`,
`random`) come from the kit, `remotion` only for the rest (`interpolate`, `spring`…); read colours, fonts, logo from
`props.theme`; size everything with `props.unit`; animate from `useCurrentFrame()` — no `Math.random` (use the kit's
`random(seed)`), `Date`, `fetch` or timers. Then:

```yaml
intro: {component: acme/launch-intro}                    # in a scenario
# or in the theme:  components: {intro: acme/launch-intro}
```

`studio components preview acme/launch-intro` renders its `preview.png`. A component usable as several kinds declares
them (`kind: card` + `kinds: [intro, outro, interstitial, overlay]`) and reads `props.as`; a box-filling overlay
component receives its box as `props.anchor` when the step gives `anchor` / `rect` / `scale`. The kit also exports
`VideoFile`, `ImageFile` and `LottieFile`, to put a file inside your own frame. The README's "Components" section has
the full contract.

## 5. The output of a Claude motion or design skill

Whatever a Claude skill (or any other tool) makes, one of three paths takes it into the video:

1. **As a file** — the skill renders an MP4 / MOV / WebM, a PNG or an SVG: drop it in `assets/` and name it
   (`intro: {video: assets/intro.mp4}`, `card: {image: assets/slide.png}`). Ask for 1920 × 1080 (or the aspect of
   the variant you render), 30 fps, H.264 — or tell it to export a Lottie JSON for `lottie:`.
2. **As an alpha overlay** — ask for a transparent background and an alpha export: *"render the composition with no
   background as VP9 with alpha (`--codec=vp9 --image-format=png --pixel-format=yuva420p`) or ProRes 4444"*. Then
   `overlay: {video: assets/burst.webm, anchor: target}` on the step it celebrates.
3. **As a workspace component** — when the skill writes Remotion code, keep it as a component so it takes every
   theme: `studio components new acme/<name> --kind <kind>`, paste the animation into `index.tsx`, replace its hard-coded
   colours and fonts with `theme.colors.*` / `theme.fonts.*`, its sizes with `unit`, its texts with `slots.*`, keep
   the imports to `react`, `remotion` and the kit, and run `studio components validate acme/<name>`. An animation made
   in HTML / CSS / SVG without Remotion ports the same way (CSS animations become `interpolate(useCurrentFrame(), …)`).

A prompt that works well: *"Make a 3.5 s, 1920 × 1080, 30 fps Remotion composition: <the motion>. Use only `react` and
`remotion`, no randomness, no timers; take colours from a `theme` prop (`colors.accent`, `colors.text`,
`colors.paper`) and sizes from a `unit` prop."* — the result drops into a component almost unchanged.

## 6. Converting and checking files

```bash
# Any video → H.264 MP4 (an unsupported codec, an .avi, a .mkv)
ffmpeg -i in.avi -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4
# An animated GIF → MP4 (GIFs are not read)
ffmpeg -i in.gif -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart out.mp4
# ProRes 4444 → a small WebM with alpha (to commit)
ffmpeg -i burst.mov -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -auto-alt-ref 0 burst.webm
# Codec, size, length, sound, alpha of a file
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,pix_fmt:stream_tags=alpha_mode:format=duration -of default=nw=1 in.mp4
```

`studio validate` probes every file (ffprobe, cached) and reports, at its line: a file that does not exist; a
container that does not match the key (`image: intro.mp4` → "it looks like a video: write `video:`"); a codec the
renderer cannot decode; `from` / `to` outside the file; `to` before `from`; fields that do not apply (`volume` on an
image, `background` on an overlay); an overlay video without alpha (warning); a `duration` longer than the video
(its last frame is held — warning); a Lottie file that is not bodymovin JSON or that refers to external images.

## 7. A complete example

The fixture project has one: `projects/northfield-fixture/scenarios/own-media.yaml` opens on its own intro video
(with a chime: the music bed ducks under it), sends a quote request with a transparent burst over the button, plays a
Lottie card in the theme's colours and a Lottie check badge in the corner of the quotes list, and ends on its own end
card. Its media are generated locally by `node scripts/fixture-media.mjs`: a small Remotion project
(`fixtures/own-media/src/index.tsx` — the intro, the end card, the burst rendered with a transparent background) and
hand-written Lottie JSON (`fixtures/own-media/lottie.mjs`).

```bash
node fixtures/wholesale/server.mjs &                    # the fixture product
node packages/cli/dist/bin.js run northfield-fixture own-media
node packages/cli/dist/bin.js render northfield-fixture own-media --review
node packages/cli/dist/bin.js render northfield-fixture own-media --theme motion --vertical
```
