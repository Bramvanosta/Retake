# Themes, components and media

How a video looks: themes, the components that draw it, and your own media and motion. Part of the [Retake guide](README.md).

## Themes

A theme's files live in `templates/<name>/` (the folder and file keep their earlier name; see the
[glossary](../GLOSSARY.md)) — the project's own in `projects/<slug>/templates/<name>/`, the workspace's in its
`templates/` (`templates_dir`).

`templates/<name>/template.yaml` gives the brand and motion style (colours, fonts, logo, wordmark, background, cursor,
captions, timings) and picks a default **component per kind**. Every section is optional and merged over the
defaults; start from a starter theme (`templates/README.md`). The starter themes `default`, `editorial` and
`motion` are always available by name, also in a workspace without a `templates/` folder (`retake list` marks them
"starter"); a workspace theme of the same name takes precedence.

### A project's own themes

A theme is a brand's, so it belongs with the project: a theme in `projects/<slug>/templates/<name>/` travels with the
project folder (another Mac, a person you hand it to). A name is looked for in this order, for that project's work:

1. the project's own `templates/<name>/`;
2. the workspace's `templates/<name>/`;
3. the starter of that name.

A folder of a name takes precedence even without a `template.yaml` (its load error says so). A project theme that hides
a workspace theme or a starter of its name is said once (`retake theme list --project <slug>`, MCP `template_list
{project}`: `notices`; the Studio's card: "Used instead of the workspace's"). Other projects keep the workspace's. A
project.yaml that names a folder by its path (`template: ./templates/brand`) keeps working; when that folder is one of
`templates/`, it is the named theme (one row, editable). A render record holds a project theme's folder relative to the
project (`/project:templates/brand`), so moving or renaming the project keeps its renders matched.

- **Make one in the project**: `retake theme create <name> --project <slug> …`, MCP `template_create_from_brand
  {project, …}`, the Studio's New theme and Copy to edit (a project's screen always makes into that project). Without
  `--project` / `project` a theme is the workspace's, as before.
- **List them**: `retake theme list [--project <slug>]` (each theme's origin: project, workspace, starter), `retake list`
  (each project's own themes), MCP `template_list {project}`.
- **Take a workspace theme into a project**: `retake project adopt <slug> --theme <name>` moves it into
  `projects/<slug>/templates/<name>/` — refused while another project or scenario uses it (they are listed), while a
  project does not open (whether it uses it cannot be told), while the project itself names the folder by its path
  (name it by its name first: a path never finds the project's copy) or while a job is queued or running; the
  workspace's folder is set aside under the workspace's `.retake/adopted/<stamp>-theme-<name>/` (from a templates_dir
  outside the workspace too; never deleted: remove it once you no longer need it). Other projects' older renders of it
  are named. A workspace theme of a starter's name keeps its name. `--copy` leaves the workspace's where it is; Claude's
  `project_adopt {project, themes}` only copies. The copy keeps its provenance (a theme Claude made can still be
  updated through `template_update {name, project}`). The project's renders made before still match it, on the board
  and at an export (their theme name finds the project's copy, whose content hash is the one they hold; a theme with
  files beyond the hash's byte budget is matched by size and date, so a copy of one reads as another theme).
- **Brand files of a project**: `projects/<slug>/brand/` is looked for first (see below); `retake project adopt <slug>
  --brand brand/logo.svg` (one brand file each — an image, a font or a token file —, repeatable; never from the
  workspace's themes, components or state folders; `--copy` to leave the original) copies or moves the workspace's
  into it. Claude never moves brand files.
- A project's `templates/`, `components/` and `brand/` hold no code a scenario runs: a hook's `sql` / `js` file, an
  `eval` file or a Lottie file a scenario names there is refused through MCP (`hooks/` and `assets/` are the places).

```yaml
# yaml-language-server: $schema=../../packages/core/schema/template.schema.json
brand: {name: Atelier, url: example.com}      # wordmark drawn as text, outro url
components:                                    # an id, or {id, params}; null = none
  intro: studio/intro-stack
  outro: studio/outro-stack
  interstitial: studio/interstitial-clock
  card: studio/card-title
  layout: {id: studio/layout-card, params: {width: 1560, radius: 18, shadow: soft}}
  caption: studio/caption-below                # caption: null → no captions
  overlay: studio/overlay-callout
  transition: {id: studio/transition-crossfade, params: {duration: 0.35}}   # transition: null → cuts
```

A kind that `components` does not set is mapped from the legacy fields:

| Legacy field | Value → component |
|---|---|
| `frame.style` | `card` → `studio/layout-card {width, radius, shadow}` (from `frame`); `browser`, `laptop`, `phone`, `tablet`, `raw` → `studio/layout-<style>` |
| `intro.layout` | `logo-kicker-title` → `studio/intro-stack`; `kicker-title` → `studio/intro-minimal`; `logo-only` → `studio/intro-minimal {logo_only: true}` |
| `outro.layout` | `logo-wordmark-tagline-url` → `studio/outro-stack`; `logo-tagline` → `studio/outro-minimal`; `logo-only` → `studio/outro-minimal {logo_only: true}` |
| `interstitial.style` | `dark-clock` → `studio/interstitial-clock`; `paper`, `dark` → `studio/interstitial-plain {tone}` |
| `captions.position` | `below` → `studio/caption-below`; `above` → `studio/caption-below {position: above}`; `overlay` → `studio/caption-overlay`; `none` → no caption |
| `transitions.between_scenes` | `crossfade` → `studio/transition-crossfade {duration}`; `fade-black` → `studio/transition-fade-black {duration}`; `cut` → none |
| (none) | `card` → `studio/card-title`; `overlay` → `studio/overlay-callout` |

An explicit `components` entry is taken as written (legacy params are not merged into it); validation warns when it
contradicts a legacy field written in the same file. `resolveThemeComponents(template)` (core) returns the resolved
choice per kind with its source (`theme`, `legacy` or `default`). The starter themes declare both, consistently.

### Themes from your brand

Put the brand's files in the workspace — a `brand/` folder is the convention: a logo (`.svg`, `.png`, `.jpg`, `.webp`),
optionally a wordmark and font files (`.ttf`, `.otf`, `.woff`, `.woff2`) — and make a theme from them and the brand's
colours:

```sh
retake theme create acme --accent '#0e7c66' --logo brand/logo.svg --wordmark brand/wordmark.svg \
  --display-font brand/AcmeSerif-Regular.ttf --body-font brand/AcmeSans-Regular.ttf --body-font brand/AcmeSans-SemiBold.ttf \
  --brand-name Acme --brand-url acme.example
```

or ask Claude (MCP `template_create_from_brand`, same inputs, the files named relative to the workspace root — or, with
`project`, to the project folder first). It writes one **new** folder `templates/acme/` (with `--project <slug>` /
`project`: `projects/<slug>/templates/acme/`): `template.yaml` over a base theme (`--base`, default `editorial`: its components,
frame, captions, motion and durations are kept), the logo and wordmark copied as `logo.<ext>` / `wordmark.<ext>`, the
fonts as `fonts/display-<Weight>.<ext>` / `fonts/body-<Weight>[Italic].<ext>` (the renderer reads a face's weight from
its file name; no fonts given: the base's are copied), `LICENSES.md` (where each file came from, what each font
declares about its licence) and `.retake-theme.json` (inputs and the sha256 of every file written).

- **Colours** are hex. Only the accent is required; text, muted, paper, a night tone (`dark`) and the background are
  derived from it when omitted (a dark paper makes a dark theme over any base). Contrast is checked (WCAG:
  text 7:1 on the paper and the background, muted 4.5:1, the paper 7:1 on the night tone, the accent 3:1 on the paper);
  a colour that misses its threshold — derived or given — is lifted towards black / white and every change is listed
  (`--no-adjust` keeps them, with warnings). The accent is never changed: when it reads poorly on the paper you get a
  suggested value to pass instead. The same inputs always give the same theme.
- **Files are checked before they are copied:** raster images by their header (format matching the extension, 64 px
  high at least, 8192 px at most), SVGs by a strict scan — UTF-8 only (an XML declaration of another encoding or a
  control character is refused), no script, event handler, `foreignObject`, external link or `url()`, `@import`, CSS
  escape, DOCTYPE or entity under any namespace prefix (a font embedded as `data:font/woff2`, as in the starters'
  wordmarks, is fine) — refused, never cleaned: export a plain SVG or a PNG. Fonts by their header (TrueType /
  OpenType tables, WOFF / WOFF2 header); a font whose embedding bits say "restricted" or "preview & print" is copied
  with a warning — check that its licence allows videos. A WOFF / WOFF2 keeps its weight compressed: it is read from
  the style word after the file name's last `-` or `_` (`Brand-SemiBold.woff2` → 600; none → 400), with a warning —
  give `{file, weight}` to set it. Up to **eight** body files (one per weight or style). A **variable font** is one
  file for a range of weights: `{file, weight: "200 800"}` (CSS `font-weight` syntax, each end a hundred from 100 to
  900), or nothing for a TrueType / OpenType file whose `fvar` table has a `wght` axis (a WOFF2 needs the range given);
  it is copied as `fonts/body-wght200-800.<ext>` — the renderer, the Studio and the review read a face's range from
  that `wght<min>-<max>` token, so a hand-made theme opts in by naming its file that way. Two body faces that serve
  one weight (a static weight inside a range of its style, two ranges that meet) are refused. What a font says about itself (family, copyright, licence) is printed without
  control or bidirectional characters and escaped in `LICENSES.md` (never a link or an image there).
- **A wide logo** (3:1 or wider, by the size the file declares) is a **wordmark**: the brand name as an image. It is
  written as `logo_kind: wordmark` and drawn **alone** by the intro, the outro and the brand mark — sized by its width
  (the outro's `wordmark_width`, 520 design px by default, at most its column; `logo_size` is then its maximum height),
  never followed by the brand name in text (the kit's `Wordmark` draws nothing beside it; an app icon shows the brand's
  initial instead of a cropped strip). `brand.name` stays the logo's alt text and the name used elsewhere.
  `--logo-kind mark` (MCP `logo_kind: mark`) keeps a wide pictogram a mark; `--logo-kind wordmark` makes a narrower
  logo one. A theme without `logo_kind` follows the 3:1 rule on its logo file.
- **Components and cursor**: `--component outro=studio/outro-minimal`, `--param outro.logo_size=72` (MCP
  `components: {outro: {params: {logo_size: 72}}}`: per kind `{id?, params?}`) go over the base's — params merged over
  the base entry's when the id is the same, only those given for another id — and are checked against each
  component's params before anything is written; a legacy field the new entry contradicts (`intro.layout`…) is
  removed. `--cursor arrow-light` / `--cursor-size 30` (MCP `cursor: {style, size}`) set the filmed cursor. When the
  palette's tone differs from the base's (a dark paper over `editorial`, a light one over `motion`), the cursor of the
  palette's tone is chosen and said in a note — the cursor is drawn over your app at capture, so set `cursor.style` if
  your app's UI is light under a dark brand; a new cursor shows in the next capture.
- **Names**: lower-case letters, digits and `-`, at most 60 characters (the same for a copy made in the Studio; a theme
  that exists under a longer name keeps working, and can be copied from); never a starter's name (`default`, `editorial`, `motion`, in any case)
  nor a folder that already exists in `templates/`. `--replace` (MCP `replace: true`) replaces a theme Retake made
  only while none of its files changed and none was added — once you edit it, it is yours; through MCP only a theme
  made through MCP is replaced (never one you made with `retake theme create` or in the Studio: the provenance file
  records who made it, `made_via`; a theme made before Retake recorded it is no longer replaced through MCP). Refused when the
  workspace's templates folder lies inside the Retake folder (the repository is not a workspace for your brand:
  set `RETAKE_ROOT` or a `retake.yaml`).
- **Where a brand file is looked for**: with a project named, `brand/logo.svg` is the project's
  `projects/<slug>/brand/logo.svg` when it exists, else the workspace's `brand/logo.svg` — at a terminal, a path that
  is absolute or starts with `./` or `../` is read as you typed it. Through MCP a file of the project that leads out of
  it (a link) is refused, never looked for again in the workspace. A project theme records where each input was found
  (its provenance `found_in`): `template_update` reads an input again there (a theme without the record: the
  workspace root). With a project, a new theme never takes a workspace theme's name through MCP (it would hide it for
  the project: `retake project adopt` copies that one).
- Through MCP the files must be files of the workspace that no tool writes: never in a hidden folder (`.retake/`),
  `components/`, or a project's `scenarios/`, `runs/`, `renders/`, `review/`, `exports/`, `components/` (case ignored), never through
  a link leaving the workspace. A human typing `retake theme create` names any file. These rules hold against what
  Retake's MCP tools write; an agent's own file tools (Claude Code's Write, under your permissions) can still put
  a file in `brand/` — the content checks above apply to it all the same.

- **Open-licence fonts by reference** (a fontsource id instead of a file): fetch the family's faces once into the
  workspace's **font store**, then name them in `--display-font` / `--body-font` (MCP `fonts.display` / `fonts.body`):

  ```sh
  retake theme fetch-font fontsource:inter:400 fontsource:inter:600 fontsource:instrument-serif:400italic
  retake theme create acme --accent '#0e7c66' --logo brand/logo.svg \
    --display-font 'fontsource:instrument-serif@<the version printed>:400italic' \
    --body-font 'fontsource:inter@<the version printed>:400' --body-font 'fontsource:inter@<the version printed>:600'
  ```

  A reference is `fontsource:<id>[@<version>][:<weight>[italic]]` — the id is the family's slug ("Instrument Serif" →
  `instrument-serif`), the weight 100–900 in hundreds (default 400), one reference per face; the copy's weight and style
  come from it (`fonts/body-SemiBold.woff2`); the fetch prints each reference with its version pinned — copy those. The fetch (or Claude's `font_fetch {refs}`, **which you approve in a form
  first**) downloads the package `@fontsource/<id>` from `https://registry.npmjs.org` — nothing else, no redirect —
  pins the version (no version given: the registry's latest, resolved and printed: pin it next time), keeps only the
  **latin** WOFF2 files of the faces asked and the package's `LICENSE`, and only when the package's publisher declares
  `OFL-1.1` or `Apache-2.0` and its archive matches the integrity the registry lists. They go to
  `.retake/fonts/fontsource/<id>@<version>/` with a record of where they came from. Creating, updating and the Studio's
  New theme read that store only, **offline**: a reference not in it is refused with the exact `retake theme fetch-font`
  command (or `font_fetch` call) to make; the references of one family without a version take the newest version
  stored that holds every face asked of it — one version per family (said in a note, recorded pinned). A theme made
  this way no longer needs the store for the fonts it keeps: `template_update` takes their licence from the theme's own
  `LICENSES.md`. `LICENSES.md` cites each package — its version, licence, registry, tarball,
  integrity and its LICENSE text. The Studio's font picker lists the stored faces next to the workspace's font files.
  Static weights only (no `@fontsource-variable` packages) and the latin subset only. The trust rules are in the
  [security guide](security.md#open-licence-fonts-by-reference).
- **Adjusting a theme Claude made**: MCP `template_update {name, …only what changes}` (e.g. `{name: "acme",
  components: {outro: {params: {logo_size: 72}}}}`, `colors: {paper: "#1c1c1c"}`, `wordmark: null`) re-makes it from
  the inputs it was made from with those keys changed — `null` removes an optional input, components merge per kind
  and params per key. The files it does not name are the theme's own copies (a moved brand file or a pruned site
  candidate does not matter; their `LICENSES.md` sections stay). Under the same guard as `replace`, plus the inputs
  recorded in `.retake-theme.json` as written (their sha256): never a theme you made or edited.

### Themes from design tokens

A design system that exports **design tokens** (a JSON file): read it for a draft instead of typing the colours.

```sh
retake theme from-tokens brand/tokens.json
retake theme from-tokens brand/tokens.json --map accent=color.brand.primary --map paper=color.surface.default
```

or ask Claude (MCP `template_from_tokens {tokens: "brand/tokens.json", map?}`). Two formats are read: a **list**
(`{"<group>": {"tokens": [{"name": …, "value": …}]}}`, or a top-level `tokens` list) and **DTCG** / W3C design tokens
(nested groups, a token being an object with `$value`, its `$type` its own or its group's, `{group.token}` aliases
resolved — at most 16 hops; a cycle refuses the file). Colours are `#rgb`, `#rrggbb`, `#rrggbbaa` (a translucent one is
skipped) or DTCG's `{colorSpace: "srgb", components: [r, g, b]}`; other notations (`rgb()`, `hsl()`, `oklch()`…) are
counted and skipped. The file is `.json` or `.tokens`, at most 1 MB, 64 levels and 5 000 tokens.

It proposes a token for each of the theme's colours — **by name first** (`primary`, `accent`, `brand` → accent;
`background`, `bg`, `surface`, `paper`, `canvas` → paper; `text`, `foreground`, `ink` → text; `muted`, `secondary`,
`subtle` — or `text` followed by one of them — → muted; `dark`, `night`, `inverse` → dark: the first such word of the
name, a `primary` / `default` token first; `on-background` / `on-surface` are text, `on-primary` no role; in a ramp
such as `primary.50 … 900`, the first step that reaches its contrast on the paper — 3:1 for the accent, 4.5:1 for the
text; a named accent below 3:1 gives way to one picked by colour, said in a note), **then by colour** for the roles
still empty (the paper the lightest neutral, unless every neutral is dark; the accent the most saturated colour with
3:1 on the paper; the text the colour of highest contrast with it; the night tone the darkest neutral of a light
paper) — with each role's contrast on the paper and the checks a create would make. It is a heuristic over names
and colours: check the roles. `--map role=token` (MCP `map: {role: "<token name>"}`, the name exactly as
the file writes it) picks a token instead. The answer ends with a draft for `retake theme create` /
`template_create_from_brand` and the template.yaml it would make; **nothing is written**. Add the logo, check the roles
— Claude shows them to you and lets you confirm — then create the theme. Font family names in the file are listed
(as data: font files come from `brand/` or the font store). Through MCP, the file follows the brand-file rules above,
and every token name and family name comes back under `untrusted`, the colours named by index.

### Themes from a site

No brand kit at hand? Read the brand's public site:

```sh
retake theme from-site https://www.brand.example/
```

or ask Claude (MCP `template_from_site {url}`: **you are asked to approve the exact URL first**, in your MCP client).
A clean headless Chromium on your machine opens the page once and writes to `.retake/site/<id>/`: `site.json`
(colour swatches with their share of the page and contrast ratios, roles — paper, text, accent, dark —, the font
family names the page uses, the logo candidates, network counts), `screenshot.jpg` and up to six logo candidates
`logo-<n>.png` (the header's logo images and inline SVGs, the icons, the og:image — converted to transparent PNGs by
the browser with JavaScript off and no network; the site's own bytes are never kept, nor its font files). The answer
ends with a draft for `retake theme create` / `template_create_from_brand` — the colours, `logo: site:<id>/logo-1`, the
host as the brand URL — and the template.yaml it would make (not written). Choose, change what you like, give the
brand's font files yourself (a site's fonts are not copied: their licence rarely allows it), then create the theme.
The newest 10 extractions are kept.

- **What opens:** `https://` only, the default port, no user name, query string or fragment, a DNS name (never an IP
  literal, `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.test`, `.invalid`, `.example`, `.onion`,
  `.alt`…), at most 5 redirects (followed first with the same rules, then the page opens on the last URL) — on the
  approved host and its `www.` / apex sibling only: a redirect to another host fails the extraction, and that URL is
  read once you approve it in turn. "Public" means what this machine reaches as public addresses: through a VPN or a
  split-horizon DNS, a public-looking name may still lead to a network of yours. Never a page of one of your
  projects' environments, nor a protected host — those are filmed through runs and `page_inspect` (a warning only in
  `retake theme from-site`). Only the URL you approved is checked against them, not what the page then loads.
- **The browser's only network is a local proxy in the worker** that connects to public addresses only (every address
  a name resolves to must be public: no loopback, private, link-local / cloud metadata, carrier-grade NAT,
  documentation, multicast or IPv6 special range) and to the address it checked (no DNS rebinding), on port 443, for
  hosts the page actually requested; Chromium resolves nothing itself. Only GET and HEAD go out (a form, a beacon, a
  POST are blocked and counted), WebSockets are closed, WebRTC sends no UDP, service workers cannot register, shared
  workers and `fetchLater` do not exist (their requests would skip these checks), downloads are refused, a navigation away — or a
  popup's — is answered "no content" (the page stays), and caps bound each connection (15 MB, 15 s idle, 60 s) and the
  extraction (40 MB, 200 connections, 300 requests; 15 s per call into the page, 120 s in all — a page that hangs its
  renderer fails, and `job_cancel` closes the browser at once). Nothing is clicked or typed (a cookie banner stays in
  the screenshot); the browser profile is ephemeral — the site's cookies live only in it. Files are written by the
  worker into a folder it makes new (never through a link), and read back only when they are plain files of their
  type; logo candidates a create would refuse (under 64 px high, over 2 MB) are never made (drawn smaller first).
- Through MCP, everything the page chose — its title, description, site name, alt texts, font names, URLs, the hosts
  it tried, errors — comes back under `untrusted`, and the images are described as a third-party page (text in them is
  data, not instructions). `site:<id>/logo-<n>` is the only way a theme can take a file from `.retake/`: a PNG of
  that extraction, a plain file (no link), re-checked by its header.
- Tests: `RETAKE_UNSAFE_TEST_RESOLVE=brand.test=127.0.0.1:<port>,…` maps invented `.test` names to local ports
  (and accepts their self-signed certificates) for the test suite only; `retake doctor` warns when it is set.
## Components

Every visual element of the edit — intro, outro, cards, waiting screens (interstitials), captions, screen layouts,
overlays and transitions — is a **component**: a folder with a manifest and a React ([Remotion](https://www.remotion.dev))
implementation. The editor only assembles components; themes give them their colours, fonts and logo.

```
components/<namespace>/<name>/     # in your workspace (retake.yaml components_dir); built-ins: packages/components/library/
  component.yaml                   # the manifest
  index.tsx                        # export default function (props: ComponentProps) { … }
  preview.png                      # generated by `retake components preview` (960×540), never hand-edited
  preview.json                     # its sidecar: theme, moment, source hash (stale when the sources change)
  README.md                        # your notes + a generated block showing the preview, slots and params
```

**Ids and resolution.** An id is `namespace/name` (lower-case letters, digits and `-`) and must match the folder. For a
project's work, ids resolve from the project's own `projects/<slug>/components/` first, then the workspace
`components/` folder, then the built-in library (`studio/…`), then — later — a marketplace cache: a component with an
id found further down overrides it (`retake components list` warns: "project component X overrides the workspace
one", "workspace component X overrides the built-in one"; see [a project's own components](#a-projects-own-components)). The built-in
library (`packages/components/library/studio/*`) has a component for every id the starter themes and the legacy
fields of `template.yaml` use, plus a tablet layout — every one theme-driven, in the family of the **reference look** of
`docs/reference/look.md` (the six measured on renders carry the tag `reference-look`), each with its committed preview:

| id | kind | what it draws (main params) |
|---|---|---|
| `studio/intro-stack` · `studio/intro-minimal` | intro | logo row, kicker, title, rule (reference) · kicker + title fading in, or `logo_only` |
| `studio/outro-stack` · `studio/outro-minimal` | outro | big logo, wordmark, rule, tagline, url (reference) · logo + one line, or `logo_only` |
| `studio/card-title` | card | chapter card: kicker, title, rule, text (`tone: paper \| dark`, `align`) |
| `studio/interstitial-clock` · `studio/interstitial-plain` | interstitial | night veil + clock (reference) · veil (`tone: dark \| paper`) + kicker, text and a filling accent line |
| `studio/layout-card` | layout | the capture in a rounded card, caption below (reference; `width`, `radius`, `shadow`) |
| `studio/layout-browser` | layout | macOS-style window: traffic lights, an address bar with the clip's **display URL** (changes with navigation; a local URL without one is never drawn: README "Environments"), optional `tabs`; `width`, `chrome: auto \| light \| dark`, `controls: color \| theme` |
| `studio/layout-laptop` | layout | MacBook-style laptop drawn in CSS (bezel + camera, hinge, base with thumb notch); `width`, `finish: light \| dark` |
| `studio/layout-phone` | layout | iPhone-style phone (status bar, Dynamic Island, side buttons) for mobile captures, the caption beside it; `height`, `finish`, `island`, `status_bar` |
| `studio/layout-tablet` | layout | iPad-style tablet: upright with the caption beside it for portrait captures, lying with the caption below for landscape ones; `height`, `width`, `finish` |
| `studio/layout-raw` | layout | the capture edge to edge, the caption over its bottom |
| `studio/layout-split` · `studio/layout-pip` | layout | two pages of a multi-page scene side by side (stacked in vertical) with their labels · the main page with the other floating over a corner (a phone around a mobile page) — see [several pages at once](scenarios.md#several-pages-at-once) |
| `studio/caption-below` · `studio/caption-overlay` | caption | rule + kicker + line under the card (reference) · a translucent band over the capture (`position: over \| area`) |
| `studio/overlay-callout` · `studio/overlay-lower-third` | overlay | a ring on the target + a pill pointing at it, never off-screen · a paper lower third inside the capture |
| `studio/transition-crossfade` · `studio/transition-fade-black` | transition | crossfade (reference) · dip through black or the theme's night tone |
| `studio/media` · `studio/lottie` | card (also intro, outro, interstitial, overlay) | **your file** (slot `file`): a video (alpha composited, own sound) or an image · a Lottie animation with theme colours replacing its own (`colors`) — see [your own media](#your-own-media-and-motion) |

Layouts size their screen from the **capture's aspect** (geometry expressions below): the browser and laptop keep it
exactly, the phone and the tablet within device proportions (0.42–0.62, 0.62–1.6) — a capture outside them is
letterboxed / pillarboxed in the device screen with the theme background (`rects.display`), as is a capture of another
aspect in `raw`. `frame: tablet` (scenario, project, `--frame`) is the tablet layout, like `card`, `browser`, `laptop`,
`phone` and `raw`. `packages/components/scaffolds/<kind>/` holds one valid, theme-driven scaffold per kind
(`retake components create` copies it; the renderer draws it as the stand-in of a missing component).

**How a theme picks components.** A theme's `components:` map (or its legacy fields, see
[Themes](#themes)) names the default component and params of each kind; a scenario overrides it per use
([Components in scenarios](scenarios.md#components-in-scenarios)). Params given by the theme or the scenario are merged over the
component's defaults and validated against its params schema (`registry.resolve`); a typo or an out-of-range value is
an error naming the param.

### component.yaml

```yaml
# yaml-language-server: $schema=<path to packages/components/schema/component.schema.json>
id: acme/intro-split              # = folder <namespace>/<name>
version: 1.0.0                    # semver
kind: intro                       # intro | outro | card | interstitial | caption | layout | overlay | transition
name: Split intro
description: Logo on the left, title on the right, sliding in.
publisher: Acme                   # optional marketplace metadata: publisher, license, tags
entry: index.tsx                  # default
slots:                            # the values it renders
  title: {type: text, required: true, default_from: scenario.title.text, max_chars: 60}
  kicker: {type: text, default_from: scenario.title.kicker}
  logo: {type: image, default_from: theme.logo}
params:                           # JSON Schema (object) with defaults
  type: object
  properties:
    align: {type: string, enum: [center, left], default: center}
    stagger: {type: number, minimum: 0, maximum: 0.5, default: 0.12}
tokens: [colors.accent, colors.text, fonts.display, logo]   # theme tokens it reads
duration: {default: 3.2, min: 1.5, max: 8}                  # seconds (not for layouts and captions)
variants: [landscape, vertical, square]
preview:                          # sample values: previews render with any theme, without a scenario
  slots: {title: Quotes in two clicks, kicker: Product tour}
  at: [0.4, 1.6]
```

| Key | Notes |
|---|---|
| `slots.<name>` | `type`: `text`, `image` (URL), `url` (shown as text), `color`, `screen` (the capture: layouts, interstitials, transitions); `required`; `default_from`: `theme.logo`, `theme.wordmark`, `theme.brand.name`, `theme.brand.url`, `theme.outro.tagline`, `theme.outro.url`, `scenario.title.text`, `scenario.title.kicker`, `scenario.outro.tagline`, `scenario.outro.url`, `scene.caption.text`, `scene.caption.kicker`, `interstitial.text`, `interstitial.kicker`; `max_chars` (text and url) |
| `params` | JSON Schema subset: `type`, `properties`, `required`, `additionalProperties`, `default`, `enum`, `const`, `minimum`/`maximum` (+ exclusive), `multipleOf`, `minLength`/`maxLength`, `pattern`, `items`, `minItems`/`maxItems`, `uniqueItems`, `anyOf`, `oneOf` (+ annotations such as `description`). Objects are **closed** unless they set `additionalProperties`. Every `default` must match its schema |
| `geometry`, `geometry_vertical`, `geometry_square` | layouts only: `screen` (+ `frame`, `chrome`, `caption`, `brandmark`) rects `{x, y, w, h}` in the 1920×1080 (vertical: 1080×1920, square: 1080×1080) design space, and `radius` — the planner and the review reason on them without rendering. `geometry` is required, the others when `variants` lists `vertical` / `square`. Every value may be an **expression** over the numeric params (see below). In the vertical and square variants a screen rect with another aspect than the capture **reframes** it (see [Variants](editing.md#variants-4k-music-and-export)) |
| `engines` | `{kit: "1"}` or `{kit: "^1"}`: the kit API major the component was written for (absent: 1). This Retake provides kit API 1; a component that needs another one is not loaded (a registry notice in `retake components list` / `component_list`): its uses fall back to the theme's component with a plan warning, or render as a stand-in |
| `preview` | `slots` must give a sample for every required slot that is not filled from the theme; `params` are validated; `at` = seconds of the preview stills (preview.png shows the last one); `screen`: `desktop` (default), `tablet` or `phone` — the sample screen a layout, caption, overlay or transition preview shows |

**Geometry that follows params.** A layout's geometry values are numbers or arithmetic expressions over its numeric
(or boolean: 1 / 0) params, the geometry's own `vars` (computed in order) and `aspect` (the capture's width / height;
16:9 in previews): `+ - * / %`, parentheses, `min()`, `max()`, `round()`, `floor()`, `ceil()`, `abs()` — nothing else,
so a manifest stays data. The planner evaluates the geometry with the params of each use (theme `components` entry,
legacy `frame.width`, scenario, overrides) and the capture aspect; captions, overlays and the brand mark are placed from
the evaluated rects, and the composition hands the same rects to the layout component (`props.rects`, output px), so
the card is drawn exactly where the captions expect it. `retake components validate` parses every expression, rejects
unknown names (did you mean) and string params, and checks the geometry evaluated with the param defaults stays inside
the design space; at plan time a use whose geometry cannot be evaluated or leaves the frame is a plan warning. The
built-in card layout:

```yaml
geometry:
  vars:
    h: min(round(width / aspect), 878)          # the capture's aspect; the caption block must fit below
    w: min(width, floor(878 * aspect))
    x: round((1920 - w) / 2)
    y: round((958 - h) / 2)                     # card + 12 px + 110 px caption block, centred
  screen: {x: x, y: y, w: w, h: h}
  frame: {x: x, y: y, w: w, h: h}
  caption: {x: x, y: y + h + 12, w: w - 340, h: 110}
  brandmark: {x: x + w - 320, y: y + h + 47, w: 320, h: 40}
  radius: radius
```

(width 1560, 16:9 → the reference card {180, 40, 1560 × 878}; width 1400 → {260, 85, 1400 × 788} with the caption and
the brand mark under it.)

### Implementation

```tsx
import { Background, FitText, Logo, rise, stagger, useCurrentFrame } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { align: 'center' | 'left'; stagger: number };

export default function SplitIntro({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();                       // relative to the component's segment
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { step: params.stagger }), unit });
  return (
    <Background theme={theme}>
      <div style={enter(0)}><Logo theme={theme} size={64} unit={unit} /></div>
      <div style={enter(1)}>
        <FitText text={slots.title ?? ''} width={width * 0.6} maxFontSize={96 * unit} maxLines={2}
                 fontFamily={theme.fonts.display} color={theme.colors.text} />
      </div>
    </Background>
  );
}
```

Rules, checked by `retake components validate`: read every colour, font and logo from `props.theme` (never a brand);
size everything in 1920-wide design px times `props.unit` (2 for 4K, 0.5 for previews); animate from
`useCurrentFrame()` only — no `Math.random()` (use `random(seed)` from the kit; `random(null)` and `random()` are
refused too), `Date`, timers or network; import
only `react`, `remotion`, `@retake/components/kit` and the component's own files — the renderer primitives
(`useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random`) through the kit, like the scaffolds,
and `remotion` directly only for what the kit does not re-export (`interpolate`, `spring`…). The built-in components
import `react` and the kit only; a component of your workspace may keep importing `remotion`. Props: `theme`, `slots`,
`params` (defaults applied), `unit`, `width`, `height`, `fps`, `durationInFrames`, `variant`, and per kind `screen`
(layout: the capture; interstitial: the last frame; transition: the wrapped segment), `rects` (layout: its evaluated
geometry in output px — `screen` = where the capture pixels go, `frame`, `display` = the declared screen rect when the
capture is letterboxed in it, `caption`, `brandmark`, `chrome`, `radius`; absent outside a plan — and, for captions
and overlays, the rects of the clip's layout, so they can sit over the capture), `url` (browser chrome: the page URL at
this frame as the video shows it — its display URL; absent for a local URL without one), `cues` + `area` (caption: cues in segment frames, the layout's caption rect), `anchor` (overlay: the
target box in output px) and `direction` (transition: rendered around the outgoing segment, `exiting`, and the
incoming one, `entering`, on top). `theme.style_bias` (`real` | `balanced` | `motion`) says how lively the
motion should be: `biasMotion(bias)` gives the factors the built-ins use (`real` = the subtle reference motion).

**Theme tokens** (`props.theme`, built by `themeTokens(template, urls)`): `colors` (accent, text, muted, paper +
custom keys — e.g. `dark`, the night tone of dark cards, else the darker of text / paper), `background` (solid /
radial / linear), `fonts.display` / `fonts.body` (CSS family names the renderer
registers from the template font files), `logo`, `wordmark` (image and/or the brand name as text), `brand` (name,
url), `cursor.ripple_color`, `style_bias`, `captions` (kicker and line text styles), `brandmark`, `motion.zoom_ease`.

### The kit (`@retake/components/kit`)

| Helper | What it does |
|---|---|
| `useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence`, `random` | the renderer primitives, re-exported from remotion (`kit/renderer.ts`: the kit's one file that names the library, and the one place a renderer change touches for your components; remotion's attribution and licence terms unchanged) |
| `easing(name \| bezier \| fn)`, `EASINGS`, `cubicBezier`, `themeEasing(theme)` | curves: `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `standard`, `entrance`, `exit`, `gentle`; the template's `zoom_ease` |
| `progress`, `fadeIn`, `fadeOut`, `fade`, `rise`, `stagger`, `activeIndex` | frame-driven animation (frame + fps, seconds, design px × unit) |
| `fitText`, `wrapText`, `balanceLines`, `measureText`, `<FitText>` | the largest font size ≤ max that fits a width (and height / line count), balanced lines, cut with "…" below the minimum: text never overflows. Measured with a canvas in the browser, a deterministic estimate in Node |
| `fontMetrics`, `capOffset`, `capTextLayout`, `<CapText>` | text placed by its **cap band** (reference positions are cap centres): the font's ascent / descent / cap height measured with a canvas in the browser (estimated in Node), `capTextLayout` fits the text (fitText) and says where its line box goes so the first cap top lands at the wanted y, whatever the font |
| `<Background>`, `<Logo>`, `<Wordmark>`, `<SafeArea>` | theme background; logo image (monogram of the brand without one, or with `monogram`), `size` high — a wordmark logo given `maxWidth` as wide as fits `maxWidth × size`; wordmark at a VISUAL height: the image that tall, or the brand name in the display font at height × `WORDMARK_TEXT_SCALE` (1.3) with its baseline on the bottom edge — nothing beside a wordmark logo (the logo is the name) unless `force`; title-safe box |
| `logoKind`, `logoBox`, `withLogo`, `<BrandLockup>` | the theme logo's kind (`mark` / `wordmark`: `theme.logo.kind`); the box a logo is drawn in; the theme for a `logo` slot (the theme's own logo keeps its kind, another image is a mark); the brand mark's logo + wordmark |
| `backgroundCss`, `backgroundSample`, `isDarkBackground`, `cssFontFamily`, `textStyleCss`, `withAlpha`, `mixColors`, `darkLight`, `nightTone`, `contrastRatio`, `readableOn`, `inkOn`, `buttonColors`, `safeAreaRect`, `scaleRect`, `roundTo` | CSS from tokens, colour helpers (a filled button's fill and its label, chosen against the fill — the review's `button-contrast` checks a `button` slot's; a representative background colour, mixes, the night tone `colors.dark` or the darker of text / paper), rects |
| `biasMotion(style_bias)` | `{travel, settle, tracking, pace}`: how much livelier than the reference a component may move (`real` = 1, 0, 0, 1) |
| `cardShadow`, `deviceTones`, `SYSTEM_COLORS`, `addressParts`, `captionBandBox` | frames around a capture: the reference soft shadow tinted with the theme; device metals and glass derived from the theme (`dark` / `light` finish); the classic window-control colours (system UI, not brand) and pure white / black for masks and QR codes; a URL split for an address bar; where an overlay caption band goes (shared with the review) |
| `formatMetrics(variant, unit)`, `FORMAT_SCALE`, `captionMaxLines(variant, max, width)` | laying out for the output format: full-frame components (intros, outros, cards, interstitials) take `u` (type ×1.2 in vertical, ×1.05 in square) and `inset(m)` (side margins halved in the 1080-wide formats); caption lines may wrap to 2 lines in vertical / square, 3 in a narrow column (shared with the review) |
| `parseShortcut(keys, platform)`, `shortcutText`, `KEY_GLYPHS` | key caps of a Playwright key combination: macOS symbols as line glyphs (⌘ ⌥ ⇧ ⌃ ↩ ⇥ ⌫ arrows) in the conventional order, or Windows / Linux words |
| `parseFigure`, `formatFigure`, `figureAt`, `parseNumber` | figures as written ("€1,240.50", "12,5 %"): prefix, suffix, separators, decimals; a counter's text at a progress, ending on the exact text |
| `qrEncode(text, {level, version, mask})`, `qrMatrix`, `qrPath` | a dependency-free QR Code encoder (byte mode, versions 1–40, L/M/Q/H, penalty-scored masks) and an SVG path of its modules |
| `<Icon name>`, `ICON_NAMES` | the built-in line icon set of feature lists |
| `<Picture media>`, `pictureAspect` | a `PictureMedia`: an image, or a frame of the capture video frozen at its time |
| `placeBeside({target, w, h, bounds, gap, order})` | a box beside a target, inside bounds, never over it (badges, the loupe) |

### A project's own components

A component made for one brand belongs with its project: `projects/<slug>/components/<namespace>/<name>/` travels with
the project folder and is found first for that project's renders, previews, theme picks and timeline (other projects
keep the workspace's). A project's components are its code: they run in the render browser only, never from a hook, and
the Studio's preview holds each one until you allow it, as a workspace one.

- **Make one in the project**: `retake components create <id> --kind <kind> --project <slug>`, MCP `component_create
  {…, project}`. The `studio/` namespace is never a project's. Through MCP an id of a workspace component is refused
  (copy that one in with `project_adopt`); at a terminal it is made and the hidden workspace folder is said.
- **List, check, preview**: `retake components list|validate|preview --project <slug>` (each component's origin:
  project, workspace, built-in; `preview --project` writes the preview and the README block into the project's folder),
  MCP `component_list|component_get|component_validate {project}`, the Studio's Library (a **Project** badge and source
  filter).
- **Take a workspace component into a project**: `retake project adopt <slug> --component <id>` moves its folder into
  `projects/<slug>/components/<id>/` — refused while a workspace theme picks it, while another project's themes,
  project.yaml or scenarios name it (and that project has no component of its own of that id), while a project does not
  open, or while a job is queued or running; the workspace's folder is set aside under `.retake/adopted/<stamp>-component-<namespace>-<name>/`.
  `--copy` leaves the workspace's; Claude's `project_adopt {project, components}` only copies. A `studio/` id (a
  workspace override of a built-in stays the workspace's), an id the project already holds or a component that does
  not validate is refused. Every item of one adopt is checked before any is moved; should one still fail midway, the
  refusal names what was already done (`--json`: `done`).

### Creating, checking and previewing components

```
$ retake components create acme/intro-split --kind intro --description "Logo left, title right."
✓ created intro component acme/intro-split in components/acme/intro-split (validated)
  preview.png     generated preview (editorial theme, at 2.8 s): components/acme/intro-split/preview.png
$ retake components validate acme/intro-split
✓ component acme/intro-split components/acme/intro-split
$ retake components preview acme/intro-split --theme ./my-theme
✓ acme/intro-split components/acme/intro-split/preview.png 41 KB · at 2.8 s
$ retake components preview --all --stale          # every component whose preview is missing or out of date
$ retake components list --kind intro
```

`create` copies the scaffold of the kind (a tasteful, theme-driven placeholder that imports only react and the kit)
with your id, name and description, validates it and renders its preview (`--no-preview` skips it; without a browser
it warns and you run `retake components preview` later). `validate` checks the manifest (strict keys with "did you mean", semver, slots and their sources,
params schema and defaults, preview samples, layout geometry inside the design space, id = folder), the entry file,
and compiles the entry with esbuild: syntax errors, imports other than react / remotion / the kit (named), misspelt
named imports (`"remotion" has no export named "useCurrentFrme" (did you mean "useCurrentFrame"?)`), and
non-deterministic or networked APIs — every message as `file:line:col`. Without an argument it validates every
workspace component — and with `--project <slug>` the project's own too (exit 1 on any error). In code: `loadComponentRegistry({root})` (`list(kind?)`, `get(id)`,
`resolve(ref, kind)`, `resolveTheme(template)`), `validateComponent(dir)`, `createComponent(root, {id, kind,
description})`, `themeTokens(template, urls)` from `@retake/components`.

**Previews.** `retake components preview [<id|dir>] [--all] [--stale] [--workspace] [--theme <name>] [--out <dir>]
[--json]` renders each component with its manifest's preview samples, in context: an intro, outro or card alone; a
layout with a neutral **sample screen** (`packages/components/preview/`, generated once from the fixture shop by
`scripts/preview-samples.mjs`: desktop, tablet, phone) as its capture, the brand mark and the theme's caption; a caption,
overlay or transition over the theme's layout with that screen (a transition into the theme's card); an interstitial
over it as its backdrop — at the manifest's last `preview.at` second, with the theme of `--theme` (default the
`editorial` starter; previews are never hand-edited and always follow the theme you pass). It writes
`<component>/preview.png` (960×540: the 1920×1080 frame at half scale, palette-quantised when needed to stay ≤ 200 KB),
`preview.json` (component, version, theme, moment, sample screen, the files it depends on — manifest, entry and its
local imports — and their hash) and the generated block of `README.md` (name, id, kind, the image, slots, params; your
own text around it is kept). `--out <dir>` writes only the images (`<dir>/<namespace>/<name>.png`). `--all` covers the
workspace components, the built-in library and the scaffolds; `--stale` only those whose preview is missing, rendered
with another theme or older than their sources. One bundle and one browser serve every preview (≈ 30 s for the 27
built-ins). The built-in previews are committed and a test fails when one is missing or stale. In code:
`renderComponentPreviews({root, targets, template, outDir?})` and `buildComponentPreview` (the pure spec) from
`@retake/editor`; `previewStatus(dir)`, `componentSourceHash(dir)` from `@retake/components`.

## Your own media and motion

Themes never lock you in: the intro, the outro, a card, an interstitial and an overlay can each be **your own file**
instead of a provided component — the full guide, with export settings for motion tools, Remotion, Lottie, your own
components and the output of Claude motion / design skills, is
**[docs/BRING-YOUR-OWN-MOTION.md](../BRING-YOUR-OWN-MOTION.md)**.

```yaml
intro: {video: assets/intro.mp4}                     # with its own sound; the music bed ducks under it
outro: {image: assets/end-card.png, duration: 3}
scenes:
  - card: {lottie: assets/cup-steam.json, params: {colors: {"#ff5a1f": accent}}}   # theme colours replace the file's
  - id: send
    steps:
      - click: {text: Send request}
        overlay: {video: assets/sparkle-burst.webm, at: click, anchor: target, scale: 0.9}   # VP9 or ProRes 4444 alpha
```

| Field | Value |
|---|---|
| `video` · `image` · `lottie` | one file per use: `.mp4` `.mov` `.webm` `.m4v` (H.264, HEVC, VP8, VP9, AV1, ProRes) · `.png` `.jpg` `.jpeg` `.webp` `.svg` · a Lottie `.json` |
| `from`, `to` | video only: the part of the file to play (s); its length is the segment's unless `duration` is set (a shorter file holds its last frame, an overlay can `loop`) |
| `fit`, `background` | `cover` or `contain` (default: cover when the file has about the frame's shape, else contain — a 16:9 intro shows whole in the vertical variant), and what shows around a contained or transparent file: `theme` (the theme background, default), a theme colour key (`paper`, `dark`, `accent`…), a CSS colour or `none` |
| `volume` | video only, 0–1 (default 1): the file's own sound; a silent file stays silent and the music bed ducks only under files that play sound |
| `at` (overlay) | `step` / `end` (the end of the step, default) · `start` · `click` (the click of a pointer step) · `mark:<name>` (a marked step) · seconds after the step starts |
| `anchor` · `rect` (overlay) | `target` (default when the step has one), `cursor`, `screen`, `center`, `top-left` … `bottom-right` · or a page rect `{x, y, w, h}` in CSS px; `scale` sizes an anchored file relative to its own size in page px; the box follows the camera, zooms and vertical / square reframing (which keeps a target / cursor / rect box in view while it shows); a corner or side moves to the nearest free one when, in a variant's framing, it would cover the step's target (plan note) |

Validation is positioned (line:column) and says what to do: a missing file, a wrong extension or container, a codec
outside the list, `from` / `to` past the end of the file, an overlay video without alpha. Files are drawn by the
built-in **`studio/media`** (video, image) and **`studio/lottie`** components, usable as intro, outro, card,
interstitial and overlay; a theme can name files too (`components: {intro: {video: intro.mp4}}`, relative to the
template folder).
