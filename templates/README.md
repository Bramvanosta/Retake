# Starter templates

Generic templates shipped with Retake. Each folder holds a `template.yaml` (brand & motion style,
validated against the template schema), its placeholder logo and wordmark, its fonts and their licences.

| Template | Look | Frame / captions | Sample brand |
| --- | --- | --- | --- |
| [`default`](default/README.md) | neutral and elegant — Inter, slate text, calm blue accent, solid light background | card / below | Retake |
| [`editorial`](editorial/README.md) | warm and premium — Instrument Serif over Inter, wine accent, paper background (the reference look) | card / below | Atelier |
| [`motion`](motion/README.md) | bold teaser — Space Grotesk, coral accent, dark gradient, fades through black | browser / overlay | Retake |

Brand templates belong in your workspace, not here: `retake theme create <brand> --accent … --logo …`
(or Claude's `template_create_from_brand`) makes `<workspace>/templates/<brand>/` from your files in
`<workspace>/brand/` over one of these starters ([Themes from your brand](../docs/guide/themes-and-components.md#themes-from-your-brand)) — `retake theme from-site <url>`
(Claude: `template_from_site`) drafts the colours and a logo from the brand's public site first; or copy the closest
starter by hand and replace its logo, wordmark, fonts and colours (each README walks through it). The
sample brands are the tool's own name (default, motion) and an invented one (editorial).
