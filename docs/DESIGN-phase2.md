# Demo Studio — phase 2 contracts: components, themes, editor, review

Types: `packages/components/src/types.ts` (component contract), `packages/editor/src/plan-types.ts` (EditPlan),
`packages/core/src/types.ts` (scenario, timeline, template — and `ComponentKind`, `COMPONENT_KINDS`, `ComponentRef`,
which `@demo-studio/components` re-exports: core is their single source of truth). Reference look: `docs/reference/look.md`.
Product rules: docs/SPEC.md §0, §9–§12.

## 1. Components (`packages/components`)

Every visual element is a component (SPEC §11). Nothing visual is hard-coded in the editor.

### 1.1 Layout of a component
```
<namespace>/<name>/
  component.yaml      # ComponentManifest (id, version, kind, name, description, slots, params JSON Schema,
                      # tokens, duration, geometry for layouts, preview samples, publisher/license/tags)
  index.tsx           # default export: React.FC<ComponentProps<P>> (Remotion; useCurrentFrame is segment-relative)
  previews/           # generated: <theme>.png (+ .mp4) — never hand-edited
  README.md           # optional
```
Rules for implementations: read every colour/font/logo from `props.theme`; size everything with `props.unit`;
deterministic (no Math.random/Date); no network; may import only `react`, `remotion` and
`@demo-studio/components/kit` (shared helpers: fades/rises/stagger, easing presets, fitText, Logo, Wordmark,
background renderer, safe-area helpers). Text slots must never overflow: fitText shrinks within bounds.

### 1.2 Built-in library (`packages/components/library/studio/*`), theme-agnostic
| id | kind | notes |
|---|---|---|
| studio/intro-stack | intro | logo + wordmark row, kicker, display title, accent rule; staggered entrance (reference look) |
| studio/intro-minimal | intro | title only, fade |
| studio/outro-stack | outro | big logo, wordmark, rule, tagline, url; staggered (reference look) |
| studio/outro-minimal | outro | logo + tagline |
| studio/card-title | card | chapter/title card (kicker + title) |
| studio/interstitial-clock | interstitial | dark overlay over the dimmed last frame, animated clock, text (reference look) |
| studio/interstitial-plain | interstitial | paper/dark card with text |
| studio/layout-card | layout | capture in a rounded card with soft shadow on the theme background, caption area below, brandmark (reference look: 1560 wide) |
| studio/layout-browser | layout | card + macOS-style browser chrome with the real URL |
| studio/layout-laptop | layout | MacBook-style mockup |
| studio/layout-phone | layout | iPhone-style mockup for narrow captures |
| studio/layout-raw | layout | capture fills the frame |
| studio/caption-below | caption | accent rule + uppercase kicker + display line, crossfade/rise between cues (reference look) |
| studio/caption-overlay | caption | translucent band over the capture (for raw/motion) |
| studio/overlay-callout | overlay | pill/callout with an arrow pointing at a target bbox |
| studio/overlay-lower-third | overlay | lower third (title + subtitle) |
| studio/transition-crossfade, studio/transition-fade-black | transition | |

Since L2.4 every id above exists; since L2.5 the six reference-look components (intro-stack, outro-stack, layout-card,
caption-below, interstitial-clock, transition-crossfade; tag `reference-look`, version 1.x) reproduce
`docs/reference/look.md` — positions measured on real renders by `packages/editor/test/render-look.test.ts` — and the
others are theme-driven **placeholders** (tag `placeholder`) until L2.7.

Reference-look rules shared by the six (all values design px × unit, every colour/font/logo from the theme):
- **Text is placed by its cap band** (`capTextLayout` + `<CapText>` in the kit): look.md positions are cap centres;
  the kit measures the font (canvas: cap height, ascent, descent) and puts the line box where the caps land on the
  wanted y, whatever the font. Intro and outro build a vertical rhythm of bands (logo row, kicker caps, title caps →
  baseline, rule, tagline, url) with the measured gaps and centre the whole stack, so a missing kicker or a two-line
  title stays balanced while the full stack lands on the reference positions.
- **Wordmark**: a visual height (image height; the brand name in the display font at height × 1.3 when the theme has
  no wordmark image — R-LOOK-22): intro 33, brand mark 24, outro 71.
- **Night tone** of dark cards and veils: `colors.dark` when the theme defines it, else the darker of text / paper
  (editorial: its ink `#1f1413`; motion: its paper `#11131c`); the clock ring is the night tone mixed 25 % towards
  the paper (editorial → `#544b48`; the reference measures `#544846`).
- **Readability guard**: colours that would not read on the theme background (contrast) fall back to the dark/light
  pair of the theme.
- **style_bias** (R-TPL-04): `biasMotion(bias)` → `real` = the reference motion; `balanced` / `motion` = more rise
  (×1.5 / ×2), a small scale settle (logo row, clock, crossfade 1–2 %), a tracking settle on the intro title, the
  caption rule and the clock ring draw themselves. The card layout is static at every bias (a frame never moves on its
  own).
- **Captions at clip edges**: a caption whose cue starts at the clip start enters 0.15 s late and one that ends with
  the clip leaves 0.15 s early, so two captions never double-expose in the middle of a crossfade; inside a clip, cue
  changes are back to back (out 0.25 s, in 0.35 s with a 7 px rise) and a kicker shared by contiguous cues stays.

### 1.3 Registry (`@demo-studio/components`, implemented in L2.2)
```ts
loadComponentRegistry(opts: { root: string /* workspace */; componentsDir?; builtinDir? | null }): Promise<ComponentRegistry>
//  scans <components_dir>/<ns>/<name>/component.yaml (studio.yaml components_dir, default <root>/components) then
//  packages/components/library/<ns>/<name>/; workspace ids override built-ins (warning notice); invalid folders are
//  kept out of list() and reported in `notices` (get/resolve throw with their positioned issues)
ComponentRegistry = {
  list(kind?): ComponentInfo[]; has(id); get(id): ComponentInfo /* ComponentError: not found + did you mean | invalid */;
  resolve(ref, kind): ResolvedComponentRef  /* {id, version, kind, params (schema defaults under the given params,
                                               validated), manifest, dir, entry, source}; kind mismatch → error */;
  resolveTheme(template): Record<ComponentKind, ResolvedComponentRef | null>  /* via core resolveThemeComponents */;
  notices: RegistryNotice[]; componentsDir; builtinDir?
}
ComponentInfo = { manifest: ComponentManifest; dir: string; entry: string /* abs */; source: 'workspace' | 'builtin' }
evalLayoutGeometry(spec, params, { aspect? }): LayoutGeometry   // geometry expressions → design px (see below)
parseManifest(text, file?, { folderId? }): { manifest?, issues: ComponentIssue[] }   // strict zod schema + semantic checks
validateComponent(dir): Promise<ComponentIssue[]>   // manifest, id = folder, entry exists, params schema + defaults,
//  preview samples fill required slots, layout geometry, esbuild compile (imports: react, remotion, the kit and own
//  files only; misspelt named imports; Math.random/Date/fetch/timers) — every issue {file, line, col, path, message}
createComponent(root, { id, kind, description, name? }): Promise<CreatedComponent>   // from scaffolds/<kind>/, validated
themeTokens(template: LoadedTemplate, urls: { logo?, wordmark?, fonts? }): ThemeTokens
fillSlots(manifest, given, ctx): { slots, from, missing, tooLong, unknown }   // default_from sources (planner, previews)
```
**Geometry expressions (L2.5).** A layout's geometry may follow its params: every value of `geometry` /
`geometry_vertical` (rect `x`, `y`, `w`, `h`, `radius`) is a number or an arithmetic expression over the component's
numeric/boolean params, the geometry's `vars` (named values, computed in order) and the built-in `aspect` (capture
width / height; 16:9 when unknown). Grammar: numbers, identifiers, `+ - * / %`, unary minus, parentheses, `min`,
`max`, `round`, `floor`, `ceil`, `abs` — a manifest stays data (no component code runs in Node; the planner, the
review, the validator and later the Studio UI evaluate it). Chosen over a geometry function exported by the component
(it would execute workspace — later marketplace — code in the planner and make planning async) and over one geometry
per param value (does not scale to numbers). Contract:
- `parseManifest` checks every expression (syntax with position, unknown names with did-you-mean, string params, vars
  shadowing a param, `aspect` as a var) and the geometry evaluated with the param defaults (positive sizes, inside the
  design space); the JSON Schema accepts `number | string` (`GeometryValue`).
- `planEdit` evaluates the geometry of each layout use with its resolved params and the capture aspect
  (`evalLayoutGeometry`), then fits the capture as before (`planLayout`); a use whose geometry cannot be evaluated
  falls back to the default geometry with a warning, one that leaves the frame is a warning. `geometry.radius` wins
  over a `radius` param.
- The composition passes the evaluated layout to the layout component as `props.rects` (output px: `screen` = where
  the capture goes, `frame` = the card / device outline, `caption`, `brandmark`, `chrome`, `radius`), so the component
  never re-derives the geometry; without `rects` (unit previews) a layout falls back to its default geometry
  (layout-card's `defaultRects`, tested equal to its manifest).
- studio/layout-card: `width` sizes the card, its height follows the capture aspect (≤ 878 so the caption block
  fits), the card + 12 px + 110 px caption block is centred vertically, the caption rect is the card's left part
  (width − 340) and the brand mark rect the card's right 320 px: width 1560 at 16:9 → card {180, 40, 1560 × 878},
  caption {180, 930, 1220 × 110}, brand mark {1420, 965, 320 × 40} (look.md); width 1400 → {260, 85, 1400 × 788}.

`packages/components/scaffolds/<kind>/` are valid, theme-driven components (`scaffolds/<kind>` ids) used by
`createComponent` and, as stand-ins, by the render pipeline until the library lands. Props added for kinds that need
them: `area` (caption: the layout's caption rect), `anchor` (overlay: target box in output px), `direction`
(transition: `exiting` around the outgoing segment, `entering` around the incoming one, drawn on top; `screen` = the
wrapped segment). The kit (`@demo-studio/components/kit`) is documented in the README, section "Components".

### 1.4 Themes (templates) pick components
Template gains (additive, core types + `TemplateSchema` / `TemplateFileSchema`):
```yaml
brand: { name: Atelier, url: example.com }          # used by wordmark-as-text, outro url
components:                                          # defaults per kind (string id or {id, params}); null = none
  intro: studio/intro-stack
  outro: studio/outro-stack
  interstitial: studio/interstitial-clock
  card: studio/card-title
  layout: { id: studio/layout-card, params: { width: 1560, radius: 18, shadow: soft } }
  caption: studio/caption-below                      # null = no captions
  overlay: studio/overlay-callout
  transition: { id: studio/transition-crossfade, params: { duration: 0.35 } }   # null = cut
```
Component ids match `COMPONENT_ID_RE` = `/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/` ("namespace/name"). The pure
helper `resolveThemeComponents(template): Record<ComponentKind, {id, params, source: 'theme'|'legacy'|'default'} | null>`
(core) applies, per kind: the `components` entry as written (`null` = none; legacy params are NOT merged into an
explicit entry) → the legacy field mapping → the built-in default.

| Legacy field | Value → component |
|---|---|
| `frame.style` | card → `studio/layout-card {width, radius, shadow}` (from `frame`); browser / laptop / phone / raw → `studio/layout-<style>` (no params yet: their params schemas come with L2.7, which may map `frame.width/radius/shadow` too) |
| `intro.layout` | logo-kicker-title → `studio/intro-stack`; kicker-title → `studio/intro-minimal`; logo-only → `studio/intro-minimal {logo_only: true}` |
| `outro.layout` | logo-wordmark-tagline-url → `studio/outro-stack`; logo-tagline → `studio/outro-minimal`; logo-only → `studio/outro-minimal {logo_only: true}` |
| `interstitial.style` | dark-clock → `studio/interstitial-clock`; paper / dark → `studio/interstitial-plain {tone}` |
| `captions.position` | below → `studio/caption-below`; above → `studio/caption-below {position: 'above'}`; overlay → `studio/caption-overlay`; none → null |
| `transitions.between_scenes` | crossfade → `studio/transition-crossfade {duration}`; fade-black → `studio/transition-fade-black {duration}`; cut → null |
| (none) | card → `studio/card-title`; overlay → `studio/overlay-callout` (source `default`) |

Validation of template.yaml warns when a `components` entry contradicts a legacy field written in the same file
(the entry wins, so editing the legacy field would change nothing). The starter templates (default, editorial,
motion) declare `brand` (fictional) and an explicit `components` map consistent with their legacy fields (tested).
`FRAME_STYLE_LAYOUTS` (core) maps each FrameStyle to its built-in layout id.

### 1.5 Scenario additions (additive, core types + schema)
- `intro: false | { component?, params?, duration? }`, `outro: false | { component?, params?, tagline?, url?, duration? }`
- `interstitial: { text, kicker?, duration?, style?, component?, params? }` (`style` = legacy override, ignored with
  `component`: warning)
- new scene entry `card: { component?, params?, slots?: Record<string,string>, duration? }` + optional `id` (default
  `card-<index>`); takes no capture time; needs `component` or `slots.title` (error otherwise)
- `frame:` on a project, scenario or scene accepts a FrameStyle (`card` ⇒ studio/layout-card …) or a layout component
  id (`FrameSpec`); the project default stays `card`
- step modifier `overlay: { component, slots?, params?, duration? (0 < d ≤ 30 s), target?: TargetSpec }`
- ids are unique across scenes, cards and interstitials, default ids included; every duration is > 0
- runner: cards are recorded in `timeline.scenes` (`kind: 'card'`, `card: {component?, params?, slots?, duration?}`,
  `t_start === t_end`); a step with `overlay` records `event.overlay = {component, slots, params, duration?, target?,
  bbox? | point?}`, the anchor measured at the END of the step (after any scroll): the `target` element if given, else
  the step's own target box as the action reports it, else the cursor position (a target not found → cursor + a
  warning). `camera` targets follow the same rule (tested on the SPEC example: scroll to "Awards" with a camera on
  "Awards" records the post-scroll box).
- `Timeline.video = { title?, intro?, outro?, frame?, template?, music? }` (`timelineVideo()` in core): the scenario's
  edit info as written, the effective default `frame` (scenario, else project) and the template the run used — the
  editor never re-reads scenario.yaml. Optional in the schema so older timelines stay valid.

## 2. Editor (`packages/editor`)

```ts
planEdit(input: { timeline; template: LoadedTemplate; project; registry: ComponentRegistry; captureFile: string;
                  scenario?; overrides?: EditOverrides }): EditPlan   // PURE + deterministic, unit-tested (L2.3)
//  scenario = optional context (edit info of timelines without a `video` block); overrides.theme: the caller loads
//  that template and passes it as `template`. Plan types grew additively (see plan-types.ts): PlanTransition per
//  segment, clip cues/layout/src/speeds/trims/zooms/heldFrames, OverlayUse.anchor (source px), PlanLayout.crop,
//  ResolvedComponent.missing, plan.assets (`ds-asset:` URL → file, swapped by resolvePlanAssets) and plan.meta.
renderVideo(opts: { project; run /* id or dir */; scenario?; template?; overrides?; out?; onProgress?; signal?;
                    concurrency? }): Promise<RenderRecord>
//  renders/<scenario>-v<N>.mp4 (+ "-vertical") and renders/<scenario>-v<N>.json (RenderRecord incl. plan + overrides)
renderStill(opts: { plan; frame; out }): Promise<string>
renderStills(opts: { plan; frames: Array<{ frame; out }> }): Promise<string[]>   // one browser session for all frames
previewComponent(opts: { component: string; template: LoadedTemplate; slots?; params?; out_dir; video?: boolean }): Promise<string[]>
previewTemplate(opts: { template; out_dir }): Promise<string[]>   // intro, clip with caption over a placeholder screen, interstitial, outro
exportRender(opts: { project; render; formats: ExportFormat[] }): Promise<ExportResult>
//  'mp4_1080p' | 'mp4_4k' | 'webm' | 'vertical_9x16' | 'gif_preview'
listRenders(project): Promise<RenderRecord[]>
```

### 2.1 Planner rules (SPEC §9 + reference look)
- Order: intro (unless disabled) → scenes / cards / interstitials in scenario order → outro. Every segment carries its
  ResolvedComponent: override by segment id → override by kind → scenario → theme → built-in default.
- Scene source range: from the end of the scene's page load (`scene_still`.t_start, else `scene_open`.t_end, else
  scene.t_start) to scene.t_end (includes trailing holds). Page loads are never shown.
- Transitions: scenes NOT contiguous in the capture (page load or any gap) use the theme transition (crossfade 0.35 s:
  outgoing clip holds its last frame while the incoming one fades in). Scenes contiguous on the same page are joined
  with NO transition (only the caption changes; camera continues). Intro→first scene and last scene→outro use the theme
  transition. Interstitials: backdrop = dimmed last frame of the previous clip (`backdropSrcFrame`), fade in/out.
- Speed: scene speed (overrides.speeds wins), step speed for its span; always 1×: the opening still, every hold
  (action and modifier), ±0.6 s around a marked step through its hold end. Speed changes are ramped over ~0.3 s.
- Idle trimming: the part of a timeline.idle interval outside the protected spans (still, hold, mark window), when
  longer than `idle_threshold` (1.2 s), is shortened to 0.4 s (0.2 s kept on each side of the cut). Nothing changes on
  screen during idle, so the trim is invisible.
- Camera: static by default. Zooms only from step `camera` hints: zoom clamped to theme max_zoom, focus = event
  camera bbox centre (else point, else cursor), eased with the hint's `ease` (else the theme zoom_ease) from the
  step's output start over max(0.8 s, duration) of OUTPUT time (duration defaults to the step's output length),
  held until `until` (default scene end), same easing out; the view is clamped so the capture always fills the screen
  rect; no reset at same-page joins.
- Captions: scene caption from the scene's first visible frame to its end; a step caption replaces it from the step's
  output start; cues never overlap. Rendered by the clip's caption component in the layout's caption rect.
- Overlays: from step `overlay` modifiers (`event.overlay`), shown from the step's output end for `duration` (else the
  component's default), anchored on `overlay.bbox` (else `overlay.point`) mapped through layout + camera.
- Provenance: every clip segment lists `steps` (output frame spans per scenario step) and the plan keeps markers and a
  time map — used by review, the Studio timeline and frame comments.
- Output: 1920×1080 × scale (capture scale 2 ⇒ 4K); vertical 1080×1920 uses `geometry_vertical` and a crop following a
  smoothed cursor/target track.

### 2.2 Composition & rendering
`DemoVideo` / `DemoVertical` (Remotion, `packages/editor/src/remotion/`) take `{ plan }` and render only the plan:
background, one Sequence per segment with its transition component (or, without one, its plain fade envelope), the
segment component, for clips the layout component with `screen` = the capture frame `srcFrames[f]` under the camera
transform and `rects` = the clip's PlanLayout in output px, the caption component (cues, `area` = the layout's
caption rect) and overlays (anchor mapped per frame with `mapSourceRect`), the brand mark (theme logo + wordmark in the layout's `brandmark` rect — layouts do not draw it),
optional music bed. Interstitials receive the previous clip's last frame (layout + capture + brand mark) as `screen`.
Transitions render twice: a crossfade over the overlap of the two segments (both see transition frames [0, n)), a dip
without overlap (frames [0, ⌊n/2⌋) at the end of the outgoing segment, [⌊n/2⌋, n) at the start of the incoming one).
The capture frame is an `OffthreadVideo` inside a `Sequence` shifted to that frame — not `<Freeze
frame={srcFrames[f]}>`: Remotion clamps a frozen timeline position to the composition length, so a capture frame
index past the end of the edit would show the wrong frame. Theme fonts are registered with FontFace (delayRender)
before anything is drawn; uses marked `missing` render with the scaffold of their kind. Components are imported through
a GENERATED registry module (the plan's component entries, built-in or workspace, + the scaffolds) so user components
are bundled too; the bundle is cached under `<root>/.demo-studio/cache/remotion-<hash>/` keyed by a hash of the
composition sources, the kit, the bundled component folders and the Remotion version. Assets (capture, fonts, logo,
music) are served by a local static HTTP server (127.0.0.1, Range, CORS) during the render. Browser:
`$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL` or Playwright's chromium headless shell. Output: H.264 CRF 16, yuv420p BT.709,
faststart, always an audio track (silent AAC without music); the video is encoded under a temporary name and renamed,
so a failed or cancelled render leaves nothing under the final name.

## 3. Review (`packages/review`)

```ts
reviewRender(opts: { project; render: string; fps?: 1 | 2; previous?: string | false }): Promise<ReviewResult>
```
Writes `review/<render-id>/`: `sheet_<fps>fps.jpg` (+ pages), `sheet_scene_<id>.jpg`, `keyframes/<marker>.png`
(+ scene first/last), `timeline.json` (output-time: segments with components, captions, markers, step spans),
`report.json`, `report.md`; returns ≤1280 px JPEG thumbnails (base64) for the MCP. Checks: durations; blank/near-uniform
frames in the screen rect and at scene starts; caption/scene mismatch, overlaps, captions too long for their area;
text slot overflow; cursor off-screen or outside the zoomed view at clicks; scenes > 30 s at ~1×; zoom count and resets
at same-page joins; transitions overlapping a click; diff vs the previous render. Findings:
`{ severity, code, message, at?: { frame, time, segment, scene, step } }`; `clean` = no error/warning.

Implemented in L2.6 (`packages/review/src/`; options also `scenario?` with `latest`, `thumbnails?: false | 'sheets' |
'all'`, `thumbnail_px?` ≤ 1280, `rules?` = thresholds, `sheet?` = grid, `out?`):
- **Inputs**: the RenderRecord (its plan is the truth: segments, evaluated layout rects, cues, step spans, camera,
  srcFrames, markers), the video, the run's `timeline.json` (clicks, cursor track, captions as captured; optional) and
  the capture (scene starts; optional). Spans: a segment is "visible" over `[from, next.from)` (a crossfade counts with
  the incoming segment); `clearFrom/clearTo` exclude the transition windows (`transitionWindows`).
- **Frames**: one ffmpeg pass per video with a `select` on exact frame numbers, raw RGB streamed with back-pressure
  (`extractFrames`): the render (contact sheet samples at the middle of each 1/fps interval, 2 fps scene samples, key
  frames, the opening-still pair of each clip), the capture (first frame of each clip + capture frames behind blank
  samples), the previous render (same segment, same offset). sharp makes tiles, sheets (labels in one SVG per page) and
  key frames; statistics are plain JS on the RGB buffers (share of pixels near the median colour, luminance sd, 96×54
  luminance signatures).
- **Text widths** use the theme's real font files (`fonts.ts`: cmap + hmtx of TTF/OTF/WOFF, no kerning) with the kit's
  `fitText` (now exported from `@demo-studio/components`), so "too long" matches what the caption component draws.
- **Severities**: video length outside 1–2 min = info within ±25 % (45–150 s), warning beyond (the range is a style
  target measured on two reference videos); scenes outside 4–25 s = info, < 2 s = warning; > 30 s at 0.85–1.2× =
  warning; blank screen ≥ 1 s or at a scene start = error; caption cut = error, shrunk below 85 % = warning; cursor off
  screen / outside the zoomed view at a click = error; more than one zoom = warning; transition over a click = warning;
  diff findings are info. Added beyond the brief: `long-wait` (an unchanging screen ≥ 3 s while the scenario waits —
  wait steps and the time after an action until the next step, holds excluded: catches loading skeletons that idle
  trimming cannot), `loading-scene-start` (the screen changes during the opening still), `empty-segment`,
  `caption-not-visible`, `caption-overlaps-brandmark`, `camera-jump`.
- **Output** is written to `review/<id>.tmp-*` and swapped in, so a review never mixes pages of two runs.

## 4. Frame comments (data model now, UI in phase 4, MCP tools in phase 3)

`<project>/comments/<scenario>.json`:
```ts
interface FrameComment {
  id: string; scenario: string; render_id: string; frame: number; time_s: number;
  region?: { x: number; y: number; w: number; h: number };      // normalised 0..1 of the output frame
  text: string; author: string; created_at: string;
  status: 'open' | 'resolved';
  anchor: { segment: string; kind: string; component?: string; scene?: string; step?: number; step_id?: string;
            src_time_s?: number };                              // computed from the plan provenance
  replies: Array<{ author: string; text: string; created_at: string }>;
  resolution?: { by: string; note: string; render_id?: string };
}
```
