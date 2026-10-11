# Demo Studio — phase 2 contracts: editor & review

Types: `packages/editor/src/plan-types.ts` (EditPlan & co.) on top of `packages/core/src/types.ts`.

## 1. @demo-studio/editor

```ts
planEdit(input: {
  timeline: Timeline; scenario: Scenario; template: LoadedTemplate; project: LoadedProject;
  captureFile: string;              // absolute path of capture.mp4
  overrides?: EditOverrides;
}): EditPlan                         // PURE: no I/O, deterministic, unit-tested

renderVideo(opts: {
  project: LoadedProject; run: string /* run id or dir */; scenario?: LoadedScenario /* default: runs/<id>/scenario.yaml */;
  template?: LoadedTemplate;         // default: scenario.template ?? project.config.template
  overrides?: EditOverrides; out?: string; onProgress?: (p: RenderProgress) => void; signal?: AbortSignal;
  concurrency?: number;
}): Promise<RenderRecord>
//   writes renders/<scenario>-v<N>.mp4 (+ -vertical suffix for the 9:16 variant) and renders/<scenario>-v<N>.json (RenderRecord incl. the plan)
renderStill(opts: { plan: EditPlan; frame: number; out: string }): Promise<string>
previewTemplate(opts: { template: LoadedTemplate; out_dir: string; title?: …; caption?: … }): Promise<string[]>
//   stills of intro, a caption over a placeholder capture, interstitial, outro (MCP template_preview)
exportRender(opts: { project; render: string; formats: ExportFormat[]; onProgress? }): Promise<ExportResult>
//   ExportFormat = 'mp4_1080p' | 'mp4_4k' | 'webm' | 'vertical_9x16' | 'gif_preview'
listRenders(project): Promise<RenderRecord[]>; nextRenderName(project, scenario, variant): string
RenderRecord = { id /* "<scenario>-v3" */, project, scenario, run_id, variant, file, plan_file, created_at,
                 duration_s, frames, width, height, fps, template, overrides, status }
```

### 1.1 Planner rules (docs/SPEC.md §9 + field-tested edit rules)
- Order: intro (unless `scenario.intro === false` or overrides.intro false) → scenes / interstitials in scenario order → outro.
- **Scene source range**: from the end of the scene's page load (event `scene_still`.t_start, else `scene_open`.t_end,
  else scene.t_start) to scene.t_end (includes trailing holds). Page loads are never shown.
- **Transitions**: between scenes that are NOT contiguous in the capture (a page load or any gap between them) use
  template.transitions.between_scenes (crossfade 0.35 s by default: the outgoing clip holds its last frame while the
  incoming one fades in). Scenes contiguous in the capture on the same page are joined with NO transition (the action
  stays continuous; only the caption changes). Intro → first scene and last scene → outro use the same transition.
  Interstitials fade in/out (crossfade). No zoom resets at a join inside the same page.
- **Speed**: scene `speed` (overrides.speeds wins) for the whole scene, step `speed` for that step's span; these spans
  always play at 1×: the scene's opening still, every `hold` (action and modifier), and ±0.6 s around a `mark`ed step
  through its hold end. Speed changes are RAMPED (speed eased over ~0.3 s of output), never instantaneous.
- **Idle trimming**: timeline.idle intervals (no screen change at all) longer than `idle_threshold` (1.2 s) are
  shortened to 0.4 s unless they overlap a protected span (still, hold, mark window). Because nothing changes on
  screen during an idle interval, the trim is invisible.
- **Camera**: static by default (template.motion.default_zoom 'none'). Zooms only from explicit step `camera` hints:
  zoom clamped to template.motion.max_zoom, focus = event.camera.bbox centre (else point, else cursor), eased with
  template.motion.zoom_ease over max(0.8 s, hint.duration) of OUTPUT time; holds until `until` (default scene end);
  zoom-out uses the same easing; the view window is clamped so the capture always fills the frame; consecutive scenes
  on the same page keep the camera (no reset at the join).
- **Captions**: scene caption from the scene's first output frame (after the incoming transition) to its end; a step
  `caption` replaces it from the step's output start. Cues never overlap: the next cue starts when the previous ends.
- **Frames**: raw (capture fills the frame, captions overlay a translucent band at the bottom), card (template frame
  width/radius/shadow on the template background, captions below), browser (card + macOS-style browser chrome with the
  real URL from the timeline), laptop (MacBook-style mockup), phone (iPhone-style mockup for narrow captures).
- **Output size**: 1920×1080 × scale (scale = overrides.scale ?? capture scale; capture scale 2 ⇒ 4K). Vertical
  variant 1080×1920 × scale: capture cropped around a smoothed track of the cursor and active target bboxes.
- Markers and the time map are expressed in output frames for review.

### 1.2 Compositions (Remotion, `packages/editor/src/remotion/`)
`DemoVideo` (landscape) and `DemoVertical` take `{ plan: EditPlan }` as input props and render nothing but the plan:
background, segments (Sequence per segment with fade envelopes), clip = `<Freeze frame={srcFrames[f]}>` around an
`<OffthreadVideo>` of the capture inside the frame/mockup with the camera transform, captions (kicker + line with
template styles and soft entrance), intro/outro/interstitial cards with light motion (respecting template.style_bias:
real = subtle, motion = richer), brandmark, optional music bed with fades and ducking under footage. Fonts and logo
are loaded from the asset URLs in `plan.brand` (FontFace + delayRender). Sizes are multiplied by `plan.unit`.
Rendering: `@remotion/bundler` bundle cached per editor-source hash under `<root>/.demo-studio/cache/`, assets served
by a local static HTTP server for the duration of the render, `renderMedia` with
`browserExecutable` = `$DEMO_STUDIO_CHROMIUM_HEADLESS_SHELL` or Playwright's chromium headless shell, h264 crf 16.

## 2. @demo-studio/review

```ts
reviewRender(opts: { project: LoadedProject; render: string /* id or path */; fps?: 1 | 2; previous?: string | false })
  : Promise<ReviewResult>
ReviewResult = { dir, files: { sheet: string; sheets: string[]; scene_sheets: Record<string,string>;
                 keyframes: Record<string,string>; timeline: string; report: string; report_md: string },
                 report: ReviewReport, thumbnails: Array<{ file; base64_jpeg }> /* ≤1280 px wide, for MCP */ }
```
Writes `review/<render-id>/`: `sheet_<fps>fps.jpg` (grid of frames with timecode + scene labels; extra pages
`sheet_<fps>fps_p2.jpg`… when long), `sheet_scene_<id>.jpg`, `keyframes/<marker>.png` (+ `scene_<id>_first.png`,
`_last.png`), `timeline.json` (output-time timeline: segments, captions, markers), `report.json`, `report.md`.
Report checks: duration per scene and total; blank/near-uniform frames inside the capture rect (e.g. white loading
pages) and at scene starts; caption/scene mismatch and overlaps (from the plan) and captions too long for the
caption width; cursor off-screen or outside the zoomed view at clicks; scenes longer than 30 s at ~1× (warning);
zoom count and zoom resets at same-page joins; transitions overlapping a click; diff vs the previous render of the
same scenario (duration and per-scene deltas, visually changed sample frames). Each finding has
`{ severity: 'error'|'warning'|'info', code, message, at?: { frame, time, scene } }`; `clean` = no error/warning.
Implementation: ffmpeg for frame extraction, sharp for grids, labels (SVG overlays) and pixel statistics.
