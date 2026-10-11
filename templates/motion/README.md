# `motion` — bold starter template for teasers

A punchier variant for teasers, launch clips and social cuts: a dark gradient, a hot coral accent,
Space Grotesk for display type, the capture in a browser window with the captions overlaid on it, cuts
through black and richer motion design (`style_bias: motion`).

| Section | Value |
| --- | --- |
| Colours | accent `#ff5c38`, text `#f5f6fa`, muted `#9ea3b5`, paper `#11131c` (dark surface) |
| Background | linear `#0a0b11` → `#1c2030` |
| Fonts | display Space Grotesk Bold, body Inter Regular / SemiBold / Bold |
| Frame | `browser`, 1600 px wide, radius 14, strong shadow |
| Captions | overlaid on the capture — kicker Inter Bold 15 px uppercase in the accent, line Space Grotesk Bold 44 px |
| Intro / outro | kicker + title, 2.6 s / logo + wordmark + tagline + url, 2.8 s |
| Interstitial / transitions | `paper` (a dark card here) / 0.4 s fade through black |
| Cursor | dark arrow, 28 px, coral ripple |
| Motion | zooms only from scenario `camera` hints (max 1.6×, snappier easing), `style_bias: motion` |
| Brandmark | none (the brand closes the video in the outro) |

Files: `template.yaml`, `logo.svg` and `wordmark.svg` (placeholder brand "Demo Studio", light wordmark
for the dark background), `fonts/` (Space Grotesk and Inter, SIL OFL 1.1 — see `LICENSES.md`).

In this dark template `paper` is the dark surface colour and `text` the light one, which is why the
interstitial uses the `paper` style (a paper-coloured card with text-coloured type). Keep that pairing
if you change the colours.

## Derive your brand template

Brand templates live in your own workspace (the folder holding your `projects/`, or the `templates_dir`
of its `studio.yaml`), never in the Demo Studio installation.

1. Copy this folder to `<workspace>/templates/<brand>/` (for example `templates/northfield-teaser/`).
2. Replace `logo.svg` with your square mark (shown up to 150 px in the outro; SVG, PNG, JPG or WebP) and
   `wordmark.svg` with your outlined wordmark, cropped tight, in a light colour that reads on the dark
   background.
3. Put your fonts in `fonts/` (`.ttf`, `.otf`, `.woff` or `.woff2`) and update `fonts.display` (a bold,
   geometric face suits this look) and `fonts.body` (regular, semibold, bold). Replace `LICENSES.md`
   with your fonts' licences.
4. Set `name`, `brand` (name and site, e.g. `{name: Northfield, url: example.com}`), the four `colors`
   (extra keys are allowed and usable as caption colours), the
   `background`, `cursor.ripple_color` and the outro `url`.
   `components` picks the default component per kind (intro, outro, card, interstitial, layout, caption,
   overlay, transition): keep it in step with `frame`, `intro`, `outro`, `interstitial`, `captions` and
   `transitions` (validation warns when they disagree), or remove it to let those fields choose.
5. Use it from a project or a single scenario: `template: <brand>` in `project.yaml`, or in the
   scenario that cuts the teaser.

Every section of `template.yaml` is optional — missing values fall back to Demo Studio's built-in
defaults — so a brand template may keep only what differs. This starter spells out every value so it
reads as a reference. The `# yaml-language-server` header points to the JSON Schema inside the Demo
Studio repository; in your workspace, point it to the output of `studio schema template` or remove it.
Loading the template reports any mistake with its line and column, and lists missing asset files.

`wordmark.svg` is live text with the Latin subset of Space Grotesk Bold embedded, so it renders the
same as an image. You can try another name by editing the `<text>` content (then widen the `viewBox`),
but use your real, outlined wordmark for production.
