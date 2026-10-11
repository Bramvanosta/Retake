# Built-in component library

Components shipped with Demo Studio, one folder per component: `library/<namespace>/<name>/` with a
`component.yaml` manifest and an `index.tsx` implementation (see the README of the repository, section
"Components", and `docs/DESIGN-phase2.md` §1).

The registry scans this folder after the workspace `components/` folder: a workspace component with the same id
overrides the built-in one (with a warning).

## Status: placeholders

Every `studio/*` component here is a **placeholder** (tag `placeholder` in its manifest): a theme-driven, valid
component that accepts the params the starter themes and the legacy template fields pass, and — for layouts —
declares the geometry it draws, so that every theme renders end to end. They are replaced by the measured
reference-look versions in lot L2.5 (`intro-stack`, `outro-stack`, `layout-card`, `caption-below`,
`interstitial-clock`, `transition-crossfade`) and L2.7 (the others).

| id | kind | params |
|---|---|---|
| studio/intro-stack | intro | align, rule, stagger |
| studio/intro-minimal | intro | logo_only, align |
| studio/outro-stack | outro | logo_size, stagger |
| studio/outro-minimal | outro | logo_only |
| studio/card-title | card | align |
| studio/interstitial-clock | interstitial | dim, turns |
| studio/interstitial-plain | interstitial | tone (dark, paper), dim |
| studio/layout-card | layout | width, radius, shadow |
| studio/layout-browser | layout | radius, shadow, show_url |
| studio/layout-laptop | layout | bezel |
| studio/layout-phone | layout | body |
| studio/layout-raw | layout | — |
| studio/caption-below | caption | position (below, above), align, max_lines, rule |
| studio/caption-overlay | caption | opacity, max_width |
| studio/overlay-callout | overlay | placement, max_width |
| studio/overlay-lower-third | overlay | side, max_width |
| studio/transition-crossfade | transition | duration |
| studio/transition-fade-black | transition | duration, color |

Layouts draw the capture (`screen`) in their screen rect; the composition draws the caption component in the
layout's caption rect and the brand mark in its brandmark rect. Layout geometry is static and the planner places
captions and overlays from it, so every layout draws exactly its declared geometry: `studio/layout-card` accepts the
`width` the themes pass (validated) but draws the 1560-wide card until L2.5 lets geometry follow params.
