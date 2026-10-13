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
//   TemplateContext = { pages, vars, hooks?, run?, secrets?: SecretResolver, usedSecrets? }
resolveSecretRef(ref: string): Promise<string>   // env:VAR | keychain:service/account (macOS `security`, Linux `secret-tool`)
interpolateDeep<T>(value: T, ctx): T             // recursively over strings in objects/arrays
interpolateAt<T>(value, ctx, path, skip?): T     // same, skipping nodes; a TemplateError names the path ("scenes[2].steps[3].type.text: …")
secretForms(value): string[]                     // raw, URL-encoded (component, `+` for spaces, URI), JSON-, HTML-escaped; [] under 3 chars
// scenario templating (R-RUN-16, L1.2; scenario-template.ts)
templateSceneEntry<T extends SceneEntry>(entry, index, ctx): T   // every string except `note`s, `eval` and the literal names
templateVideo(video: TimelineVideo, ctx): TimelineVideo          // title, intro, outro, tutorial
isLiteralPath(rel, value) / isEditTextPath(rel)  // paths relative to a scene entry: an `emit` / `screenshot` name (a token
                                                 // there is a validation error) / text the video shows (no secret refs there)
resolvePageUrl(base: string, pathOrUrl: string): string

// host allow-list (hosts.ts, shell-hosts.ts; R-SEC-06, L1.2)
allowedHosts(project) / isHostAllowed(host, project)    // localhost, every environment host, allow_hosts ("*.x" = subdomains)
hostRefusalMessage(host, project, via?): string    // "refusing to contact <host> (<via>): it is not in the allow-list of project …"
class HostRefusedError extends Error { hosts: string[] }   // thrown by runner-web's js hook tab; hooks maps it to a refusal
networkHost(url): string | null                    // host a browser request contacts (null: data:, blob:, about:…)
shellHostRefs(cmd, { vars?, env? }): Array<{ host; via; unresolved?; envKey? }>   // hosts a shell command names (§2)

// templates
STARTER_TEMPLATES_DIR: string                        // the starter templates (default, editorial, motion): templates/ of the repository
listTemplates(root: string): Promise<TemplateEntry[]> // { name, dir, source: 'workspace' | 'starter' }, sorted by name: the workspace's
                                                      // templates and the starters no workspace folder shadows (L5.1)
loadTemplate(nameOrDir: string, root?: string): Promise<LoadedTemplate>  // a name: <templates_dir>/<name>, else the starter of that
                                                      // name; defaults applied, assets resolved & checked
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
hooks (SQL / JS files) / `drop_file.path` / `eval.file` / `music.file` exist (an error when the project is known, a
warning that they cannot be checked if no project is given); a scene `cursor` target must locate something, a
`cursor` point should lie inside the viewport (warning) and `cursor: keep` on the first scene is a warning;
`speed` in (0, 8]; `camera.zoom` in [1, 3] (warning above template max_zoom); `camera.duration ≥ 0.8`;
destructive hooks (`destructive: true`, SQL matching DELETE/DROP/TRUNCATE/ALTER/UPDATE, HTTP DELETE,
shell with `rm `/`dropdb`) require `confirm: true`; a shell hook naming a host outside the allow-list in its literal
text (`shellHostRefs` without variables; `$VAR`, `$(…)` and `{{…}}` parts skipped) is an error on `run`, `rollback`
or `env.<KEY>` when the project is known; `--until` refs must resolve; interstitial has text;
a scene without `open` that is the first scene of a page is a warning ("starts on whatever is loaded").

## 2. @demo-studio/hooks

```ts
runHooks(hooks: HookStep[], ctx: HookContext, opts: { phase: 'setup' | 'teardown' | 'reset'; journal: Journal }):
  Promise<{ ok: boolean; results: HookResult[] }>
//   setup: on the first failure (non-optional), rolls back the completed hooks of this call in reverse and returns ok=false
//   teardown: runs every hook even if some fail (collects errors)
class Journal {                      // rollback journal persisted as JSON: runs/<id>/hooks-journal.json (captures),
                                     // <project>/.demo-studio/journals/<id>.json (studio hooks run / env reset)
  static open(file: string): Promise<Journal>
  record(entry: JournalEntry): Promise<void>         // executed hook + its rollback action (if any)
  pending(): JournalEntry[]                          // executed with rollback not yet done
  rollbackAll(ctx: HookContext): Promise<HookResult[]>   // reverse order, marks entries rolled back
}
findPendingJournals(projectDir: string): Promise<string[]>  // both locations, pending entries only, newest id first (env_reset)
findJournal(projectDir: string, id: string): string | null  // runs/<id>/hooks-journal.json, else .demo-studio/journals/<id>.json
standaloneJournalFile(projectDir: string, id: string): string
checkHostAllowed(url: string, project: LoadedProject): void  // throws HookSecurityError
checkShellHosts(cmd, vars, env, project): void               // the hosts a shell command names (core shellHostRefs); throws HookSecurityError
isDestructive(hook: HookStep): boolean
describeHook(hook: HookStep): string

HookContext = {
  project: LoadedProject; env: { name; pages }; vars; runId?; dryRun?: boolean;
  log: (level, msg) => void;
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>; // provided by the runner for js hooks:
                                      // runner-web evalHookInPage (the guarded hook tab); throws core HostRefusedError
  saved: Record<string, unknown>;     // save_as results, exposed to templating as {{hooks.<name>...}}
}
```

- **http**: `fetch`, templated url/headers/body, `expect` check, response saved (`status`, `headers`, `body`, `json`).
  Rollback request templated with `{{response.json.*}}`.
- **sql**: `pg` client, connection URL from `project.databases[db].url` (templated, secrets resolved).
  File or inline; a whole file runs as one multi-statement query inside `BEGIN … COMMIT`.
  Rollback: file or inline SQL from the hook's `rollback`.
- **shell**: `child_process.spawn('sh', ['-c', run])`, cwd = project dir, env merged (+ `DEMO_STUDIO_PROJECT_DIR`,
  `DEMO_STUDIO_ENV`, `DEMO_STUDIO_RUN_ID`, `DEMO_STUDIO_ALLOWED_HOSTS`), timeout, output logged.
- **js**: requires `ctx.evalInPage` (else a clear error: "js hooks need a browser: run them through the runner").
  The runner and `studio hooks run` evaluate it with runner-web `evalHookInPage`: a tab of the run's browser context
  per environment page key (shares cookies / localStorage / IndexedDB with the capture tabs; not in `session.pages`,
  never recorded), opened on that page when it is not on a web page yet, kept for the session and reused by later js
  hooks on the key (a hook may leave the app running there: `quote` keeps its console polling for a notification;
  `notifications.ts` names that tab by its key).
- **Security** (R-SEC-06: every kind, every phase, rollbacks included): hosts outside the allow-list (environment
  hosts + `allow_hosts` + localhost/127.0.0.1/::1) are refused (`HookSecurityError` reason `host`, status `refused`,
  never tolerated by `optional`; the message names the host, never the URL).
  - http / sql: checked on the connection (http redirects hop by hop).
  - js: the hook tab's guard fails every request to such a host — CDP `Fetch` (Request stage) on the tab's own session
    sees navigations, each redirect hop, sub-resources, beacons, EventSource, dedicated workers and same-site frames;
    `page.route` backs it up and covers cross-site (out-of-process) frames' first hops; `page.routeWebSocket` the
    page's WebSockets; `Network.setBypassServiceWorker`; `window.open` disabled, a popup closed at once. The guard
    stays for the tab's life (deferred requests stay blocked). Outcome: the page landing on / redirected to such a host
    → `HostRefusedError` ("js hook page … redirected to it"); the hook throws after a blocked request →
    `HostRefusedError` ("blocked while the js hook ran"; the hook's error appended) — so an ordinary failure while the
    app's own background traffic to an unlisted host was blocked is a refusal too; the hook catches it and returns →
    ok + a warning naming the host. Blocked during load or while idle → an info log line (hosts only).
  - shell: core `shellHostRefs` on the templated command, in `prepare` (so dry runs report it) and again when a
    journal replays a shell rollback — a best-effort reading of the shell text, one command at a time: URLs (network
    schemes only; also `--opt=URL`, `NAME=URL` assignments, and scheme://host inside inline code: `node -e` / `-p`,
    `python -c`, `ruby -e`, `perl -e`, `php -r`, `deno eval`, `bun -e`, `mongosh --eval`), `$VAR` / `${VAR…}` /
    `$'…'` expanded quote-aware from the script's own assignments (`NAME=`, `export`, `+=`, `unset`) over the
    environment sh gets (validation: over the hook's `env:` map; other variables unresolved), curl / wget operands
    without a scheme (complete option-value tables of curl 8 and GNU Wget, so a value is never read as a host; a bare
    IP only as a dotted quad; data-file extensions skipped), curl proxies / `--resolve` / `--connect-to`, proxy
    variables, HTTPie / xh URLs (`:port` = localhost), database clients in command position (after assignments,
    sudo / env / exec / timeout / xargs…: `-h` / `--host`, conninfo `host=` / `hostaddr=`, PGHOST / PGHOSTADDR /
    MYSQL_HOST when no host is given), redis-cli / mongosh hosts and mongosh addresses, ssh / sftp / mosh
    destinations and `-J` / `-o HostName` / a ProxyCommand (scanned as a script), scp / rsync remote operands, git
    repositories of clone / fetch / pull / push / ls-remote / remote add / submodule add, nc / telnet destinations,
    the hook's `env:` values; recursing into `sh -c`, `eval`, command substitutions (`$(…)`, backticks, also inside
    quotes, URLs and unquoted heredoc bodies) and the heredocs, here-strings and `echo` output fed to a shell (other
    heredoc bodies and redirection targets are data). Refused as computed at run time: a host built from `$(…)` or
    backticks, a variable the script reads (`read`, `mapfile`, `printf -v`, a `for` loop, a function's `$1`) or may
    have set (after `source` / `.`, `export $(…)`, `eval` of computed text), a computed psql / pg_dump database,
    `-d` value, mongosh address or git repository.
  - Residual risk (README Security, BACKLOG BL-57): what programs do on their own — their configuration, script
    files, hosts they compute or read, code piped into a shell, commands in containers or on remote machines, network
    tools the scanner does not know (socat, ncat, ftp…); in the hook tab, worker WebSockets, service / shared workers,
    WebTransport / WebRTC, preconnects, redirect hops inside cross-site frames, a link popup's first request.
  Destructive hooks without `confirm: true` are refused at run time too (defence in depth; core validation already
  flags them). Every hook execution is logged with its description (secrets redacted: values resolved from secret
  refs never appear in logs or journals).

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
evalHookInPage(session, { project, env, log }, pageKey, code): Promise<unknown>   // a js hook in its guarded tab (§2)
encodeFrames(framesDir, index: FrameIndexEntry[], out: string, opts: { fps; crf; endT }): Promise<void>
kitSource(config: KitConfig): string           // the in-page script (for debugging / other runners)
```

### 3.1 Browser
- `chromium.launchPersistentContext(profileDir, { headless: true, channel: 'chromium' /* new headless */,
  viewport: { width, height }, deviceScaleFactor: scale, locale, timezoneId, colorScheme })`.
  `locale` (navigator.language, Accept-Language, Intl) = `browser.locale`, else the project `locale`, else the
  studio.yaml `browser.locale` default (`projectBrowser(project)`).
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
  Sub-frames (the kit runs in every frame) forward their real pointer input to the parent, which offsets it by the
  frame's content-box position (R-KIT-11) — also for a frame inside an open shadow root (found by a deep search,
  cached per source window).
- Cursor icon switches between arrow / pointing hand / I-beam from `getComputedStyle(el).cursor` of the innermost
  element under the pointer — through open shadow roots and same-origin frames (R-ISS-07) — (like macOS). Styles: `arrow-dark`, `arrow-light`, `debug` (debug adds a 6×6 px pure #FF00FF square
  centred on the hotspot — used by sync tests). Position persists in `sessionStorage` so a full navigation
  restores it before the runner re-syncs it; hidden until the first position is known. On a new document the cursor
  is **drawn** only once the page painted content of its own (R-ISS-08, L1.2: a `PerformanceObserver` on the
  document's `first-contentful-paint`): its SVG would otherwise be the document's first contentful paint — ending
  Chromium's paint holding and the recorder's hold of the load on an empty page. The runner reveals it after a load it
  waited for (`cursor.reveal`, a page that never paints content); a load nobody waits for gets it 10 s after `load`.
  Only the drawing waits: `cursor.state()` (`visible`, `known`) is unchanged.
- **Resolver** `__demoStudio.find(target: TargetObject): ResolveResult` — candidates in document order,
  visible only (non-zero box, not visibility:hidden/display:none, opacity > 0, inside viewport or
  scrollable into it), scope handling (`in`), text normalisation (collapse whitespace, trim, NBSP→space),
  exact-then-substring matching, innermost match for `contains`, promotion to the nearest interactive
  ancestor (`button, a, [role=button|link|menuitem|option|tab|checkbox|radio|switch|combobox], input, select,
  textarea, label, summary, [tabindex]`), `nth` / `last_visible`. Returns `{ count, index, desc,
  bbox, ref }` where `ref` is an id stored in a WeakRef map so the runner can get a JSHandle.
- **Shadow roots and frames (R-ISS-07)**, all in the TOP kit (the runner only talks to the main frame's kit): the
  search covers every open shadow root and same-origin frame document under the scope, and candidates are ordered in
  composed visual order (a host or frame precedes what it holds; a host's shadow content precedes its slotted light
  content). A `css` selector is matched per tree. The text tier (exact, case-insensitive, substring — text, label,
  aria, placeholder, name) is chosen on the searched document's own matches when it has any: an exact match in a
  widget frame does not beat a partial one on the page (the frames' matches of that tier still count). Refs may
  designate elements in frames (a ref whose frame navigated
  or was removed reads as gone). **Every box and point crossing the kit boundary, both ways, is in top-level viewport
  CSS px** (an element in a frame is offset by its frames' content boxes); hit tests pierce shadow roots, slots and
  frames; `scrollPlan` walks layers innermost first (containers in the frame, the frame's document, containers around
  the frame, the page — container `''` is only the top document's scroller, a frame's scroller is a ref); synthetic
  click strategies dispatch at frame-local coordinates with the element realm's event constructors; a native
  `<select>` is set with its realm's value setter; frame elements are typed with `localName`, never `instanceof`.
  Out of reach: closed shadow roots, cross-origin frames (counted in the not-found message), drag events into frames
  (`drop_file` falls back to the zone's file input), CSS-transformed frames.
- Helpers: `popupState()` (visible popups: menus, listboxes, dialogs, radix/base-ui poppers, open popovers +
  `aria-expanded` of the last trigger) for popup detection; `scrollAnimate(container, top, ms, ease)`
  (rAF + setTimeout race, returns when done); `scrollContainerFor(el)`; `blankPointNear(...)` for
  click-outside; `snapshot(el, max)` (outerHTML of the failing element, else the body, trimmed at a tag boundary to
  64 KB = `ERROR_DOM_MAX`, the cursor overlay removed) for errors; `dragGhost.show(name)/move/hide`
  for drop_file.
- Choreography helpers (L1.2): `menuTrigger(row, hovered)` (`{ref, hover}`: `hover` = the row's last button is laid out
  but hidden until hovered) and `positionalTrigger(row)` (R-CHO-13); `fieldState(ref|null)` (`{editable, empty,
  kind: search|multiline|text, known}` — never the value; `known` false for what the kit cannot read: an editor's
  hidden input clipped to a sliver, a focusable widget; a frame's contenteditable / designMode body is read) and
  `clearField(ref|null)` (the element realm's value setter + `input`, contenteditable: editing commands)
  (R-CHO-14/15); `calendar()` (`{popup, next, prev, days[{ref, label, iso, disabled, outside}]}`) and
  `setNativeValue(ref, value)` (refuses a value its input would not take — min / max, step, type — checked on a
  copy) (R-CHO-24); `watchChanges()` / `changedBoxes()` (a MutationObserver on the top document, the 500 most recent
  elements; boxes merged, ≤ 12, none over 40 % of the viewport) and `textBox(ref)`
  (R-CHO-18/21); `restNear` / `restPoint` take an optional `avoid` list of boxes.

### 3.3 Actions (deterministic pacing; all durations from `Pacing`, ±jitter seeded by scene/step index)
- Movement: eased (easeInOutCubic) path from the current cursor point with a slight arc, dispatched as
  `page.mouse.move` at ~60 Hz; duration = clamp(move_base_ms + dist·move_ms_per_px, move_min_ms, move_max_ms) =
  clamp(0.9·d, 450, 1100) ms by default; nudges (d < nudge_px = 60) take 60–100 % of nudge_ms (150–250 ms) with a
  nudge_hover_ms hover; a zero-length move takes 0 ms. Every dispatched position is pushed to the cursor track
  (timeline.cursor) with capture time (dispatch time: a frame showing a move is stamped 0–6 ms after it; a page's
  `requestAnimationFrame` time was tried in L1.3 and lands a frame late half the time). Before a press, when no
  captured frame shows the cursor's last move yet (the capture stopped while the page rendered a hover effect), the
  runner waits for one (until 0.45 s after that move, `Runtime.awaitCaughtUp`): the press and its ripple are filmed,
  not frozen; a cancelled run stops there without pressing. After an
  animated scroll (a `scroll` step or a target scrolled into view) the runner probes the
  capture with 1 px nudges of the resting cursor until three frames in a row come back within 50 ms (≤ 0.9 s, a probe
  no frame answers within 0.45 s ends it:
  `Runtime.awaitFreshFrame`): the first frames of newly exposed content can stop for 0.2–0.3 s, and a glide started
  then would freeze and jump.
- Scene start (scene key `cursor`: `auto` | `keep` | point | target): `auto` rests next to the scene's first pointer
  target (its box after leading document scrolls is predicted; a `date` without `field` first: no target is known) where the drawn cursor never covers it, inside the
  viewport (`kit.restNear(box, {point, ref})`: next to where the target is clicked — not the far corner of a wide
  field —, inside the dialog that holds it, over a neutral spot, else the nearest neutral gap around the click point),
  else at the right-centre point; a continuing scene keeps a position already clear of that target and at most
  `KEEP_NEAR_PX` (240 px) from its click point, else glides next to it (L5.1, R-MAC-07: the scene opens with the cursor
  resting next to the first thing it will click — R-ISS-04, MACOS-CHECKLIST step 7; the field notes' right-centre spot
  is the fallback). It keeps a clear cursor when no spot next to the target exists (a target filling the screen). The
  glide's end is recorded (`t_settled`): the review compares the opening still from 0.3 s after it. Placement is a teleport while a page opens (cut by the editor), otherwise an eased glide during
  the still — never a jump; recorded as `scene_still.data.cursor`.
- Ripple: 12 px disc, scale .4 → 5.5 (transform .5 s cubic-bezier(.2,.7,.2,1)), opacity 1 → 0 (.55 s ease-out),
  template colour, with a light ring + soft dark edge so it stays visible on a button of the same colour.
- `click`: resolve → if not fully in the viewport, animated scroll of its container → re-resolve bbox →
  move → hover_ms → strategy chain. `auto`: (1) real CDP mouse down/up; if a popup was expected
  (aria-haspopup, aria-expanded=false, role=combobox, `expect_popup`) and neither `aria-expanded="true"` nor a new
  popup shows up within popup_fallback_ms (polled every 40 ms) → (2) `el.click()` + ripple → (3) full pointer/mouse
  event sequence (pointerdown, mousedown, pointerup, mouseup, click with coordinates) + ripple, which waits up to
  popup_timeout_ms. Records `strategy` and `popup_opened`; waits after_popup_ms when a popup opened, else
  after_click_ms; a click that navigated or changed the URL holds at least after_navigation_ms after the press
  (`data.navigation`), not counting a page load the capture held of 0.15 s or more (§3.4: the edit cuts it) — the
  click that navigated waits for the new page's paint first. A plain click whose popup opens later than after_click_ms (slow or loaded machine) is caught by
  the next step: when that step's target is not on screen yet, it waits up to popup_timeout_ms after the press for a
  new popup, then records `popup_opened` on the click and keeps the after_popup_ms pause in the click's step. Composite steps record every click in `data.clicks`
  (`{role: trigger|option|item|confirm|outside|search|nav|day, strategy, popup_opened, point, bbox, t_click, desc}`);
  the event's top-level fields describe the trigger click.
  `outside: true` → click the topmost dialog's title/heading if a dialog is open, else a blank point
  (no interactive element under it) near the top of the page; then wait until the popover is gone.
- `double_click`, `hover` (ms), `drag` (down, eased move, up).
- `type`: click into `into` (if given) then `keyboard.type` char by char at `cps` (deterministic ±30 % jitter),
  `clear`, `enter`. Without `cps` the rate adapts to the focused field (R-CHO-14, `typingRate`): a search field
  (type=search, searchbox / combobox role, aria-autocomplete list|both, enterkeyhint=search, inside `[role=search]` /
  `<search>` or an open floating popover — never a dialog —, or a name / id / placeholder / label / title like
  search, filter, find, look up…) at min(type_cps, 10); other text at type_cps, ramping from 40 characters up to 24
  cps at 120; `data.rate` = set | search | default | long. `clear` (R-CHO-15, `data.clear`): empty → nothing;
  select-all + Backspace → `keys` when the field is empty then; else the native value setter + `input` (`setter`;
  contenteditable: `editor`) — what React's value tracker sees as a change —; still not empty → `failed` (warned). A
  field the kit cannot read (fieldState `known` false or null: a frame from another origin, an editor's hidden
  input) gets the keys only, unchecked (`keys`); an input that takes no text (read-only, a checkbox) → `none`
  (warned). Focus in a frame's body: `focused()` is the frame (its box for the loupe).
- `press`: `keyboard.press(key)` × times, ripple-less.
- `select`: native `<select>` → hover + `selectOption`; otherwise click combobox → wait listbox (last
  visible) → optional search typing → click `[role=option]` by text in that listbox.
- `pick`: field by label → its trigger (combobox/button in the field container) → click → wait popover
  (last visible) → optional search → click each option → close (`outside` default: click the field label or
  dialog title, never Escape which closes whole dialogs) → wait popover gone. Only the popups the step opened are
  closed (`closeOpened` passes them to `clickOutside`): a floating popover that holds the field stays open.
- Click outside (`kit.outsidePlan`): the holding dialog's title (or blank padding inside it), else a blank point.
  A floating dialog (role=dialog + data-side: a date popover) that is itself being closed holds nothing — the
  dialog under it holds the click, else a blank point —, unless something else is being closed with it (a listbox
  it opened, portaled out of it): then it is the holding dialog and stays open (innermost layer first).
- `menu`: row (`[role=row]`, `tr`, `[role=listitem]`, `li`, card) containing `row` text → trigger
  (`aria-haspopup=menu`, then aria-label/title matching /action|more|menu|options|…/, then the last
  button in the row) → click → `[role=menuitem]` with text `item` in the last visible menu → confirm in
  the last visible `[role=alertdialog]`/dialog → wait until no menu/alertdialog is visible; if a menu
  reappears (Base UI reopen quirk) close it with click-outside, once. R-CHO-13: when the row's last button is hidden
  until hovered, or the row has no button, the cursor hovers the row's right end and looks again; still none → the
  positional last resort (warned): the clickable element at the row's right end (a sweep 8–64 px in from the right
  edge at mid-height), else at its top-right corner (18 px down: a card header's corner icon) — clickable by itself
  (interactive, `aria-haspopup`, `onclick` or its own, not inherited, pointer cursor), never a cell or the row; else
  the step fails asking for `trigger:`.
- Trigger re-click (R-CHO-10, select / pick / menu / date): the popups are taken before the trigger click; when the
  expected item is still missing RETRY_TRIGGER_AFTER_MS (3 s) later and nothing opened (no new popup, the trigger not
  `aria-expanded`), the trigger is clicked once more (`data.retried`); a popup that opened but is still filling is
  never re-clicked. A `search` is typed at once when there is a field (the focus is in a text field — an editable
  combobox, clicked without popup expectation, opens on input —, or the popover has one); otherwise after something
  opened, or after the re-click; typed once.
- `date` (R-CHO-24, `actions/calendar.ts`): `{field?, day: one | list, next?, previous?, close?}`. A native
  `<input type=date>` is set in place (one day). Otherwise: a previous date popover still open (a calendar in a
  floating popup, the trigger not expanded) is waited for (≤ 2 s, `data.waited_close_ms`), else clicked away; the
  field is clicked (re-clicked once when nothing opened); for each day the calendar (`kit.calendar()`: the innermost
  floating popup holding day cells, else the inline calendar around the last visible ones; from there up to the
  first ancestor holding a month button, ≤ 10 levels, never onto a form or the body, from a floating popup never out
  of the popup layer — a month that is its own listbox finds the popper's buttons around it and every shown month's
  days; a month button is a button, link or element classed next / prev not inside a button, above or beside the
  days, never below them, never a form's submit / reset) is read, the day matched
  (`matchDay`: dates compared as dates — ISO or English long forms, from the cell's date attribute or aria-label —,
  else whole-word label matching; enabled days of the shown months first) or the direction chosen from the shown
  days (`monthDirection`); the month button is the author's (`next` / `previous`, last visible) or the calendar's
  LAST visible one (a month-named button first, never a year button when another exists). The first month click is
  ordinary; the next ones are quick presses QUICK_GAP_MS (110 ms) apart (press 40 ms, a ripple each), each waiting
  ≤ 400 ms for the calendar to change (3 presses without change: error); MAX_MONTH_STEPS 36. Runs of ≥ 5 month
  clicks go to `data.quick_runs` (`{t_start, t_end, clicks}`). A disabled day, a day inside the shown range but not
  shown, or one never reached fails with the shown days; a disabled copy of the day in an adjacent month does not
  count (the calendar is paged to its month). Validation warns a day it cannot read as a date (no year, another
  form or language: label words only, paged forward; core `parseDay`, shared with the runner). `close`: `auto` (default: wait ≤ 1.5 s for what the step
  opened to close by itself, else click outside), `outside`, `escape`, `none`. Click roles `trigger`, `nav`, `day`.
- `scroll`: animated in-page scroll of the container (`to`, `by`, `offset` — default pacing.scroll_offset −140 —,
  `duration`).
- `drop_file`: the cursor moves (eased) to the viewport edge (`from`), then travels to the zone with a file "ghost" chip
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
  → bbox recorded on the event), `caption`, `speed` (copied to the event), `timeout`, `optional`, `park`.
- `park` (R-CHO-18/21, `park.ts`, opt-in): `parkPlan` → after a `scroll` to a target, next to its text box
  (`kit.textBox`, `restNear`; kept when already clear and within KEEP_NEAR_PX), held `pacing.park_scroll_hold`;
  after any other step, away from what changed since the last acting step started (`kit.changedBoxes`, recorded
  only when some step of the scenario parks) and from the element that step used (`restNear(…, {avoid})`, else
  `restPoint('side', avoid)`; a new document: the right-centre spot), held `pacing.park_hold`; `park: <s>` holds s,
  else the step's `hold`. The move is part of the step (`t_end` after it), the hold follows as `ev.hold`; on a
  `hold` step the cursor parks first and the hold starts after the move. Skipped while a menu / listbox / popover the
  step opened is open (a click's popup, or one not open when the step started: a menu shown on hover). Recorded as `data.park` (`{kind, how: glide|keep|skip, from, to, side, avoided, move_ms,
  hold_s}`).
- Errors: a failing step retries resolution until its timeout, then fails with a clear message
  (target description, candidate count, nearest texts found), a screenshot and a DOM snippet in
  `runs/<id>/screenshots/error-<scene>-<step>.png|.html`. Non-optional failures abort the scenario;
  teardown ALWAYS runs (try/finally, also on SIGINT/SIGTERM and AbortSignal).
- **Templating and secrets** (R-RUN-16/17, L1.2). Each scene entry (scene, card, interstitial) is templated once, when
  the loop reaches it (`templateSceneEntry`, after the setup hooks; the `--until` scene only up to its last step); the
  raw steps are templated before `normalizeStep`, so a string target is read from its value. The video block is
  templated after the setup hooks. A TemplateError fails the run (with a `--hooks run` hint for a `{{hooks.…}}` token
  of a dry run that skipped them). Secret refs are resolved by `RunSecrets` (`secrets.ts`) **before the browser
  opens**: every `{{env:…}}` / `{{keychain:…}}` of the scenes the run reaches, the mailbox headers when it runs a
  `wait_for_email`, an `eval` file's when it runs; the reader is injectable (tests). Redaction happens at the sinks —
  `emit` (log.jsonl, onProgress), run.json (RunFiles), timeline.json, the returned RunRecord, `error-*.html` (redacted
  before its 64 KiB cut: the kit trims at twice that), the step description (from a fully redacted copy of the step,
  so describeStep's 100-character cut keeps no part of a secret) and a `capture_text` target description — over
  every `secretForms` form (raw, URL-encoded as encodeURIComponent / encodeURI / a WHATWG URL path and query / a GET
  form, JSON- and HTML-escaped), longest first. What a file keeps as written is a **policy along its shape**
  (`TIMELINE_POLICY`, `RECORD_POLICY`, `PROGRESS_POLICY`): ids, enums, paths, files and timestamps at their known
  positions (started_at, created_at, `loading[].until`, `clicks[].role`, cursor icons…: a short secret never corrupts
  them), the edit-time subtrees validation keeps secrets out of (caption, card, interstitial, overlay slots / params,
  page labels, video, tutorial, a transition's component) and `artefacts` (the app's own content, kept as captured —
  but not a text's `target` description nor a document's `url`); everything else is redacted — target specs and
  descriptions, camera targets, emit `data`, eval and capture `value`s, transition params, URLs, messages, at any depth.
  `type` warns when a secret goes into a field other than `input[type=password]` (kit `focused().input_type`).

### 3.4 Recording
- CDP `Page.startScreencast({ format, quality, maxWidth: w·scale, maxHeight: h·scale, everyNthFrame: 1 })`
  on the active page (stop/start on page switch). Every frame is acked immediately and written to
  `runs/<id>/frames/NNNNNN.jpg` with `{ file, t }` appended to `frames.jsonl`
  (t = metadata.timestamp·1000 − t0_wall, seconds). Frame timestamps and runner events share the wall clock.
- t0 = the moment recording starts (before the first scene). Encoding: ffmpeg concat demuxer with per-frame
  durations (VFR) → `-vf fps=<fps>,format=yuv420p -c:v libx264 -crf <crf> -preset medium -movflags +faststart`
  → `capture.mp4` (CFR). The first frame is extended back to t=0; the last frame holds until the stop time.
- `idle` intervals: gaps between consecutive frames ≥ 0.5 s.
- Chromium keeps its frame rate limiter by default. With it, frame production stops ≈ 0.26 s when an element with a
  `backdrop-filter` goes away after a hover and a press (a closing dialog's overlay), measured on macOS / Metal
  whatever the raster path. `browser.frame_rate_limit: false` (L1.3) launches it with `--disable-frame-rate-limit`:
  no such stall, but a page's `requestAnimationFrame` then runs at thousands of Hz while anything animates (an
  animation stepping once per frame plays too fast; 2–6× the CPU) — an option, not the default; the motion check points to it when a click ripple froze.
- Motion check (`motionCapture`): per cursor move, the frame rate of the motion itself (first sample → last change
  of position) — a run warning below 0.6 × min(fps, 30); and the stalls — frame gaps ≥ 150 ms (`STALL_MIN_S`) while
  the cursor moves or a click ripple plays, except around a page change (the new page renders), over a held page load
  and 1 px nudges — a run warning listing them. Hover hitches of 100–130 ms stay under the threshold.
- **Full-page loads** (R-ISS-08, L1.2; `hold.ts` `LoadHold`, wired in `recorder.ts`): the recorder never writes a
  frame of a document that has not painted content of its own. A main-frame cross-document commit
  (`Page.frameNavigated`, not `navigatedWithinDocument`, not a back/forward-cache restore) — or the recorder attaching
  to a page that has not painted (about:blank of a fresh tab; no `first-contentful-paint` entry and not `complete`;
  checked with a 0.3 s limit, a page with a dialog open counts as painted) — starts a **hold**: frames are not written,
  so the previous frame stays on screen. A second commit (a client redirect) continues it. It ends on Chromium's
  lifecycle `firstContentfulPaint` of that document: frames painted before the paint time (the event's own stamp on
  the frames' clock, offset estimated from the events' arrival, − 8 ms) are never written; the first frame painted after
  it and arriving ≥ 40 ms after the signal is (the kit draws the cursor meanwhile: no blink), else 120 ms after the
  signal the newest one painted after it (a still page); with none (the paint's frame was dropped by the size check,
  or Chromium stopped sending frames — measured up to several seconds after a skeleton was replaced), the screencast
  is restarted (`stopScreencast` + `startScreencast` sends the current picture in ≈ 20 ms; re-sending start alone
  does not) and the hold ends 120 ms later at the latest. A document that never paints content: released after its
  network is idle (`networkIdle`, never `load` alone: an app's shell loads, then waits for its data) + 3 s for a web
  page (only solid colours; it may render from a timer), + 0.5 s for a PDF viewer (no first contentful paint at all):
  shown from then — its newest frame of the new document written stamped at the release, the screencast restarted
  (Chromium may have sent none), nothing painted before written after —, so the held time is cut by the edit and the
  page is not filmed during its grace. 10 s at most (`limit`, released the same way: a run warning naming the page and
  the capture time, never the URL). A fresh tab's about:blank (`blank`) is never released by its own load and never
  waited for: its frames stay held until a step or the scene opens a page there (the navigation continues the hold),
  its own paint, or the 10 s limit (warned: "stayed blank"). Switching away or pausing ends it (`left`), the end of the
  run too (`end`); a recorder that never wrote a frame writes the newest held one. A frame dropped by the size check
  (a cropped view, typical right after a navigation or a screencast restart) is followed, 150 ms later, by a fresh
  frame request when no full-size frame came meanwhile (≤ 5 in a row): a still page sends no other frame, and its
  picture would never be filmed. Every hold is in `timeline.loading` / `tracks[].loading` (`t_start`: the commit or the
  attach; `t_end`: the first frame written after it, else the end of the hold — no frame lies inside; page id; `until`
  paint / load / limit / left / end; `held_frames`). Lifecycle events Chromium replays when they are enabled are
  ignored unless a hold waits for that document. The runner never acts on a held page: `Runtime.awaitLoaded` waits for
  the hold (≤ 11 s; a `blank` hold is not waited for; the run's abort signal ends the wait) at the start of every step
  (not counted in the step), right after every step's action (before its end, park, hold and overlays: an `open` up to
  its commit, an Enter, a new tab end on the painted page), before every scene still and in a click that navigated
  (before its after_navigation_ms hold) — in a multi-page scene for every page of the scene (`awaitShownLoaded`, until
  none is held: the edit cuts a held load from all pages) —, then reveals the page's cursor once per hold; `awaitFreshFrame` / `awaitCaughtUp` never wait on a held page, and the motion check ignores a
  frame gap over a held load. **Timing shift**: the paint wait of a navigation is now inside the click (or the scene
  open) — a `wait_for` after a navigating click waits only for what the page shows once painted; the editor's wait
  compression and the raw export's wait-based cut see less waiting there, the held-load cuts take its place.
- Dry-run: no recording, no encoding; one screenshot per step (`screenshots/<scene>-<NN>-<action>.png`),
  irreversible steps are hovered + screenshotted, then the rest of that scene is skipped
  (`stopped_at`), later scenes continue. `--until <ref>` stops after that step (both modes).

### 3.5 Outputs (`runs/<run_id>/`)
`run.json` (RunRecord, updated live), `capture.mp4`, `frames/` + `frames.jsonl`, `timeline.json`,
`log.jsonl` (every RunProgress event), `screenshots/`, `hooks-journal.json`, `scenario.yaml` (snapshot, tokens as
written). Secret values appear as `***` in run.json, log.jsonl, timeline.json (except `artefacts`) and error-*.html.

## 4. CLI (`studio`)

```
studio new <slug> [--name N] [--template T] [--env name=key:url,...]
studio list                                   # projects
studio validate <project> <scenario|file>     # exit 1 on errors; prints file:line:col messages
studio run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--json]
studio hooks run <project> <file.yaml|scenario:setup|scenario:teardown|reset> [--yes]
studio hooks rollback <project> [id]          # replay pending rollback journals (run id or journal id)
studio env reset <project>                    # project.reset hooks + pending journals
studio schema [scenario|project|template|timeline]  # print JSON Schema
studio login <project> [--env E] [--page KEY]  # headed browser on the persistent profile to sign in once
studio doctor [--project P] [--json]          # OK/WARN/FAIL per check (Node, Chromium launch, ffmpeg/ffprobe, display,
                                              # keychain, notifications, workspace, template fonts; project profile + hosts)
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
calendar → notifications → proposal → "Download quote PDF" `target=_blank`). Server-rendered "Sales reports"
(`/reports`, R-ISS-08) make full page loads mid-scene: leaving the app, a slow report that paints a text-less skeleton
while it fetches its figures, and the way back into the app's empty shell.

## 6. Testing & acceptance (phase 1)

- Unit: core (parsing, errors with line numbers, normalisation, templating, schema), hooks (journal,
  rollback order, allow-list, destructive detection; sql against a local Postgres if `$DEMO_STUDIO_TEST_PG`).
- Integration (runner-web): fixture server + `catalogue` scenario headless at 1920×1080 → capture.mp4 +
  timeline.json. Assertions: video duration ≈ timeline duration; **cursor sync** — with the `debug` cursor,
  the #FF00FF hotspot in the frame at each click's `t_click` is within 3 px of the recorded click point and
  inside the target bbox; **no hesitations** — gap between consecutive steps' t_end and next t_start < 80 ms
  (excluding waits/holds); every popup-expecting click recorded `popup_opened`.
