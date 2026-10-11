# Demo Studio — design & package contracts

This document is the build contract between packages. The product brief is `docs/SPEC.md`.
Shared data types live in `packages/core/src/types.ts` (the source of truth). This file says
who does what and the exact public API of each package.

Conventions: TypeScript, ESM (`"type": "module"`, NodeNext, relative imports end in `.js`),
Node 22, pnpm workspace, `tsc -b` builds every package to `dist/`, tests with vitest
(`pnpm test`; the root `vitest.config.ts` aliases `@demo-studio/*` to `src/` so tests need no build).
No new npm dependencies without a strong reason (everything needed is already installed).

## 0. Layout

```
packages/core         scenario parser/validator, project/template model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js) + rollback journal + allow-list + secrets
packages/runner-web   Playwright/CDP runner: in-page kit (cursor overlay, resolver), actions, recorder, encoder, timeline
packages/editor       (phase 2) Remotion compositions + edit planner + render API
packages/review       (phase 2) contact sheets, key frames, report.json, diff vs previous render
packages/mcp          (phase 3) MCP server (stdio + HTTP)
packages/cli          `studio` command — everything the MCP does, for humans and CI
fixtures/wholesale    local test product (supplier console + buyer shop) built with real Radix UI and Base UI components
templates/<name>/     template.yaml + assets (fonts, logo)
projects/<slug>/      README.md, project.yaml, scenarios/, hooks/, assets/, runs/, renders/, review/
```

### Workspace root

`findWorkspaceRoot(start = process.cwd())`: `$DEMO_STUDIO_ROOT` if set, else the nearest ancestor
containing `studio.yaml`, else the nearest ancestor containing a `projects/` or `templates/` dir,
else `start`. `studio.yaml` (optional) may set `projects_dir`, `templates_dir`, `browser`, `ffmpeg`.

`runs/`, `renders/`, `review/` and `frames/` are git-ignored.

## 1. @demo-studio/core

Exports everything from `types.ts` plus:

```ts
// workspace
findWorkspaceRoot(start?: string): string
loadWorkspaceConfig(root: string): Promise<WorkspaceConfig>   // { root, projectsDir, templatesDir, browser?, ffmpeg? }

// projects
listProjects(root: string): Promise<Array<{ slug: string; name: string; dir: string }>>
loadProject(dirOrSlug: string, root?: string): Promise<LoadedProject>
//   LoadedProject = { slug, dir, config: ProjectConfig (defaults applied), readme: string | null,
//                     scenarios: string[] /* names */, file: string /* project.yaml */ }
createProject(root: string, input: { name: string; slug?: string; readme?: string;
  environments?: ProjectConfig['environments']; template?: string; capture?: Partial<CaptureSettings>;
  frame?: FrameStyle }): Promise<LoadedProject>       // writes README.md, project.yaml, dirs, .gitignore
updateReadme(project: LoadedProject, markdown: string): Promise<void>
parseProjectYaml(text: string, file?: string): { config?: ProjectConfig; issues: ValidationIssue[] }

// scenarios
parseScenario(text: string, opts?: { file?: string; project?: LoadedProject }):
  { scenario?: Scenario; issues: ValidationIssue[] }   // YAML → schema → semantic checks; issues carry line/col
validateScenario(s: unknown, opts?: { project?: LoadedProject; file?: string }): ValidationIssue[]
loadScenario(project: LoadedProject, nameOrPath: string): Promise<LoadedScenario>
//   LoadedScenario = { name, file, text, scenario: Scenario, issues: ValidationIssue[] }  (throws ScenarioError if any error-level issue)
saveScenario(project: LoadedProject, name: string, text: string): Promise<{ file: string; issues: ValidationIssue[] }>
//   refuses to write when error-level issues exist
normalizeStep(step: Step, index: number): NormalizedStep          // throws on 0 or >1 action keys
normalizeTarget(t: TargetSpec): TargetObject                       // "x" → {text:"x"}; "#id"/".c"/"[a]"/"a > b" → {css}
describeTarget(t: TargetSpec): string                              // short human description: `text="Save" in dialog`
listSteps(s: Scenario): Array<{ scene: Scene; sceneIndex: number; step: NormalizedStep; ref: string }>
//   ref = "<sceneId>.<stepId|index>" — used by --until
resolveStepRef(s: Scenario, ref: string): { sceneIndex: number; stepIndex: number } | null
//   accepts "sceneId.stepId", "sceneId.3", "stepId" (unique), "sceneId" (= last step of scene)

// environments & templating
resolveEnvironment(project: LoadedProject, env?: string): { name: string; pages: Record<string, string> }
interpolate(text: string, ctx: TemplateContext): string
//   {{admin}} → environment page URL; {{vars.x}} / {{x}}; {{env:VAR}}; {{keychain:service/account}};
//   {{hooks.name.json.id}}; {{run.id}}; unknown keys throw TemplateError listing the available keys
//   TemplateContext = { pages, vars, hooks?, run?, secrets?: SecretResolver }
resolveSecretRef(ref: string): Promise<string>   // env:VAR | keychain:service/account (macOS `security`, Linux `secret-tool`)
interpolateDeep<T>(value: T, ctx): T             // recursively over strings in objects/arrays
resolvePageUrl(base: string, pathOrUrl: string): string

// templates
listTemplates(root: string): Promise<Array<{ name: string; dir: string }>>
loadTemplate(nameOrDir: string, root?: string): Promise<LoadedTemplate>  // defaults applied, assets resolved & checked
DEFAULT_TEMPLATE: Template

// schemas (draft 2020-12 JSON Schema objects, also written to packages/core/schema/*.json by `pnpm -F @demo-studio/core gen:schema`)
scenarioJsonSchema(): object; projectJsonSchema(): object; templateJsonSchema(): object; timelineJsonSchema(): object

// misc
newRunId(scenario: string, date?: Date): string     // "20261011-142233-catalogue"
readJson<T>(file): Promise<T>; writeJson(file, value): Promise<void>  // atomic write (tmp + rename)
formatIssues(issues: ValidationIssue[], file?: string): string       // "file:12:5 error scenes[1].steps[3].click: …"
class ScenarioError extends Error { issues: ValidationIssue[] }
```

Validation rules beyond the schema (semantic): exactly one action key per step; unknown keys are
errors (typo protection) with a "did you mean" suggestion; scene ids unique and slug-like; step ids
unique within a scenario; `page:` keys exist in the selected environment; files referenced by
hooks / `drop_file.path` / `eval.file` / `music.file` exist (warning if no project given);
`speed` in (0, 8]; `camera.zoom` in [1, 3] (warning above template max_zoom); `camera.duration ≥ 0.8`;
destructive hooks (`destructive: true`, SQL matching DELETE/DROP/TRUNCATE/ALTER/UPDATE, HTTP DELETE,
shell with `rm `/`dropdb`) require `confirm: true`; `--until` refs must resolve; interstitial has text;
a scene without `open` that is the first scene of a page is a warning ("starts on whatever is loaded").

## 2. @demo-studio/hooks

```ts
runHooks(hooks: HookStep[], ctx: HookContext, opts: { phase: 'setup' | 'teardown' | 'reset'; journal: Journal }):
  Promise<{ ok: boolean; results: HookResult[] }>
//   setup: on the first failure (non-optional), rolls back the completed hooks of this call in reverse and returns ok=false
//   teardown: runs every hook even if some fail (collects errors)
class Journal {                      // rollback journal persisted as JSON (runs/<id>/hooks-journal.json)
  static open(file: string): Promise<Journal>
  record(entry: JournalEntry): Promise<void>         // executed hook + its rollback action (if any)
  pending(): JournalEntry[]                          // executed with rollback not yet done
  rollbackAll(ctx: HookContext): Promise<HookResult[]>   // reverse order, marks entries rolled back
}
findPendingJournals(projectDir: string): Promise<string[]>  // runs/*/hooks-journal.json with pending entries (env_reset)
checkHostAllowed(url: string, project: LoadedProject): void  // throws HookSecurityError
isDestructive(hook: HookStep): boolean
describeHook(hook: HookStep): string

HookContext = {
  project: LoadedProject; env: { name; pages }; vars; runId?; dryRun?: boolean;
  log: (level, msg) => void;
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>; // provided by the runner for js hooks
  saved: Record<string, unknown>;     // save_as results, exposed to templating as {{hooks.<name>...}}
}
```

- **http**: `fetch`, templated url/headers/body, `expect` check, response saved (`status`, `headers`, `body`, `json`).
  Rollback request templated with `{{response.json.*}}`.
- **sql**: `pg` client, connection URL from `project.databases[db].url` (templated, secrets resolved).
  File or inline; a whole file runs as one multi-statement query inside `BEGIN … COMMIT`.
  Rollback: file or inline SQL from the hook's `rollback`.
- **shell**: `child_process.spawn('sh', ['-c', run])`, cwd = project dir, env merged, timeout, output logged.
- **js**: requires `ctx.evalInPage` (else a clear error: "js hooks need a browser: run them through the runner").
- **Security**: http and sql hooks refuse hosts not in the allow-list (environment hosts + `allow_hosts` +
  localhost/127.0.0.1/::1). Destructive hooks without `confirm: true` are refused at run time too
  (defence in depth; core validation already flags them). Every hook execution is logged with its
  description (secrets redacted: values resolved from secret refs never appear in logs or journals).

## 3. @demo-studio/runner-web

```ts
runScenario(opts: RunOptions): Promise<RunRecord>
RunOptions = {
  project: LoadedProject; scenario: LoadedScenario; template?: LoadedTemplate;
  mode: 'capture' | 'dry'; env?: string; until?: string; hooks?: 'run' | 'skip';   // default: capture=run, dry=skip
  headed?: boolean; runId?: string; runsDir?: string /* default <project>/runs */;
  onProgress?: (e: RunProgress) => void; signal?: AbortSignal;
  browser?: BrowserConfig;  // overrides project.browser
}
openSession(opts): Promise<BrowserSession>     // lower-level: launch + kit injection (used by tests, MCP live preview later)
encodeFrames(framesDir, index: FrameIndexEntry[], out: string, opts: { fps; crf; endT }): Promise<void>
kitSource(config: KitConfig): string           // the in-page script (for debugging / other runners)
```

### 3.1 Browser
- `chromium.launchPersistentContext(profileDir, { headless: true, channel: 'chromium' /* new headless */,
  viewport: { width, height }, deviceScaleFactor: scale, locale, timezoneId, colorScheme })`.
  Profile = `project.auth.profile` (per env if keyed by env name), else a fresh temp profile;
  `storage_state` is loaded into the context when given. Executable: config → `$DEMO_STUDIO_CHROMIUM` → Playwright default.
- The in-page kit is installed with `context.addInitScript` (every navigation, every new tab) and
  re-evaluated on the current page when the runner starts.
- One tab per environment page key (`admin`, `app`…), created lazily; `new_tab` adds more (`tab2`, or `as`).
  The ACTIVE page is the one being recorded and acted on.

### 3.2 In-page kit (`window.__demoStudio`, written as a self-contained function, injected via `addInitScript`)
- **Cursor overlay**: a `<demo-studio-cursor>` host (shadow DOM, `pointer-events:none`) attached to
  `document.documentElement`, re-attached by a MutationObserver if removed. It uses `popover="manual"` and
  re-raises itself (hide+show popover) whenever another top-layer element opens (`toggle` events, dialog
  `showModal`), so it is drawn above modals; falls back to max z-index.
- **The overlay follows REAL input events** (`pointermove`/`mousemove` capture listeners on window) — the
  runner moves the real CDP mouse in small eased steps, so the drawn cursor and the page's hover/click
  reactions are synchronised by construction. `mousedown` → pressed state + ripple (template ripple colour);
  `mouseup` → release. `__demoStudio.cursor.ripple(x,y)` draws a ripple without input (DOM/pointer fallbacks).
- Cursor icon switches between arrow / pointing hand / I-beam from `getComputedStyle(el).cursor` under the
  pointer (like macOS). Styles: `arrow-dark`, `arrow-light`, `debug` (debug adds a 6×6 px pure #FF00FF square
  centred on the hotspot — used by sync tests). Position persists in `sessionStorage` so a full navigation
  restores it before the runner re-syncs it; hidden until the first position is known.
- **Resolver** `__demoStudio.find(target: TargetObject): ResolveResult` — candidates in document order,
  visible only (non-zero box, not visibility:hidden/display:none, opacity > 0, inside viewport or
  scrollable into it), scope handling (`in`), text normalisation (collapse whitespace, trim, NBSP→space),
  exact-then-substring matching, innermost match for `contains`, promotion to the nearest interactive
  ancestor (`button, a, [role=button|link|menuitem|option|tab|checkbox|radio|switch|combobox], input, select,
  textarea, label, summary, [tabindex]`), `nth` / `last_visible`. Returns `{ count, index, desc,
  bbox, ref }` where `ref` is an id stored in a WeakRef map so the runner can get a JSHandle.
- Helpers: `popupState()` (visible popups: menus, listboxes, dialogs, radix/base-ui poppers, open popovers +
  `aria-expanded` of the last trigger) for popup detection; `scrollAnimate(container, top, ms, ease)`
  (rAF + setTimeout race, returns when done); `scrollContainerFor(el)`; `blankPointNear(...)` for
  click-outside; `snapshot(el)` (outerHTML trimmed to 4 KB) for errors; `dragGhost.show(name)/move/hide`
  for drop_file.

### 3.3 Actions (deterministic pacing; all durations from `Pacing`, ±jitter seeded by scene/step index)
- Movement: eased (easeInOutCubic) path from the current cursor point with a slight arc, dispatched as
  `page.mouse.move` at ~60 Hz; duration = clamp(base + dist·per_px). Every dispatched position is pushed to
  the cursor track (timeline.cursor) with capture time.
- `click`: resolve → if not fully in the viewport, animated scroll of its container → re-resolve bbox →
  move → hover_ms → strategy chain. `auto`: (1) real CDP mouse down/up; if a popup was expected
  (aria-haspopup, aria-expanded=false, role=combobox, `expect_popup`) and `popupState()` shows nothing new
  within popup_timeout_ms → (2) `el.click()` + ripple → (3) full pointer/mouse event sequence
  (pointerdown, mousedown, pointerup, mouseup, click with coordinates) + ripple. Records `strategy` and
  `popup_opened`; waits after_popup_ms when a popup opened, else after_click_ms.
  `outside: true` → click the topmost dialog's title/heading if a dialog is open, else a blank point
  (no interactive element under it) near the top of the page; then wait until the popover is gone.
- `double_click`, `hover` (ms), `drag` (down, eased move, up).
- `type`: click into `into` (if given) then `keyboard.type` char by char at `cps` (deterministic jitter),
  `clear` = select-all + Backspace, `enter`.
- `press`: `keyboard.press(key)` × times, ripple-less.
- `select`: native `<select>` → hover + `selectOption`; otherwise click combobox → wait listbox (last
  visible) → optional search typing → click `[role=option]` by text in that listbox.
- `pick`: field by label → its trigger (combobox/button in the field container) → click → wait popover
  (last visible) → optional search → click each option → close (`outside` default: click the field label or
  dialog title, never Escape which closes whole dialogs) → wait popover gone.
- `menu`: row (`[role=row]`, `tr`, `[role=listitem]`, `li`, card) containing `row` text → trigger
  (`aria-haspopup=menu`, then aria-label/title matching /action|more|menu|options|…/, then the last
  button in the row) → click → `[role=menuitem]` with text `item` in the last visible menu → confirm in
  the last visible `[role=alertdialog]`/dialog → wait until no menu/alertdialog is visible; if a menu
  reappears (Base UI reopen quirk) close it with click-outside, once.
- `scroll`: animated in-page scroll of the container (`to`, `by`, `offset`, `duration`).
- `drop_file`: cursor travels from the viewport edge (`from`) to the zone with a file "ghost" chip
  (name + icon) following it; dispatch dragenter/dragover/drop with a real `DataTransfer` containing a
  `File` (fake bytes or the real file); if the zone has/contains an `<input type=file>` (or `input`
  given) and no drop handler reacted, fall back to `setInputFiles`.
- `wait` (sleep), `hold` (sleep; marked as hold in the timeline), `wait_for` (poll 100 ms; text/not_text
  are visible-text checks on the active page), `assert` (fails with screenshot), `screenshot`
  (runs/<id>/screenshots/<name>.png).
- `new_tab`: real click on target (if given) and wait ≤ 1.5 s for `context.on('page')`; if no page
  appeared, open `href` (target's `href`, or the arg) in a new page; set it active and keep recording.
- `switch_page`, `open` (navigate; `wait_until` default `load` + settle network idle ≤ settle_ms),
  `eval` (function body with `arg`), `notify` (macOS `osascript`, Linux `notify-send` if present, else log),
  `emit` (timeline event with data), `cursor` (show/hide/move/set).
- Step modifiers: `hold` (sleep after), `mark` (timeline marker at t_start), `camera` (target resolved
  → bbox recorded on the event), `caption`, `speed` (copied to the event), `timeout`, `optional`.
- Errors: a failing step retries resolution until its timeout, then fails with a clear message
  (target description, candidate count, nearest texts found), a screenshot and a DOM snippet in
  `runs/<id>/screenshots/error-<scene>-<step>.png|.html`. Non-optional failures abort the scenario;
  teardown ALWAYS runs (try/finally, also on SIGINT/SIGTERM and AbortSignal).

### 3.4 Recording
- CDP `Page.startScreencast({ format, quality, maxWidth: w·scale, maxHeight: h·scale, everyNthFrame: 1 })`
  on the active page (stop/start on page switch). Every frame is acked immediately and written to
  `runs/<id>/frames/NNNNNN.jpg` with `{ file, t }` appended to `frames.jsonl`
  (t = metadata.timestamp·1000 − t0_wall, seconds). Frame timestamps and runner events share the wall clock.
- t0 = the moment recording starts (before the first scene). Encoding: ffmpeg concat demuxer with per-frame
  durations (VFR) → `-vf fps=<fps>,format=yuv420p -c:v libx264 -crf <crf> -preset medium -movflags +faststart`
  → `capture.mp4` (CFR). The first frame is extended back to t=0; the last frame holds until the stop time.
- `idle` intervals: gaps between consecutive frames ≥ 0.5 s.
- Dry-run: no recording, no encoding; one screenshot per step (`screenshots/<scene>-<NN>-<action>.png`),
  irreversible steps are hovered + screenshotted, then the rest of that scene is skipped
  (`stopped_at`), later scenes continue. `--until <ref>` stops after that step (both modes).

### 3.5 Outputs (`runs/<run_id>/`)
`run.json` (RunRecord, updated live), `capture.mp4`, `frames/` + `frames.jsonl`, `timeline.json`,
`log.jsonl` (every RunProgress event), `screenshots/`, `hooks-journal.json`, `scenario.yaml` (snapshot).

## 4. CLI (`studio`)

```
studio new <slug> [--name N] [--template T] [--env name=key:url,...]
studio list                                   # projects
studio validate <project> <scenario|file>     # exit 1 on errors; prints file:line:col messages
studio run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--json]
studio hooks run <project> <file.yaml|scenario:setup|scenario:teardown|reset> [--yes]
studio hooks rollback <project> [run-id]      # replay pending rollback journals
studio env reset <project>                    # project.reset hooks + pending journals
studio schema [scenario|project|template|timeline]  # print JSON Schema
studio login <project> [--env E] [--page KEY]  # headed browser on the persistent profile to sign in once
studio render / review / export / mcp         # phases 2–3
```
`--json` prints RunProgress events as JSON lines (machine-readable; used by the MCP job runner).

## 5. Fixture product (`fixtures/wholesale`)

A local stand-in for a real SaaS product so the runner can be tested end-to-end without staging access:
"Northfield", a fictional B2B specialty-coffee wholesale platform. Built with **real Radix UI and Base UI
components** (the quirks in the brief come from mixing them), bundled with esbuild, served by a tiny Node server:
supplier console on :4401 and buyer shop on :4402 (configurable via env). In-memory data + JSON API with
`POST /api/reset` and endpoints used by http hooks. Screens exercise every interaction pattern of the brief:
imports (New import dialog → organisation combobox → file drop zone → Start import → "921 offers created"),
product availability by region (row action menus with Pause + confirm, Edit dialog with multi-select pickers incl.
search), catalogue + "Add a coffee" (registry search → result → product page with enrichment in progress → tasting
notes, awards, farm), and a buyer shop (home highlights → product → Request a quote dialog with a date-range
calendar → notifications → proposal → "Download quote PDF" `target=_blank`).

## 6. Testing & acceptance (phase 1)

- Unit: core (parsing, errors with line numbers, normalisation, templating, schema), hooks (journal,
  rollback order, allow-list, destructive detection; sql against a local Postgres if `$DEMO_STUDIO_TEST_PG`).
- Integration (runner-web): fixture server + `catalogue` scenario headless at 1920×1080 → capture.mp4 +
  timeline.json. Assertions: video duration ≈ timeline duration; **cursor sync** — with the `debug` cursor,
  the #FF00FF hotspot in the frame at each click's `t_click` is within 3 px of the recorded click point and
  inside the target bbox; **no hesitations** — gap between consecutive steps' t_end and next t_start < 80 ms
  (excluding waits/holds); every popup-expecting click recorded `popup_opened`.
