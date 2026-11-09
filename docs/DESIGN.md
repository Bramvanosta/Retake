# Retake — design & package contracts

This document is the build contract between packages. The product brief is `docs/SPEC.md`.
Shared data types live in `packages/core/src/types.ts` (the source of truth). This file says
who does what and the exact public API of each package.

Conventions: TypeScript, ESM (`"type": "module"`, NodeNext, relative imports end in `.js`),
Node 22, pnpm workspace, `tsc -b` builds every package to `dist/`, tests with vitest
(`pnpm test`; the root `vitest.config.ts` aliases `@retake/*` to `src/` so tests need no build).
No new npm dependencies without a strong reason (everything needed is already installed).

## 0. Layout

```
packages/core         scenario parser/validator, project/template model, templating, JSON Schemas
packages/hooks        setup/teardown hooks (http, sql, shell, js) + rollback journal + allow-list + secrets
packages/sandbox      (L1.8) sandboxes: start / seed / reset / stop, process + docker-compose providers, Postgres snapshots, init (§3.8b)
packages/runner-web   Playwright/CDP runner: in-page kit (cursor overlay, resolver), actions, recorder, encoder, timeline
packages/editor       (phase 2) Remotion compositions + edit planner + render API
packages/review       (phase 2) contact sheets, key frames, report.json, diff vs previous render
packages/engine       (L3.1) the engine API the CLI and the MCP server share (§4b): workspace / project loading, reads,
                      if_match saves, local storage refs, EngineError, the run executor, the job queue and its worker;
                      `@retake/engine/contract`: the operation contract (`ToolDef`, SDK-free `callTool`) and catalogue (§4c);
                      `@retake/engine/catalogue`: the catalogue alone, browser-safe (no run-time import)
packages/mcp          (L3.1) MCP server over stdio (§4b) and Streamable HTTP (L4.1, §4c): the contract's operations as tools
packages/ui           (L4.1) the Studio web app and its server (`retake ui`, §4c)
packages/cli          `retake` command — everything the MCP does, for humans and CI
fixtures/wholesale    local test product (supplier console + buyer shop) built with real Radix UI and Base UI components
templates/<name>/     template.yaml + assets (fonts, logo)
projects/<slug>/      README.md, project.yaml, scenarios/, hooks/, assets/, runs/, renders/, review/
```

### Workspace root

`findWorkspaceRoot(start = process.cwd())`: `$RETAKE_ROOT` if set, else the nearest ancestor
containing `retake.yaml`, else the nearest ancestor containing a `projects/` or `templates/` dir,
else `start`. `retake.yaml` (optional) may set `projects_dir`, `templates_dir`, `browser`, `ffmpeg`.

`runs/`, `renders/`, `review/` and `frames/` are git-ignored.

## 1. @retake/core

Exports everything from `types.ts` plus:

```ts
// workspace
findWorkspaceRoot(start?: string): string
loadWorkspaceConfig(root: string): Promise<WorkspaceConfig>   // { root, projectsDir, templatesDir, browser?, ffmpeg? }

// projects
listProjects(root: string): Promise<Array<{ slug: string; name: string; dir: string }>>
loadProject(dirOrSlug: string, root?: string): Promise<LoadedProject>
//   LoadedProject = { slug, dir, config: ProjectConfig (defaults applied), readme: string | null,
//                     scenarios: string[] /* names */, file: string /* project.yaml */,
//                     sandboxes?: Record<env, LoadedSandbox> /* L1.8, §3.8: merged into config as environments */ }
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
resolveEnvironment(project: LoadedProject, env?: string): ResolvedEnvironment
//   { name, pages /* real base URLs */, display?, production?, access?, read_only? } (L1.7: settings of the long form)
interpolate(text: string, ctx: TemplateContext): string
//   {{admin}} → environment page URL; {{vars.x}} / {{x}}; {{env:VAR}}; {{keychain:service/account}};
//   {{hooks.name.json.id}}; {{run.id}}; unknown keys throw TemplateError listing the available keys
//   TemplateContext = { pages, vars, hooks?, run?, secrets?: SecretResolver, usedSecrets? }
resolveSecretRef(ref: string): Promise<string>   // env:VAR | keychain:service/account (macOS `security`, Linux `secret-tool`)
interpolateDeep<T>(value: T, ctx): T             // recursively over strings in objects/arrays
interpolateAt<T>(value, ctx, path, skip?, ctxAt?): T  // same, skipping nodes; a TemplateError names the path ("scenes[2].steps[3].type.text: …");
                                                 // ctxAt(path) picks the context of each string (L1.7: edit text vs steps)
secretForms(value): string[]                     // raw, URL-encoded (component, `+` for spaces, URI), JSON-, HTML-escaped; [] under 3 chars
// scenario templating (R-RUN-16, L1.2; scenario-template.ts)
templateSceneEntry<T extends SceneEntry>(entry, index, ctx, editCtx?): T   // every string except `note`s, `eval` and the
                                                 // literal names; editCtx (L1.7) for isEditTextPath strings: the runner
                                                 // passes {...ctx, pages: displayPages(env)} — {{shop}} in a caption, card,
                                                 // overlay or label = the display URL, in a step / `open` = the real one
templateVideo(video: TimelineVideo, ctx): TimelineVideo          // title, intro, outro, tutorial (the runner passes the edit context)
isLiteralPath(rel, value) / isEditTextPath(rel)  // paths relative to a scene entry: an `emit` / `screenshot` name (a token
                                                 // there is a validation error) / text the video shows (no secret refs there)
resolvePageUrl(base: string, pathOrUrl: string): string

// environments: forms, access, display URLs, writes, clock (L1.7; env.ts, access.ts, display.ts, writes.ts, clock.ts,
// hook-writes.ts — pure helpers)
// project.yaml `environments.<env>` is the page map (short form: page → URL or {url, display}) or the long form
// {production?, access?, pages, read_only?: {hosts?, allow?, mocks?}} (a keyed union on `pages`). loadProject normalises
// it: ProjectConfig.environments keeps page → real URL (every consumer unchanged), ProjectConfig.environment_settings
// (derived, never written) the display URLs (normalised https://host[:port][/path]), production, access, read_only.
rawEnvironmentPages(value) / rawEnvironments(value)      // both forms of a raw project.yaml value (checks)
environmentAccess(env): 'read-only' | 'read-write'       // access ?? (production ? read-only : read-write)
resolveRunAccess(env, { allowWrites?, project? }): RunAccess   // { env, production, configured, mode, allow_writes, notice?,
//   warning?, protected?, writable? }
//   not production: as configured (--allow-writes a no-op where read-write); production read-only (default): read-only;
//   production + access: read-write: read-only with a notice, read-write with --allow-writes (a warning);
//   --allow-writes on a read-only environment throws AccessError (CLI: usage error, exit 2)
runAccess(env, allowWrites, project?)                    // same, never throws (journal replays, per entry)
crossEnvironmentHosts(project, runEnv, allowWrites) → { protected: ProtectedHost[], writable: string[] }
//   the pages' hosts + read_only.hosts of every other environment the run would be read-only on (production, access:
//   read-only; production + access: read-write unless --allow-writes), minus the page hosts of the environments it
//   may write to (`writable`, its own included; ports aside). Empty for projects without such environments.
protectedBy(host, access) → ProtectedHost | null; protectedHostMessage(reason, hit, access, host?)   // hooks' refusal
readOnlyHookMessage(reason, access)                      // the refusal of a writing hook
displayRows(env) → [{page, url, display?}] (every page); displayTable(env) → the rows with a display (what a run records)
displayUrl(url, table)   // http(s) only (blob:/filesystem: map the URL they wrap): the longest real base prefix of any
//   row → its display base + rest (a row without display: unchanged); a URL no row claims, on the origin of rows with a
//   display → that origin's display host ("/" page first); else unchanged. normalizeDisplay / displayError (validation:
//   a local host, an invalid URL or port refused)
editDisplayTable(recorded, current) → the edit's table: project.yaml's current rows of the run's environment, then the
//   recorded rows whose real base it no longer declares (display URLs are edit-time data: planner, raw export)
displayPages(env) → {page: display base | real URL}     // the `pages` of the edit-text template context
isLocalHost(host) / isLocalUrl(url) / findLocalUrls(text)   // localhost, dotless names, *.localhost/.local/.test/.internal/
//   .lan/.home.arpa/…, loopback, private, link-local, 100.64/10, ::1, fc00::/7, fe80::/10, IPv4-mapped; file: URLs
shownUrl(url, table) / shownText(text, table)            // the display URL, else (local) its path: never a local host
isWriteMethod(m); graphqlOf(body) / graphqlReadsOnly / graphqlWriteName / graphqlWriteOperations  // minimal GraphQL: a
//   JSON object whose keys are query / operationName / variables / extensions and whose query is a document, or a batch
parseRequestPattern(s) / requestPatternError(s) / matchRequestPattern(p, method, url, pages)
//   "[METHOD ]<page>:/path" (relative to that page's real base) | "[METHOD ]/path" (any guarded host); * = one segment
//   part, ** = anything, trailing slash optional, query ignored; GET/HEAD/OPTIONS refused (never stopped)
compileWritePolicy(env, { scenarioMocks?, access? }): WritePolicy   // read-only run: own guarded hosts (production: "*";
//   else pages' hosts + read_only.hosts, "*" = all), allow entries, mocks (scenario's first, then the environment's);
//   any run: access.protected / writable; a read-write run: protected hosts only (no allow, no mock). guardsWrites(p)
classifyRequest({method, url, body?}, policy): WriteDecision   // { write: false } | { write: true, outcome: blocked |
//   mocked | allowed | passed (unguarded host, read-only runs only), rule?, mock?, operation?, protectedBy? } — for
//   the browser write guard (runner). An entry with `operation` covers a body only when every write operation is it.
hostPatternError(entry) / hostMatches(host, pattern)     // read_only.hosts validation (host[:port], *.host, "*", URL; IDN → punycode)
resolveClock(scenarioClock, projectClock, { timezone? }): ResolvedClock | undefined   // { at, epoch_ms, timezone?, freeze? }
//   ISO date-time; without an offset: wall time in browser.timezone, else the machine's zone (recorded as `timezone`);
//   a date alone, offset minutes > 59, a year before 1970, an unknown zone, or a wall time the zone skips or shows twice
//   (DST: the message gives the offset to write) → ClockError. Scenario `clock: false` turns the project's off.
sqlWriteStatement(sql) / httpWriteReason(req) / hookWriteReason(hook, { projectDir?, rollback? }) /
rollbackWriteReason(action) / writingHooks({ setup, teardown }, opts)   // which hooks write (§2)

// host allow-list (hosts.ts, shell-hosts.ts; R-SEC-06, L1.2)
allowedHosts(project) / isHostAllowed(host, project)    // localhost, every environment host, allow_hosts ("*.x" = subdomains),
                                                        // the loopback hosts of sandboxes' mailboxes and databases (L1.8)
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

// schemas (draft 2020-12 JSON Schema objects, also written to packages/core/schema/*.json by `pnpm -F @retake/core gen:schema`)
scenarioJsonSchema(): object; projectJsonSchema(): object; templateJsonSchema(): object; timelineJsonSchema(): object

// misc
newRunId(scenario: string, date?: Date): string     // "20261011-142233-catalogue"
readJson<T>(file): Promise<T>; writeJson(file, value): Promise<void>  // atomic write (tmp + rename)
formatIssues(issues: ValidationIssue[], file?: string): string       // "file:12:5 error scenes[1].steps[3].click: …"
class ScenarioError extends Error { issues: ValidationIssue[] }

// file formats (R-PRIN-13, L1.4; formats.ts)
RETAKE_VERSION: string                          // the package version (`retake --version`, run.json engine)
FORMAT_VERSIONS: { scenario: 1, project: 1, template: 1, workspace: 1, run: 1 }
newerFormatMessage(value, { file, supported }): string | undefined   // "this project.yaml is version 2: it was made
                                                                     //  for a newer Retake (this one reads version 1) — update Retake"
newerRunMessage(runDir): string | undefined          // the same for runs/<id>/run.json (render, plan, export-capture refuse it)
checkYamlDocument(text, schema, semantic?, empty?, { formatVersion?: { file, supported } }): CheckedDocument
```

**File format versions** (R-PRIN-13, L1.4). Scenarios, project.yaml, template.yaml, retake.yaml and run.json take an
optional top-level `version: 1` (`fileVersion()` in schemas/primitives.ts: `z.literal(1).optional()`; absent = 1);
sandbox.yaml, timeline.json, the hooks journals, render / review records and raw manifests require theirs. Before the
schema, `checkYamlDocument` with `formatVersion` (`parseScenario`, `validateScenario`, `parseProjectYaml`,
`parseTemplateYaml`, `loadWorkspaceConfig`, `parseSandboxYaml`) refuses an integer `version` above the supported one
with one positioned error at the key — no unknown-key errors for the newer format's keys; `0`, `"1"` or `1.5` stay
plain schema errors. `parseTemplateYaml` drops `version` before merging the file over the defaults (it is the file's,
not a template section). Writers: `createProject` (first key), the runner (`RunRecord.version`, first key); the
starter templates and the fixture's files carry it. Hook files (top-level lists) have none. `findRun` (render,
export-capture), `retake plan`'s own `resolveRun` and `exportCapture` refuse a run whose run.json is newer; a run.json without `version` (before L1.4)
reads as 1. No migration: Retake never rewrites a user's file (a `retake migrate` is BL-70).

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
L1.7: an environment's settings (`production`, `access`, `read_only`) written in the short form get one targeted error
("settings go with the long form") instead of the page-value error — a page key named like a setting with a URL stays a
page; `display` must be a host or an http(s) base URL without query, fragment or `{{…}}`; allow / mock patterns are
parsed (a GET pattern is an error), their page keys exist in their environment; a mock has at most one of `json` /
`body` and no `{{…}}` (mocks are literal); `read_only` on an environment that is never read-only is a warning; `clock`
must be a date and a time; `writes` is for shell hooks only; on a scenario whose environment is read-only (or
production), each hook a read-only run would refuse is a warning (`--hooks skip` / `--allow-writes` make the run
valid), and `mocks` on a read-write environment are a warning (ignored, the writes really happen).

## 2. @retake/hooks

```ts
runHooks(hooks: HookStep[], ctx: HookContext, opts: { phase: 'setup' | 'teardown' | 'reset' | 'seed' | 'step'; journal: Journal }):
  Promise<{ ok: boolean; results: HookResult[] }>
//   setup: on the first failure (non-optional), rolls back the completed hooks of this call in reverse and returns ok=false
//          (ctx.signal aborted: a running shell hook is stopped and fails; the rollbacks run without the signal)
//   seed (L1.8, §3.8): stops at the first failure, rolls nothing back, never asks to confirm a destructive step, no js
//   step (L5.8, a named hook a `hook:` step runs during the take): stops at the first failure, journals rollbacks like
//          setup (undone after the teardown with the setup's), rolls nothing back itself; approvals bound to phase `step`
//   teardown: runs every hook even if some fail (collects errors)
class Journal {                      // rollback journal persisted as JSON: runs/<id>/hooks-journal.json (captures),
                                     // <project>/.retake/journals/<id>.json (retake hooks run / env reset)
  static open(file: string, opts?: { keyFile?: string }): Promise<Journal>
  record(entry: JournalEntry): Promise<void>         // executed hook + its rollback action (if any); signed (L5.14)
  isSigned(entry: JournalEntry): boolean             // L5.14: written by Retake with this home (valid `sig`)
  pending(): JournalEntry[]                          // executed with rollback not yet done
  rollbackAll(ctx: HookContext): Promise<HookResult[]>   // reverse order, marks entries rolled back
}
findPendingJournals(projectDir: string): Promise<string[]>  // both locations, pending entries only, newest id first (env_reset)
openPendingJournals(projectDir) / rollbackJournals(list, ctx)  // L5.14: open once, list, replay exactly what was listed
findJournal(projectDir: string, id: string): string | null  // runs/<id>/hooks-journal.json, else .retake/journals/<id>.json
standaloneJournalFile(projectDir: string, id: string): string
checkHostAllowed(url: string, project: LoadedProject): void  // throws HookSecurityError
checkShellHosts(cmd, vars, env, project): void               // the hosts a shell command names (core shellHostRefs); throws HookSecurityError
isDestructive(hook: HookStep): boolean
describeHook(hook: HookStep): string

HookContext = {
  project: LoadedProject; env: ResolvedEnvironment; vars; runId?; dryRun?: boolean;
  access?: HookAccess;                // L1.7: { env, mode, production?, configured?, protected?, writable? }; read-only
                                      // refuses writing hooks; any run refuses a write to a protected host
  accessOf?: (env: string) => HookAccess | undefined;  // journal replays: each entry's own environment
  baseDir?: string;                   // L1.8: sql files and shell cwd relative to it (a sandbox seed: its manifest's folder)
  log: (level, msg) => void;
  evalInPage?: (pageKey: string | undefined, code: string) => Promise<unknown>; // provided by the runner for js hooks:
                                      // runner-web evalHookInPage (the guarded hook tab); throws core HostRefusedError
  saved: Record<string, unknown>;     // save_as results, exposed to templating as {{hooks.<name>...}}
}
```

- **http**: `fetch`, templated url/headers/body, `expect` check, response saved (`status`, `headers`, `body`, `json`).
  Rollback request templated with `{{response.json.*}}`.
- **sql**: `pg` client, connection URL from `databasesFor(project, env)[db].url` (project.databases, or a sandbox
  environment's own — L1.8; a replay uses the entry's environment) (templated, secrets resolved).
  File or inline; a whole file runs as one multi-statement query inside `BEGIN … COMMIT`.
  Rollback: file or inline SQL from the hook's `rollback`.
- **shell**: `child_process.spawn('sh', ['-c', run])`, cwd = project dir, env merged (+ `RETAKE_PROJECT_DIR`,
  `RETAKE_ENV`, `RETAKE_RUN_ID`, `RETAKE_ALLOWED_HOSTS`), timeout, output logged. What it inherits (`inheritedEnv`):
  `process.env` in the CLI; under the agent policy (core `useAgentPolicy`: the worker and its job processes, the MCP
  server and the Studio server) core
  `policyChildEnv` — `CHILD_ENV_BASE` (PATH without relative entries or entries inside the workspace folders, HOME,
  USER, LOGNAME, SHELL, TMPDIR, TERM, LANG, LC_*, TZ, the proxy and certificate variables) plus project.yaml
  `pass_env:` (core `passEnvProblem` refuses a loader variable at validation, `childEnv` drops one again); an unsigned
  rollback gets `childEnv`'s base only. Its own `env` (rendered: `{{env:NAME}}` from the worker's environment) and the
  sandbox `base` go on top, as before; the host check reads the same environment. A failure under the policy ends
  with `childEnvHint`: the names it inherited (never values) and `PASS_ENV_FIX`; a failed unsigned rollback ends
  with `bareEnvHint` instead (the names, no `pass_env:` advice: it gets none). The sandbox applies the same list to
  process services (`serviceEnv`) and to `docker` (`dockerEnv(base, unset, pass)`, `DOCKER_CHILD_ENV` added by name:
  `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`,
  `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM`, `DOCKER_BUILDKIT`, `BUILDKIT_PROGRESS`; `ComposeProjectRef.pass`
  carries `pass_env` to every compose command). The docker binary itself (`$RETAKE_DOCKER`, PATH, the usual places)
  is checked by core `policyProgram` and started by its real path (`ComposeProvider.program`).
- **js**: requires `ctx.evalInPage` (else a clear error: "js hooks need a browser: run them through the runner").
  The runner and `retake hooks run` evaluate it with runner-web `evalHookInPage`: a tab of the run's browser context
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
  - Residual risk (docs/guide/security.md, BACKLOG BL-57): what programs do on their own — their configuration, script
    files, hosts they compute or read, code piped into a shell, commands in containers or on remote machines, network
    tools the scanner does not know (socat, ncat, ftp…); in the hook tab, worker WebSockets, service / shared workers,
    WebTransport / WebRTC, preconnects, redirect hops inside cross-site frames, a link popup's first request.
  Destructive hooks without `confirm: true` are refused at run time too (defence in depth; core validation already
  flags them).
- **Read-only runs** (L1.7, R-ENV-04): with `ctx.access.mode === 'read-only'`, a hook that writes is refused after it
  is prepared (templated), before anything runs and before any destructive prompt (`HookSecurityError` reason
  `read-only`, status `refused`, never tolerated by `optional`; dry runs report it). `PreparedHook.writes` judges the
  content that would run: http — every method but GET / HEAD, unless the body is a GraphQL document of queries only;
  sql — core `sqlWriteStatement` on the templated SQL (reads: SELECT without INTO / FOR UPDATE / nextval / dblink, WITH
  without a data-modifying part, TABLE, VALUES, SHOW, EXPLAIN of a read, SET / RESET of anything but the transaction
  mode or the role; a quoted identifier is judged by its name — maskSql `identifiers`); shell — always, unless the hook
  declares `writes: false` (a destructive command still writes); js — never
  statically (the runner's hook tab guards its requests); a setup hook's rollback counts with its hook (an http
  rollback by its method, a sql rollback by its statements, a shell or js rollback always). SQL of a read-only run runs
  in `BEGIN READ ONLY` (a function that writes fails in Postgres). A journal replay (`rollbackOne`) checks the
  rollback against the access of the entry's own environment (`ctx.accessOf(entry.env)`, else `ctx.access`): a refused
  replay stays pending (no attempt counted). The runner refuses a read-only run with writing setup / teardown hooks
  (core `writingHooks`) before any browser opens, secret is read or hook runs. **Any run** (`ctx.access.protected`,
  core `crossEnvironmentHosts`): a hook that writes to a host of another, read-only environment (`PreparedHook.hosts`;
  an http hook's every writing hop) is refused the same way (`protectedHostMessage`). Every hook execution is logged with its description (secrets redacted: values resolved from secret
  refs never appear in logs or journals).

## 3. @retake/runner-web

```ts
runScenario(opts: RunOptions): Promise<RunRecord>
RunOptions = {
  project: LoadedProject; scenario: LoadedScenario; template?: LoadedTemplate;
  mode: 'capture' | 'dry'; env?: string; until?: string; hooks?: 'run' | 'skip';   // default: capture=run, dry=skip
  headed?: boolean; runId?: string; runsDir?: string /* default <project>/runs */;
  onProgress?: (e: RunProgress) => void; signal?: AbortSignal;
  browser?: BrowserConfig;  // overrides project.browser
  resolveSecret?: (ref) => Promise<string>;   // {{env:…}} / {{keychain:…}} reader (tests inject one)
  loginCommand?: ({project, env, persona?}) => string;   // the fix command messages print (§3.6)
}
openSession(opts): Promise<BrowserSession>     // lower-level: launch + kit injection (used by tests, MCP live preview later)
evalHookInPage(session, { project, env, log }, pageKey, code): Promise<unknown>   // a js hook in its guarded tab (§2)
encodeFrames(framesDir, index: FrameIndexEntry[], out: string, opts: { fps; crf; endT }): Promise<void>   // after the fact (raw export, tests)
new StreamEncoder({ out, fps, width, height, format, encoder, crf, horizon, onThumb? })   // fed during the take (L5.7): push / endAt / finish / abort
kitSource(config: KitConfig): string           // the in-page script (for debugging / other runners)
signIn({project, env, persona, mode: 'headed'|'auto', page?, url?, resolveSecret?, onOpen?, drive?, headless?, signal?})
  : Promise<{persona, check, profileDir?, snapshot?, cookies, origins, url, alreadySignedIn?, kept?}>   // `retake login` (§3.6)
checkSavedSession({project, env, persona, signal?}): Promise<PersonaCheckResult>   // a saved session checked as a run sees it
```

### 3.1 Browser
- `chromium.launchPersistentContext(profileDir, { headless: true, channel: 'chromium' /* new headless */,
  viewport: { width, height }, deviceScaleFactor: scale, locale, timezoneId, colorScheme })`.
  `locale` (navigator.language, Accept-Language, Intl) = `browser.locale`, else the project `locale`, else the
  retake.yaml `browser.locale` default (`projectBrowser(project)`).
  Without personas (§3.6): one context on a fresh temp profile. With personas: one context per persona the run films
  ("realms", each its own Chromium process and cookie jar) on a per-run copy of its session, plus the default context
  when some page has no persona. Executable: config → `$RETAKE_CHROMIUM` → Playwright default.
- Every runner launch (capture realms, sign-in and recording windows, site extraction, artefact renderer, cursor
  atlas, doctor probe) ends its options with `...launchOptions({ args })` (launch.ts): `chromiumSandbox: true` (the OS
  sandbox; Playwright's default is off), `--site-per-process` appended (the headless shell leaves site isolation off
  unless asked) and the switches, refused when one turns the sandbox or site isolation off or opens the browser to
  other code (core `sandboxOffArgProblem`, lists `SANDBOX_OFF_SWITCHES` / `SITE_ISOLATION_OFF_FEATURES` /
  `BROWSER_OPEN_SWITCHES` — `--disable-web-security`, the `*-cmd-prefix` / `--gpu-launcher` /
  `--browser-subprocess-path` launchers, `--remote-debugging-port` / `-address` — in agent-policy.ts; also a validation
  error of `browser.args` in retake.yaml and project.yaml). Right after it, every launch but the doctor's probe calls
  `refuseUnsandboxed`: one CDP `Browser.getBrowserCommandLine` (`browserSandbox`), and a browser whose own command line
  holds such a switch — what an executable that adds switches itself passes — is closed and refused (RunnerError). A
  source scan (test/launch-options.test.ts) keeps every `launch` / `launchPersistentContext` on both. `retake doctor`
  reports its probe's `browserSandbox` instead.
- HTTP credentials: `resolveEnvironment` gives every consumer the page URLs without `user:password@`
  (core `withoutCredentials`); `environmentHttpCredentials` returns those details, decoded, with the page's origin —
  one origin at most, one set of details (else a validation error of the environment, and the run refused). The capture
  realms, the sign-in window and the recording window are launched with Playwright `httpCredentials` limited to that
  `origin` (`launchCredentials`, launch.ts), and the run registers the password as a secret value (masked wherever it
  writes). A challenge from another origin is never answered (Playwright leaves it to the browser: it stays pending).
- Every realm refuses local files itself before anything loads (`armFileGuard`, session.ts): a browser-level CDP
  session enables `Fetch` for `file:*` only and fails each paused request (`BlockedByClient`), in every page, popup and
  frame; no Playwright route (the HTTP cache stays on). A realm that cannot be armed is closed and the run fails.
- What the runner opens (`opens.ts`, core `navigationProblem`): a scene's `open`, `pages[].open`, an `open` step, a
  `new_tab` href and the prewarm visits are checked on their final URL — templated, then resolved against the
  environment page — before a page is created or loaded for them: http(s) or exactly about:blank, no sign-in details;
  under trust `mcp` (`RuntimeInit.navigation`: core `pageOrigins` of the environment) an absolute URL the scenario wrote
  is on one of the environment's origins. A clicked link's href (the `new_tab` fallback) gets the scheme rule only,
  plus `blob:` of the opener's origin. Text that does not parse as an absolute URL is refused whoever wrote it; at
  validation a scheme whose rest does not parse is refused, and in `pages[].open` a `<page>:` prefix that names no page
  of a known environment (`admin_consol:/x`), or `file:` / `data:` / `javascript:` / `blob:` / `view-source:` /
  `chrome:` without one. A refusal is a step error; prewarm leaves the URL out. Redirects and the links a page follows
  itself stay Chromium's (an http redirect to `file:` fails; one to another origin is followed).
- The in-page kit is installed with `context.addInitScript` (every navigation, every new tab) and
  re-evaluated on the current page when the runner starts.
- The kit's two bindings (session.ts: `__retakeNotification`, `__retakeCursor`) answer a page's main frame only
  (`src.frame === src.page.mainFrame()`); `Runtime.cursorEffect` takes a finite `time` (and a finite point for a
  ripple's `x` / `y`) and at most `CURSOR_EFFECTS_PER_SECOND` (60) effects per page in a wall-clock second, one warning
  per run beyond; the kit itself reports notifications from the top window only and sends each
  text at most one character past the limit. `readNotificationPayload` checks the payload's types (else ignored), cuts
  title, body and tag at `NOTIFICATION_TEXT_MAX` (2,048), drops an icon URL beyond `NOTIFICATION_ICON_URL_MAX` (data:
  1.5 M characters, other 2,048), and takes `url` / `origin` from the main frame. notifications.ts: per run at most
  `NOTIFICATION_RUN_MAX` (50) notifications and `NOTIFICATION_ICON_RUN_MAX` (20) icons read, one warning each beyond;
  `iconRefusal` allows a `data:` URL or an http(s) URL whose `canonicalOrigin` is the notifying frame's origin or one
  of `pageOrigins(env.pages)`; `fetchIcon` decodes a data: URL (≤ 1 MiB, `NOTIFICATION_ICON_MAX_BYTES`) or fetches with
  Node's fetch, the context's cookies for the URL, `redirect: 'manual'` (a 3xx fails), a 10 s timeout, a declared
  `content-length` over the cap refused and the body stream cancelled past it. A refused or failed icon is a warning;
  the artefact keeps `icon_url`.
- One tab per environment page key (`admin`, `app`…), created lazily; `new_tab` adds more (`tab2`, or `as`).
  The ACTIVE page is the one being recorded and acted on.

### 3.2 In-page kit (`window.__retake`, written as a self-contained function, injected via `addInitScript`)
- **Cursor overlay**: a `<retake-cursor>` host (shadow DOM, `pointer-events:none`) attached to
  `document.documentElement`, re-attached by a MutationObserver if removed. It uses `popover="manual"` and
  re-raises itself (hide+show popover) whenever another top-layer element opens (`toggle` events, dialog
  `showModal`), so it is drawn above modals; falls back to max z-index.
- **The overlay follows REAL input events** (`pointermove`/`mousemove` capture listeners on window) — the
  runner moves the real CDP mouse in small eased steps, so the drawn cursor and the page's hover/click
  reactions are synchronised by construction. `mousedown` → pressed state + ripple (template ripple colour);
  `mouseup` → release. `__retake.cursor.ripple(x,y)` draws a ripple without input (DOM/pointer fallbacks).
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
- **Resolver** `__retake.find(target: TargetObject): ResolveResult` — candidates in document order,
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
  are visible-text checks on the active page; `network_idle`: `networkIdle(page)` in `network.ts` — no request in
  flight for 500 ms, counted from the step at the earliest, from a per-page in-flight tracker (`trackRequests`, attached
  by the session to every page as it opens: `request` / `requestfinished` / `requestfailed`, the favicon and event
  streams ignored). Not Playwright's `networkidle` load state: it fires once per document and then resolves at once,
  so a request started after the page's first idle (by a click) was never waited for. A page that never goes quiet
  (long polling) times out, naming the requests in flight. As Playwright's own networkidle does, a frame's requests
  are forgotten when it commits a new document (a `framenavigated` while its navigation request is in progress — a
  pushState has none and keeps them; the new document's request is kept) or is detached: after a cross-site
  navigation (renderer swapped) and for a dedicated worker's requests (reported on the page's top frame) Playwright
  reports no end for them. A fetch whose `no-store` body the page never reads is never reported as finished either: a
  request stops counting `UNREAD_BODY_MS` (1 s) after its response headers. Limit (BL-71): a worker started by an
  iframe that goes away keeps its request until the top document changes.
  `settle()` and `open` keep the load state, bounded by
  `settle_ms`), `assert` (fails with screenshot), `screenshot` (runs/<id>/screenshots/<name>.png).
- `new_tab`: real click on target (if given) and wait ≤ 1.5 s for `context.on('page')`; if no page
  appeared, open `href` (the arg, else the target's `href`: §3.1 what the runner opens) in a new page; set it active
  and keep recording.
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
  teardown ALWAYS runs (try/finally, also on SIGINT/SIGTERM and AbortSignal) — after a failed or interrupted setup
  too: the hooks' journal and context are opened before the setup runs (`openHooks`). The run's signal reaches the
  setup only (`ctx.signal`): a cancel stops a running shell hook (process group SIGTERM, SIGKILL 2 s later; only shell
  hooks honour the signal: an http, sql or js hook ends first, the setup stops at the next hook — or after its last)
  and the next hooks, `runHooks` rolls the completed ones back with a context without the signal (rollbacks are never
  interrupted), and the run ends `cancelled`; teardown and rollbacks then run uninterrupted. Every phase's shell
  groups are in `ctx.running`: a second signal SIGKILLs them, removes the session copies and re-raises the signal
  (the journal keeps what was not rolled back).
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
  on the active page (stop/start on page switch; JPEG quality 90 by default since L5.7). Every frame is acked
  immediately, `{ file, t }` appended to `frames.jsonl` (t = metadata.timestamp·1000 − t0_wall, seconds), and the
  frame itself written to `runs/<id>/frames/NNNNNN.jpg` only with `capture.keep_frames` (L5.7: default false). Frame
  timestamps and runner events share the wall clock.
- t0 = the moment recording starts (before the first scene). Encoding **during the take** (L5.7, `stream.ts`): every
  kept frame is pushed to a `StreamEncoder` — ffmpeg reading JPEG/PNG frames from a pipe (`image2pipe`) at the output
  rate; `CfrStream` emits tick n (time n/fps) with the latest frame stamped at or before it (the first frame also covers
  the time before it, frames after the end are left out: exactly `cfrSchedule`), once nothing earlier can still arrive
  — the capture clock less STREAM_LAG_S (0.5 s), never past the start of a page load the recorder holds (its frames are
  released later with their own paint time). Codec: VideoToolbox H.264 `-q:v 85` on a Mac whose ffmpeg has it
  (checked once per process), else libx264 preset veryfast at `crf`. The same ffmpeg writes a 96×54 grey copy of every
  output frame to its stdout (`activity.ts`: changed cells per frame → slow transitions, `timeline.busy`). The take
  ends with `finish(endT)` (the last ticks, ≈ 20–60 ms); a cancelled or discarded take aborts it and removes the file.
- `idle` intervals: gaps between consecutive frames ≥ 0.5 s.
- **Capture time comes only from the capture clock** (L4.4, `timeline.ts` `CaptureClock`): every frame time, event,
  cursor sample, load hold and stamp converted with `clock.at(wall)` / `clock.now()`, never from a wall-clock timer of
  its own. Any CFR pump or streaming encoder (L5.7) is driven by frame / clock times, never by a wall timer, and a
  paused clock emits no frame — so the capture pause (L4.4 part D) cuts a pause out of the take without filming it
  (§4f). The clock keeps a list of pauses `{from, to}` (wall ms): `at(wall)` = (wall − t0 − the pauses ended before
  it) / 1000, a wall time inside a pause (open or closed) being the pause instant; `now()` = `at(wallNow())`, so it
  stands still while paused and the encoders' horizon with it; `t0Wall` (`timeline.capture.t0_wall`) never moves —
  a reader converting a wall time of a paused take applies `timeline.pauses` (less the `ms` of every earlier pause, a
  time inside one being its `t`). Conversions made after the take (held loads, critique B1) stay right whatever paused
  in between.
- Chromium keeps its frame rate limiter by default. With it, frame production stops ≈ 0.26 s when an element with a
  `backdrop-filter` goes away after a hover and a press (a closing dialog's overlay), measured on macOS / Metal
  whatever the raster path. L5.7 (R-FLD-20): after every press the recorder asks for a fresh frame (a screencast
  restart sends the current picture) whenever none arrived for KICK_GAP_MS (90 ms) until KICK_WINDOW_MS (0.7 s) —
  the frames asked for during a ripple all differ: the compositor still draws, only the screencast stopped sending; a
  frame byte-identical to the last one kept (a still page asked again) is not indexed nor encoded, so idle gaps stay whole —
  and the edit cuts what is left of a freeze (`timeline.stalls`, cut but its first frame). `browser.frame_rate_limit:
  false` (L1.3) launches Chromium with `--disable-frame-rate-limit`: no such stall, but a page's
  `requestAnimationFrame` then runs at thousands of Hz while anything animates (an animation stepping once per frame
  plays too fast) and the take costs ×2.8 Chromium CPU (GPU and renderer processes ×7, FIELD-FEEDBACK-1): an option the
  run warns about.
- What a take costs (L5.7, `perf.ts`): every 2 s, Chromium's own process report (`SystemInfo.getProcessInfo` on each
  persona's browser target: type, pid, CPU seconds), `ps -o pid=,time= -p` of the encoders and of the processes
  listening on the environment's localhost ports, Node's `process.cpuUsage()`, the load average → run.json `perf`
  (with the GPU report `SystemInfo.getInfo`, the frame rates, stalls, slow transitions, the encoder and the disk).
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
`run.json` (RunRecord, updated live; `version: 1` and, L1.4, `engine: {retake, node, chromium?, os, fonts?:
{files, digest}}` — runner `engine.ts`: `chromium` read over CDP `Browser.getVersion` once the browser is open
(`BrowserSession.browserVersion`), `os` = platform, release and arch, `fonts` = the number of font files under the
platform's font folders (darwin: /System/Library/Fonts, /Library/Fonts, ~/Library/Fonts; Linux: /usr/share/fonts,
/usr/local/share/fonts, ~/.local/share/fonts, ~/.fonts; three levels deep) and a sha256/12 of their sorted relative
names, walked once per process (≈ 1 ms on the Mac); the secrets policy keeps both keys), `capture.mp4`, `frames/` +
`frames.jsonl`, `timeline.json`,
`log.jsonl` (every RunProgress event), `screenshots/`, `hooks-journal.json`, `scenario.yaml` (snapshot, tokens as
written). Secret values appear as `***` in run.json, log.jsonl, timeline.json (except `artefacts`) and error-*.html.
L1.7: `run.json` `environment: {production?, access, clock?: {at, timezone?, freeze?}}` (+ `options.allow_writes`) and `timeline.json`
`environment: {name, production?, access, allow_writes?, display?: [{page, url, display}], clock?: {at, epoch_ms,
timezone?, freeze?}, writes?: [{t?, method, url, operation?, outcome, rule?, status?, via?}]}` — the run's effective
access, the display table (URLs elsewhere stay real), the clock and the writes the read-only guard saw. The secrets
policy keeps names, enums, display bases and the clock; real URLs and matched patterns are redacted like any URL. A
read-only run refuses its writing hooks first (before secrets, sessions and the browser); `--allow-writes` on a
read-only environment and an unusable clock throw before the run folder is made.

### 3.6 Sessions & personas (L1.6; core `auth.ts`, runner `auth.ts`)
- **Model.** `auth` (global, or keyed by environment) names personas: `{pages?, session?: profile | storage_state,
  check?: {url?, expect_text?, expect_not_url?, timeout?}, login_url?, login?: steps}`, plus `auth.login_url` for
  every persona. Sign-in patterns (`LoginPattern`) match a URL's origin + path, never its query: a path prefix at a
  segment boundary (`/sign-in` ≠ `/sign-in-help`), `<page>:<path>`, an absolute URL prefix (these two also on the same
  host after an http → https or apex → www redirect), or `{regex, flags?}` (flags `g` / `y` never applied). Validation
  refuses a pattern that matches every page (`/`, `<page>:` / `<page>:/`, an environment page's URL, a regex matching
  any URL) and flags `g` / `y`; it warns about `{regex: "^/…"}` (never matches origin + path) and a `/…/flags` path.
  No path in project.yaml: core `personaPaths(retakeHome(), project, env, persona)` →
  `profiles/<project>/<env>/<persona>/` (the master Chromium profile, written only by `retake login`),
  `sessions/<project>/<env>/<persona>.json` (snapshot: Playwright storage state + `retake: {version, project,
  env, persona, machine, created_at, how}`) and `….status.json` (`{version, status: valid|expired|error, checked_at,
  by: preflight|login|auth-status|run, run?, at?, detail?}`; "never" is not stored). `loginCommand` adds `--persona`
  whenever one is given: callers leave it out for the legacy persona (keyed on `legacy`, never on the name `default`).
  `retakeHome()` = `$RETAKE_HOME` else `~/.retake`. The legacy `auth.profile` / `storage_state` (validation
  warning: a path of one computer; never mixed with `personas`) is the implicit persona `default` on every page, its
  paths as written.
- **Binding** (core `planPersonas`, pure; the validation, the runner and the CLI share it): a page id's persona is
  fixed the first time it is filmed — `persona` of the single-page scene or of `pages.<id>` (`none` = no persona),
  else the persona whose `pages` list its environment page (a multi-page page's environment page: `page`, the `open`
  prefix, the origin of an absolute `open`), else the legacy `default`, else none; `new_tab` inherits its page's (a
  tab of a `persona: none` page is in `none` too), `switch_page: previous` follows the walk's page history (pages
  closed by `close_current` aside); `persona: none` written later on a page bound without one adds it to `none`; js
  hook tabs (when hooks run) take the persona their key is filmed with (`none` included), else their key's default —
  `retake hooks run <scenario>:setup|teardown` binds them with the same plan. Another persona later for the same id is
  an error (validation, per environment with personas; the runner re-plans for its environment and stops before the
  browser opens). `persona` on a multi-page scene is an error. In an environment without personas nothing is bound.
  `used` = the personas to check.
- **Per-run sessions** (`prepareSessions`): a `profile` persona runs on a copy of its master (`fs.cp`, copy-on-write
  clones; leaves out `Singleton*`, caches, `Crashpad`, `BrowserMetrics*`, `Login Data*`, `Web Data*`) + its snapshot's
  cookies only (a session cookie is lost when a profile closes; the snapshot keeps it; localStorage travels in the
  profile — an init script would bring back keys the app removed); the legacy form applies the whole storage state, as
  before. No master: a fresh profile + the snapshot; neither: a fresh profile ("never"). A `storage_state` persona: a
  fresh profile + its snapshot (cookies + localStorage). A master locked by a live process (`profileLock`: the
  `SingletonLock` symbolic link `host-pid`, a dangling link) is refused: Chromium writes cookies lazily. Copies are
  `$TMPDIR/retake-session-<run>-<persona>-*` (0700), removed when the session closes or a launch fails
  (`BrowserSession.open` launches every realm at once and closes them all when one fails); a master path that is a
  symbolic link is copied from its target. Each copy (and `retake login`'s temp profile) is registered in the process:
  `removeSessionCopiesSync()` removes them at once — a run's second SIGINT / SIGTERM does before killing the process;
  the CLI can call it. `sweepStaleSessionCopies()` (at every `prepareSessions`; exported) removes the
  `retake-session-*` / `retake-login-*` / `retake-profile-*` (a browser's throwaway profile, where a
  `storage_state` persona's cookies end up) folders a killed process left: ours, untouched for 10 min, no live
  Chromium lock, not this process's. Runs never open, lock or write a master; nothing is written back (a refreshed
  token stays in the copy). The legacy `auth.storage_state` file must exist (`PreflightError`, as before L1.6).
- **Preflight** (`preflight`), in every dry run and capture, after the secrets prefetch and the browser launch, before
  setup hooks, notifications, the mailbox snapshot and any recorder: each used persona is checked in a tab of its own
  browser (closed after; never a capture page): open `check.url` (default its first page's `/`); expired when it lands
  on a sign-in page or answers 401 / 403, or `expect_text` does not show within `timeout` (10 s); valid when it shows
  (without one: 0.5 s after load, off every sign-in page); error when it cannot load. Not valid + `login` steps →
  automated login (secrets prefetched one persona after the other, then the logins in parallel) and a second check.
  Each check's status is saved (0600 in 0700 folders; an automated login leaves `expired` + "signed in automatically
  for run X"). Any persona not valid → `PreflightError` listing each one with `sign in again|once: retake login
  <project> --env <env> --persona <name>` (`RunOptions.loginCommand` may rewrite it); the run keeps nothing (no
  timeline). Legacy `default` never fails for a missing or unchecked session (it starts signed out, warned) — except a
  missing `storage_state` file (above). A cancel (Ctrl-C) during a check or an automated login cancels the run at
  once: their `goto` closes its tab on abort; nothing is written about the session.
- **Automated login** (`autoLogin`): steps `open`, `click`, `type` (field cleared first), `press`, `wait_for` (its
  `network_idle` is the run's `networkIdle`, a timeout fails the login), `wait`,
  templated with the run's pages, vars and secrets (`{{hooks.…}}` is not available), real input through the kit's
  targets, in a tab of the persona's browser. Messages name the step as written (`login step 3 (type into
  label="Password")`), never a typed value, and are redacted.
- **Guard** (`LoginGuard`, `Runtime.track` / `assertSignedIn`): every filmed page is checked on each main-frame
  navigation (same-document routes included) and its current URL at every step start, scene start and still, before a
  dry-run screenshot and at the end: a page of a persona against that persona's patterns (auth.login_url, its
  login_url, check.expect_not_url), a page without one against auth.login_url unless written `persona: none` (or
  opened by `new_tab` from such a page: `BrowserSession.openerOf`). A `download`'s document is checked too (the
  download URL, the tab's URL and the fetched document's final URL, with the opener page's patterns). A landing aborts
  the run with a `LoginPageError` (the abort reason: `throwIfAborted` rethrows runner errors as they are, so the run
  fails, not cancelled); a step failing meanwhile reports the landing (never tolerated as `optional`, no error
  screenshot or DOM; a landing seen while the run ends takes precedence over its failure or cancel); teardown runs;
  the run discards frames, track frames, screenshots, artefacts, the video and the timeline. A landing on the sign-in
  page of an environment page another persona (or none) is filmed as — a tab or link that left the persona's pages —
  says so and names that page instead of "session expired". A landing before the first step after setup hooks says a
  hook may have reset the sessions. A js hook tab on its persona's sign-in page (at its load, or reused by a later
  hook) fails the hook with the command. After a non-optional step failure on a persona page, one check (abortable)
  says whether that session is still valid. A landing on the persona's own sign-in page, a hook landing and an expired
  diagnosis write the status `expired`, `by: run`, `run: <id>`. A sign-in screen shown without a URL change is caught
  only when a step fails.
- **Concurrent runs** of one scenario never share a folder: without an explicit run id, a run takes the next free
  second.
- **`retake login`** (`signIn`, runner `login.ts`): refuses a master a live browser holds; signs in on the master (a
  `storage_state` persona: a temp profile, only the snapshot is kept), seeding a new profile's `Default/Preferences`
  with `credentials_enable_service: false` / `profile.password_manager_enabled: false` (Playwright's mock keychain
  would keep a saved password in the clear). Both modes start from the saved session as a run applies it (the
  snapshot's cookies on the master; all of it — cookies + localStorage — for a `storage_state` persona; nothing for
  the legacy form): a session-cookie persona, whose master alone never holds its cookie, is seen signed in. `headed`:
  a visible persistent context (`viewport: null`, Playwright's SIGINT / SIGTERM handlers off: the CLI's) on `--url`,
  else `--page`, else the check URL; every 1.5 s it reads `context.cookies()` and the localStorage of the open pages
  (no extra tab; a quit browser cannot be read any more; origins not open keep the saved localStorage), once more
  when the last page closes (then closes the browser); `drive` plays the person in tests. `auto`: a realm on the
  master — check first (still valid: the snapshot is kept as it is, `alreadySignedIn`, no step runs), else `autoLogin`
  and `context.storageState()` (Playwright reads the localStorage of the origins visited, closed tabs included). Then
  it waits for the browser process to exit (Chromium writes its profile for a moment after its lock is gone: a copy
  taken then fails on vanished temp files), writes the snapshot (`how: manual | auto`; never for the legacy form,
  whose files are the user's) and checks the session as a run sees it (`checkSavedSession`: `prepareSessions` copy +
  snapshot cookies, its own headless browser) → status `by: login`. A headed window over a saved session (with a
  check) never replaces a session that still works with a signed-out one: the window's session is written to
  `<snapshot>.new` (0600) and checked; not valid while the saved one still is → the saved one is kept (`kept`), else
  renamed over it. `signal` (the CLI's Ctrl-C) closes the window / browser, removes the temp profile and throws a
  `CancelledError`: nothing is written. A first sign-in that fails or is cancelled removes the master it created
  (`auth status` says `never`, not `unchecked`).
- **CLI side.** `retake auth status` reads, without a browser, each persona's master (non-empty), snapshot, lock and
  status file: `never` (neither), `unchecked` (no status file), else the stored status; `--check` runs
  `checkSavedSession` one persona after the other and writes `by: auth-status` — a persona whose master a browser
  holds is not checked (`error`, `not checked`, no time or origin of an older check; "close that browser first"). The
  legacy `auth.storage_state` form has no `command` (`retake login` refuses it) but a `fix`: export the file again.
  `retake doctor --project` shows the same per persona plus the Retake home's git placement (walk up for `.git`, then
  `git -C <root> check-ignore -q <rel>[/]`: ignored = OK). CLI js hooks (`retake hooks run`, `hooks rollback`, `env
  reset`) open one browser per persona of their page key, on a `prepareSessions` copy (`failure`: the first line of a
  failure that is not a run's), with the hook tab's sign-in landing check. `retake new` on a terminal (`Io.ask` /
  `Io.confirm`; `memoryIo({answers})` scripts them) checks the slug, folder and template first (core
  `checkNewProject`), asks environments, then per environment a sign-in page and personas (name, pages — none when
  every page has a persona already —, a signed-in text → `check: {url: "<first page>:/", expect_text}`), writes them
  with `createProject({auth})`, re-opens the project with the workspace's browser settings and offers `signIn`
  (headed) for each (no answer: that one and the next ones later). Messages print `retake -C <root> …` when `--root`
  was given (`RunOptions.loginCommand`; doctor's hints too). **Interrupts** (`interrupt.ts` `onInterrupt`): `retake
  login`, `auth status --check`, the sign-ins of `retake new` and the js hooks of the hook commands handle SIGINT /
  SIGTERM — the first aborts the command's `signal` (login, check: the browser closes, its copies go) or, for the
  hooks (not abortable), closes their browsers then exits; the command exits 130; a second signal removes the copies
  synchronously (`removeSessionCopiesSync`) and exits. `BrowserSession.close()` called twice waits for the first.

### 3.7 Read-only guard and product clock (L1.7; runner `write-guard.ts`, `session.ts`, `hook-page.ts`, `product-clock.ts`)
- **Arming.** A run whose policy guards writes (`guardsWrites`: read-only, or hosts of other read-only environments to
  protect — see Policy) opens its `BrowserSession` with `writes: {policy, onWrite, onWebSocket}`: `launchRealm` arms
  every realm (also one launched later) after the kit and the storage state, before any page loads — the preflight's
  check page included — with `armWriteGuard(context, o, session.pageRole)`: an init script (`unloadGuardScript` over
  `guardedHostPatterns(policy)`, with `UNGUARDED_APIS_SCRIPT`), `context.route('**/*')`, and a `websocket` listener per
  page. `SessionOptions.writes` absent (read-write runs with nothing to protect): nothing is armed or changed.
- **Policy.** core `compileWritePolicy(env, {scenarioMocks, access})` with `access = resolveRunAccess(env, {allowWrites,
  project})`: a production environment guards every host (`"*"`, fail closed); another read-only one its pages' hosts +
  `read_only.hosts` (validated: `hostPatternError`, IDN in punycode); every run also guards `access.protected` (core
  `crossEnvironmentHosts`: the hosts of the project's other read-only environments, minus the page hosts of those it
  may write to). `guardsWrites(policy)` (read-only, or something protected) arms the session: a read-write run of a
  project whose read-only environments share its hosts (the fixture) arms nothing. A read-write policy has no allow
  entries nor mocks, and `classifyRequest` ignores (`write: false`) its writes to unprotected hosts.
- **Decision** (per request, at request time): GET / HEAD / OPTIONS → `fallback()` at once; `frame().page()` resolved
  (a throw — a popup's first request, a form posted into a new window, a service worker's fetch — counts as a capture
  page: fail closed) and its role asked (`session.pageRole`): `hook` (a js hook tab, `markOwnGuard` before it loads) →
  `fallback()` (its own guard decides); then core `classifyRequest({method, url, body: postData()}, policy)`: not a
  write → fallback; `sign-in` (the automated login tab — `LoginDeps.signInTab` → `markSignIn(page, onSignInPage)`
  before its first navigation — while its main frame URL matches the persona's sign-in patterns, every URL when it
  declares none, and never once autoLogin's steps are over) → recorded `exempt` `via: sign-in`, fallback; `signed-in`
  (that tab elsewhere: the page the sign-in lands on) → decided like a capture page's, recorded `via: sign-in`;
  `passed` (unguarded host) / `allowed` → recorded, fallback; `mocked` →
  `delay_ms`, `route.fulfill({status, headers, contentType, body})` (no body for 204 / 205 / 304; Playwright adds CORS
  headers); `blocked` → a navigation request (any frame) is fulfilled `204` (the frame stays; `watchNavigation` drops a
  main-frame navigation answered 204 / 205 or aborted — `ERR_ABORTED` — at once instead of waiting 15 s for a commit),
  anything else `route.abort('blockedbyclient')`.
- **Unload.** Writes sent while a document unloads escape a plain route: a page closed directly sends its pagehide
  beacons / keepalive fetches with the interception gone, and a keepalive request paused during a navigation can be
  released when the browser closes. Two measures, both needed (measured: either alone leaks): the init script turns
  a `keepalive` write fetch and a `sendBeacon` to a guarded host into an ordinary `fetch` (it dies with its document
  unless the guard lets it through), and pages of a guarded context close through `about:blank` — `closePage(page)`
  (switch_page `close_current`, a download's tabs, the check and sign-in tabs) and `unloadPages(context)` before
  `BrowserSession.close()` — then wait (60–300 ms) until the route handlers in flight have decided.
- **Unguarded APIs.** `fetchLater` (a deferred fetch the browser sends after the page is gone or on its timer — it
  bypassed the route: sent on the next navigation, `closePage`, `session.close()` or `activateAfter`) and
  `SharedWorker` (Playwright detaches from shared-worker targets: their requests reach no route, nor a hook tab's CDP
  Fetch) are deleted from every frame's global by the guard's init script (`UNGUARDED_APIS_SCRIPT`, measured: deleting
  works in frames and popups) and by the js hook tab's own init script on every run. Apps feature-detect both.
- **Service workers.** `enableServiceWorkerRequests()` sets `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` before
  the first read-only launch (read by playwright-core when a service-worker target attaches; process-wide, harmless for
  read-write runs: no route there): a service worker's own requests — answering a page, or in the background — reach
  the context route (`frame()` throws for them: guarded). The sign-in tab bypasses service workers
  (`bypassServiceWorkers`: `Network.setBypassServiceWorker` on a CDP session of the tab, as hook tabs do), so a worker
  that forwards its sign-in POST does not turn it into a page-less, stopped request.
- **Recording.** `onWrite` (run.ts `readOnlyGuard`) appends a `TimelineWrite` to `timeline.environment.writes` (`t`
  from capture time 0 on; `protected_by` for a protected host), warns once per stopped `METHOD page:/path`
  (`describeWriteRequest`, never the query; a protected host's names its environment) and once per unguarded host a
  write `passed` to, logs mocked / allowed writes (info) and the sign-in's exempt ones (debug); a WebSocket to a
  guarded host warns once per host (not inspected). Summary and review count every outcome but `exempt`.
- **js hook tabs** (`HookPageOptions.writes`): the tab's CDP Fetch handler and its `page.route` backup classify after
  the host allow-list; a write to a guarded host that no allow entry lets through is failed (`BlockedByClient`) —
  mocked ones too: a hook is never fooled — and reported `via: hook` once per load / run (its URL without the query:
  a hook's secrets are not the run's, the timeline could not mask them). `run()`: the hook threw after
  a stopped write → core `WriteRefusedError` (`protectedBy` on a read-write run; hooks `kinds/js.ts` →
  `HookSecurityError('read-only')`, status `refused`); it caught it → a warning. The CLI hook commands open their
  browser with the same policy (`guardsWrites`).
- **Hooks of other kinds** (any run, `@retake/hooks` runOne): a hook that writes and whose `PreparedHook.hosts`
  (http: its URL; sql: its database host; shell: the hosts its command names) include a protected host is refused
  (`checkWriteHosts` → `protectedHostMessage`, reason `read-only`) before it runs; an http hook checks every hop that
  writes (redirects, rollbacks replayed later) too.
- **Cost (C1).** Any context route makes Playwright enable `Fetch` for every request and disable the HTTP cache on
  every page session (playwright-core `crNetworkManager`): every load of a read-only run refetches its assets.
- **Product clock** (`ResolvedClock` from core `resolveClock`; runner `product-clock.ts`): a **Date-only** clock.
  `session.installClock(c)` after the preflight (the session check and the automated sign-in run on the real time)
  and before the setup hooks: `context.addInitScript` + an evaluate in every open frame and dedicated worker of every
  realm of the script `productClock({epoch, since, freeze})`, which replaces `Date` (constructor without arguments,
  `Date()`, `Date.now`; same prototype, so `instanceof` and subclasses hold) and the "now" default of
  `Intl.DateTimeFormat#format` (a bound function per instance) / `#formatToParts`; its state lives under
  `Symbol.for('retake.clock')` with the real `Date`. The time is `epoch + (realNow − since)` (or `epoch` frozen):
  `since` is the runner's `Date.now()` at the install, then at `session.anchorClock()` right before capture time 0
  (`clock.t0Wall`): a later init script moves earlier ones in new documents, an evaluate moves the open ones — every
  document computes from the same anchor, so documents before and after it, in any realm (a realm launched later
  included), agree. Dedicated workers get it on Playwright's `worker` event (after their first task may have run);
  shared and service workers keep the real date. Timers, `requestAnimationFrame`, `performance` and
  `Event.timeStamp` stay the browser's (Playwright's `context.clock`, used first, faked them and slowed the product's
  own frames and timers: ten rAF loops 60 → 30 fps, 100 `setTimeout(0)` 0 → ~500 ms). `useRealTime(page)` (a
  page-level init script `productClock(null)`: the realm reads the real time for good, the session skips the page and
  its workers) keeps the session check (`checkPersona`, also `diagnoseSession` after a failed step) and the automated
  sign-in tab off the clock. The **kit** still captures its time sources once at the top (`RT`: the globals, still
  real since the kit's init script runs first; the real `Date` from the clock's state when re-injected) — it keeps
  working when a page replaces its own timers; `afterPaint()` (two real frames, ≤ 150 ms) backs `Runtime.painted()`.
  Kit 1.3.0.

### 3.8 Sandbox mode (L1.8): the core model (core `sandbox.ts`, `checks/sandbox.ts`, `schemas/sandbox.ts`)
- **Declaration.** project.yaml `sandboxes: {<env>: <sandbox.yaml, relative to the project>}` (checkProject: name
  slug-like, not an environment of project.yaml nor an `auth` key, path relative and existing; `default_env` and a
  scenario's `env` may name a sandbox; `auth.<sandbox>` is an error). `ProjectConfig.sandboxes` keeps it as written.
- **Manifest.** `SandboxFileSchema` (JSON Schema `sandbox.schema.json`, `retake schema sandbox`): `version: 1`
  (a higher one is refused before the schema runs), `provider` (`docker-compose` | `process`), `compose {files,
  project}`, `services.<name> {url, pages: {key: url | {url, display}}, health, command, cwd, env, stop_timeout_s}`,
  `seed` (`SeedStepSchema`: the http / sql / shell hook branches + `exec {service, command, env, timeout_s}`; `js` is a
  refused key of the keyed union — `KeyedUnionInfo.refused`), `reset {strategy: reseed | snapshot, snapshot:
  {database}, restart}`, `databases`, `mailbox` (+ `clear`), `login_url`, `accounts.<persona>` (persona fields +
  `username`, `password`). `checkSandbox(value, structural, {dir, env, project})` positions every issue in
  sandbox.yaml: provider keys, paths relative to the manifest (absolute / `~` refused; compose files parsed with `yaml`
  for their service names — and those under `profiles:`, which a sandbox never starts: naming one as a service or an
  `exec` step's service is an error), **loopback-only URLs** (core `isLoopbackHost`: localhost, `*.localhost`, 127/8, ::1 — not
  `isLocalHost`, which accepts private ranges and dotless names), page keys (`KEY_RE`, `RESERVED_PAGE_KEYS`, unique),
  health (one way; `tcp` refused under compose: Docker's proxy accepts any connection), seed steps (`checkHooks` with
  `destructiveOk`, files read from the manifest's folder through the check context; `rollback` warned; pg_dump plain
  output refused; `exec` hosts against the allow-list + compose service names), snapshot (docker-compose, a Postgres
  database of `databases`, not a system one, ≤ 50 characters), accounts (`checkAuth` on the accounts as one global
  block — paths mapped `auth.personas.<p>` ↔ `accounts.<p>` — with `accounts: true`: `{{account.username|password}}`
  only in their own `login` steps, `TokenScope.account`), weak plain passwords (< 8 characters or one word: a warning,
  redaction masks every occurrence of the text; < 3: an error, redaction ignores texts that short), database URLs
  connecting where they say (`checkDatabaseUrl`: no `host` / `hostaddr` / `port` / `service` / `dbname` query
  parameter — pg's `?host=` and `?port=` win over the URL's, a unix socket included —, no templated query), health
  paths that stay on the service's url (`//…` and backslashes refused), shell seed steps under process services that
  set one variable differently (the step must set it: shell commands get the services' env), and, given the project,
  a page on the host:port of a page of a production / read-only environment (every loopback host compared as one:
  `127.0.0.1:4401`, `[::1]:4401` and `localhost:4401` are the same server). `databases.<k>.external` and
  `mailbox.external` (sandbox.yaml only, not merged into `environment_settings`): the sandbox does not start it but it
  is the sandbox's alone (§3.8b ownership).
- **Merge.** `loadProject` → `parseProjectYaml` → `loadSandboxes(dir, config)` (each manifest parsed with the
  pre-merge config; errors throw `SandboxConfigError` — name `ConfigError`, `file` = the manifest, `env`) →
  `mergeSandboxes(config, sandboxes)`: `environments[env]` = the services' pages; `environment_settings[env]` =
  `{display?, sandbox: {file, provider}, mailbox?, databases?}`; `auth[env]` = `sandboxAuth(manifest).auth` (login
  steps with `{{account.*}}` written in); a global `auth` becomes keyed by every non-sandbox environment (same block).
  Projects without sandboxes are never merged (byte-identical config). `LoadedProject.sandboxes[env]` =
  `LoadedSandbox {env, file, dir, manifest, issues (warnings, reported by validate under the manifest), secrets
  (plain passwords by persona)}`. `resolveEnvironment` adds `sandbox: {file, provider}`.
- **Consumers.** `mailboxFor(project, env)` / `databasesFor(project, env)`: a sandbox's own (none → none), else the
  project's — used by the runner (`run.ts`, `actions/artefacts.ts`), scenario validation (`wait_for_email`) and the
  sql hooks (`openDatabase(ctx, …, env)`; journal replays pass the entry's `env`). `resolvePersonas` marks a sandbox
  account `sandbox: true` with `secrets`; runner `autoLogin` registers them (`RunSecrets.addValue`) — both callers,
  the run's preflight and `retake login` — and the preflight logs its automatic sign-in as info; `retake auth status`
  marks them `sandbox: true` (shown `auto`, never a `retake login` hint, never a `--check` failure). `allowedHosts`
  adds the loopback hosts of every sandbox's mailbox and databases (`db.localhost`, `127.0.0.2`: validated, refused
  at run time otherwise). Editor and review read `environments` / `environment_settings`; their advice for a page
  without a display URL names the sandbox.yaml (`services.<service>.pages.<page>`) on a sandbox environment.
- **Hooks.** `HookPhase` `seed`: preflight like setup (a js step refuses the whole seed, `SEED_NO_JS`), stop at the
  first non-optional failure, nothing rolled back, no destructive confirmation; journals accept the phase.
  `HookContext.baseDir` (default the project dir): sql files, shell `cwd` and the psql-file destructive check.
  `HookContext.signal` aborts a running shell hook (SIGTERM to its group, SIGKILL 2 s later) and stops the list;
  `HookContext.running` holds the groups of the shell commands running now (a second Ctrl-C kills them). A shell
  command on a sandbox environment gets the templated `env` of its process services and `RETAKE_SANDBOX` over the
  CLI's environment (its own `env` wins; two services differing on a variable: an error) — a seed's `npm run
  db:reset` reaches the sandbox's database. A sql hook on a sandbox refuses a URL that pg would connect elsewhere
  (`sandboxDatabaseProblem`: pg's own parser vs the URL's host and port, a unix socket, a non-loopback host).
  `HookContext.connectAddress(host, port)` (a docker-compose sandbox's seed): the address its sql steps connect to
  instead of the URL's host name (the URL's host rewritten) — the one Docker publishes the port on.
  `JournalEntry.superseded {at, by}` (not pending any more): `Journal.supersede(env, by)` /
  `supersedePendingJournals(projectDir, env, by)` — called after a sandbox reset so `retake env reset` never replays a
  rollback on reseeded data.
- **Seed hash.** `seedHash(sandbox, extra?)`: sha256 of the canonical seed, strategy, snapshot settings and databases,
  the bytes of `seedFileRefs` (sql step files + every file of `seed/` next to the manifest) and `extra` (image ids…).
- **Run records.** `RunRecord.environment.sandbox` / `TimelineEnvironment.sandbox` (`RunSandbox {name, provider,
  strategy?, restored?, reset_ms?, seed_hash?, at?}`, kept by the redaction policies) — filled by `run --sandbox`.

### 3.8b Sandbox engine (L1.8): `@retake/sandbox` (deps: core, hooks, pg)
- **API** (the CLI's and L3.1's MCP tools'): `openSandbox(project, env?)` → `Sandbox {env, sandbox, paths, kind,
  strategy}` with `up({seed: 'auto'|'never', build?, signal, log})` → `{started, kept, changed, ms, reset?}`,
  `down({volumes?})` → `{stopped, dataGone}`, `reset({by, reseed?})` → `ResetResult {strategy, restored, ms, hash, at,
  seed: {steps, ms}, mailbox, snapshot?: {action: restored|taken, ms, database}, restarted, superseded}`, `status()` →
  `SandboxStatus {state: up|partial|down, services: ServiceStatus[] (pid or container + docker status), seed?
  {hash(12), current}, last_reset?, lock?, logs, notes}` (no lock, nothing written), `logs({service, lines})` →
  `{service, file | source, exists, text}[]`, `followLogs({service, lines, signal, write})` (docker-compose),
  `checkRunning()` (a run without --sandbox: SandboxError `down` unless every service runs and is healthy; returns a
  live lock), `prepareTake({command, signal, log})` → `Take {info: RunSandbox, up, reset, note(run), release()}`,
  `killStartedSync()`; `initSandbox(project, {env, force, basePort})` (`retake sandbox init`). Errors: `SandboxError
  {code: busy|down|port|unhealthy|seed|interrupted|failed}`. `providerFor(sandbox)`: a fresh `ProcessProvider` or
  `ComposeProvider` per call. Provider (provider.ts): `up(ctx, {build})`, `down(ctx, {volumes})`, `status`, `restart`,
  `exec?`, `stopStarted`, `killStartedSync`, `logFiles`, `servedBy(ctx, port, use)` (the service of the sandbox
  serving a port, nothing else listening: process — a port a process service names and its own tree listens on;
  docker-compose — `publishedBy`), and for docker-compose `logs?`, `followLogs?`, `publishedBy?(ctx, port, use?)` (the
  service of the sandbox's own project publishing a port: a snapshot's database by default), `address?(ctx, port)`
  (where to connect to a port its own containers publish: 127.0.0.1 / ::1) and `hashInputs?` (the services' image
  ids: part of the seed hash).
- **Files** (`<project>/.retake/sandbox/<env>/`, git-ignored): `state.json` (version 1, written synchronously and
  atomically: temp + rename) — `services.<name> {kind: process, pid, started_at (ps lstart), command, hash (command /
  cwd / env), status: starting|running, boot (kern.boottime / btime), members ([{pid, start}] of its group once
  healthy, refreshed by each up)}` (written right after the spawn with now as its start time, refined once ps
  answers), `seed {hash, at, ms}` (deleted before a seed runs and when a process service starts, written after a seed
  succeeds — kept across a `reset.restart` —, deleted by `down` when the data is gone), `last_reset`,
  `provider_state` (docker-compose: `compose {project, dir, previous?: [{project, dir}]}` written before `up` runs —
  `previous`: names an earlier up used, kept until they have neither containers nor volumes —, `snapshot {key,
  database, template, hash, owner, taken_at, ms}`); `take.lock` (`{pid, started_at, command, run?, since}` written to a temp
  file and hard-linked into place — never read half-written; `O_EXCL` where links fail —; stale when the pid is gone,
  its start time differs or it cannot be read: removed under `take.lock.break` (`O_EXCL`; one older than 10 s is
  removed) only if its text is unchanged; released in `finally` and on process `exit`); `seed-journal.json`
  (recreated per seed); `logs/<service>.log` (+
  `.1`; process), `logs/compose-up.log` (the last `up`) and `logs/seed.log` (`exec` steps) for docker-compose.
- **Flow.** `up` = lock → provider.up (orphans of an earlier manifest stopped; each service: kept when ours — health
  checked again, a changed hash warned —, else ports free → spawn → state `starting` → health → ports owned →
  `running`) → seed when never seeded / hash changed / a service started / (snapshot) the database missing or closed
  (`PostgresSnapshot.broken`) → release. `prepareTake` = lock → logs over 20 MB cut → provider.up → reset → the
  caller films → release. `reset` = lock → every service up and healthy → the mailbox must be the sandbox's own
  (`checkMailbox`: Mailpit with `clear` not false → `servedBy(port)` unless `external`) → (seed path) every sql step's
  database must be too (`checkSeedDatabases`, unless `external`) → seed (runHooks phase `seed` on batches of hook
  steps with `signal` and `running`, `exec` through `provider.exec`; `ctx.baseDir` = the manifest's folder, access
  `runAccess(env, false, project)`, `connectAddress` from `provider.address` for the databases not `external`;
  interrupted → SandboxError `interrupted`) → `supersedePendingJournals(project.dir, env, by)` right after the seed or
  the restore → mailbox `DELETE /api/v1/messages` (on `provider.address` when its port is the sandbox's) → `reset.restart` →
  `last_reset`. `killStartedSync` SIGKILLs the seed's running shell groups too. `up`, `reset` and
  `prepareTake` run inside `starting()`: a fresh provider per call remembers what it started; a failure — or an abort,
  even after the last step — stops those services (only those) before rethrowing.
- **Process provider** (`process.ts`, `proc.ts`, `ports.ts`, `health.ts`). Spawn `detached` (setsid: pgid = pid),
  stdio appended to the log (`O_APPEND`: `trimLogs` truncates in place), `unref`; argv `node` → `process.execPath`,
  a string → `/bin/sh -c`; env = the CLI's minus `npm_*`, `pnpm_*`, `VITEST*`, `NODE_ENV`, `NODE_OPTIONS`, `INIT_CWD`,
  `TEST`, + the templated `env` + `RETAKE_SANDBOX`. Identity (`identify(pid, startedAt, {boot, members,
  spawned})`): another boot time → gone; `kill(-pgid, 0)` gone → gone; the leader alive → its `ps -o lstart`
  (LC_ALL=C, parsed to epoch ms) within 2 s of the recorded one → ours, else reused; the leader gone with its group
  alive → ours only when this call spawned it or a live member of the group matches a recorded member (pid + start
  time), else reused (a reused pid can lead a group of the same id). EPERM on a group (macOS: members just killed,
  not reaped yet) counts as not alive. Stop (`stopGroup`): snapshot of the group
  and its descendants (`ps -A -o pid=,ppid=,pgid=,lstart=`), `SIGTERM` to `-pgid`, `SIGKILL` after `stop_timeout_s`,
  then the snapshot's descendants outside the group still running (same start time) get SIGTERM, 2 s, SIGKILL (their
  own group when they lead one); then the ports must free within 2 s, else a warning naming the holder. Ports
  (`sandboxPorts`: `url`, `pages`, `health` url / tcp per service — not the mailbox's nor the databases'): before a
  spawn, any listener (`lsof -nP -iTCP:<ports> -sTCP:LISTEN -Fpgcn`, or a connect on 127.0.0.1 / ::1 when lsof cannot
  see it) refuses the start; after health, `checkOwned` waits (the rest of the health timeout) until the service's
  tree listens on each port, refuses any other listener (`port`), and at the timeout says either that a port answers
  without a listener lsof can see (`port`, another user's program) or that nothing listens on it (`unhealthy`).
  Health (`serviceHealth` / `waitHealthy`): the manifest's check (default GET `url`, 200–399; `status`, `text`;
  `tcp`; none with `false`), then each page answering HTTP (any status; with `false` too), 2 s per try, every 250 ms,
  60 s by default; a health path is joined to the url's origin (`//host` cannot leave it); `gone()` ends the wait
  when the started group is gone (exit code / signal + the log's last 20 lines). `servedBy(port)`: a port of a
  process service (`sandboxPorts`) whose entry is ours and whose tree alone listens on it.
- **docker-compose provider** (`compose.ts`, `docker.ts`). Docker: `$RETAKE_DOCKER`, PATH, then the usual install
  places (`dockerPlaces`: Docker Desktop, OrbStack's bin and xbin, Homebrew, /usr/bin — doctor looks there too);
  `compose version --short` ≥ 2.17 and `info --format {{.ServerVersion}}` (the daemon) checked once per call;
  every call runs with the CLI's env minus `COMPOSE_*`, output captured, killed on abort. Project ref: `compose.project`
  or `retake-<slug>-<env>-<sha256(realpath(folder))[0:8]>` (≤ 63, sanitised), `--project-directory` = the real
  folder, `-f` per file, `--ansi never`. `ps()` (`ps --all --format json`: NDJSON or one array; Labels a comma-joined
  string cut before `,key=`; one-off containers dropped) refuses containers whose `working_dir` label is another
  folder, and every command reads it first (up, down, status, restart, exec — once per call —, logs, followLogs,
  publishedBy). Other projects' publishers: `docker ps --filter publish=<port>… --format {{json .}}` (`parseDockerPs`:
  name, compose project and folder labels, `Ports` text with host addresses and ranges) — any container that is not
  the project's own (name and folder) publishing one of the ports, on any address, is refused `port` (OrbStack lets
  one publish [::1] / [::] next to the sandbox's 127.0.0.1; lsof shows its helper alone). Addresses: `remember(ps)`
  keeps, per port of the project's running containers, `connectAddress(hosts)` (0.0.0.0 → 127.0.0.1, :: → ::1, IPv4
  first); health checks (`pinHealth`: http targets on a loopback host *name*, sent with node:http and a pinned
  `lookup` — URL and Host header unchanged), `SELECT 1`, the snapshot (`address()` → `PostgresSnapshot.open`), the
  seed's sql steps (`HookContext.connectAddress`) and the mailbox clear (`pinnedRequest`) use it. `up`: `config
  --format json` (services, published TCP ports with ranges, images: `image` or `<project>-<service>`) → `ps` → the
  manifest's ports must be published → a recorded earlier name (`provider_state.compose.project` / `.previous` ≠ the
  current one) still running refused, one with containers or volumes left kept in `previous` → other projects'
  publishers of every published port refused → published ports not held by the project's running containers must have
  no listener (`busyPorts`) → `provider_state.compose` saved, the services not running recorded as started →
  `up -d --wait --wait-timeout <max health.timeout_s | 120> --remove-orphans [--build]` (lines to compose-up.log and
  debug) → `ps` again: every config service `running` with Health `healthy` or `""` (`serviceProblems`; else a
  SandboxError `unhealthy` listing each state + `logs --tail 30` of up to 3) whatever the exit code → `foreignListeners`
  on the published ports (lsof: names matching `DOCKER_HELPER` — OrbStack Helper, com.docker…, vpnkit, rootlesskit… —
  or, when none, the one pid on every port, are the runtime; anything else is refused `port`) → other projects'
  publishers again → `remember` → `waitHealthy` (pinned) per manifest service (120 s default) → `SELECT 1` per Postgres
  database (`pgAnswers` on `pgEndpoint(url)` — pg's own parser, refused unless it is the URL's loopback host and port —
  on the published address unless `external`; SQLSTATE 3D000 / 55000 count as ready — the server answers, the reset
  repairs the database; retried until the wait timeout).
  `status`: manifest services first, then the other config services, then containers of removed services (orphans);
  docker's state / health, then `healthNow` (pinned) for manifest services; an earlier name with containers or volumes
  left is a note. `down`: `down --remove-orphans [--volumes]`, then each earlier name the same way from its recorded
  folder (`-p <old> --project-directory <dir>`, after its own folder check); `provider_state.compose` dropped unless an
  earlier name still has volumes (kept as `previous`, with a warning), `.snapshot` dropped with volumes; `dataGone =
  volumes`. `restart`: `ps` → `restart <svc>` → wait running/healthy → manifest health (pinned). `publishedBy(port,
  use)`: a running container of the project publishing it, its `working_dir` label the sandbox's folder (missing:
  refused), no foreign lsof listener, no other project's publisher.
  `exec`: `exec -T -e RETAKE_EXEC [-e NAME…] <svc> sh -c <cmd> | argv` (values in docker's env;
  RETAKE_EXEC=<random token> marks every process it starts), command/env templated (pages, vars, secrets), the
  hosts of the rendered command and env checked (`checkExecHosts`: a compose service, `isHostAllowed`, never
  `protectedBy` the run's access), timeout, output to seed.log masked (`masker`: the resolved values and
  `sandboxSecrets`); aborted or timed out → `KILL_EXEC_SCRIPT` run in the service (`sh`, `/proc/*/environ`: SIGTERM
  to the marked processes, 3 s, SIGKILL; a warning when it cannot run), aborted → SandboxError `interrupted` (kept by
  runSeed); non-zero → the exit code and the last 20 lines. `stopStarted`: `stop <started>` (logs kept);
  `killStartedSync`: SIGKILL the running compose child, the running exec's marked processes (`KILL` at once), and
  `spawnSync kill <started>`. `logs`: `logs
  --no-color --no-log-prefix --tail N <svc>` per service; `followLogs`: `logs --follow`.
- **Snapshot reset** (`snapshot-postgres.ts`, strategy `snapshot`, in `resetLocked`): `snapshotTarget` (the database
  key, its URL with secrets resolved, `pgEndpoint` — host, port, database, user, password as pg's own parser reads
  them, refused unless that is the URL's loopback host and port; a system database refused again —, `<db>__ds_snapshot`;
  pg is given the endpoint, never the URL) → `provider.publishedBy(port)` (refused without it: process)
  → `PostgresSnapshot.open` on `provider.address(port)` (127.0.0.1 / ::1, never `localhost`; maintenance connection to `postgres`, else `template1`; `server_version_num` ≥ 130000) →
  `repair()` (ALLOW_CONNECTIONS back on) → valid = not `--reseed`, `state.seed.hash` = `provider_state.snapshot.hash`
  = the current hash (core `seedHash(sandbox, hashInputs)`) and the template exists, is a template, with the comment
  `retake snapshot <hash>` → `restore(owner)` (ALTER … ALLOW_CONNECTIONS false, DROP … IF EXISTS … WITH (FORCE),
  CREATE … TEMPLATE … OWNER; no abort check between DROP and CREATE); otherwise `ensureDatabase` (an interrupted
  restore) → the seed → `take(hash)` (block + terminate, drop the old template, CREATE … TEMPLATE app, connections
  back in a `finally`, ALLOW_CONNECTIONS false IS_TEMPLATE true, COMMENT) → state. One `query()` per statement;
  STRATEGY omitted. Supersede right after the restore or the seed; then the mailbox, `reset.restart`, `last_reset
  {strategy, restored}`.
- **init** (`init.ts`, `scaffold/docker-compose/`): placeholders `__SCHEMA__ __ENV__ __PROJECT__ __ENV_FLAG__
  __APP_PORT__ __DB_PORT__ __MAIL_PORT__ __DB_PASSWORD__` rendered into sandbox.yaml, compose.yaml, README.md,
  app/index.html, seed/01-demo-data.sql under `sandbox/` (`sandbox/<env>/` for another name); any of those files
  already there refuses it before anything is written, unless `--force`; 3 ports free from 4600 (not used by the
  project's environments or other sandboxes, nothing answering); `$schema` relative inside one top-level folder, else
  a file:// URL; project.yaml through core `addSandboxEntry` — text edits only: appended (before a `...` document
  end), after the last entry of a block `sandboxes:`, or inside a one-line flow `sandboxes: {…}`, the file's line
  endings kept; a flow mapping over several lines through the yaml Document API (`lineWidth: 0`,
  `flowCollectionPadding: false`); checked by re-parsing.
- **Interrupts.** The CLI runs `up` / `reset` / `down` / `prepareTake` under `onInterrupt({message, onQuitSync})`: the
  first signal aborts (the call stops what it started and a running seed step, exit 130); the second runs
  `killStartedSync` (SIGKILL to the groups started by this call and their descendants, state entries removed; the
  seed's running shell groups; an exec step's processes in its container) and exits.
- **CLI.** `commands/sandbox.ts`: the five commands; `pickSandboxEnv(project, --env, scenario env)` (a usage error
  without sandboxes or for a non-sandbox `--env`); `prepareSandboxTake` (header line, exit codes); `checkSandboxEnv`
  (a run on a sandbox environment without --sandbox); `sandboxSummary` (the run summary line); `sandboxInitCommand`;
  `--build` / `--volumes` / `--follow` are usage errors on a process sandbox. `run.ts`: the scenario's raw `env:`
  (core `scenarioEnvOf`, no validation) → `pickSandboxEnv` → the scenario validated once against that environment →
  prepareTake → `runScenario({sandbox: take.info})`, the lock named after the run at `run_start`, released in
  `finally`. Runner: `RunOptions.sandbox` → `environment.sandbox` (a sandbox environment without it: `{name,
  provider}`). Doctor: one `Sandbox <env>` line per sandbox (`DoctorProbes.sandbox`), its personas and hosts left out;
  one `Docker` line (`dockerCheck`: PATH, then `dockerPlaces`; version, Compose ≥ 2.17, daemon, context — WARN when
  missing, naming the `--project`'s docker-compose sandboxes; FAIL only when its default sandbox — `default_env` when
  a sandbox, else the first declared — is one). `auth status`: sandbox personas `auto` (above).

### 3.9 Page inspection (L3.3; runner `inspect.ts`, kit `inventory` / `checkTargets`, core `inspect.ts`)

What `page_inspect` and `retake inspect` (job, MCP tool, CLI: L3.3 part 2) run in the worker. The tool makes no model
call: the inspection hands Claude page facts and verified targets; Claude writes the scenario.

- **Run path.** `runScenario({mode: 'dry', inspect: {within?, targets?, limit?, budgetMs?, onResult}, runsDir, runId})`
  — exactly `run_dry` semantics: the environment's own access (a production environment stays read-only, no extra
  write guard), personas on session copies with the off-camera preflight (an automated sign-in refreshes the persona's
  stored session in `RETAKE_HOME`, as any run), the sign-in guard, the product clock, agent trust with `hookTrust:
  'mcp'`. Hooks are always skipped (`record.hooks.setup: skipped`); a mode other than `dry` is refused. The replay runs
  at `INSPECT_PACING` (fast cursor travel, hover, typing, scrolls; navigation / popup / settle waits unchanged), every
  pause — `hold`, `wait`, a step's `hold:`, a scene's still — capped at 0.2 s (`Runtime.pause`), and takes no per-step
  dry screenshot. A plain page uses core `inspectScenario(page, path)`: one scene `{page, open: path, steps: [{wait:
  0}]}`; `inspectPathProblem` refuses a path that is not `/…`, `//host`, a backslash, `{{…}}` or a control character.
  The caller passes `runsDir` / `runId` (the inspection id) so the folder stays out of `runs/` (`run_list`, `latest`
  and reviews read `runs/` only).
- **When.** After the last step (`at: end`) or at `until` (`at: until`); at the step that failed (`at: failed_step`,
  `replay.failed`, the error under `untrusted`; the run still fails) — never after a sign-in landing (the run discards
  everything, as any run). `replay` also reports `skipped_irreversible` (irreversible steps a dry run shows without
  executing them: the page may differ past them) and `hooks: skipped`.
- **Origin check.** Before anything is taken, `page.url()` must have the exact origin of one of the environment's pages
  (core `isPageOrigin`: scheme + host + port — another localhost port is another app). Otherwise `status:
  landed_elsewhere`, only the host under `untrusted.landed_host`: no screenshot, no inventory, no URL. A page can still
  leave while it is inspected (a late script navigation, a slow redirect), so the check is made where the data comes
  from: `inventory` and `checkTargets` return their document's `location.origin`, checked the same way; they run
  through `KitClient.callOnce` (a document replaced during the call is `DocumentChangedError`, never retried in the new
  document — the page's new URL then decides `landed_elsewhere` or `failed`); `page.url()` is checked again after the
  screenshot (changed: the screenshot is deleted). While it runs, a page route answers a main-frame navigation request
  to another origin with 204 No Content (the page keeps its document; counted in a warning) — a redirect is not
  routed, the checks above catch it. Nothing read before a failed check is kept. The reported URL is origin + path.
- **Inventory** (kit `inventory`, one synchronous in-page call). The visible interactive elements of the page (open
  shadow roots and same-origin frames included; closed shadow roots are invisible, cross-origin frames counted),
  labels merged into a visible control, an interactive element inside a button / link / option dropped. Order: the top
  popup layer, then in view, then the rest; `limit` 80 (≤ 300). Per element: box, in view, `in` (page / dialog / menu /
  listbox / popover / row), `where` (document / shadow / frame), state booleans (disabled, expanded, checked, selected,
  popup expected, `covered`: something is drawn over its centre), role, tag, input type, name, shown text (never a
  field's content), label, placeholder, testid, a link's path (no query, no fragment). Interactive includes ARIA
  text fields without a tabindex (`textbox`, `searchbox`, `spinbutton`, `slider`). Label and `aria-labelledby` texts
  and names from content leave out what a field holds (`nameText`: a textarea's text, a select's options, an edited
  region, the element itself when `aria-labelledby` names it), and a contenteditable / ARIA text field is never named
  by its content. Plus title, h1–h3 headings,
  popups (kind as a closed enum + name), scroll containers, counts. No field value is ever read.
- **Suggested target** (the ladder). Fields: `{label}`, `{placeholder}`, `{role, name}`; others: the text (a text of
  several pieces — initials + name, a label + a count badge — tries its lettered pieces first; a text of symbols only
  is skipped), `{role, name}`; then the same scoped `in: dialog | menu | listbox | popover | {row: key}` (the row key: a
  leaf text of the row for which `rowFor` returns that row); then `{testid}`, `{aria}`, `{css: '#id'}` only for an id
  that does not look generated (`GENERATED_ID`: `:`, 3+ digits, hashes); a symbols-only `{role, name}` last. In-memory
  indexes over every visible interactive element (text, name, role + name, label, placeholder, aria, testid, id) skip
  a candidate another element shares; each remaining one (≤ 5 per element) is **verified with `find` itself** and kept
  only when the match is this element with count 1. None: the most specific base with `nth` = the element's index
  among its visible matches, verified the same way (`fragile: nth`, `matches` = the count). Flags: `nth`, `css`,
  `dynamic_text` (a digit in the text or row key), `broader` (another index key contains it: a substring tier would
  match if it went away). **Per-call memo** (`withMemo`): during the call, `trees`, `deepQsa`, `isVisible`,
  `accessibleName`, `labelPairs`, lower-cased texts and `rowFor` are computed once (the DOM cannot change inside a
  synchronous call); every other kit call sees the live DOM. A time budget (2.5 s) stops suggesting (`partial`, the
  rest `unsuggested`), checked before each lookup; an unscoped `nth` is not looked up among more than 10,000 matches
  (`NTH_MAX`: one lookup over 50,000 identical buttons took ≈ 3 s on its own); measured ≈ 1.25 s in-page (1.3 s for the whole inspection) for 80 elements of the lab's
  5,000-row table (10,021 visible interactive elements), 83 `find` verifications.
- **Action hint**, checked through the runner's own helper: `select {field}` when `find({label})` gives this element
  (native select, combobox), `menu {row}` when `rowFor(key)` is the row and `menuTrigger(row)` this element,
  `drop_file {zone}` when `fileInputFor` finds the input; else `type {into}` for a field, `click`. `action_verified`
  says so.
- **Runner side** (`inspectPage`): `within` resolved first (not found: nothing listed, `within_found: false`),
  `targets` (≤ 20, normalised; a point refused) checked with `find` (count, chosen index, box; desc and near texts
  under `untrusted`), the screenshot last (viewport PNG, the cursor hidden; boxes are CSS px, × `scale` on it), the
  sign-in guard checked again after it. Each suggestion is serialised (`targetValue`: the bare string only when
  `normalizeTarget` reads it back as the same `{text}`; `flowYaml`) and kept only when the YAML reads back as the
  verified target (`roundTrips`; else dropped and counted). Report → `secrets.redactDeep` → `inspect.json`.
- **Trust split.** Page-controlled strings — URL, title, headings, every element's role, tag, input type, name, text,
  label, placeholder, testid, link path, target and step hint, popup names, target-check descriptions, errors — sit
  under an `untrusted` key (per element, per popup, per check, and at the top). Outside it: marks, boxes, booleans,
  counts, matches and closed enums (`in`, `where`, `fragile`, `action`, popup kind, status, at).
- **Job** (engine `jobs/inspect-job.ts`, core `InspectJobInputSchema`, kind `inspect`). Input: project, `inspect_id`
  (`i_` + 26 Crockford characters, reserved at submit), env, `source` = `{kind: page, page, path, persona?}` or `{kind:
  scenario, scenario, scenario_sha256, until?}`, `within?`, `targets?` (≤ 20; `InspectTargetSchema`: a target of ≤ 2,000
  characters with no `{{`), `limit?` (≤ 300), `images: marked | none`. A client's `url` is resolved at submit
  (`pageOfUrl`): http(s), no credentials, `isPageOrigin` against the environment's pages, then the page whose base path
  is the longest prefix → page key + path (query and fragment kept). Submit and the worker both run `prepareInspect`
  (page key exists, its own URL is http(s), the synthetic scenario validated against project + environment with its
  persona; or `prepareRun(dry, until)` + the sha256 of the scenario file, `conflict` when it changed),
  `checkWorkspaceProtection`; submit adds `checkAgentTrust` and the `{{` refusal of every argument; the worker runs the
  replay with `hookTrust: 'mcp'` (agent trust in the runner) and `checkSandboxEnv`. The folder `<project>/.retake/
  inspect/<id>/` is made at submit (removed if the enqueue fails); `pruneInspections` keeps the newest 20 (ids sort by
  creation; the new one and those of queued / running inspect jobs are never removed). `runInspection` (shared with the CLI) → `runScenario` with `runsDir` =
  `inspect/`, `runId` = the id, then `drawMarks` through the engine's lazy `review()` import when the report is `ok`
  and images are `marked`. Result (`InspectJobResult`): ids, folder, `reported`, status, at, page key, persona, the
  replay's run status, file paths, counts, replay — no page text outside `untrusted: {error?, warnings}`. No report
  (preflight, sign-in landing, a refused scenario): the job succeeds with `reported: false`, the run's error under
  `untrusted.error`, and `sign_in: {env, persona}` when the runner asked for a persona's sign-in command (its
  `loginCommand` callback is called only to word that fix). A cancel → job `cancelled`; an interrupted one's fix is the
  `retake inspect` command. History: kind `inspect`, `inspect: {id, source, status, reported}`, counts nothing.
- **Marks** (review `drawMarks(png, boxes, out, {scale})`, sharp): one outline and a numbered badge (20 CSS px × scale,
  above the box when there is room) per listed element in view and not `covered` (engine `markBoxes`: a background
  button under a modal would get a number drawn on the modal), boxes × `report.scale`, JPEG `marked.jpg`.
- **MCP tool** `page_inspect` (`tools/inspect.ts`; RUN_JOB annotations; `wait_s` default 25). Exactly one of `page`
  (+ `path`), `url`, `scenario` (+ `until`); `persona` only with a page. The summary: job line, replay line (steps,
  irreversible steps skipped, hooks), the failure's step, counts, `within` / budget / truncation notes, the next step of
  the authoring loop; the page key and the scenario's own ids only. Data: status, at, page, persona, viewport, scale,
  replay, counts, popups (kind + box), scrollers, files, `truncated`, and `untrusted: {url, title, headings,
  landed_host?, error?, warnings, popups (names), targets_checked, elements}` — every element whole under `untrusted`.
  `capUntrusted` (2,000 characters a string) and a whole-result cap of 80,000 characters (elements dropped from the
  end, counted). Image: `marked.jpg` (else `screenshot.png`) through `imageResult`'s caps, none for `images: none` or a
  status other than `ok`. `job_status` of an inspect job returns the same output (and the image) with the job; `reported:
  false` with `sign_in` gives the `auth_login {project, env, persona}` line for the user; a reported inspection whose
  folder was pruned since says so (`pruned: true`). INSTRUCTIONS: the authoring
  loop (page_inspect → Claude writes the YAML → scenario_validate → scenario_save → page_inspect {scenario, until} →
  run_dry → capture).
- **CLI** `retake inspect <project> <page|url|scenario> [--path] [--until] [--persona] [--env] [--within T] [--target
  T]… [--limit] [--images] [--json] [--out DIR]` (`commands/inspect.ts`): the same `prepareInspect` + `runInspection`
  in-process (trust `author`, no queue, no protected-hosts check), targets given as YAML or text; a table on stderr or
  the report on stdout (`--json`); exit 0 only when the page was inspected (`ok`). The table flags `covered (not
  marked)`; a page with `--until` is a usage error that says so; a page's argument errors (an unknown persona, a bad
  path) are told by argument, never by a position in the scenario the command builds.

### 3.10 Script → skeleton (L3.3 part 3; core `script-draft.ts`, engine `authoring.ts`, MCP `tools/authoring.ts`)

An optional aid, never the start of the authoring loop: a timecoded Markdown table the user hands becomes an outline
and a draft that validates. Pure and deterministic (no model, no network, nothing written).
- **core** `draftScenarioFromScript(markdown, {env, video?})` → `{outline, yaml, issues}`. The first GFM pipe table
  (header line + separator) whose headers map to a time or duration column and a scene, action or caption column;
  header aliases normalised (lower case, accents, emphasis and `(…)` dropped): time, end, duration, scene, action,
  caption, kicker, page, type, in English and French (`SCRIPT_MARKDOWN_MAX` 100 kB, `SCRIPT_ROWS_MAX` 500). Cells:
  `\|` escapes, 1-based columns kept for issues; a cell with `{{` is dropped (warning). Times `M:SS` or a range
  (`–`, `—`, `-`, `→`, `->`, `to`, `à`); duration = range / end, else the duration cell (`5`, `5s`, `M:SS`), else up to
  the next timed row shared by the untimed rows between, else `SCRIPT_DEFAULT_ROW_S` (5) with a warning; overlaps and
  end-before-start warned. Types: scene (default), interstitial (`intertitre`, `carton`), title (`titre`, `intro`),
  outro (`end`, `fin`, `conclusion`); unknown → scene with a warning. Consecutive rows with the same (or an empty)
  scene cell are beats of one scene; ids slugged from the name, unique (`-2`), `scene-<n>` when nothing is left. Pages:
  a key (case-insensitive), `key:/path` / `key /path`, a `/path` on the current page, or a URL (or bare host) whose
  origin — or a display base's host — is an environment page's, the longest base path winning → key + relative path
  (checked by `inspectPathProblem`); anything else is left out with a warning. The first scene opens the
  environment's first page when the script names none; a page cell inside a scene (not its first row) is warned, not
  split. Timing warnings (`SCRIPT_TIMING`): total outside 45–150 s (the look's 60–120 s ± 25 %), a scene under 2 s
  (unreadable), under 4 s or over 25 s. Errors only when there is no draft (no table, no usable table, too long, no
  scene row). The YAML: `version`, `video`, `title` + `intro.duration`, `outro {tagline, duration}`, scenes (`id`,
  first beat's caption, `page` + `open` when known, one `hold: <duration>` per beat with `note: <action>` and a later
  beat's own caption), interstitials (`{kicker?, text, duration}`); flow style for caption / title / intro / outro /
  interstitial maps; a header comment saying it is a skeleton.
- **engine** `draftFromScript(project, markdown, {env?, name?, agent?})` (`engine.scenarios.fromScript`, feature
  `scenarios.from_script`): resolves the environment, drafts, then `validateScenarioText` (agent rules for the MCP
  client) → `{project, env, name, outline, yaml, script_issues, validation}`.
- **MCP** `scenario_from_script({project, script_markdown, env?, name?})` (READ): summary = scenes, beats, title /
  outro / interstitials, total, validates or not, "a skeleton: rewrite the holds from page_inspect, then validate and
  save", every issue (`script L:C …`, `draft L:C …`). INSTRUCTIONS mention it on its own line after the loop, only for
  a table the user hands.

### 3.11 Recording: capture (L3.4 part 1; runner `record-session.ts`, `kit/record-script.ts`, kit `suggestFor` / `secretField`, core `recording.ts`)

A person performs a flow once in a HEADED window; the actions become events for the draft generator (part 2). Claude
may start a recording, never drive it. Nothing is filmed. L4.8: the Studio's Record screen (§4h) is this window's control
panel — the same session, nothing forwarded to it.
- **runner** `recordSession({project, env, persona?, url, allowWrites?, eventsFile?, maxMs?, stop?, signal?, drive?,
  headless?, windowSize?})` → `{events, stop: closed | stopped | max_duration, ms, window, capture, access, persona,
  counts {events, actions, writes, redacted, dropped {sign_in, frame, invalid, new_page}}, warnings}` (warnings never
  quote page text). The window: `launchPersistentContext` on a COPY of the persona's profile (`prepareSessions`; a
  snapshot / signed-out persona: a fresh `retake-session-record-*` profile), its snapshot applied, `Preferences`
  with the password manager and autofill off (`disableAutofill`), `viewport: null` at the window's real size
  (`--start-maximized`; no `--hide-scrollbars`; a window narrower than `capture.width` is warned — the check replay runs
  at the capture size), Ctrl-C / SIGTERM left to the caller. The environment's access as in a run
  (`resolveRunAccess`, `compileWritePolicy`): a read-only environment arms the write guard (writes stopped / mocked,
  each one a `write` event); a read-write one lists every write request to its pages' origins (`passed`). Ends when the
  last page closes (`closed`), on `stop` (the pending typing committed through `__dsrecFlush`, then the window closes:
  `stopped`) or after `maxMs` (default `RECORD_MAX_MS` 30 min: `max_duration`); `signal` closes the window, removes the
  events file and throws a CancelledError. `drive` / `headless` play the person in tests (Playwright input is trusted).
- **isolated world** (no `exposeBinding`): one CDP session on the window's page — `Page.enable`, `Runtime.enable`,
  `Runtime.addBinding({name: random, executionContextName: 'retake-record'})`,
  `Page.addScriptToEvaluateOnNewDocument({source: passive kit + recorder, worldName, runImmediately})`. The page's main
  world sees no binding, no kit, no recorder, no `__playwright__binding__`, no cursor element; it cannot call them or
  touch the world's prototypes; only `isTrusted` events count. An isolated context reports origin `://`: its origin is
  the frame's main-world context created just before it. A message is kept only from the recorder's world, on an
  environment page origin; from a sub-frame only a content-free `frame` notice (counted).
- **in page** (`demoRecorder`, serialised): capture-phase listeners on the window, registered before the page's scripts.
  `pointerdown` → `pointer` with the element (`kit.suggestFor`, budget `RECORD_BUDGET_MS` 150 ms; else a description
  fallback without a target), `quiet_ms` (since the DOM last changed), `ms` (the in-page cost); Enter / Space on a
  focused control whose `click` has `detail: 0` → `pointer` `via: keyboard`, else a `key`; `dblclick`; typing per field
  committed at blur, Enter (`enter: true`), the next action elsewhere, `pagehide` or `__dsrecFlush`: the text past what
  the field held at focus when text was only added at its end — the initial value never crosses on its own; after an
  edit inside the field (a deletion, an insertion before its end) `clear: true` and its whole final value, which holds
  the parts of the initial value that were kept (a replay types the final value: only the changed part would not do);
  native `<select>` change → `select_native` (the option's label); a file input's change / a drop → `file` (names
  only); a scroll the person made (wheel, scroll keys, a scrollbar press) → `scroll` per container, net, after 400 ms;
  keys only `RECORDED_KEYS` outside text fields (Escape, Enter, Space, arrows, paging, Backspace, Delete) or a
  Control / Meta + letter / digit; inside a field Escape / ArrowUp / ArrowDown / PageUp / PageDown only; Space,
  Backspace and Delete are not sent when the focus is inside a closed shadow root (the event's deepest target is the
  focused host, which is not focusable itself: its field cannot be classified and the keys would count words). `appeared`:
  the element (or an ancestor) was added since the previous action (MutationObserver).
- **secrets**: `kit.secretField(el)` (1.5.0) classifies a field — `type=password`; autocomplete current- / new-password,
  one-time-code, cc-*; words of its name, id, label, aria-label, placeholder, title or test id (password, otp, cvc,
  card number, IBAN, SSN, PIN, token, API key, secret); one of ≥ 4 one-character inputs → `one_time_code` — and the
  recorder makes it STICKY per element. A secret field's typing carries no `text` (`secret: true`, `field_kind` = the
  kind). The in-page memory remembers (≥ `SECRET_MIN` 6 characters: a 4-digit PIN would mask dates) a secret field's
  committed values and its initial one, its current value while it is typed in (each new one replaces the last, so a
  prefix — a common word — is never kept), a high-entropy paste or text drop (`looksLikeToken`: ≥ 20 characters, no
  white space, ≥ 3 classes → `api_key`) and an autofilled value (an input with no key / paste / drop in the last
  second → `secret`); every outgoing string is masked (`•••`, `redacted: n`) where
  it contains one, and a typing whose value the memory knows becomes secret (a re-mounted field, a password pasted
  elsewhere). Final values are told to the runner as `[length, cyrb53(value, random salt)]` (`secretHash`, the same
  function on both sides); the runner masks every string it keeps (write labels, typed queries) and hands the hashes
  to every new document with its verdict. Never written: a secret value, a hash.
- **sign-in pages** (`signInMatchers`, extracted from the run's guard: the persona's patterns, else the environment's
  `auth.login_url`): the page holds its events until the runner's verdict for its origin + path
  (`__dsrecVerdict(url, ok, hashes)`, asked once per path); on a sign-in page they are discarded and counted
  (`dropped {reason: sign_in}`); the runner checks each event's path again.
- **runner side**: navigations of the main frame from CDP (`Page.frameNavigated` + `Page.getNavigationHistory`'s
  transition type → `start` / `typed` / `link` / `form` / `reload` / `other`; `Page.navigatedWithinDocument` → `spa`,
  a fragment-only change ignored), `where` environment (with `page_key`, the longest base prefix) / `sign_in` /
  `foreign` (the host only); paths never carry a query — a `typed` navigation keeps a filtered one (keys like token,
  code, state, session, auth, key, pass, otp… removed; values that look like a secret or the memory knows removed);
  every kept path and write label has its segments that look like a secret masked (`maskPathSecrets` /
  `looksLikeSecretSegment`: an e-mail address, ≥ 32 hex digits — a UUID included —, a JWT, a mixed-case key, a run of
  ≥ 20 letters and digits; a slug is none). Writes: the guard's own reports (`blocked` / `mocked` / `allowed` /
  `passed` on a read-only environment; the protected hosts of a read-write one); on a read-write environment every
  other write request of the window (not GET / HEAD / OPTIONS, not a GraphQL body that only reads), whatever its
  host — an API on another host, a `read_only.hosts` entry, a form post, a beacon —, `outcome: passed`. Tabs / popups the page opens:
  `new_page`, not recorded (warned). Each event is validated by `RecordedEventSchema` (else counted `invalid`), given
  `seq`, `t` (ms since start, minus the in-page age) and `page: p1`, appended to `eventsFile` (0600) and passed to
  `onEvent`.
- **core** `recording.ts`: `RECORDING_VERSION` 1, `RECORD_ID_RE` (`rec_` + 26 Crockford), `SECRET_FIELD_KINDS`,
  `RECORDED_KEYS`, `RecordedElementSchema` (the inventory entry: target, matches, fragile, in, action, role, tag,
  input_type, name, text, label, placeholder, testid, href_path, in_view, state, appeared, secret, desc?,
  alternatives? / alternatives_partial? — L4.8) and
  `RecordedEventSchema` (pointer, dblclick, type, select_native, file, key, scroll, navigation, new_page, write,
  dropped, stop; strict objects; a secret `type` without `text`, a plain one with it; a path without `?` / `#`; a
  printable key only with Control / Meta).
- **kit 1.5.0**: `passive` config (the recorder's copy: no overlay, no listener, no patched API); `suggestFor(el | ref,
  {budget_ms})` = `inventory({within, limit: 1})` on the element, else its label's control, a hidden file input's label,
  or its nearest interactive ancestors (≤ 4 tries) — null when nothing interactive holds it; `secretField`. Measured: a
  press on the lab costs 1–4 ms in the page; on `/inspect-lab?rows=5000` (≈ 10,000 controls) ≈ 210 ms, the budget spent
  (description fallback).
- **alternative targets (L4.8, kit 1.6.0)**: `inventory({alternatives: n ≤ 3, alternatives_budget_ms})` /
  `suggestFor(el, {alternatives})` go on along the ladder past the verified suggestion: never `nth` / `last_visible`
  (none at all when the suggestion is positional), never a key an index knows is shared, each `verify`-ed to resolve
  once to this very element (a key the page shares with a non-interactive element is not offered), ≤ 3 kept, ≤ 6 extra
  verifications, an own budget of min(10 ms, what is left of the press's 150 ms) — none, `alternatives_partial`, after a
  suggestion over 20 ms or on a page of over 2,000 distinct texts. Only asked for by the recorder (`info(target, true)`
  on a press, a keyboard activation, typing, a native select, a file; never a scroll or a key), never kept for a secret
  field; page_inspect's inventory never carries them. They reach the event as `el.alternatives` (`{target, fragile}`,
  ≤ 3, never positional in the schema) through the in-page and runner masking like every string; an event the schema
  refuses only for its alternatives is kept without them. `RECORD_ALT_BUDGET_MS` 10 (test hook `alternativesBudgetMs`).
  Measured (headless, 2026-10-28): a press on the lab p50 1 ms / p95 4 ms in the page with alternatives, the same
  without; a press on `/inspect-lab?rows=5000` ≈ 250 ms (a slow suggestion: no alternatives).

### 3.12 Recording: draft, engine, CLI (L3.4 part 2; core `draftFromRecording`, engine `record.ts`, `retake record`)

- **core** `draftFromRecording(events, {name, env, envIsDefault, pages, persona, defaultPersonas?, projectVars?,
  access})` → `{scenario, yaml, issues, writes, firstWrite, stats}`. Pure; events in `seq` order; writes taken apart
  first. Rules: a press → `click` on the verified target (`targetValue`: a lone text as a string), a right press keeps
  `button: right`, a middle one is dropped; no target → a fallback `{text, in?}` from the element's own name (warned
  `fallback_target`), nothing for a container / masked text / no text; `el: null` is noise (counted). Two presses on one
  element + `dblclick` → `double_click`. A press followed by presses / typing in a `listbox` / `popover`: options
  (`role: option`, by accessible name) → one option on a `select {field}` trigger, or a list that closed by itself →
  `select {field | combobox, option, search?}`; else `pick {field: label | trigger target, option(s), search?, close}`
  — `escape` (an Escape key after it, absorbed), `outside` (a press on nothing / a container after it, absorbed; also
  when another action follows), `none` (nothing follows). A `menu {row}` trigger + a `menu` item → `menu {row | trigger,
  item, confirm?}`: confirm = the next press when it is a button that appeared in a dialog within 10 s named like the
  item (or yes / ok / confirm / continue); else it stays a click. A `drop_file` zone + `file` → `drop_file {zone, name:
  first name, fake: true}` (info); a zone without a file is dropped. `type` → `type {into, text | {{vars.<kind>_N}},
  clear?, enter?}`, the click on the same target just before folded into `into` (`select_native` likewise →
  `select {combobox, option}`); consecutive one-time-code boxes merge on the first (warned). Secret placeholders:
  `vars.<kind>_N: CHANGE-ME` unless project.yaml `vars` has that name (then it is used, no scenario var). `key` →
  `press` (`Space`, `Meta+k`). Scrolls add up per container until the next action: ≥ `RECORD_SCROLL_MIN_PX` (120) →
  `scroll {to: <next target>, in?}`, or `{by}` when no target follows. Before an action: `wait_for {target, timeout:
  max(15, ⌈2 × gap⌉)}` when its element appeared and the gap since the previous action is ≥ 1.5 s, never for the first
  action after a document load. Scenes: the first `{page, open}` from the start; a page change with steps in the scene
  starts a new one — `open:` (the path under the page's base, a typed query kept) when the address bar, a reload or
  history moved it with no action in the last second, or when the window comes back from a sign-in page / another
  site (actions there are dropped, `signed_out` / `foreign_page`); otherwise no `open:` (it continues). Ids from the
  path's first meaningful segment (`home` for `/`), `-2`… when taken; empty scenes dropped. `env:` unless the default;
  `persona:` on the first scene when it differs from the page's default (`none` signed out). Every write (any host)
  goes to the last step that ended ≤ `RECORD_WRITE_WINDOW_MS` (2 s) before it as `note: sends …` (`(stopped:
  read-only)` / `(answered by a mock: read-only)`), else it is ambient (info, at the step after it); `firstWrite` = the
  first step followed by a write that went through (not `blocked` / `mocked`), however long after — the check replay
  stops before it. A recorded string holding `{{` (typed text, a name, a label, an option, a search) never reaches the
  draft: its step is left out (`template_text`; the click that focused a field stays), and `open:` writes `{{`
  percent-encoded; an `open:` holding a masked segment is warned (`secret_path`). Issues come in the order they were
  raised, each with `scene` and `step` (the step it is about, or for what happened between steps the next one — the
  scene's step count at its end); a click folded into the typing that follows it passes its issues on. The YAML:
  steps' values in flow style, a header comment; the draft is parsed (`parseScenario`) and any error is an `invalid`
  issue (`draftInvalidIssue`: a fixed message, its line, scene and step — never the validator's text). Issue messages
  never quote page text or a typed value. Two typing events on one field (the same recorded target) with nothing
  between them but scrolls under 120 px, the second without `clear`, the first without `enter`, are one `type` step
  (L4.8: a visit to another window blurs the field and commits the first part) — not when an annotation insert sits
  between them, the joined text would hold `{{` or pass 2,000 characters; two secret parts of one kind stay one
  placeholder (never a second one that appends); the step keeps each part's time (`tw`), so a write that follows
  either part is attributed to it (the window counts from the latest part before the write).
- **Hidden characters (L4.8 review A-M3)**: a recorded string holding one of the characters no Studio write adds
  (scenario-edit.ts `firstHiddenChar`: controls, zero-width and direction characters, line / paragraph separators, a
  BOM inside) is treated like a masked or templated one: a press on such a name, typed or pasted text, a choice, an
  alternative — the step is left out (`hidden_text`, never quoted), no such alternative is offered, and any step that
  would hold one (a list's field name…) is refused by `push` itself; a write label with one is not quoted in `note:`.
  Recordings without one are unchanged (golden drafts of L3.4's generator: core test fixtures `recordings/`).
- **Studio annotations (L4.8; core `record-annotations.ts`)**: `draftFromRecording(events, ctx, annotations?, {final?})`
  with `{v: 1, rev, choices: {"<seq>": 0..3}, inserts: [{id, after_seq, kind, …}]}` (strict; ≤ 200 inserts, ≤ 2,000
  choices, 64 KiB; Studio text without `{{`, control or hidden characters, line breaks included). Without annotations
  (or empty ones) the draft is the recorder's, byte for byte (tested over every generator case, also with alternatives
  on every element). Picks: every fold and merge decision compares the recorded targets; a pick is written only when
  the draft is emitted, at the step's main target (click, double_click, `type {into}`, `select {combobox}`, `drop_file
  {zone}` — never a list's label, a select by field or a row menu): the latest of the step's target events that has a
  choice wins (0 = the recorder's suggestion), and the recorder's own `wait_for` / `scroll {to}` before that action
  follow it; `recordedAlternatives(el)` lists the offered ones (masked, templated, hidden-character, positional or
  same-as-suggestion dropped, none for a secret field). Inserts at an event position: `hold` / `wait_for` (the next
  action's target — a select or pick by field: `{label: <field>}` —, page idle when it has none — `insert_wait_idle`
  —, or a text) go before the first action whose latest event is after the position, after that action's helpers that
  ended at or before the position (a scroll made before the insert) and before the others (the recorder's wait, made
  with the action) (a wait for the same target replaces the recorder's, its timeout kept: `insert_replaced`), else at
  the end of the scene current at the position; an insert made on a row keeps that row's identity (review B-H1):
  `row: 'wait'` — right after the recorder's wait before the action at `after_seq` —, `after_insert` — right after
  that insert (its `after_seq` / `row` copied, the fallback once it is removed); `caption` / `mark` / `camera {zoom,
  until}` go on that action step — never a helper —, `pending` while the recording goes on, on the last action
  (`insert_moved`) once it ended (`final`: by default a `stop` event), left out with nothing recorded
  (`insert_unplaced`); two of one kind on a step: the later wins (`insert_replaced`). Writes are never attributed to an
  inserted step; issue positions and `firstWrite` count inserted steps. New outputs: `sources` (per step: `seqs`
  [first, last], `role` action / helper / insert, `helper` wait / scroll, `row` — its identity, stable while the draft
  regenerates: `a<first seq>`, `w<seq>`, `s<first seq>`, `i:<id>` —, `target_seqs`, `target_seq` — where its
  alternatives are picked —, `chosen`, `insert`, `modifiers`), `pending`, `placeholders` ({name, kind, project_var,
  scene, step}). With annotations the header comment says the draft was arranged in the Studio. `{aliases: false}`
  (every Studio recording's draft, review B-M2): no YAML anchor / alias — a target shared by a helper and its action is
  written each time (CLI / MCP drafts keep L3.4's aliases, byte for byte: BL-119). `shownStep(bare, shown, at)` maps a
  step of the recorder's own draft to its row in the arranged one (by `row`; null when gone). `applyRecordChange(
  annotations, change, events)` applies one `choose {seq, index}` (an offered alternative only) / `insert {at: 'end' |
  {after_step_seq, row?: 'wait'} | {after_insert}, insert}` (the end = the newest event, resolved by the caller under
  its lock) / `remove {id}`; ids `i<rev>`, marks `m1`, `m2`… by default, unique; a camera's zoom a factor with two
  decimals in (1, 3] (`recordZoomOptions(max_zoom)`: 1.25 / 1.5 / 2 each capped at the theme's max_zoom, default
  min(1.5, max_zoom)); studio.json's `saved` a slug and its own `scenarios/<name>.yaml`; errors are fixed messages.
- **engine** `recordScenario(ws, project, {env?, persona?, page?, path?, url?, name?, allowWrites?, check?, agent?,
  submittedBy?}, ports)` → `RecordOutcome {rec_id, dir, draft, name, saved, not_saved?, env, persona, access, stop, ms,
  window, capture, counts, stats, scenes [{id, steps, opens}], issues, warnings, writes {total, by_steps, ambient,
  first}, check}`. `recordStart`: the page (default the persona's first page, else the environment's first), `path`
  (`inspectPathProblem`), or a `url` on an environment origin (`pageOfUrl`); the persona (`none`, a name, else the page's
  default). Linux without a display (and no test `drive`) → `unavailable`. Preflight: `checkSavedSession`; not valid →
  the persona's `login:` steps (`signIn` auto, headless), else `refused` with the `retake login` command as `fix`.
  `RETAKE_RECORD_MAX_MIN` (minutes, (0, 1440]) → `maxMs`. The draft is validated with the project
  (`parseScenario` with its vars, pages and personas) before it is saved or checked: an error is an `invalid` issue; a
  save that fails is a `not_saved` error issue with a fixed message (the log line too: never the error's text). Folder `<project>/.retake/records/<rec_id>/` (0700,
  newest `RECORD_KEEP` 20): `events.jsonl` (the runner's stream), `draft.yaml`, `record.json` (0600: the outcome, write
  labels, first write, saved / check). `ports.stop` = stop and keep; `ports.signal` while recording = cancel (folder
  removed, `cancelled`), after it = the check stops. No action → folder removed, `not_saved: nothing_recorded`. Saved
  with `saveScenarioText(…, {ifMatch: null, agent})` only when the name is free (default `recorded-YYYYMMDD-HHMM`, `-2`…;
  a taken name is warned before the window opens, the draft kept). Check replay: `runScenario` dry, the draft + the
  inspection pacing, at the capture viewport, run folder `<rec>/check/` (its screenshots removed); scope `until_write`
  up to the step before `firstWrite` (`skipped: first_step_writes` when that is the first step) on any environment,
  else `all` (a read-only environment's stopped / mocked writes are stopped again by the replay's guard) → `{status: passed | failed | skipped | cancelled,
  steps_passed, steps_total, failed_at?, untrusted.error?}`. History: `kind: record`, `record {id, steps, saved}`,
  counts nothing.
- **CLI** `retake record <project> [name] [--env] [--persona] [--page] [--path | --url] [--allow-writes] [--no-check]
  [--json]`: in-process (the primary path), a status line counting actions, Ctrl-C = stop and keep (from the check on,
  the run's own handler stops the check), then the summary (actions, scenes, issues as `scene.step: …`, writes with
  reset advice, saved file, check, draft path, the next `run --dry`); `--json` the outcome. Exit 1 when nothing was
  recorded, the draft is invalid or the check failed. `--allow-writes` as `retake run` (usage error on a read-only
  environment).

### 3.13 Recording: job and MCP (L3.4 part 3; core `RecordJobInputSchema`, engine `jobs/record-job.ts`, MCP `scenario_record`)

- **Job input** (`kind: record`): `{project, rec_id (reserved at submit, RECORD_ID_RE), env?, source: {page, path},
  persona?, scenario?, check: boolean, submitted_by}` — strict: no step, URL, typed text or write flag exists in it, so
  nothing in a job can drive the window. `submitRecordJob`: slugs, no `{{…}}` in page / path / url / persona,
  `recordStart` (page key, path, a URL on an environment origin → page + path, persona), the workspace's protected
  hosts (`checkWorkspaceProtection`), Linux without a display → `unavailable` with the `retake record` command as `fix`;
  warnings (a taken name: the draft is kept only; a read-only environment: writes stopped or mocked).
- **Execution** (`executeRecordJob`): the checks again, `checkSandboxEnv`, then `recordScenario(…, {id: rec_id, agent:
  true, submittedBy}, {hookTrust: 'mcp', stop, skipCheck: () => stop.aborted, signal, history: false})`. Two signals:
  the worker's SIGINT / SIGTERM aborts the job's `stop` controller (not its cancel controller) — the window closes, the
  draft is made and saved, the check replay is skipped (`reason: stopped`), the job succeeds and the worker exits;
  `job_cancel` (the cancel marker) aborts `signal` — while the window is open the recording is discarded (folder
  removed, job `cancelled`), after it only the check replay stops. Progress: `phase` = preflight / `recording · N
  actions` / draft / check with steps; events carry counts and fixed messages only (a log line when the window opens).
  The worker's history line (`record {id, steps, saved}`, counts nothing) replaces recordScenario's own. A `record` job
  holds the worker's capture slot while its window is open (as a headed `auth_login`; renders go on beside it since
  L5.14: it films nothing). Interrupted: by its last
  progress phase — `check`: the draft was made (`.retake/records/<rec_id>/draft.yaml`, saved under scenarios/ when
  its name was free), only the check was cut; `draft`: the draft was being made (that file if it was written);
  otherwise "no draft was made" — `fix` = `retake record …`. `pruneRecords(project, keep, except, root)` never removes the folder of a queued or
  running record job (`activeRecords`).
- **Result** (`RecordJobResult`): `rec_id, dir, draft (path), name, saved {file, path, hash} | null, not_saved?, env,
  persona, access, stop, ms, window, capture, counts, stats, issues {error, warning, info, codes}, warnings, writes
  {total, by_steps, ambient}, check {status, scope, reason?, steps_passed, steps_total, dir?}`, and under `untrusted`:
  `scenes` (ids made from page paths), `issues` (with scene / step), `first_write`, `check {until?, failed_at?,
  error?}`. Never the draft's text: `engine.record.get` reads draft.yaml from the folder (≤ 200 kB).
- **Test hook**: `runWorker({recordTest: {drive, headless, windowSize}})` — in-process only (worker-main never sets it;
  a worker process has no way to receive a driver), not gated on `submitted_by`, so a stdio test can submit through
  MCP while this process's worker holds the lock and plays the person.
- **MCP** `scenario_record({project, env?, page?, path?, url?, persona?, scenario?, check = true})` (RUN_JOB
  annotations; 39 tools): submits and returns at once — the summary tells Claude to ask the user to perform the flow
  and close the window, that it does not drive it, to follow with `job_status {wait_s: 25}` and to submit no other job
  meanwhile. `recordOutput` (also `job_status` for a record job): running → what the user does; finished → actions,
  scenes, steps, placeholders, saved file + hash (`if_match`), the check, issue counts and codes, writes, warnings, the
  next steps; data = the trusted result + `files {draft, dir}` + `untrusted {scenes, issues, first_write?, check?,
  draft_lines}` (the YAML as lines: each string under `untrusted` is capped at 2000 characters); a refusal naming a
  persona that must sign in points at `auth_login`. `record` is a product-text kind: a failed job's message is only
  under `untrusted.error`. INSTRUCTIONS: one line on when to record and how to follow it.
- **The Studio's side (L4.8 part 3; engine `record-files.ts`, `record-studio.ts`)**. The folder's creator
  (`recordScenario`: the CLI and the worker alike) writes `meta.json` once (0600, `wx`) right after making the folder:
  `{v: 1, rec_id, job_id | null, submitted_by, name, env, persona, access, page, path, started_at, max_ms, owner {pid,
  started_at}}` — the draft's context (with the current project.yaml's pages, default personas and vars, the view and
  Save rebuild the worker's draft byte for byte) and who may change it. `record.json` gains `events_sha256` (the events
  file after the stream ended). A job with `submitted_by: 'ui'` is never saved by the job (`not_saved: 'studio'`; no new
  input field, MCP and CLI unchanged on the wire). The job's `stop` marker (`queue.requestStop` / `stopRequested`,
  reserved like `pause`) is polled with the cancel marker for running `record` jobs and aborts the job's `finish`
  signal: the window closes as if closed (`stop: 'stopped'`) and the check replay runs (a worker signal still skips it).
  Ops (`engine.record.{view, annotate, save, discard, stop}`, clients `ui` / `test` only; every answer path-free, page
  and typed text under `untrusted`):
  `view(project, rec_id, {job?, since?})` — the job from `meta.job_id` (or the `job` hint before the folder exists, or
  after a discard removed it; checked to be that recording's job), state `queued | preflight | recording | draft |
  check | done | interrupted | tampered | nothing_recorded | failed | cancelled | discarded | missing` (`interrupted`: a
  dead worker, or a CLI recording whose owner process is gone, with no record.json: Save and Discard allowed,
  unchecked; `tampered`, fail closed (review A-M2): a Studio recording whose record.json holds no valid
  `events_sha256`, or whose job succeeded without a record.json — read-only, Discard only; `discarded` also for an open
  window the Studio discarded — its cancel marker says `reason: 'discard'`), `can {annotate, save, discard, stop}`,
  counts, stats, issue counts, check (+ `events_changed`, true when record.json's checksum is not the events'),
  saved, `rev`, `draft_sha256` (the hash of the draft shown), `zoom {max, options, default}` (the project theme's
  max_zoom), `version` (an equal `since` answers `unchanged: true`, nothing read), `untrusted {yaml, blocks, sources,
  issues, pending, placeholders, alternatives [{scene, step, seq, chosen, options [{index, target, words, fragile}]}],
  inserts, writes, check? (+ `failed_row`: the check's failing step of the recorded draft on screen, through
  `shownStep`; null when gone)}`; nothing is read when the records folder or the recording's folder is a link or leads
  out of the project (realpath compared, as for writes: the view says why, the list skips it); events.jsonl is read
  without following a link, each complete line re-validated (a refused line dropped and counted, a last line without
  its newline left for the next read). `annotate(project, rec_id, {rev, change})` — under the lock
  `.retake/locks/record-<id>.lock`, the revision checked, the events read then (an insert `at: 'end'` lands after
  the newest event in the file at that moment: a visit to the Studio commits the typing in progress after the screen's
  last poll), studio.json read with O_NOFOLLOW (a link refused) and replaced by an exclusive temp file and a rename.
  `save(project, rec_id, {name, rev, draft})` — a finished (done / interrupted) Studio recording: the events file must
  hash to record.json's `events_sha256` (fail closed), the draft made again with the annotations (`final`), and it must
  be byte for byte the draft the person saw (`draft` = the view's `draft_sha256`: an events line, a project.yaml var or
  page, or an annotation changed since is a `conflict`, no file — review A-M1); its errors refuse, then
  `saveRecordedDraft`: a hidden character anywhere refused (located by scene and step), agent trust (`via: 'studio'`),
  a NEW `scenarios/<name>.yaml` only (a taken name: `conflict`, "choose another name"), the validator's text never in
  the message (issues located by scene and step, text under `details.untrusted`, paths removed); then `saved` in
  studio.json (read-only after). `discard(project, rec_id, {job?})` — the window open (or not yet): job cancel with
  `reason: 'discard'` (L3.4 removes the folder; the view says discarded); during the draft or the check: `discard`
  written into studio.json and the job cancelled, the folder removed by the job itself when it ends (B-L2), else by
  the next view or recent list; afterwards removed at once — only a real folder directly under the project's real
  `.retake/records` (realpath compared, no link on the way). `stop(project, rec_id, {job?})` — queued: cancel
  (unless the worker took it meanwhile); preflight and recording: the stop marker — before the window opens the job
  turns it into a clean cancel (nothing opens, no folder kept; a worker taking a job whose stop was asked sees it at
  once), never a cancel racing the window into a discard (B-L8); any recording with a job, whoever started it.
  Annotate, save and discard need a Studio recording (review A-L1): its job exists with `submitted_by: 'ui'` and is the
  job meta.json names with `submitted_by: 'ui'` (meta.json alone proves nothing — `.retake/` is agent-writable;
  before the folder exists, the job alone); MCP and CLI recordings, and one whose origin cannot be verified (its job
  gone or another), are read-only from the Studio. A camera insert above the project theme's max_zoom is refused
  (`invalid`). The Studio's `record.submit` refuses a second recording while one is queued
  or running in the workspace (`conflict` naming it; checked and queued in one in-process chain). `jobs.cancel` from
  the MCP client refuses an unfinished `record` job the Studio submitted (it would discard the person's recording).
  Prune keeps, beyond the newest 20, a folder whose lock is held and an unsaved, undiscarded Studio recording younger
  than 7 days (`RECORD_UNSAVED_KEEP_MS`).
  `list(project, {limit?})` (part 4) — the recent list: recordings whose job is queued or running before their folder
  exists, then the real folders of `.retake/records/`, newest first (≤ 50), each `{rec_id, state, job, started_by,
  started_at, name, env, persona, page, path, steps, actions, saved, studio}` without reading its events.
- **The Studio server's Record ops (L4.8 part 4; ui `server/record-ops.ts`, `server/record-watch.ts`)**: seven own ops
  in `UI_OPS` (not MCP tools; `scenario_record` and `job_cancel` stay out). `record_options {project}` — environments
  (the access a Studio recording gets: never `--allow-writes`), page keys, personas with their stored session state
  (auth.status, no browser), `login_steps`, the path-free sign-in command, defaults per environment, warnings and notes
  in words, the recording open in the workspace, and `recent` (engine `record.list`). `record_start {project, env?,
  page?, path?, persona?, name?}` — strict: no `url`, `allow_writes`, `check` or `submitted_by` from a page (400,
  nothing queued); submitted with `check: true`, a page and a path; the job's `submitted_by` is the engine's client.
  `record_view {project, rec_id, job?, since?}` (the draft's YAML as `untrusted.yaml_lines`: the untrusted cap is per
  string), `record_annotate {project, rec_id, rev, change}` (core `RecordAnnotationChangeSchema`, strict),
  `record_stop` / `record_discard {project, rec_id, job?}`, `record_save {project, rec_id, name, rev}` (in the
  server's scenario chain). Every answer goes through `recordPathFree`: pathFree on every trusted string (a failed
  job's `error.message` / `error.fix` included: `retake -C .` for the workspace) and on the check replay's failure text;
  the draft and URL `path` fields keep their text with only the workspace's own path cut (withoutPathsDeep would
  shorten a page path such as `/orders/new` and drop blocks below 8 levels). Errors keep the HTTP layer's rule (message
  and details path-free, `fix` as typed). Live re-reads: a stat poll of each recording folder's own files (events.jsonl,
  studio.json, record.json, meta.json; never through a link, ≤ 40 folders a project) while an event stream is open;
  `workspace {records: ['<project>/<rec_id>']}` names those that changed. The screen on top of them: §4h.

### 3.14 Themes from brand files (L3.5 part 1; core `brand.ts`, components `brand/`, engine `brand/`, MCP `template_create_from_brand`, `retake theme create`)
The contract (input schema, palette formulas and thresholds, template.yaml generation, file checks, naming, replace
and provenance) is DESIGN-phase2.md §1.10. Surfaces: `engine.templates.create(input)` (trust `mcp`, feature
`templates.create`); MCP `template_create_from_brand` (WRITE_FILES annotations; 40 tools, 41 with `template_from_site` — DESIGN-phase2 §1.11) — input = `BrandInputSchema`,
summary: folder, colours, every contrast ratio and change, the suggested accent, fonts, warnings and the next step
(`template_preview {project, template}`), data = `ThemeCreated` with the font files' name strings under
`untrusted.fonts`; `retake theme create <name> --accent --logo …` calls `createThemeFromBrand` with trust `author`
(any local file, relative to the cwd). Synchronous: no browser, no job (file reads ≤ 25 MB).

## 4. CLI (`retake`)

```
retake new <slug> [--name N] [--template T] [--env name=key:url,...]   # on a terminal without --env: asks (personas too)
retake list                                   # projects
retake validate <project> <scenario|file>     # exit 1 on errors; prints file:line:col messages
retake run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--allow-writes] [--json] [--sandbox]
retake hooks run <project> <file.yaml|scenario:setup|scenario:teardown|reset> [--yes] [--allow-writes]
retake hooks rollback <project> [id] [--allow-writes] [--replay-unsigned] [--dry]   # replay pending rollback journals (run id or journal id); lists them first (unsigned ones in full)
retake env reset <project> [--allow-writes] [--replay-unsigned] [--dry]   # project.reset hooks + pending journals (listed first); --replay-unsigned: a terminal only, y/N per entry
retake sandbox init <project> [--env E] [--force] [--json]                                  # §3.8b scaffold
retake sandbox up|down|reset|status|logs <project> [--env E] [--no-seed] [--build] [--volumes] [--reseed] [--json] [service] [--lines N] [--follow]   # §3.8b
retake schema [scenario|project|template|timeline|sandbox]  # print JSON Schema
retake login <project> [--env E] [--persona P] [--auto] [--page KEY] [--url URL]   # sign a persona in (§3.6)
retake auth status [--project P [--env E]] [--check] [--json]   # personas: valid / expired / never / unchecked / error
                                                                # (a sandbox account never signed in: auto)
retake doctor [--project P] [--json]          # OK/WARN/FAIL per check (Node, Chromium launch, ffmpeg/ffprobe, display,
                                              # keychain, notifications, workspace, template fonts; project personas
                                              # (never / expired / in use / in a git work tree), session home + hosts;
                                              # MCP: registered Node path, PATH finds ffmpeg, worker, .retake/ ignored)
retake render / review / export               # phase 2
retake mcp [--print-config]                   # §4b: MCP server over stdio (or its registration for Claude Code / desktop)
retake mcp --http [--port N] [--rotate-token] [--json]   # §4c: the same server over HTTP on 127.0.0.1 (--print-config --http)
retake ui [--port N] [--no-open] [--json]     # §4c: the Studio web app on 127.0.0.1 until Ctrl-C; one server per workspace
retake jobs [list] [--project P] [--state S]… [--limit N] [--json] | status <id> [--json] | cancel <id>   # §4b jobs
```
`--json` prints RunProgress events as JSON lines (machine-readable; used by the MCP job runner).
`--allow-writes` (L1.7) confirms writes on a production environment whose project.yaml sets `access: read-write`; on a
read-only environment it is a usage error (exit 2). The run header and the hooks commands' header say `production`,
`read-only` / `writes allowed` and the clock (`clock 2026-11-02T10:24:00 Europe/Paris (frozen)`); the notice / warning
of core `RunAccess` is printed once. The run summary
of a read-only run counts its writes (`writes  1 mocked, 0 stopped (read-only)`, + allowed / to unguarded hosts;
`writesSummary`; a read-write run's writes stopped on another environment's hosts: `1 stopped (hosts of read-only
environments)`), and `retake review` / `render --review` print the review's environment line.

## 4b. Engine API and MCP server (L3.1)

**`@retake/engine`** (deps: components, core, editor, hooks, review, runner-web, sandbox, zod). One typed, in-process API over a workspace. The CLI calls
the moved functions directly with its native options, errors and exit codes; `EngineError` exists only at the
boundary of clients outside the CLI (the MCP server; the jobs worker and the HTTP API later).

```ts
openWorkspace({root?}) / openProject(ws, slugOrDir)   // moved from cli/src/workspace.ts (the CLI re-exports them)
personaState / projectPersonaStates / tildePath       // moved from cli commands/auth.ts (`--check` stays in the CLI: Chromium)
createEngine({root?, client: 'cli'|'mcp'|'test'|'ui'}): Promise<Engine>   // agentTrust(client): every client but cli / test (§4c)
Engine {
  root, workspace, cli /* `retake -C <root>`: commands a human is asked to run */, info(): EngineInfo
  projects: list() → ProjectSummary[]; get(slug) → ProjectView; create({name, slug?, readme?, environments?, template?});
            updateReadme(slug, markdown, ifMatch?)
  scenarios: get(slug, name) → {name, file (ref), path, yaml, hash}; validate(slug, yaml, {env?, until?, name?}) →
             {ok, issues (line/col)}; save(slug, name, yaml, {ifMatch?}) → {file, path, hash (of the bytes written), created, warnings}
  runs: list(slug, {scenario?, mode?, limit = 20}) → RunSummary[] (newest first);
        status(slug, runId) → RunStatusWithJob (run.json + the state of its job overlaid; `list` overlays it too:
        a queued run whose job was cancelled before any worker took it is `cancelled`, one whose worker died `interrupted`);
        submit({project, scenario, mode: 'dry'|'capture', env?, until?, hooks?, sandbox?}, {approver?}) → {job, run_id, warnings, worker?};
        cancel(slug, runId) → JobRecord (refused for a run without a job: a `retake run` in a terminal)
  jobs: get(id) / list({project?, states?, kinds?, runId?, limit = 50}) / events(id, {after?}) / cancel(id) /
        wait(id, {timeoutMs, signal?, onChange?}) / position(id) / worker() → the live worker lock or null
  hooks: submit({project, source, env?, dry = true}, {approver?}) → {job, journal_id, worker?}
  env:   reset({project, env?, dry = true}, {approver?}) → {job, journal_id, worker?}
  auth: status({project?, env?}) → {personas (no profile / snapshot paths), errors};
        login({project, env?, persona?, mode = 'headed'}) → {job, persona, env, worker?}
  sandbox: status(slug, env?) → SandboxStatusView; up({project, env?}, {approver?}) / reset({project, env?, reseed?},
           {approver?}) → {job, env, worker?}
  record: submit({project, env?, persona?, page?, path? | url?, scenario?, check = true}) → {job, rec_id, env, page,
          path, persona, warnings, worker?}; get(slug, recId) → {dir, draft (draft.yaml text) | null, truncated}   // L3.4
  usage() → {captures, dry_runs, renders, entries, since?}   // from history.jsonl
}
loginTarget(project, {env?, persona?, auto?}) → {env, persona} / signInPersona(project, env, persona, {mode, page?, url?},
  {interrupts, log, onOpen?}) → {interrupted} | {result}   // moved from cli commands/auth.ts (LoginOptionError {usage})
appendHistory(root, entry) / usageCounts(root) / entitlements() → {tier: 'internal', features: 'all', limits: null}
selectHooks(project, spec, env?, {projectFilesOnly?}) / createHookContext(project, {env?, allowWrites?, dry?, vars?,
  runId?, scenario?, trust?, log, confirm?, loginCommand, signal?}) → {ctx, access, closeSessions} / hooksAccess
                                                       // moved from cli commands/hooks.ts (the CLI keeps printing and Ctrl-C)
preflightHooks(project, [{phase, hooks}], {env?, vars?, scenario?, journalFile}) → {env, items, refused}
takeApprovals(ApprovalRequest, approver?) → JobApproval[]   approvalChecker(approvals) → confirmDestructive
pruneApprovalRequest(listed, fix) → PruneApprovalRequest   takePruneApproval(PruneApprovalRequest, approver?, client?)
```

- **Names, never paths.** Every input is a slug or an id (`checkProjectSlug` = core `PROJECT_SLUG_RE`,
  `checkScenarioName` = `SLUG_RE`, `checkRunId` = `RUN_ID_RE`), checked before core sees it (core's loaders also take
  absolute and cwd-relative paths, which only the CLI may use).
- **`if_match`** (sha256 hex of the file's bytes): an existing file needs the hash its read returned — a mismatch, or
  none, is `conflict` with `details.current`; `null` (or none) creates a file that must not exist, by `link()` (atomic
  EEXIST, never an exists-then-rename window); the hash is checked again just before the rename. `scenario_save x`
  is refused while `scenarios/x.yml` exists (a new `.yaml` would shadow it). The returned hash is of the bytes written
  (a final newline is added).
- **Storage** (R-ARC-03, local only): `LocalStorage(projectDir)` — `resolve(ref)` (refs are project-relative POSIX
  paths: no absolute path, `..`, `.`, empty segment or backslash), `refOf(path)`, `describe(ref, kind, {hash})`
  (stat + streamed sha256), `readText(ref)` → `{text, sha256}`, `writeText(ref, text, {ifMatch})` (atomic; a folder
  that is a symbolic link out of the project is refused, real paths compared). Producers (runner, editor, review)
  keep writing absolute paths into their records: refs inside run.json / render.json are a format change (L3.6 /
  BL-70); the engine converts at its boundary (a run's paths are re-rooted on its current folder).
- **Views.** `ProjectView` leaves out `auth` (persona names, pages and whether they have login steps, per environment)
  and masks a password written in a URL (`maskUrlCredentials`). `RunStatusView` / `SandboxStatusView` /
  `AuthStatusItem` keep text the filmed site or a service controls (step error message, warnings, health
  responses, a check's detail and URL) under `untrusted`.
- **Errors.** `EngineError {code, message, fix?, details?, docs?}`, codes `not_found | invalid | conflict | refused |
  needs_approval | busy | unavailable | cancelled | internal` (core's error kinds, `error-kind.ts`). Every error class
  raised on purpose states its kind (`errorKind`, a getter where it depends on the message or a field) and may name its
  guide page (`errorDocs`, carried as `docs`: its URL on the public repository, core `docsUrl`, which an MCP error's
  data carries); `toEngineError(e)` reads them in one place, an EngineError of another module copy keeping its fix,
  details and docs (ScenarioError / ConfigError →
  not_found or invalid, AccessError / HookSecurityError / WriteRefusedError / HostRefusedError → refused, SandboxError
  busy / down / interrupted → busy / unavailable / cancelled, CancelledError → cancelled; the table:
  `packages/engine/test/error-kinds.test.ts`), anything without a kind → internal. The CLI prints an error with a kind
  as one line, without a stack.

**Runs: one executor** (`execute-run.ts`, moved from `cli/commands/run.ts`). `prepareRun(ws, project, scenario,
{dry, until, hooks, env, headed, sandbox})` (the sandbox pick from the scenario's raw `env:`, the scenario validated
against the environment it runs on, the template; `RunOptionError` = a CLI usage error) and `executeRun(prepared, req,
{runId?, allowWrites?, hideCursor?, signal?, loginCommand?}, ports)` (the scenario's warnings and notes, the sandbox
take or check, `runScenario`) are what `retake run` and the worker both call. `RunPorts {issues, note, sandboxLog,
progress, interrupts}` carry what the CLI prints, in the same order as before; `interrupts: InterruptPort` replaces the
CLI's direct `onInterrupt` for the sandbox take (`open({message, onQuitSync}) → {signal, interrupted, dispose}`; the
CLI's implementation is `onInterrupt`, the worker's the job's AbortSignal plus its signal rule). `checkAllowWrites`
throws `AccessError` (the CLI turns it into its usage error), a failed take `SandboxTakeError` (`interrupted` → exit
130). `retake run`'s output, errors and exit codes are unchanged (a cancelled run still exits 1).

**Jobs** (R-ARC-02; `jobs/`). Input contract in core (`jobs.ts`, `JobInputSchema`, version 1): a `run` job is
`{version, kind: 'run', project (slug), scenario (name), scenario_sha256 (of the file's bytes at submit), mode,
env?, until?, hooks?, sandbox?, run_id (reserved), submitted_by}` — strict (no other key), never a secret, a session or
a path. Files under `<workspace>/.retake/` (git-ignored):

```
jobs/<id>/job.json      the record: written once by the submitter (queued), then only by the worker that claimed it — or,
                        for a heavy job (L5.14), by its job process from `running` on (`worker` = that process,
                        `supervisor` = the worker), the worker writing the end only when the job process died first
jobs/<id>/claim         {pid, started_at, at} — created O_EXCL: the atomic claim
jobs/<id>/cancel        {at, by} — created O_EXCL by a cancel (run_cancel / job_cancel); the worker polls it (250 ms)
jobs/<id>/events.jsonl  appended by the claiming worker: state changes, the runner's (redacted) progress, logs, the result
jobs/<id>/yield.json    {v, state: 'background', since, cause: here|elsewhere} — L5.14: written by the worker while a
                        running heavy job yields to a filming take, removed after (one writer: the worker)
workers/worker.lock     {pid, started_at, host, version, build, since} — one worker per workspace, two slots (L5.14)
workers/worker.log      what workers print (stderr), appended
```

- The queue is a port (L6.3; `jobs/job-queue.ts`), in two views. `JobQueueView` reads and asks: read (with the derived
  states), a submit's own files (`jobFile`: a render's edit snapshot, never a link followed), the markers a client asks
  with (cancel, pause, stop: `cancelOf` / `pauseOf` / `stopOf` say when, and a cancel's reason), who claimed a job, what
  holds heavy work and a heavy job's yield (`takeHold`, `yieldOf`), the events, and `withOwnMemory()` (the same jobs for
  another watcher: its own memory of the jobs seen finished and of the filming markers, and the default `retake` in
  its derived fix texts). `JobQueue` adds the submit (`enqueue`) and the claiming worker's writes (`claim`, `unclaim`,
  `write`, `setYield`, `append`: events get seq + 1, + 2… after the seq the writer passes, one writer at a time).
  `Engine.queue` is a `JobQueueView`: the MCP server and the Studio read it, and the ratchet's `queue-call` rule keeps
  the submit and the worker's writes inside `packages/engine/src`. No path in either. The behaviour is written once
  (`queue-core.ts`) over a job's named entries; the file queue (`queue.ts` `FileJobQueue`, the files above) and an
  in-memory queue (`memory-queue.ts`: tests of the code that is handed a queue) keep them, and one contract suite holds
  both (`packages/engine/test/job-queue-contract.ts`). The paths are the file queue's file part (`JobFiles` — a job's
  folder, job.json, browser.json, live.json, yield.json, events.jsonl), handed apart from the queue to the code that
  reads or writes a job's files itself (the worker: a render's browser; the live channel; the Studio's live run through
  `Engine.jobFiles`; the project board's stat memo). Only the composition roots build the file queue: the engine, the
  worker, the job process and the CLI's `workspaceQueue` (its in-process commands read it so that their pruning spares
  the folders of active jobs), plus the adapter's own `withOwnMemory()`; every other module is handed one (the
  ratchet's `queue` rule). `<workspace>/.retake` and its jobs folder are named by `workspace-state.ts`; what an
  interrupted job says, by `jobs/interrupted.ts`. The worker (`runWorker`) keeps one record of everything it holds,
  read and changed by module functions under four section comments: finish, recovery, claim and run.
- Ids: `j_` + a ULID (sortable). States `queued → running → succeeded | failed | cancelled`, and `interrupted`.
  Readers never write: a `running` job whose worker is gone (pid + `ps` start time, sandbox proc.ts) is derived
  `interrupted` (fix: `retake env reset <project>`); a `queued` job with a cancel marker and no claim is derived
  `cancelled`. The next worker persists those (it holds the lock). run.json is never rewritten for `interrupted`: the
  run status overlays it.
- `succeeded` = ran to the end (the run's own status is `result.status`); `failed` = could not run (EngineError code
  and message: the scenario's bytes changed since submit → `conflict`, a sandbox take failed…). The worker reads a
  pinned scenario once (core `loadScenario` / `readScenarioSource` with `expectSha256`): those bytes are hashed and
  compared before they are parsed (`ScenarioChangedError` → `conflict`, "submit it again"), and the run, the
  inspection or the hooks use them, never a second read of the file.
- Submit (`submitRunJob`): names checked, `prepareRun`, the hooks the run executes checked and approved (below), the
  scenario hashed, `reserveRunId` (core; the runner uses it too) and a `queued` run.json written, the input queued; the
  MCP engine then calls `ensureWorker`. Early exits never leave run.json `queued`: the worker closes a reserved run as
  `cancelled` (cancelled before it started) or `failed` (it could not start).
- `hooks` / `env_reset` jobs (`jobs/hooks-job.ts`): `{version, kind: 'hooks', project, source (core HOOKS_SOURCE_RE:
  reset | <scenario>:setup|teardown | hooks/<name>.yaml — a file's real path must be inside the project),
  scenario_sha256? (for `<scenario>:setup|teardown`: the scenario file's bytes at submit, set before the approvals are
  signed and covered by their signature; the worker refuses such a job without it or with another hash — `conflict`,
  submit again), env?, dry, journal_id (reserved: `<stamp>-hooks-<label>`), submitted_by, approvals?}` and `{…, kind: 'env_reset', env?, dry,
  journal_id (`<stamp>-env-reset`)}`. The executors are `retake hooks run` / `retake env reset` on the engine's
  `createHookContext` with trust `mcp` and the job's approvals; results (`HooksJobResult`, `EnvResetJobResult`) list
  each hook with its trusted fields (index, name, kind, status, the hook as declared, the approval reason) and keep
  its templated description, message and error under `untrusted`. A cancel stops the hooks (a setup's completed ones
  are rolled back): the job ends `cancelled`.
- **Approvals** (R-MCP-35, `approvals.ts`). Every queued job runs its hooks with **trust `mcp`** (core `HookTrust`;
  hooks `HookContext.trust`, runner `RunOptions.hookTrust`): `confirm: true` is ignored; destructive hooks and every
  shell hook need an approval; a shell hook always counts as writing (`SHELL_ALWAYS_WRITES`: refused on a read-only
  run, by the runner's static check too). At submit, `preflightHooks` dry-runs the hooks the job will execute (a run:
  setup + teardown; hooks: the source; env_reset: the project's reset hooks — never the journal rollbacks) with trust
  `mcp`: nothing executes, secrets are `***`, no browser opens; a refusal fails the submit (`refused`, fix = the
  `retake` command); the hooks that need a human (from the dry run, else from the file alone) go to the client's
  `Approver` once (`ApprovalRequest {what, project, env {name, production, access}, items [{fingerprint, phase, index,
  name, kind, description (templated), reason, lines}], fix}`). `lines`: the hook in full, one line per field, then
  its rollback's prefixed `rollback ` (hooks `shown.ts`: `actionLines` of `PreparedHook.shown` /
  `PreparedHook.rollback.shown`, carried as `HookResult.shown` under trust `mcp`, redacted; `declaredHookLines` of the
  raw hook when the dry run could not template it, and for a sandbox's seed steps) — every character visible (core
  `showHiddenChars`: controls, bidirectional, invisible and look-alike characters — spaces other than U+0020, joiners,
  fillers, variation selectors), a further line of a value after `  | `, a field name (an `env` or header key) on its
  line (`showHiddenCharsLine`: a line break as `\u{a}`); the form's text is engine `approvalFormText` (mcp
  `approvalMessage` is it): a numbered heading per hook (`approvalItemTitle`: phase, position, name once — on its line —,
  kind) with its reason, then these lines indented. `takeApprovals` refuses (`refused`, `details.too_long`, the fix)
  before asking anyone, approver or not, a hook whose text in the form exceeds `APPROVAL_HOOK_MAX_CHARS` (4,000) or a
  form (`approvalFormText`, whole) over `APPROVAL_FORM_MAX_CHARS` (16,000); the Studio's run blockers name it
  `too_long` ("hooks too long to approve here", the terminal command). Core validation refuses a control character in a
  hook's `name` and in a shell hook's `env` names. *Agent-written hooks*: `RunHooksOptions.agentWritten` marks the
  hooks the agent wrote — a scenario's setup, teardown and own named hooks (runner `run.ts`, engine `preflightHooks`
  lists, `executeHooksJob` for `<scenario>:setup|teardown`); `HookContext.agentVars` (the scenario's own `vars`, set
  by engine `createHookContext` and the runner with trust `mcp`) makes a hook whose templates use one of them count as
  agent-written wherever it is declared. Under trust `mcp` an agent-written shell hook goes through hooks
  `kinds/shell.ts` `checkAgentShell` before anything of it is rendered (in the preflight and in the worker; a refusal is
  `HookSecurityError` `mcp`, ending with the grammar and "have a person put it in hooks/<name>.yaml … or run it in a
  terminal"): its `env` names (core `agentShellEnvProblems`: `ENV_NAME_PLAIN`, no loader variable — core
  `LOADER_ENV_NAMES`, the start files and programs other tools read included: `LESSOPEN`, `MANPAGER`, `SSH_ASKPASS`,
  `RUSTC_WRAPPER`, `MAVEN_OPTS`, `FPATH`, `PIP_*`, `UV_*`…); no `{{hooks.…}}` / `{{response.…}}` token and no secret
  token (`{{env:…}}`, `{{keychain:…}}`, `{{secret:…}}`) in `run` / `rollback` / `cwd` (`agentShellTokenProblems`; root
  as core's lookup reads it — as an agent's scenario never names a secret, a secret's value is never what the checks
  read); then `agentShellView` — the text rendered with vars, pages and `run` (`{{run.dir}}` defaulting to `runs/<id>`
  in a preflight) — is read by core agent-policy
  `agentShellCwdProblems` (one plain word, not agent-writable) and `agentShellProblems`: length first
  (`AGENT_SHELL_MAX_CHARS`, 4,000), then one pass over the characters (`plainCommands`: plain words of
  `[A-Za-z0-9./:=@%+,_-]`, single spaces, `&&` as a word between two commands — `AGENT_SHELL_GRAMMAR`), then per
  command: `REFUSED_BUILTINS` by the last path part, as the program or after a `WRAPPERS` program (the wrappers, and
  the shells' prefix words bash `coproc`, zsh `noglob` / `nocorrect` / `-`); loader variables set
  (leading assignments, `env` arguments, `VARIABLE_SETTERS` names, `printf -v`); `INTERPRETERS` code options, `awk`
  without `-f`, `xargs` / `parallel` / `find -exec` / `env -S`; `PACKAGE_RUNNERS` (a runner, or its subcommand anywhere
  after it), `deno npm:` / `jsr:`; `git -c`; paths (`pathCandidates`: the word, after `=`, `-X`, `@`, each `,` and
  `:` part) — through an agent-writable folder (`agentWritablePath`, for a word with a `/`, any word of an interpreter's
  command, the value of a `PATH_OPTIONS` option), to an agent-writable file (README.md: any word, bare or not, whatever
  program reads it), to project.yaml (any word), into `hooks/` unless it is the script the command runs (`runsFileAt`:
  the program, an interpreter's first non-option word, a `-f` / `--file` / `-m` value). A rollback of such a hook is
  recorded with `agent: true` (under the entry's signature) and `rollbackShell` holds it
  to the same rules again on the text it replays (env names, tokens, then the rendered `cwd` and command), whoever
  replays it; a refusal is `HookSecurityError` `mcp` (status `refused`).
  `hookFiles({agentWritten})` still binds the existing files such a hook names but leaves judging them to these rules.
  A person's hook keeps the shell's full syntax and is only shown in full. No approver → `needs_approval`; declined / cancelled /
  timeout / error → `refused`; accepted → `input.approvals = [{fingerprint, by: 'human-elicitation', at}]`, written once
  with the job. `fingerprint` = hooks `hookFingerprint(hook, {phase, index, env})`: sha256 of canonical JSON (sorted
  keys) of the **raw** hook as its file declares it, its phase, position and environment — templates unresolved, so
  `{{run.id}}` and saved responses do not differ between preflight and run. The worker's `confirmDestructive` is
  `approvalChecker(input.approvals)`: a hook that needs a human runs only when its fingerprint is listed (a changed or
  moved hook is refused). What the raw hook is rendered with comes from the same bytes: a run job, and a hooks job of
  `<scenario>:setup|teardown`, carry the sha256 of the scenario bytes the preflight read, and the worker runs no other
  (the scenario's `vars` included). With trust `mcp` a dry run never calls the approver: its results carry `approval {reason,
  fingerprint}`. The CLI (trust `author`) is unchanged: `confirm: true`, `--yes` / the prompt, `writes: false`.
  *Rollbacks* (L3.1 review): a setup hook whose rollback is destructive (HTTP DELETE, destructive SQL inline or in its
  file) or is a shell command or JavaScript needs the approval too (its rollback runs later — a failure, a cancel, an
  environment reset — without asking again); the item's `description` ends with `; rollback: <templated rollback>`
  (also `rollback`), its `lines` end with the rollback's fields, and its reason with `its rollback: …` (core `rollbackApprovalReason`, hooks `PreparedHook.rollback`).
  *Files*: the fingerprint also folds `files` — ref → sha256 of each project file the hook references (hooks
  `hookFiles`: its sql / js file and its rollback's, and every relative word of its shell command that names an
  existing file under its working directory: `./seed.sh`, `node scripts/x.mjs`, `psql -f reset.sql`): a script changed
  after the approval is refused. *Signed* (`jobs/signing.ts`): `FileJobQueue.enqueue` signs each approval —
  `sig` = HMAC-SHA256 over its workspace (the real path of the queue's root), the job's id, the canonical job input
  (without its approvals) and the approval (payload `v: 3` since L5.14), with the Retake home's key
  `<RETAKE_HOME>/approvals.key` (core `home-key.ts`: 32 random bytes in hex, 0600, created whole on first use — written
  to a temporary file and hard-linked into place, so a reader never sees a partial key and of two processes making it
  at once the second reads the first's — its folder made 0700, an existing one open to others closed to 0700 then,
  never the account's home folder); the worker keeps only approvals whose signature verifies for that
  job (`verifiedApprovals`; the others are dropped with a `warn` event, their hooks refused), so a job.json written by
  anything but a submit carries no approval. *Bound to their job* (L5.14): approvals are signed for their job's id in
  its workspace (a job.json copied under another id, or into another workspace sharing the home, verifies none — a
  moved workspace's queued jobs too: submit them again), and the worker consumes them when it claims the job
  (`consumeApprovals`: `<RETAKE_HOME>/approvals-used/<job id>` created once with the claimed record's digest; given back
  only when the worker returns the job to the queue unrun; kept a year): a job folder made again under the id of a job
  that was already claimed ends `failed` ("refused without running") at its claim; a record that cannot be written
  ends the job `failed` with that reason ("the record of the approvals workers took … cannot be written"), never as
  approvals taken before. A heavy job's process gets the
  digest of the record its worker claimed (`--digest`: sha256 of the id and input) and refuses any other record
  (exit 4). Whoever can read the Retake home can sign: it guards against a forged job file, not against a process
  running as the user with access to `~/.retake` (which holds the sessions too).
- **Rollback journals are signed** (L5.14, hooks `journal.ts`): every entry Retake writes — a capture's, `retake hooks
  run`'s, an environment reset's, by the worker or the CLI — carries `sig` = HMAC-SHA256 with the Retake home's key over
  where its journal stands and the whole entry (its `seq` included), signed again on every save (its status,
  attempts…). Where it stands (`JournalPlace`): the real path of its project's folder (which names the workspace), that
  folder's own name, the location (`run`: `runs/<id>/hooks-journal.json`; `journals`: `.retake/journals/<id>.json`;
  `file`: any other journal, by its folder) and the journal's path there. An entry is trusted only with a valid
  signature, a `seq` no other entry of its journal repeats, and a `started_at` less than a year old; each trusted
  entry's rollback is replayed once — `<RETAKE_HOME>/rollbacks-done/<sha256 of its identity>` (where its journal stands,
  its seq, its start, its rollback: the same through its attempts) is created (exclusively) before it runs, removed when
  the rollback fails (it may be tried again), pruned after a year by a worker's start — so a copy of the entry in any
  earlier state is refused once it succeeded ("Retake replayed this rollback before"). An untrusted entry
  (a journal placed or edited by something else; copied into another project or workspace, moved between `runs/` and
  `.retake/journals/`, duplicated; a journal of an older Retake or another home; a workspace moved since) is never
  signed by a later save and is not replayed with trust `mcp` — an environment reset job, a capture's teardown: the
  result says `refused`, "not signed by this Retake home for this journal … a person can review it and replay it from a
  terminal" (no flag is handed to the agent; no approval prompt is offered for it: the simpler safe choice). In a
  terminal `retake hooks rollback` and `retake env reset` list every pending rollback before replaying, with its journal
  file; an untrusted entry is shown in full (`rollbackActionLines`: every field of its action as it would run, its
  templates filled from the data it carries, never a secret resolved, every control, bidirectional or invisible
  character written out — its description is the writer's words and is not shown for it), and is not replayed (exit 1;
  `--dry` lists it and exits 0). `--replay-unsigned` works only in an interactive terminal (a usage error otherwise)
  and asks about each untrusted entry, shown in full again, y/N (no by default): the entry asked about is the one that
  runs (the journal is read once). Never replayed, whoever asks: an untrusted `sql` rollback (it would connect with the
  environment's database URL), `js` (the environment's signed-in page), one that references a secret (`{{env:…}}`,
  `{{keychain:…}}`), a `shell` one on a sandbox environment (its variables); a `shell` one said yes to runs with a bare
  environment (PATH, HOME, the user, shell, temp folder and locale, Retake's own variables), not the rest of the
  terminal's. A capture never replays an untrusted entry (a journal found in its run folder at its start was not its
  own).
- **What work submitted through MCP may reference** (core `agent-trust.ts`; the agent writes scenarios, README.md and
  new projects, and reads what runs return). Checked at `scenario_validate` / `scenario_save` (as errors), at submit
  (`checkAgentTrust`: `refused` with the `retake` command) and again where it runs (the runner with `hookTrust: 'mcp'`
  before anything opens; the hooks executor; the step and the hook that read a file):
  - *Secrets*: no `{{env:…}}` / `{{keychain:…}}` anywhere in the scenario (steps, hooks, vars) nor in a code file it
    runs (eval.file, a hook's sql / js file). Only project.yaml (personas' login steps, databases, mailbox, reset hooks)
    and the project's `hooks/` files — what a human wrote — resolve them. Masking catches a value as is, not a
    transformed one (base64): the reference itself is refused.
  - *Files*: drop_file.path, eval.file, a hook's sql / js file (and its rollback's) and the files its shell command
    names are relative, inside the project folder once symbolic links are followed (`projectFileProblem`: no absolute
    path, `~`, `..` out of it); a templated path is checked again when the step runs (runner `Runtime.agentTrust`).
  - *Code from agent-writable files*: eval.file, a hook's sql / js file and a script its shell command names are never
    README.md, `scenarios/`, `runs/`, `renders/`, `review/`, `exports/` or `.retake/` (`AGENT_WRITABLE_PATHS`).
  - *Production across projects* (`protected-hosts.ts`): the protected hosts are the page hosts (host + port, loopback
    names folded) and `read_only.hosts` of every production or read-only environment of **every** project of the
    workspace. `project_create` refuses a page on one of another project's; a run, hooks or an environment reset on a
    read-write environment with a page on one is refused at submit and by the worker (`checkWorkspaceProtection`). A
    protected environment itself is not concerned (its own access applies); sandboxes neither.
- Worker (`runWorker`, entry `worker-main.ts`; `retake worker` (hidden) runs the same): takes `worker.lock` (a live
  holder: exit at once; a stale one is taken over under a breaker), and runs two slots (L5.14, §4q): the capture slot
  claims the oldest queued capture-class job and runs it in the worker, the heavy slot the oldest queued heavy job and
  runs it in a job process of its own (`worker-main --job`); captures go first. Each job's cancel marker is checked
  right after the claim; it runs, and its final state is written — a write that fails makes it exit 1, so readers see
  `interrupted` rather than a live `running`. Idle for `--idle-exit` (default 60 s): it releases the lock, looks at the
  queue once more (a job queued while a client saw it alive), then exits. It exits when `.retake/` disappears,
  and, when idle, when its build changed (`buildStamp`: version + the mtimes of the modules of the engine and of every
  `@retake/*` package it depends on at run time, transitively from the package.json files — core, hooks,
  runner-web, sandbox), handing over to a new worker if jobs wait. A job whose input version or kind it does not know
  (a newer client) is left to a worker of the new build when the code changed, else closed `failed` (`invalid`,
  "refused without running") — never parsed as another kind. Signals: the first SIGINT / SIGTERM stops claiming and aborts
  the running job (teardown and rollbacks run); a later one removes session copies, runs the take's `onQuitSync` and
  exits 130 on the next tick, after the runner's own second-signal handler has killed its shell hooks.
- `auth_login` / `sandbox_up` / `sandbox_reset` jobs (part D). `{…, kind: 'auth_login', env?, persona? (a name),
  mode: 'headed' | 'auto'}`: the executor is `retake login`'s (`loginTarget` + `signInPersona`, under the job's
  interrupt port): `headed` opens a visible window on the worker's machine and the job waits until the human closes
  it; `auto` plays the persona's `login:` steps. Its result (`AuthLoginJobResult`) is the check's status, `signed_in`,
  the `retake login` command, and the check's detail and URL under `untrusted` — never a profile or snapshot path, a
  cookie or a secret. `{…, kind: 'sandbox_up', env?}` / `{…, kind: 'sandbox_reset', env?, reseed?}`: `Sandbox.up` /
  `reset` under the interrupt port (`onQuitSync` = `killStartedSync`), result `SandboxJobResult` (services started /
  kept / changed, the reset or null, pages). **Seed steps run with trust `mcp`** (sandbox `SandboxCallOptions.seedTrust
  {trust, confirm}` → `ProviderContext.seedTrust` → `runSeed`): a shell seed step needs an approval (hooks: in phase
  `seed` only a shell step asks under trust `mcp`; destructive http / sql steps rebuild the sandbox's own data and are
  never asked about; `exec` steps run in a container and are not hooks). Its fingerprint is `hookFingerprint(step,
  {phase: 'seed', index (among ALL the seed steps), env: <sandbox env>})` — `runSeed` maps runHooks' batch index (between
  exec steps) to it. `seedApprovalItems(project, env)` lists them at submit for sandbox jobs and for a run with
  `sandbox: true` (whose take passes the run's trust and approvals to `prepareTake`). An interrupted job's `fix` depends
  on its kind: `env reset` (run, hooks, env_reset), `login` (auth_login), `sandbox up` (sandbox jobs), `record` (record:
  no draft was made; the events streamed so far stay in the recording's folder).
- The worker's dispatch is a `switch` over the job kinds (exhaustive). Each finished job — and each interrupted one
  the next worker records — appends a line to `<workspace>/.retake/history.jsonl` (`{v, at, job, kind, project,
  submitted_by, state, ms, run?, counted: {captures, dry_runs, renders}}`, O_APPEND, best effort); `retake run`,
  `retake render` and `retake still` append theirs (no job), `retake export` one counting the formats it re-rendered
  (component previews are not counted). `engine.usage()` sums them; `entitlements()` is the parked licence hook.
- `retake jobs [list] | status <id> | cancel <id>` (CLI, `commands/jobs.ts`) reads the same queue through the engine
  (`client: 'cli'`, `autoStartWorker: false`: a worker started from a terminal would inherit the terminal's
  environment and run the jobs an MCP client queued): newest first with progress and outcome, one job's details, a
  cancel (a finished job: nothing to do; a queued one is cancelled at once, closed by the next worker). Malformed ids and states are usage errors (exit 2); an unknown job exits 1.
- `ensureWorker(root)` spawns `node <engine>/worker-main.js --root <ws>` detached (`--conditions=source --import
  <tsx loader>` + the `.ts` entry when the engine runs from its sources) unless the lock's holder is alive. The worker
  inherits the spawning server's environment and outlives it.

**`@retake/mcp`** (deps: core, engine, `@modelcontextprotocol/sdk` pinned at exactly 1.32.1, zod).

- `server.ts` is the only module importing the SDK: the low-level `Server` (tools/list, tools/call), the stdio
  transport; it ends when stdin ends or closes, once the calls already received are answered, or when stdout breaks.
- `schema.ts`: tool inputs are zod `strictObject`s (an unknown argument is refused), published with
  `z.toJSONSchema(s, {io: 'input'})` (a field with a default is optional) without `$schema` / `$id`. Argument
  problems are tool errors (`invalid`, one line per argument), so the model can correct them; an unknown tool is a
  JSON-RPC error.
- `result.ts`: `content[0]` a summary for Claude (never untrusted text), `content[1]` the data as JSON, also
  `structuredContent`; strings under `untrusted` are cut at 2000 characters; errors: `isError`, `"<code>: <message>"`
  + `fix`, `structuredContent.error`.
- `startMcpServer({root})`: console.log / info / debug go to stderr; one engine (`client: 'mcp'`). Nothing in this
  process opens a browser or starts a capture (auth status reads files; sandbox status asks the provider).
- `config-snippet.ts`: `--print-config` — `stableNodePath` (mise / nvm `node/[v]<major>`, Homebrew `opt/node@<major>`),
  `clientPath` (core `client-path.ts` since L4.2, re-exported: PATH with the node's folder first + Homebrew / system
  folders, absolute entries only, without the folders a package manager adds for its script: `node_modules/.bin`,
  corepack, node-gyp-bin, and none inside the workspace, under any spelling of it — `realpathSync.native`, and any case
  where the system ignores case), `RETAKE_HOME` when set (absolute, through `retakeHome`); the `mcpServers` JSON (stdout) and the `claude mcp add` line (stderr). L3.7: `pluginMarketplaceRoot` (the first
  folder above the entry point with `.claude-plugin/marketplace.json` and `skills/.claude-plugin/plugin.json`) and
  `pluginInstallCommands` (`claude plugin marketplace add <repo>`, then `cd <ws> && claude plugin install
  retake@retake --scope local --config node=… cli=… workspace=… [home=…]`, shell-quoted), printed as the
  alternative to `claude mcp add` when the marketplace is there. Serving, `retake mcp` sets its own `PATH` to
  `clientPath(process.execPath, PATH, …, root)` before the server starts (a plugin or GUI client may pass a bare PATH,
  a relative entry or a folder of the workspace, where the agent writes; the jobs worker inherits it). `engine_info`
  adds `started_in` (the server's cwd: Claude Code's session folder) and `started_outside_workspace`, said in its
  summary: the plugin's values are per user, not per folder (review M3).
- The plugin (L3.7, repository root): `.claude-plugin/marketplace.json` (marketplace `retake`, one plugin, source
  `./skills`); `skills/.claude-plugin/plugin.json` (`retake`, version = `RETAKE_VERSION`, `skills: "./"`,
  userConfig `node` / `cli` (file) and `workspace` (directory), required, and `home` (directory, default `""`));
  `skills/.mcp.json` (`${user_config.node} ${user_config.cli} --root ${user_config.workspace} mcp`, env
  `RETAKE_HOME=${user_config.home}`: an empty `home` replaces an inherited `RETAKE_HOME` and `retakeHome()`
  falls back to `~/.retake`). Claude Code checks neither the paths nor that required values are set (a missing
  one: no server, the skills still load). `claude --plugin-dir skills` loads it as `retake@inline`, with its own
  (empty) values. Tests: packages/mcp/test/plugin.test.ts (layout, print-config, quoting, PATH; a gated block runs
  `claude plugin validate` / `plugin details` / `mcp list` on a scratch `CLAUDE_CONFIG_DIR`).
- The skills (L3.7): `skills/retake-{scenario,theme,component}/SKILL.md` (frontmatter `name` first, then
  `description`, nothing else; ≤ 200 lines; a "Before you start" block calling `engine_info`, the loop, "what good looks
  like", a Rules block with pinned sentences) and two references (`retake-scenario/reference/scenario-language.md`,
  `retake-component/reference/kit.md`). The lint `packages/mcp/test/skill-lint.ts` (`lintSkills(files, ctx)`, the
  context injected: tools with their input JSON Schemas and zod checks, the vocabulary, `ACTION_NAMES`, the kit's
  names, the CLI's help through `main`, the scenario validator under agent trust on a fixture copy, `parseManifest`,
  file existence, `checkComponentEntry` on a component folder) returns issues by rule (`frontmatter`, `size`, `tool`,
  `vocabulary`, `cli`, `link`, `orphan`, `yaml`, `code`, `actions`, `kit`, `hygiene`, `rules`, `coverage`);
  `unknownKeys(root, schema, value)` walks nested keys (`$ref`, `anyOf`, records through `additionalProperties`, arrays
  through `items`). After the review of L3.7: the CLI rule is absolute (pinned: never `retake`, `pnpm retake` or
  `node …/bin.js` through the shell, whoever asks); `LOOPHOLE` runs over the whole Rules block; the prose (code and
  pinned sentences blanked) refuses `DENY` phrases (curl, wget, download, password, "do what it says", "anyway"),
  "run … yourself", "run `retake …`" unless "never" or the user runs it, and a `retake …` command whose sentence does
  not name the user (outside "For the user's own terminal"); `FORBIDDEN` adds Claude Code's load-time `` !` ``,
  `` ```! `` and `$ARGUMENTS` / `$N` / `$name`, `confirm` in any spelling and a secret reference with a space;
  hosts are matched case-insensitively and bare domains on every two-letter and common generic TLD (file extensions
  and schema key paths excepted); "Before you start" pins the root ≠ session-folder stop (and, for themes, the
  repository stop). Tests:
  packages/mcp/test/skills.test.ts (the shipped skills pass; one negative case per rule). A lot that changes a loop,
  a tool's arguments or a CLI flag a skill names updates the skill: the lint fails until it does.
- Tools of part A: `engine_info`, `project_list`, `project_get`, `project_create`, `project_update_readme`,
  `scenario_get`, `scenario_validate`, `scenario_save`, `run_list`, `run_status`, `auth_status`, `sandbox_status`.
  Part B: `run_dry` (waits `wait_s`, default 20), `run_capture` (returns at once), `run_status` with `wait_s` and the job
  overlay, `run_cancel`, `job_list`, `job_status`, `job_cancel`. `wait_s` is 0–25 s: a wait polls the job (300 ms)
  until it finishes; while waiting, a call whose request carries a `progressToken` gets `notifications/progress`
  (`progress` = steps done, `total` = steps, `message` = state and current step; strictly increasing, ≤ 2 a second:
  `progressReporter` in server.ts). The client cancelling the call ends the wait, never the job. Part C: `hooks_run`
  and `env_reset` (jobs, `dry` by default, `wait_s` default 20; annotations destructive + open world). Part D:
  `auth_login` (`mode` headed by default, `wait_s` 0; annotation open world, not destructive; no credential argument —
  the stdio test checks that no tool schema names a password, secret, token or cookie) and `sandbox_up` /
  `sandbox_reset` (`wait_s` 20; destructive, not open world) — 23 tools.
- **Elicitation** (`approval.ts`). When the client declared form elicitation, a call gets `CallContext.elicit` (server.ts:
  `server.elicitInput({mode: 'form', message, requestedSchema}, {relatedRequestId, timeout, signal})`) and the tool an
  `Approver`: one form per submit, message = the work, project, environment (production, access), each hook (phase,
  position, name, templated description with its target, reason) and the `retake` command; schema `{approve: boolean}`
  (required, default false). Only `accept` with `approve: true` approves. The timeout is explicit — 10 min
  (`RETAKE_MCP_APPROVAL_TIMEOUT_MS`), since the SDK's default request timeout is 60 s; a timeout
  (`isTimeoutError`) or any failure refuses. A client without form elicitation gets no approver: `needs_approval`.
- **Prune approval** (`approvals.ts`, `engine.projects.prune(slug, req, {approver})`). Under agent trust (every client
  but the CLI and tests) a prune with `dry_run: false` lists first (`pruneProject`, dry, with the jobs queued or
  running then), builds `PruneApprovalRequest {what: 'prune', project, keep_renders, count, bytes, by_kind [{kind,
  count, bytes}], lines (the first PRUNE_FORM_MAX_LINES = 20 items: kind word, id with every hidden character written
  out, reason, size), more, fix: 'retake -C <ws> prune <p> [--keep-renders N] --yes'}` and calls
  `takePruneApproval`: a form (engine `pruneApprovalFormText`, whole; mcp `pruneApprovalMessage` is it) over
  APPROVAL_FORM_MAX_CHARS → `refused` before anyone is asked; no
  `Approver.approvePrune` → `needs_approval`; declined / cancelled / timeout / error → `refused`; nothing is deleted
  before an accept. The form says approving deletes every item, the listed and the counted ones. Accepted: a second
  `pruneProject` pass (the jobs read again) with `only` = the listed items' `pruneKey` (`<kind>:<id>`) → the paths each
  had then deletes those still prunable then, each with only those paths (a file added since stays); `skipped` names the approved ones that are not
  (something uses them now, or they are gone), `not_asked` counts the prunable ones not in the approval — both
  kept. mcp `pruneApprovalMessage` / `pruneApprovalForm` (schema `{approve: boolean}`, default false) put it to the
  person; `project_prune` passes the call's approver. The CLI's `retake prune --yes` deletes in one pass, unasked.

## 4c. Engine HTTP server and Studio app (L4.1)

**Engine `src/http/`** (node built-ins only; shared by every local HTTP server of the engine):
- `checkRequest(req, {port, token, route, refuseBrowsers?}) → {ok, path, route} | {ok: false, status, code, message,
  allow?}` — the gate, one fixed order, each layer answering on its own: Host exactly `127.0.0.1:<port>` /
  `localhost:<port>` (421: what stops DNS rebinding) → with `refuseBrowsers` (MCP over HTTP) any request `fromBrowser`
  (an Origin header, or a Sec-Fetch-* header other than a lone `Sec-Fetch-Mode: cors` — the one Node's fetch adds to
  every request) 403 — a second line, not the first: browsers send an Origin on every POST and cross-origin fetch, and
  Sec-Fetch-* from secure contexts only (a plain-http page's no-cors GET carries neither; it holds no token) →
  a present Origin this server's own, and on API routes (`RouteSpec.api`) a present Sec-Fetch-Site `same-origin` /
  `none` (403) → route (404) and method, OPTIONS never (405 + Allow) → `Authorization: Bearer` compared in constant time
  when `RouteSpec.token` (401) → POST `application/json` (415) and a declared Content-Length within `RouteSpec.maxBody`
  (413). `readBody(req, max)` caps the bytes too; `drainBody` reads a refused body (≤ 8 MiB) before the answer so the
  client reads it instead of a reset. `securityHeaders(kind)`: `STUDIO_CSP` (`default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`), nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP / CORP same-origin,
  `Cache-Control` no-store (API) / no-cache (static). Never an `Access-Control-*` header.
- `listenLoopback(server, port = 0)` — 127.0.0.1 only (no host option), `busy` on EADDRINUSE, refused when the bound
  address is not 127.0.0.1.
- `newSecret()` (32 random bytes, base64url), `secretEquals`, `bearerToken`, `BootstrapCodes` (one-time codes, 60 s,
  ≤ 16 waiting, kept as sha256 digests).
- `ERROR_STATUS`: invalid 400, refused 403, needs_approval 403, not_found 404, conflict 409, cancelled 409, busy 423,
  unavailable 503, internal 500.
- `stableToken(file, {rotate?}) → {token, created, rotated}` / `readPrivateToken(file)` / `mcpHttpTokenFile()` =
  `<Retake home>/mcp-http.token` (part 3): created once (0600 temporary file, chmod, `link()` into place: two starts
  never write two tokens), replaced by `rotate` (0600 temporary file renamed over it); trusted only as a regular file of
  this user without group / other bits holding one token — anything else `refused`, never repaired silently.
- Discovery file `<workspace>/.retake/ui.json` `{version: 2, kind: 'ui', pid, started_at, port, url, since}` — no
  secret: `claimDiscovery(file, record)` after the bind writes those fields only — a 0600 temporary file (chmod)
  hard-linked into place; on EEXIST a live holder (pid + start time) is returned for reuse, a stale or broken file
  replaced once; a state folder this user cannot write (EACCES / EPERM / EROFS) is `refused` with a fix;
  `readDiscovery` refuses a link, a non-regular file, another user's file or any group / other permission bit, and
  reads a version-1 record (an older Retake's, which held the token) for its holder only, never its token;
  `releaseDiscovery` removes only its own record (pid, start time, port, since), a regular file of this user whatever
  its mode by then (a file made 0644 while serving does not outlive the server).
- Studio token record `studioTokenFile(root)` = `<Retake home>/ui/<sha256 of the workspace's real path, 16 hex>.token`
  `{version: 1, root, pid, started_at, port, token}`: written by the server that won the claim (`writeStudioToken`:
  0600 temporary file renamed over it, through `replacePrivateFile` — a link, another user's file or group / other
  bits are `refused`, as the MCP HTTP token), read by `readStudioToken` (null for another workspace's root), removed on
  close only while it is still its own (`releaseStudioToken`). What its place protects against: a process confined to
  the workspace folder (or a synced copy of it) reads no secret in `.retake/`, and a ui.json it rewrites never gets the
  token (a reuse sends it to the record's port only). A process of this user that reads the Retake home is the person
  (the MCP HTTP token and the signed-in profiles are there too).

**Engine client `ui`.** `EngineClient` and core `JOB_CLIENTS` gain `ui`; `agentTrust(client)` (= not `cli`, not
`test`) gives the scenario checks agent trust; comment authorship and `cliOnly` already treat anything but `cli` as the
agent; no approver is ever passed (`needs_approval`). The L4.1 allow-list runs under agent trust; how a person proves
presence in the UI (approvals, comment authorship, edits with secret refs) is open: L4.3 and L4.4 kept agent trust
(approvals and edits with secret refs: BL-106), comment authorship is L4.6's.

**`LocalStorage` reads** (`readText`, and the if_match hash of `writeText`) go through the file's real path and are
refused (`refused`) when it lies outside the project's real path — README.md, scenario_get, scenario_save,
project_update_readme alike; the refusal never names the link's target. A project folder that is itself a link reads
normally. `readText` also says whether the bytes are UTF-8 (`utf8`; `text` has U+FFFD where they are not). **Writes**
(`writeText`) through a file that is a symbolic link land in its target when that is a file of the project (the link
stays a link); a link leading out, or to nothing, is refused. `project.yaml` read through the engine (`project_get`,
`project_list`, every job opening a project by slug) is refused when it leads out of the project; the CLI reads what
the person points it at. `project_get` keeps opening a project whose README.md cannot be edited as text:
`readme_error` says why (a link leading out: `readme` and `readme_hash` null; not UTF-8: the text with U+FFFD).
`project_update_readme` holds `README_MAX_CHARS` (200,000) for the file as written, its final line break included.

**`callTool(t, engine, args, ctx) → {ok, output} | {ok: false, error: EngineError}`** (`@retake/engine/contract`, an
`exports` sub-path of the engine; moved from the MCP package) — the zod parse (problems per argument) and the handler,
SDK-free; `protocolTool` and the Studio server both use it. The same entry holds `ToolDef` / `ToolContext` /
`ToolOutput`, `capUntrusted` and `pinArguments`, and the **operation catalogue** (`catalogue.ts`, also its own
browser-safe entry `@retake/engine/catalogue`: it imports nothing at run time): every operation once (122: the 45 MCP
tools, the Studio's 65 own ops, 12 operations only the CLI serves), its facets — the effect (`read`, `write`,
`destructive`), whether MCP and the Studio queue it as a job, whose code it runs (`none`, `project`: hooks and sandbox
commands, `workspace`: components and themes rendered), `serves` for the commands that serve others (`mcp`, `ui`,
`worker`) — the engine's admission rules it meets (§4d), and, for each shell (CLI commands, MCP tool, Studio op), the
service or the one-line reason it has none; the Studio's entry holds its pinned arguments (`run_status` `wait_s` 0;
`auth_login` `mode` headed, `wait_s` 0) and its ops' own statuses (`render_frame` busy → 429, read with
`studioStatus`). The Studio's allow-list `UI_OPS` is `servedNames('studio')`, in catalogue order. Tests hold MCP
`TOOLS` (in order), the Studio's own ops, and the CLI's commander tree (`commandPaths()`) to it, and every tool's
read-only and destructive hints to its effect (`hintsOf`: read-only exactly for `read`, destructive exactly for
`destructive`; a table test); snapshots hold the published tool list and the Studio's operation table byte for byte
(packages/mcp/test/fixtures/tool-list.json, packages/ui/test/fixtures/op-table.json).

**Admission rules and the caller (L6.5).** The engine's submits of a run, a render and an export hold the Studio and
MCP (caller.ts `admits`) to four rules, each checked and followed by its submit under its own key in the engine's
process (admission.ts): `one_run_per_scenario` (a run of the scenario queued or running → 409 `conflict` naming it),
`sessions_ack` (a capture of a scenario whose persona's session is not valid and that no run signs in by itself needs
`sessions_ack` naming it: `details.sessions`), `one_render_per_scenario`, `export_cap` (one export of a render, at most
`EXPORTS_OPEN_MAX` = 2 of the workspace; a `latest` is held to it once resolved). The words are the ones the Studio
gave when the rules were its own; the CLI's own commands (in their process) and the engine's tests are not held. Who
calls is one `Caller` (`callerOf(client)`: client, channel `cli` / `studio` / `mcp`, trust `author` / `mcp`), and every
decision the engine takes from it is a function of caller.ts (agent checks, refusal wording, person channel,
`if_match`, proposals, the Record screen, the worker's clean environment, theme edits, admission); `EngineClient` is
core's `JobClient`; `HookTrust`, `PlanTrust` and `BrandTrust` are the caller's trust (a compile-time check), and the
engine holds every job and a theme made from a brand to `mcp` (`ENGINE_TRUST`).

**`@retake/ui`** (deps: core, engine, mcp, esbuild, react, react-dom; the MCP package never depends on it; from the MCP
package it takes only the tools it serves as they are and the Set-up sheet's registration helpers).
- `buildUi()` — esbuild in memory: `src/app/main.tsx` + its CSS → `/app.js`, `/app.css` (ESM, minified, targets
  chrome120 / safari17 / firefox120), `/` a static `INDEX_HTML` without inline script or style; ≈ 100 ms, ≈ 190 KB.
- `startStudioServer({root, port?, log?, sqlite?, pollMs?, startWorker?, workerSpawn?, workerIdleExitMs?}) → {url, port,
  token, mintCode(), launchUrl(), calls, streams, live, engine, close()}` — engine `createEngine({client: 'ui',
  autoStartWorker: startWorker !== false, workerEnv: studioWorkerEnv(process.env, root)})` (L4.1: no worker; L4.2 part
  4: the worker starts on a submit, with a clean environment — engine `cleanWorkerEnv`, what every client but the CLI
  gives its worker, §4d "Run actions"); routes: static (GET
  / HEAD, no token), `GET /v1/events` (token, api: the event stream, below), `POST /v1/live` (token, api, ≤ 4 KiB: one
  run's stream, §4f — L4.4), `POST
  /v1/session` `{code}` → `{ok, token}` (no token; the code is the proof), `GET /v1/info` → engine info + `http_api: 1`
  + `ops`, `POST /v1/bootstrap` → `{code, url}` (token), `POST /v1/call/<op>` (token, ≤ 2 MiB) → `{ok: true, summary,
  data}` (untrusted caps applied) or `{ok: false, error: {code, message, fix?, details?}}` with `ERROR_STATUS`; an op
  outside `UI_OPS` (`engine_info`, `project_list`, `project_get`, `project_update_readme`, `job_list`, `run_list` and,
  since L4.2, `run_status` without its long-poll (`wait_s` absent or 0: critique B11) — MCP tools — and
  `activity_list`, `search` — the Studio's own reads of the index — `projects_overview` — every project's environment
  flags and last run in one call, for the Projects screen — and, since L4.2, `scenario_blocks`, `run_thumbs`, the own
  op `scenario_run` and the MCP tool `run_cancel` (§4d); since L4.3 the MCP tool `scenario_validate` and the own op
  `scenario_edit` (§4e); since L4.4 the MCP tools `auth_status` and `auth_login` (NARROWED: `mode` headed only, `wait_s`
  0) and the own ops `run_pause`, `scenario_sessions`, `sign_in_cancel` (§4f); L5.10a the own READ op `project_board` (§4l); since L5.2b the own op `unsaved_report`
  (what a tab holds unsaved, kinds and names only: the desktop app's quit question, §4j); `run_dry` / `run_capture` and `scenario_save` stay out (critique B11; one Studio write path);
  `ToolDef`s in `src/server/ops.ts` that never take an MCP tool's name) is 404 `unknown op` and runs nothing.
- `launchStudio(o) → {reused: false, server, url} | {reused: true, url}` — a live holder of this home's token record
  is reused (a new code minted through `/v1/bootstrap` on that record's port with its token), else a server is started,
  ui.json claimed and the token record written; closing releases both. A live holder of ui.json without a token record
  in this home (after a 2 s wait for one that just claimed it) is `busy` with what to do: another RETAKE_HOME's server
  ("run retake ui with the RETAKE_HOME that server was started with, or stop it") or an older Retake's (version 1:
  "stop it") — nothing is sent to its port. A build older than this one reads a version-2 record as broken and replaces
  it (two servers on one workspace until one stops: the residue of mixing builds). `retake ui --port N` while a server already runs on another port reuses it and warns that `--port` is not used.
  L5.2: each answer has `player` (the player origin; `/v1/bootstrap` answers it too — no secret, the capabilities under
  it are), undefined from an older server; `retake ui --json` prints it with `v: 1`; `retake ui --supervised` (§4j:
  `v: 2` since L5.2b, the pipe lines follow). L5.2b: after each op that succeeded and is not read-only (`unsaved_report`
  excepted) the server's `onWrite` listeners run (the supervised job watch polls at once).
  `/v1/info` adds `counters` — `sessions` (codes redeemed), `streams` (event streams open), `player_media_bytes_read`
  (bytes of registered files read to answer GET requests — read, not sent: an aborted response counts its read-ahead;
  review B L9), `player_range_requests` (GET answers 206) — numbers only, what the desktop shell's black-box test asserts; every answer carries
  `Permissions-Policy: camera=(), microphone=(), display-capture=(), geolocation=()` (Chromium browsers enforce it;
  whether WKWebView does is unverified — the desktop shell denies every media-capture request itself and its Info.plist
  names no camera / microphone / location use: §4j).
- The page (`src/app/`): reads `#c=<code>` and removes it with `history.replaceState` before anything else (a route
  fragment stays), trades it at `/v1/session`, keeps the token in sessionStorage, sends it as a header (`credentials:
  'omit'`); no token or a 401 → "This Studio session ended — run `retake ui` again" (no input asks for a token), with
  every unsaved README text of the tab still on screen, read-only, to copy.
- App structure (L4.1 part 2; React, no router or state library): hash routes `#/`, `#/p/<slug>`, `#/p/<slug>/readme`
  (`route.ts`: `parseRoute` decodes and caps a slug — the server checks it —, `hrefTo` is the only builder of an
  `href`); `api.ts` `call(op, args)` / `useCall` (load, reload, refetch on focus) and the connection state (online /
  offline / ended); `Shell` (sidebar: Projects, each project with Overview / README of the open one, the workspace
  folder, connection, version, worker from `engine_info` every 15 s and at each `jobs` event, the update mode);
  `ProjectsScreen` (`SearchBox`, `project_list`, then ONE `projects_overview` for every card's environment flags and
  last run — re-read at any project event, resync or focus —, `ActivityPanel`); `ProjectPage` (`project_get`, `run_list {limit: 5}`, `ActivityPanel {project}`); `ReadmeEditor`
  (below); `drafts.ts` (unsaved README text per project for this tab, `beforeunload` guard); `events.ts` (part 3,
  below); `Activity.tsx` (`ActivityPanel`, `SearchBox`: hits link to their project through `hrefTo`).
- README editor: a textarea with `maxLength` 200,000 (the tool's cap) and a counter; save (button, Cmd/Ctrl+S) →
  `project_update_readme {markdown, if_match: the hash the text was based on}` — `markdown` with a final line break and
  the file's own line breaks (the textarea works in LF; `drafts.ts` remembers CR LF or LF from the text loaded, so
  loading a CR LF file is no change and a save keeps it CR LF), never sent over the cap (final line break included);
  `readme_error` (not UTF-8, a link leading out) → a read-only view with why, never the editor; no README.md → "saving
  creates it". While open, `project_get` at each
  `workspace` event naming the project in `readme`, at each `resync` and on focus (skipped during a save; a read
  started before a save ended is ignored — the epoch guard): a new hash with no unsaved text
  → loaded and announced, with unsaved text → a banner ("Load the version on disk" / "Keep editing mine"); 409 → a
  fresh `project_get` and a panel with both texts: "Save mine over it" (if_match = the shown version's hash; another
  change meanwhile → 409 again), "Load the version on disk" (the person's text kept read-only to copy), "Back to
  editing".
- Untrusted text: every value is a React text node; names, slugs, paths, URLs and errors go through `Txt` (a `<bdi>`
  with U+202A–U+202E / U+2066–U+2069 shown as `[U+…]` marks); README text is shown as-is in a `<pre>` and the
  textarea. A source lint (`packages/ui/test/app-source.test.ts`) bans `dangerouslySetInnerHTML`, `innerHTML` /
  `outerHTML`, HTML-from-string APIs, `document.write`, `eval` / `Function`, string timers, `setAttribute`,
  `javascript:`, `src=` and any `href` not built by `hrefTo`, and raw direction controls in the sources. L4.2: one
  image source — Thumb.tsx's `<img src={url}` with `url = jpegDataUrl(entry.base64)`, exactly once (§4d) — and no
  `srcSet`, `createElement` / `cloneElement`, `src` key (a `{...{src}}` spread), frame, object or media element.
- `retake ui` (cli `commands/ui.ts`): workspace check as `retake mcp` (exit 2 with the `--root` hint), lazy import of
  `@retake/ui`, opens the browser (`open` / `xdg-open`) unless `--no-open`, serves until SIGINT / SIGTERM.

**The workspace index** (part 3; engine `src/index-db/`, R-ARC-05, ADR-2) — `<workspace>/.retake/index.sqlite`, a
cache of the files, written only by the Studio server holding ui.json (the worker and the CLI never open it).
- `loadSqlite()` imports `node:sqlite` once, with a `process.emitWarning` filter that lives only during the import and
  swallows only the warning whose message starts "SQLite is an experimental feature" (a DeprecationWarning in the same
  window still prints); `ERR_UNKNOWN_BUILTIN_MODULE` (Node 22.0–22.12) → null: no index, `activity_list` / `search`
  answer `unavailable` ("needs Node.js 22.13"), everything else works.
- `WorkspaceIndex.open(ws, {loader?})` → null without node:sqlite; `rebuilt`: `missing` (built), `corrupt`
  (`PRAGMA quick_check` not ok, or SQLITE_CORRUPT 11 / SQLITE_NOTADB 26 by `errcode` — node:sqlite's `code` is
  generic), `schema` (meta.schema ≠ `INDEX_SCHEMA`), `not_a_file` (the db, its -wal or its -shm is not a regular file:
  a symbolic link — SQLite would follow it — is removed, never followed) → the file and its -wal / -shm deleted and
  built again; WAL,
  `timeout: 2000`. Tables: `meta` (schema, generation, history inode and byte offset), `sources` (key → signature),
  `projects` (slug, name, error, scenario count), `runs` (run.json summaries), `renders` (renders/*.json read as data —
  the index never loads the editor), `history` (one row per history.jsonl line), `search` (FTS5: kind, project, ref,
  title, body — project name + README, scenario names, run and render ids with scenario / mode / theme / status).
  **No jobs table** (critique B2).
- `reconcile()` (one pass at a time) — `scanSources(ws, unfinished)` (sources.ts): per project, the signatures (inode,
  size, mtime) of project.yaml + sandbox.yaml + `scenarios/` (`project:<slug>`), README.md (`readme:<slug>`), `runs/`
  + the run.json of runs the index holds as queued / running (`runs:<slug>`), `renders/` (`renders:<slug>`), and
  history.jsonl (`history`); `diffSources` against the `sources` table → only those re-read (`listProjectSummaries`,
  README through `LocalStorage.readText` — a link out of the project is not read —, `listRuns`, renders/*.json — a
  README or render record only when it is a regular file (≤ 4 MiB / 1 MiB) inside the project once links are
  followed, a run.json only as a regular file (no link, no FIFO), never opened otherwise —,
  history.jsonl from the stored offset to its last `\n`; a shorter file or another inode is read from the start) and
  written in one transaction; returns `{keys, generation}`.
- `activity({project?, limit})` — jobs whose job.json says queued / running (a job seen finished is never read again:
  its file no longer changes), each `derive()`d now (a dead worker →
  `interrupted`, a cancel before the start → `cancelled`), then history rows newest first: `{source: 'queue' |
  'history', at, kind, project?, state, job?, submitted_by, ms?, run?, render?, progress?}` — ids, kinds and states
  only (history lines carry no product text). `search(q, {project?, limit ≤ 50})` — `ftsQuery(q)`: every word (NFKC,
  control characters dropped, split on spaces and FTS punctuation, ≤ 12) a quoted prefix term with quotes doubled,
  bound as a parameter (no FTS syntax from the person reaches SQLite); ranked; a README snippet for projects.
- `JobsWatch.poll()` — ids of jobs new since the last poll or unfinished then whose state / progress / cancel changed
  (the first poll takes stock): a handful of job.json reads, whatever the queue's length.

**The event stream** (part 3; ui `src/server/live.ts`, app `src/app/events.ts`).
- `GET /v1/events` (token, api route: the gate's Origin / Sec-Fetch-Site rules apply) → `text/event-stream`: `hello
  {api, index, generation}`, `workspace {projects, readme, scenarios?, runs?}` (slugs whose sources changed; `readme`:
  README.md; since L4.2 `scenarios`: `<slug>/<name>` of scenario files changed, an in-place save included, and `runs`:
  `{project, run, scenario, status, finished, change: new | status | progress | removed}` — §4d),
  `jobs {changed}` (ids), `index {generation}`, `: keepalive` every 15 s. A stream is never an op (`calls` unchanged).
- `Live` polls every second (`pollMs`) while at least one stream is open, never otherwise (critique C2: no recursive
  fs.watch): the index's `reconcile()` — or, without node:sqlite, `scanSources` diffed in memory — and `JobsWatch`.
  `activity_list` / `search` refresh first (`freshIndex()`), and what that refresh found goes out on the streams too.
  At most `EVENT_STREAMS_MAX` = 4 streams; the next is 503 `too_many_streams`.
- The page keeps ONE stream per browser (critique B1: over HTTP/1.1 each stream holds one of the browser's 6
  connections per host — at 6 tabs every call hung and a 7th tab did not load): the tab holding the Web Lock
  `retake.events` reads it (`fetch` with the token in a header — EventSource cannot send one) and relays each event
  over the BroadcastChannel `retake.events`; when that tab closes, the lock passes to another, which opens the
  stream. Without Web Locks each tab leads its own; a leader answered 503 publishes `resync` every 3 s (30 s), then
  tries again; when a stream opens again after one was lost, subscribers get `resync` (re-read what they show). `useEvents`,
  `useProjectEvents(slug)`, `useEventMode()` (`stream` / `relay` / `polling`: the sidebar says *live updates* or
  *updates every 3 s*). The `resync` after a lost stream is the next stream's `hello` (what changed meanwhile was told
  to nobody).

**MCP over HTTP** (part 3; R-MCP-02; mcp `src/http.ts`, `server.ts`; cli `retake mcp --http`).
- `server.ts`: `wireServer(o)` (tools/list, tools/call with progress and form elicitation) shared by `serveStdio` and
  `mcpHttpHandler({…, maxSessions = 8, idleMs = 30 min})` — Streamable HTTP with stateful sessions
  (`StreamableHTTPServerTransport`, `sessionIdGenerator: randomUUID`): one wired `Server` per session, so an
  elicitation goes out on the session's stream and its answer reaches the call that asked; a request without
  `Mcp-Session-Id` must be an `initialize` (else 400), an unknown id 404, DELETE ends a session. A session is *in use*
  while a call runs or its GET event stream is open: at the cap a new `initialize` closes the least recently seen
  session not in use (a client gone without DELETE: Claude Code restarted), 503 only when all are in use (`evicted`
  counts them); a session not in use for `idleMs` is closed. The SDK's deprecated Host / Origin options stay off.
- `startMcpHttpServer({root, port = 47820, token, log?, maxSessions?, idleMs?}) → {url, port, sessions, evicted,
  close()}` —
  engine client `mcp` (one engine per process, as stdio), `INSTRUCTIONS`, `TOOLS.map(protocolTool)`; each request:
  `checkRequest` with `refuseBrowsers` and the one route `/mcp` (GET / POST / DELETE, token, ≤ 4 MiB), the security
  headers, the body read and parsed (400 JSON-RPC parse error), then the handler. `listenLoopback`: 127.0.0.1 only.
- `retake mcp --http [--port N] [--rotate-token] [--json]` — `stableToken(mcpHttpTokenFile(), {rotate})`, the same PATH
  clean-up as stdio, serves until SIGINT / SIGTERM (`--json`: one line `{type: 'mcp-http', url, port, pid}`);
  `--print-config --http [--port N]` prints the registration without the token (review A M1): `mcpHttpConfigJson`
  (`{type: 'http', url, headers: {Authorization: 'Bearer ${RETAKE_MCP_TOKEN}'}}` — Claude Code expands the
  variable when it reads `.mcp.json`, which is often committed) on stdout; on stderr `claudeCodeHttpCommand` (`claude
  mcp add --transport http retake <url> --scope user --header "Authorization: Bearer $(cat '<token file>')"` —
  the shell reads the file, its history keeps the `$(cat …)`) and `mcpHttpTokenExport` (`export
  RETAKE_MCP_TOKEN="$(cat '<token file>')"`). `--port` / `--rotate-token` / `--json` without `--http`: usage
  error.
- Whoever holds the token is an MCP client of the workspace (agent trust) and answers its own approval forms — as the
  client that spawns `retake mcp` over stdio. Separate process and token from the Studio: a Studio page never holds it.

## 4d. Scenario blocks and run thumbnails (L4.2)

Part 1 — the model and the safe reads (core `blocks.ts`, `step-match.ts`, `plain-file.ts`, targets `plainTarget`;
engine `scenarios.check`, `runBlockers`, `LocalStorage.readText`). Part 2 — the view, the thumbnails and the events
(engine `scenario-view.ts`, `run-thumbs.ts`, `run-data.ts`, `run-files.ts`, review `./thumbs`, index-db `sources.ts`;
Studio ops `scenario_blocks`, `run_thumbs`, `run_status`). Part 3 — the read-only screen (ui `src/app/`
ScenarioScreen.tsx, Inspector.tsx, YamlView.tsx, Thumb.tsx, thumbs.ts, scenario-words.ts, events.ts; route.ts). Part 4
— the run actions and the Studio's worker (Studio op `scenario_run`, `run_cancel`, `studioWorkerEnv`; engine worker
spawn options, the worker lock's `started_by`; the client's channel carried into the hooks package and the runner).

**Blocks** (core `scenarioBlocks(text, {issues?, hookFiles?}) → ScenarioBlocks`; R-UI-08..10, R-UI-14). Pure, never
throws: `{parsed, video, hooks: {setup, teardown}, entries, step_count, issues}`.
- `video`: name, title, env, template, frame, intro / outro (`theme` | `off` | `custom` with component, file, duration,
  tagline, url), music, tutorial, clock, capture overrides, pacing keys, var names, mock count, the file's top comment
  as a person reads it (`topCommentWords`, review B M5: leading editor directives — `yaml-language-server:`, an Emacs
  `-*- … -*-`, a vim modeline — left out with one blank line after them, hard wraps joined into paragraphs, list items
  kept on their lines, URLs without userinfo) and `comment_lines` (its lines as written, what L4.3 edits).
- `HookBlock`: phase, index, kind, name, one-line `summary` (http method + URL; sql file or first line, its database;
  shell / js first line or file), `rollback`, `needs_person` (core `hookApprovalReason` — the same rule as the submit's
  backstop: declared or detected destructive, any shell command, a setup hook's rollback that needs approval; engine
  `approvals.ts` now calls it), `flags` (destructive, rollback, confirm, optional, reads only).
- `entries` in file order: `scene` (id, effective `page` — its own, else the previous capture scene's,
  `page_inherited` —, `pages[]` of a multi-page scene, `open`, `continues`, persona, caption, speed, still, cursor,
  transition, frame, tutorial, irreversible, skip, note, `context`, `steps`), `card` (id or `card-<i>`, component,
  string slots, params, file, duration, transition), `interstitial` (id or `interstitial-<i>`, text, kicker, duration,
  component, file), `unknown` (not a mapping, a scene without a string id).
- `StepBlock`: `key` "<scene>.<index>" (a timeline's key), id, action, `category` (`actionCategory`: an exhaustive
  switch over ACTION_NAMES — navigation, click, hover, type, select, pick, menu, scroll, drag, drop_file, wait, hold,
  check, script, cursor, download), `label` (the action in words), `target` (plain words), `summary` (one line: text
  typed, key × times, option, URL, seconds, file), `args` (normalised), `chips` (`stepChips`: zoom, hold, mark, caption,
  speed, irreversible — step or scene —, optional, park, overlay, tutorial, page (`on:`), timeout; each `{kind, label}`
  with words), `fingerprint`, `picture`, `occurrence`, `range`, `comment`, `aliased`, `issues`. A step without exactly
  one action is `category: unknown` with why in `label`.
- `range` = 1-based lines and 0-based offsets `[start, end)` of the node (trailing blank space trimmed): the page and
  L4.3 slice the text — no per-step source copy (critique B12). `comment` = the lines just above (the first item of a
  list takes the list's). Issues (from `issues`, else core parseScenario without a project) go to the deepest block
  their path points into (step → entry → hook), the rest to `issues`: each issue in exactly one place.
- Strings as written: a templated `{{shop}}` / `{{env:…}}` stays a reference, never resolved; markup, bidi controls
  and `javascript:` stay verbatim (the page renders text nodes). Only `user:password@` of a URL is left out of what a
  block shows (`stripUrlUserinfo`: scene and page `open`, step targets / summaries / args, hook summaries, outro url,
  card slots and params, every comment — up to the authority's LAST `@`: `https://u:p@ss@h/` → `https://h/`, review A
  #5) — never out of the text or the ranges (the YAML tab shows the file as written).
- YAML aliases: values come from core parseYaml (`maxAliasCount` 1000; a recursive alias — `a: &x {b: *x}`, which
  overflowed every walker, parseScenario included — is now refused with its line). The check is one pass (review A
  #1: `Alias.resolve` walks the whole document per alias — 20,000 aliases took a minute with the event loop blocked):
  each alias's target is the latest node anchored with its name before it in document order, then each alias is
  checked against its path; `locateOffset` uses the same map. 20,000 aliases: < 400 ms (test), refused by the alias
  count. The walker never resolves an alias:
  a block reached through one is `aliased`, carries the alias's range and no comment; L4.3 never edits through it.
- `plainTarget(t)` beside `describeTarget` (unchanged for timelines and logs): `“Save”`, `button “OK”`, `“Increase”
  (aria label) in the dialog`, `field “Delivery window”`, `field with placeholder “…”`, `element with test id “…”`,
  `element matching .row > button`, `element containing “a” and “b”`, `the 2nd …` / `the last …` / `the last visible
  …`, `… in the row containing “Iceland”`, `point 640, 360`.

**Step identity across edits** (core `step-match.ts`; critique B4). Picture identity = sha256(stepFingerprint + `on:` +
scene context), the context = sha256 of the scene's effective page, `open`, `pages` and `persona`; `n` = earlier steps
of the scene with the same identity. `stepFingerprint` itself is unchanged (comment anchors store it).
`scenarioIdentityOfValue` (shared by the blocks and the snapshots: one rule for both sides), `sceneStepFingerprints(text)`
(parsed once — the old per-step re-parse was O(n²)), `matchRunSteps(today, run) → Map<"<scene>.<i>", RunStepMatch>`:
`{run_index}` (same identity and occurrence in the run's scene), else `changed` (an unmatched run step lies between the
same matched neighbours: one of the same action first — review B L1: a changed click is not the wait before it —,
else in order; `run_index` = the replaced step), `new`, `scene_changed`, `scene_not_in_run`, `unreadable`. A modifier-only edit (caption, hold, speed, camera, mark, overlay, id) keeps the picture; reordering
identical steps maps them in order.

**Safe small-file reads** (BL-79 residue). Core `readPlainFile(file, max) → {ok, bytes} | {ok: false, reason: missing |
link | not_file | too_large | unreadable}`: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, fstat on the descriptor (a regular
file of at most `max` bytes), at most `max + 1` bytes read; never throws. `{verify}` sees the descriptor's stat before
the read (false → `link`): the run folder reader's check that the folders above the file were not swapped. Used by `scenarioChangedSinceRun`, by core
`loadProject` for `project.readme` (a FIFO named README.md held every project load), and by engine
`LocalStorage.readText` behind its realpath check: a link out stays `refused` (`details.reason: link_out`), a FIFO /
device / folder is `refused` (`not_file`), a file over `READ_TEXT_MAX_BYTES` (2 MiB = SCENARIO_COMPARE_MAX_BYTES) is
`invalid` "too large" (`too_large`) — never "not found". `projects.get` turns each into `readme_error`. A run submit
reads its scenario through `getScenario` first (before, `prepareRun` read it with `readFile`: a link out was followed,
a FIFO held the submit).

**Run blockers** (critique #6, B2). `engine.scenarios.check(project, name, {env?}) → {name, file, path, yaml, hash, ok,
issues, run_blockers: {dry, capture}}`: `issues` validated against the project WITHOUT agent trust (a person's
`{{env:…}}` is valid in their file; `validate` keeps agent trust for what an agent writes); `run_blockers` from
`runBlockers(ctx, {project, scenario, env?})` — the submit's own gates (`runGates`: agent trust, the workspace's
protected hosts, hooks a rule refuses, hooks that need a person) run for a dry run (hooks skipped) and a capture
(hooks run) with no approver, every gate run, nothing queued or reserved; each `{code, message, fix?}`. `submitRunJob`
runs the same gates and stops at the first: the blockers are the submit's refusals (test: for every fixture scenario
the first blocker equals the refusal; dry runs are never blocked, captures of catalogue and quote are). Wording per
client (`agentChannel(client)`: `ui` → `studio`, else `mcp`): core `agentTrustProblems(…, {via})`, `projectFileProblem`,
`secretRefsProblem`, `templateRefProblem`, engine `checkAgentTrust`, `takeApprovals`, `takeSiteApproval`,
`checkWorkspaceProtection` say "from the Studio" / "The Studio cannot approve hooks yet: run it in a terminal" to the
Studio — never "MCP" —, and keep the MCP wording otherwise.

**The view** (engine `scenarios.view(project, name, {run?, env?})` → `ScenarioView`; Studio op `scenario_blocks`).
`{project, name, file, hash, text, blocks, ok, issues, run_blockers, environment, scenes, runs, source, running, steps,
untrusted}`.
- `blocks`, `ok`, `issues`, `run_blockers` as `scenarios.check` (issues WITHOUT agent trust; blockers worded for the
  client), then as the Studio shows them (`studioBlockers`, review B M2 / M6 / L6): a file with errors → one blocker
  per mode, "the file has N errors (listed with the blocks): fix the file first — a run from the terminal refuses it
  too", `fix_file`, no command; paths become words ("scenes[3].steps[0].click" → "step 1 of scene send (click)",
  "setup[0]" → "setup hook 1"); a `fix` also as `fix_node` (`<node> <repository>/packages/cli/dist/bin.js -C …`, for a
  person without `retake` on their PATH). A file of more than `VIEW_STEPS_MAX` = 2,000 steps (review A #8: a 2 MiB
  file of 43,488 steps made a 20 MB answer): the first 2,000 steps' blocks and bindings (the entries after the one holding
  the 2,000th step left out) and `limit: {steps_shown, steps_total, issues_shown, issues_total}`; issues ≤ `VIEW_ISSUES_MAX` = 500. `environment` = `{name, production, access, sandbox}` of `env` ?? the scenario's ?? the project's default.
- `scenes[<id>]` = `{url?, display?, continues_from?, pages?, captured_s?, run_status?}`: the page base (its own page,
  else inherited, else the environment's first) + `open` when it is a path, the `open` as written otherwise — URLs as
  text, `user:password@` left out of both the base and the `open`; the display base the same way; a scene without
  `open` `continues_from` the previous one; a multi-page scene (review B M1) `pages[] = {id, page?, url?, display?,
  continues_from?}` — each page's environment page and full URL, or the scene that filmed it last; the source run's
  capture time and outcome of the scene.
- `runs` (the picker, ≤ `VIEW_RUNS_MAX` = 20, newest first) = `{id, mode, status (job state overlaid: interrupted),
  env, started_at, finished_at?, steps_done, steps_total, pictures: screenshots | frames | video | null, complete,
  snapshot, partial?}` — a status run.json holds that the runner never writes is `unknown`, and a scene in `partial` /
  `why` is named only when it is a scene id (else "a scene"; review A #4: run.json is a file anyone may write);
  `snapshot` = the run kept scenario.yaml; `partial` = `until step <i+1> of <scene>` | `failed at step <i+1> of <scene>` | `cancelled` |
  `interrupted` (steps 1-based as the screen numbers them — engine `stepRef` —, never the run's 0-based key); `complete` =
  succeeded, not stopped by `until`, with pictures. "With pictures" is read per run from a few lstats (dry: a PNG in
  screenshots/; capture: frames.jsonl + frames/, else capture.mp4, else per-page frames / videos), never from the mode
  (a cancelled capture has frames and no video).
- `source` (critique B8) = the run asked for (`run`: a finished run of this scenario, else `invalid` / `not_found`),
  else the newest complete run with a snapshot (review B L6: a newer one without could only say "cannot tell"), else
  the newest complete run, else the newest finished run with pictures; `{run, mode, status, finished_at, picked,
  changed, binding, notice?, hooks?, newer_partial[]}` — `newer_partial` (`{id, mode, partial, pictures}`) names the
  finished runs newer than the default that are partial or left no picture (an `until` dry run of the authoring loop
  never hides yesterday's complete capture; review B H1: a run that failed before its first step — the site down — is
  named too, `partial` "failed at step 1 of …" or "no pictures"). `running` = the
  newest queued / running run (never a source); its progress is a `run_status` read.
- `steps[<today's key>]` (critique B4) — `changed` = core `scenarioTextChanged(today's text, the run's snapshot)`:
  false → by position; true → core `matchRunSteps` (picture identity: fingerprint + `on:` + scene context); no
  snapshot → by position, `notice: cannot_tell`. A bound step = `{run_key, status, ms?, picture, why?}` — `run_key`
  is the run's own key (what `run_thumbs` takes: caches are keyed by run, never by today's key), `picture` =
  `screenshot` | `error_screenshot` | `frame` | `video` | null, `why` for a step skipped after an irreversible step
  ("after step 2 of one, irreversible: a dry run stops the scene there" — 1-based, review B M2). Otherwise `{missing, why?, run_key?}`:
  `not_reached` (why: "the run failed at step 1 of two", "the run stopped at step 1 of two (until)", cancelled, no
  timeline), `new`,
  `changed` (+ the run's step it replaced), `scene_changed`, `scene_skipped`, `scene_not_in_run`, `unreadable` (why:
  "this step has no single action (fix it in the file)", review B M3). Timeline
  events with `step < 0` (scene_open, scene_still, notifications) bind nothing.
- `untrusted` = `{run_error?, steps: {<today's key>: {target?, error?, url?}}}` — the target as found, the step error
  and the URL visited (userinfo out): page text, cut to 2,000 characters by the call route's `capUntrusted`, never
  outside `untrusted`.
- Memo (critique B1), per engine (`ScenarioViews`): the text layer (blocks, validation, blockers, environment, scene
  URLs, identity) by (file sha256, the signatures of project.yaml / sandbox.yaml / hooks/ / retake.yaml, env), redone
  after 60 s at most (hook files, templates, protected hosts); the run list by the runs folder's signature (its newest
  8 folders and their run.json, unfinished runs' run.json); the binding by (file sha256, the source run's folder and
  file signatures). A repeat with nothing changed reads the file, hashes it and stats a few paths (1,200 steps: first
  66 ms, repeat 4 ms, 454 KB of JSON); 20 rewrites of a running run's run.json recompute no text layer and no binding.

**Run files** (engine `run-files.ts`, `run-data.ts`; critique B6). `RunFolder.open(projectDir, id)`: `runs/<id>` must be
a real folder (lstat: not a link) whose real path is inside the project's `runs/`. A file is named by the code from
validated parts — at most `<folder>/<file>`, each segment `^[A-Za-z0-9][A-Za-z0-9._-]*$`; the folder a real folder
(lstat) inside the run; the file read by core `readPlainFile` (no link followed, no FIFO held, capped on the
descriptor) and checked once open (review A #7: the runs folder, the run folder and the file's folder are still the
folders resolved — same inode, not a link — and the name still names the file opened): run.json, timeline.json ≤ 32 /
64 MiB, the snapshot ≤ 2 MiB, frame indexes ≤ 32 MiB, screenshots ≤ 16 MiB (`SCREENSHOT_MAX`; was 64), frames ≤ 16 MiB. Frame names in an index must match `^\d{6}\.(jpe?g|png)$` (others are left out); a track's files
`^capture-[A-Za-z0-9._-]+\.mp4$` / `^frames-[A-Za-z0-9._-]+\.jsonl$` (else the step has no picture); screenshot names
are rebuilt from the scene id and step (`<fileSlug(scene)>-<NN>-<action>.png`, `error-<fileSlug(scene)>-<i>.png`; the
action one of the 27) — `RunRecord.screenshots` (absolute paths) is never used. A video goes to ffmpeg as open
descriptors, never a path (review A #7: a path checked then opened by ffmpeg could be swapped for a link):
`RunFolder.openVideo(name, n)` opens it n times (`O_NOFOLLOW`, a regular file, checked once open, the same inode each
time), the child gets them as fds 3…, read as `-protocol_whitelist fd -f mp4 -fd <n> -i fd:`. `RunDataCache` holds 6
runs, keyed by the run folder's real path and the lstat signatures of run.json, timeline.json, scenario.yaml,
screenshots/, frames.jsonl, frames/, capture.mp4 and every page track's files (`frames-<page>.jsonl`, its folder,
`capture-<page>.mp4`; review A #8: a re-written track served stale pictures).

**Which frame** (critique B3). The picture of a capture step is the frame on screen at its end after its hold, T =
`hold.t_end ?? t_end`, on the CFR grid the runner's encoder made (runner-web `cfrSchedule`): output frame n =
min(floor(T·fps), frames − 1), frames = round(duration·fps) (a track: its own fps, the capture's duration). From kept
frames: the latest frame stamped at or before n/fps + 0.5 ms (among those before the end); from the video: an input
seek to (n − ¼)/fps (it returns the first frame at or after the time: frame n). Both give the same picture — the last
step included (its hold ends at the end of the capture, past the last frame's start: the old seek wrote nothing), and a
frame stamped between the tick and T is not shown by either. Multi-page scenes: the track of the page the step acted on
(`ev.page`), else the scene's first page; a scenario made only of multi-page scenes has no main frames (its steps all
use tracks).

**Thumbnails** (engine `runs.thumbs(project, run, keys, {signal})` → `{project, run, thumbs: [{key, mime: image/jpeg,
base64, width, height, from}], missing: [{key, reason}]}`; Studio op `run_thumbs`). 1–24 keys of the run
(`^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.\d{1,4}$`). Sources in order: a failed step's error screenshot; a dry run's step
screenshot; a capture's kept frame; the video. `reason`: `not_reached` (no event, or skipped), `no_step`, `no_picture`,
`unreadable` (a link, a bad image, ffmpeg failed), `too_large`, `budget`, `cancelled`. Review `./thumbs` (sharp and
`child_process` only — never the package root, which pulls the editor and Remotion: 79 ms / 27 MB instead of 354 ms /
88 MB): `thumbJpeg(bytes)` fits inside 480 × 480, never enlarged, JPEG q 75, `limitInputPixels` 100 MP (a
decompression bomb is refused before decoding), `failOn: error`; `videoFramesAt(input, seconds[])` (`input` a path —
file protocol only — or `{fds}`, one descriptor per time — fd protocol only) — ONE ffmpeg process per batch: one
`-ss t -i …` input per time, each frame written as a PNG to its own pipe (after the input descriptors), so a
time that gives no frame is `null` without shifting the others; killed on abort and after 10 s, resolved on `exit`
(pipes dropped). At most 2 ffmpeg processes per engine and 1 per run at a time (its batches queue), sharp work 2 at a
time, each source read inside its sharp slot (review A #2: all 24 sources were read first — 24 hard links of a 60 MiB
PNG took 1.5 GB; now ≤ 2 × 16 MiB held, `stats.sourceBytesPeak` in the test). One answer ≤ `RUN_THUMBS_RESPONSE_MAX` = 2 MiB of base64 (the rest `budget`: ask again), one thumbnail ≤
`THUMB_BASE64_MAX` = 200,000 characters. Cache: memory only, ≤ 32 MiB of base64, keyed by (run folder, the run's file
signatures, the run's key). Nothing is written to disk. Real fixture capture of catalogue (21 steps): 119 ms from kept
frames, 1.19 s from the video, the same pictures (mean difference 2.6–2.8 / 255).

**Events** (critique B1). `scanSources` signs each scenario file on its own (`scenario:<slug>/<name>`: a readdir and a
stat per file, only while a stream is open); the index reads nothing for it. `WorkspaceIndex.reconcile()` →
`{keys, runs, generation}`: `runs` from `runChanges` — the index's rows before and after a `runs:` re-read plus the
run.json signatures the scan watched — `{project, run, scenario, status, finished, change: new | status | progress |
removed}` (the pass after a run appears starts watching its run.json; its first progress is told from then). Without
node:sqlite `Live` keeps the rows in memory and does the same. The `workspace` event carries `scenarios` and `runs`
when there are any. A scenario screen (part 3) re-reads `scenario_blocks` only for its own file, a run of its scenario
that starts or finishes, its picker, or `resync` — never on progress.

**The screen** (part 3; R-UI-08..10, R-UI-13, R-UI-14). Routes `#/p/<slug>/s/<name>` (Blocks) and `…/yaml` (`hrefTo`;
the name is a decoded, capped string the server checks), linked from the project page's scenario list (the sidebar's
scenario list is cut, BL-80). One `scenario_blocks` read per (re)load; the op adds `hints` — core
`ACTION_DESCRIPTIONS` of the actions the file uses (the inspector's edit hints).
- Layout: breadcrumb, name, file, step count, environment with its flags; tabs Blocks / YAML (links). A running run of
  the scenario → a banner "A capture of this scenario is running · n/N steps · current step k of <scene> · action"
  (1-based, critique C5: nothing more) with "Cancel this run" (part 4). Blocks: "Pictures from" (a `<select>` of the view's `runs`: the default = the view's source; running
  / queued runs disabled; "no pictures" said) with the source line (mode, run id, status, when, hooks outcome), the
  `changed` / `cannot_tell` banners, `newer_partial` offered ("Show its pictures"), the run's error in a "From the
  page" box (its "scene x, step i" prefix said "step i+1 of x": `runErrorWords`, review B M2); "Runs from the Studio"
  (the Dry run / Capture buttons and `run_blockers`: "nothing stops it" / "needs the terminal" + message + the `fix`
  command and its `fix_node` form, `user-select: all` — part 4 below); issues (all blocks' issues, with line:col); the
  "showing the first 2,000 steps of N" notice past the cap; the video card (facts, "Notes from the file"); the hooks strip (setup → capture → teardown; kind, name, summary, flags, rollback, `needs_person`, the source
  run's hook outcome); entries in file order — a scene card (heading "Scene n id", skipped / irreversible badges,
  caption, comment, facts: page (inherited said), URL or "continues from", "shown as" display, persona, speed, layout
  (frame, pages side by side), duration (captured s + the scene's outcome in the run), transition, cursor, still,
  tutorial; a multi-page scene's "Pages" (each page id, label, environment page, full URL or "continues from", viewport,
  persona) and its layout in words (`layoutWords`: the scene's frame, else the video's — "2 pages, picture in picture
  (pip) — the video's frame" —, else "chosen at render"; review B M1); note; issues; its steps; filmed scenes numbered
  1, 2, 3… — cards and interstitials are not counted, review B L3), cards and interstitials as narrower dashed blocks
  (component / file, duration or "default duration", slots / text), unknown entries with their issues. The inspector
  is a sticky `aside`.
- Step row: the picture (160 × 90 CSS px box, fixed: no layout shift) or words; the number, the category badge in
  words, the label, the plain target, the summary; chips (`data-chip`); the state in the source run in words ("done",
  "failed in this run", "skipped in this run", "not executed (irreversible)", or the missing reason: "Not reached:
  <why>", "Changed since this run", "New since this run", "Its scene changed / was skipped / is not in this run",
  "Cannot tell: …"), its duration, "matched by position: cannot tell whether it changed" under `cannot_tell`, the issue
  count. Rows are memoised: a selection change re-renders two rows; a picture re-renders its own row
  (useSyncExternalStore on the loader, per key).
- Keyboard (critique B9): one `role="listbox"` per scene (labelled "Steps of scene <id>") of `role="option"` rows
  (`aria-selected`, the listbox's `aria-activedescendant`); only the listbox holding the selection is tabbable (the
  first one before any selection), so the steps are ONE tab stop; Up / Down / Home / End / Page Up / Page Down (10) move
  across scenes (focus follows to the other scene's listbox, the row scrolls into view); a click selects. The option's
  accessible name = "Step n: <label> <target>. <state>"; no live region; the selection survives the YAML tab and
  re-reads (lifted to the screen; a key gone from the file falls back to the first step).
- Inspector (R-UI-14): "Step n of scene id", badge + label, target, summary, the hint, arguments (key / value text;
  non-strings as JSON, capped at 2,000 characters), modifiers with their kind, the comment, "In the file" (file, lines,
  "Show in YAML" → the YAML tab with those lines outlined and scrolled to the centre) and the source slice
  (`text.slice(range.start, range.end)`), "Written as a YAML alias", the edit hint ("Read-only here: change this step in
  <file> (line n), or ask Claude to change it." — editing is L4.3), issues, "In the run" (status, duration, picture
  source, the run's own step when it differs — "step 2 of one in that run", 1-based —, `why`), "From the page" (`untrusted.steps[key]`: target found, error,
  URL).
- YAML tab: one `<li>` per line in an `<ol>` (numbers are list markers: not copied), each line through `Txt`, the
  issues with line:col, the focused lines outlined.
- Pictures (thumbs.ts, Thumb.tsx): one `ThumbLoader` and one IntersectionObserver (rootMargin 200 px) per screen
  (around both tabs). A row whose binding has a picture registers (run id, run key); every 50 ms the visible keys that
  are neither known nor asked go out as `run_thumbs` calls of ≤ 24 keys of one run, ≤ 2 in flight, in the order they
  came on screen. A row leaving the screen aborts every call none of whose rows is still visible (the fetch's signal;
  the server's `res` close aborts ffmpeg); an aborted key is asked again when visible; `budget` / `cancelled` are asked
  again while visible (an answer of nothing but those gives up: `failed`, no loop); other reasons are kept and said in
  words. Entries are keyed by (run id, the run's own key) — never today's key — and ≤ 600 are kept (the oldest off
  screen leave first). An answer is accepted only for keys asked, with integer sizes 1–4096 and a payload
  `jpegDataUrl` accepts; anything else is `unreadable`. `jpegDataUrl(b64)` = `data:image/jpeg;base64,` + b64 when b64
  is a string of 1–200,000 characters, a multiple of 4, `^[A-Za-z0-9+/]+={0,2}$`; else null. `alt` = the step's own
  words + "step n of scene id, at the end of the step in <mode> <run>" (never page text). Attributes and `<option>`
  text cannot hold a `<bdi>`: the row's `aria-label`, the `alt` and the picker's option text show direction controls
  as marks (`visibleControls`; review A #4, #8), the option's status only through the known words. `api.call` takes a signal:
  an aborted call is a CallError `cancelled`, never "offline".
- Events (events.ts `scenarioEventAction`, `useScenarioEvents`): re-read on `resync`, a `workspace` event whose
  `scenarios` holds `<slug>/<name>`, or whose `runs` hold a run of this project and scenario with change new / status
  / removed; a `progress` change → `run_status {project, run_id}` (no `wait_s`), at most one in flight plus one queued;
  a `jobs` event → a `run_status` read of the run shown running, if any (review B M4: a worker that died writes no
  run.json — its job turns interrupted); a `run_status` that says the shown run finished (interrupted included) →
  one re-read; nothing for anything else (other scenarios, projects, READMEs, the index). The window's focus re-reads (useCall),
  as on every screen. Measured in the e2e: 4 progress writes → 0 view reads and ≥ 1 `run_status`; another scenario's
  file and run → 0; the run finishing → 1; the file edited in place → 1.
- Measured (e2e, an Apple-silicon Mac, Chromium headless): 1,200 steps (12 scenes × 100) → the screen with its first pictures in
  ≈ 0.3 s after the route change (bound 5 s), 1 `scenario_blocks`, ≤ 2 `run_thumbs` before any scroll (only s0 keys),
  End → the last row pictured with ≤ 2 more calls (only s11 keys). Real workspace (catalogue capture without frames:
  video path; quote dry run): screen 120–165 ms, first pictures of catalogue 0.8 s from the video.

**Run actions** (part 4; R-UI-15; critique B2, B5, B11).
- Studio op `scenario_run {project, name, mode: dry | capture, env?, hash?}` (ops.ts `runOps`, strict zod: anything
  else — `sandbox`, `until`, `hooks`, `wait_s`, `scenario` — is 400 before a read) → `engine.runs.submit({project,
  scenario: name, mode, env?, expect_sha256: hash})` with no approver. `hash` = the view's: `submitRunJob` hashes the
  text it parsed and checked (no later read of the file) and refuses another one, 409 `conflict` "changed since it was
  shown" (review A #6: what was clicked is what runs; the worker checks the file against the same hash). One submit of
  a scenario at a time in a Studio, and none while a `run` job of it is queued or running: 409 naming the run (review
  B L2: two tabs queued two runs, a capture's hooks ran twice). Then the default hooks (a dry run skips them, a capture runs them), never a sandbox
  reset, never `until`, never a wait; `{run_id, job, state, mode, warnings, worker?}`. `run_cancel` is the MCP tool (any
  run started through a job; the screen offers it only for its scenario's running run). `run_dry` / `run_capture`
  are not in `UI_OPS`. The submit is the authority: what the view showed as a blocker is refused the same way (403
  `needs_approval` / `refused` with the `retake run …` fix), nothing queued, no run id reserved.
- The screen: "Runs from the Studio" holds a Dry run and a Capture button. A mode with blockers is disabled, labelled
  "Capture — needs the terminal" (`aria-describedby` → "why, and the command to type, below": said once, review B L6)
  above its reasons and fix commands (`retake …` and its `node …/bin.js …` form); a file with errors → "Capture — fix
  the file first", no command (review B M6); both are disabled while a run of the scenario is queued or running
  ("waits for the run of this scenario to finish") or a click is in flight. A click sends exactly `{project, name,
  mode, hash}`; success → "Dry run <id> queued: its progress shows above…" and a re-read, then, once the run has ended,
  its outcome (review B H1): "The dry run <id> failed at step 1 of one" / "… cancelled", "It left no picture." and the
  first line of its error from `run_status` in a "From the page" box; a refusal → a danger notice with the server's
  message and fix (a 409 `conflict` also re-reads the view). The running banner's "Cancel this run" → `run_cancel {project, run_id}` → "Cancel asked" (a running run stops
  at its next step; its teardown and rollbacks still run) and a re-read (a queued run is cancelled at once; a worker
  finalises its run.json later, if one runs). Progress, the finish and the new pictures come through the events
  (critique B1: `run_status` on progress, one re-read at start and at the end); the new run becomes the default source
  when it is complete.
- Wording for a Studio user everywhere (critique B2): `agentChannel('ui')` = `studio` reaches the preflight
  (`preflightHooks({via})` → engine `createHookContext({via})` → hooks `HookContext.via`), the worker (`run-job` →
  `executeRun({hookVia})` → runner-web `RunOptions.hookVia` → its agent-trust refusal, `writingHooks({via})`, the hooks'
  context) and the worker's protected-hosts re-check: core `shellAlwaysWrites(via)` ("from the Studio a shell hook
  always counts as writing…"; `SHELL_ALWAYS_WRITES` = the MCP wording), the hooks' approval refusal ("from the Studio,
  "confirm: true" does not count and the Studio cannot approve hooks yet — run it in a terminal"). The rules are the
  same; only the words differ. MCP keeps its wording.
- Step references (part 4): every step a person reads is 1-based — the rows, the inspector ("Step 3 of scene
  proposal"), the banner ("current step 3 of proposal"), `partial` and `why` ("failed at step 3 of proposal"), the
  inspector's "step 2 of one in that run" (`keyWords(run_key)`); a run's own keys (`proposal.2`) stay internal (thumbnail
  requests, `data-key`). MCP summaries keep `scene.step` (Claude's references).
- The worker (critique B5): `retake ui` sets its own PATH with core `clientPath` (absolute entries only, none a package
  manager added — `node_modules/.bin`, corepack —, none inside the workspace; the node first, Homebrew / system folders
  completed), so the thumbnails' ffmpeg is never a program in the workspace. The engine takes `workerEnv` /
  `workerSpawn` (tests) and passes them, with `startedBy: client`, to `ensureWorker` → `spawnWorker(root, {env,
  startedBy, spawn})` → `worker-main --started-by <client>` → the worker lock's `started_by` (`^[a-z]{1,16}$`, checked
  when written and when read; a handover passes it on). Every client but the CLI starts its worker with engine
  `cleanWorkerEnv(env, root)` (review A #3: a worker an MCP client started inherited Claude Code's environment and
  served the Studio's later jobs; the Studio's `studioWorkerEnv` is the same cleaner): no `npm_*` / `pnpm_*` /
  `INIT_CWD` / `COREPACK_*` / npm tokens (a package manager's; `npm_config_*` can carry a registry token), no
  `RETAKE_MCP_TOKEN`, no model or agent credential (`ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `AZURE_OPENAI_*`,
  `AWS_BEARER_TOKEN_BEDROCK`, Gemini / Google AI, Mistral, Cohere, Groq, xAI, DeepSeek, OpenRouter, … keys, Hugging Face
  tokens; review B L5) nor code-host tokens (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`), nothing that loads code from the
  workspace (`NODE_OPTIONS` naming a file to load — `-r`, `--require`, `--import`, `--loader`, `--env-file`… —; `NODE_PATH`,
  `DYLD_*`, `LD_PRELOAD`, `LD_LIBRARY_PATH` with a relative entry or one inside the workspace), PATH =
  `clientPath(node, PATH, exists, root)` (the workspace under any spelling: `realpathSync.native`, and without case
  where the system ignores it), RETAKE_HOME made absolute — never more than `retake worker` typed in the same
  terminal needs; sign-in secrets read through `{{env:…}}` stay. A worker lock without its start time names a pid that
  cannot be told from any other: it counts as alive only where `ps` cannot tell that pid's start either (review A #7:
  a lock forged with the Studio's own pid kept every worker off). One worker serves the workspace: a job runs in
  the environment of whichever client started the worker (`retake jobs`, `retake doctor`, `engine_info` and the
  Studio's sidebar say "started by …"). The worker exits after 60 s idle (`RETAKE_WORKER_IDLE_MS`;
  `workerIdleExitMs` for tests); the Studio never kills it (a capture finishes with its teardown after the Studio
  stops).
- Tests: scenario-run.test.ts (pinned arguments → 400, nothing queued or reserved; quote's capture → 403 equal to the
  view's blocker, Studio wording, the fix; a dry run queued `submitted_by: ui`, no hooks / until / sandbox, cancelled;
  a read-only environment's shell hook refused "from the Studio"; `studioWorkerEnv`; the spawn injected: the command,
  `--started-by ui`, the env; a real worker: `started_by: ui`, its live environment read with `ps -E`, every worker
  started exits once idle); studio-e2e-scenario.test.ts "run actions" (Chromium: blocked Capture disabled with its
  command, no request; Dry run → exactly `{project, name, mode}`; the queued banner; Cancel → `run_cancel`; the
  cancelled run in the picker); cli ui.test.ts (an `ffmpeg` in `<ws>/bin` and `<ws>/node_modules/.bin` never runs:
  the thumbnails use the real one); hooks trust.test.ts (Studio wording); jobs.test.ts (`started_by` written / read
  checked); test:slow scenario-run-acceptance.test.ts (the fixture on free ports, the real worker: highlights' Dry run
  → progress → its pictures; a running dry run cancelled; the worker killed by pid at the end).

## 4e. Scenario editing (L4.3)

R-UI-11 / R-UI-12. Built in four parts: the write path and the editable YAML tab; the step structure edits (move,
delete, duplicate), drag & drop, the keyboard path and undo / redo; value edits through the inspector's form and new
steps from a palette — all on the same write path (the lot's plan and critique, B1–B11, apply here); then the
acceptance on the fixture from the built `retake ui` (end of this section). Cut to BL-95: scenes, forms beyond scalars
and a flat target, YAML saves in the undo history.

**Write lock** (critique B1). Storage `writeText` with an `if_match` hash holds `<project>/.retake/locks/
write-<sha256 of the target's real project path, 24 hex>.lock` (engine `project-lock.ts` `takeProjectLock`: the L3.6
TakeLock — created whole, stale only when its process is gone; busy retried every 20 ms for ≤ 3 s, then `busy`) from
the first hash check to the rename, so two writers of one version — one process or several (`retake ui` beside
`retake mcp`) — give exactly one success and one `conflict` (before: 221 of 300 concurrent pairs both "succeeded"). A
write through a link and one to its target share the lock. It covers every if_match write: the Studio, MCP
`scenario_save`, `project_update_readme`, comment threads (inside their own lock). Comments' `lockThread` uses the same
helper. TakeLock's liveness check answers for its own process without `ps`.

**Mode kept** (critique B11). The temp file of a replace is created 0600 and `chmod`ed to the replaced file's mode
(`lstat` of the target, through an inside link the target's) — never through writeFile's `mode` (masked by the umask:
0664 became 0644). A new file takes the umask's default.

**The op** — `scenario_edit {project, name, hash, edit}` (ui `editOps`, strict zod: `edit` is
`{kind: 'replace_text', text}` | `{kind: 'restore', text, text_hash}` | `{kind: 'move_step', from: StepAt, to: {scene,
index}}` | `{kind: 'delete_step', at: StepAt}` | `{kind: 'duplicate_step', at: StepAt}` with `StepAt = {scene (a slug),
index (0..100,000), guard (16 hex)}` | `{kind: 'set_step', at: StepAt, changes: [{path, from?, to?}] (1–40)}` |
`{kind: 'insert_step', to: {scene, index}, after: guard | null, action (a palette action), values: {key: value} (≤ 40)}`
with `path` 1–3 segments `[a-z][a-z_]*`, a value a string ≤ 10,000 characters, a finite number or a boolean (never an
object, a list or null), text ≤ 500,000 characters, hashes 64 hex; any other key or kind is 400 before a
read), edits of one file one at a time in a Studio server (`oneAtATime`), →
engine `scenarios.edit(project, name, {hash, edit})` (scenarios.ts `editScenario`) with agent trust and channel
`studio` for the `ui` client → `{name, file, path, hash, label, select, warnings, notices, change?}` (`select`: the step to
select after a step edit; `change`: a block edit's kind under L5.5's rule — `filmed` when core `filmedChangesOf` finds a
filmed part changed (an argument, a hold, a new / moved / deleted step: a dry run shows it, a capture films it), `edit`
for a caption, speed or mark alone (a render of the same run re-plans it)). Steps:
1. The file the view read: `scenarios/<name>.yaml`, else an existing `.yml` — written in place, never created
   (`not_found`).
2. `hash` ≠ the file's sha256 → 409 `conflict`, `details.current`.
3. The file itself blocked (`scenarioEditBlocker`) → 403 `refused` with `details.problems [{line, message}]`: not
   UTF-8 (getScenario now keeps `utf8`: a save would replace bytes with U+FFFD), over SCENARIO_EDIT_MAX_CHARS
   (500,000), holding a carriage return without a line feed (review A M2: an editor — the tab's textarea included —
   shows a line break where YAML reads none, so the file's text and what it runs differ; the tab's draft turns only CR
   LF into LF, `crlfToLf`), or — agent clients — a symbolic link to a file of the project outside `scenarios/`
   (`ScenarioText.linked_to`, review A L1: never written through into a hook script; MCP `scenario_save` refuses it
   too) or holding what core agent trust refuses (a secret reference, a file out of the project, code in an
   agent-writable file, a template folder: critique B3, the YAML tab read-only, never "delete your sign-in line to
   save"). A name spelt with another case than the file (`QUOTE` for `quote.yaml` on a case-insensitive disk) is not
   found (review A M1: getScenario, `scenario_save` a conflict), and the write lock is keyed on the existing file's
   real path as the disk spells it: one file, one name, one lock.
4. The new text: `replace_text` adds a final line break (the text's own, CR LF when it mostly uses CR LF) when
   missing; `restore` writes the bytes as given and refuses a text whose sha256 is not `text_hash` (critique B5:
   undo / redo byte-exact, a file without a final line break included) or that is not a version of that file this
   process showed (getScenario) or wrote (review A L3: `knownScenarioVersion`, at most 128 hashes per file and 256
   files, in memory) — a page cannot restore a text it made up; a step edit is spliced by core
   `applyStepEdit` (below) and refused (403) unless `verifyEditText` finds the re-parsed text equal to the intended
   value — a step no longer where the edit names it (its guard) is a 409 with `details.stale` (no "apply again"). ≤
   500,000 characters.
5. Hidden characters (critique B9, review A L2 / M2, core `newHiddenCharProblem`): controls (`\p{Cc}`) but tab, LF and
   a CR LF's CR — a carriage return without a line feed is one —, format characters (`\p{Cf}`: direction controls,
   zero-width, soft hyphen, U+FEFF past offset 0, interlinear annotations, tags), U+2028 / U+2029, every
   `\p{Default_Ignorable_Code_Point}` (variation selectors, combining grapheme joiner, Khmer inherent vowels, Mongolian
   separators, Hangul fillers) and the braille blank — a text with one on a line the file does not have word for word
   (a new one, or one moved from a comment into a value), or with more of one than the file did (a copied line), is
   refused (400) naming the character, its line and column; a ZWJ between two pictographs and U+FE0E / U+FE0F after an
   emoji character are emoji sequences. A restored version (step 4) is not checked: it was on disk. `editValueProblem`
   is the stricter rule for single form values (part 3), and a form field holding one is locked (`stepFormValues`).
6. Hooks unchanged (critique B3, review A H1, agent clients): core `changedHookSections` compares `setup`, `teardown`,
   `mocks` of the base and the new value by canonical JSON (an absent section = an empty one; an unparseable base: any
   section counts as changed) → 403 "setup changed: hooks and mocks run on this Mac, so the Studio saves a scenario
   only with them unchanged — edit them in your editor"; while the base has any hook or mock, `changedHookInputs` holds
   its `vars` (templated into a shell line, a SQL text, an HTTP body) and `env` (where the hooks run) the same way →
   403 "vars changed: this scenario has hooks or mocks, which read its vars and its environment and run on this Mac, so
   the Studio saves it only with vars and env unchanged — change them in your editor" (`details.sections`). `restore`
   is held to both.
7. Validated against the project and its template, plus agent-trust issues placed at their lines
   (`agentTrustProblemsAt`, critique B11: one issue per string holding a secret reference, a file reference at the
   string naming it, a template folder at `template`) worded "from the Studio": errors → ScenarioError (400, issues
   with line / col in `details.issues`), nothing written; warnings come back. The new text is checked `confined` to
   the channel (review A L4, also `scenarios.validate` / `save` for agent clients): a file reference outside the
   project is "resolves outside the project folder" without a stat, one leading out through a link "not found" — the
   answer never tells whether a file exists outside the project (a person at a terminal still gets "not found").
8. `writeText(file, text, {ifMatch: hash})`: atomic, under the write lock, mode kept. Core's own writers (`saveScenario`,
   `writeTextAtomic`: a new project's files, scaffolds) take no lock — core cannot take the engine's project lock —
   and write without `if_match` (review A note; BL-96).
`verifyEditText(text, intended)` (core) is the verify of edits built from a value (parts 2–3): the text re-parsed with
core `parseYaml` — a bare parseDocument misses an alias before its anchor — must deep-equal the intended value.
`scenarios.validate` / `save` now pass the client's channel as well (they said "through MCP" to the Studio).

**Step edits** (part 2; core `step-edits.ts`, pure). `applyStepEdit(text, edit) → {text, intended, label, select,
notices}` or `StepEditError {code: stale | not_editable | invalid}`; text splices of the original (whole lines), never a
re-serialisation — every byte outside the touched lines is the original's:
- A step's span: its dash line (the `- ` must open the line: the item's value range read back over spaces, and over
  an anchor, a tag or a comment between the dash and the value — review B L4: `- &s` then the keys; a dash item not
  written plainly, `- &a<tab>{…}`, locks its scene's steps with why: `stepsDashWhy`, since an edit of a step needs its
  neighbours' spans) to the end of its last content line (an inline comment included); plus the comment lines it owns (critique B6, by column): the
  contiguous `#` lines just above at the dash's own column, not past the previous item's last content line nor the
  `steps:` line, and the contiguous `#` lines just after it deeper than the dash (a commented-out modifier). Any other
  comment (a column-0 section header) and blank lines stay put; a `#` line inside a block scalar is part of the scalar
  (inside the node's range).
- Move: the span removed, re-inserted before the target item's span (or after the last item's), re-indented by the
  dash-column difference (a line less indented than its dash → refused). `to.index` is the final index (in its own
  scene counted without it; the same place → `invalid`). The only step moved out or deleted leaves ` []` after the
  `steps:` colon; into `steps: []` the flow `[]` is cut (what follows on its line — an inline comment — kept) and a
  block list written under the key at the source's indentation relative to its own key.
- Delete: the span removed (notice "Its comment lines went with it." when it owned some). Duplicate (critique B8): the
  step's own lines (not its comments — nor a comment line after its last value that the node's range takes in: the
  copy ends at its last scalar or flow collection) after its span, without `id` (ids are unique) and `mark` (one moment), and a
  capture's `as` (capture_text, download, wait_for_email) suffixed with the first free `-2`, `-3`… (inserted before
  the closing quote of a quoted value); each a notice. A step defining an anchor is not duplicated (the anchor would be
  defined twice).
- Final line break state kept (a block appended after a last line without one gets the break first; a removal
  leaving one where the file had none drops it); the file's line break (CR LF kept); a BOM stays.
- Refused (`not_editable`, with why, also on the view): a step or scene or `steps` written as an alias, a non-empty
  flow list of steps, a file that is not valid YAML. An anchor moved after its alias, a keep-chomped scalar losing a
  trailing blank line, anything unforeseen: the verify refuses it.
- Guard (critique B2): `stepGuard(raw)` = sha256 of the step's canonical JSON as written (modifiers included: a caption
  change changes it; fingerprints leave modifiers out), 16 hex. Every addressed step must have it, so an edit re-sent on
  a newer version applies only if that place still holds that very step.
Goldens: every step of the fixture's scenarios moved to every place in its scene and to the start / end of every
other scene, deleted and duplicated — value exact, every line kept, moves reversible to the byte (2,368 edits on 13
files). Outside the goldens a move back by hand gives the same value but not always the same bytes (review B fuzz:
about 2 % — a blank line or a column-0 comment does not travel with a step, `steps: [ ]` comes back as `steps: []`);
undo is byte-exact (`restore`).

**Forms** (part 3; core `step-forms.ts`, pure). `stepForms()` → `{actions: ActionForm[], modifiers, palette}` derived
once from `z.toJSONSchema(ACTION_ARG_SCHEMAS[a])` (the conversion of the published schema): an object branch's
properties become fields `{key (dotted path from the step: "type.into.label"), label, kind: text | number | integer |
boolean | enum, required?, options?, min? / exclusive_min? / max?, min_length?, pattern?, description?, group?}`; a
property that is a TargetSpec (by its `$defs` name) becomes a group of flat target fields (text, role, name, label,
aria, placeholder, css, testid, `in` — the ScopeSpec keywords —, nth, exact), a click / hover's own target keys too;
a union takes its first plain scalar branch (`scroll.to` a number); lists, points, nested targets, `contains`,
`last_visible`, `in` as a row → `yaml_only` (critique C2). Modifiers: caption.text / caption.kicker (group `caption`),
hold, speed, mark. `eval`, `emit`, `cursor` take no form. Palette (critique C3, `PALETTE_ACTIONS`): open, click,
double click, hover, type, press, select, wait, wait for, hold, screenshot, scroll, menu, date, notify; `defaults`: a
required number 1 (or its minimum), a required text empty. `stepFormValues(raw)` → `{action, values, locked, yaml_only}`:
each field read in object form (a shorthand reads as the field it means — normalizeStep for the action, normalizeTarget
for a target, `{text}` for a caption); a value of the wrong kind or a non-scalar → `locked` with why, a URL with
`user@` → locked ("sign-in details"), never in `values`; on each `StepBlock` as `form`.

**Value edits** (part 3; core `step-edits.ts` `set_step` / `insert_step`, critique B2 / B4). Each change must name a
form field of the step's action (else `invalid`), not a locked one, with a value of its kind and — strings — no hidden
character, line break or more than 10,000 characters (`editValueProblem`, critique B9; refused naming the field:
`StepEditError.field` → `details.field`); `from` must deep-equal what the step holds there now (else `stale` naming the
field and its value now: a field changed meanwhile is never reverted; the step's guard still names the step). Each
change becomes one raw operation, applied to the text one by one, each re-parsed and checked against the whole file's
intended value: `scalar` — yaml's `CST.setScalarValue` on the node's source token (its quoting and comments kept),
again as `QUOTE_DOUBLE` (a number / yes-no: `PLAIN`) when the re-parse differs (`123`, `yes`, `a, b` in a flow map);
`replace` — a shorthand that must become an object, a flow map rendered by yaml in its place; `add` — `, key: value`
after a flow map's last pair, or one `key: value` line after a block map's last line at its key column (the file's
line break); `remove` — the pair with its comment lines (pairRemoval), a target or caption left empty going with it,
the action's last value refused; in a flow map, refused (`not_editable`) when what lies between the tokens — a scalar
value's own characters left out — holds a comment or a line break (review B M3: the comment belongs to a key that
stays). A shorthand is kept when the new object still reads as that one field and the
schema takes the scalar (`shorthandOf`: never `type: x`); then the step's form values must equal the shown ones with
the changes (a text that looks like CSS is written `{text: "#x"}`, never as a shorthand that would read as css). A
file without a final line break keeps it so. `insert_step`: `newStepValue(action, values)` (palette actions, known
fields, kinds, B9, required ones) in field order, one-value targets and the action as their shorthand when that reads
the same; rendered by yaml as `- action: <flow>` when ≤ 120 characters, else a block; inserted with the move's
insertion (indentation, `steps: []`, CR LF); `after` must be the guard of the step before that place (null at 0), else
`stale`. Goldens: every value field of every fixture step given a new value — exactly its own line changes (its node's
line in the original); one removal and one added modifier per step; palette steps at the start, middle and end of
every scene (one line); fixture steps → form values → `newStepValue` → the same arguments; a hostile corpus of 29
YAML-syntax values on four kinds of scalar, an added key and a new step (values stay values, one line each).

**The form and the palette** (ui `StepForm.tsx`, `forms.ts` pure and unit-tested; `scenario_forms` read once per page).
The inspector shows the selected step's form under its edit buttons (editing on, the step not locked): its fields
(target groups folded while empty, the modifiers after the action's own fields — a hold step's seconds first; the empty
optional fields of each part folded under "More: clear, enter" — a set target's other keys under "Other ways to find
it (n)" —, decided by the file's values so a field never moves while it is typed in; `click: {aria: Increase, in:
dialog}` shows 4 of its 23 fields until a fold is opened), locked fields read-only with why, "Also in this step, edited
in the YAML tab: …"; each input checked with its field's rules before sending (a number and its bounds, a whole number,
a pattern, one line, its options; a group's required field only once the group has a value; `aria-invalid` + the
error under the field); **Save** sends `set_step` with the fields whose input differs from what it showed only (each
with the value shown — review B M2: an untouched `""` read as not set was a removal; an empty input of a text field
that holds `""` and allows it reads as `""`, so `type: {text: "", clear: true}` needs no value); a server refusal shows
at its field (`details.field`, or an issue's path inside the step: `issueField`). The form resets when the step
changes on disk (its guard), saying so and listing what was typed (`form-dropped`) when it held changes. **Add a step…** opens the palette: the 15
actions, the chosen one's form with its defaults, **Where** (after the selected step, the start / end of each scene),
**Add** → `insert_step`. After a form's save the live region adds the change's kind ("What the browser does changed: a
dry run shows it, a capture films it." / "Only the edit changed: a render of the last capture shows it, no new capture
needed."). "Apply it to the new version" after a 409 (forms.ts `editAgain`): a form's changes go to the same step found
again by its fingerprint and which of the scene's steps with it — only while the scene has as many steps with that
fingerprint as before (review A L5: a fingerprint leaves modifiers out, so a deleted twin made the nth the next one) —
(its new guard; the server applies each change only while that field holds what the form showed), a new step after the
same step by its guard; moves as before. Off, with why (`edit-conflict-off`), when the new version turns block
editing off (review B L9).

**Blocks** (core blocks.ts, part 2): `StepBlock.guard`, `StepBlock.locked` (why: an alias, a flow list), and
`SceneBlock.steps_locked`. **Moved** (core `movedSteps`, scenario-view): in each scene, the bound steps whose run index
is not in the longest increasing subsequence of the scene's run indexes (today's order) get `moved: true` — the picture
stays, the row says "moved since this run" and the inspector "the picture shows it at its old place".

**The Blocks tab** (ui `StepEditing.tsx` `useStepEditor` + `EditBar`, `step-edit.ts` pure — `keyboardMove`,
`dropMove`, `EditHistory`, unit-tested; ScenarioScreen.tsx): each edit is `scenario_edit` on the shown hash, then a
re-read (non-optimistic). Input lock (critique B7): from the send until the view with the edit's hash lands, `busy` —
rows not draggable, keys and buttons ignored, `aria-busy` on the blocks — and a held key (`repeat`) never edits.
Editing off (no grip, nothing sent, the reason in the bar) while the YAML draft holds unsaved text or when
`edit.blocks` is not ok. Native HTML5 DnD (no library): a grip (`aria-hidden`) on draggable rows; `dragstart` sets
only `application/x-retake-step` (never read on drop); the drag state lives in the document (critique B11): rows
and the empty scene's zone accept a drag only when a drag started here, the insertion line by the pointer's half; a
window listener cancels any other dragover / drop with `dropEffect = 'none'` (a file from the Finder never opens in
place of the page). Keyboard: Alt+↑ / Alt+↓ (one place; past the scene's edge to the end / start of the previous /
next scene that takes steps, cards skipped), Delete / Backspace; the listbox's `aria-describedby` names them; the
inspector has Move up / Move down / Duplicate / Delete. One polite status region ("Moved step 3 of request to position
1. Saved." + notices + warnings count; "Undone: …"; Alt+↑ on the first step / Alt+↓ on the last: "Step 1 of a is
already the first step: it cannot move up.", review B L6); refusals in an alert with their issues. While a drag is on,
a dragover that reaches the window (not a row or the empty scene's zone: they stop it) clears the insertion line
(review B L5). Undo / redo: ⌘Z / Ctrl+Z,
Shift+⌘Z / Ctrl+Y outside fields and buttons naming the edit; `restore` of the text before on the edit's hash (redo:
the text after on the hash before), ≤ 50 entries / 16 MiB; a view with a hash this screen did not make clears the
history with a notice (a YAML save from the same screen included, in its own words: "Saved from the YAML tab: the undo
history of block edits was cleared.", review B L7). The bar's "Editing the blocks is off (moves, copies, deletes, forms
and new steps): <why>". After an edit its view selects the moved step,
the copy or the delete's neighbour — once: the same version read again (a file event, a run ending) never takes the
selection back from a step picked since. A 409 → "Your edit (…) was not applied" with
**Apply it to the new version** (the same op on the re-read view's hash: the guard decides) and **Leave it**; a stale
answer is an error, never offered again.

**The view's `edit`** — `{yaml: EditAbility, blocks: EditAbility}`, `EditAbility = {ok: true} | {ok: false, why,
problems?}`: `yaml` from `scenarioEditBlocker` (computed in the text layer for agent clients); `blocks` also refused for
a file that does not parse, has errors, or is shown truncated (2,000 steps). Said before any edit.

**The YAML tab** (ui `YamlTab.tsx`; `TextEditing.tsx` holds the README editor's `DiskBanner`, `TextConflict`,
`KeptText`): `edit.yaml` not ok → a warning with the why and each problem's line, the read-only YamlView, any unsaved
text to copy; else the read-only view with **Edit**, which opens the editor (also directly when a draft exists). The
editor: a textarea (LF text; the file's EOL from `detectEol` restored on save, a final line break added; maxLength and
counter at 500,000), Save / ⌘S / Ctrl+S → `scenario_edit replace_text` with the base hash, Discard, Close (only
without changes); live issues from `scenario_validate` 400 ms after the last keystroke, one call in flight; a save
refused with issues lists them with their lines ("1 error in this text: nothing was written, your text is kept");
409 → `scenario_blocks` read → the conflict panel ("Save mine over it" with the shown version's hash). The view's
re-reads (workspace events, focus) drive "changed on disk": no unsaved text → loaded and announced; unsaved → the
banner; a view still showing a version this tab replaced is ignored (the set of superseded hashes). Lines of the
draft holding a hidden character are listed. Drafts (drafts.ts) are keyed `readme:<slug>` / `scenario:<slug>/<name>`;
the session-ended page names each. While the scenario's draft holds unsaved text the Blocks tab says block editing is
off (critique B7). The app builds no YAML: no `yaml` import, only type imports from `@retake/*` (source lint).

**Acceptance** (part 4): the built `retake ui` on a scratch copy of the fixture workspace, its own fixture on free
ports, headless Chromium, on `quote`: the type step's text and speed (one save, one line), a caption (one line), a
drag & drop, an Alt+↓, a Duplicate, a Delete and a palette `hold` — each save diffed against the version before
(exactly the intended lines: −1/+1, −1/+1, −1/+1, −1/+1, +1, −1, +1); a Dry run of the edited file from the screen (the
setup's effect armed by hand: a Studio dry run skips hooks) ran 26 / 26 steps with the new text, the run's
scenario.yaml the edited bytes, and its pictures shown; seven undos → `cmp` identical with the original; a YAML tab
save (two lines changed, the blocks showing it, the undo history cleared) reverted in the YAML tab → `cmp` identical.
Safari / Firefox drag & drop are checked by hand (MACOS-CHECKLIST 13c).

## 4f. Run screen (L4.4)

R-UI-16…19, R-AUTH-10: watch a dry run or a capture from the Studio as it happens. Built in parts (the lot's plan and
critique, B1–B16, apply here): **A — runner and engine (built)**; **B — the Studio server's `/v1/live` relay and ops
(built)**; **C — the Run screen and the Sessions panel (built)**; **D — the capture pause (built, on L5.7)**; **E — the
acceptance on the fixture and the picture's CPU measured on a capture (done; "Acceptance and cost" below)**.

**Progress events** (core `RunProgress`). `outline` once the run's secrets are resolved (review A: a value written as is
in a step is masked there as in `step_start`; before the browser opens, before any `scene_start`): every step the run executes
(`until` and skipped scenes honoured, `{scene, step, action, desc}` with `desc` described from a redacted copy as
`step_start`'s) — the step list comes from the run, never from re-reading the scenario. `session` per persona from the
preflight (runner `auth.ts` `onPersona`, before any setup hook): `valid` | `unchecked` | `none` (the single-account
form starts signed out) | `signed_in_auto` | `failed`, `detail` page text (untrusted). `pause`: `paused` / `resumed`
(`ms`; `paused` carries `max_ms`, the limit the screen says) before step `scene.step` (`refused` with a `reason` stays in
the type for runs of parts A–C, which refused to pause a capture; nothing emits it now). Like every progress event they are redacted and
written to `log.jsonl`; the CLI prints `session` with `--verbose` and the pauses.

**Live picture** (runner `live-preview.ts`, `RunOptions.live: LiveSink {wanted, onWanted, frame}`). Its own CDP
session on the page the run acts on (`rt.page`, looked at every 250 ms: a page switch, a new tab, a multi-page scene's
acting page) — never the recorder's session, never `Emulation.*` — so a dry run (no recorder) has it and a capture's
frames are untouched (probe: no recorder gap ≥ 150 ms, no wrong-size frame with it). `Page.startScreencast {jpeg,
quality 60, maxWidth min(960, viewport), everyNthFrame: 1}`, acked at once; at most LIVE_FPS_MAX = 10 frames a second
are handed on, latest-only with a trailing edge (the newest frame of a burst always follows within 100 ms): with a
stride of 6 a page that changes once and goes still never sent its final picture (7 of 8 lost). Costs ≈ +21 %
Chromium CPU on a full-motion page while attached (probe), +15.6 % on a real capture (part E, below), hence: no CDP session at all unless the sink is wanted (someone
watches), and on camera only — `start()` right after capture time 0, `stop()` first thing in `finally` (before the
effect check, the recorders, the session diagnosis, the teardown, the artefacts). In between it shows what the acting
page shows — an `offscreen` scene and a `hook:` step's still page included (played live, cut by the edit; nothing needs
to suspend it: review). What watching cost is counted (`watched()`: the seconds a screencast ran, the frames handed
on): a capture filmed while someone watched records `perf.live_preview {seconds, frames_sent}` and warns "the live
picture was watched for … s of the take (n frames sent): Chromium encoded it on top of the capture" (review A L4). The
preflight's sign-in tab, hook pages and the artefacts' browser are never `rt.page`. A frame right after a navigation can be cropped (e.g. 800×461 of 800×600): the
picture's header carries its size. Frames live in memory only.

**Live channel** (engine `jobs/live-channel.ts`; the worker for every `run` job). The claiming worker opens a loopback
listener (`listenLoopback`: 127.0.0.1, a free port) behind `checkRequest` with `refuseBrowsers` (Host its own
`127.0.0.1:<port>` / `localhost:<port>`, any Origin or Sec-Fetch-* header but a lone `Sec-Fetch-Mode: cors` → 403, a
fresh 32-byte bearer token in constant time → 401), one route `GET /v1/frames` (404 / 405 otherwise), at most
LIVE_STREAMS_MAX = 2 streams (503 `too_many_streams`) and 8 sockets — a socket holding no stream is closed after
LIVE_IDLE_MS = 2 s, and when all 8 are taken the oldest without a stream makes room for the newcomer (review A L3: 8
idle connections locked the Studio out; a stream is never dropped for a newcomer). `<job>/live.json` `{v: 1, port, token, job, run,
pid, started_at}` is created 0600 from the start (a `wx` 0600 temp file, chmod, rename) and removed when the job ends;
`readLiveChannel` trusts it only as a private regular file of this user (opened `O_NOFOLLOW` and checked on the open
descriptor — `readPlainRange` —: no link, no group / other bit, ≤ 4 KiB) naming
this job and the identity of the worker that holds the job's claim, alive (pid and start time) — a stale file of a
killed worker gives no picture. Wire format: a binary stream of records `u32 header length · JSON header {v: 1, kind:
'frame', seq, page?, w, h, at} · u32 byte length · JPEG`; `kind` / `v` leave room for an input channel (BL-25 / BL-73:
a separate authenticated route, not built). Backpressure latest-only per stream: a record is written only when the
socket needs no drain, else it replaces the one waiting record (a reader that never reads: ≤ one record beyond Node's
16 KiB buffer). One frame cache, the latest record, sent at once to a new stream (a still page sends nothing new),
dropped when the job ends. `openLiveFeed` (the Studio server's upstream, part B) checks every record (header ≤ 4 KiB
with its fields, JPEG `FF D8 FF`, ≤ 512 KiB, w / h ≤ 4096) and ends on anything else. Nothing writes, logs or indexes a
frame: a test scans every file of the run, `.retake`, the Retake home and the worker's TMPDIR for the frames'
bytes, whole, inside a file or in base64.

**Pause** (runner `pause.ts`, dry runs and captures). Between steps only: at the top of `runStep` once the page is loaded
(`awaitShownLoaded`) and signed in (`assertSignedIn`), before a late popup's settle and `step_start` (critique B4);
never inside a step, never in hooks, teardown or encoding; a pause asked during setup or the last step takes effect at
the next step, or not at all. While `PauseGate.requested` the run waits (polled every 100 ms): run.json `paused: {scene,
step, since}`, then `pauses: [{scene, step, at, ms}]` and `paused` removed (also after a cancel); `assertSignedIn`
again after it. A cancel or the sign-in guard ends the wait at once through the run's combined signal (teardown and
rollbacks as for any cancel). A pause longer than `PauseGate.maxMs` (default 30 min; the worker reads
`RETAKE_PAUSE_MAX_MIN`, minutes (0, 1440]) stops the run: cancelled, "paused longer than … the run was stopped (its
teardown and rollbacks still run)". The capture clock pauses with the run (a dry run's timeline too); the pause lands
in `timeline.pauses: [{t, ms, scene, step}]` (`t` the capture time it stopped at, `ms` the wall ms left out).

*A capture does not film the pause* (part D, critique B1 / B3 / B4 / B5). In order: the last click's effect check
ends (`settleEffectChecks`) and the run waits until RIPPLE_S + 0.1 s after the last press or ripple of any cursor (the
ripple is never cut); the clock pauses at the wall time read then and, in the same tick, every recorder filming now —
the main capture and each page track of a multi-page scene (`recordingPage` set) — stops taking frames (`pause()`
drops its session at once, then stops the screencast; the press-kick timer ends with it); the take's CPU sampler then
takes a sample and stops counting (review B L10: the recorders used to stop first and the clock after, filming ≈ 0.1 s
of frameless hold per pause). Capture time stands still: the encoders fed during the take
(their 100 ms ticks follow `horizon()` = `clock.now()` − 0.5 s) write no tick for it, a frame painted meanwhile would
land at the pause instant, the motion / stall / busy checks see one continuous take. On resume each recorder
re-attaches to its page (`switchTo`; ≤ ≈ 300 ms with the attach check) and the clock's pause closes at the paint time
of the first fresh frame of any of them (`waitFrameAfter(resumeWall)`, at most RESUME_FRAME_MS = 1 s, then at that
time): that frame lands exactly at the pause instant — no frameless gap, no false freeze (B3); measured on an animated
board (the test's own, 60 Hz; two takes): the last frame 15–20 ms before the instant, one frame at it, the next
13–14 ms after. The ripple settle before the pause is filmed: a take paused right after a click is the same take
unpaused plus that settle — measured after the review fix on three pairs (2.55–2.65 s pauses): the capture-time span
between the step before and the step after the pause 0.54–0.56 s against 0 s unpaused, the wall time of the take less
its capture time equal to the pause's length to 0–1 ms (nothing of the pause filmed); the whole videos 0.33–0.73 s
longer (that settle, plus two takes' variance). One length for a pause everywhere: run.json `pauses[].ms`, the
`resumed` event, the log and `timeline.pauses[].ms` are the time capture time stood still (from the pause to the first
fresh frame). Then the sampler goes on,
leaving out the CPU every process used meanwhile, the pause's seconds and the unfilmed time of each browser (`perf.cpu`
and `perf.seconds` = the capture duration). A stop or the time limit while paused closes the clock's pause at once
(no re-attach; the take is discarded as any cancelled one). The page keeps running during the pause — timers,
animations, a running product clock (L1.7, re-anchoring it was left out): what it shows after the resume is what it
shows, a jump at that point when it changed; the run says so in a warning ("paused once (2.5 s, not filmed): the video
goes on where it paused — …"). A held page load before or after the pause keeps its place on the frames (B1); a pause
never splits a load (it comes after `awaitShownLoaded`, B4).

The control path: engine `runs.pause(project, run_id, paused)` → the job's `pause` marker (a client creates it, removes
it to resume; the worker only reads it, polled with the cancel marker every 250 ms) → the gate. `runs.pause` refuses a
run of the CLI (`refused`) and a queued, stopping or finished run (`conflict`), and writes no marker then; a capture is
no exception (parts A–C refused it); resuming always removes the marker. Run views carry `paused` / `pauses`, a running job `pause_requested_at`, its progress `paused`
(job long-polls wake on it), MCP run_status a line.

**Sessions** (engine `auth.forScenario(project, scenario, {env?, mode?})`, `auth.ts` `scenarioPersonaStates`): the
personas a run of the scenario signs in (core `planPersonas`, hooks' tabs counted for a capture), each with its stored
state (no browser), `auto` — every run's preflight signs it in off camera: it has `login:` steps **and** each
`{{env:…}}` they use is set in the environment of the worker this client starts (EngineOptions.workerEnv, else
cleanWorkerEnv of the process for a client other than the CLI; review B M3) — `login_env_missing` (names, never a
value; with an `issues` line), `login_keychain` (keychain items counted, never looked up: no prompt, no value read —
taken as there), `has_check` (review A M2: the preflight checks it before filming), never a profile or snapshot path,
the last check's `detail` / `at` under `untrusted`. The worker that runs the job may be another one (started from a
terminal, with its own environment): the answer is about the worker this client would start. A headed `auth_login`
job's window closes after `RETAKE_SIGNIN_MAX_MIN` (default 30 min: it holds the single worker, and a click in the
Studio opens it) — `timed_out`; `auth.cancelSignIn(job)` cancels an `auth_login` job and refuses any other kind. A
stopped sign-in writes no snapshot and no status; a profile persona that already had a browser profile signed in on
it, so what the window changed stays there (`profile_kept`, review A L5; `signInStoppedText` words it for the worker,
MCP and the Studio) — a first sign-in removes its new profile, a `storage_state` persona's window ran on a throwaway
one. (A temporary copy of the profile, swapped in on success, was weighed and left: the master's writer and its lock
are `retake login`'s since L1.6.)

**The run stream** (part B; ui `server/run-live.ts`, `RunLive`). `POST /v1/live {project, run_id, after?: {log,
job?}, frames?}` — a route of the gate like every other (Host → Origin / Sec-Fetch-Site → route / method → token → JSON
→ ≤ 4 KiB), the body a strict object (slug and run-id patterns, offsets ≥ 0; anything else 400), an unknown run 404,
at most RUN_LIVE_STREAMS_MAX = 2 streams (the slot reserved before any await; a third 503 `too_many_streams`); never
an op (the op counter does not move). `text/event-stream`, `Cache-Control: no-store`, a comment line every 15 s.
Events: `hello {project, run_id, mode, job}`; `snapshot {from: 'start' | 'after', truncated, log_lines_dropped?,
cursor: {log, job}, events: [{src, seq, ev}], notes?}`; `progress {src, seq, ev}`; `job {state, pause_requested,
cancel_requested}` on change (polled every 4th read); `picture {state: off | none | waiting | live | busy | ended,
why?}`; `frame {seq, w, h, at, page?, jpeg}` (base64); `end {status?, job_state?}`, then the stream closes.
- *Steps and log* (critique B11, B12): the run's `log.jsonl` (every progress event, for a job's run and a terminal's
  `retake run` alike) and, for a job's run, the worker's `events.jsonl` (`log` → `job_log`, `state` → `job_state`; its
  `run` events are log.jsonl's and dropped) — read only while a stream is open, every RUN_LIVE_POLL_MS = 300 ms, from
  byte offsets, through engine `RunFolder.readRange` / `readPlainRange` (no link followed — `O_NOFOLLOW`, no FIFO held,
  a regular file checked once open, the run folder still the one resolved), ≤ 256 KiB a read, ≤ 2 MiB a poll and file.
  `seq` = the byte offset of the line's end in its file; `after` resumes from those offsets (an offset past the end, a
  replaced file: from the start, said so); on connect a log longer than LIVE_TAIL_MAX = 8 MiB is read from its last 8
  MiB (the cut line dropped, `truncated`); a line over LIVE_LINE_MAX = 64 KiB is skipped with a `note` (the partial-line
  buffer never grows past it). The snapshot keeps every event but the log lines, cut to the newest 500. The stream
  ends (`end`) once the run's job finished (the worker finalises run.json first) or, for a terminal's run, once run.json
  says it finished; after `run_end` it waits up to 10 s for the job. The run's lines and the worker's are merged by
  `ts` in the snapshot and each poll (`mergeByTime`, each file's order kept — review B L5); the page inserts a line by
  its time too, so a reload shows the same order.
- *The view* (S9): never a raw RunProgress — every field type-checked (log.jsonl is a project file an agent could
  write), unknown types and malformed lines dropped; `run_start` → status, mode, env, steps_total, production, access,
  hooks, until; `run_end` → status, steps, hooks, stopped_at, error {scene, step, action}, warning / optional-failure
  counts — no `dir`, output, screenshot or any other path field; names (scene, persona, hook, action) ≤ 200 characters
  of one line; every text capped at LIVE_TEXT_MAX = 2,000 characters, control characters dropped, the project folder,
  the workspace and the home folder replaced by `<project>`, `<workspace>`, `~`; the filmed site's and the hooks' text
  (step_end / log / encode / job messages, session `detail`, hook `message`, run_end `error` and `warnings`) under
  `untrusted` — the page renders it as text (`Txt`), never as a link or HTML. Step `desc` (the scenario's own, redacted)
  stays outside. A hook named by its description (its shell command or URL) has its name scrubbed as a text; URLs in
  every text keep their origin, path and query keys — a password, the query values, the fragment and path segments that
  look like a secret are masked (`maskUrls`, review A). Every event is written by `sseText`: JSON with U+2028 / U+2029
  escaped (review A M1: the page's old line regex ended a line there and dropped the whole event — the snapshot
  included); the page's parser (`parseSseBlock`, shared by the event stream) splits lines on `\n` only. This closes
  R-ARC-01's "job progress reaches the UI as ids the page re-reads" for the Run screen.
- *The picture* (S3 is the worker's; B8, C2): ONE upstream per job (`FrameFeed`, engine `readLiveChannel` +
  `openLiveFeed`, which checks every record), opened when the first page stream that wants frames subscribes, closed
  (aborted) when the last one leaves — logs keep flowing from the files. A stream wants frames when `frames` says so,
  else for a dry run only: a capture's stream carries none unless the page sent `frames: true` (user decision, kept
  by the measure: the picture costs ≈ +15 % Chromium CPU during a take — "Acceptance and cost" below). No job (a terminal's run) or a finished run → `none`. While the job
  is queued, or between upstream attempts, the feed looks again every second; a 503 of the worker → `busy` (another
  Studio holds its second stream). The feed keeps the current frame while it is open (memory only — what a second page
  stream joining it gets first: the worker only sends its cache to a new connection) and drops it when it closes or
  the picture is no longer live. Latest-only toward each page: a frame is written only when the page's socket needs no
  drain, else it replaces the one waiting frame (a page that never reads holds ≈ two frame records at most); progress
  events are small and always written. Frames are never written, logged or put in an event file (S4: a test scans the
  workspace and the Retake home for their bytes, raw and base64). The page decodes with WebCodecs' `ImageDecoder` where
  the browser has it, else `createImageBitmap` of a Blob, on a canvas (part C; no CSP change, no `src=`, no blob: URL).
- *Ops*: `run_pause {project, run_id, paused}` → engine runs.pause (409 queued / stopping / finished, 403 a terminal's
  run; the summary says "pausing before its next step" until the run reaches it); `scenario_sessions
  {project, name, env?, mode?}` → engine auth.forScenario + `confirm`; `sign_in_cancel {job}` → engine
  auth.cancelSignIn; `auth_status` (MCP, read-only); `auth_login` NARROWED to `mode: 'headed'` and `wait_s: 0` (S6: a
  page script can only open a window the person sees, which closes after RETAKE_SIGNIN_MAX_MIN; `auto` is what
  every run's preflight does by itself).
- *The session acknowledgement* (S7; since L6.5 an admission rule of the engine, `sessions_ack` of `runs.submit`, for
  the Studio and MCP alike — `run_capture {sessions_ack}`; §4c): `scenario_run` of a capture reads auth.forScenario (capture mode)
  and needs `sessions_ack: string[]` naming every persona whose stored status is expired / error / never and that no
  run signs in by itself (not `auto`, not a sandbox account, not the legacy single-account file, where a run starts
  signed out) — else 409 `conflict` with `details.sessions: [{persona, status, checked_first}]` and nothing queued;
  extra names are ignored; a dry run needs none. A guard against a wasted take, not person presence (a page script can
  send it). `checked_first` (review A M2): the run's own preflight checks the persona before setup hooks and before
  anything is filmed when it has a `check` or never signed in, and stops there; a saved session without a `check` is
  used as it is — the run fails only when a page lands on the sign-in page, after its setup hooks ran. The 409's text
  (`confirmWhy`) and the dialog say which applies to whom.

**The page** (part C; ui `app/RunScreen.tsx`, `run-live.ts`, `LiveView.tsx`, `Sessions.tsx`, `sse.ts`). Routes
`#/p/<slug>/s/<name>/run` — the preflight: `scenario_sessions` (capture mode) as a table of the personas with their
stored state and Sign in, the issues, `scenario_blocks`' run blockers beside Start dry run / Start capture (a running
run of the scenario: "Watch … live" and both wait) — and `#/p/<slug>/s/<name>/run/<run_id>`: one run, any of the
scenario's (the scenario screen's banner and its submit link there with "Watch live"; it keeps its own Dry run /
Capture). A start navigates to the run's route.
- *The stream client* (`useRunLive`): `POST /v1/live` through fetch (the token in a header, `openStream`), the events
  folded into one state by a pure `applyEvent` (re-rendered at most every 100 ms; frames never enter React state). The
  largest `seq` per source is the cursor: a stream that drops without `end` reopens with `after` after 1 s, doubling to
  10 s; `from: 'start'` replaces the state, `'after'` appends. A hidden tab (`visibilitychange`) aborts its stream (the
  server then closes the job's upstream when no other page wants frames — B8) and reopens it with `after` once shown.
  `frames` is sent only once the person used the toggle: until then the server's default holds (a dry run's picture
  on, a capture's off); the toggle reopens the stream with `frames: true / false`. 503 → `run_status` every 2.5 s
  while visible (header, steps done, the current or paused step), the stream tried again after 30 s; 4xx → the
  server's message. `end` stops it for good.
- *The picture* (B14): a canvas of a fixed 960×540 drawing size in a 16:9 box; each frame's base64 checked (`FF D8
  FF`, ≤ 700,000 characters, w / h ≤ 4096) and decoded by `ImageDecoder({data: bytes, type: 'image/jpeg'})` where the
  browser has it (the bytes straight to the decoder), else `createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}))`
  (a browser may keep a Blob in its blob storage — on disk under memory pressure; a ≈ 50 KB frame stays in memory in
  practice), letterboxed: scaled to fit the box and centred, dark bands (part E; it was drawn from the top,
  a dark band below). The layout follows the frame size (`run-live.ts` `nextLayout` / `placeFrame`): a new width at
  once (another page or viewport), a new height of the same width only after SETTLE_FRAMES = 3 frames in a row — a
  dry run of a 1920×1080 scenario sends mostly 960×471 frames with, now and then, a 960×540 one (a capture's recorder
  override gives 960×540 throughout), and such a frame is drawn at the picture's place and scale (its top at the
  picture's top) instead of moving it; nothing resizes. Latest-only (one decode at a time, the newest frame waiting). The source lint allows the
  two decoders (`new Decoder(…)`, createImageBitmap and `new Blob`) in LiveView.tsx only and bans `URL.createObjectURL` / `blob:` everywhere in src/app (Thumb.tsx's data: URL
  stays the one image source). The canvas has a label; its state is words beside it (hidden, waiting, live — "not
  recorded" —, none for a terminal's run, ended, another Run screen holds the stream).
- *Steps and log*: the step list is the run's `outline` (a run older than L4.4: the steps it reported), grouped
  *Before filming* (the preflight's `session` rows first, setup hooks — the runner's phase-start event shown as one
  "running" row until its first hook reports), the scenes, *After the scenes* (teardown, rollbacks, encoding); each row
  a status word with a glyph (waiting, running, done, skipped, failed, not reached, "paused before this step"; review B:
  `stepStatus` — "stopped here" only for the step a Stop interrupted, the last that started when it did not end well,
  never an optional step that failed before; "interrupted (its worker stopped)" for a step still running when the
  stream ended without `run_end`, the elapsed time then stopped at the last event's `ts`; "skipped (dry run)" /
  "skipped (hooks off)" for a `hook:` step of a run that skips its hooks; a `hook:` step's entries listed on its row);
  "Follow the current step" scrolls the list only. "n/N steps done" counts the rows that say done (`stepCounts`: a
  failed step is not done; skipped ones said apart). The log keeps the last LOG_KEEP = 1,000 lines (the dropped ones
  counted), the run's, the worker's notes (its job states in words that are never the run's outcome: "the worker
  finished the job") and the Studio's own notes, in time order, a warnings-only filter, follow. Every text of the view
  is a text node through Txt; session details sit in "From the page" boxes, step messages and a step's run error in
  boxes that say they may quote the page, an error of the tool (no step: a missing variable, the app not reachable)
  plainly.
- *Controls* (B15): Pause / Resume (`run_pause`) for a running run of a job (a capture: "the video does not show the
  pause; the page keeps running, so what changes on it meanwhile shows as a jump"); disabled with the reason for a
  queued run, a stopping run and a terminal's run ("press Ctrl-C there"). "Pausing before the next step" while asked, "Paused before step n of <scene>" with the
  limit the `paused` event carries while paused, "the pause came too late: the run ended before its next step" when it
  ended first. Stop (`run_cancel`) "stops now: the step in progress is interrupted" (it does not wait for the next step)
  and says that the teardown and pending rollbacks still run; the outcome names the teardown hooks' results and the
  rollbacks (or "no rollback was pending").
- *Sessions* (B9, B10): the project page's Sessions panel (`auth_status`) and the preflight table; Sign in =
  `auth_login {project, persona, env}` (the server pins headed / no wait); the job followed through `jobs` events and
  `job_list` every 3 s (waiting for the queue, a window open with its time limit and "it may be behind this window",
  the result) with Cancel (`sign_in_cancel`; "Stopped": nothing saved, or — `profile_kept` — the window's changes left in
  the persona's browser profile, or, the result not known yet, "the saved session was not updated"). The preflight
  table says `auto` (with "its keychain items are not looked up here"), the login variables missing for the worker, and
  "no check: a run uses its saved session as it is". ConfirmSessions is a modal `<dialog>` naming each persona and its
  state: per `checked_first`, "the capture checks … first and stops before filming if it is still not valid" or "…
  cannot be checked first (no check): the capture uses its saved session as it is and fails only when a page lands on
  the sign-in page — after its setup hooks ran", **Sign in first** first and focused, Escape closes it and sends
  nothing, **Capture anyway** sends `sessions_ack` (also on a 409 `details.sessions` from a stale screen, and from the
  scenario screen's Capture). It closes before it unmounts (review B L4): Escape gives focus back to Start capture,
  "Sign in first" moves it to that persona's Sign in button, a refused start to the Start button.
- *Accessibility*: every control a button or a labelled checkbox / select; the step list and the log are focusable
  scrolling lists, not live regions; one visually hidden `role="status"` line says only the run's state changes
  (queued, running, paused, stopping, ended).

**Acceptance and cost** (part E, 2026-10-26; the built `retake ui`, a scratch copy of the fixture workspace with the
fixture on ports of its own, a scratch `RETAKE_HOME`, a headless Chromium driving the page). A dry run of
`highlights` watched live (first frame drawn 1.3 s after Start, the picture letterboxed), paused before
`quotes.0` for 3 s (no step moved) then resumed — succeeded 7/7; another stopped after 2 steps — cancelled, "no
rollback was pending". A capture of `highlights`: the picture hidden by default (no `frames` asked, nothing drawn),
shown by the toggle (the stream reopened with `after` + `frames: true`), paused once — `run.json pauses` 5.0 s,
`timeline.pauses` `{t: 9.083, ms: 4801}`, the run warning "paused once (4.8 s, not filmed)" —, succeeded with its
setup and teardown hooks. A capture submitted through MCP (`retake mcp` over stdio, `run_capture`) watched on the Run
screen, paused there while MCP `run_status` printed "paused before step quotes.0 … (from the Studio: it resumes
there …)", succeeded. The project page's Sessions panel on `signed-in`: the supplier *expired* (with the check's page
text in a *From the page* box), the buyer *never signed in*; **Sign in** opened the headed window ("a browser window
is open on this computer …", its 30-minute limit), **Cancel** closed it — "Stopped: nothing was saved" (the wording
since the review: what a stop leaves, `profile_kept`), no browser left. With the supplier expired and its `login:` steps removed, **Start capture** of `proforma` opened the
confirmation (nothing sent, *Sign in first* focused), **Capture anyway** sent `sessions_ack: ["supplier"]` and the
run's preflight stopped it before filming (first row "Session of supplier — not signed in: the run stops before
filming", 0 frames). No console error in any page.

*The live picture's CPU on a capture* (R-UI-17; the take's own sampler, `run.json perf.cpu`, Chromium = browser +
GPU + renderers + other helpers): the fixture's `live-quote` (a 32 s take: two pages filmed at once at 1440 × 900,
the picture following the acting one; cursor moves, a quote request, live lists), captured from the Run screen four
times in a row, the page watching each, the picture off / on / off / on:

| take | picture | Chromium cpu-s | of which browser process | per take-second | recorder frames (fps) | stalls | load mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | off | 13.96 | 8.32 | 0.43 | 869 (26.7) | 0 | 7.4 |
| 2 | on (212 frames drawn) | 15.70 | 10.33 | 0.49 | 879 (27.2) | 0 | 9.6 |
| 3 | off | 12.77 | 7.76 | 0.40 | 877 (27.2) | 0 | 7.9 |
| 4 | on (212 frames drawn) | 15.20 | 10.08 | 0.47 | 880 (27.3) | 0 | 5.9 |

Mean 13.37 → 15.45 cpu-s: **+2.1 cpu-s, +15.6 %**, almost all in the browser process (+2.2 cpu-s: the second
screencast's JPEG encoding at `everyNthFrame: 1`); GPU, renderers and the retake process within the noise; the
recording untouched (frames, fps, no stall, nothing dropped). Above the plan's 10 % threshold: the picture stays off
by default during a capture (one click shows it, the screen says it costs CPU), on for a dry run. A cheaper capture
picture (a narrower `maxWidth`, a lower rate) is in the backlog's Run screen extras.

## 4g. Edit / verify timeline (L4.5)

R-UI-23…26 (+ R-UI-15's "Open timeline", the guard-rail "L3.2 / L4.5"): see the edit of a take before rendering it,
switch its components in one click, render and review it from the Studio. Built in parts (the lot's plan and its
critique B1–B17 apply): **A — model, edits, render snapshot**; **B — the player origin and its sandbox**; **C — the
timeline screen and the preview**; **D — the inspector and switching**; **E — render, queue and review in the screen**;
**F — acceptance, measurements, docs** (all built). Cuts: BL-107 (editing extras), BL-108 (preview fidelity: frame-exact
playback, a proxy, colours), BL-109 (watching a finished render, exports, other review settings), BL-110 (isolation
residues, WebKit's frames).

**Timeline model** (editor `timeline.ts`, pure). `timelineOf(plan, {labels?, timeline?}) → TimelineModel`: every
frame absolute (a segment's `from` plus its segment-relative spans). `segments[]` — `index, id, kind, from, to`
(`to` = from + durationInFrames: a crossfade's overlap included), `component {id, kind, source, missing?}`,
`transition {kind, frames, component}` (absent: the first segment, or a same-page join — then `joined: true` on a
clip), a clip's `scene`, its `caption` component (null: captions off), a multi-page clip's `pages` (ids), a card's
`reading`. `captions[] {from, to, scene, i}`, `steps[] {from, to, scene, step, step_id?, action, key: "<scene>.<step>"}`
(a scene's still is step -1), `camera[] {from, in_to, out_from, to, zoom, requested_zoom?, source, scene, step, key,
pane?}` (panes' zooms included), `speed[]` (every span of every clip, `protected` kept), `cuts[] {at, src_from_s,
src_to_s, scene, reason}` — every planner trim (they are all cuts: idle, a held page load, a freeze, a busy wait, a hook
step) plus any other jump of the time map, the reason taken from the run's timeline span covering most of the skipped
capture time (`loading` + `scene_open`, `stalls` → frozen, `busy`, `hook` events, `idle`; `gap` without the timeline)
—, `markers[] {frame, done?, scene, step?, i}`. Text is only under `untrusted`: caption kicker / text and marker names
by index, step labels by key (given by the caller), page labels by "<scene>.<page>". No per-frame array: a 4-minute
plan's model is ≈ 15 KB (its plan ≈ 60 KB), built in 0.1 ms. `placePins(model, threads, {run_id, edit})`: a thread of
the shown take at its anchored step's first frame (else its marker, else its segment's start); on today's edit
(`edit: 'scenario'`) a thread of another take at `step_now`; else listed beside the track (no position invented).

**Preview plan** (editor `preview-plan.ts`, critique B4). `previewPlan(plan, {urlFor, forbid}) → PreviewPlan`: every
`ds-asset:` URL swapped for the URL the player serves it at (`urlFor(asset, file)`: undefined → refused); `assets`,
`display`, `notes`, `warnings`, `source.file`, `tracks[].file`, `music.file` removed; an absolute path left in a slot (a
theme's own file in studio/media's `file`) blanked; a `hidden` URL entry (a local URL without a display one) keeps its
frame, loses its address; refused (`PreviewPlanError`) — a `ds-asset:` URL the asset map does not serve, a `file:`
URL, any string holding one of the `forbid` folders (project, run, theme, workspace, home). Part B serves it as
plan.json under the player's capability; nothing in a JSON op.

**Field edits** (core `field-edits.ts`, critique B10: L4.3's step operations untouched — their low-level text helpers
are exported as one frozen object, `stepEditText`, and reused). `ScenarioEdit` gains `{kind: 'set_field', at, field,
from?, to?}`: `at` = `{entry: 'top'}` or `{entry: 'scene' | 'card' | 'interstitial', id, guard}` (guard = stepGuard of
the entry as written; a card / interstitial id is its `id`, else `card-<index>` / `interstitial-<index>`); `to` absent
= the theme's default (the key removed). The allow-list (`FIELD_PATHS`) is the only set of paths it takes, every one an
edit value (core filmedChanges): top `frame`, `intro`, `intro.component`, `intro.duration`, `outro`,
`outro.component`, `outro.duration`, `caption_component`; scene `frame`, `transition`, `speed`; card `card.component`,
`card.duration`, `card.transition`; interstitial `interstitial.component`, `interstitial.duration`. Values checked
first (`fieldValueProblem`): a frame word or a layout id, a transition kind or a component id, speed in (0, 16],
durations in (0, 600], a component id, the intro / outro switch takes `false` or nothing; strings through
`editValueProblem` (no hidden character, one line). Applied only while the file holds `from` there (`true` for an intro
/ outro written as a map) and the entry still has its guard (`stale` otherwise); a value written as a map (a transition
with params) is not editable here. The editor: a scalar set through yaml's CST (quoting kept, double-quoted when the
re-parse disagrees), a value replaced (a flow value; a block map written over by `intro: false` — the pair's lines
rewritten), a pair added (a new top-level key just before `scenes:`, a new scene key just before `steps:`, both above
the comment lines that belong to that key; else after the map's last pair; `, key: value` into a flow map; a missing
parent as `{key: value}`), a pair removed with its comment lines (removing a nested map's last key removes the parent
pair — `intro: {component: x}` → the theme's intro; a card keeps its `card` key). Each operation re-parsed against the
whole file's intended value; the final line break state kept. Labels: "Set the layout of scene request to laptop",
"Turned the intro off", "Reset the intro component to the theme's default".

**Through `scenario_edit`** (engine `scenarios.editScenario`): the file-level rules of L4.3 unchanged (the hash as
if_match, the blocker, no hidden character added, hooks / mocks frozen and — while there are any — vars / env, the
validation with agent trust, the write lock); then a `set_field` that does not fit its use is refused (`invalid`, the
same words the inspector shows: engine `field-options.ts` `fieldFitProblem` over components `componentFit` — kind,
written slots shown, required slots given, params valid, a layout's pages, a user file taking no component; frame
words against the scene's pages: `split` / `pip` only for a multi-page scene, a single-page style never for one, no
multi-page frame for the whole video; a component written for another kit API); a `set_field` whose result changes
the filmed part is refused (defence: the allow-list holds only edit values); the result's `change` is always `edit`.

**`caption_component`** (scenario key; core types, zod, JSON Schema, `timelineVideo`, `replanEdit` — copied, named
`caption_component` among the edit changes; filmed: no). The planner resolves a clip's caption `overrides.components.caption`
→ `video.caption_component` (source `scenario`) → theme → built-in; an unknown id falls back with the resolver's
warning. MCP and the CLI read it through the same planner (no new argument; MCP `render {overrides.components.caption}`
still wins). Per-scene caption components and a general scenario `components:` map are BL-107 (critique B9).

**`engines.kit`** (components manifest, the guard-rail). `engines: {kit: "1" | "^1"}` (`KIT_RANGE_RE`, absent = 1),
`KIT_API_VERSION = 1`, `kitMajorOf`. A component of another major is a broken registry folder: a notice ("needs kit
API 2 (engines.kit "^2"): this Retake provides kit API 1"), `get` / `resolve` throw, `list` leaves it out — its uses
fall back down the planner's chain (a warning) or render as `missing`. The 41 built-in manifests carry none (critique
C4); BL-15 is the consumer.

**Timeline view** (engine `timeline-view.ts`, `engine.timeline.view({project, scenario, run_id?})`, feature
`timeline.view`). Plans the take as a render would (`planRenderRequest`, trust `mcp`, the L5.5 edit source) and returns
`{view, plan, folders}` — the plan and folders only for the in-process caller (part B's player); `view` holds
`run_id`, `theme`, `hash` (today's file: the next `scenario_edit`'s), `source` (`edit`, `scenario_changed`,
`filmed_changes`, `edit_changes`, `edit_sha256`), `editable` (true, or why: no file, a file the Studio does not edit —
its blocker —, a filmed change pending: "capture again to see edits on it", an edit from the run), `model` (the
timeline model without its untrusted part), `pins`, `choices` (`video`: caption component and frame; per segment id —
intro / outro: component, switch, duration; scene: frame, transition, speed; card: component, duration, transition;
interstitial: component, duration — each `{at, field, current?, editable, options, range?}`, options the theme default
first then the frame styles by name (Card, Browser, Laptop, Phone, Tablet, Full screen; split / pip for a multi-page
scene) or the components of the kind, each `usable: true | {why}`), `capture` (codec, B-frames, keyframe interval over
the first 30 s — ffprobe reading the packets from a descriptor opened without following a link; `slow_scrub` when
keyframes are more than 1 s apart, critique B14), `runs` (the scenario's captures), `key`, `ms {planning, total}` and
`untrusted` (captions, markers, step labels — from the text the plan came from —, page labels, the plan's warnings and
notes, the last 50 threads' text and author). A trust refusal returns `{blocked: {problems, command}}`. Path-free and
plan-free (a test scans it). **Memo (critique B13):** one view per key — sha256 of the file, its blocker, the run, its
timeline.json size and mtime, the workspace components' folder and manifest mtimes — LRU 4, concurrent reads sharing one
planning (`memo: true` on a hit); the registry reused while those mtimes hold; the music bed measured once per file
(size, mtime); the capture probed once per file. A click's write and the scenario event it raises plan once; undo back
to a version still memoised plans nothing.

**Render jobs** (critique B5, B12). Submit writes `edit.yaml` (the scenario text the edit was planned from: editor
`PlannedRun.editText`, its sha256 = the job's `edit_sha256`) into the job folder before job.json (`FileJobQueue.enqueue
(input, {files})`: plain names only — `[a-z][a-z0-9-]*.(yaml|json|txt)`, never the queue's own files — mode 0600,
exclusive create). The worker reads it without following a link (≤ 2 MB), refuses one whose sha256 is not the job's
(conflict) and plans from it (`renderVideo` / `planRun {editText}` → core `scenarioSinceRun(…, nowText)`: the same parse,
filmed check and trust gates); a job without one (queued by an older build) reads today's file as before. A render
job's `review: {fps: 1 | 2}` (core `RenderJobInputSchema`, engine `RenderRequest.review`) reviews the render in the
same job once it is written (`reviewInline`: the review job's own execution with the job's signal; progress phases
`review:<stage>`): a cancel during it stops the review (`result.review: {state: 'cancelled'}`; the render, already written, stays this succeeded job's result — render_status must not call a finished render cancelled; the previous review comes back),
another failure leaves the render succeeded with `result.review: {state: 'failed'}` and the reason under
`untrusted.review_error`; on success `result.review {state, clean, counts, ms}`. A worker killed during it: the
interrupted-render cleanup recovers the review folder too.

**Player origin** (part B; ui `server/player.ts`, critiques B4, B6, B15, B16). The Studio process opens a second
loopback listener, `http://127.0.0.1:<Q>` (`StudioServer.player`; `playerPort` option), after its own: it knows the
Studio's port P, and the Studio's CSP then names Q in `frame-src` (engine `studioCsp(frameSrc)`, `securityHeaders(kind,
{frameSrc})`; `FRAME_SRC_RE` accepts only `http://127.0.0.1:<port>`) — the one origin a Studio page may frame, which is
also what stops the frame from navigating itself elsewhere (CSP has no `navigate-to`). Gate: engine `checkRequest` with
the new `allowNullOrigin` (Host exactly 127.0.0.1 / localhost:Q → else 421; GET / HEAD → else 405; Origin absent,
`null` or its own → else 403; no token: the capability is the proof). One **session capability** (32 random bytes) in
every path, created with the server, replaced by `rotate()`, revoked by `close()` (every older URL 404); never logged
(a failure logs `retake player: a <frame|media|other> request failed: <Error name>`), never in a Referer
(`no-referrer` on every answer and the iframe). Routes, nothing else (no `/v1`, no op, no event):
- `GET /s/<cap>/frame` — the frame document: no inline script; `boot.<hash>.js` (first, classic) then
  `b.<hash>.js` (defer); `<meta name="ds-parent">` with `http://127.0.0.1:P http://localhost:P`; `Cache-Control:
  no-store`; the frame CSP as a header: `default-src 'none'; script-src Q/s/<cap>/; style-src 'unsafe-inline';
  img-src Q/m/<cap>/ data:; media-src Q/m/<cap>/ data:; font-src Q/m/<cap>/ data:; connect-src Q/m/<cap>/;
  worker-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors http://127.0.0.1:P http://localhost:P; sandbox allow-scripts` (sandboxed even
  opened on its own); `X-DNS-Prefetch-Control: off`, `nosniff`, `CORP: cross-origin` (the frame is an opaque origin).
- `GET /s/<cap>/{boot,b}.<hash>.js` — the scripts, `private, max-age=86400, immutable` (the hash names the build).
- `GET /m/<cap>/plan/<id>.json` — a preview plan (`publish`: editor `previewPlan` over the view's plan; `forbid` = the
  project, run and theme folders plus the caller's — the Studio passes the workspace and the home folder), from
  memory, LRU 16, ≤ 16 MB, id = its sha256.
- `GET|HEAD /m/<cap>/<file id>/<name>` — a registered file. `register(file, within)` takes a file only when its real
  path lies inside one of `within` (publish: the view's project, run and theme — the folders planRun's gate 2 put every
  asset in), the path given is no link, and it opens (`O_NOFOLLOW | O_NONBLOCK`) as a regular file; ids are random
  (16 bytes) and stable per (device, inode, size, mtime) for the session (critique B6: a switch keeps every media URL,
  no `<video>` reloads), ≤ 4,096 per session. Each read reopens the real path without following a link and checks it
  is still that regular file (device, inode, size, mtime) — swapped for a link, a FIFO or other bytes → 404; Range
  (editor `parseRange`; 206 / 416), HEAD, ETag = the id, `private, max-age=86400, immutable`, `Content-Security-Policy:
  default-src 'none'; sandbox` (a file opened as a document runs nothing).
CORS (`Access-Control-Allow-Origin: *`, exposing Content-Length / Content-Range / Accept-Ranges) only on `/m/`: the
plan, fonts and Lottie JSON are CORS fetches with `Origin: null`. The Studio port still never sends an
`Access-Control-*` header. `StudioServer.crossSite` counts requests that came from another site (Sec-Fetch-Site
cross-site / same-site, or Origin `null`) — the sandbox test asserts the frame sent none.

**Preview bundle** (part B; ui `player/bundle-player.ts`, critiques B3, B11). esbuild in memory, one classic IIFE per
script (`b.js` from `frame-main.tsx`, `boot.js` from `boot.ts`), minified, the Studio's browser targets. It holds the
Remotion Player, DemoVideo (the render's own composition, through the generated `ds:composition`) and **every**
component of the workspace registry plus the scaffolds (`playerComponents`), so a switch never rebuilds it. The
generated `ds:modules` maps each id to `() => import(entry)` (and each scaffold by kind): esbuild makes each a lazily
initialised module inside the one IIFE — nothing a component's module does runs before the frame loads it for a plan
that uses it, and one that throws rejects its own import only. Import allow-list (an esbuild plugin): a component's
import is checked with components `importProblem` (own folder, react, react/jsx-runtime, remotion, the kit — the rule
`retake components` applies); its bare imports resolve from the ui package, never from its folder (a planted
`node_modules/react` is ignored); each of its files is loaded by the plugin: real path inside the component's real
folder (a link out of it is refused), read with core `readPlainFile` (no link, regular, ≤ 1 MB), `.ts .tsx .js .jsx
.mjs .json` only. The frame, the composition and the kit import their own sources and react, react-dom, remotion,
@remotion/player, @remotion/lottie, lottie-web, scheduler, @retake/core / components (type-only in practice).
A component that breaks a rule or does not compile is excluded and the build retried once without it (`excluded:
[{id, why}]`, worded with its id, never its folder); its uses draw with their kind's scaffold. Memo (`PlayerBundles`):
key = sha256 of the format, the Player's version, editor `bundleHash` of the components (composition, kit, every
component folder by content, Remotion's version) and the frame's sources; rehashed on every frame document (an edited
component file is a new bundle), at most 2 kept, concurrent asks share one build. `@remotion/player@4.0.534`,
`remotion`, `@retake/components` and `@retake/editor` are now dependencies of `ui` (same versions as the
lockfile already held; installed with `pnpm install --offline --frozen-lockfile`).

**The frame** (part B; `player/boot.ts`, `player/frame-main.tsx`). `boot.js` deletes and pins to a non-configurable
`undefined` RTCPeerConnection, webkitRTCPeerConnection, RTCDataChannel, RTCSessionDescription, RTCIceCandidate,
RTCRtp{Sender,Receiver,Transceiver}, WebTransport and `navigator.sendBeacon` (WebRTC is the one channel the CSP does not
cover; an about:blank child cannot bring it back: `frame-src 'none'`). No storage shim: storage throws in the opaque
origin and the Player tolerates it. `frame-main` posts its `hello` from its own `load` event; on `load {plan_url,
frame}` it refuses a plan URL that is not `Q/m/<cap>/plan/…` and a plan whose capture, page tracks or music are not
under `Q/m/<cap>/`, loads the plan's component ids (editor `usedComponentIds`, shared with the render's
`planComponentIds`) — a missing or throwing one is `missing` (`loaded.missing` + a warning; its kind's scaffold draws)
— then mounts the Player (`initiallyMuted`, no controls, no click / space / double-click handling, key = the load).
What it mounts is a tiny external store (`frame-store.ts`) the React tree reads with `useSyncExternalStore` (L5.2): a
`load` answered before the tree's first effects ran is kept and shown — WKWebView fires the frame's load event (hence the
hello) before React's first render, and a setter taken in an effect lost the plan in about half the desktop runs (the
Player never mounted, no `<video>`, *Loading the preview…* for good).
`settled {frame}` once paused at that frame with no delayRender handle left, every `<video>` at readyState ≥ 2 and not
seeking, `document.fonts.status === 'loaded'` and every image complete, for two polls (30 ms) in a row — the Player
itself waits for nothing (critique B8). Preview mode (editor `remotion/preview-mode.ts`, `PreviewContext`, set only by
the frame): a theme font that fails is a `warning` ("a theme font could not be loaded (<families>): the preview uses a
fallback font") and the text draws in the fallback; a render still stops (cancelRender). Errors and warnings: at most 8
per load, 300 characters each.

**Protocol v1** (part B; `player/protocol.ts`, `player/parent.ts`, critique B2). The frame opens a MessageChannel and
posts one `hello {bundle}` with its port to the parent — to `location.ancestorOrigins[0]` when it is one of the
`ds-parent` origins, else to each of them (one channel each: only the matching one delivers). The page
(`connectPreview(iframe, {onHello, onMessage, onStop, budget?})`) listens on `window` for exactly one message from the
frame: a valid `hello` with a port connects and the window listener is removed; anything else from the frame stops the
preview; other windows are ignored; the frame's `load` event re-arms it (a reloaded frame's new hello replaces the
port). Over the port every message must parse exactly (`parseFrameMessage`: exact keys, whole frames within the last
`loaded.frames`, text ≤ 300, lists ≤ 64) and fit the budget (240 messages in any second), else the preview stops: port
closed, iframe removed, `onStop` with "the preview stopped: a component sent too many messages" / "…it sent a message
the Studio does not take". Page → frame: `load {plan_url, frame}`, `seek`, `play`, `pause`, `rate {0.5|1|2}`, `mute
{muted}`, `clear`. Frame → page: `loaded {frames, missing, warnings}`, `frame` (at most one per animation frame),
`state {playing, buffering, muted}` (first on mount: muted — the page shows "Unmute"), `settled`, `ended`, `warning`,
`error`. `PREVIEW_FRAME_ATTRS`: `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, `allow="autoplay"`,
`aria-hidden`, `tabindex=-1` (part C's PreviewFrame uses the same).

**Timeline screen** (part C; ui `app/TimelineScreen.tsx`, `TimelineTracks.tsx`, `PreviewFrame.tsx`, `timeline-words.ts`,
op `timeline_view` in `server/ops.ts`). Route `#/p/<slug>/s/<name>/timeline[/<run>[/<step key>]]` (`hrefTo` drops a
step without its run: the key is the run's own); reached from the scenario screen's **Open timeline** (R-UI-15; the
newest capture that succeeded with its video, else the button disabled with why), the Run screen's outcome of a
succeeded capture (**Open its timeline**) and the step inspector's **Show in timeline** (a step bound to a capture: its
run key). **The op** `timeline_view {project, name, run?}` (strict; not an MCP tool): no capture → 404 in the Studio's
words (the planner's own error names the runs folder); engine `timeline.view`; a trust refusal → `{blocked}` with the
command and no URL; else the view plus `frame_url` / `plan_url` from `player.publish(result, {forbid: [workspace,
home]})` — the plan, its folders and every path stay in the process (a test scans the answer: no `plan` / `folders`
key, no workspace or home path, no `ds-asset:`, no product URL); a publish failure keeps the view with `preview_error`.
The engine memo's key gained the scenario's comment folder (size, mtime): a new or answered thread is new pins. **The
screen** reads it once per route, again on this scenario's file / runs events and `resync` (a re-read of an unchanged
take is a memo hit and the same `plan_url`: nothing reloads); a new run id remounts the screen (a new playhead), a new
`plan_url` loads into the same frame. **PreviewFrame** — the app's one `<iframe>`: literal `sandbox="allow-scripts"
referrerPolicy="no-referrer" allow="autoplay" aria-hidden="true" tabIndex={-1}` (= `PREVIEW_FRAME_ATTRS`, both checked
by the source lint), `pointer-events: none`; first rendered without `src`, `connectPreview` attached in a layout effect,
then `src={frameSrc}` set (`frameSrc = armed ? url : undefined`, url = `previewUrls(frame_url, plan_url)`: the player's
frame route and a plan of the same origin and capability, else no preview); on each `hello` it sends `load {plan_url,
frame: the playhead}`, on each new `plan_url` `load` again; it sits in a wrapper the page unmounts when parent.ts has
removed a stopped frame (the reason shown, **Restart the preview**). **Playhead and preview:** a seek sets the
playhead at once and posts at most one `seek` per animation frame (a pending one is flushed before `play` / `pause`,
which it would otherwise undo); the preview region says *Loading the preview…* (`aria-busy`) until the codec answer and
then a `settled` for the frame asked (after a pause: the first `settled`, whose frame becomes the playhead); `frame`
messages move the playhead only while playing (late ones from a scrub are ignored); `state` gives Play / Pause, the
buffering note and **Unmute** / **Mute** — the sound asked is re-sent after every `loaded` (a load remounts the Player
muted); `warning` / `error` and `loaded.missing` are listed as text a component may have written. **Codec** (critique
B14, Q5): `canPlay` asks `MediaSource.isTypeSupported` (else Media Capabilities) for the capture's codec
(`avc1.640028` for H.264, `vp09.00.10.08`, `av01.0.04M.08`, `hvc1…`; an unknown codec or no way to ask is playable); no →
"This browser cannot play the take's H.264 video: open the Studio in Chrome, Safari or Firefox. The tracks still work."
in place of the frame (Play, Unmute and Speed disabled; the tracks and scrubber still move the playhead); the facts line
shows the codec, the keyframe spacing and B-frames, and `slow_scrub` is an info note. **Tracks:** a label column
(sticky) and one lane per track, every item absolutely placed by percentage of the frames (the zoomed level is the same
layout wider: `max(2, seconds / 10)` screens, ≤ 50), each a button with its words as accessible name (kind, label,
times) that seeks to its start: segments (scene id / kind, the component's short id, a shaded transition, missing ones
striped), captions (kicker — text), steps (1-based; a scene's still dashed), camera (zoom, its ease in hatched), speed
(spans; `held` for a transition's held frame; cuts ✂ at their frame with the reason's words), markers ◆, comment pins
(● open / ○ resolved; status, time, author and text on hover / focus; replying is L4.6) and "made on another
take" below. The scrubber is a native range (step 1 frame, `aria-valuetext` "0:00.07 · scene a · step 1
hold"), as wide as the lanes plus a thumb so its thumb's centre meets the playhead line. **Keys** (`keyAction`): Space,
← / →, Shift+← / →, Home / End, [ / ]; none with Alt / Ctrl / ⌘, while typing (input, select, text area, editable) or in
a radio group; on the scrubber its own arrows / Home / End (no double step), Space the screen's; on a button or link
Space is its own. **Preview fidelity:** in preview mode DemoVideo's capture asks for the middle of its source frame
(`PREVIEW_FRAME_CENTRE` = 0.5: a browser keeps a frame's timestamp in microseconds, rounded — asking for exactly n / fps
showed frame n − 1 in Chromium at a 2× span); renders unchanged. Premounting the next clip and
`acceptableTimeShiftInSeconds` were not needed: in the installed Chrome a real 45 s capture played at 29.6 output
frames / s and every seek settled in ≈ 0.1 s (below).

**Measured (part C, this Mac).** Chromium e2e (VP9 copy of a self-numbering synthetic take: ten blocks per frame give
the source frame index; a scene at 2× with an idle cut, a card, a zoom): 10 frames read back exactly through a
screenshot of the iframe's region after clicks on the tracks, arrows, Shift+arrow, End, a scrubber drag across the card,
the scrubber's own arrow and a play / pause (output → source 0→6, 7→13, 37→43, 157→192, 158→194, 26→32, 179→236, 2→8,
23→29); the libx264 H.264 take shows the message, no frame. The installed Google Chrome (gated
`RETAKE_TEST_CHROME=1`, temporary profile): the VideoToolbox take (keyframes every 0.4 s) and the libx264 one
(7.97 s, B-frames) both play — 8 seeks each exact, seek → settled median 107–109 ms, p95 109–111 ms, max ≤ 212 ms
(the settle check itself is two 30 ms polls), playback 29.4–29.5 output frames / s of 30; a real capture of the fixture
(`highlights`, VideoToolbox, 1,364 frames, 10 segments; `RETAKE_TEST_REAL`): timeline view 77–205 ms, the first
frame settled 320 ms after the tracks drew, 8 seeks median 106–107 ms (max 223 ms), playback 29.6 frames / s. On these
short 640×360 / 1080p takes the long GOP costs no visible seek time; the note stays (critique B14: an 8-s GOP on a long
1080p take decodes up to 8 s per seek).

**Inspector** (part D; ui `app/TimelineInspector.tsx`, `field-switch.ts`; the timeline screen and tracks). Beside the
preview (under it below 1,040 px): the video's switches (`choices.video`: the caption component, every scene's layout)
and the selected segment's (`choices.segments[<id>]`: a scene's layout, transition, speed; a card's component, duration,
transition; a waiting screen's component, duration; intro / outro: the switch, component, duration). **Selecting:** a
click on the segments track (`aria-pressed`) or [ / ] (the segment whose first frame the playhead lands on); a segment
gone from a new version unselects. **Radio groups:** each switch is a `fieldset` with a `role="radiogroup"` of
`role="radio"` buttons (`aria-checked`); arrows / Home / End move the focus only and Space / Enter picks — a pick
writes, so never one write per arrow (manual activation); roving `tabindex`; the timeline's keys stay out
(`keyAction`'s radio-group rule). Options are the view's: `value: null` is the theme's default ("As the video (Full
screen)" for a scene's layout when the video writes one), sent as `set_field` **without `to`** (the key removed — the
core label "Reset … to the theme's default"); an option the use cannot take (critique B7) is `aria-disabled`, dashed,
with the engine's reason on it ("studio/card-before-after needs slots.before"), focusable, and a click does nothing
(the server refuses it too: 400). Speeds: Normal (1×), 1.25×, 1.5×, 2× and a custom value; durations a number field;
the intro / outro switch Theme default / Off (+ "On, as written", not pickable, when the file writes a map); a value
not offered shows as "… (as written)". A switch the file writes with params (`c.editable.why`) is disabled with why.
**Writing** (`useSwitchEditor`, L4.3's `useStepEditor` for `set_field`): `scenario_edit {hash: view.hash, edit:
{kind: 'set_field', at, field, from: current?, to?}}`; from the send until the view with the answer's hash lands, picks
are ignored (`busy`); then the screen's `reload` reads `timeline_view` again, the new `plan_url` loads into the same
frame and the preview says *Loading the preview…* until `settled` at the playhead, which does not move (the plan-change
effect is a layout effect: no paint shows the new view as already settled). The live region (polite) says "Set the
layout of scene a to Laptop. Saved: ⌘Z undoes. Only the edit changed: a render of this take shows it, no new capture."
(L5.5's rule: every `set_field` path is an edit value) plus L4.3's warning count. **The op:** `scenario_edit`'s strict
schema gained `set_field` — `at` `{entry: 'top'}` or `{entry: scene | card | interstitial, id (slug), guard (16 hex)}`,
`field` one of core `FIELD_PATHS` **and** of that entry's list (a refinement: before any read), `from` / `to` a string
≤ 200, a finite number or a boolean, no other key — a malformed switch is a 400 even for a scenario that does not exist.
**Undo / redo** (⌘Z / Ctrl+Z, Shift+⌘Z / Ctrl+Y, the buttons; not while typing in a field): L4.3's `EditHistory` —
`restore` of the exact earlier bytes, which the server checks against their sha256 and against the versions the Studio
read or wrote. The bytes come from `timeline_view`'s `text`: the engine gives the file's text **beside** the view while
switches can be written (like the plan, so the view itself keeps text only under `untrusted`), the op adds it to its
answer (the same text `scenario_blocks` gives the page). A version this screen did not make clears the history, with a
notice. **409** (another writer changed the file): "Your switch (Set the layout of scene a to Laptop) was not applied.
The timeline now shows the new version." — **Apply it to the new version** sends the same switch found again by (entry,
id, field) with the new guard and the **same `from`** (a value the other writer changed is refused as stale — "the
layout of scene a changed meanwhile (it is now "phone")" — never overwritten; off with why when the new version takes no
switch there) and **Leave it**. The undo buttons, the live region and the notices stay on top of the inspector while its
switches scroll (sticky). A filmed change pending or a file the Studio does not edit: every switch disabled with the
view's why (part C's notice above the preview says it once).

**Measured (part D, this Mac).** Chromium e2e on the self-numbering VP9 take: from the click to the preview settled on
the new version (the view's hash changed and the frame asked settled), measured in the page with `requestAnimationFrame`:
layout → laptop 98–100 ms, caption component 97–99 ms, speed 97–103 ms, transition 98–100 ms, default speed 99 ms — the
write and the view take ≈ 10 ms, the rest is the frame's own settle check (two 30 ms polls after the load). Laptop: the
preview's corner went from the capture's grey (21, 21, 21) to the theme's background (147, 144, 141) and the numbered
blocks no longer read; undo gave back the original bytes (`Buffer.compare` 0) and exactly the plan's source frame again.
The caption component (studio/caption-below → studio/caption-overlay): the caption band changed (mean difference 10.9 /
255) while the capture's blocks still read exactly.

**Render, queue, review** (part E, R-UI-26; ui `server/ops.ts` `renderOps`, `app/Renders.tsx`, `render-words.ts`;
engine `renders.ofScenario`, `reviews.image`). **`scenario_render {project, name, run, expect_edit_sha256}`** — strict,
nothing else: no theme, override, variant, review setting or path (400); it calls `renders.submit` with `review: {fps:
1}` (the review inline, critique B12) and the snapshot of B5, the theme and every option coming from the files.
`expect_edit_sha256` (the view's `hash`; engine `RenderRequest.expect_edit_sha256`, also open to MCP callers) is checked
after planning and **before** the id is reserved: the file the edit was planned from — today's file when the edit comes
from the run — must be the version shown, else 409 "scenarios/<name> changed since it was shown: look at the timeline
again, then render" with nothing reserved or queued (the screen reads the view again). While a render of the scenario is
queued or running another is a 409 naming it (`details.render_id`, `job`); submits of one scenario run one at a time in
the server, so two clicks at once give one job. **`scenario_renders {project, name}`** — the engine's path-free list: the
unfinished render jobs, oldest first (queued with `queue {ahead, running {kind, phase, fraction}}`, running with phase,
fraction, eta, `reviewing` while the phase is `review:*`, `cancel_requested`, the job's `edit_sha256`); the records
renders/<name>-vN[-variant].json (named by the file first: other scenarios' records are not read; O_NOFOLLOW, ≤ 16 MB),
newest first, at most 20, each with its review's verdict (`none | queued | running | clean | warnings | errors | failed |
cancelled` — from a review job, the render job still reviewing, its inline `result.review`, or review/<id>/report.json
written after the render, counts only); and `last_failed` (the newest render job when it failed, was cancelled or
interrupted after the newest record), its message under `untrusted`. **`render_cancel {project, job}`** — a `render` or
`review` job of that project only (403 otherwise: job_cancel stays out of the Studio); a cancel during the inline review
keeps the render. **`render_review {project, render_id}`** — `reviews.get` reduced: verdict, counts, findings (severity,
code, `at`), durations, the diff's summary, the contact sheets by file name (`image`, `label`; REVIEW_IMAGE_RE
`sheet_…jpg`), the findings' messages and a failed review's message under `untrusted` — no `dir`, `files`, filmed
environment or path. **`review_image {project, render_id, image}`** (critique B16) — a NAME of review/<id>/ (400 for
anything else), the folder inside the project once links are resolved, the file opened with O_NOFOLLOW, regular, ≤ 8 MB,
starting `FF D8 FF`; scaled in memory (sharp, review's `./thumbs` entry) to ≤ 1600 px and ≤ 2,000,000 base64 characters
(else 1100 px, q 70, else refused). **The app:** the timeline header's Render bar (Render — "Render the take as
captured" when the edit comes from the run — off while a render of the scenario is unfinished, with why; the newest job
in one live line with a `<progress>`; else "Latest: v3 · 2 warnings · from this version"); the Renders card under the
tracks and on the scenario screen (Render on the newest finished capture and the file's hash): the queue with Cancel
("Stop the review" while it reviews), the failure, the renders (5, then "Show all"), each "from this version" (same run,
same edit sha256, same theme), "from an earlier version", "the take as captured" or "of another capture", and its review
badge; **Show the review** (and by itself once a render this tab queued is reviewed): the verdict, the findings (message
through `Txt`; **Show in the preview** seeks the timeline only when the render is of the version shown), the contact
sheets one after another through Thumb.tsx's one `<img>` (`Jpeg`, now shared: `jpegDataUrl(base64, max)` with `max` one
of THUMB_DATA_MAX / SHEET_DATA_MAX = 2,000,000 — a type and a lint rule: every `<Jpeg` names one literally), larger on
click. **Events:** the Live poll's `workspace` event gains `renders` (the projects whose renders/ folder changed); the
list reads again for a job it shows, a job id the tab never saw, its project's `renders`, or a resync — at most once a
second (a running render's progress: one `scenario_renders` a second; a capture's progress: nothing).

**Measured (part E, this Mac).** Engine, through the worker in-process: submit + render (half scale, a 2 s synthetic take)
+ inline review at 1 fps: 8.4 s with the shared bundle cache warm. Chromium e2e (a 2 s VP9 take, 1920×1080, the worker run
in the test): from the worker's start to the review's verdict on screen 4.0–4.6 s; states seen in the page: queued,
running; the contact sheet decoded (2 tiles, 1 fps).

**Measured (part B, this Mac).** Go / no-go (critique B17, before the server): the real bundle — Player, DemoVideo, the
41 built-ins, 8 scaffolds, Lottie — on the fixture's quote timeline plus a Lottie card (a VP9 copy of a synthetic
capture), in Playwright's Chromium 141 under the frame CSP in an opaque `sandbox="allow-scripts"` frame: intro, clip,
Lottie card, card, interstitial and outro drawn; the editorial fonts loaded through FontFace CORS with `Origin: null`;
the Lottie JSON fetched under `connect-src`; 0 CSP violations, 0 errors; plan.json 18.7 KB. The real bundle: 1,043,579
bytes (boot.js 418), 128 ms to build, 14 ms to re-hash on a memo hit; 49 lazy imports. The sandbox e2e: the positive
control's allowed fetch read the 62,284-byte font; 36 channels from the component and 3 navigations blocked; 0 hits on a third loopback port,
0 STUN packets, 0 cross-site requests on the Studio, 0 ops; under a 100,000-message flood on `window` and then on a
stolen port, the page's 20 ms timer stayed under 200 ms and the preview stopped.

**Measured (part A, this Mac, load ≈ 2–2.5).** `timeline.view` on a synthetic 3-segment take: 62–65 ms cold, 1.9 ms
from the memo; a switch (the `set_field` write — the registry memoised too — and the view the screen reads after it)
median 11 ms, p95 17 ms over 10; the fixture's `quote` timeline: 95–99 ms cold (planning 68–72 ms), 7.7–8.7 ms from the
memo, view 17 KB (plan 22 KB); a synthetic 4-minute take (8 scenes, 96 steps, 7,080 frames): 67–69 ms cold, a switch
37–39 ms, view 25 KB, plan 58 KB. The budget of "shows in the preview within a second" is therefore the preview's own
part (parts B–C): the write plus the view stay under 100 ms (the tests allow 1.5 s / 3 s under load).

**Acceptance (part F, this Mac, 2026-10-27).** The built `retake ui` (`--json --no-open`) on a scratch copy of the
fixture workspace (its own fixture on 4471–4474, a scratch `RETAKE_HOME`), driven in the installed Google Chrome
156 (Playwright `channel: 'chrome'`, a temporary profile, 1600×1000 at device scale 2), the worker spawned by the
Studio itself (`started by the Studio`): Capture of `highlights` from the scenario screen — run
`20261027-045015-highlights`, 15.9 s; **Open timeline**: tracks 230 ms after the click (`timeline_view` 141 ms on the
wire), the first frame settled 312 ms after the tracks; 1,365 frames, 10 segments, H.264 (VideoToolbox, keyframes every
0.4 s, no B-frames), no "cannot play". Ten scrubber jumps across the take: seek → settled median 109 ms, p95 114 ms,
max 160 ms; ten one-frame steps: median 108 ms, max 112 ms. Playback 4 s from the start: 119 frames, 29.7 frames / s of
30, no warning. Scene `quotes` → **Laptop**: one line (`    frame: laptop`), the preview settled on it 132 ms after the
click (mean absolute difference of the preview 22.4 / 255 against the frame before: the bezel and the theme around it);
**Caption band** (`caption_component: studio/caption-overlay`, one more line): 115 ms, the caption drawn as a band over
the capture (difference 5.6); ⌘Z twice: the file `cmp`-identical to the original, the preview pixel-identical to the
frame before the switches. **Render** from the timeline: queued, running ("preparing the components 2 %"), reviewing,
then v1 with its verdict 45.7 s after the click (a 45.5 s 1920×1080 render, 5.0 MB): 3 warnings (`card-too-short` on
figure, testimonial, cta — the fixture's own short cards), 1 note (`video-length`), "from this version"; the contact
sheet decoded (1600 px wide), larger on click. 0 CSP violations, 0 console errors. The default caption of the editorial
theme is already `studio/caption-below`: choosing **Caption below** writes a line and changes no pixel (correct: the
inspector's "Theme default" names no component, BL-107's previews would show it).

**Preview versus render (part F, R-UI-25).** Same plan (the file undone to the take's bytes), same frames: the preview
cut out of a device-scale-2 screenshot of the frame (1564×880; 1.5 % cropped on each side: the rounded corners), against `renderStills` of the
plan (1920×1080 PNG, scaled down by area) and the frame of the encoded render `highlights-v1.mp4`. Mean absolute
difference (0–255) / pixels whose largest channel differs by more than 48:

| frame | what | preview vs renderStill | preview vs render | renderStill vs render |
|---|---|---|---|---|
| 48 | intro | 1.11 / 0.69 % | 1.50 / 0.70 % | 0.66 / 0 % |
| 137 | clip (coffees, card layout) | 7.01 / 3.06 % | 6.97 / 3.03 % | 0.96 / 0 % |
| 295 | caption (quotes) | 4.22 / 1.32 % | 3.93 / 1.32 % | 0.75 / 0 % |
| 561 | card (key figure, counted up) | 1.06 / 0.55 % | 1.46 / 0.56 % | 0.67 / 0 % |
| 776 | card (features) | 1.83 / 1.14 % | 2.24 / 1.13 % | 0.71 / 0 % |
| 1320 | outro | 0.60 / 0.20 % | 0.99 / 0.19 % | 0.66 / 0 % |

Looked at (amplified difference pictures): the same source frame of the capture (the cursor at the same place), the
same layout, caption, card text, fonts and animation step everywhere; the differences outside the capture are edges
only — text antialiasing at the preview's scale (the Player draws the 1920×1080 composition scaled by CSS, the still is
rasterised at full size then scaled) and a registration of about one device pixel (the frame sits at a fractional CSS
position). Inside the capture there is one real difference: **its colours** — the preview draws the capture ≈ 3–4
levels brighter on near-white (247 245 239 against 243 242 235) and ≈ 10 on mid-tones (152 112 75 against 142 102 66),
while the theme's background around it differs by ≤ 2. The two decode the same bt709 limited-range H.264 (no transfer
or primaries tag) through different paths — Chrome's `<video>` in the preview, the render's frame extraction — and the
preview's near-white is the closer to the page's own CSS colour (#f7f3ee = 247 243 238). Not a plan difference; BL-108.

**Review fixes (after parts A–F; two independent reviews).** Isolation (review A):
- *Chrome's prerender ignores a frame's CSP and sandbox* (installed Chrome and Playwright's `chromium` channel; the
  headless shell sends nothing): a `<link rel="prerender">` made in the frame — in its head or body, by
  insertAdjacentHTML, setAttribute or relList — had Chrome fetch an arbitrary URL (the frame's own capability path
  in the query) and resolve an arbitrary host name. Three layers now: (a) `boot.ts` refuses the token everywhere an
  element gets a `rel` (the property, DOMTokenList add / toggle / replace / value, setAttribute(NS),
  setAttributeNode(NS), NamedNodeMap.setNamedItem(NS), an Attr's value / nodeValue / textContent — originals and the
  built-ins the checks use captured first, values converted once, every pin non-configurable), removes XSLTProcessor,
  a document-typed XMLHttpRequest, execCommand('insertHTML'), setHTML / parseHTML, and refuses to create elements that
  make a child browsing context (iframe, frame, object, embed, fencedframe, portal) or to define custom elements;
  (b) the frame CSP requires Trusted Types with no policy (`require-trusted-types-for 'script'; trusted-types 'none'`):
  innerHTML, insertAdjacentHTML, document.write, DOMParser, createContextualFragment, srcdoc, a script's src and a
  Worker's URL throw — the Player, DemoVideo, every built-in and Lottie use none of them (the sandbox e2e still draws
  them, 0 errors); (c) **structural**: a workspace component (anything not built in) runs in the preview only after the
  person allowed it in this Studio session — `preview_allow {id, hash}` (the timeline's *Allow in the preview* button,
  naming the component and its folder content hash, editor `componentFolderHash`); the allow-list (ui
  `server/preview-allow.ts`) is in the Studio server's memory only, keyed by content, cleared on restart, never
  persisted, reached by no MCP tool or engine call. Until then the component is `held`: not in the frame's bundle at
  all (`PlayerBundles.get(registry, allowed)`), its uses drawn with their kind's stand-in, the timeline naming it
  (`timeline_view.preview_held`). Built-in components always run.
- *A child frame* (srcdoc, about:blank) was a fresh realm with none of boot.js's pins (review A L2): Trusted Types close
  srcdoc, boot.js refuses frame elements, and the bundle starts (renders, says hello) only in the frame document — its
  capability path, a direct child of the Studio page.
- *One capability for the whole Studio, never rotated* (L3): the player origin now keeps a capability per scope — the
  Studio scopes by project (`publish(…, {scope: project})`), so a page of one project never holds URLs of another's
  files. A timeline page holds a lease (`timeline_view {lease}`) and gives it back when it leaves (`timeline_leave`);
  the last lease of a project leaving releases its scope (every URL 404; the next view gets a new capability); leases
  of tabs closed without leaving lapse after two hours. `/m/` answers CORS with `Access-Control-Allow-Origin: null`
  (the frame's opaque origin, not `*`): fonts, the plan and Lottie JSON still load.
- *Hard links* (N4) passed every path check: the player origin refuses a file with more than one name (at registration
  and at every read), as do `review_image` and planRun's trust gate 2.

Correctness (review B):
- *"From this version"* (H1) compared the file, the capture and the theme name only: a `retake render --no-intro
  --scale 0.25` of the same file was labelled "this version" and its findings seeked the wrong segments. The render
  list now carries each render's plan signature (`planSignature`: the record's plan without notes and warnings,
  canonical JSON, sha256) and theme folder content hash (`template_sha256`, written in the render record:
  editor `theme-hash.ts`), the timeline view carries its own (`plan_sha256`, `theme_sha256`), and on the timeline only
  equal ones are "this version" (*with other options* / *with other theme or project settings* otherwise). The Studio
  render's real plan equals the view's (render e2e). The scenario screen (no plan shown) also requires landscape and
  no option beyond the files'.
- *The intro / outro switch* (H2) deleted a tagline or an image with the map: core refuses `intro` / `outro` switches
  over a map holding more than a component and a duration, and the inspector shows that switch disabled with why.
- *The view memo* (H3 / A N6) missed theme and project files: project.yaml joins the key, and on every hit the theme
  folder's files (names, sizes, mtimes) and every file the plan serves are re-stat'ed — a change plans again.
- *Cut reasons* (M4): the planner records why it cut on each trim (`TrimSpan.reason`); for other time-map jumps a page
  load, a frozen screen, a busy wait or a hook covering any of the skipped time wins over idle.
- *Comment pins* (M5): a thread made on a render whose plan and theme match the shown version is pinned at its own
  frame; any other at its step, marker or segment, as before.
- *A failed render* (M6) showed a raw stack: its message is its first line with every absolute path cut to its file
  name (`failureWords`), in the Renders card and the Render bar (which no longer shows an older render's "Latest").
- Smaller: a picked segment lands after the transition into it; the video's layout offers split / pip when a scene
  films several pages and says when a one-page layout would change none; a filmed change names steps 1-based; "0.0 s
  skipped" reads "under 0.1 s"; the notice of a take without a snapshot says "Switches are off for this take"; the
  review panel shows scene sheets, key frames and the diff too (at most 24 images); the app bundle budget is 430 KB
  (≈ 415 KB).

## 4h. Record screen (L4.8; L5.11b: in the shell, on the kit — the last paragraph)

R-UI-20…22: record a scenario from the Studio by clicking through the product, pick a step's target among verified
alternatives, add quick inserts while recording. Built in six parts (the lot's plan and its critique B1–B17, C1–C7
apply): **1 — core generator and annotations** and **2 — kit and runner alternatives** (§3.11, §3.12), **3 — engine**
and **4 — the Studio server's ops** (§3.13), **5 — the screen**, **6 — docs and acceptance**. Cuts: BL-118 (thumbnails
per step, a live picture of the window, controls inside it, editing before Save, a re-check after later changes, more
alternatives, choices and inserts through MCP), BL-119 (CLI / MCP drafts written with YAML anchors — a Studio draft has
none), BL-25 (recording through the live picture, with the reasons it was not built). The two reviews' findings (trust
A-M1…A-L3, screen B-H1…B-L8) are folded into §3.12, §3.13 and this section.

**The person clicks in a real window.** A Studio recording is L3.4's `record` job submitted by the `ui` client: the
worker opens the headed window on this Mac, full size (maximised, as L3.4: the desktop layout is what the video films;
never "side by side"), and the person clicks and types there. The Studio is its control panel and nothing on the screen
reaches the window: no input is forwarded, no live picture is shown. The recorder, its masking and its isolated world
are L3.4's, unchanged; the draft is made again from events.jsonl and studio.json on every read (§3.12 "Studio
annotations").

**Routes** (ui `app/route.ts`): `#/p/<project>/record` the start form, `#/p/<project>/record/<rec_id>` one recording.
Entry points: *Record a scenario* on the project page (the Scenarios card) and *Record a new scenario* on the scenario
screen. The project nav stays open on both.

**The start form** (`StartForm`, `record_options`): environment (production / read-only / sandbox warnings in words),
page, path (starts with `/`), persona with its stored session (*valid*, *expired*, … — no browser opens to read it) and
the Sessions panel's **Sign in** beside it, name (`recorded-YYYYMMDD-HHMM` by default, the same rules as Save); the
window note (a full-size window on this Mac, Cmd-Tab between it and the Studio, come back by its title bar — a click in
the page is recorded —, a Studio visit commits the typing, closing the window is Stop); the recording open in the
workspace (one window at a time: Start is disabled, with *Open it*); a persona that cannot sign in by itself (no valid
session, no `login:` steps, no sandbox) disables Start too, saying why beside it, with its Sign in; the project's
recent recordings (state, steps,
who started it, *saved as <name>*). **Start** sends a page and a path only (`record_start`; never a URL, never
`--allow-writes`, the check replay always on) and opens the recording's route.

**The recording** (`RecordingScreen` → `RecordingBody`, presentational): `record_view` every 700 ms while the recording
is live and the tab visible, every 3 s once it is over, and at once on a `workspace {records}` or `jobs` event; an
unchanged read sends `since` and gets `unchanged: true`. Before meta.json exists the view needs the job id: the tab
keeps the one `record_start` answered (an in-memory map); after a reload, `record_options.open` gives it; then the last
view's job (a discard removes the folder). A poll answer never replaces a newer one: an annotate answer makes the polls
already sent stale, and a view of an older revision is dropped (B-L1) — unless the server said the screen's revision
is stale (a 409), then its next view wins. The page
shows the state in words (*waiting for the worker*, *opening the window*, *recording*, *making the draft*, *checking the
draft*, *recorded*, …) with the time left, then:
- **The draft** — step rows by scene (`draftRows` over `untrusted.blocks` and `sources`): the recorder's helpers say
  *added by the recorder*, inserts are rows or chips *added by you* with **Remove**; under a step whose main target has
  offered alternatives, a disclosure *Other targets: N verified* opens a radio group (a fieldset whose legend names the
  step; index 0 the recorder's suggestion; fragile ones say why); the checked radio follows the server's answer
  (*Target picked by you*), and a pick made on a click the typing later folded in shows on the typing step. The draft
  as YAML in a closed disclosure.
- **The draft cursor** — tab state, never stored: *at the end* (follows the next actions) or right *after a row*, keyed
  by the row's identity (`sources[].row`, never its index — review B-M1): it stays on that row while the draft
  regenerates (its words, *after step n of <scene>*, follow the row), moves onto a hold or a wait it adds (the next one
  goes right after it), and goes back to the end when its row is gone. An insert there is anchored to that row
  (B-H1): after an action or the recorder's scroll `{after_step_seq}`, after the recorder's wait `{after_step_seq,
  row: 'wait'}` (between the wait and its press), after an insert `{after_insert}`. Each row's **Insert after this
  step** is named *Insert after step n of <scene>* and keeps that name (its state in `aria-pressed`); **Back to the
  end**. A done change is said in the status line (*Hold added after step 2 of products*).
- **Quick inserts** at the cursor: **Hold 2 s**, **Mark**, **Zoom** (the view's `zoom.default`: min(1.5, the project
  theme's max_zoom) — never a factor the editor would clamp; hidden when the theme allows none), **Wait for…** (the
  next target, the page idle, a text), **Caption…** (text and kicker). Wait for and Caption are disclosures (Enter
  adds, Escape closes and gives the focus back to the button). A caption, a mark or a zoom made at the end while the
  recording goes on waits in *Applies to your next action* and goes on it.
- **The window** card — **Stop and keep** (`record_stop`: the window closes as if closed, the draft is made, then
  checked) and **Discard** (a confirmation whose first, focused button is *Keep it*); once over, **Save as scenario**
  (a name; a taken one says *choose another name* and nothing is written; Save sends the view's `draft_sha256` — a
  draft changed since is refused and read again) then the scenario screen; saved recordings are read-only with links
  to the scenario. The card is titled *The window* while it is open, then *Save* (or *Discard*). A Discard — of an
  open window too — ends on a neutral *Discarded* (no error notice; the *being discarded* note goes once it is over),
  and a cancel the Studio asked for is never shown as an error.
- Placeholders (`{{vars.<name>}}` names only, never a value), writes with the reset advice, issues by severity in words,
  the check (passed / failed / skipped) said honestly (B-M4): it replayed the recorded draft without the picks and
  inserts — its counts are *recorded steps*; its failing step is shown at its row on screen (`failed_row`), else as
  *recorded step n … not a row on screen any more*; the dry run after Save replays everything.
- A preflight refusal naming a persona not signed in shows the Sessions panel's **Sign in** for it (no empty draft
  card under it); a recording Claude or the CLI started is read-only (no Save, Discard, picks or inserts; Stop only
  while its job runs: none for a CLI recording) and says who started it; one whose origin cannot be verified, or
  *cannot be verified* (tampered), says so in fixed words.

**Page text only through `Txt`.** Every string from the draft, the page or a file (step labels, targets, alternatives'
words, inserts' text, issues, placeholders, writes, the check's failure, the YAML, names, notes, warnings) is rendered
by `Txt` (a `<bdi>` with direction controls shown as `[U+202E]`) or, in an attribute, by `visibleControls`;
`record-words.ts` never reads `untrusted` (its sentences hold enums, numbers and the Studio's own words). The SSR lint
in `app-source.test.ts` renders `RecordingBody` and `StartForm` to static markup with a hostile string in every field
and fails on any page string outside a `<bdi>` (bare text, an `<option>`) or a raw direction control; the e2e records
the fixture's flagged page (`/record-lab?hostile=1`, a label with markup and a direction override) and checks no script
ran.

**Tests.** `studio-e2e-record.test.ts` (default suite, ≈ 19 s; Studio server, headless Chromium, an in-process worker
whose `recordTest.drive` plays the person in the window, fixture on 4551–4554): a pick that folds, a password sentinel,
a blur mid-word, each insert, Stop, Save (a taken name refused), the hostile page, Discard during the check, a
read-only recording, the sign-in mapping, the sentinel nowhere. `studio-e2e-record-acceptance.test.ts` (gated by
`RETAKE_TEST_SLOW=1`, ≈ 107 s; `RETAKE_TEST_HEADED=1` shows the window): the shop's quote flow recorded with
every insert and a pick, Stop, the check, Save, then a dry run, a capture and a render of the saved scenario from the
Studio — the plan has the caption from the picked click on, the zoom on it and the marker on the select; measured on
the Mac (2026-10-28): Stop → checked ≈ 10 s, Save 0.18 s, dry run ≈ 24 s, capture ≈ 24 s, render + review ≈ 37–41 s
for a 25 s video. The real window with a person switching to the Studio is MACOS-CHECKLIST 13i: `drive` is an
in-process hook, so no automated test has a person's Cmd-Tab.

**L5.11b — the Record screen in the shell** (« Épure » 3b, R4-Record, R-UI-44; every capability above is kept). The
screen is rebuilt on the kit (`RecordScreen.tsx`; ratchet −274: it left `test/legacy-controls.json`), its routes
unchanged. Built from the lot's plan corrected by its critique (H1 the command priorities, M7 one Stop, L2 never a
capture of the remembered scenario from the Record route). Cuts: BL-131 (and BL-130's Show the window, Check replay).
- **Browser.** Shoot's (`ShootBrowser.tsx`): Prepare and the Runs while a scenario is in context (the status bar's
  shared `scenario_actions` entry: no second read), the **Recordings** group (record_options' `recent`, read on the
  route's open and again when the recording on screen changes state or is saved — never per poll; the open one shows
  its live state and actions from the screen's own view), Record a scenario. The start form no longer lists them.
- **The start form** in the centre: Location / Page / Persona as kit Selects, Path / Name as TextFields with
  `unsaved: null` (a start form is nobody's work: no quit question), the rest as before. Start stays enabled while it
  is sent (a repeat is said, never sent: a disabled button would drop the focus), a refusal takes the focus, the new
  recording's title takes it when its route opens.
- **A recording.** The draft rows are the kit's compact RowCards — options of a listbox since the fixes below:
  pressing one IS the draft cursor
  (a selected row = inserts go right after it; pressed again, or Back to the end = at the end), so the selection and the
  cursor are one state, keyed by the row's identity as before. Under the selected row: its verified alternatives (a
  kit RadioGroup, the recorder's suggestion marked) and the Insert toolbar (a kit Toolbar: Hold 2 s, Wait for…,
  Caption…, Mark, Zoom… — a radio of `zoom.options`, the theme's maximum marked —, Back to the end; the forms open under
  it, Enter adds, Escape closes and gives the focus back). A row with alternatives says "n alternatives" or "Target
  picked by you" on its right; an insert row is set in, its modifiers are chips (their Remove: the cursor block). The
  inspector (through
  the shell's slot, shown in place when hidden; `RecordingBody` renders it, so the SSR lint sees it): Started with
  (facts + the Name Save uses), the selected step (facts + Add after this step, which focuses the toolbar), Stop
  recording / Save as new scenario (disabled with why until the check is over) / Discard (the kit's Sheet, destructive:
  "Keep it" is the default and the cancel — Return or Escape keeps it), Check, To look at, Secret fields, Writes,
  Warnings. Every state, check and note callout carries a state word (the colour-only rule; the checker's vocabulary
  gained "recorded" and "discarded").
- **The status bar and the commands.** While the recording goes (`LIVE_STATES`, queued → check) the screen claims the
  actions slot — "Recording · browser window open" (or the state), "n actions · n inserts · draft updated …" — and the
  status bar's own scenario line steps aside on that route. It owns the four Scenario commands at
  `PRIORITY.recording` from the route's first paint (`live` is true until the view says otherwise or the read fails):
  ⌘. stops this recording (`record_stop`; before the view is read it says to wait; a stop already asked, a terminal's
  recording or a recording past its window each say so) — never a run of the scenario in context, a reload included;
  Rehearse / Capture / Render say why they wait and send nothing. Once it is over the defaults (naming their scenario)
  take the commands and the slot back. The one Stop visible is the inspector's (critique M7; the head's while the
  inspector is hidden).
- **Words and focus.** State changes after the screen opened and each change made are said through the shell's polite
  line (`shell/say.ts`; keyed per recording, so a line of the start form never outlives it); the sr-only status line of
  L4.8 is gone. A focused control that disappears or turns disabled (Stop, Discard, a removed insert, the toolbar
  moving onto a new hold) hands the focus to its replacement by test id, else to the title; after Save the shell's
  centre pane holds it.
- **Tests.** `studio-e2e-record.test.ts` (8, migrated: the row pressed for the alternatives, Zoom…, the Recordings group;
  new: Rehearse / Capture / Render refused while recording with nothing sent, ⌘. after a reload calls `record_stop` and
  no run op, the Discard sheet's Return and Escape send nothing and give the focus back, the focus after Discard and
  Save, the status bar's words and its one Stop); `studio-e2e-a11y-keyboard.test.ts` (the start form and a live
  recording with a row selected at dark 1280 / 1440 / 900 and light 1280; done; the Discard sheet walked);
  `app-source.test.ts` (the SSR lint renders the body with its inspector in place; RecordScreen kit-only and Txt-only,
  each with a planted mutation; its ops and its command priorities); `kit-static.test.ts` (RadioGroup, compact
  RowCard); `record-app.test.ts` (every recording state a mark and a state word).
- **Fixes after the two reviews.** *The draft is one tab stop* (A-M2): each scene's rows are a kit `RowList` listbox
  (`aria-activedescendant`; the list holding the active row is the tab stop, the others `-1`) of `RowCard` options — ↑ /
  ↓ the row before / after across scenes, Home / End, Page Up / Page Down (board-keys' `gridMove`, one column), Enter /
  Space select the active row (= the cursor after it; again: back to the end); Stop is a few Tabs from the title
  whatever the draft's length. The cursor block is a `group` between the options (never counted as a row: A-L3) holding
  the selected row's own Remove buttons (an insert row's, its modifiers' — the rows show those as text), its
  alternatives and the Insert toolbar; at the end it sits after every scene, in one place. *One change in flight*
  (A-M1 / A-L6): the radio shows the pick asked for at once while it is saved; a newer pick of the same step waits and
  replaces an older one waiting; Stop and Discard wait for the change being written (said) and go right after; an
  insert, a Remove or Save asked meanwhile is refused and said; a change that waited reads the newest view's revision.
  *Nothing typed is lost* (A-L7 / B-L4): the open insert form and the Name Save uses live in the recording's body, not
  in the cursor block or the inspector (React mounts the inspector again when it moves between its pane and the centre:
  a slot that moved a DOM box instead would build DOM outside JSX, which the app's source lint refuses), and the Discard
  sheet is outside the inspector; the focus keeper puts the focus back on a field by its test id (a radio by its
  value). With the inspector hidden, the one Stop is in the head beside the time. *The palette* (A-M2 / A-L1): while a
  recording goes its Scenario group is the recording's — "Stop recording" (or Cancel) and "Discard…", named after the
  recording (command-bus `useScenarioGroup`), with or without a scenario in context, never naming that scenario. *Words*:
  Save's reason per state (B-M2: "Saving opens after Stop…" while the window is open, "…once the check is over" while
  the draft is made and checked — `saveWhyWords`); Enter in Name while Save cannot go says why (A-L4); an info note is a
  status, a refusal or failure an alert, and the start refusal is said once, by the focus (A-L5). A compact row's aside
  wraps under its text in a list narrower than 560 px and a word is never broken (A-L2). The Recordings group says a
  recording's location and step count again and links a saved one's scenario (B-L6). The commands' ownership stays per
  route (A-L8, by design): on the start form or Prepare, one click from a live recording, the status bar's defaults act
  on the scenario in context. Tests: `studio-e2e-record-keys.test.ts` (12, the record ops answered by the test: a view
  held back, a save held back, any state and length).

## 4i. The Studio's identity and accessibility (L4.9)

R-UI-02, R-UI-03, R-ACC4-01. A pass, not a redesign: the L4.1 contract (tokens, 4.5:1, words on badges, focus rings)
made checked by a machine, the gaps it found fixed, the palette closed, the Geist pair named, and the one end-to-end
acceptance SPEC §14.4 asks for. Built in five parts (A checker, B fixes / palette / lints, C tours, D acceptance, E docs)
from the lot's plan corrected by its critique (H1–H4, M1–M6). Cuts: BL-120 (the Geist files), BL-121 (Safari / Firefox
automated), BL-122 (accessibility beyond the pass).

**A closed palette.** Every colour of the Studio is a token of `:root` in `packages/ui/src/app/app.css` (≈ 70, in
families: surfaces and neutral tints, text, lines, the one blue accent, four status families, one categorical violet
for input actions and card segments, video surfaces / tooltips / marks); rules use `var(--…)` only. The move kept every
value: a computed-style snapshot of every tour state before and after (colours, borders, outlines, shadows, opacity,
placeholders — scratch, not committed) differed only by the fixes below and the fonts. The live picture's letterbox
reads `--ink` (LiveView.tsx). Theme colours appear only in swatches, posters and the sandboxed preview: the chrome never
reads a theme. Rules stated in app.css's header: one accent, the only interactive or selected colour; status colours
always with words; the violet never means "interactive"; dark tokens for video and tooltips only.

**Fonts.** `--font: 'Geist', -apple-system, …, sans-serif` and `--mono: 'Geist Mono', ui-monospace, …, monospace`,
by local family name only (no `@font-face`, no file, no network). A Mac with the fonts installed shows them in Chrome and
Firefox (this one has Geist Mono, not Geist); Safari never exposes installed fonts to a page. Text widths, and so a
layout's overflow verdict, can differ per machine until the files are bundled (BL-120).
*L5.9:* bundled — the official variable woff2 pair in `packages/ui/fonts` with its SIL OFL 1.1 `LICENSE.txt` beside it
(unmodified), declared by tokens.css's two `@font-face` (`font-display: swap`), served from memory by the Studio's own
origin (§4k); the palette moved to `tokens.ts` (one file, dark and light); app.css is the `legacy` cascade layer.

**Fixes the checks found.** `::placeholder { color: var(--muted); opacity: 1 }` (WebKit's default read 2.35:1 on the
three search fields; Firefox's adds opacity .54). The theme editor's hidden `legend` widened the page at 1280 and 1440:
`.chips legend { width: 100% }` beat `.sr-only` on specificity — now `.chips legend:not(.sr-only)`, and `.sr-only`
gained `margin: -1px; padding: 0; border: 0; clip-path: inset(50%)`. The proposal diff's whitespace marks (`.pd-mark`,
`#8a6d00` at opacity .85 ≈ 3.7:1) → `--warning`, opaque. The timeline's selected segment hid its focus ring (its
selection outline overrode `:focus-visible`): focused and selected now shows the ring outside, the selection inside.
The selected state, colour alone until the review (a tint and a 1.6:1 border): the selected step, the current run step
and the current thread row get a 3 px `--accent` bar inside on the left (5:1), a filter chip a 2 px accent edge (its
border and an inset line), a pressed button (`aria-pressed`: the timeline zoom, the step palette, a contact sheet) an
accent border and inset line; the nav link (weight 600), the tab (a 2 px underline), the timeline radio (weight and a
filled dot) and segment (an inside outline and weight) already had one. Accepted below 4.5:1, transient or inactive
only (stated in app.css, a lint holds opacity to these five): disabled controls (.5), a dragged step (.45), the steps
during a write (.75; L5.9 review A-L2: replaced by a dashed `--busy-edge`, the text unfaded — four states since), a
switched-off timeline group (.55, its radios `aria-disabled`), an unset colour well (.35, no text). The 1.5:1 field borders (`--line-strong`) are accepted: every field has a visible label, the border is not the
only way to find it (WCAG 1.4.11 asks 3:1 only of what identifies a control).

**The checker** (`packages/ui/test/a11y.ts`, a test helper, no dependency; unit tests `a11y-checker.test.ts`, each rule
fired by a planted case and silent on its twin, its maths = `contrastRatio`'s; the review's probes it now catches are among them, the others are BL-122):
- `contrast` — every visible text node's element, every control's value (a submit button's too) and every quoted
  `::before` / `::after` content against what is painted under it: every ancestor's background composited from the page
  up, each ancestor's opacity applied as a group (the text and what is under it faded together over what lies below —
  a dark card at .5 over white reads ≈ 3.4:1, not 17:1); a gradient counts its worst stop; an image background is
  *unmeasured* (counted, budgeted per station, never passed); a colour the checker cannot read (`oklch()`, `lab()` …;
  `color(srgb …)`, what `color-mix()` computes to, is read) is a finding, never transparent; media (`img`, `video`,
  `canvas`, `iframe`) inside the text's opaque box and under it (`elementsFromPoint` when on screen) → only the layers
  above the media, composited over black and over white, the worse kept (no translucent layer between → unmeasured).
  4.5:1, 3:1 at 24 px or 18.66 px bold. Exempt and counted (a budget per station: 10 by default): the text of a
  disabled control itself — never the rest of a disabled container.
- `placeholder` — the field's `::placeholder` colour times its own opacity, on the field's background.
- `name` — Chromium's accessibility tree (CDP): a control role with no name, or named only by its placeholder or title;
  in the page: a focusable element inside `aria-hidden`, an `<img>` with no `alt`.
- `reachable` — an interactive role (native or not) with tabIndex < 0 that is not the item of a composite whose tab
  stop is one of its own items, or the composite itself with an `aria-activedescendant` inside it (an unrelated
  `tabindex="0"` in the group does not count). Composites of one family (same role and class, each script-focusable)
  sharing one stop — the scenes' step lists — are listed, and `familyWalk` proves with ArrowDown that the stop reaches
  every group of the family.
- `focus-ring` (`tabWalk`) — Tab from the top (inside an open modal dialog: its own controls) until it comes back to a
  stop; each stop must show a real indicator, focused vs blurred, on the element if visible, its active option or its two
  nearest visible ancestors: outline, shadow or border parts of ≥ 3:1 against what they are drawn on (an outline outside
  the box on what is around it; a border also against its unfocused colour) adding up to ≥ 2 CSS px, or a background
  change of ≥ 3:1; the browser's own `auto` ring passes. A transparent outline, a 1.1:1 shadow, a 1 % tint, a parent
  tint fail. The focused element must not be entirely covered (its centre and four inner corners under another
  element). Text shown only while focused (a pin's tooltip) is contrast-checked then. A walk that reaches its cap (400
  stops by default, per station; the largest screen, the library, has 104) without coming back is a finding (`walk`).
- `colour-only` — the status families (every `:root` token named `--danger*`, `--warning*`, `--info*`, `--success*`,
  `--online*`: soft, line and mark tones too) on a background, border, outline, shadow, the colour of a glyph-only text,
  or a `::before` / `::after`: a mark with no letters needs a state word (the badges' vocabulary — failed, running,
  connected, ended, added …) in its own or its row's visible text — never any word, and a label only a screen reader
  hears is no word for a sighted person who cannot tell the colours apart; a glyph other than a dot (◆, ✂, ·, ✓)
  says it by its shape. A row (table, list, listbox) that differs from its siblings by a status colour starts with a
  sign (+ − ✓ ✗ …) or says a state word: a diff row keeps its +/−.
- `selected` — every selected, current, pressed or checked state (`aria-selected`, `aria-pressed`, `aria-checked` off
  native inputs, `aria-current` on a link or control, the classes `selected`, `is-selected`, `current`, `is-current`,
  `is-checked`) is compared with an unselected peer (same tag, role and first class, up to four levels up; not one
  holding the focus): it must differ by more than colour — a weight ≥ 200 heavier, an underline, a mark (border, outline,
  shadow) ≥ 2 px thicker on one side at ≥ 3:1 against both backgrounds, a fill ≥ 3:1 from the peer's, a
  `::before` / `::after` marker or a marker child — on itself or its matching children, two levels down.
- `headings` (one level-1 heading, `h1` or `role="heading"`, hidden ones not counted; no level skipped) and `overflow`
  (no sideways scroll of the page or of `main`).
- `dialogCheck` — a native dialog is modal (`:modal`: `showModal()`, not `show()`), takes focus on open, closes on
  Escape and gives focus back to its opener.
- `settle` — a station is audited once nothing says it is loading (`aria-busy`, `data-loading="yes"`, a `role="status"`
  starting "Loading"), within 30 s; still loading then is a finding, not a half audit.
Limits (BL-122): Chromium only (CDP); over media only black and white are composited; hover-only content is not
reached; `filter`, `mix-blend-mode`, `-webkit-text-fill-color`, `display: contents` text, a dark sibling layer painted
under the text (not an ancestor) and text clipped by an `overflow: hidden` panel are not measured; label-in-name is not
checked; a ring clipped by an `overflow: hidden` ancestor still counts.

**Static lints** (`app-source.test.ts`, the main contrast guarantee for the pairs it can see): no colour literal outside
`:root` (hex, colour functions, named colours; values only, comments stripped), no `var()` fallback, no URL or
`@font-face`; every `var(--x)` of app.css and the app sources defined (any custom-property character: `--accent_strong`
is not read as `--accent`), every token used; colour literals in the app's TypeScript (hex of 3, 4, 6 or 8 digits, colour
functions, named colours) only in the theme editor's defaults (theme data); the Geist pair first and every font
declaration through the two tokens; every text token × every background it may sit on ≥ 4.5:1 (translucent backgrounds
composited — over every grey for the veils laid on video), marks ≥ 3:1 (the focus ring, the comment region on video,
the status dots), every pair a rule declares together, every `color` token classified as text and every background
token classified — static for the pairs within each set and within one rule; a text token on an ancestor's background
of another set is the tours' to measure; the one `::placeholder` rule; no outline removed (`none`, `0`, `hidden`,
`!important` too), made transparent (`outline-color: transparent`, a transparent outline anywhere) without a ring in its
place, and every focus ring (`:focus`, `:focus-visible`, `:focus-within`) drawn in `--accent` or `--accent-strong` (the
skip link's target `main:focus` excepted); opacity below 1 only on the five accepted states (four since L5.9); a TypeScript-parser pass
over every `.tsx`: a user-input handler (any `on…` but focus, change, form, load and media events — `onClickCapture`,
`onContextMenu`, `onWheel`, drag and drop included) only on a native control (`button`, `input`, `select`, `textarea`,
`summary`, `a` with a real `href`) or an element with a control role, a literal or roving tabIndex 0 and, for a click,
a key handler — five reasoned exceptions keyed by their exact attributes and source line (the comment frame's region
drag, the step options of the listbox, the empty scene's drop target, the timeline's radio group keys, the record insert
form's Escape) — no spread onto a non-native element (Txt's typed `aria-current` excepted), no `<a>` without a real
`href`, no positive tabIndex.

**The tours** (default suite, Chromium; `a11y-tour.ts` sets up a scratch workspace: the fixture project with its failed
dry run, the synthetic bits take with a render, two threads (one with a region and Claude's proposal — an in-process
`mcp` engine, as `comment_reply` makes one), a scenario that does not parse, a project whose persona cannot sign in by
itself, and the workspace's own editable theme `tour-theme`, a copy of editorial in its templates folder; whatever it
started is closed again when it throws). Every state is checked at 1280 and 1440 wide once settled, its Tab walk at
1280 (dialogs walked inside), the arrows across each shared tab stop; each must have no finding.
`studio-e2e-a11y.test.ts` (15 states, ≈ 15 s): projects, a project with its Sessions panel loaded (its rows), the
README's 409 conflict, blocks with a step selected, YAML, a YAML parse error, the run preflight, a failed dry run, the
capture's sessions confirmation (dialog), blocks of a take with its inspector, the timeline with a segment selected,
Comments (a list with the viewer, a thread with its region and the proposal's diff, none yet), the timeline previewing
the proposal (its switches off: an exempt budget of 45). `studio-e2e-a11y-keyboard.test.ts` (9 states + the keyboard
path, ≈ 20 s; the fixture on free ports): the Record start form, a recording live with its draft (the record job
in-process, Playwright playing the window), done, its Discard dialog; the library (every card walked: 104 stops) and its
Create with Claude dialog, a component once its About, Slots and Params have loaded, the themes, the theme editor on
`tour-theme` with its fields enabled (147 texts, 2 exempt, 66 Tab stops; read-only it showed 76 of 77 texts exempt and 26
stops; no sideways scroll at either width); then a keyboard-only path with a trusted-pointer counter at 0: Skip to content
→ demo → bits → the steps listbox (arrows select, the inspector follows) → Alt+↓ moves a step (the file changes exactly)
→ once the move has landed (Undo enabled) ⌘Z (exact bytes) → Open timeline → `]` / `[` → the Layout radios (arrows,
Space writes one line, the preview re-plans) → ⌘Z → Comments → the thread → a reply typed and sent (channel `studio`).
Not reached by either (gap of R-UI-03): a failed review verdict, a proposal stale or undone, hover-only tooltips,
posters loaded in the library.

**The R-ACC4-01 acceptance** (`studio-e2e-acceptance.test.ts`, gated by `RETAKE_TEST_SLOW=1` and
`RETAKE_TEST_CHROME=1`, Google Chrome installed; not in `pnpm test:slow`, like the other installed-Chrome tests):
the fixture product on free ports, the Studio starting its own worker (the lock's live worker killed at the end, its
start time checked), every action a click or a key: Projects → highlights → a hold changed in the inspector form
(exactly that line) → Dry run watched live → Capture → Open timeline → the quotes segment's layout switched (one line,
the preview settled on the same frame with other pixels; two "before" pictures first, ~0 % apart) → ⌘Z (exact bytes,
the view back on its first hash before the next click) → switched and kept → Render and its verdict (the wait fails
fast, with the job's phase, when the render job runs with no live worker or shows the same phase for 5 min; bound
600 s) → Comment at the playhead with a region typed in the four fields → Post (a `studio` thread) → a proposal (as
`comment_reply` makes one; no model) → Apply (exact bytes) → Resolve; the checker on all 11 stages at 1280 and on six
at 1440 (projects, blocks-edited, timeline, rendered, comment-composer, proposal): 17 audits. Its run on the Mac and the
frames looked at: `docs/requirements.json` (R-ACC4-01).

**By hand**: Safari, Firefox, VoiceOver and the keyboard in Safari (MACOS-CHECKLIST 13j). One WebKit run of 14 screens
from a cached Playwright build (`executablePath`, not committed: the build belongs to another tool) after the fixes:
1,624 texts, no contrast or placeholder failure, no sideways scroll; WebKit's page errors were Playwright's screenshot
style refused by the CSP and the sandboxed preview's Fullscreen permission message (BL-121).

## 4j. Desktop shell (L5.2)

`apps/desktop`: a Tauri 2.12 app (Rust; wry 0.57 / WKWebView) that shows the workspace's own Studio server. Not a pnpm
package and not in `tsc -b`: `scripts/desktop.mjs` runs cargo (`--locked`; `--offline` with CARGO_NET_OFFLINE=true).
MSRV 1.90 for the shell (Tauri's); the rules crate `apps/desktop/core` declares none (it needs Rust 1.70). The BACKLOG
guard-rail holds: the shell supervises and opens the same UI; its Rust is OS glue.

**Process model.**
- The app runs `node <cli> --root <workspace> ui --supervised` (`Command::new`, no shell; the child gets the app's
  environment, nothing added — a release build removes what makes Node.js or the linker load code: `NODE_OPTIONS`,
  `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `DYLD_*`, `LD_PRELOAD` / `LD_LIBRARY_PATH` / `LD_AUDIT`, which a Finder
  launch would take from `launchctl setenv` (review A L4; `desktop-core` `child_env_dropped`). Not an allow-list: an
  automated sign-in's `{{env:NAME}}` secrets reach the worker through that environment) with three pipes, reads its
  first stdout line (≤ 30 s, ≤ 64 KB) and checks it
  (`desktop-core` `parse_ui_line`: `type: "ui"`, `v: 2` (L5.2b; `retake ui --json` keeps `v: 1`) — another version is
  refused with the one to rebuild: an older CLI "run pnpm build, then pnpm desktop:build", a newer one "rebuild the app —
  pnpm desktop:build" (an app built before L5.2b refuses `v: 2` with its own "pnpm build (and pnpm desktop:build)"
  alert: never a hang), `url` exactly `http://127.0.0.1:<port>/#c=<43 chars>`, `player` exactly `http://127.0.0.1:<other
  port>`; no `player` = an older running server → refused with "stop it and open the workspace again").
- `--supervised` (cli `ui.ts`): `--json --no-open`, the stdin watcher installed before the server starts; stdin's end
  (or error), SIGTERM / SIGINT stop it through the same close path (ui.json released), then `stopped: <reason>` on
  stderr. After the line only the pipe lines below are written on stdout (console.log / info / debug go to stderr, the
  lines through stdout's own write captured first: critique M4); a parent gone is seen as stdin's end (EPIPE ignored).
  The signal handlers are installed before the line (a parent that signals as soon as it reads it meets them). Bytes
  on stdin are still read and discarded (BL-106's confirm will be the first inbound message). A folder that is no
  workspace prints `{"type":"error","v":2,"code":"no_workspace"}` before exiting 2 (review B L4: an older CLI without
  `--supervised` also exits 2, with no line — the app then says to run `pnpm build` and `pnpm desktop:build`).
- **Owned** (`reused: false`): the app holds the only write end of the child's stdin — the app's death (crash, SIGKILL)
  is the child's EOF. Quit (menu, ⌘Q, SIGTERM / SIGINT / SIGHUP through a self-pipe handler that asks the event loop
  to exit; the stop runs on `RunEvent::Exit`): SIGTERM, the stdin closed after 1 s if it still runs, SIGKILL at 5 s
  (`desktop-core` `stop_child`; `retake ui` stops in ≈ 10–20 ms on SIGTERM). An unexpected exit while owned → the
  window's allowed origins are emptied at once (review A L3: the freed ports may be bound by another local process,
  whose page a reload must not load), then an alert with its status and last stderr lines (8 KB, sanitised), Restart /
  Quit.
- **Attached** (`reused: true`: a terminal `retake ui` or another app serves the workspace): the child printed and
  exits; the app opens that server's Studio, never stops it and does not watch it (BL-125); a navigation to its
  origins once its pid is gone (`kill(pid, 0)`, `desktop-core` `navigation_decision` → `ServerGone`) is refused, the
  origins are emptied and the same Restart / Quit alert offers a server of the app's own (review A L3).
- **The shell holds no token and never reads ui.json**: it asks the CLI, whose reuse (`launchStudio`) mints a code
  through the token record in the Retake home; the one-time URL (valid 60 s, single use) is in the app's memory only, handed to the
  webview, never printed, never on a command line. The page keeps its token in its own sessionStorage.
- **Pipe lines (L5.2b, push).** After the `ui` line an owned server writes, one JSON object per line, ≤ 8 KB each,
  each framed by a newline before and after (review A L3: a stray partial write of another module on stdout becomes a
  line of its own, ignored, never glued to the next state; the shell skips blank lines silently) (ui `supervise.ts`): `{"type":"pending","jobs":[{kind,state,project,scenario?}…≤ 8],"jobs_total","unsaved":[{kind,
  project?,scenario?}…≤ 8],"unsaved_total"}` — what Quit would leave behind, whole, at start (after the job watch took
  stock) and on every change, coalesced (one write per 250 ms at most, a trailing write so the last state always lands,
  latest-wins while stdout is full: nothing queues) — and `{"type":"job_end","kind","outcome","reason"?,"project",
  "scenario"?}` once per job that ends while it runs (≤ 20 a minute; more counted on stderr). Push, not a question
  asked at Quit time: Quit with nothing pending decides from memory (a mutex read: instant, no round trip, no timeout),
  the snapshot is still there after the server died (the restart alert names the unsaved text), stdin stays
  inbound-free. Freshness: a Studio op that writes nudges the watch (a submit shows at once), a dirty report reaches
  the server on the first changed character and is pushed at once, a job Claude queued through MCP shows within the
  1 s poll. **Enums and slugs only**: job kind ∈ {capture, dry_run, render, review, export, recording,
  studio_recording, hooks, env_reset, sandbox_start, sandbox_reset} (one explicit table from the job kinds:
  `sandbox_up` is `sandbox_start`, a `record` job the Studio submitted is `studio_recording`), state ∈ {running,
  queued}, outcome ∈ {succeeded, failed, attention}, reason ∈ {run_failed, interrupted, review_issues, check_failed,
  ready_to_save, nothing_recorded, hooks_failed, reset_failed}, unsaved kind ∈ {readme, yaml_draft, step_form,
  comment, component_brief, new_theme, theme_draft}; project `^[a-z0-9][a-z0-9-]{0,99}$`, scenario
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$` — checked by the server (a hand-edited job.json is data: a name is sent only when
  it passes the rule AND names a project / scenario file that exists, review A L1) and again by the shell
  (`desktop-core` `pipe.rs`: an unknown enum drops the item but its total still counts, a bad slug drops the name,
  lists cut to 8). The lists are the same in TypeScript and Rust (a static test compares them: review B L8). No path,
  message, URL or page text crosses; the shell's words are its own (`words.rs`) — **enums, plus names that pass the
  slug rules**: a slug is still words someone chose (`Your_session_expired-…` is a valid scenario name), so the shell
  shows a name cut to 40 characters, as a name inside its own sentence, never as one. The shell reads each line through a capped reader (16 KB; a
  longer one is drained to its newline and marks the snapshot unreadable); a line that is no JSON object, an unknown
  `type` or a `job_end` it cannot word is ignored (said once: forward compatible, a stray print never poisons the
  snapshot); only a `pending` that fails its checks marks it unreadable — Quit then asks with generic words — until the
  next valid one. At the server's end its jobs are history (critique L2): the snapshot keeps only the unsaved text.
- **The job watch** (`Supervisor`, supervised and owned only): engine `JobsWatch` polled every 1 s for the server's
  life (not the event stream's: a hidden window may lose its stream) — it takes stock first, so jobs finished before
  the server started give no `job_end`; a job seen unfinished that reads finished, or a new one already finished, gives
  exactly one (ids remembered, ≤ 1 000). Jobs of the workspace's queue count — the quit question and notifications
  alike — whoever queued them: the Studio (any window or tab on this server) or Claude through MCP. The CLI queues
  none: `retake run` / `render` / `export` / `record` run in-process and write no job, so a terminal's capture is
  neither asked about nor notified (review B L1). Kinds that count: captures and dry runs, renders, reviews, exports,
  recordings, sandbox starts and resets, environment resets and hooks that are not dry; not `preview` (the library's posters), `auth_login`
  (the person is at its window), `inspect`, `site`. A queued job with no live worker is left out (critique M2: nothing
  runs it until the next submit starts one — it would hold Quit, and "keeps running" would be false). Outcome
  (`jobOutcome`): failed → failed; interrupted → failed / interrupted; cancelled → none (someone asked for it); a run
  whose own status failed → failed / run_failed (cancelled → none); a render with an inline review not clean, a review
  not clean → attention / review_issues; a recording: nothing recorded → attention / nothing_recorded, check failed →
  attention / check_failed, a Studio recording to save → attention / ready_to_save; hooks not ok → failed /
  hooks_failed; an environment reset not ok → failed / reset_failed (a rollback or a reset hook: review B L14);
  otherwise succeeded. Each live job is read once per poll (`JobsWatch.record`: a running job's read checks its worker
  with `ps`, review B L15); the event stream's own watch (`live.ts`) is a second reader while a page is open — one
  shared watch is BL-125. Not every end is a notification (review B L12): past 20 `job_end` lines a minute the rest
  are counted on the server's stderr only, so a summary can undercount a flood.
- **Unsaved text** (`unsaved.ts`, own op `unsaved_report` — in every Studio, harmless in a browser tab):
  `{tab: 22 base64url, hidden, items: ≤ 16 × {kind, project?, scenario?}}`, zod strict in its shape (an extra field
  such as a label is a 400; a name is any text ≤ 1 000 characters). The board keeps each tab session's latest report;
  names only for a project (`project.yaml`) and a scenario (`scenarios/<name>.yaml`) that pass the slug rules (≤ 100
  characters) and exist — a name that does not is dropped, the item kept (review A L4: one bad name never refuses the
  whole report; the page drops it before sending too); deduplicated across tabs; a new tab beyond 16 is refused
  (critique L3: never an older one evicted — the oldest report is the hidden app window's; the refused 17th tab retries
  every 5 s and is missing from the question meanwhile, review B L12). Reports of one tab apply in call order (reviews
  A M1 / B M3): each call takes the tab's next number on entry, and a report whose existence checks end after a newer
  call of its tab came is dropped — a report still checking when the `pagehide` empty report arrives never re-adds the
  tab. **A report never outlives its tab session**
  (critique L8, the simpler rule): an empty report clears it — the page sends one when its set empties and on
  `pagehide` (with `keepalive`), then sends nothing until `pageshow` (Chromium fires the unload's `visibilitychange`
  after `pagehide`: a report sent then could reach the server after the empty one) — and the board ends with its
  server; nothing expires by time (a hidden window's timers are throttled: a report that expired while the window sat
  closed would be the loss this exists to prevent). Worst case: a tab killed without `pagehide` (a WebContent crash)
  leaves one needless question until the server stops. The page (`unsaved-report.ts`) reports the drafts store's
  dirty README / scenario YAML and the **marks** of component-local text (`drafts.ts` `useUnsavedMark`: a step form's
  typed fields, the comments composer, a reply or a resolve / reopen note, the Library's "create a component" words,
  a changed new-theme form, a theme colour or background picked and not written — review B L7): kinds and names, never
  the text; on a
  change (one call in flight, the latest after it), on `visibilitychange` while not empty, nothing while nothing was
  ever unsaved. The browser's own `beforeunload` prompt stays the drafts' only (marks are not added to it). The Record
  screen's typed words are not marked (BL-125).
- The jobs worker is detached and shared (`retake mcp`, the CLI): Quit never stops it; it finishes and idle-exits.

**The window.** `WebviewUrl::External(<one-time URL>)` — not a Tauri custom protocol: the gate accepts only the
server's own Origin, the CSP's `connect-src 'self'` and `frame-src <player>` need the real loopback origins, and a
page under `devUrl` / `frontendDist` would be a Tauri *local* origin that reaches app commands without a capability.
- `.incognito(true)`: an ephemeral WebKit data store — no cache of capture media (the player serves them `immutable`),
  no per-port storage piling up (the port is new each launch), nothing in `~/Library` (tested). Nothing is lost: the
  token is in sessionStorage, the Studio uses no other storage.
- `.disable_drag_drop_handler()`: Tauri's handler answers every native drag without calling WebKit, which would kill
  the Studio's HTML5 block drag & drop (L4.3). Finder file drops go to WebKit, which the Studio ignores.
- `on_navigation` (wry asks for every frame): allowed = the Studio's and the player's exact origins
  (`desktop-core` `navigation_allowed`, on the serialised URL: lower-case scheme, `127.0.0.1`, the exact port, no
  userinfo) and `about:blank` / `about:srcdoc`; anything else is cancelled and logged by its origin. No new-window
  handler: wry's default refuses (`window.open` → null, `target=_blank` cancelled). Known residue (review A L1):
  tauri-runtime-wry's wrapper allows a URL it cannot parse (`url.parse().map(handler).unwrap_or(true)`) without
  asking the handler; no WebKit URL reaching it was found (an invalid-punycode host became `about:blank`).
- `on_download` answers false to every event (review A M1): without a download handler wry answers *Allow* to a
  response WebKit cannot show, and WebKit saved it into `~/Downloads` (probe of 2026-10-29: a Studio-origin
  `<a download>` and an attachment frame each wrote a file). With the handler, every download — `<a download>`, an
  attachment, the main frame or a frame — goes to wry's download delegate and is cancelled; the shell logs "refused a
  download of <origin>".
- `on_permission_request` denies everything (review A L2: wry grants a media-capture request when no handler is set),
  and the Info.plist names no camera / microphone / location use (WebKit then exposes no `navigator.mediaDevices`:
  probe). The server's Permissions-Policy header (§4c) is not relied on here: whether WKWebView enforces it is
  unverified.
- No IPC for the page: no `capabilities/`, no inline capability, no `#[tauri::command]`, no plugin, `withGlobalTauri`
  false (Tauri still injects `__TAURI_INTERNALS__`; every invoke is refused: probe of 2026-10-29). Devtools only in
  debug builds (the release build sets `tauri/custom-protocol`).
- Close / ⌘W hides the window (`CloseRequested` prevented; the page and its event stream stay); `RunEvent::Reopen`
  (the Dock icon) or Window › Show Studio Window (⌘0, review B M3) shows it. ⌘Tab back to the app with the window
  hidden shows none (an `NSApplicationDidBecomeActive` observer needs a block crate the shell does not depend on:
  BL-125). While hidden the page keeps its event stream, so the server's 1 s workspace poll and keepalive go on
  (BL-125: measure with App Nap). No Reload item (critique M1: WKWebView implements no `beforeunload` panel — wry's UI
  delegate has none; Quit, Open Workspace… and a restart ask through the quit guard since L5.2b, a Reload would need
  the same: BL-125).
- `--route '#/…'` (debug builds, or RETAKE_DESKTOP_TEST=1): once the page has removed `#c=` from its URL, the
  app sets `location.hash` (the only `.eval`; `route_ok`: `#/` + `[A-Za-z0-9/_.-]{0,200}`) — how the black-box test
  reaches a timeline without input automation.

**Workspace and launch config.** `--root` → RETAKE_ROOT → `<Retake home>/desktop.json` (`{version: 1,
workspace}`, 0600, written atomically after a start succeeded; Retake home as the CLI computes it) → the current
folder's `retake.yaml` → NSOpenPanel (folders only). The CLI's `no_workspace` line = not a workspace → the picker
again with that message; Cancel → quit (first launch only). File › Open Workspace… (review B M1) checks the folder
first (`desktop-core` `is_workspace`: a `retake.yaml` or a `projects/` folder, the CLI's rule): not a workspace → an
alert, nothing changes; otherwise the owned server stops before the next starts (never two), and a start that fails
or is cancelled reopens the previous workspace — Open Workspace… never quits the app.
`Contents/Resources/launch.json` (`{version: 1, node, cli}`, written by `desktop:build`: `stableNodePath(execPath)`,
the repository's `packages/cli/dist/bin.js`); `RETAKE_NODE` / `RETAKE_CLI` win in debug builds only (a
Finder launch never takes them from `launchctl setenv`); both absolute, regular files, else an alert with the fix.
Under RETAKE_DESKTOP_TEST=1 — honoured only when another process started the binary, never with launchd as its
parent (`getppid() == 1`: a Finder or Dock launch, which `launchctl setenv` could arm — review A L2; decided once at
launch, `desktop-core` `test_mode_allowed`) — no modal is ever shown (alerts print their text and their buttons' keys
and answer their cancel button — the last, the guard's Cancel, the restart alert's Not Now — or the next index of
RETAKE_DESKTOP_TEST_ANSWERS; the picker answers RETAKE_DESKTOP_TEST_PICK once, then cancels), SIGUSR1 is File › Open Workspace… and SIGUSR2 is Quit through `terminate:` (L5.2b: the ⌘Q path —
the gated test's ways to the menu without input automation), notifications are logged, never posted
(RETAKE_DESKTOP_TEST_FRONT=0|1 says whether the window counts as in front), and RETAKE_DESKTOP_TEST_MODAL_MS
shows an alert for real and aborts it after that delay (the same main-thread call as a signal's, aimed at that alert
only).

**Output.** fd 2 is a pipe read by a filter thread (`logfilter.rs`) before the real stderr: `desktop-core` `sanitize`
(every URL cut to its origin, `#c=…`, `Bearer …` and any run of ≥ 40 base64url characters hidden, control and bidi
characters replaced, ≤ 1000 characters a line), ≤ 50 lines a second, and Tauri's `__TAURI_INVOKE_KEY__ expected … but
received <frame text>` lines (a page frame posting to the IPC handler wry registers for all frames) dropped and
counted. The child's stderr is forwarded through it (`retake: …`). `finish()` drains it on exit. A panic writes its
sanitised message straight to the real stderr (review B L7: an abort in an AppKit callback would kill the process
before the filter thread prints it). Every line the shell prints starts with the binary's name (`main.rs` `BIN` =
Cargo.toml `name`).

**Native glue.** `objc2-app-kit` (default features off: its defaults want a crate not in the cache): NSOpenPanel and
NSAlert on the main thread. The menu is built from one table (`src/menu.rs` `MENUS`: an item is a shell command `{id,
label, accelerator, enabled}`, a macOS standard item or a separator): App (About, Hide, Hide Others, Show All, Quit) ·
File (Open Workspace… ⌘O, Close Window ⌘W) · Edit (Undo, Redo, Cut, Copy, Paste, Select All — they reach the page's
fields) · View (Enter Full Screen) · Window (Minimize, Zoom, Show Studio Window ⌘0). Only ⌘O and ⌘0 are the shell's;
⌘S, ⌘Enter, ⌘R, ⇧⌘R, ⌘B and ⌘. are left to the page (desktop-config.test.ts). No theme is set: the window is the
system's appearance (DarkAqua in Dark mode — alerts, the picker and menus follow it) and WebKit gives the page its
`prefers-color-scheme`, but the standard title bar takes the colour of the page's top (WKWebView on macOS 26, measured
by review B M2): light today, because the Studio pins `color-scheme: light` (app.css). Nothing in the shell changes
that — no `.theme()`, no `NSRequiresAquaSystemAppearance`; the redesign's dark / light tokens under
`prefers-color-scheme` (BL-124) carry the bar with them. *L5.9:* View now holds the page's commands (Command Palette…
⌘K, Script · Shoot · Edit · Review ⌘1 – ⌘4, Show or Hide Inspector ⌥⌘I) before Enter Full Screen, so the shell's own
keys are ⌘O and ⌘0 and the page's are those six (below, *Commands*); app.css no longer pins light — the page's
`color-scheme` follows the system's appearance (dark by default, light when the system asks: §4k), the window's chrome,
alerts and menus still follow the system (no theme set), so the two agree, and the standard title bar takes the page's
top colour in either. Keychain: nothing (secrets stay `{{keychain:…}}` references
resolved by the worker).

**The quit guard (L5.2b, `src/guard.rs`).** `applicationShouldTerminate:` added at launch to the class of NSApp's
delegate (`class_addMethod`, type `Q@:@`): tao 0.37 does not implement it and Tauri's `ExitRequested` never fires for
⌘Q, so this is the one path for ⌘Q, the menu's Quit (`terminate:`), the Dock, a quit Apple event and logout / restart.
`class_addMethod` returning NO (a later tao implements it) leaves the guard off and logs "quit guard off": the gated
test turns red at that upgrade. The method, on the main thread: no session of the app's own (none, or an attached
server: it has no pipe) or nothing pending → Now (a mutex read: Quit stays instant); otherwise the window is shown and
an app-modal alert (`macos::ask`; not a sheet — it works with the window hidden, needs no TerminateLater bookkeeping,
and logout waits for it; L5.12d: the fallback — a plain Quit asks the window's page first, below) asks with `desktop-core` `guard_question`: "Quit Retake?" — "Unsaved text in the Studio
(this window, or a browser tab on it) can no longer be saved: • README.md of shop • Scenario quote of shop (YAML)"
(review B L6: the board holds every tab on the server; a browser tab keeps its text on screen, but nothing saves it
once the server stops) / "These jobs keep running after the app quits, but it will not tell you when they end:
• Capture of shop · quote (running) …and 2 more" — and, with a recording the Studio started, "A recording started in
the Studio keeps its window open: close that window to end it, then save it from the Record screen when this
workspace is open again" (review B L5: its controls are the Record screen's). Unsaved text (or an unreadable state):
[Cancel, Quit Anyway] — Cancel first and Escape (AppKit gives a button titled Cancel Escape even when it is first;
Return then does nothing: logged by the gated test, review B L4), Quit Anyway destructive (red) and without a key, so
Return never loses text (critique M3); jobs only: [Quit Anyway (Return), Cancel (Escape)]. File › Open Workspace… asks
"Open another workspace?" the same way before the owned server stops ("These jobs keep running; this window stops
following them"). The restart alert after the owned server died names the unsaved text still in the window: [Not Now
(Return), Restart, Quit] — Restart and Quit lose the text, so both are destructive without a key (review B M4,
`restart_buttons`); Not Now leaves the window as it is (Quit later asks again — its job list is gone, the jobs being
history). Without unsaved text: [Restart (Return), Quit]. Rules found by the plan's
critique and probes (`l52b/probe-crit`, `probe-tao`):
- **Logout, restart, shut down** (review B M2): the quit Apple event being handled (`NSAppleEventManager
  currentAppleEvent`, `kAEQuitReason`: logo / rlgo → logout; rest / rrst / shut / rsdn → restart or shut down) picks
  `Action::LogOut` — "These jobs stop when you log out (the jobs worker ends with your session)" — or
  `Action::SystemRestart`: jobs alone ask nothing there (an unattended restart, such as a macOS update's, is never held
  by them; they stop with it either way, and the log says so), unsaved text or an unreadable state still asks ("These
  jobs stop when the Mac restarts or shuts down"). ⌘Q, the menu and the Dock carry no reason: `Action::Quit`. Not
  gated (sending a quit event with a reason needs Automation permission): the words are core tests, the reason is
  MACOS-CHECKLIST 14a.
- **Signals stay "quit now"**: SIGTERM / SIGINT / SIGHUP go through `app.exit` → `[NSApp stop:]`, never `terminate:`,
  so they never meet the guard; `QUIT_NOW` is set first. `[NSApp stop:]` ends only the hook's own modal (it runs
  outside tao's callback); a modal opened by a Tauri callback — Open Workspace…'s question, the restart alert, "not a
  workspace", the picker — holds tao's queued exit until it closes (tauri-runtime-wry `request_exit` goes through the
  event-loop proxy, which waits while `in_callback`). So every shell modal is counted while it runs (`macos.rs`
  `Modal`), and the signal thread ends whichever is up (review B M1): `performSelectorOnMainThread:` of a small
  `StudioShellModalEnder` method — it runs in the modal panel mode — that cancels the picker by its own `cancel:` or
  ends an alert with `abortModal`, only while `[NSApp modalWindow]` says a modal loop runs (abortModal without one
  raises); it is posted again every 100 ms while one is up (≤ 5 s: a modal opening as the signal comes, or the one an
  ended modal returns to). Once `QUIT_NOW` is set no new modal opens and no server starts (`open` checks it): the
  callback returns and the queued exit runs. Measured (gated, each modal up for real, the test's own abort set at 20 s): 23 ms for the
  quit question, 41 ms for Open Workspace…'s, 20 ms for "not a workspace", 32 ms for the restart alert. A `terminate:`
  (the test's Quit) during the restart alert reaches the hook, which answers Cancel (gated: no question nested). The picker's case is not gated
  (test mode never shows the panel: a real NSOpenPanel would write the test bundle's preferences) — MACOS-CHECKLIST
  14a.
- **AppKit treats a `terminate:` sent while the hook is still deciding as Now** without asking again (H2): `GUARD_OPEN`
  is set while a question is up — the test hook is ignored then, a second ⌘Q while another question of the guard is up
  answers Cancel, and the restart alerts (`server_exited`, `server_gone`) wait (re-queued every 250 ms; the dead
  server's ports refused first, review B L11) instead of opening an alert inside the alert or a server while it
  decides. A `terminate:` while any other shell modal is up (the restart alert, the picker, "not a workspace")
  answers Cancel too (review B L13: never the question nested in it, never `applicationWillTerminate` inside a modal a
  Tauri callback opened — the H1 hang); File › Open Workspace… opens no picker while a question is up (B L10).
- **Never `terminate:` from a Tauri / tao callback** (H1): tao runs `run_on_main_thread` closures holding its callback
  lock, and `applicationWillTerminate` takes it again — a hang (reproduced). The test hook (SIGUSR2) sends
  `performSelectorOnMainThread:terminate:` from its own thread, which arrives like a real ⌘Q (outside tao's callback,
  Tauri events still flowing while the alert waits).
- A panic in the hook answers Now (`catch_unwind`, L7): an app that cannot quit is worse than a question not asked.
- An attached server: no guard, no notifications, said once at attach ("they need a server of this app's own"); the
  relay (the `--supervised` child kept alive with the file's token) is BL-125.

**The quit question in the page (L5.12d, `desktop-core` `guard_flow`, `src/guard.rs`; R-DSK-04).** Page first, the
native alert as the fallback. For a plain Quit (⌘Q, the menu, the Dock — no `kAEQuitReason`) with something pending,
an owned server and the window on the Studio's own origin (`w.url()`: the player origin is allowed for navigations
too, and its top document would swallow the event), the hook answers Cancel at once and asks the page: `ShowWindow`
(unminimise, front) then one constant-shaped script, `page_quit_js` — `window.dispatchEvent(new CustomEvent(
"studio:quit", { detail: {id, action, title, text, buttons, proceed, cancel, destructive} }))`, the words of
`guard_question` as JSON data (every string `json::quote`d, U+2028 escaped) and a fresh id (16 bytes of
`/dev/urandom`, base64url, 22 characters; logged in test mode only). The page (`shell/QuitSheet.tsx`, mounted only
under the app's flag) checks the detail whole (exactly the eight keys — a static test compares the Rust and page lists
—, the id's shape, two buttons ≤ 100 characters, words ≤ 4 000 UTF-16 units, indexes in range: anything else, no
sheet, no ack). The bound is one constant on both sides (`guard_flow` `QUIT_TEXT_MAX` / `QUIT_LABEL_MAX` = the page's,
compared by a static test — L5.12d fixes, review A-L1 / B-L1): words.rs's longest question (eight unsaved and eight job
lines of cut names, the largest totals, the recording and unknown notes) stays under ¾ of it (a desktop-core test builds
it), and a question past it would be asked natively at once (`page_fits`), never sent to be refused. The page opens a
kit Sheet (title and text through Txt, the text pre-line; the buttons left to right as the native alert shows them —
its first, default button rightmost, as the kit's other sheets place their primary action: unsaved text reads
[Quit Anyway] [Cancel ●], jobs only [Cancel] [Quit Anyway ●], review B-M1; the kit's rules give the alert's keys:
unsaved text → Return = Cancel, Quit Anyway destructive with no key, Escape = Cancel; jobs only → Return = Quit Anyway;
Return on a Tab-focused destructive button chooses the default, as the alert's Return does wherever the focus ring is —
Space and a click still press it, A-L2; no key caps on the buttons, as every kit Sheet), and acks
through the own op `desktop_answer {id, shown: true}` once the dialog is open, two animation frames painted and
`document.visibilityState === 'visible'` (a minimised window or another Space acks when it shows); the answer is
`desktop_answer {id, answer: proceed | cancel}`: the sheet stays open, the chosen button busy and the other off, until
the call settles — answered, it closes; failed (a 409, a 503), a Callout in the sheet says "The app did not get the
answer" and the question stays answerable (A-L3; the shell's own timers still apply). The server (`server/desktop.ts`) writes one framed pipe line —
`{"type":"shown","id","shown":true}` / `{"type":"answer","id","answer"}` — on the supervised stdout (never another
server: 409, reason `not_supervised`; once its supervisor has stopped — the server closing — nothing can be written:
503, reason `stopped`, never "answered", B-L6; `shown` capped at 20 a minute, an answer never; Studio only, never an MCP
tool; no job-watch nudge); `pipe.rs` reads them strictly (exactly `type`, `id` and the line's own field: any other key
ignores the line, A-L6) (`PipeMsg::Shown` / `Answer`, unknown types still ignored both ways:
an older shell ignores them, an older server never acks → the fallback). The flow (pure, its own unit tests with an
injected clock — critique H1):
- **No TerminateLater** (a reply from a tao callback hangs, H1 of L5.2b): Quit Anyway sets APPROVED and re-enters
  through `request_terminate()` (`performSelectorOnMainThread:`, as SIGUSR2 does); the re-entered hook consumes it →
  Now. Probed first on macOS 26 (release build, temporary code): the hook's Cancel then a posted `terminate:` 0 / 50 /
  300 ms later → the app exits 0 in 18 – 330 ms; a quit Apple event (a Dock Quit: `NSRunningApplication terminate`)
  94 – 135 ms; a Cancel on re-entry keeps the app and a later Quit works (×4 each).
- **No ack within 1.5 s** (a hung page, not loaded yet, the Connecting / Ended screen, the server stopped): the timer
  closes the page's question, sets FALLBACK and re-sends `terminate:`; the re-entered hook asks natively. The
  re-entry is queued on the main thread behind the close script (`run_on_main_thread`, the same event-loop queue an
  eval from another thread takes), then posted: the page's sheet is closed before the native alert opens (L5.12d fixes,
  review A's note; whether WebKit paints it closed behind the app-modal alert is MACOS-CHECKLIST 14e). The Connecting
  and Ended screens have no session — no token, no server to answer through — so they mount no sheet and the 1.5 s
  wait there is by design (B-L5): telling the shell "no sheet here" would need an answer path they do not have.
- **`shown` / `answer` only for the question up now, once**: an old, replayed, post-fallback id, or one arriving while
  the native alert is up, is ignored (logged "ignored a page answer: not the question up now").
- **APPROVED is tied to that answer, expires after 5 s and any Cancel clears it** — the restart alert opening between
  the page's Quit Anyway and the re-entered `terminate:` answers Cancel and leaves nothing approved (a later ⌘Q asks).
- **Every exit from a page question closes its sheet** (`studio:quit-close {id}`): the fallback, logout / restart
  arriving while asked (native for them), nothing pending any more, the server gone or exited, a signal, Open
  Workspace…'s question.
- **A second ⌘Q while it is up re-dispatches the same id** (a reloaded page shows it again) and waits for an ack
  again; once the question was shown 10 s ago and is still unanswered, the next ⌘Q asks natively (a page that acked and
  then hung never traps the person). This replaces L5.2b's "a second Quit is ignored" for the page path (the native
  alert keeps it).
- **Native stays for** logout, restart and shut down (loginwindow never waits on a web page), the restart alert (no
  server, no answer path), "not a workspace", the folder picker, File › Open Workspace…'s question (through the page it
  would turn a synchronous menu callback into an async flow: cut, BL-135), an attached server (no pipe: no question at
  all), test mode's `RETAKE_DESKTOP_TEST_QUIT=native` (the L5.2b gated cases that answer the alert), and every
  fallback.
Gated (RETAKE_TEST_DESKTOP=1): the page asks and acks by itself in WKWebView; Cancel and Quit Anyway through
`desktop_answer` with the id test mode logs; a second Quit re-dispatches the same id; a replayed old id is ignored; the
server SIGSTOPped → no ack → the native alert after ≈ 1.5 s and the late ack ignored; L5.12d fixes (review B-M2), with
the page path on: SIGTERM while the sheet is up → the app exits 0 at once, the question in the window dropped, no alert;
the owned server killed while the sheet is up → the question dropped before the restart alert (answered Not Now
through the test answers), a later Quit native. Measured (gated, release build):
⌘Q to the page's ack 100 ms, Quit Anyway to the app's exit 28 ms, ⌘Q to the native fallback 1 629 ms. VoiceOver on the sheet and a
hung page in daily use are MACOS-CHECKLIST 14e.

**Job notifications (L5.2b, `src/notify.rs`).** UNUserNotificationCenter (`objc2-user-notifications`, default features
off, and `block2`: both already in Cargo.lock through objc2-ui-kit — four dependency edges, no new package). A
`job_end` while the window is in front (the app active, its window key, visible, not minimised) is dropped (the page
shows it); otherwise `desktop-core` `Notifier` posts the first at once and holds the ones within 5 s of a post for one
summary at the 5 s mark (dropped if the window came to front meanwhile): at most 12 a minute by construction. Words
from `words.rs`: "Capture finished" / "Render failed" / "Recording needs attention", the body "shop · quote" and a
reason ("The review found errors or warnings.", "Ready to save on the Record screen.", "Interrupted: the worker
stopped.", "A rollback or a reset hook failed."), "Sandbox started"; a summary "3 jobs ended" — "2 finished, 1 failed /
shop · quote and 1 more" (review B L14). Thread identifier `jobs`, no sound. Permission (`Alert` only) is asked at the
first notification that would be shown, which is posted once granted if the answer came within a minute. A no or an
error is never kept for the session (review B L9, `desktop-core` `Permission`): the next notification asks again —
once the person answered, that call never prompts, so a switch turned on in System Settings works without a relaunch
— and each different outcome is logged once: "notifications are off: System Settings › Notifications › …" for a
person's no, "notifications could not be allowed: macOS refused the request (<domain> <code>)" for an error (an
unsigned or ad hoc bundle refused by macOS is not a person's no). The delegate is set at
launch when bundled (a click on a notification left from an earlier session still shows the window): `willPresent`
answers banner + list, a click activates the app and shows the window (no navigation to the job's screen: BL-125).
Only a real bundle calls UN (`NSBundle.mainBundle` with a bundle id and a `.app` path; `desktop:dev` runs a bare binary
and says so once); test mode never calls it. No osascript fallback. Permission is stored per bundle id, not tied to the
ad hoc signature: expected to survive a rebuild (MACOS-CHECKLIST 14a checks it); the test bundle id never asks; the
rename (L5.13) changes the bundle id → one new prompt.

**Prepared for the redesign (BACKLOG BL-124); L5.9 built the commands and the page's side of the title bar.**
- *Title bar.* `src/menu.rs` `TITLE_BAR` is the one switch — **`TitleBar::Standard`, kept by L5.9**;
  `TitleBar::Overlay { buttons: (16, 18) }` (transparent title bar, no title text, the window buttons inside the
  page's 48 px bar) waits for a native drag band (BL-126). The page's side is built and tested: a constant main-frame
  init script (`menu::SHELL_FLAG_JS`, `initialization_script`, never the all-frames variant) sets
  `window.__studioShell = {titleBar: 'standard' | 'overlay'}`; main.tsx turns `overlay` into `html[data-titlebar]`,
  which gives `--ui-titlebar-inset: 80px` (the bar's content and the skip link clear of the buttons) — nothing else
  moves, and the flag only changes layout and key binding (a forged flag in a browser tab only moves the layout; the
  sandboxed Player is cross-origin and can neither read it nor send commands). The title bar has no selectable text.
  *The drag band's pass criteria* (critique H2; a probe time-boxed to half a day, all by hand with real drags):
  (1) a drag from the bar's empty area moves the window; (2) a press-drag starting on a mode button moves the window and
  does not navigate; (3) after any band drag no `:active` state stays stuck and a hover over the steps list starts no
  text selection or step drag (WebKit must get its mouse-up: `performWindowDragWithEvent:` runs AppKit's own tracking
  loop, which takes it — a synthetic mouse-up, if needed, outside the webview's bounds so no click fires); (4) the next
  click works; (5) a `<select>` in the bar still opens; (6) a double-click on the empty bar zooms as macOS does, never on
  a control; (7) it coexists with the menu, sheets and full screen (the inset in full screen: the buttons are gone).
  L5.9 did not run the probe — every criterion needs a real window drag, which an unattended run cannot post (no
  Accessibility permission) — so it ships the standard bar (critique H2's cut line); whether WKWebView honours
  `app-region: drag` was not measured either (it was stated "no" in L5.2). BL-126 holds the probe and the band.
- *Commands (L5.9).* `MENUS` has `Item::Page` entries — View: Command Palette… ⌘K, Script ⌘1, Shoot ⌘2, Edit ⌘3,
  Review ⌘4, Show or Hide Inspector ⌥⌘I, then Enter Full Screen. A click (or the accelerator) runs
  `menu::page_command_js(id)`: for a `Page` id of the table only, `window.dispatchEvent(new CustomEvent('studio:command',
  {detail: {id}}))` with the id JSON-quoted — one way, no data from the page, no IPC (the `.eval` count is 2: the
  `--route` setter and this). The page's ids are ONE list (`ui-kit/commands.ts` `MENU_COMMANDS`), compared with the
  table's `Page` ids by desktop-config.test.ts; the page accepts those ids only, and ignores them while a modal dialog
  is open (the palette's own ⌘K closes it: critique M5). Under the app the page binds no key itself (the accelerators
  send the commands: a key never acts twice); in a browser tab it binds ⌘K only on a Mac (never Ctrl+K: a text field's
  "delete to the end of the line" there), Ctrl+K elsewhere outside a text field, and nothing while an input method
  composes or a modal other than the palette waits (L5.9 review B-L3); ⌘R, ⌘1 – 4, ⌥⌘I stay the browser's. Rehearse ⌘R, Capture ⇧⌘R, Render ⌘B and Stop ⌘. come with L5.11, when they act (critique M6: a menu item
  that only opened a screen would lie); until then the shell binds none of them.
- *Menu state* (review B L10) — **decided in L5.9: static.** Every page command is always enabled; a command the page
  cannot run answers in the page's status bar ("Open a scenario first", "This screen has no inspector"). State flowing
  to the shell (server→shell `state` lines or a narrow page→shell request) is BL-126.
- *Native confirmation sheets* (BL-106 amended; one message shape, the same there): the server asks through the
  supervised pipe — `{"type":"confirm","id","text","buttons"}` on the child's stdout (`buttons`: the labels, the first
  the default, the last the cancel); the shell shows a sheet on the window (NSAlert `beginSheetModalForWindow`, the
  text as plain text, those labels as the app's own buttons) and writes `{"type":"confirmed","id","button"}` (the index
  pressed) to the child's stdin; the server matches the id and continues. The page can neither raise one (it has no
  IPC; a server op may ask on its behalf, and the server decides when to) nor answer it (the answer comes only from
  the pipe the shell holds). In a browser tab (no supervisor) the same request falls back to the terminal prompt.
- *Name.* "Retake" is tauri.conf.json `productName` and the bundle id its `identifier` — the one place each: the
  shell reads the name from the generated context (`package_info().name`), `desktop.mjs` reads both from the file
  (Info.plist, the `.app` name, the plist's texts). The binary's name is Cargo.toml `name` (`main.rs` `BIN`, the log
  prefix; `desktop.mjs` and the gated test read it from Cargo.toml). The rename changes those values.

**Build.** `desktop:build`: `cargo build --release --locked --features custom-protocol` (thin LTO, stripped: 7.9 MB
binary) → `<target>/release/bundle/Retake.app` (Info.plist with `NSLocalNetworkUsageDescription` — the worker and
its browser are the app's children, so macOS names the app in a local-network prompt —, the icon made by `sips` +
`iconutil` — the 16 and 32 pt slots copied from `icons/iconset/`, the larger ones downscaled from `icons/icon.png`;
all generated from the app mark by `gen:mark`, §4o (b)), `launch.json`,
`codesign --force --sign -` (ad hoc, no entitlement). Never copied to /Applications. Launch Services records each
built copy even when its binary is started directly: `desktop:clean` unregisters it. Disk (measured 2026-10-29): the
build folders are inside the checkout unless CARGO_TARGET_DIR is set — `apps/desktop/target` (≈ 1 GB for a debug
build, dependencies without debug info; ≈ 0.85 GB for a release one; one per checkout or worktree) and
`apps/desktop/core/target` (≈ 11 MB, also what `desktop-core.test.ts` builds), plus Tauri's generated `gen/`; all
git-ignored, all removed by `desktop:clean` (review B L3).

**Tests.** `desktop-config.test.ts` (default suite, static: tauri.conf.json, no capability anywhere, the window's
builder calls, one `.eval`, one `Command::new`, the dependency allow-list and Tauri features — L5.2b: the notification
crates' feature list, the hook added, UN only behind the bundle check and never in test mode, no `terminate` inside a
`run_on_main_thread` closure, GUARD_OPEN / QUIT_NOW / catch_unwind in place —, `--locked`, no /Applications, ad hoc
signature, the menu table's accelerators, `TITLE_BAR`, the name in one place); `desktop-core.test.ts` (default suite:
`cargo test` of `apps/desktop/core`, a crate with no dependency — 33 tests (L5.2b: the pipe lines, the question's
words with a hostile-input property test, the no-storm rule),
≈ 1.6 s warm; skipped with the reason in its title on Windows, on macOS without the Xcode command line tools —
`xcode-select -p`, checked before cargo runs so the `cc` shim never opens their install dialog —, without rustc /
cargo, or with a Rust older than 1.70: review B M4); `desktop-shell.test.ts` (gated `RETAKE_TEST_DESKTOP=1`,
cargo probed only then: one release build
with the test bundle id `local.retake.desktop.test`, the binary started directly; owned server = its child,
argv without secret, two listeners on 127.0.0.1; the page loaded = `/v1/info` counters `sessions ≥ 1`, `streams ≥ 1`;
SIGTERM = the graceful path (`quit: SIGTERM`, the child's `stopped: SIGTERM`); SIGKILL = no orphan; attached = the
terminal's server survives Quit; Open Workspace… (SIGUSR1) on a folder that is no workspace keeps the app, its server
and its page; L5.2b (SIGUSR2 = `terminate:`): nothing pending → instant; a running job (its worker: the test
process) holds Quit and Open Workspace… (answered Cancel), then instant once it ended; a tab's unsaved report (the
op, with the token of the workspace's record in the Retake home) named, a name that does not exist never; notifications logged by the no-storm rule — window
not in front: one at once and one summary 5 s later, in front: none; SIGTERM with a job running quits without a
question; attached: no guard, SIGUSR2 quits at once and the job stays; the real alert (MODAL_MS): a second window of
the app while it is up and gone after, a second SIGUSR2 ignored (H2), SIGTERM while it is up quits (M1), Return never
on Quit Anyway with unsaved text (the alert's key equivalents logged), screenshots of the question; the owned server
killed with unsaved text: the restart alert names it, Not Now keeps the window, Quit then asks about the text only; a
hostile launch — a copy of the app whose launch.json runs a fake `retake ui --supervised` serving an
adversarial page and a sandboxed "player" — proves no request reaches a foreign port (iframe, redirect, srcdoc frame,
octal host, `target=_blank`, `window.open`, top-level location), data: / blob: / custom-scheme navigations refused,
both downloads cancelled and nothing in `~/Downloads` (files named with a per-run token, the only ones ever deleted),
every invoke refused and the player frame's IPC message dropped, no `mediaDevices`, no NODE_OPTIONS in the child (review
A M2); no secret in the output; nothing in `~/Library` and no Launch Services record left; with
`RETAKE_TEST_SLOW=1` a fixture capture on its timeline: `player_media_bytes_read > 0`). By eye: the screenshots the
test keeps (`RETAKE_TEST_SHOTS`): a locked screen skips them, a capture without Screen Recording permission or a
flat picture is printed "unverified" (review B). By hand: MACOS-CHECKLIST 14a.

## 4k. The Studio's design system and shell (L5.9)

R-UI-02 (amended by BL-124), R-UI-30 – R-UI-34, R-DSK-03. « Épure » 1: the foundations the screens are rebuilt from in
L5.10 – L5.12 — one token file for dark and light, a kit of accessible components built in-house, the app shell, a
gallery audited by the L4.9 checker, a source lint keeping screens on the kit, the Geist pair bundled. The look itself is
docs/reference/studio-ui.md (exported from the validated canvas). Built in parts A – G from the lot's plan corrected by
its critique (H1 – H4, M1 – M7). Cuts: BL-126 (desktop extras: the overlay title bar's drag band, menu state, the
Scenario menu's place in L5.11), BL-127 (kit extras).

**Tokens.** `packages/ui/src/app/tokens.ts` is the one file: `UI_COLOURS` (the kit's `--ui-*`, dark and light from the
canvas), `LEGACY_COLOURS` (the L4.9 palette: light exactly as L4.9, dark mapped onto the semantic set; three role
splits where one token could not be both in dark — `--accent-fill` / `--accent-strong-fill` for the primary button
under white text, `--tooltip-bg` for the timeline's tooltip that read `--fg`), `UI_STATIC` / `LEGACY_STATIC` (type
13 / 15 / 20 with 18 / 22 / 26 leading, weights 400 / 600, spacing, radii, pane sizes; `--main-h`, the centre pane's
height, for the legacy rules that used `100vh`), `FONT_FILES`. `tokens.css` is generated (`pnpm -F @retake/ui
gen:tokens`, committed, a test compares it): the two `@font-face`, the appearance-free tokens on `:root`, then
`:root, [data-appearance='dark'] { color-scheme: dark; … }` (dark by default: no preference or dark),
`@media (prefers-color-scheme: light) { :root { color-scheme: light; … } }` (light only when the system asks), and the
`[data-appearance]` scopes repeated after it (a scope always wins: the gallery's columns). Nothing in the page switches
the appearance (BL-127). The desktop window sets no theme: its chrome, alerts and menus follow the system's appearance
(§4j), and the page's `color-scheme` follows the system too, so they always agree; the standard title bar takes the page's
top colour (review B-M2). The document declares `<meta name="color-scheme" content="dark light">` (no white flash) and
preloads both fonts. `tokens.css` also declares the dialogs' veils (`--ui-backdrop`, `--backdrop`) on `::backdrop` itself
in each appearance and scope: Safari 17 and Firefox 120 (UI_TARGETS) do not inherit custom properties into it (review
A-L9). `--main-h` is written from `--ui-titlebar-h` + `--ui-statusbar-h` in tokens.ts (review B-L7).

**Fonts.** `packages/ui/fonts/Geist-Variable.woff2` (sha256 `206f01ed…a706`, 69,560 bytes) and
`GeistMono-Variable.woff2` (`55419aa0…972b`, 71,104 bytes), the official OFL release, unmodified, with `LICENSE.txt`
(SIL OFL 1.1, `930853ee…9137`) beside them; `buildUi` reads them once and serves `/fonts/<file>` from memory as
`font/woff2` with an ETag (the static route; CSP `font-src 'self'` unchanged; esbuild leaves the two URLs to the server:
`external: ['/fonts/*']`). The package's `files` lists `fonts`. The licence names the font's authors and the OFL's
site: the one third-party text the generic-names rule lets in, verbatim (the OFL requires it). The checker's `settle`
waits for `document.fonts.ready` (critique M3: an audit never measures the fallback's widths).

**Layers.** app.css (the legacy screens) is the cascade layer `legacy`; the kit's `ui-kit/kit.css`, the shell's
`shell/shell.css` and the rebuilt screens' `screens.css` are unlayered, so a kit component keeps its look inside a
legacy screen whatever the order and specificity (critique M4: app.css's global `:focus-visible` would have redrawn
the kit's ring in another colour). Directions are one-way: app.css reads no `--ui-*` token, the kit, the shell and the
new screens read nothing else.

**The kit** (`packages/ui/src/app/ui-kit/`, `index.ts` exports it): Button (primary, secondary, ghost, destructive,
record; sm / md / lg; icon, key caps, busy, a disabled reason read through `aria-describedby`), LinkButton, IconButton
(`aria-pressed`, one label), Kbd, Icon (a table of 23 stroke icons, `aria-hidden` SVG), Segmented (a fieldset of native
radios covering their segments) and SegmentedLinks (`aria-current`; a missing place is a disabled button with a hint),
Switch (a native checkbox `role="switch"` drawn as the track), TextField / TextArea / Select / FieldRow, StatusMark (a
shape and a word, eight states), Timecode (spoken form in hidden text), Progress, Toolbar (roving tab stop), StatusBar,
SourceList, InspectorSection, FrameCard / PosterCard (one control: a pressed button or a link), Blocker (one line, one
fix: a button or Copy with a polite "Copied"), EmptyState, Sheet, Menu, CommandPalette. Every text prop is a React node,
and **every slot that shows text the kit did not write renders a string through `<Txt>`** (`shown()`, bits.tsx: a
`<bdi>` with its direction controls made visible) — palette entries and hints, menu items, sheet titles and bodies,
source-list rows and flags, status words, labels, hints, errors, cards; a `<select>`'s options and key caps through
`visibleControls` (an `<option>` cannot hold a `<bdi>`); Progress's `aria-valuetext` too (review A-M1: a project named
with U+202E read reversed in ⌘K). Every control native; the ring 2 px `--ui-ring`. **Toolbar** (review A-M2): its stops
are its visible controls outside a popover or a menu (a closed menu's items are not stops), a radio group counting once
(its checked radio); it leaves a key that a control inside handled (`defaultPrevented`), the arrows of a radio group, and
every key of a text-entry field, a slider or a select to them. **Sheet** (review A-L1): it follows its `open` prop even
when the platform closes the dialog itself (Chromium lets a page refuse Escape once per user activation) — that close is
the cancel action, and a sheet its owner keeps open shows again; a late close event of an earlier closing is ignored.
**Switch:** named by its label alone (`aria-labelledby`), the hint its description (A-L3). **SegmentedLinks:** the reason
is rendered whenever a segment is off, so no `aria-describedby` dangles (A-L4). **CommandPalette:** "Nothing matches"
stays in the accessibility tree while empty (A-L5), no empty `aria-activedescendant`, no command while an input method
composes, the focus back to the opener or to `#main` when a command took the opener away (A-L6). **The unsaved mark:** TextField and
TextArea take a REQUIRED `unsaved: UnsavedItem | null` and call `useUnsavedMark(unsavedFor(value, baseline,
unsaved))` (L5.2b's drafts.ts) — a parser test checks the call and the prop; `null` is for no one's text (a search, the
gallery's samples: critique L6). An error is said in words starting "Error:" (the red edge is never the only cue).
**No dependency (decided with evidence).** Select is the native `<select>`; Menu is a `popover="auto"` list opened
through `popoverTarget` (the top layer above `overflow: hidden` panes, light dismiss and Escape from the platform; a
click on the open trigger closes it: critique L9) with roving focus, typeahead, ↓ / ↑ to open on the first / last item,
placed under its trigger by `popover.ts` (`position: fixed`, flipped above near the bottom, re-placed on scroll and
resize); Sheet and CommandPalette are `<dialog>.showModal()` (inert page, Escape, focus back to the opener). Their
behaviours pass in Chromium (studio-e2e-kit) and in one scratch WebKit-2370 run (H4, by `executablePath`, not
committed): 9 / 9 once three WebKit conventions are allowed for — Tab skips buttons while macOS keyboard navigation is
off, radios stop at the last enabled one instead of wrapping, a click does not focus a button (so a dialog opened by a
click has no opener to give the focus back to) — and its console noise: WebKit reports a CSP `style-src-attr`
violation for every `<select>` it draws (the legacy screens' too; nothing the app writes). Raw, 5 / 9. The desktop app's
WKWebView is checked by hand (MACOS-CHECKLIST 14b). A sheet's Return default is never a destructive action
(`defaultAction` falls back to the cancel action: L5.2b's rule); a palette's active option has the selection fill and
a 3 px `--ui-ring` bar (critique M1). Commands (`commands.ts`): `MENU_COMMANDS`, `studioShell()`, `modalOpen()`.

**The shell** (`shell/AppShell.tsx`, kit-only; `modes.ts`, `slots.tsx`; the title bar a grid of two equal side
columns around the mode switch, so it is centred on the window under the overlay inset too — review B-L1): a fixed
window of panes (title bar 48, browser
240, centre — the one scroller —, inspector 320, status bar 34); DOM order = Tab order (Skip to content — a kit Button,
clear of the window buttons —, title bar, browser, centre, inspector, status bar). Title bar: the app mark and
`APP_NAME` (`brand.ts`, the one place the page names the product; a lint), project › scenario truncated before the mode
switch, the mode switch centred (Script → the scenario's blocks, Shoot → its Run screen (and Record), Edit → its
timeline (and a proposal's preview), Review → its comments; the scenario in context is the route's or the one opened
last in that project while the project still lists it — review B-L8; none → four disabled buttons and a hint), the context slot and the inspector toggle. Browser: a
SourceList "Studio" keeping L4.1's words (Projects, "Projects of the workspace", Overview, README with "unsaved",
Components, Themes) plus Record, the class `sidebar` and the foot (workspace path, version, worker pid, UI gallery).
Inspector: shown only while a screen renders `<ShellSlot name="inspector">` (a portal); the legacy screens render none
and keep the whole centre. Status bar: `data-testid="connection"` (a StatusMark, worker idle / running, live updates
or updates every 3 s), a polite line for a command's answer, the `actions` slot (empty on legacy screens: Rehearse /
Capture / Render act from L5.11 — critique M6). The centre scrolls to the top only when the screen's identity
(route name, project, scenario) changes (critique M2); when the old screen took the focused control with it, the focus
lands on `#main` (A-L6; not on a load's first screen, where Tab starts at the top), as it does when the inspector is
hidden with the focus inside. One `aria-current` in the browser (Overview, not also its project's row: A-L9).
Commands: §4j; the shell's palette lists places (projects, the
open project's pages, the modes of the scenario in context, the gallery) and the inspector toggle.

**Legacy screens in dark.** Every screen not rebuilt yet keeps its content in the centre pane, in both appearances,
through the legacy palette's dark values alone (no per-screen CSS): the two tours pass in dark at 1280 and 1440 and in
light at 1280 with no finding, so no route is kept light (critique H3's fallback, `<main data-appearance="light">`,
was not needed). Two collisions the first dark tour found, fixed in tokens.ts: `--info-soft` had the value of
`--accent-soft` (the checker read the timeline radios' selection tint as an "info" mark) and `--ui-recording` that of
`--danger-soft`; a lint now forbids any token sharing a status family's colour.

**The gallery** (`#/ui`, `GalleryScreen.tsx`, kit-only; reached by the browser's foot and ⌘K): every component in its
states, a dark and a light column (`data-appearance` scopes; the top layer of a sheet, menu or palette opened in a column
inherits its tokens), the inspector and actions slots filled. Toured in dark and light at 1280 and 1440, plus its
sheet, menu and palette open in each scope.

**The checker (a11y.ts).** `colour-only` collects status tokens from every rule of `:root` or a `[data-appearance]`
scope, inside `@media` and cascade layers too, resolved on each element's own scope, and watches the kit's families
(`--ui-ok`, `--ui-warn`, `--ui-fail`, `--ui-record`, `--ui-recording`, `--ui-danger`, `--ui-idle`, `--ui-waiting`) —
before, the dark default's selector would have left it watching nothing, silently (critique H1); the tours assert it
watches ≥ 1 colour at every station (counted over the root and every scope: review A-L7). An `<svg>` outside a control
is a mark drawn in its colour (its `currentColor` paths), checked like a sign in text. `settle` takes a busy element a
station holds on purpose (the steps while a write is in flight: A-L2). `reachable`
accepts the options of a listbox that a focusable combobox controls with `aria-activedescendant` (the palette: M1).

**Lints** (app-source.test.ts): colour literals only in tokens.css / tokens.ts; tokens.css = tokensCss(); its only URLs
the two fonts; every token defined is used and every one used defined; contrast of every pair in both appearances (the
legacy sets, the kit's text × surfaces and marks × surfaces, the switch's knob × track and track × pane: M7; L5.13b:
the app mark's back take on its plate and front take on the back and the plate, every `fill` / `stroke` token in a mark
pair — the dark plate itself is a quiet lift, ≈ 1.3:1 on the title bar, accepted below 3:1: the blue take carries the
mark); focus
rings in `--accent`, `--accent-strong` or `--ui-ring`; no `vh` in a height, inside `min()` / `max()` / `clamp()` too
(review B-M1: the timeline's preview is `clamp(160px, calc(var(--main-h) * 0.44 - 46px), 460px)` — L4.9's 44vh less the
two bars — so as many track rows show on load as before the shell; the palette, a fixed dialog, takes `70%` of the
window); opacity below 1 on four states (the steps in flight keep their colours: a dashed `--busy-edge`, A-L2); sizes,
weights and radii of the kit, shell and new screens from `--ui-*` only; the kit's text through `<Txt>` (a parser pass
over every JSX child of `ui-kit/`, and an SSR render planting a hostile string in 50 slots of 23 components);
**screens stay on the kit** (review A-M3: `scripts/kit-ratchet.ts`) — outside `ui-kit/`, a native control or disclosure
(`button`, `input`, `select`, `textarea`, `dialog`, `progress`, `meter`, `details`, `summary`, `label`), a widget role
(31: button, checkbox, radio, tab, slider, switch, menuitem, option, combobox…) or a role that is not a literal, a kit
class (`k-…` but `k-sr`, `k-mono`, `k-scope`), any app.css class, or a legacy token written in the TypeScript is counted
per file against `packages/ui/test/legacy-controls.json` (29 legacy files today): a count may only stay or go **down**
(≤ its row, so a rebase over another lowering never conflicts; a row above HEAD's fails), a file without a row (the shell,
the gallery, every new screen) has none, and `pnpm -F @retake/ui ratchet` lowers the rows when they drop and never
raises one; the product's name (`/\bRetake\b/` since L5.13) is written only in brand.ts among all the app's sources
and bundle.ts (A-L8).

L5.10a (§4l) adds SourceList rows, Facts, Disclosure, PosterGrid and Thumb sizes to the kit.

**Tests.** `kit-static.test.ts` (react-dom/server: each component's elements, roles and states; the unsaved-mark
parser check; `defaultAction`; the palette's filter; the menu commands' allow-list); `studio-e2e-kit.test.ts`
(Chromium, ≈ 5 s: appearance switching live, the kit's keys, a toolbar holding a menu, radios and a URL field (A-M2), a
sheet whose owner refuses Escape (A-L1), the shell's palette and commands, ⌘K / Ctrl+K by platform (B-L3), M5, the modes,
M2, a long name at 900 px, the overlay contract and the centred switch (B-L1)); `studio-e2e-timeline` (the track rows on
load at 1440 × 900 and 1280 × 800: B-M1); the tours (`studio-e2e-a11y*.test.ts`, ≈ 15 s each: 31 states, each in dark at
1280 + 1440 with its Tab walk and in light at 1280; the gallery in both at both widths); desktop-config (the page
commands, the parity with `MENU_COMMANDS`, one init script, two evals); `studio-e2e-comments-chrome` (gated: the centre
pane scrolls, the page never does, the browser stays under the title bar).

## 4l. The Project screen, Welcome and the project browser (L5.10a)

R-UI-35 – R-UI-37. « Épure » 2, the project side (L5.10 was split: L5.10b builds the Scenario side — storyboard, step
inspector, scenes browser, YAML source, Location select). Reference: B32-Projet (« B·3b Épure », round 3, validated)
and R4-Welcome, layout and drawing; the product's name stays `APP_NAME`. Built from the lot's plan corrected by its
critique (H1 the board's own read, H2 the cuts, M2 the store's invalidation, M3 the words, M4 every capability's home,
M5 Disclosure, M6 the listbox, M8 the migration guard, M9 Thumb sizes). Cuts: BL-128.

**`project_board {project}`** (ui `server/ops.ts` boardOp; engine `projects.board`, `project-board.ts`). A Studio-own
READ op (in `OWN_OPS`, never an MCP tool), path-free, the video titles under `untrusted` (capped at 200 characters).
Per scenario of `project_get.scenarios` (at most `BOARD_SCENARIOS_MAX` = 200; past it `truncated`): file facts
(parsed, ok, errors, warnings, the content counts: scenes, cards, interstitials, steps, hooks; its environment when the
project has it, else the project's default — an environment the project lacks only under `untrusted.env`, capped;
the theme a render of today's file uses, `theme`; its sha256), the running take, the last finished take (status, partial words "failed at step 3
of proposal", its job), the **capture** (the newest succeeded capture with its pictures — video or kept frames — and
whether today's file still films it: `current` true when the file is unchanged or only its edit changed, false when the
filmed part changed, null without a snapshot), the newest complete dry run, the newest succeeded landscape render with
its review (renders.ts `renderView`, shared with `scenario_renders`), a newer failed render, the render job queued or
running (its fraction, reviewing), the length (the render's, else the capture's scenes summed) and the poster (a failed
take newer than the capture: its error screenshot when it has one; else the capture's — else the dry run's — last step
with a picture: `runs.poster`, run_thumbs takes its key). The render shown is the newest succeeded landscape one that
shows today's file (sameVersion's rule with today's theme: the same capture, file bytes and theme, no override), else
the newest one — an older matching render is never hidden behind a newer override. Strings from run.json pass only
with their shape (an environment name, an ISO time; a scene id through `stepRef`). **Never through
`scenarios.view`** (critique H1: its 16-entry memos thrash past 16 scenarios and a board read would evict the open
scenario screen's entries): ONE pass over the runs folder newest first (the newest 300 run.json re-checked by their
stat; the older ones — finished, they do not change — summed up per scenario once per project and held while their ids
stay the same, ids joining at the head added to it: a never-run scenario no longer walks the folder at each read), file
facts memoised by the file's stat and the project files' signatures (project.yaml, sandbox.yaml, hooks/, retake.yaml,
the project theme's folder and template.yaml; 512 entries), each entry holding the files its checks looked for (core
`CheckContext.filesRead`: own media, data, SQL…) re-statted before it is trusted, and expiring after 60 s (the scenario
view's text TTL) — a removed asset shows at once; "current" by (capture, snapshot stat, file hash), posters by the run
folder's and timeline's stat through the board's own `RunDataCache`, render records by their stat, report.json by its
stat (renders.ts); one renders readdir and ONE pass over the job queue per call (each job.json memoised by its stat:
jobs are never pruned; the running take's job comes from the same pass — a take from a terminal has none, no second
pass). The jobs the board shows (`jobs`: render and review jobs only — a take's progress is the page's `run_status`,
never a board read). Measured (board-ops.test.ts): a 40-scenario copy with 30 runs cold 168 ms, warm 4 ms; the
fixture (16) warm 3 – 4 ms; 3000 jobs of another project in the queue warm 13 – 15 ms (154 ms before the memo). A test
proves a board read leaves the scenario views' memo untouched (no text, binding or run-list recompute).

**State words** (pure `board-words.ts`, every row tested). `productionState` → a mark AND a word (StatusMark; each word
carries a state word the checker's colour-only rule knows) and a smart group, first match wins: a file that cannot be
read / has errors (▲, no group); a take running ("Capture running · step 7 of 18", "Capture · queued"); a render job
("Render running · 40 %", "Render queued", "Review running"); a take that failed or was interrupted after the capture
(✕ "Failed at step 3 of proposal", "Interrupted": Failed); "Last take: status invalid" (a status the runner never
writes); a render that failed after the capture (✕ Failed); the capture no longer current (◆ "Script changed since the
shoot": Needs a shoot); a render of this capture on this file with today's theme — render-words `sameVersion`, the
scenario screen's own rule (critique M3) — with its review ("Rendered · clean / 2 warnings / 1 error / review pending / review running /
review stopped"); no snapshot ("Ready to render · cannot tell if current": Ready); a render of another take or file
(◆ "Render outdated": Ready); none (◌ "Shot · ready to render": Ready); no capture: a cancelled take, a passed dry run,
or nothing ("Draft · not shot yet") — Needs a shoot. A newer cancelled or `until` take leaves the capture's words.

**The store** (`project-data.ts`). One module-level entry per (op, project) for `project_get`, `project_board` and
`auth_status` — one call in flight, a reload asked meanwhile runs once after it, read through `useSyncExternalStore`
by the shell's browser, the screens and the Cast's Sessions panel alike: opening a project costs one read of each (an
e2e counts them, and a focus re-reads each once). The subscription is stable per entry and reads nothing; the first
reader of an entry (or one coming back to the project) reads it in an effect, so a re-render, another reader joining
or a change of screen inside the project reads nothing. An entry in error is read again on an event, a focus, a Retry
or after 2 s, then 4 s… (at most 60 s) while someone reads it — never in a loop (reviews A-H1 / B-H1: an inline
subscription had re-read all three at every re-render of the shell, one read per step of a take and ~300 a second on a
broken project.yaml). `boardEventAction` (pure, tested): a reconnection re-reads all; a run of the project that
appeared, changed status or went away, a scenario file or a render file (renders/ or review/: a review run from a
terminal) re-reads the board; the README the project; the project's project.yaml, sandbox.yaml or scenario list (the
`workspace` event's `files`) all three — another change of the project no list names is its runs folder before a run
is told: the board (an older server without `files`: all three); a run that only progressed nothing (the Project
screen asks `run_status` for the takes it shows running); a `jobs` event re-reads the board at most every 2 s, only for
a job it shows or one it never saw — and not for another project's job when the event names the jobs' projects
(`projects`); the Cast at most every 10 s, only for this project's jobs. The project list (main.tsx) and Welcome's
overview ignore a `workspace` event that only says runs progressed (`onlyRunProgress`). Measured
(studio-e2e-board-reads): a 24-step dry run from a terminal with the Project screen and the Cast open — project_board 4,
project_get 0, auth_status 0 on each (one of each per step before); a broken project.yaml over 5 s — 2 of each
(~1560 before); six arrow keys in the poster grid — one activity_list (the production inspector's Lately mounting),
then nothing.

**Routes and the shell.** `#/p/<slug>/g/<ready|shoot|failed>` (a smart group: the grid filtered),
`#/p/<slug>/loc/<env>` (the Project screen with that location in its inspector — no new screen, critique H2),
`#/p/<slug>/cast` (the Cast: today's Sessions panel until L5.11). One `ProductionsScreen` element, keyed by the
project, serves the project, its groups and its locations (the search stays; a location route clears the selection —
selecting a production afterwards shows it: the newest wins; a production the search or the group hides is no longer
selected). With the inspector hidden (its toggle, ⌥⌘I) what it shows — the project's facts, README and recent runs, a
production, a location's pages — is rendered in place under the grid (`ShellSlot inline`, under a heading of its own);
Welcome's workspace and Claude likewise. The browser shows the
open project's tree (§ studio-ui.md: Productions + groups with counts, Library, Locations, Cast, Project); the title
bar's project is a Menu (the workspace's projects, All projects → Welcome); the palette adds the project's pages, its
locations and "Open <scenario>". A production selected becomes the scenario in context (modes.ts `rememberScenario`:
the modes act on it).

**Screens.** Welcome (`WelcomeScreen.tsx`, `projects_overview` in one call as before; R4-Welcome's layout: an
identity column — the app's 128 px mark, name, version, New project, the projects folder — beside "Recent projects",
one column in a narrow centre; posters cut), the Project
screen (`ProductionsScreen.tsx`: the poster grid as ONE listbox — the kit's `PosterGrid`, critique M6 —, the project /
production / location inspectors, the recent runs kept for the "written by a newer version" rows), the Cast
(`CastScreen.tsx`), Lately and the search rebuilt on the kit (`Activity.tsx`; a production's Lately filters the
project's activity on the page). ProjectsScreen.tsx and ProjectPage.tsx are gone; every capability of theirs has a
home (README variants and its notice, warnings, environments' pages and display URLs, personas, the library link
`library-link`, Record `record-link`, scenario links `scenario-link` = the inspector's Open, the Sessions panel, recent
runs, activity, the "cannot be opened" state).

**Kit additions** (gallery entries, kit-static, the hostile-SSR slots, studio-e2e-kit): SourceList rows (icon, lead,
value, quiet, test id, a `detail` second line that wraps — a persona's location), Facts (a name goes on a `group`
around the `dl`), Disclosure, PosterGrid (as many columns as fit, 200 px at least — three at 1440, one at the desktop
app's 900 px; ↑ ↓ move by the layout's computed row; no `aria-activedescendant` while nothing is selected), the
`inline` field layout, TextField `maxLength` / `autoComplete` / `spellCheck` / `labelHidden` (a search icon), Txt
`title` (a tooltip, controls made visible), LinkButton `testId`, Blocker without a word (no mark), icons film /
components / location / person; Thumb sizes by a prop only (`size`: row, poster, inspector — critique M9: the legacy
screens keep the row size and its classes; L5.10b: frame / poster / inspector, `th-*` boxes — §4l (b)).

**Tests.** board-ops.test.ts (the op: allow-list, zod refusals, path-free, untrusted title; the facts through a
capture, a render and its review, a newer capture, a failure, a filmed change; budgets; the views' memo untouched),
board-words.test.ts (every row; never colour alone; the event table), app-source (the routes; every JSX child of the
project-side screens through Txt / a kit slot; no ratchet row; read ops only), kit-static, studio-e2e-kit (the
listbox's keys, the project tree and menu), studio-e2e (Welcome, the inspector's README and recent runs, a location's
pages, a hostile production title), studio-e2e-editor (one read of each per project open), the tours (Welcome, the
Project screen with nothing / a production selected — also at 900 px —, a group, a location, the Cast),
studio-e2e-board-reads (the read counts above; another project's job; the inspector hidden; 900 px; the lows). The
migrated e2e files keep every test title, assertion count and test id (a scratch guard compared them with HEAD).
Expectations changed on purpose: the README preview shows a bidi control as a visible mark (`[U+202E]`, through Txt
like every text from data — the editor keeps the exact bytes); the checker's state words gained "valid" (a persona's
session; "invalid" was there, "validate" / "validation" stay out); its reachable rule accepts a focusable listbox with
nothing selected and no `aria-activedescendant` (a checker self-test).

### 4l (b). The Scenario screen: storyboard, step inspector, scenes browser, YAML source (L5.10b)

R-UI-38 – R-UI-39. « Épure » 2, the scenario side. Reference: B32-Scenario and R4-Source (layout and drawing; R4-Light
for the light appearance); built from the lot's plan (§1.4, §3, §4) corrected by its critique (H2 the minimal take
strip, M1 the Location's conditions, M4 every capability's home, M5 the editor's text area, M7 the drop slot, M8 the
guard, L1 the intrinsic sizes, L2 the title bar at 900 – 1280, L3 the grid keys). A rebuild, not a cut: every capability of
L4.2 – L5.8's ScenarioScreen / Inspector / StepForm / StepEditing / YamlTab / YamlView / TextEditing / Thumb is kept —
same ops, same write path (`scenario_edit` with the hash shown, the step guards, undo / redo by `restore`), same test
ids. Cuts and deviations: BL-129.

**The screen in the shell** (`ScenarioScreen.tsx`). The scenario's name is a visually hidden h1 (the title bar names
it; it renders once the view is there — tests and screen readers wait on it). The title bar's context slot: **View**
(`SegmentedLinks` "View": Board · YAML — `#/p/<slug>/s/<name>` and `…/yaml`, unchanged routes) and **Location** (critique
M1): the project's environments, each option with its flags in words ("production · read-only"), default the file's
own (`video.env`, else the project's default); a choice is remembered per scenario in this tab only (a module map —
a reload goes back to the file's) and sent as `env` to `scenario_blocks` and `scenario_run` only when it differs from
the file's — a default run's body is the pinned `{project, name, mode, hash}` as before; the take strip says "Dry run
and Capture use the location …" and, when chosen, that Shoot (the Run screen) uses the file's own. Only a location
project.yaml has is ever shown or sent (L5.10b fixes, review A M1): a remembered one it no longer has is never sent
and is dropped once the project is read — from the map and the state —, said once above the take strip
(`location-dropped`); the select and the strip name the same one. An option leaves out a flag word that repeats its
name ("production · read-only", review A L7). A new shell slot
`browser` (slots.tsx): while claimed, the screen's own list replaces the project tree (the foot stays) — and the
board is not read behind a scenario screen (AppShell: `useBoard(null)` on scenario routes, critique M2). Comments
moved to Review mode: the take strip keeps the open count as a link (`threads_counts`, "Comments · 3 open").

**The take strip** (`TakeStrip.tsx`, minimal until L5.11 moves the run actions to the status bar): "Pictures from"
(a kit Select over the runs, `run-picker`), the source run as a shape + words + when (`source-line`), the comments
link; Dry run and
Capture in one line, each with what stops it said before any click (the button disabled, "— needs the terminal" / "—
fix the file first", the reason id read by the button) and the reasons with their commands folded under the line (a
Disclosure: the blocker's words, `retake run …` and its node form — `TerminalCommands`, a kit piece the Run, Record and
Timeline screens import too); Open timeline (or off with why); the location line; what the last click came to (queued
with Watch it live, its outcome with the first line of its error, or the refusal with its command); what the pictures
may not show (changed since the run with the filmed changes, only the edit changed, cannot tell, newer runs stopped
early with "Show its pictures", the run's error "from the page"); ConfirmSessions as before. The running take (a
callout: id, steps done, the current step, a progress bar, Watch live, Cancel: `running`, `run-cancel`) is the
screen's, above both views — the YAML view shows it too (L5.10b fixes, review B M1).

**The storyboard** (`Storyboard.tsx`). Entries in file order: a "Before filming" row card (the setup hooks; its
inspector also lists the named hooks "during the take, off camera"), the filmed scenes numbered 1, 2, 3 (cards and
interstitials as row cards between them: a 96 × 54 tile, the slots' title / kicker / text, "Card · component · 2.5 s"),
an "After filming" row card. A scene: its h2 (the caption's kicker, else its id), the caption's text, its flags in
words (skipped, off camera: played, not in the video, irreversible), "Scene 1 · shop, / · 9.3 s" (a button: the scene
into the inspector) and Add step (the palette placed at the scene's end); its comment, note and issues; then its
frames — the kit's **FrameGrid** (ONE listbox per scene; three columns while the board — a `k-board` container — is
wider than 600 px, two down to 380 px, one below: the board's width, not the window's, L5.10b fixes A-L4 / B-L6; the
one tab stop is the list holding the selection, else the selected scene's, else the first scene's;
`aria-activedescendant` only there) of **FrameOption**s (measured at 1440 × 900: a frame 256 × 201, its picture
244 × 137, 20 px gaps): the step's picture from the source run (Thumb.tsx, asked only on screen) or why there is none
in words, its number over it, its verb (600: the action's own words when they start with it — "Wait for", never "Wait
wait for") and its target, else its `summary` ("Wait 1.6 s", "Press Enter"), then its state in that run as a shape and
words with "took 2.1 s", "matched by position: cannot tell whether it changed", its modifiers in words, the `summary`
beside a target (B32's note) and its issues. Above the scenes: "25 steps in 4 scenes · scenarios/quote.yaml"
(`board-count`). A scene's length beside its number: a capture's seconds, else "not shot yet" (no run with pictures),
"no capture yet" (a dry run's pictures) or "not captured" (review A L5).
Selected: the selection fill and a 2 px ring; dragged: a dashed outline and a dimmed picture (no opacity in the kit);
an edit on its way: every frame's edge dashed (`aria-busy`). Keys (pure `board-keys.ts`, tested): ← / → the step
before / after across scenes, ↑ / ↓ the frame in the same column of the row above / below (into the scene before's last
row or the next scene's first, the column clamped, an empty scene skipped), Home / End, Page Up / Page Down three rows
— index arithmetic on the step counts and the grid's computed columns, never a measure of a frame (a skipped scene has
none); Alt+↑ / Alt+← move the selected step one place earlier, Alt+↓ / Alt+→ later (`keyboardMove`; Alt+← is
prevented: Back in some browsers), Delete / Backspace delete it; a held key repeats no edit; ⌘Z / ⇧⌘Z as before.
Entering the frames (L5.10b fixes, review A M2): a list that takes the focus with no selection in it (Tab with a scene,
a card, the hooks or the video selected; a click in its gaps) selects its first step — the focus is never on a listbox
with no active option —, a grid key with no selection in the list lands on its first step (End: the last of all), and
a mouse-down on a frame (a click or the start of a drag) makes it the active option at once. One selection (review B
M2): the screen resolves it once (`resolveSelection`) and the board, the browser and the inspector show that one; a
picked step whose key leaves the file leaves its scene selected (else the video), a gone scene or card the video —
never another step, whose Delete the person did not pick (keys are "<scene>.<index>": BL-129).
Drag & drop (critique M7): the drag state lives in the page (never `dataTransfer` contents; an outside drag is refused
by the window guard); the list takes `dragover` / `drop` itself, so the 20 px gaps are its; the slot is
`slotFromPointer` (the nearest row by Y, the frame's half by X; past the last frame of the last row — the trailing
empty cells — the end of the scene; tested) and the insertion bar is drawn on ONE side (after the frame before the gap;
before the first frame for gap 0); an empty scene keeps its drop zone (`drop-empty`, in the kit); a locked scene
refuses. Huge scenarios: no virtualization — each scene is `content-visibility: auto` with its own intrinsic block
size (120 px of header + rows × the row height: critique L1 — the columns and the row height measured on a rendered
scene and kept up to date on resize, review A L4; 236 px and three columns before the first measure; the inline size
stays the board's — a remembered width overflowed the 900 px centre), frames memoised (the source run one object, so
a selection re-renders the two frames it changes, not the board: review A L3, a React commit hook in
studio-e2e-scenario counts them). Measured (studio-e2e-scenario, 1,200 steps from the Project screen): interactive with
its first picture 295 ms after the route change, one `scenario_blocks`, ≤ 2 `run_thumbs` calls of ≤ 24 keys before any
scroll (scene s0's keys only), End → only s11's keys; a fast scroll: 21 calls, 20 aborted, at most 1 in flight.

**The inspector** (`ScenarioInspector.tsx`, replacing Inspector.tsx). A step, in B32's order (L5.10b fixes, review B
L4): its picture (the inspector's width, 288 × 162 measured), "Step 3 · Click" (`inspector-step`), its scene and "took
1.6 s in this capture / dry run", its form (the Action fields, then the Modifiers: at 1440 × 900 the last modifier row
ends at 611 px, unscrolled) or its target, what the action does (`inspector-hint`), Move up / Move down / Duplicate /
Delete in a toolbar (`step-actions`: no `aria-keyshortcuts` — the keys act in the frames, review A L2; the button an
edit came from keeps the focus once editing is back on, so Enter again moves it again — `data-step-action`, review A
L1), why it is read-only or where else to change it (`edit-hint`), its issues; "In this run" (open: `inspector-run`,
Show in timeline, the "From the page" box); "As written" (folded
while the form shows the values: `inspector-args`, the modifiers' chips, its comment, its lines `inspector-source`);
"Show in the file · line 37" (the YAML view, the lines outlined). The form (`StepForm.tsx`): the kit's fields in the
inspector's row layout (`data-field` kept), each named in words (`fieldLabel`: "Text", "Milliseconds", "Move time (ms)",
"Typing speed (characters a second)" — not the schema's keys in mono), a target's empty ways to find it under "Other ways to find it (n)" and the
empty optional fields under "More: …" (Disclosures, `form-more`), the **modifiers as switches** (caption, hold, speed,
mark — core `MODIFIER_KEYS`, a local copy: the page imports no runtime code from core): on shows their fields, off
empties them so Save sends their removal (the same `set_step` changes, each with what the form showed); its own unsaved
mark only (the kit fields `unsaved={null}`: critique M5). A scene: its caption, flags and facts (page and URL — each
page of a multi-page scene, `scene-pages` —, persona, speed, layout, captured length and this run's status, transition,
cursor, still, tutorial), note, comment, issues. A card / an interstitial: component, file, length, slots or kicker and
text, transition, issues. Before / After filming: the hooks (`hooks`, `hook`: kind, name, flags as words, what they
run, rollback, a person needed, issues), this run's outcome, the named hooks (`named-hooks`). The video: its facts —
its location is the file's own ("local (the project's default)") with the tab's choice beside it ("(Dry run and
Capture: signed-in)", review A L6) —, the notes from the file (`video-block`), the comments link.

**The scenes browser** (`ScenesBrowser.tsx`, the browser slot): Video (the total captured length), Before filming,
each scene (its number, title, length and a 2 px bar against the longest: decorative), cards and interstitials
(quieter, their length), After filming — kit `SourceItem` rows with `onSelect` (buttons, `aria-current="true"`). A row
selects its entry and brings it into view: on the board the entry, in the YAML view its lines.

**File-wide notices** (critique M4) above the edit bar: a YAML draft open (board edits off, `yaml-draft-open`), "This
file is not valid YAML" (`invalid-yaml`), the file's issues with their lines (`issues`, unpositioned ones included),
the steps limit (`steps-limit`). The edit bar (`StepEditing.tsx` `EditBar`, a kit Toolbar: Undo / Redo naming the
edit, Add a step…, "Busy: saving…", the live region; why editing is off; the 409 offer; a refusal with its issues)
and the palette (`StepForm.tsx` `Palette`) are the same flows on the kit. Every message says "the YAML view" (the core
and engine refusals and reasons included — "fix it in the YAML view first"; the 409 offer says "The board now shows the
new version"), and the Timeline and Comments screens' link back says "Board" (L5.10b fixes, review A L7 / B L2). Callouts (`Callout`, a kit piece) replace
the legacy Notice; every mark's title or word carries a state word the checker knows ("Note:", "Warnings:", "Blocked:",
"ready · nothing stops it").

**The YAML source** (`YamlTab.tsx`, `YamlView.tsx`, R4-Source): a toolbar line (the file mono, "Comments and layout
are kept when you edit the board.", Edit / Save / Discard changes / Close the editor); the read view — numbered lines
with each issue under its line (a shape and a word), the focus lines outlined; the editor — the kit TextArea, now with
`inputRef`, `maxLength` (500,000), spell check and auto-correction off, extra describing ids (the counter and the
save state) and `unsaved={null}` (the draft's mark is drafts.ts's); drafts, `if_match`, the 409 panel, live
`scenario_validate`, the read-only reasons and hidden characters as before (TextEditing.tsx on the kit, also used by
the legacy README editor). The **File** inspector: valid or how many errors in words, warnings, unsaved changes in the
editor, the "same checks as Claude's edits" sentence, hidden characters by line, lines · characters of the cap · steps,
read-only. Syntax colours, Ln / Col and the Outline are cut (BL-129: the scenes browser plays the Outline's part).

**Kit additions** (`ui-kit/frames.tsx`, panes, fields; a gallery section "Storyboard", kit-static, the hostile-SSR slots):
FrameGrid / FrameOption / RowCard (`slotFromPointer`, `dropSide`), Callout, TerminalCommands, SourceItem `onSelect` and
`bar`, Disclosure / InspectorSection `testId`, Switch `layout="row"`, TextField / Select `dataField` / `testId` /
`title` / `describedBy` / `inputMode`, Select `error`, TextArea as above, `gridColumns` exported. Thumb.tsx: sizes
`frame` (its column's width, 16:9), `poster`, `inspector`; its boxes' look is screens.css's `th-*` (the row size and app.css's
`.thumb` classes are no longer used). The two real-control exceptions moved from ScenarioScreen.tsx to
`ui-kit/frames.tsx` (the option and the empty scene's drop zone).

**Ratchet.** ScenarioScreen.tsx (236), Inspector.tsx (64, deleted), StepForm.tsx (68), StepEditing.tsx (29),
YamlTab.tsx (50), YamlView.tsx (12), TextEditing.tsx (30) and Thumb.tsx (5): 494 rows removed; the new files
(Storyboard, TakeStrip, ScenarioInspector, ScenesBrowser, board-keys) have none. Left legacy as planned: Sessions.tsx,
ReadmeEditor.tsx, Renders.tsx (its card in a closed "Renders and review" section at the board's end, `renders-card`,
until L5.12), CommentsTab.tsx.

**Tests.** app-source (every JSX child of the eleven scenario-side files through Txt / a kit slot — a planted bare
target and scene title fail it —; no ratchet row and nothing off the kit; the ops they call — reads, `scenario_edit`,
`scenario_run`, `run_cancel` — and every `scenario_edit` call naming the version shown), kit-static (the frames
listbox, the row card, the callout, the source button row, the switch row, the commands; the drop slot table),
storyboard-app (the keys, the intrinsic size), studio-e2e-scenario (the board, pictures, keys by column, events,
hostile text in the scenes browser and scene titles, the 1,200-step budget, run actions, multi-page facts in the
scene's inspector), studio-e2e-edit (+ a drop in a column gap and in a trailing cell with the exact place; add, move,
duplicate, delete, a form's change and undo each one `scenario_edit` with the file's sha256), studio-e2e-forms
(+ a switch off sends the removal), studio-e2e-yaml (+ the File inspector, a browser row outlining its lines, a file
that does not parse), the tours (the board with a step selected at 1280 / 1440 dark, 1280 light and 900, a row card
selected, the YAML view read and editing, a file that does not parse on the board and in YAML). The migrated files keep
every test title, assertion count and test id (the scratch guard); listed renames: `comments-tab` → `comments-count`
on the scenario screen.

## 4m. Shoot: prepare, live, the status bar's actions, the Scenario menu (L5.11a)

R-UI-40 – R-UI-43. « Épure » 3a. Reference: R4-ShootPrep, R4-ShootLive, R4-Confirm (layout and drawing), the status
bars of B32-Projet / B32-Scenario. Built from the lot's plan corrected by its critique (H1 command priorities, H2 the
status bar's read and its memo, H3 blocker words by gate, M1 no page probe, M2 the shared location said, M3 the palette,
M4 a terminal's run, M7 one Stop). A rebuild, not a cut: every capability of L4.4's Run screen, LiveView and Sessions is
kept (pause on L5.7's clock, stop with its teardown words, pause too late, the live preview channel, two streams then the
run_status fallback, steps / hooks / log, sign-in limits, the headed sign-in, the check-less personas' paragraph,
protected hosts as blockers); the quit guard and the notifications of L5.2b are untouched (the notification word for a
dry run is now "Rehearsal": desktop core words.rs). Cuts: BL-130. The Record screen is L5.11b.

**Words.** *Rehearse* (the action), *Rehearsal* (a run of that mode), *Rehearsing* (its state) everywhere the page and the
desktop shell write; `mode: 'dry'`, the CLI's `--dry`, MCP `run_dry`, job kinds and the engine's messages are unchanged
(Prepare shows one mapping line). A source lint (app-source.test.ts) fails on "dry run" in a string the page shows
(comments, test ids, the mapping line and the ops' descriptions excepted).

**The engine.** `RunBlocker.kind` (`agent_trust`, `opens_other_site`, `protected_host`, `hook_refused`, `read_only`,
`needs_approval` with `count`, `invalid`, `prepare`) — set by `runBlockers` from the gate that threw (`blockerKind`; a
preflight that failed is `prepare`, never a safety reason; `opens_other_site` when every agent-trust problem is a URL
outside the environment's origins: `checkAgentTrust` puts their count in `details.navigation`); `ScenarioRunChoice.job` on an unfinished run (null: a terminal's run); `running` is
the newest unfinished run WITH a job, else the terminal's (`runningOf`: a terminal's run and a Studio job can be
unfinished together — the one-run check sees jobs only — and Stop must reach the one it can).
`engine.scenarios.actions` (op `scenario_actions`, a Studio read in the `ui` allow-list, strict input: project, name,
env): hash, validity, the blockers on the location, the scenes and steps, the runs with the unfinished one, the capture
a render edits, a render queued or running. Its layer has its own memo (64 entries) — it reads a fresh text layer of the
scenario screen's cache, never inserts into it — and both layers are single-flight (two reads at once compute once).

**The status bar** (`shell/StatusActions.tsx`). On every screen with a scenario in context: its state in a non-live span,
then Rehearse, ● Capture, Render, and Pause / Stop while a run of it is unfinished; one blocker line at a time
(Capture's, else Rehearse's) in the gate's words (`shoot-words.ts` keyed on `kind`, an honest fallback, never cut) with
Command… — a popover that SHOWS the whole command, wrapped, beside its Copy (what is copied is what is shown) — or Open
the YAML; each disabled action's full reason as its description. In a narrow window whole segments give way by
priority (the key caps, "live updates" and the last take's time at ≤ 1100 px; the scenario's name and the last take at
≤ 1000 px; Command… keeps its icon), never a word cut in half. No action acts before the project is read; one that
cannot act says why in the polite line and sends nothing; the line never says a step's progress. The polite line is
text (Txt), one line at a time (a new one replaces it), gone after 6 s and when the screen changes. On the
Scenario screen the screen feeds it its own view, run_status and render queue (`useFeedActions`: no second read); on
the Project screen a selection is read once it settled 300 ms; elsewhere `scenario_actions` (shoot-data.ts entries,
re-read by the scenario's file, a run of it appearing / changing status / going, the project's files, a focus, a
reconnection; a render it shows at most every 5 s, a job it never saw every 2 s; a step's progress — its run's job
rewritten — never: the run's end comes by its run.json, `useRunProgress`'s end or Stop's own reload). The shell's
`engine_info` is read again on a job it never saw (a worker may start), a reconnection and every 15 s — not per step.
Starts go
through ONE store function (`startRun`: a scenario being sent ignores a second start in the same tick; the run just
queued counts as running until a read lists it); they send the hash of the file on screen (`useShownFile`: the
Scenario screen's, the timeline's with its run) and `env` only when the tab chose another location (run-location.ts:
one choice per scenario in this tab, shared by the Scenario screen, Prepare and the status bar; a stale one dropped
once the project is read, said by the screen that shows it or by the polite line). Stop and Pause reach the run's job;
a terminal's run has none ("press Ctrl-C there", also said beside Prepare's disabled Pause / Stop). A start stays where
it is, except from Shoot (Prepare, or a run's live screen — its outcome's Rehearse again / Start capture): the new run's
live route opens and its title takes the focus.

**Commands** (`shell/command-bus.ts`). `MENU_COMMANDS` += `rehearse`, `capture`, `render`, `stop`; the desktop app's
**Scenario** menu (between View and Window) sends them — ⌘R, ⇧⌘R, ⌘B, ⌘. — as page commands (always enabled: a command
that cannot act says so; menu state stays BL-126). A browser tab binds none of the four (the browser keeps them); the
palette's Scenario group runs them. The bus gives a command to the highest priority, never to effect order: the status
bar's defaults 0, a screen 10 (Prepare's Rehearse / Capture, the live screen's Stop while its run goes), a live
recording 20 (L5.11b: the Record screen's four commands while its recording goes — it also claims the status bar's
actions: one Stop visible, §4h); a tie
goes to the latest. While a modal dialog is open the menu's commands wait — but Stop, which closes the palette first and
always answers. On a live screen ⌘. waits for the stream (or run_status) to say whose run it is, says a stop or a pause
already on its way, and sends one call however often it is pressed.

**Prepare** (`ShootPrepare.tsx`) and **live** (`ShootLive.tsx`, LiveView.tsx on the kit, the one image decoder kept):
see docs/reference/studio-ui.md. Prepare probes no page (critique M1: a run refused at submit never reaches its pages,
so Prepare does not either). Its Start buttons stay enabled while a start is sent (a repeat is said, never sent: a
disabled button would drop the focus) and sit in a footer that stays at the foot of the centre pane; a refusal takes
the focus; a project or scenario that does not load says so where the screen would wait. Its Sessions table has no
Location column (the checklist's first item says it), the Session column takes the free width, the run notes sit on
their own line (a note an issue's callout says is left out), the rows stack below 520 px of pane (a container query),
and a sandbox account or a persona its login steps sign in offers no "Sign in…". The live screen claims the status bar
while its run goes (Pause / Resume, Stop; its state word from the status bar's table: Rehearsing, Capture paused…) and
releases it when it ends. A stopped run is "stopped" everywhere the page speaks (the engine's `cancelled` and
`partial: cancelled` are mapped).

**The sheet.** The capture's confirmation is the kit's Sheet in the shell (one for the status bar, ⇧⌘R and Prepare):
`alert` (not destructive), Cancel · "Sign in <persona> first…" (the default) · Capture anyway (`sessions_ack` once).
Opened before any request on Prepare (it knows `confirm`), on the server's 409 `details.sessions` elsewhere. It is a
page `<dialog>`, not a native sheet (§4j's native sheets are for the server's own asks: L5.12): the question is the
page's. A protected location is no sheet: it is a blocker with its terminal command (the Studio has no approver).

## 4n. Edit and the Review report (L5.12a)

R-UI-45, R-UI-46. « Épure » 4a. Reference: R4-Edit, R4-Review (layout and drawing; "Retake" read as `APP_NAME`). Built
from the lot's plan corrected by its critique and the lead's decisions (H2 Edit's own Render, M1 lints re-pointed by
name with an app-wide count, M3 the MP4 export as a job, M4 this part's own a11y stations and legacy CSS, M5 cuts, M6
Cancel and the version note on Edit). A rebuild: every capability of L4.5's TimelineScreen / TimelineTracks /
TimelineInspector / PreviewFrame / Renders is kept (the Player on its own origin with the literal sandbox, no IPC; the
seek loop, the keys, the 409 offer, undo by exact bytes, the workspace-component hold, the lease, deep links, comment at
the playhead, pins). Cuts: BL-132.

**Shell.** `BrowserCollapsed` (slots.tsx): a screen hides the browser pane while mounted (`.sh-app[data-browser=none]`,
the grid drops the column). Route `review` — `#/p/<slug>/s/<name>/review[/<render id>]`, the render id of a render id's
shape (`RENDER_ID` = core `RENDER_ID_RE`) or not found; `modeOf` → review; `modeTarget('review')` → the Review view
this tab used last (`noteReviewView`, the report first). The View (`ReviewViews`: Report · Comments (n open), counted by
`threads_counts`) sits in the title bar's context on both views (the comments screen keeps its own tabs until L5.12b).

**Edit** (`TimelineScreen.tsx` keeps the one `<PreviewFrame` with `url={urls.frame}` and the checked-URL line — the
source lint pins them by name; `EditPreview.tsx` the stage, overlays and transport around it; `TimelineTracks.tsx` on
the kit's Track / TrackItem; `TimelineInspector.tsx` on ChoiceChips / NumberField / Callout; `EditNotes.tsx`;
`EditStatus.tsx`). The tracks are memoised and take no playhead: the Scrubber and the Playhead are the screen's, drawn
over the lanes, so ten seeks on a 1,200-step take render no track item (studio-e2e-edit-budget counts React's commits).
The inspector's top (the switch's words, a refusal, the 409 offer) is sticky in the shell's pane; the selected segment
is said in the inspector's own polite region; an undo / redo asked while a switch is written is queued, said ("Saving…
Undo in a moment") and run once its view lands (BL-122). Edit fills the status bar's actions: what is on screen, the
render line (polite: the job's words, the newest failure, "Latest: vN · verdict · from this version", a render this tab
queued "reviewed"), Cancel the render (Stop stays for runs), Undo · Redo, Render. **Edit owns `render` at
`PRIORITY.screen`** (H2): ⌘B and the palette run `useRenders().render(target)` — the capture and the file as shown
(`expect_edit_sha256`), refused and re-read on a 409 change (`render-refused` Callout, `onStale`), one at a time,
"Render the take as captured" on such a take; on a proposal's route the target is a reason: said, nothing queued.
Show in Edit hands over through `edit-handoff.ts` (module memory, taken once): Edit seeks to the finding's frame only
when that render is of the version it plans (`versionNote(…).same`: the same plan signature and theme files), else to
the step, with a note.

**The Review report** (`ReviewScreen.tsx`, `review-words.ts`). Reads only what existed: `scenario_renders`,
`render_review`, `review_image` (one at a time: the next once the one before answered), `render_frame` (FrameRequests:
one in flight, the newest wins; this tab's session), `threads_counts`, `activity_list` (the export's state, path-free),
and the status bar's shared `scenario_actions` entry (the file's hash and the latest capture: Render again). The check
families are a page-side table total over the review package's FINDING_CODES (a test); a family with nothing found is
not listed — the report never says "passed" (a review records findings, not the checks that ran: BL-132). Checks are
one RowList listbox, each family a `role=group`, RowCard options; the selection drives the inspector. An unknown render
id is an empty state; nothing is read with it. Render on the report re-renders the scenario (its latest capture, the
file on disk) through useRenders — the same refusals —, and a render queued there opens its report once reviewed.

**`review_export`** (ops.ts renderOps; Studio-only, in the `ui` allow-list, never an MCP tool): strict input `{project,
render_id}` (a render id's shape); queues the engine's existing `export` job with `formats: ['mp4_1080p']` into the
fixed `exports/<render_id>/`; one at a time per render (a 409 naming the job while one is queued or running) and at most
`REVIEW_EXPORTS_OPEN` = 2 exports of the workspace queued or running at once (a CLI's or Claude's count; a 409 "2
exports are already queued or running"); the check and the submit run in one chain for the whole workspace (since
L6.5 the engine's `export_cap` admission rule, `EXPORTS_OPEN_MAX`, for the Studio and MCP alike), so two clicks, two
tabs or two renders never interleave (the race is tested: two calls at once on a
render with no export yet give one job). The worker runs one heavy job at a time anyway (one worker per workspace, L5.14):
the cap keeps one page from queueing an export — possibly a re-render — of every render. The answer is path-free (`job`,
`state`, `formats`, `where` in words). The raw capture stays a command to copy, built only from a slug and a run id that
pass their rules (`rawExportCommand`).

**Kit additions** (gallery entries in both appearances, the hostile-slot SSR test): `ChoiceChips` (roving radio group of
buttons; a disabled chip `aria-disabled` and focusable with its reason; the real-controls exception re-keyed to it and
one `role="radiogroup"` app-wide), `Track` / `TrackItem` / `Scrubber` / `Playhead` (tracks.tsx), `ContactSheet`, `Tag`,
`NumberField`; `Progress`, `RowListItem`, `LinkButton`, `SegmentedLinks` gained test ids / a label; icons zoom-in,
zoom-fit, export. Legacy: Timeline* / PreviewFrame / Renders leave the ratchet (−294); their app.css rules went (the
theme editor's `tl-undo`, `tl-preview-note`, `held-list` stay) with the 12 legacy tokens only they used.

**Fixes after the two reviews.** Render on a proposal's route is refused in every state of Edit: the status bar's
`renderWhy` says `PROPOSAL_RENDER` on route `proposal` (its button off, ⌘B said) and Edit's loading / error / blocked
states own `render` at `PRIORITY.screen` with the same words (A-M1). An undo / redo queued behind a write that fails or
meets a 409 is dropped and said once ("Undo cancelled: the switch was not saved…"), never run against the switch before
(A-M2). Every value from data in the eight Edit / Review files goes through Txt — the h1 names the scenario as text,
the finding's code too — under an app-source lint (`EDIT_REVIEW_SIDE`) (A-M3). Show in Edit's "made from another
version" note only when the render is listed AND differs; a finding with no frame on this version goes to its step or
stays, silently; a render no longer listed goes to the step, no frame trusted (B-M1). The pending ask is dropped by a
route anywhere but that scenario's Edit (`editSeekRouteChanged` on hashchange) and by an Edit that cannot show the take,
whose error / blocked states keep the browser collapsed (A-L6, A-L7). The export part re-reads the activity on its own
project's jobs only (`exportReadsOn`, A-L1). On the scrubber `[ ]` and Shift+← → are the screen's (A-L2). Track items
are 24 px targets: 24 px tall, a centred 24 px hit area under a narrower span (`::before`; the button no longer clips),
the ticks of a lane nudged apart by `spaceTicks` while it has room (a ResizeObserver per lane with ticks; a crowded
lane keeps them on their frames) (A-L3). ContactSheet's toggle keeps one name (A-L4). Render rows are links
(`RowCard to`, `aria-current`) (A-L5). The report's status bar says "Rendered · when · vN" with the neutral `idle` mark
(B-L1); renders sharing their "when" words show their time of day (`sharedWhen`, `clockWords`) (B-L2); Edit's status
line is plain words (B-L3); the inspector's empty answer line takes no room (`.ed-live:empty` visually hidden, the top
`display: contents` while it holds nothing) and its general hint is last (B-L4); the transport's Toolbar
`clickLeavesKeys`: after a click focused one of its buttons (Chromium), the arrows, Home and End stay the playhead's
(B-L5); the unused `mp4ExportCommand` went (B-L7).

### 4n (b). Frame comments, Claude's proposal, the README editor, the ⌘K palette (L5.12b)

R-UI-47, R-UI-48. « Épure » 4b. Reference: R4-Comments, R4-Palette (layout and drawing; "Retake" read as `APP_NAME`). A
rebuild: every capability of L4.6's CommentsScreen / ProposalPanel / CommentsTab and L4.1's ReadmeEditor is kept (the
FrameRequests contract — one frame request in flight, the newest wins, 429 backoff, 503 retried once, one session per
tab —, `frame_anchor`'s 150 ms settle and sequence guard, the 409 reloads with the text kept, buttons from the server's
`offer` only, Undo apply while today's file is the one the apply wrote, Apply and re-render, Resolve with vN, render
gone / still, newer renders; the README's if_match saves, conflict, disk banner, 200,000 cap, CR LF kept, read-only on
`readme_error`, drafts across navigation). Cuts: BL-133.

**Review › Comments in the shell's panes** (no layout or breakpoint of its own: the shell narrows the panes). Context:
Review's View, whose Comments segment carries the old tab's `comments-tab` and "Comments (n open)" on both views
(CommentsTab.tsx deleted). Browser pane (`ShellSlot name="browser"`): `ThreadList.tsx` — Open · Resolved · All as a
kit Segmented (the radios keep `filter-*`), "This render only" a Switch, the counts, rows as RowCard links (`to`,
`aria-current="page"`: rows that navigate are links), "All" grouped Open (n) / Resolved (n); while a new filter is read
the last list stays (`aria-busy`): the pane never flashes back to "Loading". Centre: `CommentsScreen.tsx` (placement,
events, the head line and the render picker), `FrameViewer.tsx` (the frame with the kit's `RegionOverlay`, the
Scrubber named "Frame", markers and pins on one Track — a pin is a TrackItem link to its thread —, ± 1 s / ◀ ▶, the
typed time, ← → / Shift), `Composer.tsx` (the region as four NumberFields, Clear, the chips as Tags, a TextArea with its
unsaved mark, ⌘↩). Inspector: `ThreadPanel.tsx` (the thread, its entries, Reply / Resolve with its note / Reopen through
ONE `send` helper) and `ProposalCard.tsx` (the apply store, `applyProposal`, the card with the kit's `DiffTable`).
`ProposalBanner.tsx` is a Callout over Edit's stage and never applies. The proposal focus hand-off (`focusProposalOf`)
names its project and thread and is dropped by a route anywhere else (`proposalFocusRouteChanged` on hashchange) and by
a thread that cannot be read. The pointer surface of the region drag is FrameViewer.tsx's (the real-controls exception,
keyed exactly); RegionOverlay is presentational. The write rules are structural (see "Fixes after the two reviews"
below): an allow-list of ops per file, an import graph, `if_match` on each guarded call's argument object.

**DiffTable** (kit): the caller's rows (comment-words `diffRowsView`): a sign (shown) and its word (hidden), the line
numbers, the line as a `<code dir="ltr">` cell with a bidi override (byte order), edge spaces `·`, tabs `→`, unseen
characters `[U+…]`, a "right-to-left text" marker; every row shown, no inner scroll; add / del rows differ by a 3 px
bar beside their sign (the colour-only rule: a row that starts with a sign). Its text pieces are shown as text with
direction controls made visible — never inside a `<bdi>` (an isolate would undo the byte order).

**README editor** on the kit: a tall TextArea (`#readme-text`, prose wraps), Callouts for the missing README, a notice,
an error; the shared TextConflict / KeptText / DiskBanner; save-state words; ⌘S; the count and its cap; the read-only
view on `readme_error` (its text and the person's unsaved draft in read-only TextAreas). Still no Markdown preview.

**The ⌘K palette** (R4-Palette): 640 px (`--ui-palette-w`), "Search commands, scenes and themes", an icon per row, Esc's
key cap in the field, a footer legend read by assistive technology too (↑ ↓ Move · Return Run · Esc Close; "Commands
with a key are also in the menu bar" only in the desktop app — a row shows a key only when it is a menu bar item); its list is never a tab stop of its own (`tabIndex=-1`: a long list scrolls, which Chromium would
make focusable). Groups, in order: **Commands** (the Scenario menu's — or a live recording's own, L5.11b —, Review's
"Comment at this frame", the inspector), **Go to** (the modes, "Review report — last render · <words>" from the
review's badge words, never "passed", the project's pages, All projects, UI gallery), **Scenes**, **Themes** (the theme
set for the scenario Edit shows, the project's, All themes), **Scenarios**, **Projects**. Screens fill their groups
through `paletteGroup` (command-bus.ts, generalising L5.11b's `scenarioGroup`: slots `scenario`, `scenes`, `review`,
`report`, `themes`; the latest mounted per slot; `useScenarioGroup` kept as an alias). **The palette never writes**: an
entry goes somewhere or selects something (a scene is picked — on the Scenario screen's YAML view, its lines, like
the browser's pick —, a theme row opens the theme editor — setting a theme stays the inspector's). The Scenario menu's
own commands (Rehearse, Capture, Render, Stop; a live recording's Stop recording / Discard…) are the exception: they
act, as from the menu. Held by a static check (every screen group's handlers, followed to their definitions in scope,
reach no writer) and e2e op counters: every row of the palette on the Scenario screen but those four commands, every
Scenes and Themes row and the report row on Edit, the report row and "Comment at this frame" (both branches) on
Comments.

**Legacy:** CommentsScreen, CommentsTab, ProposalPanel and ReadmeEditor leave the ratchet (−339); their app.css rules
went (comments, proposal, README editor) with the nine legacy tokens only they used (`link-hover`, `faint`,
`warning-faint`, `warning-mark`, `ink-veil`, `on-ink`, `on-ink-muted`, `mark-on-video`, `mark-edge`); a11y stations
for a thread with its proposal, the README conflict and the palette on Edit at dark 1280 / 1440 / 900 and light 1280.

**Fixes after the two reviews (L5.12b).**
- Writes, structurally: `COMMENTS_OPS`, the ops each comments-side file may call (ThreadList `threads_list`; FrameViewer
  `render_outline`, `render_frame`; Composer `frame_anchor`, `thread_add`; ThreadPanel `thread_get`, `thread_still` and
  its one helper; ProposalCard `thread_apply`, `scenario_render`, `scenario_edit`, `thread_resolve`; ProposalBanner
  `thread_get`); ProposalCard.tsx exports only its card (`applyProposal` is private), imported by ThreadPanel.tsx alone;
  the banner's value imports are an exact list (a read, words, the focus hand-off, the kit); every `thread_resolve` /
  `thread_reopen` / `thread_apply` call — direct or through ThreadPanel's `send` — names `if_match` in its argument
  object (`thread_reply`'s strict input has none: it sends its text only). An e2e clicks every control of the timeline's
  banner and sees no write.
- Review's status line is one component for both views (`ReviewChrome` in ReviewScreen.tsx, with `useReviewRender`):
  "Rendered · when · vN · n open · n resolved", Open in Edit, Render (⌘B at the screen's priority) — on Comments, of the
  render the viewer shows. Shoot's line and buttons never show on Review's routes (StatusActions stands down there).
- The list's words are the list's own: an answer is tagged with the filter (and render) it was read with, so while
  another filter is read the old list keeps its own groups and empty sentence (marked busy).
- Performance: the palette's "Comment at this frame" names the render only (the frame is read when it runs: a frame in
  its words rebuilt the shell's command list on every step); ThreadList and ThreadPanel are memoised (useRenders returns
  one object while nothing in it changes), the diff's rows computed once per proposal read — a frame step re-renders
  neither the shell, the list nor the thread (an e2e compares their fibers' props).
- FrameViewer: the picture's alt names the frame it shows; one status line, always mounted, says a frame slow to come
  after 600 ms; a `pointercancel` cancels like Esc; the arrows wait while a modal is open.
- Composer: arriving at an `at` address (Comment this frame, the timeline's Comment or C), once the frame is laid out,
  the text box and Post are scrolled into view (`block: 'nearest'`) and the text focused; the text box is described by
  the characters left and "⌘↩ posts…"; a polite line speaks the characters left only as 200, 100, 50, 10 and 0 are
  crossed (`charactersLeftAnnounced`).
- DiffTable: the table is named by a caption; the edge-space dots and the tab arrow are `aria-hidden`, read as words
  ("2 leading spaces", "1 trailing space", "a tab").
- Palette: `aria-expanded` false while nothing is listed; the composition guard also checks keyCode 229 (WebKit ends a
  composition with `isComposing` false); the report row reads "last render vN · not reviewed" for a render without a
  review, "no finished render yet" when only failed ones exist.
- The a11y checker skips what lies behind an open `dialog:modal` (the reachable rule and the families' walk: the page is
  inert); the palette-on-Scenario station is back.
- At 900 px (a trade-off, said in studio-ui.md): the frame ≥ 260 px, the diff's code column ≥ 160 px with its lines
  wrapped, no sideways scroll — an e2e holds it.

### 4n (c). The Library, the Themes list and the theme editor (L5.12c)

R-UI-49. « Épure » 4c. Reference: R4-Library, R4-Theme (layout and drawing; "Retake" read as `APP_NAME`). A rebuild:
every capability of L4.7's LibraryScreen / ThemesScreen / ThemeEditor is kept (posters only for cards on screen —
library-load.ts' chunks of 12, the 2 s debounce, Retry, nothing while the tab is hidden —, checked data addresses for
every picture, Play that never starts by itself, the registry notices, the failed job's words, set as theme default with
`if_match` and an exact Undo, copy-first for a read-only theme, Create with Claude's prompt of checked names; the theme
editor's one write path `theme_edit` on the version shown, ThemeHistory ≤ 50, DraftThrottle 5/s with the write on
release, the 409 re-read, held workspace components with Allow, the lease, Use in a scenario with its Undo, the unsaved
`theme_draft` / `new_theme` / `component_brief` marks). Cuts: BL-134.

**The Library in the shell.** Browser (`LibraryBrowser.tsx`, shared with the Themes list): Productions, the Library
group (Components with its count — the old `library-link` —, Themes) and each theme of the project with where it comes
from in words; on the Library a theme row shows the components in that theme. Context: the Theme select (`lib-theme`).
Centre (`LibraryScreen.tsx`): "Components · n in <theme>", Create with Claude…, Source as a Segmented, the search, the
Kind chips (`ChoiceChips`: "All (41)", "Intros (4)" — what choosing one would show), the notices (a Disclosure), then a
section per kind of poster cards (`LibraryCards.tsx`): a card is ONE selection control (the kit's PosterCard, pressed;
named by the component's name, its id and tags its description — the picture's alt is not said first) and its play
controls under it, inside the card's frame (the hover and the selection fill are the whole card; the ring is the
pressed button's own mark drawn over the card) — Play is a toggle with one name ("Play <name>", `aria-pressed`, named
by `aria-labelledby` the button and the name's element), its state a pressed look of its own (`--ui-pressed`'s bar,
not the focus ring's colour; its icon a pause) and the "Playing · loop" mark on the poster. The grid is ONE tab stop
(L5.12c fixes, review A-M3): the selected card — else the last one picked, else the first — and its controls are the
stops, every other card's are not; ← → move the selection one card (across sections), ↑ ↓ a row of the section (past
its first or last row, the same column of the next section), Home / End, Escape clears it (the stop stays), Space
selects, Enter on the selected card brings the focus to its inspector (in place when the inspector is hidden; there the
selected card also links to its page, "Details"). With 240 cards the inspector is two Tabs from the selected card.
Inspector (`LibraryInspector.tsx`, rendered at one place of the screen's tree for the grid and a component's
page, keyed by the component: Set as default on a starter from the grid moves to the copy's page and keeps its result,
Undo and "Open the copy"): the selected card's — or the open component's — picture, kind, slots,
length, kit compatibility (a mark and a word), the themes that pick it; Play in the theme (the same play state and the
card's rule: off when the loop cannot play, unless it plays),
Open the details, Create with Claude… (a new one like it); Theme default (Set as default of <theme>…); About. Nothing
selected: the theme's summary. The detail route keeps its page (`LibraryDetail.tsx`): the picture large with its
controls, About, the slots and params as kit `DataTable`s (column headers, row headers, a caption), the README as text.
Status bar: "Idle" (or "n previews queued: waiting for the worker") · "Posters render while their cards are on screen",
Render all loops, Open the theme editor — the scenario in context's line and buttons stand down on the Library's and
the themes' routes (StatusActions).

**Sheets.** Create with Claude is a kit Sheet (`CreateSheet.tsx`, not destructive): Copy the prompt is its default (off
until there is a prompt), Close / Escape closes, and the person's words belong to the screen — closing keeps them,
reopening shows them, the quit question names them (`component_brief`) while they are not empty. Set as default: a
Sheet says what the write does (Return = Set as default); a starter: a Sheet asks the copy's name ("Copy as <name> and
set"). The Themes list's Copy to edit… and the editor's are Sheets with the name field: Return in it copies (L5.12c
fixes: the kit Sheet runs its default action, when it is on, on Return in a one-line text field). The kit Sheet gained
`content` (fields under the text, outside its description) and a `disabled` action; its focus on open is the default
when it is on, else the first text field, else the first action that is on (Create with Claude opens on its Id field,
never on a chip that is not a tab stop). No native `<dialog>` is left outside the kit (a lint).

**The theme editor in the shell.** Browser: the theme's sections (Brand, Colours, Type, Motion and cursor, Components) —
rows that bring the inspector's section into view and give it the focus — and its components, each a link to its page
in the library in this theme. Centre (`ThemeEditor.tsx`, still the one owner of the theme's `<PreviewFrame`): the
theme's name, Editable / Read-only and Starter / Workspace as tags, what uses it, Copy to edit… on a read-only theme,
its problems, the status line (`theme-status`: what the last write did, or why it was not written), ONE live preview
with a target Segmented Intro · Clip with caption · Outro (critique M5: no grid of three — only one Player exists),
Play (a toggle with one name) and Restart, the held components with Allow, then Use in a scenario. Inspector
(`ThemeFields.tsx`): the fields — the kit's `ColorField` for each colour (the native `<input type="color">`: each move a
draft previewed in the frame, its native `change` the write; the hex written on Enter or when left, once, never a
text that is not a hex; the field's `version` is the theme's sha256, so after a refused write (409) it shows what is
written and leaving it sends nothing; while a colour is dragged, a dot of the written colour beside the well; an unset
well hatched, never faded, and "not set" in words for a screen reader), the ripple Switch, the background, the contrast lines (a mark and a word each),
Type (the display Select, a Switch per body font file), Motion and cursor (ChoiceChips, Max zoom, the default zoom),
Components per kind (Select, the old params kept or dropped as a Segmented). Status bar: "Ready · each change is saved
and checked", Undo, Redo, Extract from a website… (the list's site panel), Use in a scenario… (brings its select). The
colour literals stay in ThemeEditor / ThemesScreen / theme-words / tokens (the set's size is asserted: ThemeFields.tsx
and the kit take colours as data; `pickerValue` is theme-words'). The Themes list: rows with swatches, tags, what uses
each theme, Edit / Open, Copy to edit…; New theme (kit fields, ColorFields for its colours that hand the form each
keystroke — `onText`: a value that is not a hex stays as typed and the form's line says why; "Make the theme" follows
the typed accent); the site panel (commands only: no Studio op queues a site job).

**Structure.** `LIBRARY_OPS` (app-source): the ops each Library / themes file may call — LibraryScreen the four library
reads and `library_render`, LibraryInspector `theme_view` / `theme_edit` / `theme_copy`, ThemesScreen its list, the
brand files, `theme_copy`, `theme_create`, `site_list`, ThemeEditor its reads, the lease, `theme_edit`, `theme_copy`,
`preview_allow`, `scenario_blocks`, `scenario_edit`, the others none; app-wide, `library_render` is LibraryScreen's
alone and every `theme_edit` names `if_match` in its argument object (Use in a scenario's `scenario_edit` its `hash`;
`x.call(…)` is seen too). L5.12c fixes (review A-M2): every app file imports the api's `call` / `useCall` by their own
names and only calls them — no alias, namespace, default or dynamic import, no re-export, never bound to another name
— so the per-file op lists see every call. The colour constants of theme-words.ts (`SAMPLE_ACCENT`, `EMPTY_FORM`,
`pickerValue`) are imported only by the gallery, the Themes list and the theme's fields (a lint).
Every value from data is text in the nine files (a lint). Performance: the cards are memoised (an item compared by
value: a re-read hands new objects), the pump read per card (`useSyncExternalStore` of its two keys), the context one
object per theme — with 240 cards a selection renders the two cards it changes (the first one also gives the grid's tab
stop to the selected card), Play the one, a re-read none (an e2e counts React's commits). The theme editor's sections
are memoised on the theme shown with a stable `send` / `setDraft`, each colour row on its own value and draft: a drag
of 30 moves renders the dragged field 30 times and nothing else of the editor (31 commits, the previews held). The on-screen observer has one root per scroller: the centre pane for the boxes inside it,
the window for the inspector's picture (an observer rooted at the centre never saw it).

### 4n (d). The quit sheet, reduced motion, the end of the legacy layer (L5.12d)

R-DSK-04, R-UI-50. « Épure » 4d. Reference: R4-Confirm (layout; "Retake" read as `APP_NAME`).
- **The desktop quit question as a page Sheet** answered through the server's pipe, the native alert as the fallback —
  §4j "The quit question in the page" (the flow and its rules, the op `desktop_answer`, the probe of the re-entry).
- **The end of the legacy layer.** bits.tsx keeps `Txt`, `shown`, `visibleControls`, `plural`, `When`: `Badge`,
  `Notice`, `Loading` (and `EnvFlags`, `RunState`, which nothing used) are gone — every state is a kit StatusMark, Tag,
  Callout, EmptyState or Progress, always with a word. main.tsx's screens outside the shell are on the kit: Connecting (a
  Progress), the start error (a Callout, the message through Txt), the session ended (a Callout and each kept draft in
  a read-only kit TextArea; test ids `session-ended`, `unsaved-drafts`, `unsaved-draft` kept), the not-found screen (an
  EmptyState whose heading is the centre pane's h1 — the kit's EmptyState takes `level` 1 — and Back to the projects).
  `app.css` (the cascade layer `legacy`, 1 240 lines at L5.12c) is deleted; `base.css` holds element defaults only (box
  sizing, `[hidden]`, the page's height, the body on `--ui-canvas` / `--ui-text` in the kit's 13 / 18 type — the legacy
  body was 14 / 21 —, links in `--ui-link`, the focus ring in `--ui-ring`, code in the mono stack, placeholders,
  `bdi` breaking anywhere), `--ui-*` tokens only and no class: the kit's lints read it too. A plain link's focus ring
  keeps a radius (`a:focus-visible`, the kit ring's `--ui-radius-control`: the legacy layer gave it 4 px; review B-L4). tokens.ts' L4.9 palette and
  its appearance-free tokens (`--font`, `--mono`, `--radius`, `--main-h`) are removed (tokens.css −169 lines): every
  token is a `--ui-*` one. `test/legacy-controls.json` is `{}`: the ratchet test asserts every app file holds zero
  findings (`pnpm -F @retake/ui ratchet`: "the table is current"). The "every className word is defined" lint the
  plan relied on did not exist: it is added (app-source) — a className word is a class of a stylesheet (or a prefix one
  completes in a template), or one of 38 named hooks, each with its reason (two e2e hooks, the kit's middle sizes, a
  screen root's name beside `sc-screen`, states shown by an attribute, parts laid out by their parent); a forgotten
  legacy class (`notice`, `card`, `badge`) or a typo fails it. It reads JSX `className` attributes and object-literal
  `className:` fields, follows a name to a const or an expression-bodied helper of the same file (`className={cls}`,
  Button's `cls(variant, size)`), and skips comparison operands (review A-L5 / B-L2: `'record'` of `x === 'record'` no
  longer excused a class `record`); the dead `nav-link` (no rule, no test) and SourceItem's `className` went. A
  template's variable part is not checked (`k-btn-${v}` passes on the prefix).
- **Reduced motion.** A source lint: every `animation` / `transition` of the app's stylesheets (kit.css, shell.css,
  screens.css, base.css) has a LATER rule of its own selector, in cascade order (main.tsx's imports: base → kit → shell →
  screens; review A-L4), turning it off under `@media (prefers-reduced-motion: reduce)` (today the spinner, the
  indeterminate progress and the switch's knob; a later stylesheet animating `.k-spinner` again fails it); no `scroll-behavior` but `auto`; every
  `scrollIntoView` / `scrollTo` / `scrollBy` of the app says `behavior: 'auto'` (15 calls; `scrollTo(0, 0)` became
  `scrollTo({ top: 0, left: 0, behavior: 'auto' })`). Edit's follow-while-playing sets `scrollLeft`: instant by
  construction (no smooth scroll anywhere). Chromium (`emulateMedia({ reducedMotion: 'reduce' })` on the gallery):
  the spinner's and the progress fill's `animation-name` are `none`, the knob's `transition-duration` `0s`, and no
  element of the gallery animates or transitions; without it they move.
- **The closing accessibility tours.** Every rebuilt screen has its station (a – c added Edit with a segment selected,
  the Review report with a check selected, a thread with Claude's proposal, the palette on Edit and on Scenario, the
  Library with a card selected, its Create sheet, a component's detail, the theme editor); d adds the quit sheet —
  unsaved text and jobs only, its event dispatched in a page with the app's flag — and the not-found screen, each dark
  at 1280 / 1440 / 900 and light at 1280: 0 findings (the sheet's walk stays inside it: its two answers). The keyboard
  tour through Edit and the report stays green.
- Cut (BL-135): Open Workspace… through the page (critique M4); the sheet's own words for logout / restart (native by
  design).

<!-- old-name:begin — the rename (L5.13a) names the old names on purpose -->
## 4o. The rename to Retake (L5.13a)

R-REN-01, R-REN-02, R-REN-04. Before L5.13 the tool was called Demo Studio; everything is renamed at once, with no alias:
the command `studio` → `retake` (bin, `pnpm retake`, Commander, the commands messages print), the packages
`@demo-studio/*` → `@retake/*` (the root package `retake`), every `DEMO_STUDIO_*` variable → `RETAKE_*`, the home
`~/.demo-studio` → `~/.retake`, the workspace file `studio.yaml` → `retake.yaml`, the tool folders `.demo-studio/` →
`.retake/`, the MCP server and plugin `demo-studio` → `retake` (`retake@retake`, skills `retake-scenario / -theme /
-component`; the plugin's entry-point key `studio` → `cli`), the desktop app `Demo Studio.app` → `Retake.app`
(identifier `local.demo-studio.desktop` → `local.retake.desktop`, Cargo package `retake-desktop`), Docker / Postgres
names (`retake-*`, `retake.test=pg`, the snapshot comment `retake snapshot <hash>`), temp prefixes, in-page names
(`<retake-cursor>`, `__retake*`, `retake.token`, `retake.events`) and the files the tool writes (`engine.retake` in
run.json — and its `perf.cpu.retake`, `studio` before; a run recorded earlier still reads the same in the perf line —,
`retake/raw-capture`, `.retake-theme.json`). Kept, not old names: the built-in `studio/` component namespace
(every theme and scenario names it), the comment / agent channel `studio`, the `studio:*` page events, "the Studio"
for the web app.
- **The rename is a script** (`scripts/rename-l513.mjs`): ordered, case-aware rules, exact literals per file, the
  folder renames; deterministic and idempotent (a second run changes nothing), `--dry` lists, `--only <files>` limits
  it. It rewrites tracked files only (never another session's untracked work), refuses a dirty tree unless
  `--allow-dirty` (`--only` names the files to rewrite, dirty or not, inside the repository), never follows a link and
  skips a file that is not valid UTF-8. A branch started before L5.13 runs it on itself before rebasing. A line carrying the `old-name` tag (with a colon)
  and a region between its begin and end markers (like this section) are never rewritten. The lockfile is rewritten as text (an offline regeneration
  drops other platforms' entries), the `@retake/*` keys of each importer re-sorted; Cargo.lock's root package moved to
  its sorted place (`--locked` holds).
- **An existing installation is told, never migrated** (`packages/core/src/legacy.ts`, the one module that knows the
  old names; `packages/engine/src/legacy.ts` for the process check). The old home, workspace file, variables and tool
  folders are never read — only detected, by stats: one stderr line at CLI start (never stdout: MCP over stdio and
  `ui --supervised` speak there) while `~/.demo-studio` holds `profiles/` or `sessions/` and `~/.retake` holds
  neither — RETAKE_HOME is tested first, so a chosen home (every test's) never makes it look; the same in
  engine_info (`legacy.old_home`: a one-line note in the Studio's sidebar, the MCP summary) and in the preflight's
  failure when a persona was never signed in. With `DEMO_STUDIO_HOME` set (and RETAKE_HOME not) the old home is the
  folder it names (core `oldHomeDir`: the old build kept that person's sign-ins there; `~/.demo-studio` is then not
  looked at): the line, the note (`legacy.old_home_var`), the MCP summary and doctor name that folder and the variable
  — set RETAKE_HOME to it, or move it (L5.13b, the L5.13a leftover). Likewise an old variable set without its `RETAKE_*` twin
  (`DEMO_STUDIO_HOME`, `_ROOT`…: the tool now runs on another home or workspace): named — never its value — on that
  stderr line, in `legacy.old_vars` (an MCP client launched with an old registration env never shows stderr) and, for
  the home, in the preflight's failure. `retake doctor`'s "Before Retake" lines (the home: the move, or the swap
  `mv ~/.retake ~/.retake.after-upgrade && mv ~/.demo-studio ~/.retake` when the tool recreated `approvals.key`,
  `mcp-http.token` or `desktop.json`; the old variables by name; the old workspace file; the old tool folders of the
  workspace and its projects with their pending rollback journals; a workspace or project `.gitignore` that ignores
  `.demo-studio/` but not `.retake/`, with the line to add). A `studio.yaml` stops the workspace lookup and the load
  refuses it with the `mv` — only when it is this tool's (next to `projects/` or an old tool folder, or its first 4 KB
  carry `version:` and a workspace key), and never in the home folder itself (`~/Projects` and the old home sit there
  on most machines): another tool's file of that name is walked past. The desktop app's "not a workspace" alert names
  an old `studio.yaml` with its rename. While a Studio or a worker of the old build still holds the workspace (its old
  `ui.json` / `worker.lock`: a bounded read; a linked file or folder is skipped; a holder counts only with the start
  time `ps` gives for its pid, as the worker lock's rule — the folder is agent-writable, and a pid alone could name any
  process of the person), `retake ui`, `retake mcp`, a worker, `retake sandbox up / reset`, a sandbox take
  (`run --sandbox`, CLI or job), `retake env reset` and a recording refuse to start beside it; the fix says what to stop,
  or to remove the file when no old Studio or worker runs, and the CLI prints every refusal's fix line. Hooks, components and an MCP registration naming old names are the upgrade guide's grep
  commands ("Upgrading from Demo Studio").
- **Safety lists keep the old names.** `.demo-studio/` stays in AGENT_WRITABLE_PATHS (its files — page dumps, drafts —
  are never run as code: dropping it would have widened trust); a worker a client starts never gets
  `DEMO_STUDIO_MCP_TOKEN` either. The variables the tool writes for the person's code (`RETAKE_SANDBOX`, `_RUN_ID`,
  `_ENV`, `_PROJECT_DIR`, `_ALLOWED_HOSTS`: hook and seed shells, process services) are also written under the old
  names — never read; BL-136 drops them later.
- **Markers the tool wrote into folders a person keeps** are still recognised: a theme's `.demo-studio-theme.json` /
  `made_by: demo-studio` (its `--replace`), a raw package's `demo-studio/raw-capture` (a new export to its folder), a
  session snapshot's `demo_studio` metadata key (the "made on another computer" warning); a component README's generated block is found by its begin marker's prefix, whatever command the comment names. A
  component importing `@demo-studio/components/kit` is refused with the new specifier in the message (no alias).
- **The guard** (`packages/core/test/old-name.test.ts`): no tracked file (nor an untracked one under the source
  folders) holds the old name in any spelling — wrapped across a line too —, the old command (`studio <sub>`, `pnpm
  studio`, `Usage: studio`, `` `studio` `` before "command" / "CLI"), the old workspace file or home; allowed: the
  rename script, core's and engine's `legacy.ts`, the `legacy*.test.ts` files, and tagged lines / regions in a short
  list of files (a tag anywhere else fails); file and folder paths are scanned too, and the regex-source spellings
  (`Demo\s+Studio`). vitest.config.ts gives every run a scratch RETAKE_HOME unless one is set (removed at the end of
  the run), refuses `~/.retake` and `~/.demo-studio` (through a link too), and drops every `DEMO_STUDIO_*`; core
  `retake-home.test.ts` is its canary, and also fails a test file that deletes RETAKE_HOME without restoring it.
- **The previews' bundle** (editor render/preview.ts): a target that is a package scaffold (same id, same folder) is
  bundled once, as the scaffold — flagged, so the bundle guard does not ask which component its kit imports belong to;
  a workspace component reusing a scaffold's id from another folder stays under the holder check (met when the rename
  made all 49 previews stale at once; editor `preview-scaffold.test.ts`).
- The "two takes" mark (title bar, Welcome, favicon, desktop icon) is L5.13b: §4o (b).
<!-- old-name:end -->

### 4o (b). The "two takes" mark (L5.13b)

R-REN-03. The app mark is one drawing, `packages/ui/src/mark.ts` (pure: geometry and `markSvg(variant, palette,
{size?, iconGrid?})`, no colour of its own) — declension « Nette » of the canvas (BL-124), kept exactly as validated:
the previous take as an outline behind, the new one in front with a play triangle, on a 96-unit plate (22-unit corners)
of a 100-unit grid. Three variants by the size it is seen at (`markVariantFor`): `full` ≥ 64 px (the triangle at its
size), `small` 21 – 63 px (larger frames, an 8-unit outline, no triangle), `tiny` ≤ 20 px (both takes filled, no
triangle) — the bands are `markVariantFor`'s (16 pt → tiny, 32 pt → small for the iconset slots, 18 px → tiny for the
title bar, 128 px → full on Welcome). Its colours are tokens.ts's: `--ui-mark-plate` (`#2a2e37` dark — a quiet lift,
≈ 1.3:1 on the title bar's `--ui-pane` and accepted below 3:1 as decorative: the blue take carries the mark, an ink
plate would vanish —, `#141823` light: the ink plate, since the canvas's light-plate declension, its triangle light on
a light front, cannot be drawn with a plate-coloured triangle), `--ui-mark-back` `#3d7bff`, `--ui-mark-front` `#f4f5f7`; and the fixed `MARK_INK`
palette (plate `#141823`) for what cannot follow the page's appearance. The kit's `AppMark` draws the geometry inline
(`aria-hidden`, the name always beside it; fills by `.k-appmark-*` classes on the tokens, so the colour lints hold): the
title bar's 18 px tiny mark and Welcome's 128 px full one (the placeholder squares went), and the gallery. The favicon
is the tiny mark in `MARK_INK` as a `data:image/svg+xml` URL in the document (bundle.ts `FAVICON_URL`; the CSP's
`img-src 'self' data:` unchanged, no route). The desktop icon is generated, never drawn by hand: `pnpm -F @retake/ui
gen:mark` (scripts/gen-mark.ts, tsx) writes `apps/desktop/icons/icon.svg` (the full mark placed on macOS's icon grid: a
1024 canvas, the plate 824 wide at 100 — scale 824 / 96), `icon.png` (1024², sharp resolved from packages/review where
it is already a dependency), `iconset/icon_16x16{,@2x}.png` (tiny) and `icon_32x32{,@2x}.png` (small) — Finder's 16 and
32 pt slots drawn for their size, the variant chosen by the slot's points so both densities show the same drawing
(critique L3) — and `icon.json` (the SHA-256 of each SVG a PNG was made from). `desktop.mjs`'s icns step copies the
committed iconset sizes — all four required, each one's pixel size read from its PNG header first (`DRAWN_ICONS`,
`drawnIconProblems`: a missing or mis-sized file fails the build with "run gen:mark", never a sips fallback; iconutil
itself accepts a mis-sized PNG) — and downscales `icon.png` (sips) for the others. `markSvg` takes `#rrggbb` palette
values only (it throws otherwise). Tests (ui `mark.test.ts`): the committed SVG equals `markSvg`, icon.json names it
and each iconset SVG, PNG sizes read from their headers, and each PNG's pixels compared with its SVG rasterised again
by sharp (mean Δ < 2, max < 128 on 0–255 — never bytes, which follow the sharp / librsvg version: a reverted icon.png
or a swapped slot fails), the mark's colours in the contrast lint (back on plate, front on back and plate ≥ 3:1 in
both appearances; `fill` / `stroke` tokens classified), the favicon is the tiny mark, AppMark draws mark.ts's geometry aria-hidden with no colour
of its own, the title bar and Welcome draw it. Cut: the macOS 26 appearance variants (Icon Composer) and a favicon that
follows the appearance in Safari (BL-136).

## 4p. The standalone app (L5.16; L5.16a: the bundle layout and the resolver; L5.16b: the app, signing, the DMG; L5.16c: the first run and the integrations; L5.16d: the updater; L5.16e: releases from GitHub Actions; L5.16f: the update feed on a GitHub release)

R-APP-01 – R-APP-05. The app carries everything a capture, a render and a review need; the engine finds it through one
resolver, and behaves exactly as before when there is no bundle (a repository checkout).

**Layout** (`Retake.app/Contents/Resources`, or a stage folder — `apps/desktop/scripts/bundle.mjs stage`):

```
bundle.json         the manifest (below)
node/bin/node       the building Node.js 22 (system libraries only; re-signed — ad hoc in L5.16a)
engine/             pnpm deploy --prod of @retake/cli, hoisted (the isolated layout names the build machine's paths in
                    .pnpm folder names), every hard-linked file given an inode of its own first (pnpm imports the
                    injected workspace packages as hard links to the checkout's package.json and dist/ files), pnpm's
                    own records removed, injected workspace packages' `workspace:` / `file:` specs replaced by their
                    version, *.map / *.d.ts / .bin pruned; the compositor's bare install names rewritten to
                    @loader_path (the hardened runtime ignores the DYLD_LIBRARY_PATH Remotion sets); engine/templates/
                    (git-tracked files only)
browsers/           chromium-<rev>, chromium_headless_shell-<rev>: the revisions the deployed playwright-core's
                    browsers.json pins, from Playwright's cache (ditto, links kept); markers empty and freshly dated
ffmpeg/bin/         ffmpeg + ffprobe handed with --ffmpeg (system libraries only), else absent (`ffmpeg: null`)
plugin/             .claude-plugin/marketplace.json + skills/ (git-tracked; the Claude plugin marketplace)
licenses/           node/, chromium/, remotion/, apps/desktop/licenses/** (ffmpeg/: our build's notices and written
                    source offer; remotion-compositor/: the compositor's GPL FFmpeg build — version, configuration,
                    source pointer; the stage refuses a compositor version it does not name), THIRD-PARTY.md
```

`bundle.json` (v 1): `app` (the one version), `node`, `playwright {core, chromium, headless_shell}`, `compositor`,
`ffmpeg {version, licence, libx264, sha256} | null`, `minimum_macos` (`15.0`: Remotion's own libraries are built for
it; part b puts it in Info.plist), `paths {node, engine, browsers, ffmpeg|null, templates, plugin}` relative to the
folder holding it, `sha256`, `sizes`. The stage refuses an out folder inside the checkout or /Applications, a cache
without the pinned browsers (the message names the one install command, the person's), an ffmpeg linking outside the
system; it ends with `checkStage` (also `bundle.mjs check <dir>`, and the tests on a small fake stage): paths inside
and present, every link relative and resolving inside, no regular file with a second hard link (a write to it would
change the checkout or the store), no path of the build machine (home, checkout) in any text file of the stage
(`.js`, `.json`, `.md`, `.yaml`… up to 8 MB each), one playwright-core, empty markers, the Mach-O files listed (thin and
FAT magic: part b's signing walk). Stage hygiene: `xattr -cr` (after the links are broken). **The checkout is never
written**: `stage` snapshots `git status --porcelain` with the sha256 of every file it lists before and after (a file
already modified and written again keeps its status line; its bytes tell), and fails loudly, naming both, when they
differ — whether the stage succeeded or not. (Found by L5.16a's reviews: the first stage rewrote nine
`packages/*/package.json` through pnpm's hard links.) Measured (L5.16a): 977 MB = Node 110, engine 314 (after D7: `@remotion/cli`
dropped; @remotion/bundler still needs @remotion/studio), browsers 500, ffmpeg 53 MB; ≈ 10 s on APFS.

**Discovery** (core `bundle.ts`): `bundleInfo()` looks for `bundle.json` in exactly one folder, five above core's own
`dist/` (`Resources/engine/node_modules/@retake/core/dist`), and accepts it only when its `paths.engine` holds that
module at `node_modules/@retake/core/` — never a folder above the app, never a stray `bundle.json` above a checkout.
One that claims this engine but is broken (a path leaving the folder, links followed) is never thrown at import
(`prepareBundle` and `starterTemplatesDir` go on, `bundleProblems()` keeps it, doctor shows an "App bundle" FAIL line);
every resolver that needs the bundle (`bundleInfo()`, so `mediaTools()`) throws it: a damaged app says so instead of
quietly using the system's tools. A playwright-core that does not load in `prepareBundle` is kept the same way.
`sealed` is the whole `.app` around `Contents/Resources`, else the stage folder.

**The resolver order** (D4, one for every tool): explicit setting → explicit variable → the bundle's → the system's.
- ffmpeg / ffprobe — `resolveMediaTools({configured, env, bundle, exists})`: ffmpeg = retake.yaml `ffmpeg` →
  `$RETAKE_FFMPEG` → `paths.ffmpeg` → PATH; ffprobe = beside retake.yaml's ffmpeg when one is there → `$RETAKE_FFPROBE`
  → beside `$RETAKE_FFMPEG` when one is there → the bundle's (`paths.ffmpeg`) → PATH (a lone static ffmpeg keeps the old
  ffprobe).
  retake.yaml's value is made absolute against the workspace root by `loadWorkspaceConfig` when it names a path (a
  bare name stays a command); a relative `$RETAKE_FFMPEG` / `$RETAKE_FFPROBE` is refused (BundleError: it would name
  another file in each process's cwd), and `cleanWorkerEnv` drops a relative `RETAKE_FFMPEG` / `RETAKE_FFPROBE` /
  `RETAKE_CHROMIUM*` from a worker a client starts. `mediaTools()` is this process's: `openWorkspace` registers — or
  clears — the workspace's setting each time (`useWorkspaceFfmpeg`, process-wide: a CLI command, the MCP server, the
  Studio server and a worker each serve one workspace; the one opened last wins, a test switches roots), so the sites no
  option reached (the preview quantiser, the silent-track fix, the review's frame reader, the pixel helpers) honour
  retake.yaml too.
  Every spawn goes through `ffmpegBin(explicit?)` / `ffprobeBin(explicit?)`; a source lint (cli `app-bundle.test.ts`)
  fails on a command literal `'ffmpeg'` / `'ffprobe'` anywhere else.
- Capture browser: `browser.executable` → `$RETAKE_CHROMIUM` → playwright-core's registry, which points at the bundle's
  browsers (below) — source `bundled`, else `playwright` (the cache).
- Render browser: `$RETAKE_CHROMIUM_HEADLESS_SHELL` → the registry's headless shell (`bundled` / `playwright`) → none:
  no render starts (`assertRenderBrowser` says how to install the headless shell; Remotion never downloads its own).
- Starter themes: `paths.templates`, else the repository's `templates/` (`STARTER_TEMPLATES_DIR`, so the "shipped
  theme" checks follow); the Claude plugin marketplace: `paths.plugin`, else the folder above the entry point.
- `retake --version` adds `(app bundle: <path>)`; doctor names each source (`retake.yaml`, `$RETAKE_FFMPEG`,
  `bundled`, `PATH`, `Playwright cache`) on the ffmpeg, ffprobe, Chromium and new "Render browser" lines, and its
  hints inside a bundle say "reinstall Retake" or name retake.yaml / the variables, never a pnpm / brew / Homebrew
  command (an app without its own ffmpeg, a `$RETAKE_CHROMIUM` pointing nowhere included). Its MCP line resolves ffmpeg
  as the MCP client's server will: with the registration's `PATH` (and `RETAKE_HOME`) only — never the shell's
  `$RETAKE_FFMPEG`.

**The browsers path never leaks** (critique M2): playwright-core reads `PLAYWRIGHT_BROWSERS_PATH` once, when its
registry loads. `prepareBundle()` sets it to `paths.browsers`, requires playwright-core from the engine folder and
restores the inherited value (deleted when there was none) — first thing in both entry points: `bin.js` loads
`bundle-env.js` before `main.js`; `worker-main.ts`'s first import is `./bundle-env.js` (the worker never runs bin.js).
Hooks, sandbox services, shells, `claude` and the worker's children see the person's own value. One playwright-core in
the engine (checkStage) keeps the registry the engine launches from the one that was pointed.

**Nothing writes inside the bundle** (critique M3): `assertOutsideBundle(path, what)` (links followed, a path not
created yet by its nearest folder). A workspace, its projects / templates / components folder inside the bundle is
refused by `loadWorkspaceConfig`; a project folder there (a link from `projects/` into the app included) by
`loadProject`; a `$RETAKE_HOME` there by `retakeHome()`; any command's `--out` there by the CLI (a `preAction` hook,
before the command runs); `retake init` refuses one; `renderComponentPreviews` refuses (before rendering) a preview
written next to a component inside it; from a bundle `components preview --all` means `--workspace`. Not guarded: a
write a third-party library makes on its own (below).
Playwright rewrites `DEPENDENCIES_VALIDATED` (empty) when it is older than 30 days: the stage dates it fresh and keeps
it empty (an empty rewrite leaves the seal intact). The L5.16a acceptance found no file newer than the run in the stage.

**H.264** (core `h264.ts`): `h264Encoder(ffmpeg)` reads `-encoders` once per path — libx264 when listed (today's
arguments, unchanged: the repository's Homebrew ffmpeg and the app's own GPL build have it), else `h264_videotoolbox`
at q:v 85 profile high (`h264CodecArgs`; each site keeps its scale, pixel format, colour tags and `-g`), else
H264EncoderError naming the ffmpeg; an ffmpeg that cannot list them gets today's arguments. Sites (each driven with
a fake ffmpeg in the tests, not only its argument builder): the capture (`resolveEncoder`, whose answer run.ts takes as
is: libx264 asked but absent → VideoToolbox, or an error — it now always runs `ffmpeg -encoders`, once per path), the
raw export's MP4 clips (`encodeClip` returns the encoder used; the package's manifest, selects and README name it:
"H.264 high profile (VideoToolbox q:v 85)…", never "CRF 14", `rawCodecLabel`), the 1080p export (`transcodeMp4`), and
`encodeFrames` (no production caller: the synthetic-run test harness and R-ARCH-08's unit). Measured on 20 s of the
fixture's 1080p render: libx264 CRF 18 SSIM 0.99891 (2.7 MB), VideoToolbox q:v 85 0.99896 (9.1 MB). Our ffmpeg build
has FFmpeg's native AV1 decoder only (no dav1d): an AV1 video a person brings is probed everywhere but decoded by our
ffmpeg only on a Mac with an AV1 hardware decoder (M3 and later); Remotion's compositor has its own (dav1d).

**One version** (critique L3): the root package.json's `version` (0.2.0), repeated in `RETAKE_VERSION`, every
package.json, tauri.conf.json, the Claude plugin's plugin.json and apps/desktop/Cargo.toml (+ its Cargo.lock entry); a
test keeps them equal. Not part of it: apps/desktop/core (the `desktop-core` crate, internal to the shell), the fixture,
component versions.

**The L5.16a acceptance** ran from the stage only: `env -i`, scratch HOME and RETAKE_HOME, `PATH` = the system folders
+ the ffmpeg build folder, the staged Node: doctor (every tool `bundled`), a capture, a render and a review of the
fixture's `quote`; then doctor and a dry run under Node's permission model (reads: the stage, the workspace, the scratch
homes, TMPDIR; `--allow-addons` for sharp, `--allow-child-process` for Chromium / ffmpeg / hooks; doctor alone also
probes the docker install places and `.git` above the workspace). That proves the engine's own Node.js file reads only:
child processes and native add-ons are not confined by Node's permission model.

### 4p (b). The app and the DMG, ad hoc (L5.16b)

R-APP-07 – R-APP-09. `pnpm desktop:bundle --out <dir> [--ffmpeg <dir>] [--stage <dir>]` (`bundle.mjs build`;
`RETAKE_BUNDLE_OUT` instead of `--out`): stage → sign the payload → bundle.json's hashes of the signed files → `tauri
build` → sign the shell and the app → verify → DMG → verify the DMG. `pnpm desktop:release …` is the same run with
`--release` (the person's own run: the app laid out ad hoc, then re-signed with the Developer ID by the same
`release.mjs finishApp` the release workflow's `sign` job runs — §4p (e)); `--app-only` stops at the ad hoc app (the
workflow's `build` job). Every output lands in `<out>`, a dedicated folder (`checkFolder`, by real path —
links followed through the deepest existing ancestor: never inside the checkout, /Applications (nor
/System/Volumes/Data/Applications), ~/Applications or ~/Library, never the home folder or a folder holding it, never
the Desktop / Documents / Downloads folder itself; empty, or marked `.retake-bundle` by an earlier build — a folder
with anything else in it is refused untouched; `--stage` gets the same rule, and a reused stage of another version
than tauri.conf.json's is refused before Tauri builds anything when an app or a DMG is made — stage again): `stage/`, `target/` (cargo;
`CARGO_TARGET_DIR` when it is outside the checkout), `app/Retake.app` + an `Applications` link (the DMG's folder),
`Retake_<version>_aarch64.dmg`, `tauri.bundle.json`, `Info.plist`, `icon.icns`, `entitlements/`, `tauri-cli/`,
`bundle-report.json` (sizes, timings). About 4 GB at the peak (stage 0.93 + app 0.94 + DMG 0.40 + cargo target 1.6). The
developer app is untouched: `pnpm desktop:build` / `desktop:dev` / `desktop:test` keep the repository's CLI and
launch.json version 1. tauri-build writes `apps/desktop/gen/schemas` in the checkout (git-ignored): the build saves
that folder first and puts it back as it was after `tauri build` (removed when it was absent), and the checkout's
snapshot (`git status` + the bytes of every listed file) covers it, compared before and after the build.

**One environment for every child** (critique M1, review A M1). `buildEnv` is an allow-list: PATH, HOME, USER,
LOGNAME, SHELL, TMPDIR, LANG, `LC_*`, TERM, CI, NO_COLOR, SDKROOT, DEVELOPER_DIR, MACOSX_DEPLOYMENT_TARGET, RUSTFLAGS,
`CARGO_*`, `RUSTUP_*`, `RUSTC*`, PNPM_HOME, `COREPACK_*` (COREPACK_ENABLE_AUTO_PIN=0 keeps pnpm from pinning itself
into a package.json), `npm_config_*`, `XDG_*`, PLAYWRIGHT_BROWSERS_PATH — and any name that reads as a credential
(TOKEN, SECRET, PASSW, CREDENTIAL, AUTH, PRIVATE, KEY) is dropped even where a prefix allows it. Every child of a build
or a stage runs with it — pnpm (deploy, store path), git, otool, install_name_tool, codesign, ditto, xattr, sips,
iconutil, plutil, hdiutil, `tauri build` and cargo (every crate's build script), xcrun, spctl — plus the build's own
variables (CARGO_TARGET_DIR, CARGO_NET_OFFLINE). The release credentials stay in the signer object and reach only the
tool that needs each, as arguments that are not secrets (below). A test runs a build with recording stand-ins of every
tool kind and a fake Tauri CLI, with APPLE_*, updater keys under their current and legacy names
(TAURI_SIGNING_PRIVATE_KEY*, TAURI_PRIVATE_KEY*, TAURI_KEY_PASSWORD) and registry / cloud tokens set: none reaches any.

**Added to the payload** before signing: `launch.json` version 2 — `{"version":2,"bundled":true,"node":"node/bin/node",
"cli":"engine/dist/bin.js","preload":"node/guard.cjs"}`, paths relative to its folder; `desktop_core::launch_config`
accepts plain names only (no `..`, no `.`, never absolute: `Component::Normal` each), regular files whose real path
(links followed) is still inside the folder — the rule holds without the seal (review B L2b) — `bundled: true` and
`preload` required. The shell reads it from its binary's real path (`launch_json_path`: `current_exe()` keeps a
link's path on macOS — review A L5). A missing or unreadable launch.json beside a `bundle.json` gets the bundled words
too (review B L1). And `bin/retake` (from `apps/desktop/bundle/retake.sh`): it unsets what makes Node.js or the
dynamic linker load other code — NODE_OPTIONS, NODE_PATH, NODE_REPL_EXTERNAL_MODULE, LD_PRELOAD, LD_LIBRARY_PATH,
LD_AUDIT and every DYLD_* (the list of `desktop_core::child_env_dropped`, which the shell drops for its Studio server:
a Rust test compares the two) — sets WS_NO_BUFFER_UTIL=1 / WS_NO_UTF_8_VALIDATE=1, follows `/bin/realpath -- "$0"` (a
link on the PATH — part c — or a chain of links finds the app), refuses to run unless that path is
`*.app/Contents/Resources/bin/retake` (a copy outside an app says "link to it, do not copy it") and the app's Node.js,
engine and guard are there, then `exec`s `node --require <Resources>/node/guard.cjs <Resources>/engine/dist/bin.js`.
`LaunchConfig.bundled` picks the shell's words: a damaged bundle says "install it again from its disk image", a version
gap with a Studio server says another copy of Retake serves the workspace — never a pnpm command
(`ConfigError::{Missing, Invalid, BadPath}` with their bundled flag, `LineError::text(bundled)`,
`StartError::text(bundled)`).

**The module lookup guard** (review A H1). Node.js looks a bare specifier up in every `node_modules` folder from the
importing file to `/`, then in $HOME/.node_modules, $HOME/.node_libraries and `<prefix>/lib/node`. From Resources that
walk leaves the app — `Retake.app/node_modules`, `/Applications/node_modules` (writable by any admin process),
`/node_modules`, `~/node_modules` for a copy in ~/Applications — and the reviewer showed a planted `bufferutil` there
running inside the app's Node.js (ws's optional addon, required by playwright-core). `node/guard.cjs` (+
`guard-hooks.mjs`, from `apps/desktop/bundle/`) closes it: a module inside Resources resolves bare specifiers inside
Resources only — CommonJS through `Module._nodeModulePaths` (also what `require.resolve(x, { paths })` uses) and
`Module._resolveLookupPaths` (the global folders), ES modules through a `module.register` resolve hook that refuses a
target outside Resources. A file outside Resources — the person's workspace components, a JavaScript hook, a sandbox
script — keeps Node.js's lookup from its own folder; relative, absolute and URL specifiers are untouched. It is an
argument, never NODE_OPTIONS (dropped): the launcher, the shell's Studio server (child.rs: `--require <preload>` + the
WS_* variables), the jobs worker the engine spawns (`workerCommand` + core `bundleNodeArgs()`), the MCP registration
(`mcpServerEntry`); worker threads inherit it. The render bundle's own resolver (webpack, through @remotion/bundler)
walks `node_modules` folders upwards the same way — the gated acceptance caught it taking a planted
`@remotion/video-matting` (an optional peer @remotion/studio names, which the app does not hold) from above the app —
so from an app bundle `ensureBundle` passes `resolve.restrictions` = one RegExp of the app's Resources, the workspace
and the bundle cache (`renderBundleRestriction`): a module found elsewhere is not found, as without the planted folder. `prepareBundle` (both entry points' first step) loads it too when a
process was started on the bundle's code without it — the Claude plugin's own `.mcp.json` names `node <cli>` only —
before playwright-core or any command loads; a missing guard is a `bundleProblems` line (doctor). Tests: a mini tree
with canaries above the app, above Resources and in $HOME/.node_modules — CommonJS, ES modules, `require.resolve` with
paths and a worker thread load none, the engine's own package loads, a workspace file still resolves its own
node_modules and the folder above it (a control run without the guard loads them all); the gated acceptance plants
canaries for every bare specifier the engine's JavaScript names but does not hold, above the built app and in the
scratch home, and above Resources in a clone of the app.

**Tauri lays the app out, nothing else** (D1, M1, M8). The bundle configuration is an overlay generated into `<out>`
(`bundleOverlay`) and passed with `tauri build --bundles app --no-sign --ci --config <overlay> -- --locked
[--offline]`; tauri.conf.json keeps `bundle.active: false` (a test). The overlay: `active`, `targets: ["app"]`, the
icns made by desktop.mjs's `icns()` (the L5.13b drawn slots), `macOS.minimumSystemVersion` 15.0 (also the cargo
build's deployment target), `macOS.infoPlist` (our extras: `NSLocalNetworkUsageDescription`,
`LSApplicationCategoryType` — Tauri merges them), `macOS.files` mapping each top-level item of the stage to
`Resources/<name>` (never `bundle.resources`: it dereferences links and breaks Chromium's framework). No
`signingIdentity`, no updater, no plugin. The Tauri CLI 2.12.4 (the version the pnpm store holds; the crates are tauri
2.12.5 / tauri-build 2.7.4 — a test ties the CLI's major.minor to the tauri crate's) is rebuilt from the pnpm store
(`tauriCli`) and pinned (review A M2): `apps/desktop/bundle/tauri-cli.json` records the sha512 of every file of both
packages (`@tauri-apps/cli`, `@tauri-apps/cli-darwin-arm64`: the native binary, `tauri.js`, `main.js`, `index.js`…);
each store index must name its package and version and list exactly those files with exactly those sha512, every
content file must match, every path must stay inside its package folder — a store whose index and files were rewritten
together, an index naming another package or version, a path with `..`: refused ("not the pinned 2.12.4"). Upgrading
means fetching the new version once with a network, checking it against the registry, and recording its files there.
An offline `pnpm add -D @tauri-apps/cli` rewrote the lockfile without the optional platform packages it has no offline
metadata for (esbuild, rspack… 1,744 lines), so no dependency is added.

**Signing is ours** (`apps/desktop/scripts/sign.mjs`, D3 as amended by M1). The table is data:
`apps/desktop/bundle/sign-table.json` (entries `{id, kind: file | bundle, path, entitlements: <plist> | null, dryDLV,
optional?}`, paths relative to Resources, `*` within one segment) plus `apps/desktop/bundle/entitlements/*.plist`. The
entitlements are the least an ad hoc probe with the hardened runtime proved (review A L1): Node.js without any
entitlement dies at its first JIT (SIGTRAP), with allow-jit alone runs JIT and WebAssembly; Chromium 1194 signed with
the plain helper and the browser process bare and the Renderer / GPU helpers and the headless shell on allow-jit alone
rendered JavaScript, WebAssembly and WebGL (ANGLE Metal in new headless, SwiftShader in the headless shell) and took
screenshots, while the same run with the Renderer helper and the headless shell bare did not start a page (the probe
is sensitive). What no offline probe can prove stays: Node.js keeps disable-library-validation in release (the
person's own native addons, in hooks or sandbox scripts, carry another signature than the app's; the app's own addons
share its team); the Plugin helper keeps Chromium's own set (Retake never starts it).

| Entry | Release entitlements | Dry adds DLV |
|---|---|---|
| node | allow-jit, disable-library-validation | (has it) |
| Chromium Helper (Renderer), (GPU), headless_shell | allow-jit | yes |
| Chromium Helper (Plugin) | allow-unsigned-executable-memory, disable-library-validation | (has it) |
| Chromium.app, Chromium Helper, (Alerts), crashpad handler, app_mode_loader, web_app_shortcut_copier | none | yes |
| compositor `remotion`, `ffmpeg`, `ffprobe` | none | yes |
| every library (`*.dylib`, `*.node`, Chromium Framework.framework), esbuild ×2, our ffmpeg / ffprobe (optional) | none | no |
| the shell (Contents/MacOS) and the outer app | none (signed after Tauri, by `signApp`) | no |

`signPlan(payload)` walks every regular file (links never followed), finds each Mach-O by its magic (thin either byte
order, FAT), and fails on one no entry covers (a file entry, or the main executable of a bundle entry: an app's
`Contents/MacOS/*`, a framework's `Versions/<v>/<Name>`), on one two entries cover, and on an entry (not optional) that
matches nothing; the order is inside-out (deepest path first). Every signature: `codesign --force --options runtime
--timestamp=none -s - [--entitlements]` in dry mode; `entitlementsFor(entry, 'dry')` = the release set plus
disable-library-validation where `dryDLV` (ad hoc has no team: an executable loading code of another ad hoc signature
needs it), nothing else — a test compares the two sets entry by entry. Signing rewrites the Mach-O files, so
bundle.json's sha256 values (Node.js, ffmpeg, ffprobe) are recomputed from the signed files right after
(`refreshManifestHashes`, review B M3: bundle.json is no Mach-O — the outer signature seals it as rewritten).

**The release path** (review A M4, review B M1; `pnpm desktop:release`, the person's run — MACOS-CHECKLIST 15b; tests
go no further than recording stand-ins of codesign / xcrun / ditto / spctl). `signer('release', env)` →
`releaseConfig` first: `APPLE_SIGNING_IDENTITY` ("Developer ID Application: … (TEAM)"), `APPLE_TEAM_ID` (the same
team), and how notarytool authenticates — `APPLE_KEYCHAIN_PROFILE` (stored once by the person with `xcrun notarytool
store-credentials`) or an App Store Connect API key (`APPLE_API_KEY` its id, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`
the .p8 file). An Apple ID's app-specific password is refused: notarytool takes it only on its command line, where `ps`
shows it to every local process (`notarytool submit --help`: `--password`, else a keychain profile or a key file). An
empty variable is absent; refused, naming what is missing, before anything is staged or any tool runs (a test with
recording stand-ins on PATH, through `build()` and through the command line's `--release`). Then: the payload, the
shell and the app signed with the identity and `--timestamp`; the app checked; **the app notarised as a zip** (`ditto
-c -k --keepParent Retake.app <out>/notarize/Retake-notarize.zip` → `xcrun notarytool submit <zip> --wait
<credentials>` → the zip removed → `xcrun stapler staple Retake.app`: notarytool takes a zip, a disk image or a flat
package, never an app folder); the DMG made from the stapled app, signed, notarised and stapled; then `verifyRelease`:
every Mach-O of the app and the app itself signed by APPLE_TEAM_ID's team and none ad hoc, `spctl -a -vv -t exec` on
the app, `spctl -a -vv -t open --context context:primary-signature` on the DMG, `xcrun stapler validate` on both. A
failure's text redacts the value of every credential flag (`--keychain-profile`, `--key`, `--key-id`, `--issuer`,
`--password`, `--apple-id`, `--team-id`, `--keychain`; `--flag value` and `--flag=value`), wherever it sits. No
keychain is touched by the tool itself.

**Verification** (every build): `codesign --verify --deep --strict --verbose=2` on the app; every Mach-O of the whole
app has the `runtime` flag and no `get-task-allow`; each entry's entitlements read back (`codesign -d --entitlements -
--xml`) equal the table's for the mode; the shell and the app have none (`verifyApp`). Then `appProblems` (review B M2,
review A L6): `Contents/Resources` equals the signed stage byte for byte — `treeDigest` right after signing (every
file's size, executable bit and sha256, every link's target) against the app's after Tauri's copy, Tauri's own
`icon.icns` aside: a crate's build script runs between the two — no AppleDouble `._` file, no extended attribute but
`com.apple.provenance`, Info.plist's `LSMinimumSystemVersion` 15.0 and the local network words; the checkout's snapshot
unchanged. `com.apple.provenance`: macOS 15+ tags the files a process writes with its responsible app's provenance
record (here the app the build was started from; a build started from another app may carry none), and `xattr -c`
cannot remove it; an opaque id, never part of a signature — the DMG copies it on every file (17,021). Each check is a
function the tests run on a mini app and on tiny DMGs, one mutation per rule.

**The DMG** (D2): `hdiutil create -volname Retake -srcfolder <out>/app -fs APFS -format ULFO -ov <dmg>` — the app and
an `/Applications` link, no Finder scripting, no mount to make it (a styled window: BL-140). Checked by `verifyDmg`:
`hdiutil imageinfo` (format ULFO), then `hdiutil attach -nobrowse -readonly -noautoopen -mountpoint <out>/mnt`: the app
inside verifies and carries no AppleDouble file or foreign attribute, the Applications link is there, nothing else on
the volume (dot files included); detached (forced when needed).

**Measured** (the gated acceptance, `RETAKE_TEST_BUNDLE=1`, M4 Mac, after the review fixes, 2026-11-03): build 108 s —
stage 12.9 s, payload signing 4.8 s, `tauri build` 46.3 s, verification 16.6 s, DMG 26.8 s (a cold cargo cache: about
3 min, `tauri build` ≈ 90 s); 35 signatures for 35 Mach-O files; 5 links kept; app 989 MB, DMG 425 MB (ULFO), payload
973 MB. From the built app only (system PATH, scratch HOME / RETAKE_HOME / TMPDIR, 143 canary packages in 4 folders
above the app and in the scratch home): doctor 1.8 s, every tool `bundled`; capture of the fixture's `quote` 50 s (25
steps); `render --review` 83 s (1,823 frames, bundle 3.9 s, review clean, render browser `bundled`, no canary in the
render bundle); the shell binary started directly (cwd outside the repository) served the Studio from `node --require
<Resources>/node/guard.cjs <Resources>/engine/dist/bin.js` in 0.8 s; a clone with canaries above Resources ran doctor;
afterwards no canary had run, bundle.json's hashes matched the files, the app still verified, nothing inside it was
newer than the runs and ~/Library's entries for the bundle id were unchanged (names, sizes, mtimes). Whole run 268 s.

### 4p (c). The first run and the integrations (L5.16c)

R-APP-10 – R-APP-15. What the installed app does the first time it runs and what it may set up for the person — each
step on its click, none from an agent.

**Where the app runs from** (critique H1). A quarantined app opened from Downloads or the disk image runs from
`…/AppTranslocation/<uuid>/d/Retake.app` (random, read-only, gone after a restart) or from `/Volumes/…`: any path recorded
then breaks. One rule on both sides — `desktop_core::setup::install_location(app, read_only)` (statfs `MNT_RDONLY`) and
core `installLocation(app, {readOnly})` (EROFS on `access(W_OK)`): the `/AppTranslocation/` marker → `translocated`, a
read-only volume → `read_only`, anything under `/Volumes` → `volumes`, else `ok` (core's test compares the words of
the two and replays every `install_location` assert of the Rust tests, `/VolumesOld/…` look-alikes included).
Not `ok`: the shell logs it and Help › Install the retake Command… answers a native alert; the Set-up sheet says "Move
Retake to Applications, then open it again" with the command and both Claude steps off; the setup ops refuse them
server-side (409 `location`); doctor's **App location** line warns. Scaffolds never write a path into the app into the
person's files: from a bundle, `retake sandbox init`'s sandbox.yaml and `retake components create`'s component.yaml have
**no** `# yaml-language-server: $schema=` line (a checkout keeps its relative path).

**The first run** (plan §5.1). A bundled app (launch.json v2) with no workspace (`choose_workspace` → None) asks, words
in `setup.rs`: *Welcome to Retake* — **Create ~/Retake** (default) · **Choose a Folder…** · **Quit**. Create runs the
app's own `node --require guard.cjs engine/dist/bin.js init ~/Retake` (child.rs `init_workspace`: argv, the server's
environment rules, 30 s); Choose opens a workspace as it is or makes an empty folder one (`retake init` refuses a
non-empty one: its words come back in the alert, and the folder is left as it was). The workspace is remembered in
`desktop.json` as before (source `created at the first run`). Test mode answers from `RETAKE_DESKTOP_TEST_ANSWERS` (the
gated acceptance: `0` — Create; and `1,1` with two picks — a non-empty folder refused, asked again, an empty one made the
workspace).

**The Set-up sheet** (plan §5.2; `shell/SetupSheet.tsx`, `shell/setup.ts`; docs/reference/studio-ui.md). A kit Sheet in
the app's window only (the page's `__studioShell` flag): it opens by itself when `setup_status.seen` is false (`<Retake
home>/app.json` without `setup_seen` of this major), on Help › Set Up Retake…, Install / Uninstall the retake Command…
(the shell dispatches `studio:setup` with `{}` or `{section: "cli" | "cli-remove"}` — `setup_page_js`, a constant shape;
anything else is ignored) and at `#/setup`. One checklist: workspace, Retake home, command line, Claude Code, Claude
Desktop, notifications, screen recording ("not needed: captures are headless"), local network ("asked when needed").
Only **Done** writes `setup_seen`; Escape (the kit Sheet's `escapeAction`) closes it without that — no visible choice was
made, so it opens again at the next start (review c A-L6). **Focus** (review c A-M2 / A-L6): the sheet opens on its
title (the kit Sheet's `focusTitle`: focusable, not a tab stop — the top in view, a first Return chooses nothing); Help ›
Install the retake Command… on the command's first action, Help › Uninstall… on the confirmation's Uninstall (Keep it
when nothing is installed); an inline confirmation (Uninstall…, Add to Claude Desktop… / Replace…) takes the focus on
its first button and gives it back to its opener on Keep it / Cancel; once an action answered, the focus stays on its
button, else the item's first action, else the item's title. The process list (is Claude Desktop running?) is read
only while that step is in view (an IntersectionObserver; `setup_status {processes: true}`) or when the window comes to
front, and the server reads `ps` at most every 5 s (`PS_EVERY_MS`; review c A-L8).

**The setup ops** (`ui/src/server/setup-ops.ts`): `setup_status`, `setup_cli_install {folder: default|chosen,
replace}`, `setup_cli_choose`, `setup_cli_remove`, `setup_claude_code_run`, `setup_claude_desktop_add {replace}`,
`setup_notifications`, `setup_done`. Studio-only own ops in the `ui` client's allow-list, never MCP tools (a static
test reads the MCP list): **no MCP tool can install the command or register Retake with Claude** (an agent with a
shell of its own still can). The installed app's own server only: supervised (the shell's pipe attached) AND running
from a `.app` bundle — anything else answers `available: false` / 409 `not_supervised` / `not_bundled`. Twelve writes a
minute (423 `rate`). The page sends choices, never a path; what other programs wrote (Claude Code's output, Claude
Desktop's current entry, its parse error) is under `untrusted` and shown as text. The machine is one injectable
context (`SetupContext`: the bundle, the home, the environment, uid, the read-only probe, the process list, Claude
Desktop's config path) — tests run on scratch folders only.

**The pipe, both ways.** Server → shell (stdout, framed like the others): `{"type":"setup","action":"notifications" |
"cli_folder"}` (strict: exactly those two fields). Shell → server (the supervised server's stdin, at most 8 KB a line,
`parseShellLine`, strict; the cap counts bytes, on both sides — the CLI's `shellLineReader` too): `{"type":
"cli_folder_open"}` (sent just before the panel shows: the sheet says "choose the folder in the panel" only then —
review c A-L7), `{"type":"cli_folder","path":<absolute>}` (the folder picked in the shell's native NSOpenPanel),
`{"type":"cli_folder_cancelled"}` (none: cancelled, or another question was up — the sheet says "No folder was
chosen"), `{"type":"notifications","state":"on"|"off"|"unknown"}` (the answer of
`requestAuthorization`; test mode never calls UN and says `unknown`). The chosen folder is checked when it arrives
(`checkCliFolder`: absolute, a folder once links are followed, the person's (uid), writable, outside the workspace and
the app) and kept for `setup_cli_install {folder: "chosen"}`.

**The command** (plan §4, critique L1 / L4). A symbolic link `~/.local/bin/retake` (created 0755 when missing) or
`<chosen>/retake` → `Contents/Resources/bin/retake`; recorded in `app.json` (`cli: {path, at}`). `cliLinkState`: absent,
ours, another copy of Retake (review c B-M3: the exact layout `<X>.app/Contents/Resources/bin/retake` AND `<X>.app`'s
Info.plist naming `APP_BUNDLE_ID` — tauri.conf.json's `identifier`, or a test build's `<id>.<suffix>`; dangling when that
app is gone), foreign (a file, a folder, a link elsewhere — a formula's `…/bin/retake`, another app's launcher). A
foreign file is never replaced nor removed; another copy's link only with Replace (an atomic rename of a new link).
**One command per app** (review c B-M1): the status, Install and Uninstall read the link recorded in `app.json` beside
the default folder — after a restart the sheet shows the chosen folder's link as installed; Install into another folder
while this app's link exists is refused (409 `installed_elsewhere`: Uninstall first); Uninstall removes this app's link
(the recorded one first), nothing else — and works from a misplaced app too (it only takes a link away). The PATH said
is the server's (the app's launchd PATH: it cannot see the shell's, and never runs the login shell): whether the folder
is on it, which `retake` comes first, and the zsh line to copy into `~/.zprofile` (`export PATH="$HOME/.local/bin:$PATH"`;
a name with anything zsh expands or ends on is single-quoted — `zshQuote`, review c A-L1); "check it: open a new
Terminal window and run retake doctor". Doctor's **retake command** line (bundled; from a checkout only a dangling
link): the link, a link to a removed app (its `rm` hint quoted to paste), another copy's, a foreign file, another
`retake` first on the PATH.

**Claude Code** (Q5). `pluginInstallSteps` (mcp: the argv form of `pluginInstallCommands`, same values: the bundle's
Node.js, `engine/dist/bin.js`, the workspace, `home` when RETAKE_HOME is set; marketplace = `Resources/plugin`). Run
finds `claude` in a fixed list (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local`), runs the two
lines as argv (`shell: false`, the install line's `cd` as its working folder, stdin closed, its own process group),
with a small environment (PATH: claude's folder, the system's, Homebrew's, the app's Node.js last; HOME, USER, LOGNAME,
LANG, LC_ALL, TMPDIR, CLAUDE_CONFIG_DIR — nothing else), stops at the first failure, 60 s for the run (then SIGTERM to
the group, SIGKILL 2 s later: "run the lines in Terminal"), output without escape sequences or control characters,
16 KB at most. A step ends when its process **exits** (its exit code decides) plus 200 ms for the last output, then its
pipes are destroyed (review c A-M1: a helper `claude` leaves in a session of its own never holds the answer; at the
limit the answer comes after SIGKILL whatever the pipes do). One run at a time (409 `busy`, review c A-L5).

**Claude Desktop** (Q5, critique M7). `planDesktopEntry` (pure): create / add / same / replace; refused: unparsable
JSON, a top level or an `mcpServers` that is no object. `writeDesktopEntry`: the folder must exist (Claude Desktop made
it: nothing is created in ~/Library); a symlinked config is written at its real path; a backup
`<Retake home>/backups/claude-desktop/<name>.retake-backup-<ISO time>[-n]` first (review c A-L2: Retake's own folder,
0700, each copy 0600, a unique name, 5 kept — never beside the file nor beside a symlink's target, where a dotfiles
repository would get every server's `env`); the new text through a temporary file beside the real target with the old
mode (0600 for a new file), fsync, rename; read back — the entry must be there (else `not_kept`, naming the backup). The
op refuses while Claude Desktop runs (`ps -axo comm=`: `…/Claude.app/Contents/MacOS/Claude`), when `ps` cannot tell
(409 `claude_unknown`, review c A-L3) and a different entry without `replace`; the sheet shows both entries before
Replace.

**Two copies of Retake** (critique M6). The worker lock records `engine` (core `engineLocation`: the `.app`, or the
checkout holding `pnpm-workspace.yaml`; read back only as an absolute one-line path). `otherCopy` (another engine, or
another version): engine_info (`worker.other_copy: true`, the copy under `untrusted.worker_other_copy`), the Welcome
inspector's Worker row, doctor's MCP line, the warnings of a run or render submit ("this job runs there, with that
copy's browsers and tools": fixed words and the version only) and the Studio's own submits (scenario_run /
scenario_render `untrusted.other_copy` → the "queued" line, review c B-M2). Every shown field of a lock has its shape
when it is read (review c A-L4): a version's (`LOCK_VERSION_RE`, ≤ 40 characters; else dropped, said as `?`), a build
stamp's, an ISO time, a host and an engine path without control or invisible characters; doctor prints them through
the same filter. Signed-in profiles:
every launch on a persona's profile (`BrowserSession.open` with its user data folder, `retake login`'s window, a
recording's copy) compares the Chromium major it would run (`launchMajor`: playwright-core's pinned versions, or a
macOS app's Info.plist; unknown → not checked) with the newest the profile records (our `retake-browser.json` and
Chromium's own `Last Version`) and refuses an older one before Chromium starts; a launch records its major.

**Measured** (the gated acceptance, 2026-11-03, after the L5.16c fixes): build 102 s (stage 13.4 s, payload signing
4.3 s, `tauri build` 43.8 s, verification 15.9 s, DMG 24.5 s); 35 / 35 signatures; app 989 MB, DMG 422 MB; doctor 2.3 s;
capture 51 s (25 steps); `render --review` 77 s (1,808 frames, clean); the Studio 1.0 s; the first run (no workspace,
test mode's Create) served `~/Retake` of a scratch HOME 1.2 s after start, then the setup ops on that server linked the
command (run through the link), took the panel's folder from stdin (installing there refused until the first link was
uninstalled), said a second, empty panel as `cancelled`, reached the shell for the notification request and refused
Claude Desktop (no folder); the first run's Choose a Folder… (a non-empty folder refused by `retake init`, asked again,
an empty folder made the workspace) 1.6 s. Every child ran with CFFIXED_USER_HOME at its scratch home: Chromium's
`~/Library/…/Crashpad/settings.dat` untouched. Whole run 261 s, 8 / 8.

**Words.** Every shell sentence naming `pnpm` / `desktop:build` has its bundled variant ("install it again from its disk
image": config.rs, rules.rs, child.rs's usage exit; notify.rs's one line is reached only outside an app bundle). The
Help menu: Set Up Retake…, Install the retake Command…, Uninstall the retake Command… (no keys; `{app}` in a label is
the app's name — no product name in the shell's sources).

### 4p (d). The updater (L5.16d)

R-APP-16 – R-APP-18. Modelled on a static update feed — since L5.16f files of the repository's own GitHub releases (the
person's decision, 2026-11-04: no self-hosted update host): a check at launch at most once a day, the notes and Install
and Restart on a click, the archive's signature checked against the key compiled into the app — whoever writes the
releases can withhold an update, never forge one.

**Which build updates itself** (critique H2). `tauri-plugin-updater` 2.14.0 (pinned, optional, cached: `cargo …
--offline --locked`) is behind the cargo `updater` feature, and `update::register` adds it only when the config carries
`plugins.updater` with a key and an endpoint — the plugin refuses to start without its key, and its
`requireSignedVersion` / insecure-transport switches exist only there. `bundle.mjs` turns both on together, only when
`RETAKE_UPDATE_FEED` (https, no user / query / fragment, the `.json` file itself) and `RETAKE_UPDATE_PUBKEY` (a minisign
Ed25519 key, decoded) are set — one alone is refused before anything is built: the generated overlay (scratch, never
committed) gains `plugins.updater = {pubkey, endpoints: [feed], requireSignedVersion: true, allowDowngrades: false}`
and cargo `--features updater`. The release overlay never has a `dangerous*` key; the gated test's overlay
(`testUpdaterOverlay`, reachable from no command line) alone has the insecure-transport flag, for its feed on
127.0.0.1. `tauri.conf.json`, the crates and the sources carry no `plugins.updater`, key, endpoint or real host (a static
test). Any other build — the developer app, a bundle without the two variables — says "Updates are off in this build"
(launch.json's `updates`: "on" / "off", which doctor reads). The feed's channel follows the version (`checkChannel`,
review d B-L3): a stable build must name `…/latest.json`, a pre-release `…/rc.json`. The plugin is used from Rust only:
no capability grants its commands to the page.

**The archive** (critique H3). Ours, not Tauri's: `COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs
--no-acls --no-fflags -czf Retake.app.tar.gz -C <dir> Retake.app` (macOS 26's bsdtar writes extended attributes as pax
headers, an older one AppleDouble `._` entries: neither travels), checked against the app (`archiveProblems`: every
link — Chromium's framework's included —, no `._` entry, nothing outside `Retake.app/`), then signed by the pinned Tauri
CLI's `signer sign --app-version <the app's Info.plist version>` with `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) given
to that one command only, and the `.sig` checked against the public key in Node before the build ends.

**The feed** (`scripts/publish-update.mjs`; L5.16f: on GitHub releases, through the REST API with Node's `fetch`). Each
version's release holds `Retake.app.tar.gz`, its `.sig` and `platform-<platform>.json` ({signature, url}); one fixed
release, `update-feed` — a pre-release created by the first publication with `make_latest: false`, so GitHub never
shows it as the latest (and `releases/latest/download/…` would skip the rc channel anyway) — holds `rc.json` (every
version) and `latest.json` (stable ones). The apps read `<server>/<owner>/<repo>/releases/download/update-feed/<channel>`
(`feedUrl`; `release.mjs feed` from GITHUB_SERVER_URL + GITHUB_REPOSITORY), public downloads with no credentials, so
the repository must be public. Environment: GITHUB_TOKEN (contents: write — the workflow's job token, `gh auth token` by
hand), GITHUB_REPOSITORY (`<owner>/<repo>`, checked), RETAKE_UPDATE_PUBKEY; GITHUB_API_URL / GITHUB_SERVER_URL default
to GitHub's own, https only. The order: (1) nothing is requested before the archive's minisign signature is verified in
Node against `RETAKE_UPDATE_PUBKEY` (the key ids, Ed25519 over the BLAKE2b-512 prehash — or the data for a legacy `Ed`
signature —, the global signature over the trusted comment, its `version:` equal to the version published: the apps
require it), the version, platforms (`darwin-aarch64` only: the archive is the Apple-silicon app), the repository name,
the https addresses and `RETAKE_UPDATE_FEED` (when set: this version's channel on this repository) checked; (2) reads
before any write — the repository is public (`private: false`, `visibility: public`), `v<version>` is a published release
(GitHub's by-tag lookup answers 404 for a draft, whose files would answer 404 to the apps), and what it holds already is
these bits (the archive and `.sig`: size, and the API's `sha256:` digest when given; a platform file: the same signature
and URL) — other bits are refused with no override: a public release's files are never replaced, a fixed build is a new
version (`--force` is gone); (3) the version's release gains only what it lacks (archive, `.sig`, platform file — the
workflow's `attach` job attached the first two to the draft); (4) the feed, never edited: rebuilt from every platform
file the version's release holds (a re-run heals a race) — this run's platform from the entry it checked, which the
file read back must equal (review f A-L1: a mismatch, or a file read back that is not JSON, fails before the feed) —,
and each channel replaced unless it serves a newer version. A channel kept at a version that has no published release
(a hand-placed or forged feed: it freezes every app) is a `::warning::` of the run, which stays green — the version's
release is complete and which feed is right is a person's call (review f A-L2). A file in GitHub's `starter` state (an
interrupted upload, never downloadable) on the version's release is deleted before this run uploads its own (A-L7).
**A channel replaced** (`replaceAsset`): GitHub can neither overwrite an asset nor rename one onto a taken name, so the
new file is uploaded whole as `<name>.tmp-<run>` (run = GITHUB_RUN_ID + random), then the old one deleted and the new
one renamed. Before each delete every file of that name is looked at again (review f A-M1): one that appeared since the
check (not the asset compared) holding this version or a newer one is kept and ours dropped (`kept <v>`), an older one
deleted. A rename refused (another run took the name, or a list not up to date yet) is tried again after a pause, four
tries in all. The temporary file is dropped only when the name is held by an equal or newer feed; otherwise the run
keeps it and fails saying the channel may be MISSING and to re-run the publication (review f A-M2) — a re-run writes
the channel and removes it, as it removes any temporary file of an interrupted run after its rename. The channel is
missing only between the DELETE and the PATCH (the test measures it), never half written. **Requests** (review f A-M2,
B-L1, B-L2, A-L4): each has a timeout (30 s; 15 min for an upload over 1 MiB — the archive by hand); GET, DELETE and
PATCH are asked again after a 5xx, a 429, a 403 with Retry-After or no request left, or a network error / timeout
(pauses 1, 2, 4, 8 s; Retry-After honoured up to 60 s) — never an upload or a creation; a 422 on creating
`update-feed` means "exists" only with GitHub's `already_exists`; the token goes to the API and to a release's
`upload_url` only when that is the API's own upload host (`uploads.<host>` for `api.<host>`, else the API's host:
Enterprise Server). A file read back follows up to three redirects to GitHub's storage, each https, none with the
token, at most 1 MiB (announced or received); a read that fails stops the run (a failed read is never taken for
"absent": that could move a channel back); a file that is not JSON is treated as absent and rewritten. The workflow's `publish` job runs one at a time in the repository (job concurrency `release-publish`):
two tags never rewrite the feed together. The notes: `--notes`, else the summary paragraph of the version's CHANGELOG
section (plain text), else its bullets' leads, else "Retake <version>".

**Following GitHub's redirects** (L5.16f). GitHub answers a release file's download address with a redirect to its
download host. The plugin's reqwest client follows redirects by default (up to 10, any host); `ask_feed` builds the
updater with `configure_client(|b| b.https_only(update_flow::https_only(test_feed)))` — reqwest refuses a non-https
URL on the first request and on every redirect (its redirect policy checks `https_only` per hop) — and the found update
keeps the builder's client for the download, so the check and the archive accept a redirect to another https host and
refuse http anywhere on the way; `fetch_archive` still refuses a non-https archive address up front. Any https host is
followed — the trust is the archive's signature, not the host. No test proves the http refusal at run time (it needs
an https first hop: a TLS listener, a certificate and a trust override the repository does not have): it rests on
reqwest 0.13.3 (`src/redirect.rs`, the redirect policy's per-hop check) and the plugin 2.14.0 applying the client to
the check and the download, both read in the locked sources; desktop-config.test.ts pins those two versions so a bump
fails until it is checked again (review f A-L8 / B-L4). The e2e build's
127.0.0.1 feed alone is http (`is_test_feed`); its feed server now answers both the feed and the archive with a 302 to a
second server on the next port, and the test checks both hops were followed. Measured (2026-11-04): the gated end to end 3 / 3 in 304 s,
both hops of the check and of the download followed, the real update 13.7 s from launch to the restarted 0.2.1.

**The flow** (`desktop_core::update_flow` holds the rules; update.rs the I/O).
- *When*: at launch when due — never checked, a day since the last successful check, a clock that went back, or a
  failed install remembered (`launch_check_due`: the restarted app asks again at once, review d B-M2) — remembered in
  `<Retake home>/desktop-updates.json` (0600, atomic; doctor reads it: "App updates", critique L7, a warning after 30
  days); Help › Check for Updates… now, its answer in an alert (up to date, off, could not check — each with the last
  successful check's date) or the Studio's sheet — refused, and said, while a check, a download, a wait or the install's
  quit is under way (`check_refused`, review d B-M1: a check then would drop the archive the wait holds). The feed
  must answer within 30 s (the plugin's request timeout). `RETAKE_DISABLE_UPDATE_CHECK=1` (true, yes) turns the
  checks off; an app running from a translocated copy or a read-only disk is off too ("move it to Applications": the
  plugin's renames need a writable folder on its volume — critique H1); /Volumes (an external disk) is allowed.
- *What the Studio sees*: one stdin line per state (`off` + reason, `idle`, `checking`, `available` + version, notes,
  date, `downloading`, `waiting` + jobs, `installing`, `failed` + failure and `retry`) with fixed keys, a checked
  version, the feed's notes cleaned (no control, bidi or zero-width character, ≤ 2,000 characters, the line cut to the
  server's 8,192 BYTES: `fits_shell_line`, shared with part c's folder line — review d B-L4); the server parses them
  again (update-ops.ts), `desktop_update_status` gives the notes under `untrusted`, the page shows them through Txt in
  a named, keyboard-scrollable region; the native alert never shows them (the feed is not signed). "Update available ·
  vX" is a kit Button in the status bar (a live button while a step runs: it reopens the sheet); its kit Sheet has the
  notes and Later · Install and Restart; then the progress (downloading and checking, waiting for N jobs — Later stops
  waiting —, installing) or the failure in words — the sheet stays open on a refusal ("not writable": install the new
  version from its disk image, also the badge's words; off).
- *The click*: `desktop_update` {install | later} (own op, never an MCP tool: an agent never installs and restarts the
  app; the app's own server only; install only while an update is known — available, or a failure the shell says may
  be tried again, never a dead button; 20 a minute; Later also acknowledges a remembered failure) writes `{"type":"update",
  "action":…}`, the only update line the shell takes from the pipe. `install_step`: off → refused; nothing found →
  refused; the app's folder or its parent not writable by this account → "install the new version from its disk image"
  (no admin prompt from a background flow: the plugin's privileged path is never reached); jobs of this workspace
  running or queued → wait (critique M6: an idle worker hands over by itself when its code changes; a running one is
  waited for, a queued one would start on the old engine); else a quit.
- *The install*: the archive is downloaded (https only — the e2e build's 127.0.0.1 feed aside —, at most 1.5 GB
  received or announced, stopped after 60 s without a byte or 2 h in all: `watch`, a seam unit-tested with an endless
  and a hanging producer; Later aborts it) and verified (the plugin: the key compiled in, the signed version equal to
  the announced one, never older), then kept in a 0600 file of the app's cache folder (`updates/update-<pid>.tar.gz`,
  the folder 0700 — never held in memory through the wait; removed after the install, on Later, and at the next start
  when its process is gone); then the quit goes through the existing guard as `Action::Update` ("Install the update and
  restart Retake?" — unsaved text asks, the page's sheet first, the native alert after 1.5 s; jobs listed there "keep
  running; they may fail once the app is replaced"). The arming (`Arm`, review d A-M1): the posted `terminate:` must
  reach the guard within 10 s (else back to Available); once the guard took it for the update, the person's answer
  holds however long the question stays open; it is never armed while a quit question is up in the page; Now approves
  it (a signal's quit never does); Cancel, Later or a dropped page question disarms it. At RunEvent::Exit, after the
  owned server stopped gracefully, `finish` reads the file and lets the plugin verify it again and swap the bundle
  (`renamex_np` RENAME_SWAP on APFS, the previous app restored on a failure) and restarts — Tauri's restart
  (LaunchServices, `open -n`, the log filter flushed first) for a person, the new binary started directly in test mode
  (never LaunchServices; the old process waits 1.5 s so its child's test mode, decided from its parent, holds; the
  click by itself only in a build made with the e2e overlay: `test_install_allowed`). An approved install with no
  archive left remembers the failure and restarts (an approved click never just closes the app). A swap that fails
  restarts the old app, which says so and checks again (`failed` kept until a check finds no update or another version,
  an install succeeds, or the person's Later); a swap whose old app could not be put back (the plugin's fallback path)
  says where it was left in an alert, and nothing restarts. The non-test restart path runs in no automated test
  (MACOS-CHECKLIST 15d).
- What an update replaces: the whole `.app`; the Retake home, workspaces, the command's link and the Claude
  registrations point at the same paths. Processes still running from the old bundle (another workspace's worker, an
  MCP server Claude started) keep their loaded code; an idle worker hands over (critique M6). Cut to BACKLOG BL-143:
  counting those processes before the swap, an admin install, delta updates, the download's progress.

**Measured** (the gated end to end, 2026-11-03): the two builds 188 s — 0.2.0 117 s (stage 15.7 s, payload signing 4.5 s, `tauri build` 56.4 s with a cold cargo target and the plugin, verification 16.4 s, the archive and its signature 23.5 s), 0.2.1 from the same stage and target 71 s (`tauri build` 22.7 s); app 941 MB (no ffmpeg in that run), archive 345 MB (344,896,177 bytes), its 5 links those of the app, signed for 0.2.1 by the CLI with the test key. A feed whose signature (same key, same version) is of other bytes: the plugin refused the download ("The signature verification failed"), the app kept running at 0.2.0, nothing installed. The real update: 13.0 s from the launch of the 0.2.0 copy to the restarted app's first line — check, download and check of the 345 MB archive from 127.0.0.1, the quit (nothing pending: no question), the owned server stopped gracefully in 22 ms, the swap, the restart; the restarted 0.2.1 served the workspace with a server of its own; `codesign --verify --deep --strict` passed on the swapped app, every link there, no AppleDouble file; Chromium 141.0.7390.37 (new headless) and the headless shell launched from it with its own Node.js. Whole test 225 s, 3 / 3. Two findings of that test, fixed: `tauri::generate_context!` embeds a config's `plugins` as serde_json values (the `updater` feature adds the optional `serde_json`, already locked); test mode's restart gave the child the log filter's pipe as stderr, whose reader ends with the old process — the restarted app lost its lines and hung on the first one (it now gets the real stderr: `logfilter::real_stderr`). Re-run after the review d fixes (2026-11-03): 3 / 3 in
230 s — builds 188 s (0.2.0 116 s, 0.2.1 71 s), archive 344,931,374 bytes, the forged feed refused and nothing kept,
the real update 13.4 s from launch to the restarted 0.2.1, the verified archive kept in the app's cache folder
(scratch HOME) until the install and gone after it; the gated desktop-shell black box 18 / 18 (one slow case skipped).

### 4p (e). Releases from GitHub Actions (L5.16e)

R-APP-08 (the release run). The person's decision (2026-11-04): the repository is public on GitHub and releases are made
there, from a tag, on GitHub-hosted runners — the DMG attached to a public GitHub release, the update published in the
repository's `update-feed` release (L5.16f; §4p (d)). docs/RELEASING.md is the person's guide;
`.github/workflows/release.yml` the workflow.

- **Five jobs; the keys never meet dependency code** (review e A-H1: on a hosted runner every step runs as the same
  user and a process left by one step outlives it, reading files and other processes' environments — `buildEnv` is no
  boundary between processes). `release` (ubuntu-24.04, `environment: release`, contents: write): the tag is the
  version (`set-version.mjs --check`, `release.mjs tag`; a pre-release version makes a pre-release), the tagged commit
  is an ancestor of `origin/main`, **what is configured** (below), then a **draft** release (CHANGELOG paragraph + how
  to install), created or edited. `build` (macos-15, contents: read, no environment, no secret, no variable — the feed
  and public key come as the release job's outputs): Node.js (below), corepack's pnpm (package.json's `packageManager`
  carries its sha512, checked on download), `pnpm install --frozen-lockfile`,
  Rust 1.99.1 through the image's rustup (`rustup toolchain install … --profile minimal --target aarch64-apple-darwin`,
  `RUSTUP_TOOLCHAIN`; no third-party toolchain action), `pnpm build`, the Tauri CLI into the pnpm store, Playwright's
  browsers then `bundle.mjs check-pins`, our ffmpeg (pinned sources; `HOMEBREW_NO_AUTO_UPDATE=1`, pkg-config's version
  printed; built at every run), then `pnpm desktop:bundle --app-only` — exactly the ad hoc app of `desktop:bundle` — packed with
  `/usr/bin/tar` (links kept, no extended attribute, no Mac metadata) with `tauri-cli/`, its sha256 a job output,
  uploaded as an artifact. `sign` (a **fresh** macos-15, `environment: release`, contents: read): checkout, Node.js,
  the artifact checked against the build job's sha256 and unpacked **before the signing material is written** —
  `node apps/desktop/scripts/release.mjs unpack` (`unpackBuild`: the archive decompressed in Node.js and its members
  read by our own reader, `tarMembers` — ustar and pax headers, every checksum and the ustar magic, octal fields, no
  data for anything but a file, zeros only after the end marker; GNU long names, global or sparse pax headers and
  another character set refused, so tar walks the bytes as it does —; only `app`, `app/Retake.app/…` and
  `tauri-cli/…`, those three themselves folders, files and folders under `tauri-cli`, files, folders and links whose
  relative target stays inside the app under the app; a hard link, a device, a fifo, an AppleDouble `._` name, a name
  given twice, `..`, an absolute name or a missing part refuses it before anything is written —, then tar extracts
  the two parts from those very bytes (its standard input; `--no-mac-metadata --no-xattrs --no-acls --no-fflags`),
  then checked: exactly them in the folder, real folders, every link of the app resolving inside it by the system's
  realpath — Node.js's own resolves a link's `..` lexically; a refusal leaves nothing behind) —, then the signing
  material and `release.mjs sign` only — no pnpm install, no package script, no Homebrew, no cargo; the
  outputs (DMG, archive, .sig, SHA256SUMS-macos.txt) uploaded as an artifact; the temporary keychain and key files
  removed in a last `always()` step. `attach` (ubuntu, contents: write): the files checked against the sign job's sum,
  then **refused unless the release is still a draft** (review e A-M4 / B-M2: a public release's files are never
  replaced — a re-run after the publish fails there; a fixed build is a new version), the assets this build does not
  make removed (a re-run with another configuration leaves nothing stale), the files uploaded (`--clobber`), the notes
  completed. `publish` (ubuntu, `environment: release` — no secret since L5.16f: the environment is the gate before the
  release goes public —, one at a time across tags): public (latest or pre-release), then — updates on — the archive
  and .sig fetched from the release (a missing one fails the job; review e B-M3: no `|| true` anywhere) and published
  with `publish-update.mjs`, the job token as GITHUB_TOKEN and the public key from the release job's output.
- **The sign entry** (`apps/desktop/scripts/release.mjs`: `finishApp` + `sign --app <dir>/Retake.app --out <dir>
  [--release] [--app-version <v>] [--tauri-cli <dir>]`): its whole import graph is Node.js built-ins and repository
  files (`release-workflow.test.ts` walks it: bundle.mjs, sign.mjs, desktop.mjs, publish-update.mjs). A release
  re-signs the ad hoc app inside-out with the Developer ID (the payload in Contents/Resources by the same table, then
  bundle.json's hashes refreshed, then the shell and the app), checks it (verifyApp release, appProblems), notarises it
  as a zip and staples it; then the update archive of the stapled app (an app built with the updater: launch.json
  `updates: on`), signed by the Tauri CLI the build job laid out — **re-checked file by file against tauri-cli.json's
  sha512 pins before it runs** (`checkTauriCliDir`: exactly the pinned files, no link, no other file or package; chosen
  over a minisign signer of our own, which would need the key format's scrypt and BLAKE2b-256 code) and **run from a
  fresh copy** (bundle.mjs `freshTauriCli`: the handed folder no link, each pinned file read once without following a
  link — one swapped in after the folder's check is refused —, those bytes checked and written into a new temporary
  folder, the copy checked again: nothing beside the handed folder is on the CLI's module lookup path), made by
  finishApp right before the update archive is signed and removed right after, whatever happens (the `--tauri-cli`
  folder itself is checked before `--out` is claimed and again before anything is signed); the CLI runs with HOME in
  the copy and is refused before it starts when a folder of its module lookup path outside the copy exists
  (`cliLookupPaths`: a `node_modules` in each folder above it, HOME's `.node_modules` / `.node_libraries`, the Node.js
  prefix's `lib/node` — the list a test compares with what Node.js itself reports) — the signature then verified
  against RETAKE_UPDATE_PUBKEY; then the DMG (hdiutil create / attach / detach tried again on "Resource busy" only —
  3 tries, 2 s then 4 s; review e B-M4), signed, notarised, stapled, then the team, Gatekeeper and both tickets checked.
  Without `--release`: the ad hoc app checked as it is, an ad hoc DMG, said. `--app-version`: Info.plist's
  CFBundleShortVersionString must be it (the workflow passes the tag's) — the archive is signed for it (review e B-L7);
  bundle.json's `app`, which names the DMG, must be a version and, with `--app-version` or a DMG to make, Info.plist's;
  bundle.json's `paths.node` / `paths.ffmpeg` (its hashes are refreshed from them) relative, with no `.` or `..` part,
  inside Resources by the system's realpath; bundle.json and launch.json not JSON: refused without their words — all
  before anything is signed.
  `--out` is empty or an earlier run's (emptied first: no stale archive). `pnpm desktop:release` = the ad hoc layout +
  the same `finishApp` in the same process.
- **What is configured: two sets, each all or nothing** (review e B-M1; `release.mjs preflight`, `CONFIG_SETS`).
  The Apple set (seven secrets: certificate, its password, identity, team, API key id, issuer, .p8), the updater set
  (the key and its password as secrets, `RETAKE_UPDATE_PUBKEY` as a variable; L5.16f dropped the update host's
  `UPDATES_PUBLIC_URL` and the upload pair: the feed's address comes from the run's context). None of a set: that part
  is off and said (an ad hoc build "Not notarised … Open Anyway"; "Updates are off in this build"). Some: the run
  fails in the release job, before anything is built, naming each missing name — and "set as a variable: it must be a
  secret" (or the reverse) when the name sits in the other store: the release job sees each secret only as
  `secrets.X != ''` (true / false, never its value) and each variable by value, so a name in the wrong store *is*
  detectable. With the updater on, the feed (`release.mjs feed`: GITHUB_SERVER_URL + GITHUB_REPOSITORY), the repository
  public (review f A-L3 / B-L5: the step before reads `gh api repos/<repo>` with the job token — `private`,
  `visibility` — and the preflight refuses one that is not public, or unknown, before anything is built; publish-update
  checks it again) and the public key are checked there too and handed to the build job as outputs (public values). The sign job checks its own set again first (review e B-L4).
- **The release environment** (review e A-M1): secrets live in the `release` environment, which only `release`
  (presence only), `sign` and `publish` (no secret: the gate) reference; RELEASING.md has the person give it a deployment rule for `v*`
  tags only, add a tag ruleset (only they create, update or delete `v*`) and protect main — GitHub settings, made by
  the person.
- **Pins** (review e A-M2 / A-M3 / B-L9): every action pinned to the commit of an exact upstream tag, resolved
  read-only (`gh api repos/<o>/<r>/git/ref/tags/<tag>`, all lightweight tags) and written beside it: checkout v5.1.0,
  upload-artifact v6.0.0, download-artifact v6.0.0 — no setup action. **Node.js** is the version
  `apps/desktop/bundle/node.json` pins (22.16.0), installed by every job's first step after its checkout,
  `bash apps/desktop/scripts/ci-node.sh` (it runs no node): the official `node-v<version>-<platform>.tar.gz` fetched
  over https from the Node.js project, its sha256 checked in the shell against node.json's `tarballs` (the lines of
  the project's SHASUMS256.txt, its signature checked against a listed releaser's key) before anything of it is
  unpacked or run — npm, corepack and the rest of the install with it —, unpacked into `$RUNNER_TEMP/node`, its
  bin/node checked against node.json's `sha256` for darwin-arm64 (the macOS jobs) or linux-x64 (the ubuntu ones),
  its bin first on PATH (`$GITHUB_PATH`); the stage refuses any other binary again (`checkNode`) before it copies it.
  Playwright's installer checks no hash:
  each browser revision folder's tree digest (every path, link target, size, executable bit and sha256, markers left
  out: `browserDigest`) is pinned in `apps/desktop/bundle/browsers.json`, recorded from a checked local install of the
  lockfile's playwright-core (re-recorded at each bump), and the stage refuses another tree (`checkBrowser`;
  `check-pins` right after the install). **The first tagged run may need these digests refreshed** if the CDN's
  browser archive lays files out differently from the local install — the build job then fails with the digest it
  found, and `bundle.mjs browser-digest <folder>` records a checked one (the darwin-arm64 binary pin was recorded from
  a local install of that tarball: the first run confirms it too). **No cache**: no `actions/cache` step and no setup
  action — nothing is restored from an earlier run or another workflow; the pnpm store, ffmpeg and cargo are filled
  at every run from the lockfile and the pinned sources (a re-run downloads ffmpeg's sources again: two are archives a
  forge generates, re-pinned after a re-verification if their bytes change). RELEASING.md has Playwright (the app's
  Chromium) bumped and browsers.json re-recorded at every release (automating it: BACKLOG BL-160).
- **The temporary keychain** (`apps/desktop/scripts/ci-keychain.sh import|delete <dir>`, GitHub Actions only): the user
  search list saved first, a keychain with a random password locked after 6 h, the identity re-wrapped by LibreSSL's
  `/usr/bin/openssl` (the certificate's password from the environment) with a random one-time password and imported
  **non-extractable** (`-x`) for codesign, `set-key-partition-list`, the keychain first on the search list, the identity
  checked against APPLE_SIGNING_IDENTITY (the message names a missing Developer ID intermediate too). **No password on
  any command line** (review e A-L1): the four commands that hold one (create, unlock, import, partition list) reach
  `security` on its standard input (`security -i`, one command per run); an error it says there ("security: …", exit
  status 0 in that mode) fails the step, its words printed with the passwords taken out. delete puts the list back,
  deletes the keychain and removes every file of the folder even when `security` fails (then says so; review e A-L2).
  sign.mjs: `APPLE_KEYCHAIN` → `codesign --keychain <it>` in a release (redacted in a failure's text).
- **Notarisation and Gatekeeper** (review e B-L2 / B-L3): `notarytool submit --wait --timeout 75m --output-format
  json` (the sign job allows 180 min for two); anything but `Accepted` fails with Apple's status and message and the
  first issues of `notarytool log <id>` (same API key; no secret printed). `spctl -a -vv` must say `accepted` and
  `source=Notarized Developer ID` — its exit status alone passes on a Mac with relaxed assessments.
- **Secrets and the token** (held by `release-workflow.test.ts`, which also runs the step scripts in bash against
  stand-ins of `gh` and `security`): top-level `contents: read`, `contents: write` only on release / attach / publish
  (the jobs that call `gh`, none runs a build tool); the job token only in the four steps that call `gh` and in
  publish › Publish the update (L5.16f: publish-update.mjs, our script, as GITHUB_TOKEN); no `UPDATES_*` name; no secret in
  a workflow / job env, a `with`, an `if` or a script; key material bound in sign › Signing material only (no build
  tool, no `gh`, `umask 077`); `persist-credentials: false` on every checkout; only `push: tags: v*`.
- **Not covered**: build provenance (an attestation of what the build job built) — BACKLOG BL-145; the build job is
  trusted to build what the tag says (the sign job signs what it is handed).
- **Licence** (BACKLOG BL-138): the app ships Remotion's compositor's FFmpeg build (GPL, fdk-aac compiled in) —
  accepted on 2026-11-04 for the person's own releases, though a public release is distribution to anyone who
  downloads it; to resolve before any sale (the licence note of docs/guide/desktop-app.md and the README's Licence section say so).
- **Not run here**: the workflow itself (no GitHub write from this repository's tooling, actionlint not installed) —
  `security -i`, the Node.js download (ci-node.sh against the project's host) and the CDN browsers' digests meet the real runner on the first tagged
  run, and the GitHub REST calls of publish-update.mjs (tested against a local stand-in of the API only) meet GitHub on
  the first publication; the notarised DMG on a clean account and an update through the feed are the person's
  (MACOS-CHECKLIST 15b, 15d).
  Here: `release.mjs sign` (ad hoc) on the app `desktop:bundle --app-only` built, the gated bundle acceptance, and the
  pinned Tauri CLI laid out from the pnpm store, copied fresh, its `signer generate` and `signUpdateArchive` run from
  the copy (a throwaway key, HOME in the copy) with the signature verified.

## 4q. Captures first (L5.14)

A take filmed on a loaded machine shows it (fewer frames during motion, more kicked frames): renders, exports, reviews,
previews and site extractions are background work, a take is not (BL-116). Built on the file queue (decision of
2026-11-04: no new dependency; ADR-1 unchanged, BL-117 parked).

- **Classes** (core `JOB_CLASS`, `jobClass`, `isFilming`): `capture` — run, hooks, env_reset, auth_login, sandbox_up,
  sandbox_reset, inspect, record; `heavy` — render, review, export, preview, site. An unknown kind is a capture (the
  worker refuses it in its own process, as before). A new kind does not type-check until it picks a class. Only a
  filming take (`run`, mode `capture`) holds heavy work; the other captures go first and stay one at a time with the
  takes (hooks, resets and sandboxes share the hooks journal) but hold nothing (a 30-min recording window does not
  freeze renders).
- **Two slots per worker** (jobs/worker.ts): the capture slot runs captures in the worker (unchanged code: the live
  channel, the test hooks, the signal rules); the heavy slot runs one heavy job in a **job process**
  (`worker-main --job <id> --kind <kind> --root <ws> --build <stamp> --supervisor <pid> --digest <sha256>`, jobs/job-child.ts), detached
  (a process group of its own), log in worker.log, environment = the worker's. It runs the worker's job code
  (jobs/run-job-record.ts), writes job.json from `running` on (`worker` = itself, `supervisor` = the worker), refuses
  another build (exit 3: the worker gives the job back — removes its claim — and hands over once both slots are empty)
  and anything but the queued heavy job of that kind its worker claimed — the very record, by its digest (§4b) — (exit 4:
  `failed`, invalid). Its build is
  stamped over the folders the worker stamped (`RETAKE_JOB_BUILD_DIRS`: a worker run in-process by a test resolves the
  packages otherwise than a process started from the sources). It polls its parent pid every second: its worker gone, it
  cancels the job (teardown and clean-ups run) and ends it `interrupted` itself — macOS sends nothing to an orphaned
  group (probe 3). A job process that dies before writing its end: the worker writes `interrupted`, its state / result
  events numbered after the child's last one. A next worker, before any claim, gives such a process 15 s, then SIGTERM,
  then kills its tree — only when it is provably that job's job process: a pid above 1 on this host, running with the
  start time its record names, with a job process's command line for that job id and this workspace (review A M1);
  any other recorded pid is left alone and the job persisted `interrupted` without its clean-ups. A record whose kind is
  not its input's kind (what a job process refuses) ends `failed` on its first claim, never claimed and given back in a
  loop (review A M2). With `previewTest` (in-process tests only) heavy jobs run in the worker, one job at a time, as
  before.
- **Signals** (jobs/signal.ts, review B L1): every signal to a job process or its tree, and the root of every QoS hold,
  goes through one guard — never a pid that is not an integer above 1 (a failed spawn's -1: `kill(-1)` reaches every
  process of the user; 0: this process's own group; 1: launchd), the worker itself or its own group. A spawn that failed
  has pid 0 until its `error` event.
- **Claims** (jobs/pick.ts, pure): ids oldest first; the capture slot takes the oldest queued capture whatever the age
  of the heavy jobs; the heavy slot takes nothing while a filming take of this workspace waits in the queue (unclaimed,
  not cancelled — a cancelled one holds nothing), nor while something films now: the worker's own take while it films
  (runner `onFilming`, live — not during its setup or teardown hooks, not while it is paused: review B M3), or a filming
  marker of this user. The class comes from the kind of the job's input through this build's table; no field of
  job.json orders the queue. While the worker's own take films and nothing heavy can start, the loop does not scan the
  queue, nor stamp the build (the take's event loop is the worker's). A build change stops every claim (captures
  included); hand-over waits for both slots. `once` = one job. The first signal cancels the capture and SIGTERMs the job
  process (before any QoS release: a slow `ps` never delays it), and the worker waits for both before releasing its
  lock; a second one kills the job process's tree. `queue.position` of a heavy job a take holds says `held_by: 'take'`
  ("waiting for a take to finish" in `retake jobs`, MCP and the Studio), whatever its place in its lane.
- **Filming markers** (jobs/captures.ts) — one folder per user on this Mac, not per Retake home: macOS
  `<getconf DARWIN_USER_TEMP_DIR>/retake-captures` (0700, independent of TMPDIR), elsewhere `<RETAKE_HOME>/captures`;
  `RETAKE_CAPTURES_DIR` replaces it (the test runner gives each test file one: vitest.setup.ts; under a test run — VITEST
  or any RETAKE_TEST_* variable — the per-user folder is never used without it, and every test that builds a process
  environment by hand carries it: core retake-home.test.ts). A folder that is not a real 0700 directory of the user is
  not used (nothing holds). One file per take, `k_<ULID>.json`, created whole (tmp + rename), 0600:
  `{v, pid, started_at, ws, source, paused?}` — `ws` is a random id of the workspace (`.retake/capture-id`), never a
  path, slug, scenario, run or job id. Read with core `readPlainFile` (no link followed, a FIFO never blocks, at most
  4 KB). Written from capture time 0 to the end of the scenes (runner `onFilming`: not around setup / teardown hooks or
  the encode's end), `paused` while the take is paused (L4.4: the pause is not filmed; written back before the
  recorders film again), removed at the end, on process exit, or by any reader once stale. Liveness: the owner rewrites
  the file's time every 2 s; a marker counts while its time is within 10 s of now — a time in the future is no fresher —
  AND its pid runs with the recorded start time (none recorded: only where ps cannot read one either) — a `retake run`
  suspended with Ctrl-Z goes stale. Cap: an owner (pid + start time, not a file name) holds at most
  `RETAKE_CAPTURE_HOLD_MAX_MIN` (default 60) of holding time, counted by each reader from its first sight of it (a gap
  counts at most 5 s); a rewritten, renamed, or stale-removed-and-rewritten file does not restart it while its owner
  keeps a marker within 10 s (`CAP_CARRY_MS`: two takes of one worker closer than that count as one); then heavy work
  goes on, and that is said: the running heavy job's yield reads `past_cap` ("going on: a take … has held heavy work for
  over 60 min"), the terminal command prints one line. Markers owned by an ancestor of a command do not hold it (a take's
  own hooks).
- **A running heavy job during a take** (jobs/yield.ts, chosen by the spike below): background QoS — `taskpolicy -b`
  on every pid of the job process's tree (its group and every descendant: Remotion's browser is detached), walked again
  every 2 s with `-b` for the new pids only (one `ps` per walk, with a 5 s limit, and a `/bin/sh` only when the tree grew:
  the take's event loop may be the worker's); `taskpolicy -B` per pid when no marker holds, only for the pids the hold
  made background (a pid at background QoS before — `ps -o pri` 4, someone's `taskpolicy -b retake render` — keeps it,
  and so do its children; a child forked under a held pid inherited the hold's and gets `-B`); a pid whose start time
  changed is never touched. The worker writes `<job>/yield.json` (`{v, state: background | past_cap, since, cause,
  cap_min?}`) while it holds, or while a take past the cap still films, and removes it before it releases. Cancel of a held job: it stays at background priority and ends itself (its clean-ups run);
  its tree is killed only `cancelGraceMs` (30 s) after the cancel, then the worker writes `cancelled`. One writer of a
  job's end: the job process, else the worker when it died first (its events appended after the file's last seq;
  never a second `interrupted` from the scan, which skips the worker's own slots).
- **The CLI** (cli/src/heavy-gate.ts): `retake render` (and `--review`), `still`, `export`, `review`,
  `export-capture` and the raw export of `run --raw` wait to start while a marker holds — one line on stderr ("waiting
  for a take to finish (in this workspace | elsewhere on this Mac) before rendering — Ctrl-C to quit, --no-wait to start
  now"), stdout unchanged, Ctrl-C exits 130 with nothing written — then yield by background QoS on their own tree during
  a later take (never SIGSTOP: a stopped foreground command hands the terminal back). `latest` is resolved before the
  wait ("rendering run <id>" after one). `--no-wait` skips both. `retake run` (capture) writes a marker while it films;
  `--dry` none. Nothing filming: one read of an empty folder.
- **The spike (L5.14a; M4, 24 GB, the machine otherwise as quiet as it could be made; fixture `quote`, a 47 s take, a
  61 s render of 1832 frames)**, twice: today's render (concurrency 7, software GL, libx264 CRF 16) and BL-114's
  (angle, VideoToolbox at 4 Mb/s, concurrency 3, injected without a code change). S0: two unpaused renders give
  identical frames today (framemd5 1832/1832, 85–93 s); BL-114's do not (1405/1832 identical, SSIM min 0.9957 — its
  criterion is that spread). S4 (`motion_fps_min` / kicked / dropped / stalls; each condition 3 takes, every run listed
  here; 5 takes alone first). Today: alone 60.5, 51.4, 59.7, 60.3, 60.4 fps (median 60.3, spread 9.1) / kicked 9–10 /
  dropped 5–7 / 0 stalls; beside an untouched render 45.7, 28.4, 32.3 (median 32.3) / 14–18 / 7 / 1 stall each; beside a
  render SIGSTOPped for the take 60.5, 29.6, 51.5 (median 51.5; the 29.6 take was disturbed by a build on the machine) /
  7–12 / 6–8 / 0; beside a render under background QoS 41.7, 52.1, 57.3 (median 52.1; the 41.7 take is below the bar —
  one QoS take of three today) / 10 / 5–8 / 0. BL-114: untouched 28.0, 28.9, 32.2 / 16–20 / 7–9 / stalls 3, 3, 0;
  SIGSTOP 60.5, 60.5, 58.4 / 8–11 / 6–7 / 0; QoS 56.3, 60.7, 57.7 / 8–12 / 5–8 / 0. Pass rule on the medians:
  ≥ alone − max(2 fps, the alone spread 9.1) = 51.2 fps, kicked ≤ alone + 2, dropped ≤ alone + 1, no stall — both
  mechanisms pass, so QoS wins (M5: no timer of Remotion's to defeat, no stopped tree to recover, reversible without
  root). **QoS passes today by 0.9 fps** (52.1 against 51.2), on a bar widened by the alone spread: a noisier or slower
  machine, or one more process in the render's tree, may fail it — L5.15 (BL-114's settings) re-runs S4 for QoS against
  this bar, and SIGSTOP stays the fallback studied below. S6, the render's frame rate before → after `-B`, all six
  pairs: today 22.1 → 22.0, 23.5 → 23.1, 11.7 → 21.2 (the "before" sample taken while the render was still starting);
  BL-114 24.9 → 24.5, 23.6 → 29.0, 26.5 → 26.3 — no pair slower by more than 2 % after; the frames identical after a hold
  (1832/1832 today; BL-114 within its own spread, SSIM min 0.9956). Some Chromium processes keep `pri` 46/47 under `-b`
  in the spike's samples (their own QoS); the integration test sees every process of a job's tree at 4. S1 (SIGSTOP
  correctness, for the record, both settings): a stop at 40 % of the frames for 10 s, 120 s, 60 min (the cap), at 97 %,
  right after the browser started, twice in one render (30 % and 60 %, 3 min each). With Remotion's frame timeout raised
  (6 h) all succeeded with today's frames identical (BL-114 within its spread) and the same GPU process. With the
  default 90 s timeout the 120 s stop failed in BOTH settings, 1 of 2 runs each: BL-114's with "Timeout (90000ms)
  exceeded rendering the component" (probe 1 in situ), today's with an unhandled EPIPE and no error message — SIGSTOP
  would need the timeout raised and a watchdog of active time. A stopped render holds 2.9 GB (today, 14 processes) and
  2.2 GB (BL-114, 10 processes) for 60 min, with 21 000 and 24 600 pageouts over the hour; a 3-min stop right after the
  browser started stretched one render from ≈ 95 s to 530 s. The stop during bundling and S2 (exports) were not reached
  by the spike's triggers (the exports ran unstopped). The spike took ≈ 4 h 50 min (S0 6 min, S4 1 h 40 min, S1 3 h).
- **Surfaces (L5.14b)**: readers derive `JobRecord.yield` — `{state: waiting | background | past_cap, cause: here |
  elsewhere, since?, cap_min?}`: `waiting` for a queued heavy job while a take holds heavy work (a filming take of this
  workspace queued, or a filming marker: `FileJobQueue.takeHold`, read once per list, per JobsWatch poll and per
  Activity feed, and reading only the jobs the queue has not seen finished — review A M1: a finished job.json is read
  once per queue, not at every poll), `background` / `past_cap` from a running heavy job's yield.json; never written
  back. yield.json and the queued records are in agent-writable job folders: they are read as enums, a time and a
  bounded number only (review A L4) — a forged one can make a row say "slowed", nothing more. Fixed words only (engine `held.ts`, the Studio's render-words.ts):
  "waiting for a take to finish (in this workspace | elsewhere on this Mac)", "slowed during a take (…)", "going on: a
  take (…) has held heavy work for over N min" — the other workspace is never named. MCP: `job_status`, `job_list`,
  `render_status` say them with the enum in `data.yield`; `engine_info` has `held` (`{state, cause, kind, count}` of
  this workspace's jobs) and a "Captures first:" sentence. `retake jobs` puts the words on the job's line (`jobs status`:
  a `held` row with the time). The Studio: a render row's words on the Review report and the scenario screen (no time
  left while slowed: it would be wrong), the "Lately" feed, and the status bar's segment ("a render is slowed during a
  take (…)") — from engine_info, then from each jobs event (`held`; the job stream's signature has the yield, so a
  hold shows within one poll); at 1000 px and less it keeps its short form ("a render slowed by a take") where the
  other segments drop (docs/reference/studio-ui.md). `retake doctor` has a "Captures first" line: the takes filming now (counted: in this
  workspace / elsewhere, paused, past the cap), the markers' folder (never made by doctor), whether background priority
  is available (`/usr/sbin/taskpolicy`), the cap; WARN when the folder cannot be used or a marker's owner is not a
  Retake process — its command line a jobs worker (`…/worker-main.js`) or the CLI's `run` (engine `isTakeOwnerCommand`;
  review A L3: another node process is not one) — it holds renders up to the cap. A take's report (run.json
  `perf.machine`): `takes_beside` — the most other unpaused takes filming at once while it filmed — and `heavy_slowed`
  — heavy work (a render, review, export, preview or site extraction) of its workspace's jobs worker ran at background
  priority during it (not counted: a terminal `retake render`, which has no job, and another workspace's work);
  sampled every 2 s by the take's owner (engine `TakeBeside`, critique L9: the runner only records the answer of
  `onFilming('stop')`) without reading any job folder (review A H1: the take's event loop) — a take in the worker asks
  the worker's own hold, a terminal take reads the one file the worker keeps while it holds heavy work
  (`.retake/workers/held.json`, state `background`, removed when it lets go); one warning when another take films
  beside it; `choppyCause` says
  "another take filmed at the same time on this Mac" before "the machine was busy". Linux / Windows keep the wait only
  (BL-147).
- **Measured acceptance (L5.14b)**: `packages/ui/test/captures-first-acceptance.test.ts`
  (gated `RETAKE_TEST_CAPTURES_FIRST=1`, ≈ 10 min, run by hand with the machine quiet): from the Studio's own submits
  (`scenario_run`, `scenario_render`) with the worker it starts, `quote` without the two hooks a Studio submit cannot
  approve; 3 takes alone, a reference render (its speed measured), then 3 times a render running and a take submitted.
  *The rule* (review B M2 / M3): first a quiet machine — the 1-minute load average at the start at most half the cores,
  each alone take's highest load at most 1.5 × the cores, the alone takes' motion fps within 10 fps of each other (the spike's quiet alone takes spread 9.1) — else
  the test fails "machine not quiet — re-run" and concludes nothing (a noisy alone set must not widen the bar it is
  judged by: the first version's bar, the alone median − max(2, the alone spread), let three takes at half the alone
  speed pass on a loaded machine). Then fixed bars: every take beside a render films motion at ≥ the alone median − 2
  fps; the beside takes' median dropped and kicked frames ≤ the most the alone takes had; freezes ≤ the alone takes'
  most. The render is measured before the take (4 s of rendering at least), during it and after it: slower during,
  after ≥ 0.8 × before; the job process and at least half of its tree at `ps -o pri` 4 during the take (a few Chromium
  processes keep a priority of their own, 46 / 47), and every process that was at 4 and still runs is not after it.
  Run of 2026-11-04 15:37 (M4, before this rule; other sessions' load up to 18, its alone takes' highest load 12.35 /
  7.19 / 4.61 on 10 cores): alone motion fps at worst 58.5 / 57.7 / 58.7 (spread 1.0: quiet by the gate), dropped 8 /
  4 / 4, kicked 10 / 10 / 10, no freeze; beside a render 57.7 / 58.6 / 56.5 (the lowest equal to the bar 56.5: it
  passes the fixed bar with no margin), dropped 4 / 6 / 10 (median 6 ≤ the alone most 8; one take at 10, above it),
  kicked 8 / 9 / 9, no freeze; each take started 245–375 ms after its submit (never behind the render); the render at
  6.1–6.5 frames/s while the take filmed, 26.6–27.5 after it — its speed before the take was not measured in that run
  (the "before" window never had two samples: the take was submitted at 5 % of the render's progress, reached as its
  frames started); every process of its job process at `ps -o pri` 4 during the take, 31 / 46 / 47 after; frames
  identical to the reference (framemd5 1816 / 1816, three times); each take's report `takes_beside: 0, heavy_slowed:
  true`. A later run with the machine loaded by other work (load up to 31 on 10 cores; one alone take at 26.9 fps)
  failed on kicked (median 14 against 12) — the new rule refuses that run as not quiet instead.

- **The acceptance on the GPU path (L5.15, decided before its run)**: renders now run on the GPU by default on a Mac
  (§4r), so the acceptance runs the shipped default (it sets `RETAKE_RENDER_GL` / `_ENCODER` back to `auto`: the suite
  pins the software path). The take's quiet gate and fixed bars stay exactly as above. The reference render and every
  render beside a take must draw the same way (the record's `policy`: GL and encoder used equal, no fallback — else a
  refusal, not a pass; a fallback of the reference render is a failure of its own — the default path failing on this
  Mac, never "not quiet"); their frames are compared by SSIM ≥ 0.995 on every frame on the GPU path (ANGLE and
  VideoToolbox are not frame-identical run to run: two renders of the shipped settings, 8 Mb/s with a key frame every
  2 s, differ by SSIM min 0.9977 (§4r); BL-114's spike at 4 Mb/s and 12-frame GOPs by 0.9956 — the bar sits under both),
  identical framemd5 on the software path. The
  render's speed is reported before / during / after the take; the test asserts after ≥ 0.8 × before and that every
  process lowered to background QoS came back, and **reports "slower during" without asserting it**: on the GPU path
  most of a render's work is the GPU's and VideoToolbox's (`VTEncoderXPCService`, a system process outside the job's
  tree), which `taskpolicy -b` does not reach — a GPU render may barely slow down, which is good for the take, and the
  take's own bars are what protects it.
  *Its run* (2026-11-05, M4, the quiet gate passed at a start load of 1.99): alone 58.6 / 58.7 / 58.7 fps min, dropped
  4 / 4 / 4, kicked 10 / 9 / 10; beside a GPU render 57.6 / 57.7 / 55.1 against the bar of 56.7, dropped 4 / 7 / 5
  (median 5 against the alone maximum 4), kicked 10 / 10 / 9 — **not passed**: one take under the fps bar (its highest
  load 11.15, against 5.8–6.4 for the other two) and the dropped median one over. Background QoS still slows a GPU
  render: 29.6–33.6 frames/s before, 6.3–6.8 during each take, 30.0–30.8 after. The bars were not widened; the person
  chose to land L5.15 with this gap and run the acceptance again on an idle Mac (R-CAP-03).


## 4r. Renders on the GPU (L5.15; editor `render/policy.ts`, core `render-settings.ts`, `gpu.ts`)

*Measured at the end of L5.15* (2026-11-05, M4, 3 interleaved runs per variant, load gate < 5, peak cores = p95 per
interval; medians): 1080p today 453.9 cpu-s / 77.1 s / 5.9 cores mean, 7.3 p95 / 10.5 MB — GPU 185.9 cpu-s (+ 0.5 in
`VTEncoderXPCService`) / 63.7 s / 2.9, 3.8 / 24.4 MB; 4K today 1 380 cpu-s / 210 s / 6.6, 9.3 / 23.1 MB — GPU 438 cpu-s
(+ 0.6) / 103 s / 4.2, 4.9 / 61 MB. SSIM against today: worst frame 0.9936 (1080p), 0.9958 (4K); GPU run to run 0.9977 /
0.99995. The signed app renders on the GPU path (the gated bundle acceptance, 8/8).

BL-114's spike, measured again and corrected: on a Mac with a GPU a render draws with ANGLE (Metal) and encodes with
VideoToolbox, 3 frames at a time — as fast as before at about 40 % of the CPU time; everywhere else, and as the one
fallback, today's software path.

- **One policy module** (`render/policy.ts`) names the GL, the encoder and the default concurrency of every Remotion
  browser of a process: `openRenderBrowser` opens the browser of a render or a still (render.ts `openSession`) and of the
  component previews and Library loops (preview.ts' backend); `renderPlan` alone takes the encoding fields
  (`remotionEncoding`). The Library's GIF loops are drawn by the policy's browser (ANGLE on a Mac) and encoded as
  before (Remotion's gif codec); `webm`, `gif_preview` and the `mp4_1080p` transcode are ffmpeg's own and untouched.
- **Settings** (core `render-settings.ts`, `WorkspaceFileSchema.render`): `gl: auto|gpu|software`,
  `encoder: auto|videotoolbox|libx264`, `concurrency: 1–16`, in retake.yaml `render:` (set for the process by
  `openWorkspace`, as `ffmpeg`) or `RETAKE_RENDER_GL` / `_ENCODER` / `_CONCURRENCY`. Order: an explicit option (the
  CLI's `--concurrency`, a test's `settings`) → retake.yaml → the variable → `auto` (so a retake.yaml key wins over its
  variable). A bad value fails the render with a message naming the variable; `videotoolbox` outside macOS is an error
  (Remotion's `required` would pick another hardware encoder there). `resolveRenderPolicy` is pure: `auto` → ANGLE on
  darwin, software elsewhere; concurrency 3 with ANGLE (`GPU_CONCURRENCY`), ⌊0.75 × CPUs⌋ in 1–8 in software.
- **The GPU check** (when the browser opens, not by doctor: a GPU can come and go): with ANGLE, CDP
  `SystemInfo.getInfo` on the browser's connection, read by `gpuInfoOf` (moved from runner-web to core). Not
  accelerated (a VM without a GPU, a remote session, SwiftShader) under `auto` → that browser is closed and the render
  browser opened again in software, one warning, and the render takes the software path's default concurrency (¾ of the
  CPUs) unless one is set — the session carries the effective policy (render.ts `Session.policy`), the record and doctor
  say the same; under `gpu` → kept, with a warning. `onBrowser` (the worker records the
  pid to kill it after a crash) and the network guard are called **after** the check, on the browser that renders
  (critique H3). Cost: ≈ 30 ms for the check, ≈ 0.1 s for a reopen. The fallback is today's software raster, never
  `swangle` (SwiftShader through ANGLE: 678 s and 3 574 cpu-s for the fixture's 61 s, against 65 s today). The check is
  read again at the end of a render (≈ 30 ms): Chromium leaves the GPU by itself when its GPU process keeps failing, and
  the record then says `software`.
- **The encoder, chosen before the render**: `auto` takes VideoToolbox with the GPU path when (1) the render fits its
  size limit and (2) the probe passes; else libx264 CRF 16 and a warning saying why. Size limit (`VIDEOTOOLBOX_MAX_SIDE`,
  measured on an M4 with the compositor's ffmpeg, 3 frames, nullsrc): 3840×2160, 4096×2304, 2304×4096, 4096×4096,
  4096×3072 encode; 4104×2304, 2304×4104 and 4096×4104 fail ("cannot create compression session: -12903") — **each side
  at most 4096**. It must be decided up front: an oversize session fails only once frames flow, as a broken pipe (a
  `write EPIPE` that Remotion leaves unhandled), and `--scale` goes up to 4. The probe (`videotoolboxRenderWorks`) runs
  the binary that will encode — Remotion's compositor ffmpeg, through `RenderInternals.callFf` exactly as Remotion
  spawns it (its folder as cwd and DYLD_LIBRARY_PATH: without them it aborts in dyld) — on `nullsrc` (that ffmpeg has
  no `color` source) at the render's size, bitrate and GOP, 3 frames, ≈ 0.12–0.19 s, cached per process, binaries folder
  and size (critique H1: the capture's probe, `color` on our ffmpeg, would always have answered no). A cancel ends the
  wait for it at once (the probe runs on, bounded by its 15 s timeout, and its answer stays cached). It passes from the
  repository and from a relinked copy of the compositor folder (the app's layout, bundle.mjs `relinkCompositor`); the
  signed app itself is checked by the gated bundle acceptance only.
- **VideoToolbox's encoding**: `hardwareAcceleration: 'required'` (never `if-possible`, which falls back to libx264
  silently, and never `crf` with it), `videoBitrate` 0.13 bit per pixel per frame rounded to 0.5 Mb/s, at least 1 Mb/s
  (1080p30 8 Mb/s, 4K30 32.5, 1080×1920 8, 1080² 4.5, 60 fps twice), `gopSize` 2 × fps (Remotion passes no `-g`
  otherwise: ffmpeg's default of 12 frames, 154 key frames in the fixture's 1 844). No B-frames; the comment viewer's
  frame-exact seek holds on such a file (engine render-frame.test.ts). VideoToolbox undershoots its target on this
  content (8M → ≈ 3.2 Mb/s); renders are ≈ 2.3× larger than libx264 CRF 16's (24.5 MB vs 10.5 MB per minute of 1080p,
  accepted 2026-10-28).
- **One fallback, the render path only**: `gpuPathFailure(error, path)` says yes only for the GPU path's own failures —
  the GPU process lost, the GL context gone, the hardware encoder or its pipe — on strong signs only, looked for in the
  lines after ffmpeg's banner and the streams' metadata (its configuration names videotoolbox on every build, and a
  VideoToolbox file's `encoder : Lavc… h264_videotoolbox` is quoted by any stitch failure): `[h264_videotoolbox @`, a
  compression session (`-1290x`), the pipe (EPIPE, by code or message), a video encoder that does not open; never a
  line that merely names the encoder, an audio encoder, a cancel, a full disk, a frame or `delayRender` timeout,
  memory, a crashed page (usually memory), or a RenderError of the plan. A guarded render whose page fails (below) on
  the GPU path counts too. Then the video
  is rendered once more from frame 0 in software with libx264 at the same concurrency (never more memory after a
  failure), through a new session (its browser reported and guarded again), to a fresh temporary name; the partial file
  is removed first (Remotion pre-encodes in its own temp folder: the partial next to the output only exists during the
  final mux). Progress never goes back: the stage is `retrying` and `overall` / `renderedFrames` are clamped to what was
  reached. A cancel during it cancels. The fallback runs once: its path is software, which the classifier never retries.
  When it fails too, the error says both ("render failed in software, after the GPU path failed (<reason>): …") and the
  failed record keeps `policy` (with `fallback`) and the warnings so far; `timings.render_ms` is the last attempt's (the
  GPU attempt's time is in `total_ms`). Stills and previews have the same GPU check and no fallback: a failure is said
  (the Library has Retry).
- **One browser per guarded run**: Remotion replaces the browser it was given when a page of it fails (a closed target,
  a flaky network error: `renderFrameAndRetryTargetClose`, one retry per frame, not configurable) with one it opens
  itself. Every Remotion call of a guarded session (renders, stills, previews and loops of the jobs worker) therefore
  names `/dev/null` as its `browserExecutable` (network-guard.ts `GUARDED_NO_OTHER_BROWSER`): a guarded render never
  lets Remotion open a browser of its own — a frame whose page fails ends the render with a plain error ("a page of the
  render failed …"), after our own guarded software retry on the GPU path; a preview item fails alone, the next one in
  a fresh session. `/dev/null` exists and is no program: Remotion's browser check (one promise queue for every browser
  of the process — a path it rejects there would fail every later browser, our own included) passes, and the launch
  fails at once (spawn EACCES), before anything runs; it leaves an empty profile folder in the temp folder. An unguarded
  `retake render` keeps Remotion's own retry (it has the machine's network anyway). Tested with a component whose page
  fails (network-guard.test.ts, render-gpu.test.ts).
- **The encoder pipe's guard** (`guardEncoderPipe`, installed by the first render or still of a process): an EPIPE
  rejected unhandled is ignored (the render itself fails with it), any other unhandled rejection is left to Node's
  default when no other handler decides — `retake render` no longer crashes on a broken encoder pipe, as the job
  process and the worker already did not.
- **The record** (`RenderRecord.policy`): `gl {asked, source, resolved, used, renderer}` (the GPU's name, 200 characters
  at most, plain text), `encoder {asked, source, used}`, `concurrency_source`, `fallback {reason}` when the software
  path rendered it — the reason quotes the error seen (a component's own words can be in it): the engine's
  `render_status` gives it under `untrusted.fallback_reason` only; `encoding {encoder, crf | bitrate + gop}` (`crf` is
  optional since: VideoToolbox has none). `retake render` prints "h264 VideoToolbox 8M" / "h264 crf 16" and "on the GPU"
  / "in software" / "in software after a GPU failure". `retake doctor`'s **Renders** line (`probeRenderPath`: the same
  checks, nothing written) says what a 1080p render gets here: `GPU (ANGLE (Apple, ANGLE Metal Renderer: Apple M4, …)) ·
  VideoToolbox H.264 · 3 frames at a time`, the settings set and their source; WARN when `auto` found no GPU or
  VideoToolbox does not work, FAIL when every render would fail. (The MCP server relays no doctor line.)
- **The Library's key** (engine library.ts): the browser identity plus ` gl=<resolved>` — the policy resolved before any
  browser opens, which the Studio server and the job process compute alike from the same retake.yaml and environment
  (critique M1: the GL a job found is not known where the states are computed). The rule, tested in two processes
  (library-cache.test.ts): retake.yaml `render:` is read alike by every process of the workspace and wins; a
  `RETAKE_RENDER_*` variable reaches the processes that have it — the worker a Studio or MCP server starts gets theirs
  (`cleanWorkerEnv` keeps them), but a worker already running from another client keeps its own, and the Studio then
  asks for keys its jobs do not write (they say so: `changed`, `expected`), so previews render again — pin a GL for a
  workspace in retake.yaml (guide: workspace). A GPU picture is another picture
  (antialiased edges); committed `preview.png` files stay valid (their staleness is their source hash).
- **Determinism**: software renders are frame-identical run to run and across concurrency (framemd5 1844/1844); GPU
  renders are not (ANGLE + libx264: 1178/1844 identical, SSIM min 0.998; + VideoToolbox: SSIM mean 0.99996, min 0.9977
  between two). So `vitest.setup.ts` pins `RETAKE_RENDER_GL=software` and `RETAKE_RENDER_ENCODER=libx264` for every test
  file (deterministic, Linux's path, today's suite times); a test of the GPU path opts in (`settings`, or the variables
  set back to `auto`) and compares SSIM (≥ 0.995 on every frame) or structure, never bytes (render-gpu.test.ts, the
  captures-first acceptance, the bundle acceptance). `RETAKE_TEST_RENDER_POLICY=keep` runs a suite on the shell's values.
  A process a test starts with an environment of its own (an MCP server, a CLI command) gets the pin through
  `testChildEnv()` (packages/core/test/child-env.ts), checked for every such environment by the retake-home canary; the
  app's acceptances run the shipped default on purpose.
- **What an export passes on**: a re-rendered export (square, vertical) keeps the render's warnings about files and
  about how it was drawn and encoded (no GPU, VideoToolbox's limit or probe, the fallback: export.ts
  `exportRenderWarnings`).
- **Measured (design pass, M4 10 cores 24 GB; the fixture's quote, 61.5 s = 1 844 frames; loads in brackets — the machine
  was shared)**: today (software, libx264, concurrency 7) 451–460 cpu-s, 65–67 s, 6.9–7.0 cores mean, peak 9 [2.5 /
  10.9]; planned (ANGLE + VideoToolbox 8M gop 60, 3) 173–200 cpu-s, 59–61 s, 2.9–3.3 mean, peak 4 [12.7 / 15.3]; ANGLE +
  libx264 at 3: 207 cpu-s, 60 s; planned at 4: 200 cpu-s, 49 s, peak 4.9. 4K (`scale: 2`): today 1 351 cpu-s, 176 s;
  planned 420 cpu-s, 97 s [18.8 / 26.9, loaded]. A 4 min 05 s render (7 346 frames) twice on the GPU path: 1 013–1 057
  cpu-s, 258 s, the GPU process' footprint flat at 653–685 MB, no failure (today: 1 988 cpu-s, 284 s). Where the CPU goes
  (planned vs today, 1080p): Chromium renderers 44 vs 233 cpu-s, GPU process 11 vs 21, ffmpeg 56 vs 100 (decoding
  Remotion's JPEG frames and the BT.709 conversion remain: BL-154), Node 22–47. These are n = 1–2 per variant on a shared
  machine (critique M4); the lot's final figures — 3 runs each of today vs the default at 1080p and 4K on a cool-down,
  medians and spreads, peak cores as the p95 of per-interval CPU gained, SSIM per frame against today's render and run
  to run, the media engine's service (`VTEncoderXPCService`, system-wide) beside the tree's CPU, memory per process kind
  (a summed RSS counts shared pages per process: an upper bound), runs whose cool-down timed out marked and left out of
  the cooled medians — are taken at the end on a quiet Mac (scratch harness `final.mjs`) and go into R-RND-14.

## 5. Fixture product (`fixtures/wholesale`)

A local stand-in for a real SaaS product so the runner can be tested end-to-end without staging access:
"Northfield", a fictional B2B specialty-coffee wholesale platform. Built with **real Radix UI and Base UI
components** (the quirks in the brief come from mixing them), bundled with esbuild, served by a tiny Node server:
supplier console on :4401 and buyer shop on :4402 (configurable via env), and the same apps behind a sign-in on :4403 /
:4404 (L1.6: invented accounts, one cookie name, `POST /api/auth/expire`; fixtures/wholesale/README.md). In-memory data + JSON API with
`POST /api/reset` and endpoints used by http hooks. Screens exercise every interaction pattern of the brief:
imports (New import dialog → organisation combobox → file drop zone → Start import → "921 offers created"),
product availability by region (row action menus with Pause + confirm, Edit dialog with multi-select pickers incl.
search), catalogue + "Add a coffee" (registry search → result → product page with enrichment in progress → tasting
notes, awards, farm), and a buyer shop (home highlights → product → Request a quote dialog with a date-range
calendar → notifications → proposal → "Download quote PDF" `target=_blank`). Server-rendered "Sales reports"
(`/reports`, R-ISS-08) make full page loads mid-scene: leaving the app, a slow report that paints a text-less skeleton
while it fetches its figures, and the way back into the app's empty shell.
L1.7: `GET /api/health` counts `mutations` (successful non-GET API calls since the server started, never reset) — the
proof that a read-only run changed nothing; `/#as-of` adds the shop hero's "Prices as of …" line, the fixture's only
date from the browser's clock (every other date is the server's demo clock). The fixture project gives its pages
display URLs (`*.northfield.example`) and an environment `production` (the local fixture, read-only, with an
environment-level mock); its scenario `read-only` films a mocked quote request with `clock:` and `frame: browser`.
L3.3: `/inspect-lab` on the shop (`server/inspect-lab.mjs`, server-rendered): two identical "Save" buttons, a
"Publish" whose text a paragraph repeats, icon buttons with a generated and a stable id and a testid, fields (label,
placeholder only, native select, a password field with a value, a file drop zone), instruction-like text in a
paragraph, a `role` and an aria-label, an orders table with row menu triggers, an open shadow root, a same-origin and
a cross-origin frame; `?dialog=1` an open dialog with its own "Save", `?rows=N` (≤ 5,000) a long table.
L3.4: `/record-lab` on the shop (an SPA page, `src/shop/pages/RecordLab.jsx`; `/record-lab/results` the same page):
an account form whose password field switches to text ("Show"), is re-mounted as a new plain field holding the value
("Re-mount the field") or printed as page text ("Reveal"), one-time-code boxes, a card number, an API key field, a GET
form with a password; a native select, a Radix select, a Radix dialog, a table whose rows have a Radix menu (Archive
asks to confirm), a file drop zone, a textarea, a contenteditable, a "Mark notifications read" button (the page's one
write) and an in-app link; a script that forges events, calls every window function that looks like a binding and
looks up the kit's and the recorder's names (on load and by a button; its report in `[data-testid=forge-report]`).
L1.8: two sandboxes of the fixture project — `sandbox` (process: `node server.mjs` on 4501–4504, started by Retake)
and `sandbox-docker` (docker-compose, `sandbox/docker/{sandbox.yaml,compose.yaml}`: the fixture image on
4511–4514 + `axllent/mailpit:v1.29.4` on 4525), same pages (the signed-in side), seed (`POST /api/reset`) and
accounts; scenario `sandbox-quote` (no hooks). No npm package at run time: `bundle.mjs` (OUT_DIR, `bundleState`,
`bundleVersion`; node: imports only) is what the server imports, `build.mjs` (esbuild imported inside `build()`) is
loaded only when the bundle is stale, playwright-core only for a PDF. `Dockerfile`: `node:22-alpine`, context
`fixtures/wholesale` with a whitelist `.dockerignore` (package.json, server.mjs, bundle.mjs, server/, src/shared/,
public/build/), the host-built bundle required (`RUN test -f public/build/build.json` with the command to run),
`NORTHFIELD_HOST=0.0.0.0` + port variables, `USER node`, a `HEALTHCHECK` (busybox wget of
`http://127.0.0.1:$NORTHFIELD_CONSOLE_PORT/api/health`), `CMD node server.mjs --no-build`; no Chromium (the PDF
route answers 500). SMTP relay
(`server/smtp.mjs`, `NORTHFIELD_SMTP` / `--smtp` / `startFixture({smtp})`): `Mailbox.send` keeps the message and, with
a relay, starts `SmtpRelay.deliver` (tracked in `mailbox.pending`, awaited by `flush()` and `close()`): `buildMime`
(multipart/related { multipart/alternative { text, html }, inline cid parts }, base64 bodies at 76 columns, RFC 2047
subject and names, `Message-ID` = the mailbox's) → `dataPayload` (CRLF, dot-stuffing, the final dot) → `smtpSend`
(220 → EHLO, HELO once on a 5xx → MAIL FROM → RCPT TO per recipient → DATA → 354 → payload → 250 → QUIT → 221; replies
read to their `NNN ` line; 10 s socket timeout); every outcome logged, never thrown.

## 6. Testing & acceptance (phase 1)

- Unit: core (parsing, errors with line numbers, normalisation, templating, schema, format versions), hooks
  (journal, rollback order, allow-list, destructive detection; sql against a real Postgres if `$RETAKE_TEST_PG` —
  `pnpm test:pg`: `scripts/test-pg.mjs` starts a throwaway `retake-pg-test-<hex>` container (label
  `retake.test=pg`) from the local `postgres:17-alpine` image (never pulled) on a loopback port Docker picks,
  with password auth (scram, what the connection-failure test needs), waits for a password-authenticated `SELECT 1`
  over TCP (the image's init server listens on no TCP socket), runs `packages/hooks/test/sql.test.ts` and removes that
  container by its exact name with its anonymous data volume (`docker rm -f -v`: the image declares a volume, which
  `--rm` does not drop when the container is removed by name) in `finally` and on SIGINT / SIGTERM; a labelled
  container a killed run left is listed with its `docker rm -f -v`, never removed; `--all` runs the whole suite with Postgres, Docker and slow tests on).
- Integration (L1.4, `packages/cli/test/catalogue-acceptance.test.ts`, gated by `RETAKE_TEST_SLOW=1` —
  `pnpm test:slow`, ≈ 77 s): the fixture on free ports + the committed `catalogue` scenario (loaded through core, the
  `local` environment pointed at the fixture's ports in memory, its real hooks) headless at 1920×1080 with the debug
  cursor → capture.mp4 + timeline.json in a temp folder. Assertions: run succeeded, hooks ok / ok, the setup rollback
  replayed after the teardown (journal: nothing pending, the entry `rolled_back`), run.json and timeline.json
  schema-valid, scenes and marks, the run folder's files (log.jsonl ending with `run_end`); the two scroll steps last
  their set 1.5 / 2.2 s plus at most the 0.9 s wait for fresh frames (`awaitFreshFrame`); every frame and the video 1920×1080 at 30 fps, capture 55–80 s, video duration ≈
  timeline duration (± 0.2 s); **cursor sync** — with the `debug` cursor, the #FF00FF hotspot in the frame at each
  click's `t_click` (event-level clicks and every `data.clicks[]` entry but `outside`) is within 3 px of the recorded
  click point and inside the target bbox; **no hesitations** — gap between consecutive steps' t_end (hold end) and
  next t_start < 80 ms, the scene-opening still included; every popup-expecting click (New import, the select, menu
  and pick triggers) recorded `popup_opened`; no capture freeze while the cursor moves (the dialog-close ripple stall,
  R-ISS-12, is tolerated).
- Sandboxes (L1.8): unit (core manifest checks, hooks seed phase, the sandbox engine's state / lock / ports / health /
  identity, compose argv / parsing with a fake docker, the fixture's SMTP relay against an in-test SMTP server), the
  process provider for real on the fixture (default suite), and the docker-compose tests gated by
  `RETAKE_TEST_DOCKER=1` — `packages/sandbox/test/compose.test.ts` (the init scaffold with Postgres snapshots, a
  health stuck at `starting`, busy ports) and `packages/cli/test/sandbox-docker.test.ts` (the fixture's image built,
  a sign-up mail relayed to the real Mailpit and read with runner-web's `MailboxClient`, the PDF refused, reset empties
  Mailpit, `down --volumes`), plus another checkout sharing the project name and another container publishing the
  sandbox's port on [::1] (K2, K3). Their compose projects, containers and images are named
  `retake-test-<run token>-*` / `retake-test-fixture-<run token>-*` and swept after the run — that run's
  only, so two runs (another worktree) never remove each other's (containers, networks, volumes, the images they
  built; never base images, never `--rmi all`, never a prune).
