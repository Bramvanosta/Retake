# Built-in component library

Components shipped with Demo Studio, one folder per component: `library/<namespace>/<name>/` with a
`component.yaml` manifest and an `index.tsx` implementation (see the README of the repository, section
"Components", and `docs/DESIGN-phase2.md` §1).

The registry scans this folder after the workspace `components/` folder: a workspace component with the same id
overrides the built-in one (with a warning).

The reference-look components (`studio/intro-stack`, `studio/outro-stack`, `studio/layout-card`,
`studio/caption-below`, `studio/interstitial-clock`, `studio/transition-crossfade`) arrive in lot L2.5, the rest of
the library in L2.7. Until then, the per-kind scaffolds in `../scaffolds/` are valid components the render pipeline can
use as stand-ins.
