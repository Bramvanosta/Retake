# Built-in component library

Components shipped with Retake, one folder per component: `library/<namespace>/<name>/` with a
`component.yaml` manifest, an `index.tsx` implementation, its generated `preview.png` (960×540, the editorial theme,
the manifest's preview samples) + `preview.json` sidecar, and a README.md showing the preview, the slots and the params
(see `docs/guide/themes-and-components.md` of the repository, section "Components", and `docs/DESIGN-phase2.md` §1).

The registry scans this folder after the workspace `components/` folder: a workspace component with the same id
overrides the built-in one (with a warning).

## The library (all final since L2.7)

Every component reads its colours, fonts, logo and wordmark from the theme only, sizes everything with `unit`, is
deterministic, and scales its motion with the theme's `style_bias` (layouts are static by design). The six measured
against `docs/reference/look.md` carry the tag `reference-look`; the others are built in the same family (text placed
by its cap band, the reference soft shadow, the theme's night tone for dark surfaces, readability guards).

| id | kind | params |
|---|---|---|
| studio/intro-stack | intro | align, rule, stagger |
| studio/intro-minimal | intro | logo_only, align |
| studio/outro-stack | outro | logo_size, stagger |
| studio/outro-minimal | outro | logo_only |
| studio/card-title | card | align, rule, tone (paper, dark) |
| studio/interstitial-clock | interstitial | dim, turns |
| studio/interstitial-plain | interstitial | tone (dark, paper), dim |
| studio/layout-card | layout | width, radius, shadow |
| studio/layout-browser | layout | width, radius, shadow, show_url, tabs, chrome (auto, light, dark), controls (color, theme) |
| studio/layout-laptop | layout | width, finish (light, dark), shadow |
| studio/layout-phone | layout | height, finish (dark, light), island, status_bar, shadow |
| studio/layout-tablet | layout | height (portrait), width (landscape), finish (dark, light), shadow |
| studio/layout-raw | layout | — |
| studio/caption-below | caption | position (below, above), align, max_lines, rule |
| studio/caption-overlay | caption | position (over, area), align, opacity, max_width, max_lines |
| studio/overlay-callout | overlay | placement (auto, above, below), max_width, highlight |
| studio/overlay-lower-third | overlay | side (left, right), max_width |
| studio/transition-crossfade | transition | duration |
| studio/transition-fade-black | transition | duration, through (black, night), color |

Layouts declare their geometry with expressions over their params and the capture `aspect` (the planner evaluates it
per use and passes the result as `props.rects`); the composition draws the caption component in the layout's
`caption` rect and the brand mark in its `brandmark` rect. Device layouts keep the capture's aspect within device
proportions and paint the theme background around a capture they letterbox (`rects.display`).

Previews are regenerated with `retake components preview --all` (or `--all --stale`); `packages/components/test/
previews.test.ts` fails when one is missing or older than its component's sources.
