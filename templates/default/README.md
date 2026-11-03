# `default` — neutral starter template

Neutral and elegant, fits any product: Inter for display and body, slate text, a calm blue accent on a
solid light background, the capture in a soft-shadowed card with the captions below it.

| Section | Value |
| --- | --- |
| Frame | `card`, 1560 px wide, radius 18, soft shadow |
| Captions | below the card — kicker Inter SemiBold 15 px uppercase in the accent, line Inter SemiBold 35 px |
| Intro / outro | logo + kicker + title, 3.2 s / logo + tagline, 3.0 s |
| Interstitial / transitions | dark card / 0.35 s crossfade between scenes |
| Cursor | dark arrow, ripple in the accent |
| Motion | static camera, zooms only from scenario `camera` hints (max 1.4×), `style_bias: real` |
| Brandmark | logo + wordmark, bottom right |

Files: `template.yaml`, `logo.svg` and `wordmark.svg` (sample brand: the tool's own name, "Retake"), `fonts/` (Inter,
SIL OFL 1.1 — see `LICENSES.md`).

## Derive your brand template

Brand templates live in your own workspace (the folder holding your `projects/`, or the `templates_dir`
of its `retake.yaml`), never in the Retake installation.

1. Copy this folder to `<workspace>/templates/<brand>/` (for example `templates/northfield/`).
2. Replace `logo.svg` with your square mark (it is shown from 30 px in the brandmark up to 150 px in the
   outro, so keep it legible small; SVG, PNG, JPG or WebP) and `wordmark.svg` with your outlined
   wordmark, cropped tight, in a colour that reads on your background.
3. Put your fonts in `fonts/` (`.ttf`, `.otf`, `.woff` or `.woff2`) and update `fonts.display` and
   `fonts.body` (regular, semibold, bold). Replace `LICENSES.md` with your fonts' licences.
4. Set `name`, `brand` (name and site, e.g. `{name: Northfield, url: example.com}`), the four `colors`
   (extra keys are allowed and usable as caption colours), the
   `background` and `cursor.ripple_color` (your accent at about 45 % opacity).
   `components` picks the default component per kind (intro, outro, card, interstitial, layout, caption,
   overlay, transition): keep it in step with `frame`, `intro`, `outro`, `interstitial`, `captions` and
   `transitions` (validation warns when they disagree), or remove it to let those fields choose.
5. Use it from a project: `template: <brand>` in `project.yaml` (or in a scenario).

Every section of `template.yaml` is optional — missing values fall back to Retake's built-in
defaults — so a brand template may keep only what differs. This starter spells out every value so it
reads as a reference. The `# yaml-language-server` header points to the JSON Schema inside the Retake
repository; in your workspace, point it to the output of `retake schema template` or remove it.
Loading the template reports any mistake with its line and column, and lists missing asset files.

`wordmark.svg` is live text with the Latin subset of Inter SemiBold embedded, so it renders the same
as an image. You can try another name by editing the `<text>` content (then widen the `viewBox`), but
use your real, outlined wordmark for production.
