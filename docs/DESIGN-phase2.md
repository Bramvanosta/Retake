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
parseManifest(text, file?, { folderId? }): { manifest?, issues: ComponentIssue[] }   // strict zod schema + semantic checks
validateComponent(dir): Promise<ComponentIssue[]>   // manifest, id = folder, entry exists, params schema + defaults,
//  preview samples fill required slots, layout geometry, esbuild compile (imports: react, remotion, the kit and own
//  files only; misspelt named imports; Math.random/Date/fetch/timers) — every issue {file, line, col, path, message}
createComponent(root, { id, kind, description, name? }): Promise<CreatedComponent>   // from scaffolds/<kind>/, validated
themeTokens(template: LoadedTemplate, urls: { logo?, wordmark?, fonts? }): ThemeTokens
fillSlots(manifest, given, ctx): { slots, from, missing, tooLong, unknown }   // default_from sources (planner, previews)
```
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
`DemoVideo` / `DemoVertical` (Remotion) take `{ plan }` and render only the plan: background, one Sequence per segment
with its fade envelope, the segment component, for clips the layout component with `screen` = `<Freeze
frame={srcFrames[f]}><OffthreadVideo/></Freeze>` under the camera transform, the caption component and overlays,
brandmark, optional music bed. Components are imported through a GENERATED registry module (built-in + workspace
component entries) so user components are bundled too; the bundle is cached under `<root>/.demo-studio/cache/` keyed by
a hash of editor + component sources. Assets (capture, fonts, logo, music) are served by a local static HTTP server
during the render. Browser: `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL` or Playwright's chromium headless shell.

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
