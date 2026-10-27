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
packages/sandbox      (L1.8) sandboxes: start / seed / reset / stop, process + docker-compose providers, Postgres snapshots, init (§3.8b)
packages/runner-web   Playwright/CDP runner: in-page kit (cursor overlay, resolver), actions, recorder, encoder, timeline
packages/editor       (phase 2) Remotion compositions + edit planner + render API
packages/review       (phase 2) contact sheets, key frames, report.json, diff vs previous render
packages/engine       (L3.1) the engine API the CLI and the MCP server share (§4b): workspace / project loading, reads,
                      if_match saves, local storage refs, EngineError, the run executor, the job queue and its worker
packages/mcp          (L3.1) MCP server over stdio (§4b) and Streamable HTTP (L4.1, §4c), SDK-free tool layer `callTool` (§4c)
packages/ui           (L4.1) the Studio web app and its server (`studio ui`, §4c)
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

// schemas (draft 2020-12 JSON Schema objects, also written to packages/core/schema/*.json by `pnpm -F @demo-studio/core gen:schema`)
scenarioJsonSchema(): object; projectJsonSchema(): object; templateJsonSchema(): object; timelineJsonSchema(): object

// misc
newRunId(scenario: string, date?: Date): string     // "20261011-142233-catalogue"
readJson<T>(file): Promise<T>; writeJson(file, value): Promise<void>  // atomic write (tmp + rename)
formatIssues(issues: ValidationIssue[], file?: string): string       // "file:12:5 error scenes[1].steps[3].click: …"
class ScenarioError extends Error { issues: ValidationIssue[] }

// file formats (R-PRIN-13, L1.4; formats.ts)
DEMO_STUDIO_VERSION: string                          // the package version (`studio --version`, run.json engine)
FORMAT_VERSIONS: { scenario: 1, project: 1, template: 1, workspace: 1, run: 1 }
newerFormatMessage(value, { file, supported }): string | undefined   // "this project.yaml is version 2: it was made
                                                                     //  for a newer Demo Studio (this one reads version 1) — update Demo Studio"
newerRunMessage(runDir): string | undefined          // the same for runs/<id>/run.json (render, plan, export-capture refuse it)
checkYamlDocument(text, schema, semantic?, empty?, { formatVersion?: { file, supported } }): CheckedDocument
```

**File format versions** (R-PRIN-13, L1.4). Scenarios, project.yaml, template.yaml, studio.yaml and run.json take an
optional top-level `version: 1` (`fileVersion()` in schemas/primitives.ts: `z.literal(1).optional()`; absent = 1);
sandbox.yaml, timeline.json, the hooks journals, render / review records and raw manifests require theirs. Before the
schema, `checkYamlDocument` with `formatVersion` (`parseScenario`, `validateScenario`, `parseProjectYaml`,
`parseTemplateYaml`, `loadWorkspaceConfig`, `parseSandboxYaml`) refuses an integer `version` above the supported one
with one positioned error at the key — no unknown-key errors for the newer format's keys; `0`, `"1"` or `1.5` stay
plain schema errors. `parseTemplateYaml` drops `version` before merging the file over the defaults (it is the file's,
not a template section). Writers: `createProject` (first key), the runner (`RunRecord.version`, first key); the
starter templates and the fixture's files carry it. Hook files (top-level lists) have none. `findRun` (render,
export-capture), `studio plan`'s own `resolveRun` and `exportCapture` refuse a run whose run.json is newer; a run.json without `version` (before L1.4)
reads as 1. No migration: Demo Studio never rewrites a user's file (a `studio migrate` is BL-70).

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

## 2. @demo-studio/hooks

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

## 3. @demo-studio/runner-web

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
  : Promise<{persona, check, profileDir?, snapshot?, cookies, origins, url, alreadySignedIn?, kept?}>   // `studio login` (§3.6)
checkSavedSession({project, env, persona, signal?}): Promise<PersonaCheckResult>   // a saved session checked as a run sees it
```

### 3.1 Browser
- `chromium.launchPersistentContext(profileDir, { headless: true, channel: 'chromium' /* new headless */,
  viewport: { width, height }, deviceScaleFactor: scale, locale, timezoneId, colorScheme })`.
  `locale` (navigator.language, Accept-Language, Intl) = `browser.locale`, else the project `locale`, else the
  studio.yaml `browser.locale` default (`projectBrowser(project)`).
  Without personas (§3.6): one context on a fresh temp profile. With personas: one context per persona the run films
  ("realms", each its own Chromium process and cookie jar) on a per-run copy of its session, plus the default context
  when some page has no persona. Executable: config → `$DEMO_STUDIO_CHROMIUM` → Playwright default.
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
`run.json` (RunRecord, updated live; `version: 1` and, L1.4, `engine: {demo_studio, node, chromium?, os, fonts?:
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
  No path in project.yaml: core `personaPaths(studioHome(), project, env, persona)` →
  `profiles/<project>/<env>/<persona>/` (the master Chromium profile, written only by `studio login`),
  `sessions/<project>/<env>/<persona>.json` (snapshot: Playwright storage state + `demo_studio: {version, project,
  env, persona, machine, created_at, how}`) and `….status.json` (`{version, status: valid|expired|error, checked_at,
  by: preflight|login|auth-status|run, run?, at?, detail?}`; "never" is not stored). `loginCommand` adds `--persona`
  whenever one is given: callers leave it out for the legacy persona (keyed on `legacy`, never on the name `default`).
  `studioHome()` = `$DEMO_STUDIO_HOME` else `~/.demo-studio`. The legacy `auth.profile` / `storage_state` (validation
  warning: a path of one computer; never mixed with `personas`) is the implicit persona `default` on every page, its
  paths as written.
- **Binding** (core `planPersonas`, pure; the validation, the runner and the CLI share it): a page id's persona is
  fixed the first time it is filmed — `persona` of the single-page scene or of `pages.<id>` (`none` = no persona),
  else the persona whose `pages` list its environment page (a multi-page page's environment page: `page`, the `open`
  prefix, the origin of an absolute `open`), else the legacy `default`, else none; `new_tab` inherits its page's (a
  tab of a `persona: none` page is in `none` too), `switch_page: previous` follows the walk's page history (pages
  closed by `close_current` aside); `persona: none` written later on a page bound without one adds it to `none`; js
  hook tabs (when hooks run) take the persona their key is filmed with (`none` included), else their key's default —
  `studio hooks run <scenario>:setup|teardown` binds them with the same plan. Another persona later for the same id is
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
  `$TMPDIR/demo-studio-session-<run>-<persona>-*` (0700), removed when the session closes or a launch fails
  (`BrowserSession.open` launches every realm at once and closes them all when one fails); a master path that is a
  symbolic link is copied from its target. Each copy (and `studio login`'s temp profile) is registered in the process:
  `removeSessionCopiesSync()` removes them at once — a run's second SIGINT / SIGTERM does before killing the process;
  the CLI can call it. `sweepStaleSessionCopies()` (at every `prepareSessions`; exported) removes the
  `demo-studio-session-*` / `demo-studio-login-*` / `demo-studio-profile-*` (a browser's throwaway profile, where a
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
  for run X"). Any persona not valid → `PreflightError` listing each one with `sign in again|once: studio login
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
- **`studio login`** (`signIn`, runner `login.ts`): refuses a master a live browser holds; signs in on the master (a
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
- **CLI side.** `studio auth status` reads, without a browser, each persona's master (non-empty), snapshot, lock and
  status file: `never` (neither), `unchecked` (no status file), else the stored status; `--check` runs
  `checkSavedSession` one persona after the other and writes `by: auth-status` — a persona whose master a browser
  holds is not checked (`error`, `not checked`, no time or origin of an older check; "close that browser first"). The
  legacy `auth.storage_state` form has no `command` (`studio login` refuses it) but a `fix`: export the file again.
  `studio doctor --project` shows the same per persona plus the studio home's git placement (walk up for `.git`, then
  `git -C <root> check-ignore -q <rel>[/]`: ignored = OK). CLI js hooks (`studio hooks run`, `hooks rollback`, `env
  reset`) open one browser per persona of their page key, on a `prepareSessions` copy (`failure`: the first line of a
  failure that is not a run's), with the hook tab's sign-in landing check. `studio new` on a terminal (`Io.ask` /
  `Io.confirm`; `memoryIo({answers})` scripts them) checks the slug, folder and template first (core
  `checkNewProject`), asks environments, then per environment a sign-in page and personas (name, pages — none when
  every page has a persona already —, a signed-in text → `check: {url: "<first page>:/", expect_text}`), writes them
  with `createProject({auth})`, re-opens the project with the workspace's browser settings and offers `signIn`
  (headed) for each (no answer: that one and the next ones later). Messages print `studio -C <root> …` when `--root`
  was given (`RunOptions.loginCommand`; doctor's hints too). **Interrupts** (`interrupt.ts` `onInterrupt`): `studio
  login`, `auth status --check`, the sign-ins of `studio new` and the js hooks of the hook commands handle SIGINT /
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
- **Hooks of other kinds** (any run, `@demo-studio/hooks` runOne): a hook that writes and whose `PreparedHook.hosts`
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
  `Symbol.for('demo-studio.clock')` with the real `Date`. The time is `epoch + (realNow − since)` (or `epoch` frozen):
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
- **Manifest.** `SandboxFileSchema` (JSON Schema `sandbox.schema.json`, `studio schema sandbox`): `version: 1`
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
  the run's preflight and `studio login` — and the preflight logs its automatic sign-in as info; `studio auth status`
  marks them `sandbox: true` (shown `auto`, never a `studio login` hint, never a `--check` failure). `allowedHosts`
  adds the loopback hosts of every sandbox's mailbox and databases (`db.localhost`, `127.0.0.2`: validated, refused
  at run time otherwise). Editor and review read `environments` / `environment_settings`; their advice for a page
  without a display URL names the sandbox.yaml (`services.<service>.pages.<page>`) on a sandbox environment.
- **Hooks.** `HookPhase` `seed`: preflight like setup (a js step refuses the whole seed, `SEED_NO_JS`), stop at the
  first non-optional failure, nothing rolled back, no destructive confirmation; journals accept the phase.
  `HookContext.baseDir` (default the project dir): sql files, shell `cwd` and the psql-file destructive check.
  `HookContext.signal` aborts a running shell hook (SIGTERM to its group, SIGKILL 2 s later) and stops the list;
  `HookContext.running` holds the groups of the shell commands running now (a second Ctrl-C kills them). A shell
  command on a sandbox environment gets the templated `env` of its process services and `DEMO_STUDIO_SANDBOX` over the
  CLI's environment (its own `env` wins; two services differing on a variable: an error) — a seed's `npm run
  db:reset` reaches the sandbox's database. A sql hook on a sandbox refuses a URL that pg would connect elsewhere
  (`sandboxDatabaseProblem`: pg's own parser vs the URL's host and port, a unix socket, a non-loopback host).
  `HookContext.connectAddress(host, port)` (a docker-compose sandbox's seed): the address its sql steps connect to
  instead of the URL's host name (the URL's host rewritten) — the one Docker publishes the port on.
  `JournalEntry.superseded {at, by}` (not pending any more): `Journal.supersede(env, by)` /
  `supersedePendingJournals(projectDir, env, by)` — called after a sandbox reset so `studio env reset` never replays a
  rollback on reseeded data.
- **Seed hash.** `seedHash(sandbox, extra?)`: sha256 of the canonical seed, strategy, snapshot settings and databases,
  the bytes of `seedFileRefs` (sql step files + every file of `seed/` next to the manifest) and `extra` (image ids…).
- **Run records.** `RunRecord.environment.sandbox` / `TimelineEnvironment.sandbox` (`RunSandbox {name, provider,
  strategy?, restored?, reset_ms?, seed_hash?, at?}`, kept by the redaction policies) — filled by `run --sandbox`.

### 3.8b Sandbox engine (L1.8): `@demo-studio/sandbox` (deps: core, hooks, pg)
- **API** (the CLI's and L3.1's MCP tools'): `openSandbox(project, env?)` → `Sandbox {env, sandbox, paths, kind,
  strategy}` with `up({seed: 'auto'|'never', build?, signal, log})` → `{started, kept, changed, ms, reset?}`,
  `down({volumes?})` → `{stopped, dataGone}`, `reset({by, reseed?})` → `ResetResult {strategy, restored, ms, hash, at,
  seed: {steps, ms}, mailbox, snapshot?: {action: restored|taken, ms, database}, restarted, superseded}`, `status()` →
  `SandboxStatus {state: up|partial|down, services: ServiceStatus[] (pid or container + docker status), seed?
  {hash(12), current}, last_reset?, lock?, logs, notes}` (no lock, nothing written), `logs({service, lines})` →
  `{service, file | source, exists, text}[]`, `followLogs({service, lines, signal, write})` (docker-compose),
  `checkRunning()` (a run without --sandbox: SandboxError `down` unless every service runs and is healthy; returns a
  live lock), `prepareTake({command, signal, log})` → `Take {info: RunSandbox, up, reset, note(run), release()}`,
  `killStartedSync()`; `initSandbox(project, {env, force, basePort})` (`studio sandbox init`). Errors: `SandboxError
  {code: busy|down|port|unhealthy|seed|interrupted|failed}`. `providerFor(sandbox)`: a fresh `ProcessProvider` or
  `ComposeProvider` per call. Provider (provider.ts): `up(ctx, {build})`, `down(ctx, {volumes})`, `status`, `restart`,
  `exec?`, `stopStarted`, `killStartedSync`, `logFiles`, `servedBy(ctx, port, use)` (the service of the sandbox
  serving a port, nothing else listening: process — a port a process service names and its own tree listens on;
  docker-compose — `publishedBy`), and for docker-compose `logs?`, `followLogs?`, `publishedBy?(ctx, port, use?)` (the
  service of the sandbox's own project publishing a port: a snapshot's database by default), `address?(ctx, port)`
  (where to connect to a port its own containers publish: 127.0.0.1 / ::1) and `hashInputs?` (the services' image
  ids: part of the seed hash).
- **Files** (`<project>/.demo-studio/sandbox/<env>/`, git-ignored): `state.json` (version 1, written synchronously and
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
  `TEST`, + the templated `env` + `DEMO_STUDIO_SANDBOX`. Identity (`identify(pid, startedAt, {boot, members,
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
- **docker-compose provider** (`compose.ts`, `docker.ts`). Docker: `$DEMO_STUDIO_DOCKER`, PATH, then the usual install
  places (`dockerPlaces`: Docker Desktop, OrbStack's bin and xbin, Homebrew, /usr/bin — doctor looks there too);
  `compose version --short` ≥ 2.17 and `info --format {{.ServerVersion}}` (the daemon) checked once per call;
  every call runs with the CLI's env minus `COMPOSE_*`, output captured, killed on abort. Project ref: `compose.project`
  or `demo-studio-<slug>-<env>-<sha256(realpath(folder))[0:8]>` (≤ 63, sanitised), `--project-directory` = the real
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
  `exec`: `exec -T -e DEMO_STUDIO_EXEC [-e NAME…] <svc> sh -c <cmd> | argv` (values in docker's env;
  DEMO_STUDIO_EXEC=<random token> marks every process it starts), command/env templated (pages, vars, secrets), the
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
  `demo-studio snapshot <hash>` → `restore(owner)` (ALTER … ALLOW_CONNECTIONS false, DROP … IF EXISTS … WITH (FORCE),
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

What `page_inspect` and `studio inspect` (job, MCP tool, CLI: L3.3 part 2) run in the worker. The tool makes no model
call: the inspection hands Claude page facts and verified targets; Claude writes the scenario.

- **Run path.** `runScenario({mode: 'dry', inspect: {within?, targets?, limit?, budgetMs?, onResult}, runsDir, runId})`
  — exactly `run_dry` semantics: the environment's own access (a production environment stays read-only, no extra
  write guard), personas on session copies with the off-camera preflight (an automated sign-in refreshes the persona's
  stored session in `DEMO_STUDIO_HOME`, as any run), the sign-in guard, the product clock, agent trust with `hookTrust:
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
  replay with `hookTrust: 'mcp'` (agent trust in the runner) and `checkSandboxEnv`. The folder `<project>/.demo-studio/
  inspect/<id>/` is made at submit (removed if the enqueue fails); `pruneInspections` keeps the newest 20 (ids sort by
  creation; the new one and those of queued / running inspect jobs are never removed). `runInspection` (shared with the CLI) → `runScenario` with `runsDir` =
  `inspect/`, `runId` = the id, then `drawMarks` through the engine's lazy `review()` import when the report is `ok`
  and images are `marked`. Result (`InspectJobResult`): ids, folder, `reported`, status, at, page key, persona, the
  replay's run status, file paths, counts, replay — no page text outside `untrusted: {error?, warnings}`. No report
  (preflight, sign-in landing, a refused scenario): the job succeeds with `reported: false`, the run's error under
  `untrusted.error`, and `sign_in: {env, persona}` when the runner asked for a persona's sign-in command (its
  `loginCommand` callback is called only to word that fix). A cancel → job `cancelled`; an interrupted one's fix is the
  `studio inspect` command. History: kind `inspect`, `inspect: {id, source, status, reported}`, counts nothing.
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
- **CLI** `studio inspect <project> <page|url|scenario> [--path] [--until] [--persona] [--env] [--within T] [--target
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
may start a recording, never drive it. Nothing is filmed.
- **runner** `recordSession({project, env, persona?, url, allowWrites?, eventsFile?, maxMs?, stop?, signal?, drive?,
  headless?, windowSize?})` → `{events, stop: closed | stopped | max_duration, ms, window, capture, access, persona,
  counts {events, actions, writes, redacted, dropped {sign_in, frame, invalid, new_page}}, warnings}` (warnings never
  quote page text). The window: `launchPersistentContext` on a COPY of the persona's profile (`prepareSessions`; a
  snapshot / signed-out persona: a fresh `demo-studio-session-record-*` profile), its snapshot applied, `Preferences`
  with the password manager and autofill off (`disableAutofill`), `viewport: null` at the window's real size
  (`--start-maximized`; no `--hide-scrollbars`; a window narrower than `capture.width` is warned — the check replay runs
  at the capture size), Ctrl-C / SIGTERM left to the caller. The environment's access as in a run
  (`resolveRunAccess`, `compileWritePolicy`): a read-only environment arms the write guard (writes stopped / mocked,
  each one a `write` event); a read-write one lists every write request to its pages' origins (`passed`). Ends when the
  last page closes (`closed`), on `stop` (the pending typing committed through `__dsrecFlush`, then the window closes:
  `stopped`) or after `maxMs` (default `RECORD_MAX_MS` 30 min: `max_duration`); `signal` closes the window, removes the
  events file and throws a CancelledError. `drive` / `headless` play the person in tests (Playwright input is trusted).
- **isolated world** (no `exposeBinding`): one CDP session on the window's page — `Page.enable`, `Runtime.enable`,
  `Runtime.addBinding({name: random, executionContextName: 'demo-studio-record'})`,
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
  input_type, name, text, label, placeholder, testid, href_path, in_view, state, appeared, secret, desc?) and
  `RecordedEventSchema` (pointer, dblclick, type, select_native, file, key, scroll, navigation, new_page, write,
  dropped, stop; strict objects; a secret `type` without `text`, a plain one with it; a path without `?` / `#`; a
  printable key only with Control / Meta).
- **kit 1.5.0**: `passive` config (the recorder's copy: no overlay, no listener, no patched API); `suggestFor(el | ref,
  {budget_ms})` = `inventory({within, limit: 1})` on the element, else its label's control, a hidden file input's label,
  or its nearest interactive ancestors (≤ 4 tries) — null when nothing interactive holds it; `secretField`. Measured: a
  press on the lab costs 1–4 ms in the page; on `/inspect-lab?rows=5000` (≈ 10,000 controls) ≈ 210 ms, the budget spent
  (description fallback).

### 3.12 Recording: draft, engine, CLI (L3.4 part 2; core `draftFromRecording`, engine `record.ts`, `studio record`)

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
  never quote page text or a typed value.
- **engine** `recordScenario(ws, project, {env?, persona?, page?, path?, url?, name?, allowWrites?, check?, agent?,
  submittedBy?}, ports)` → `RecordOutcome {rec_id, dir, draft, name, saved, not_saved?, env, persona, access, stop, ms,
  window, capture, counts, stats, scenes [{id, steps, opens}], issues, warnings, writes {total, by_steps, ambient,
  first}, check}`. `recordStart`: the page (default the persona's first page, else the environment's first), `path`
  (`inspectPathProblem`), or a `url` on an environment origin (`pageOfUrl`); the persona (`none`, a name, else the page's
  default). Linux without a display (and no test `drive`) → `unavailable`. Preflight: `checkSavedSession`; not valid →
  the persona's `login:` steps (`signIn` auto, headless), else `refused` with the `studio login` command as `fix`.
  `DEMO_STUDIO_RECORD_MAX_MIN` (minutes, (0, 1440]) → `maxMs`. The draft is validated with the project
  (`parseScenario` with its vars, pages and personas) before it is saved or checked: an error is an `invalid` issue; a
  save that fails is a `not_saved` error issue with a fixed message (the log line too: never the error's text). Folder `<project>/.demo-studio/records/<rec_id>/` (0700,
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
- **CLI** `studio record <project> [name] [--env] [--persona] [--page] [--path | --url] [--allow-writes] [--no-check]
  [--json]`: in-process (the primary path), a status line counting actions, Ctrl-C = stop and keep (from the check on,
  the run's own handler stops the check), then the summary (actions, scenes, issues as `scene.step: …`, writes with
  reset advice, saved file, check, draft path, the next `run --dry`); `--json` the outcome. Exit 1 when nothing was
  recorded, the draft is invalid or the check failed. `--allow-writes` as `studio run` (usage error on a read-only
  environment).

### 3.13 Recording: job and MCP (L3.4 part 3; core `RecordJobInputSchema`, engine `jobs/record-job.ts`, MCP `scenario_record`)

- **Job input** (`kind: record`): `{project, rec_id (reserved at submit, RECORD_ID_RE), env?, source: {page, path},
  persona?, scenario?, check: boolean, submitted_by}` — strict: no step, URL, typed text or write flag exists in it, so
  nothing in a job can drive the window. `submitRecordJob`: slugs, no `{{…}}` in page / path / url / persona,
  `recordStart` (page key, path, a URL on an environment origin → page + path, persona), the workspace's protected
  hosts (`checkWorkspaceProtection`), Linux without a display → `unavailable` with the `studio record` command as `fix`;
  warnings (a taken name: the draft is kept only; a read-only environment: writes stopped or mocked).
- **Execution** (`executeRecordJob`): the checks again, `checkSandboxEnv`, then `recordScenario(…, {id: rec_id, agent:
  true, submittedBy}, {hookTrust: 'mcp', stop, skipCheck: () => stop.aborted, signal, history: false})`. Two signals:
  the worker's SIGINT / SIGTERM aborts the job's `stop` controller (not its cancel controller) — the window closes, the
  draft is made and saved, the check replay is skipped (`reason: stopped`), the job succeeds and the worker exits;
  `job_cancel` (the cancel marker) aborts `signal` — while the window is open the recording is discarded (folder
  removed, job `cancelled`), after it only the check replay stops. Progress: `phase` = preflight / `recording · N
  actions` / draft / check with steps; events carry counts and fixed messages only (a log line when the window opens).
  The worker's history line (`record {id, steps, saved}`, counts nothing) replaces recordScenario's own. A `record` job
  holds the queue while its window is open (one job at a time, as a headed `auth_login`). Interrupted: by its last
  progress phase — `check`: the draft was made (`.demo-studio/records/<rec_id>/draft.yaml`, saved under scenarios/ when
  its name was free), only the check was cut; `draft`: the draft was being made (that file if it was written);
  otherwise "no draft was made" — `fix` = `studio record …`. `pruneRecords(project, keep, except, root)` never removes the folder of a queued or
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

### 3.14 Themes from brand files (L3.5 part 1; core `brand.ts`, components `brand/`, engine `brand/`, MCP `template_create_from_brand`, `studio theme create`)
The contract (input schema, palette formulas and thresholds, template.yaml generation, file checks, naming, replace
and provenance) is DESIGN-phase2.md §1.10. Surfaces: `engine.templates.create(input)` (trust `mcp`, feature
`templates.create`); MCP `template_create_from_brand` (WRITE_FILES annotations; 40 tools, 41 with `template_from_site` — DESIGN-phase2 §1.11) — input = `BrandInputSchema`,
summary: folder, colours, every contrast ratio and change, the suggested accent, fonts, warnings and the next step
(`template_preview {project, template}`), data = `ThemeCreated` with the font files' name strings under
`untrusted.fonts`; `studio theme create <name> --accent --logo …` calls `createThemeFromBrand` with trust `author`
(any local file, relative to the cwd). Synchronous: no browser, no job (file reads ≤ 25 MB).

## 4. CLI (`studio`)

```
studio new <slug> [--name N] [--template T] [--env name=key:url,...]   # on a terminal without --env: asks (personas too)
studio list                                   # projects
studio validate <project> <scenario|file>     # exit 1 on errors; prints file:line:col messages
studio run <project> <scenario> [--dry] [--until REF] [--hooks run|skip] [--env E] [--headed] [--allow-writes] [--json] [--sandbox]
studio hooks run <project> <file.yaml|scenario:setup|scenario:teardown|reset> [--yes] [--allow-writes]
studio hooks rollback <project> [id] [--allow-writes]   # replay pending rollback journals (run id or journal id)
studio env reset <project> [--allow-writes]   # project.reset hooks + pending journals
studio sandbox init <project> [--env E] [--force] [--json]                                  # §3.8b scaffold
studio sandbox up|down|reset|status|logs <project> [--env E] [--no-seed] [--build] [--volumes] [--reseed] [--json] [service] [--lines N] [--follow]   # §3.8b
studio schema [scenario|project|template|timeline|sandbox]  # print JSON Schema
studio login <project> [--env E] [--persona P] [--auto] [--page KEY] [--url URL]   # sign a persona in (§3.6)
studio auth status [--project P [--env E]] [--check] [--json]   # personas: valid / expired / never / unchecked / error
                                                                # (a sandbox account never signed in: auto)
studio doctor [--project P] [--json]          # OK/WARN/FAIL per check (Node, Chromium launch, ffmpeg/ffprobe, display,
                                              # keychain, notifications, workspace, template fonts; project personas
                                              # (never / expired / in use / in a git work tree), session home + hosts;
                                              # MCP: registered Node path, PATH finds ffmpeg, worker, .demo-studio/ ignored)
studio render / review / export               # phase 2
studio mcp [--print-config]                   # §4b: MCP server over stdio (or its registration for Claude Code / desktop)
studio mcp --http [--port N] [--rotate-token] [--json]   # §4c: the same server over HTTP on 127.0.0.1 (--print-config --http)
studio ui [--port N] [--no-open] [--json]     # §4c: the Studio web app on 127.0.0.1 until Ctrl-C; one server per workspace
studio jobs [list] [--project P] [--state S]… [--limit N] [--json] | status <id> [--json] | cancel <id>   # §4b jobs
```
`--json` prints RunProgress events as JSON lines (machine-readable; used by the MCP job runner).
`--allow-writes` (L1.7) confirms writes on a production environment whose project.yaml sets `access: read-write`; on a
read-only environment it is a usage error (exit 2). The run header and the hooks commands' header say `production`,
`read-only` / `writes allowed` and the clock (`clock 2026-11-02T10:24:00 Europe/Paris (frozen)`); the notice / warning
of core `RunAccess` is printed once. The run summary
of a read-only run counts its writes (`writes  1 mocked, 0 stopped (read-only)`, + allowed / to unguarded hosts;
`writesSummary`; a read-write run's writes stopped on another environment's hosts: `1 stopped (hosts of read-only
environments)`), and `studio review` / `render --review` print the review's environment line.

## 4b. Engine API and MCP server (L3.1)

**`@demo-studio/engine`** (deps: core, hooks, runner-web, sandbox). One typed, in-process API over a workspace. The CLI calls
the moved functions directly with its native options, errors and exit codes; `EngineError` exists only at the
boundary of clients outside the CLI (the MCP server; the jobs worker and the HTTP API later).

```ts
openWorkspace({root?}) / openProject(ws, slugOrDir)   // moved from cli/src/workspace.ts (the CLI re-exports them)
personaState / projectPersonaStates / tildePath       // moved from cli commands/auth.ts (`--check` stays in the CLI: Chromium)
createEngine({root?, client: 'cli'|'mcp'|'test'|'ui'}): Promise<Engine>   // agentTrust(client): every client but cli / test (§4c)
Engine {
  root, workspace, cli /* `studio -C <root>`: commands a human is asked to run */, info(): EngineInfo
  projects: list() → ProjectSummary[]; get(slug) → ProjectView; create({name, slug?, readme?, environments?, template?});
            updateReadme(slug, markdown, ifMatch?)
  scenarios: get(slug, name) → {name, file (ref), path, yaml, hash}; validate(slug, yaml, {env?, until?, name?}) →
             {ok, issues (line/col)}; save(slug, name, yaml, {ifMatch?}) → {file, path, hash (of the bytes written), created, warnings}
  runs: list(slug, {scenario?, mode?, limit = 20}) → RunSummary[] (newest first);
        status(slug, runId) → RunStatusWithJob (run.json + the state of its job overlaid; `list` overlays it too:
        a queued run whose job was cancelled before any worker took it is `cancelled`, one whose worker died `interrupted`);
        submit({project, scenario, mode: 'dry'|'capture', env?, until?, hooks?, sandbox?}, {approver?}) → {job, run_id, warnings, worker?};
        cancel(slug, runId) → JobRecord (refused for a run without a job: a `studio run` in a terminal)
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
- **Errors.** `EngineError {code, message, fix?, details?}`, codes `not_found | invalid | conflict | refused |
  needs_approval | busy | unavailable | cancelled | internal`; `toEngineError(e)` maps the other packages' errors by
  name in one place (ScenarioError / ConfigError → not_found or invalid, AccessError / HookSecurityError /
  WriteRefusedError / HostRefusedError → refused, SandboxError busy / down / interrupted → busy / unavailable /
  cancelled, CancelledError → cancelled, anything else → internal).

**Runs: one executor** (`execute-run.ts`, moved from `cli/commands/run.ts`). `prepareRun(ws, project, scenario,
{dry, until, hooks, env, headed, sandbox})` (the sandbox pick from the scenario's raw `env:`, the scenario validated
against the environment it runs on, the template; `RunOptionError` = a CLI usage error) and `executeRun(prepared, req,
{runId?, allowWrites?, hideCursor?, signal?, loginCommand?}, ports)` (the scenario's warnings and notes, the sandbox
take or check, `runScenario`) are what `studio run` and the worker both call. `RunPorts {issues, note, sandboxLog,
progress, interrupts}` carry what the CLI prints, in the same order as before; `interrupts: InterruptPort` replaces the
CLI's direct `onInterrupt` for the sandbox take (`open({message, onQuitSync}) → {signal, interrupted, dispose}`; the
CLI's implementation is `onInterrupt`, the worker's the job's AbortSignal plus its signal rule). `checkAllowWrites`
throws `AccessError` (the CLI turns it into its usage error), a failed take `SandboxTakeError` (`interrupted` → exit
130). `studio run`'s output, errors and exit codes are unchanged (a cancelled run still exits 1).

**Jobs** (R-ARC-02; `jobs/`). Input contract in core (`jobs.ts`, `JobInputSchema`, version 1): a `run` job is
`{version, kind: 'run', project (slug), scenario (name), scenario_sha256 (of the file's bytes at submit), mode,
env?, until?, hooks?, sandbox?, run_id (reserved), submitted_by}` — strict (no other key), never a secret, a session or
a path. Files under `<workspace>/.demo-studio/` (git-ignored):

```
jobs/<id>/job.json      the record: written once by the submitter (queued), then only by the worker that claimed it
jobs/<id>/claim         {pid, started_at, at} — created O_EXCL: the atomic claim
jobs/<id>/cancel        {at, by} — created O_EXCL by a cancel (run_cancel / job_cancel); the worker polls it (250 ms)
jobs/<id>/events.jsonl  appended by the claiming worker: state changes, the runner's (redacted) progress, logs, the result
workers/worker.lock     {pid, started_at, host, version, build, since} — one worker per workspace (concurrency 1)
workers/worker.log      what workers print (stderr), appended
```

- Ids: `j_` + a ULID (sortable). States `queued → running → succeeded | failed | cancelled`, and `interrupted`.
  Readers never write: a `running` job whose worker is gone (pid + `ps` start time, sandbox proc.ts) is derived
  `interrupted` (fix: `studio env reset <project>`); a `queued` job with a cancel marker and no claim is derived
  `cancelled`. The next worker persists those (it holds the lock). run.json is never rewritten for `interrupted`: the
  run status overlays it.
- `succeeded` = ran to the end (the run's own status is `result.status`); `failed` = could not run (EngineError code
  and message: the scenario's bytes changed since submit → `conflict`, a sandbox take failed…).
- Submit (`submitRunJob`): names checked, `prepareRun`, the hooks the run executes checked and approved (below), the
  scenario hashed, `reserveRunId` (core; the runner uses it too) and a `queued` run.json written, the input queued; the
  MCP engine then calls `ensureWorker`. Early exits never leave run.json `queued`: the worker closes a reserved run as
  `cancelled` (cancelled before it started) or `failed` (it could not start).
- `hooks` / `env_reset` jobs (`jobs/hooks-job.ts`): `{version, kind: 'hooks', project, source (core HOOKS_SOURCE_RE:
  reset | <scenario>:setup|teardown | hooks/<name>.yaml — a file's real path must be inside the project), env?, dry,
  journal_id (reserved: `<stamp>-hooks-<label>`), submitted_by, approvals?}` and `{…, kind: 'env_reset', env?, dry,
  journal_id (`<stamp>-env-reset`)}`. The executors are `studio hooks run` / `studio env reset` on the engine's
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
  `studio` command); the hooks that need a human (from the dry run, else from the file alone) go to the client's
  `Approver` once (`ApprovalRequest {what, project, env {name, production, access}, items [{fingerprint, phase, index,
  name, kind, description (templated), reason}], fix}`). No approver → `needs_approval`; declined / cancelled /
  timeout / error → `refused`; accepted → `input.approvals = [{fingerprint, by: 'human-elicitation', at}]`, written once
  with the job. `fingerprint` = hooks `hookFingerprint(hook, {phase, index, env})`: sha256 of canonical JSON (sorted
  keys) of the **raw** hook as its file declares it, its phase, position and environment — templates unresolved, so
  `{{run.id}}` and saved responses do not differ between preflight and run. The worker's `confirmDestructive` is
  `approvalChecker(input.approvals)`: a hook that needs a human runs only when its fingerprint is listed (a changed or
  moved hook is refused). With trust `mcp` a dry run never calls the approver: its results carry `approval {reason,
  fingerprint}`. The CLI (trust `author`) is unchanged: `confirm: true`, `--yes` / the prompt, `writes: false`.
  *Rollbacks* (L3.1 review): a setup hook whose rollback is destructive (HTTP DELETE, destructive SQL inline or in its
  file) or is a shell command or JavaScript needs the approval too (its rollback runs later — a failure, a cancel, an
  environment reset — without asking again); the item's `description` ends with `; rollback: <templated rollback>`
  (also `rollback`), and its reason with `its rollback: …` (core `rollbackApprovalReason`, hooks `PreparedHook.rollback`).
  *Files*: the fingerprint also folds `files` — ref → sha256 of each project file the hook references (hooks
  `hookFiles`: its sql / js file and its rollback's, and every relative word of its shell command that names an
  existing file under its working directory: `./seed.sh`, `node scripts/x.mjs`, `psql -f reset.sql`): a script changed
  after the approval is refused. *Signed* (`jobs/signing.ts`): `FileJobQueue.enqueue` signs each approval —
  `sig` = HMAC-SHA256 over the canonical job input (without its approvals) and the approval, with the key
  `<DEMO_STUDIO_HOME>/approvals.key` (32 random bytes in hex, 0600 in a 0700 folder, created on the first approval);
  the worker keeps only approvals whose signature verifies (`verifiedApprovals`; the others are dropped with a `warn`
  event, their hooks refused), so a job.json written by anything but a submit carries no approval. Whoever can read
  the studio home can sign: it guards against a forged job file, not against a process running as the user with access
  to `~/.demo-studio` (which holds the sessions too).
- **What work submitted through MCP may reference** (core `agent-trust.ts`; the agent writes scenarios, README.md and
  new projects, and reads what runs return). Checked at `scenario_validate` / `scenario_save` (as errors), at submit
  (`checkAgentTrust`: `refused` with the `studio` command) and again where it runs (the runner with `hookTrust: 'mcp'`
  before anything opens; the hooks executor; the step and the hook that read a file):
  - *Secrets*: no `{{env:…}}` / `{{keychain:…}}` anywhere in the scenario (steps, hooks, vars) nor in a code file it
    runs (eval.file, a hook's sql / js file). Only project.yaml (personas' login steps, databases, mailbox, reset hooks)
    and the project's `hooks/` files — what a human wrote — resolve them. Masking catches a value as is, not a
    transformed one (base64): the reference itself is refused.
  - *Files*: drop_file.path, eval.file, a hook's sql / js file (and its rollback's) and the files its shell command
    names are relative, inside the project folder once symbolic links are followed (`projectFileProblem`: no absolute
    path, `~`, `..` out of it); a templated path is checked again when the step runs (runner `Runtime.agentTrust`).
  - *Code from agent-writable files*: eval.file, a hook's sql / js file and a script its shell command names are never
    README.md, `scenarios/`, `runs/`, `renders/`, `review/`, `exports/` or `.demo-studio/` (`AGENT_WRITABLE_PATHS`).
  - *Production across projects* (`protected-hosts.ts`): the protected hosts are the page hosts (host + port, loopback
    names folded) and `read_only.hosts` of every production or read-only environment of **every** project of the
    workspace. `project_create` refuses a page on one of another project's; a run, hooks or an environment reset on a
    read-write environment with a page on one is refused at submit and by the worker (`checkWorkspaceProtection`). A
    protected environment itself is not concerned (its own access applies); sandboxes neither.
- Worker (`runWorker`, entry `worker-main.ts`; `studio worker` (hidden) runs the same): takes `worker.lock` (a live
  holder: exit at once; a stale one is taken over under a breaker), claims the oldest queued job, checks its cancel
  marker right after the claim, runs it, writes its final state — a write that fails makes it exit 1, so readers see
  `interrupted` rather than a live `running`. Idle for `--idle-exit` (default 60 s): it releases the lock, looks at the
  queue once more (a job queued while a client saw it alive), then exits. It exits when `.demo-studio/` disappears,
  and, when idle, when its build changed (`buildStamp`: version + the mtimes of the modules of the engine and of every
  `@demo-studio/*` package it depends on at run time, transitively from the package.json files — core, hooks,
  runner-web, sandbox), handing over to a new worker if jobs wait. A job whose input version or kind it does not know
  (a newer client) is left to a worker of the new build when the code changed, else closed `failed` (`invalid`,
  "refused without running") — never parsed as another kind. Signals: the first SIGINT / SIGTERM stops claiming and aborts
  the running job (teardown and rollbacks run); a later one removes session copies, runs the take's `onQuitSync` and
  exits 130 on the next tick, after the runner's own second-signal handler has killed its shell hooks.
- `auth_login` / `sandbox_up` / `sandbox_reset` jobs (part D). `{…, kind: 'auth_login', env?, persona? (a name),
  mode: 'headed' | 'auto'}`: the executor is `studio login`'s (`loginTarget` + `signInPersona`, under the job's
  interrupt port): `headed` opens a visible window on the worker's machine and the job waits until the human closes
  it; `auto` plays the persona's `login:` steps. Its result (`AuthLoginJobResult`) is the check's status, `signed_in`,
  the `studio login` command, and the check's detail and URL under `untrusted` — never a profile or snapshot path, a
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
  the next worker records — appends a line to `<workspace>/.demo-studio/history.jsonl` (`{v, at, job, kind, project,
  submitted_by, state, ms, run?, counted: {captures, dry_runs, renders}}`, O_APPEND, best effort); `studio run`,
  `studio render` and `studio still` append theirs (no job), `studio export` one counting the formats it re-rendered
  (component previews are not counted). `engine.usage()` sums them; `entitlements()` is the parked licence hook.
- `studio jobs [list] | status <id> | cancel <id>` (CLI, `commands/jobs.ts`) reads the same queue through the engine
  (`client: 'cli'`, `autoStartWorker: false`: a worker started from a terminal would inherit the terminal's
  environment and run the jobs an MCP client queued): newest first with progress and outcome, one job's details, a
  cancel (a finished job: nothing to do; a queued one is cancelled at once, closed by the next worker). Malformed ids and states are usage errors (exit 2); an unknown job exits 1.
- `ensureWorker(root)` spawns `node <engine>/worker-main.js --root <ws>` detached (`--conditions=source --import
  <tsx loader>` + the `.ts` entry when the engine runs from its sources) unless the lock's holder is alive. The worker
  inherits the spawning server's environment and outlives it.

**`@demo-studio/mcp`** (deps: core, engine, `@modelcontextprotocol/sdk` pinned at exactly 1.32.1, zod).

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
  where the system ignores case), `DEMO_STUDIO_HOME` when set (absolute, through `studioHome`); the `mcpServers` JSON (stdout) and the `claude mcp add` line (stderr). L3.7: `pluginMarketplaceRoot` (the first
  folder above the entry point with `.claude-plugin/marketplace.json` and `skills/.claude-plugin/plugin.json`) and
  `pluginInstallCommands` (`claude plugin marketplace add <repo>`, then `cd <ws> && claude plugin install
  demo-studio@demo-studio --scope local --config node=… studio=… workspace=… [home=…]`, shell-quoted), printed as the
  alternative to `claude mcp add` when the marketplace is there. Serving, `studio mcp` sets its own `PATH` to
  `clientPath(process.execPath, PATH, …, root)` before the server starts (a plugin or GUI client may pass a bare PATH,
  a relative entry or a folder of the workspace, where the agent writes; the jobs worker inherits it). `engine_info`
  adds `started_in` (the server's cwd: Claude Code's session folder) and `started_outside_workspace`, said in its
  summary: the plugin's values are per user, not per folder (review M3).
- The plugin (L3.7, repository root): `.claude-plugin/marketplace.json` (marketplace `demo-studio`, one plugin, source
  `./skills`); `skills/.claude-plugin/plugin.json` (`demo-studio`, version = `DEMO_STUDIO_VERSION`, `skills: "./"`,
  userConfig `node` / `studio` (file) and `workspace` (directory), required, and `home` (directory, default `""`));
  `skills/.mcp.json` (`${user_config.node} ${user_config.studio} --root ${user_config.workspace} mcp`, env
  `DEMO_STUDIO_HOME=${user_config.home}`: an empty `home` replaces an inherited `DEMO_STUDIO_HOME` and `studioHome()`
  falls back to `~/.demo-studio`). Claude Code checks neither the paths nor that required values are set (a missing
  one: no server, the skills still load). `claude --plugin-dir skills` loads it as `demo-studio@inline`, with its own
  (empty) values. Tests: packages/mcp/test/plugin.test.ts (layout, print-config, quoting, PATH; a gated block runs
  `claude plugin validate` / `plugin details` / `mcp list` on a scratch `CLAUDE_CONFIG_DIR`).
- The skills (L3.7): `skills/demo-studio-{scenario,theme,component}/SKILL.md` (frontmatter `name` first, then
  `description`, nothing else; ≤ 200 lines; a "Before you start" block calling `engine_info`, the loop, "what good looks
  like", a Rules block with pinned sentences) and two references (`demo-studio-scenario/reference/scenario-language.md`,
  `demo-studio-component/reference/kit.md`). The lint `packages/mcp/test/skill-lint.ts` (`lintSkills(files, ctx)`, the
  context injected: tools with their input JSON Schemas and zod checks, the vocabulary, `ACTION_NAMES`, the kit's
  names, the CLI's help through `main`, the scenario validator under agent trust on a fixture copy, `parseManifest`,
  file existence, `checkComponentEntry` on a component folder) returns issues by rule (`frontmatter`, `size`, `tool`,
  `vocabulary`, `cli`, `link`, `orphan`, `yaml`, `code`, `actions`, `kit`, `hygiene`, `rules`, `coverage`);
  `unknownKeys(root, schema, value)` walks nested keys (`$ref`, `anyOf`, records through `additionalProperties`, arrays
  through `items`). After the review of L3.7: the CLI rule is absolute (pinned: never `studio`, `pnpm studio` or
  `node …/bin.js` through the shell, whoever asks); `LOOPHOLE` runs over the whole Rules block; the prose (code and
  pinned sentences blanked) refuses `DENY` phrases (curl, wget, download, password, "do what it says", "anyway"),
  "run … yourself", "run `studio …`" unless "never" or the user runs it, and a `studio …` command whose sentence does
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
  position, name, templated description with its target, reason) and the `studio` command; schema `{approve: boolean}`
  (required, default false). Only `accept` with `approve: true` approves. The timeout is explicit — 10 min
  (`DEMO_STUDIO_MCP_APPROVAL_TIMEOUT_MS`), since the SDK's default request timeout is 60 s; a timeout
  (`isTimeoutError`) or any failure refuses. A client without form elicitation gets no approver: `needs_approval`.

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
  `<studio home>/mcp-http.token` (part 3): created once (0600 temporary file, chmod, `link()` into place: two starts
  never write two tokens), replaced by `rotate` (0600 temporary file renamed over it); trusted only as a regular file of
  this user without group / other bits holding one token — anything else `refused`, never repaired silently.
- Discovery file `<workspace>/.demo-studio/ui.json` `{version: 1, kind: 'ui', pid, started_at, port, url, token, since}`:
  `claimDiscovery(file, record)` after the bind — a 0600 temporary file (chmod) hard-linked into place; on EEXIST a live
  holder (pid + start time) is returned for reuse, a stale or broken file replaced once; a state folder this user cannot
  write (EACCES / EPERM / EROFS) is `refused` with a fix; `readDiscovery` refuses a link, a non-regular file, another
  user's file or any group / other permission bit; `releaseDiscovery` removes only its own record (pid + token), a
  regular file of this user whatever its mode by then (a file made 0644 while serving does not outlive the server).

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

**MCP `callTool(t, engine, args, ctx) → {ok, output} | {ok: false, error: EngineError}`** — the zod parse (problems per
argument) and the handler, SDK-free; `protocolTool` and the Studio server both use it.

**`@demo-studio/ui`** (deps: core, engine, mcp, esbuild, react, react-dom; the MCP package never depends on it).
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
  0) and the own ops `run_pause`, `scenario_sessions`, `sign_in_cancel` (§4f); `run_dry` / `run_capture` and `scenario_save` stay out (critique B11; one Studio write path);
  `ToolDef`s in `src/server/ops.ts` that never take an MCP tool's name) is 404 `unknown op` and runs nothing.
- `launchStudio(o) → {reused: false, server, url} | {reused: true, url}` — a live holder of ui.json is reused (a new
  code minted through `/v1/bootstrap` with its token), else a server is started and ui.json claimed; closing releases
  it. `studio ui --port N` while a server already runs on another port reuses it and warns that `--port` is not used.
- The page (`src/app/`): reads `#c=<code>` and removes it with `history.replaceState` before anything else (a route
  fragment stays), trades it at `/v1/session`, keeps the token in sessionStorage, sends it as a header (`credentials:
  'omit'`); no token or a 401 → "This Studio session ended — run `studio ui` again" (no input asks for a token), with
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
- `studio ui` (cli `commands/ui.ts`): workspace check as `studio mcp` (exit 2 with the `--root` hint), lazy import of
  `@demo-studio/ui`, opens the browser (`open` / `xdg-open`) unless `--no-open`, serves until SIGINT / SIGTERM.

**The workspace index** (part 3; engine `src/index-db/`, R-ARC-05, ADR-2) — `<workspace>/.demo-studio/index.sqlite`, a
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
  `demo-studio.events` reads it (`fetch` with the token in a header — EventSource cannot send one) and relays each event
  over the BroadcastChannel `demo-studio.events`; when that tab closes, the lock passes to another, which opens the
  stream. Without Web Locks each tab leads its own; a leader answered 503 publishes `resync` every 3 s (30 s), then
  tries again; when a stream opens again after one was lost, subscribers get `resync` (re-read what they show). `useEvents`,
  `useProjectEvents(slug)`, `useEventMode()` (`stream` / `relay` / `polling`: the sidebar says *live updates* or
  *updates every 3 s*). The `resync` after a lost stream is the next stream's `hello` (what changed meanwhile was told
  to nobody).

**MCP over HTTP** (part 3; R-MCP-02; mcp `src/http.ts`, `server.ts`; cli `studio mcp --http`).
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
- `studio mcp --http [--port N] [--rotate-token] [--json]` — `stableToken(mcpHttpTokenFile(), {rotate})`, the same PATH
  clean-up as stdio, serves until SIGINT / SIGTERM (`--json`: one line `{type: 'mcp-http', url, port, pid}`);
  `--print-config --http [--port N]` prints the registration without the token (review A M1): `mcpHttpConfigJson`
  (`{type: 'http', url, headers: {Authorization: 'Bearer ${DEMO_STUDIO_MCP_TOKEN}'}}` — Claude Code expands the
  variable when it reads `.mcp.json`, which is often committed) on stdout; on stderr `claudeCodeHttpCommand` (`claude
  mcp add --transport http demo-studio <url> --scope user --header "Authorization: Bearer $(cat '<token file>')"` —
  the shell reads the file, its history keeps the `$(cat …)`) and `mcpHttpTokenExport` (`export
  DEMO_STUDIO_MCP_TOKEN="$(cat '<token file>')"`). `--port` / `--rotate-token` / `--json` without `--http`: usage
  error.
- Whoever holds the token is an MCP client of the workspace (agent trust) and answers its own approval forms — as the
  client that spawns `studio mcp` over stdio. Separate process and token from the Studio: a Studio page never holds it.

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
  person without `studio` on their PATH). A file of more than `VIEW_STEPS_MAX` = 2,000 steps (review A #8: a 2 MiB
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
  URLs, identity) by (file sha256, the signatures of project.yaml / sandbox.yaml / hooks/ / studio.yaml, env), redone
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
  `needs_approval` / `refused` with the `studio run …` fix), nothing queued, no run id reserved.
- The screen: "Runs from the Studio" holds a Dry run and a Capture button. A mode with blockers is disabled, labelled
  "Capture — needs the terminal" (`aria-describedby` → "why, and the command to type, below": said once, review B L6)
  above its reasons and fix commands (`studio …` and its `node …/bin.js …` form); a file with errors → "Capture — fix
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
- The worker (critique B5): `studio ui` sets its own PATH with core `clientPath` (absolute entries only, none a package
  manager added — `node_modules/.bin`, corepack —, none inside the workspace; the node first, Homebrew / system folders
  completed), so the thumbnails' ffmpeg is never a program in the workspace. The engine takes `workerEnv` /
  `workerSpawn` (tests) and passes them, with `startedBy: client`, to `ensureWorker` → `spawnWorker(root, {env,
  startedBy, spawn})` → `worker-main --started-by <client>` → the worker lock's `started_by` (`^[a-z]{1,16}$`, checked
  when written and when read; a handover passes it on). Every client but the CLI starts its worker with engine
  `cleanWorkerEnv(env, root)` (review A #3: a worker an MCP client started inherited Claude Code's environment and
  served the Studio's later jobs; the Studio's `studioWorkerEnv` is the same cleaner): no `npm_*` / `pnpm_*` /
  `INIT_CWD` / `COREPACK_*` / npm tokens (a package manager's; `npm_config_*` can carry a registry token), no
  `DEMO_STUDIO_MCP_TOKEN`, no model or agent credential (`ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `AZURE_OPENAI_*`,
  `AWS_BEARER_TOKEN_BEDROCK`, Gemini / Google AI, Mistral, Cohere, Groq, xAI, DeepSeek, OpenRouter, … keys, Hugging Face
  tokens; review B L5) nor code-host tokens (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`), nothing that loads code from the
  workspace (`NODE_OPTIONS` naming a file to load — `-r`, `--require`, `--import`, `--loader`, `--env-file`… —; `NODE_PATH`,
  `DYLD_*`, `LD_PRELOAD`, `LD_LIBRARY_PATH` with a relative entry or one inside the workspace), PATH =
  `clientPath(node, PATH, exists, root)` (the workspace under any spelling: `realpathSync.native`, and without case
  where the system ignores it), DEMO_STUDIO_HOME made absolute — never more than `studio worker` typed in the same
  terminal needs; sign-in secrets read through `{{env:…}}` stay. A worker lock without its start time names a pid that
  cannot be told from any other: it counts as alive only where `ps` cannot tell that pid's start either (review A #7:
  a lock forged with the Studio's own pid kept every worker off). One worker serves the workspace: a job runs in
  the environment of whichever client started the worker (`studio jobs`, `studio doctor`, `engine_info` and the
  Studio's sidebar say "started by …"). The worker exits after 60 s idle (`DEMO_STUDIO_WORKER_IDLE_MS`;
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
acceptance on the fixture from the built `studio ui` (end of this section). Cut to BL-95: scenes, forms beyond scalars
and a flat target, YAML saves in the undo history.

**Write lock** (critique B1). Storage `writeText` with an `if_match` hash holds `<project>/.demo-studio/locks/
write-<sha256 of the target's real project path, 24 hex>.lock` (engine `project-lock.ts` `takeProjectLock`: the L3.6
TakeLock — created whole, stale only when its process is gone; busy retried every 20 ms for ≤ 3 s, then `busy`) from
the first hash check to the rename, so two writers of one version — one process or several (`studio ui` beside
`studio mcp`) — give exactly one success and one `conflict` (before: 221 of 300 concurrent pairs both "succeeded"). A
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
only `application/x-demo-studio-step` (never read on drop); the drag state lives in the document (critique B11): rows
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
off (critique B7). The app builds no YAML: no `yaml` import, only type imports from `@demo-studio/*` (source lint).

**Acceptance** (part 4): the built `studio ui` on a scratch copy of the fixture workspace, its own fixture on free
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
frame: a test scans every file of the run, `.demo-studio`, the studio home and the worker's TMPDIR for the frames'
bytes, whole, inside a file or in base64.

**Pause** (runner `pause.ts`, dry runs and captures). Between steps only: at the top of `runStep` once the page is loaded
(`awaitShownLoaded`) and signed in (`assertSignedIn`), before a late popup's settle and `step_start` (critique B4);
never inside a step, never in hooks, teardown or encoding; a pause asked during setup or the last step takes effect at
the next step, or not at all. While `PauseGate.requested` the run waits (polled every 100 ms): run.json `paused: {scene,
step, since}`, then `pauses: [{scene, step, at, ms}]` and `paused` removed (also after a cancel); `assertSignedIn`
again after it. A cancel or the sign-in guard ends the wait at once through the run's combined signal (teardown and
rollbacks as for any cancel). A pause longer than `PauseGate.maxMs` (default 30 min; the worker reads
`DEMO_STUDIO_PAUSE_MAX_MIN`, minutes (0, 1440]) stops the run: cancelled, "paused longer than … the run was stopped (its
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
job's window closes after `DEMO_STUDIO_SIGNIN_MAX_MIN` (default 30 min: it holds the single worker, and a click in the
Studio opens it) — `timed_out`; `auth.cancelSignIn(job)` cancels an `auth_login` job and refuses any other kind. A
stopped sign-in writes no snapshot and no status; a profile persona that already had a browser profile signed in on
it, so what the window changed stays there (`profile_kept`, review A L5; `signInStoppedText` words it for the worker,
MCP and the Studio) — a first sign-in removes its new profile, a `storage_state` persona's window ran on a throwaway
one. (A temporary copy of the profile, swapped in on success, was weighed and left: the master's writer and its lock
are `studio login`'s since L1.6.)

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
  `studio run` alike) and, for a job's run, the worker's `events.jsonl` (`log` → `job_log`, `state` → `job_state`; its
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
  workspace and the studio home for their bytes, raw and base64). The page decodes with WebCodecs' `ImageDecoder` where
  the browser has it, else `createImageBitmap` of a Blob, on a canvas (part C; no CSP change, no `src=`, no blob: URL).
- *Ops*: `run_pause {project, run_id, paused}` → engine runs.pause (409 queued / stopping / finished, 403 a terminal's
  run; the summary says "pausing before its next step" until the run reaches it); `scenario_sessions
  {project, name, env?, mode?}` → engine auth.forScenario + `confirm`; `sign_in_cancel {job}` → engine
  auth.cancelSignIn; `auth_status` (MCP, read-only); `auth_login` NARROWED to `mode: 'headed'` and `wait_s: 0` (S6: a
  page script can only open a window the person sees, which closes after DEMO_STUDIO_SIGNIN_MAX_MIN; `auto` is what
  every run's preflight does by itself).
- *The session acknowledgement* (S7, critique B10): `scenario_run` of a capture reads auth.forScenario (capture mode)
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

**Acceptance and cost** (part E, 2026-10-26; the built `studio ui`, a scratch copy of the fixture workspace with the
fixture on ports of its own, a scratch `DEMO_STUDIO_HOME`, a headless Chromium driving the page). A dry run of
`highlights` watched live (first frame drawn 1.3 s after Start, the picture letterboxed), paused before
`quotes.0` for 3 s (no step moved) then resumed — succeeded 7/7; another stopped after 2 steps — cancelled, "no
rollback was pending". A capture of `highlights`: the picture hidden by default (no `frames` asked, nothing drawn),
shown by the toggle (the stream reopened with `after` + `frames: true`), paused once — `run.json pauses` 5.0 s,
`timeline.pauses` `{t: 9.083, ms: 4801}`, the run warning "paused once (4.8 s, not filmed)" —, succeeded with its
setup and teardown hooks. A capture submitted through MCP (`studio mcp` over stdio, `run_capture`) watched on the Run
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
screencast's JPEG encoding at `everyNthFrame: 1`); GPU, renderers and the studio process within the noise; the
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
API 2 (engines.kit "^2"): this Demo Studio provides kit API 1"), `get` / `resolve` throw, `list` leaves it out — its uses
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
(a failure logs `studio player: a <frame|media|other> request failed: <Error name>`), never in a Referer
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
`studio components` applies); its bare imports resolve from the ui package, never from its folder (a planted
`node_modules/react` is ignored); each of its files is loaded by the plugin: real path inside the component's real
folder (a link out of it is refused), read with core `readPlainFile` (no link, regular, ≤ 1 MB), `.ts .tsx .js .jsx
.mjs .json` only. The frame, the composition and the kit import their own sources and react, react-dom, remotion,
@remotion/player, @remotion/lottie, lottie-web, scheduler, @demo-studio/core / components (type-only in practice).
A component that breaks a rule or does not compile is excluded and the build retried once without it (`excluded:
[{id, why}]`, worded with its id, never its folder); its uses draw with their kind's scaffold. Memo (`PlayerBundles`):
key = sha256 of the format, the Player's version, editor `bundleHash` of the components (composition, kit, every
component folder by content, Remotion's version) and the frame's sources; rehashed on every frame document (an edited
component file is a new bundle), at most 2 kept, concurrent asks share one build. `@remotion/player@4.0.534`,
`remotion`, `@demo-studio/components` and `@demo-studio/editor` are now dependencies of `ui` (same versions as the
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
`DEMO_STUDIO_TEST_CHROME=1`, temporary profile): the VideoToolbox take (keyframes every 0.4 s) and the libx264 one
(7.97 s, B-frames) both play — 8 seeks each exact, seek → settled median 107–109 ms, p95 109–111 ms, max ≤ 212 ms
(the settle check itself is two 30 ms polls), playback 29.4–29.5 output frames / s of 30; a real capture of the fixture
(`highlights`, VideoToolbox, 1,364 frames, 10 segments; `DEMO_STUDIO_TEST_REAL`): timeline view 77–205 ms, the first
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

**Acceptance (part F, this Mac, 2026-10-27).** The built `studio ui` (`--json --no-open`) on a scratch copy of the
fixture workspace (its own fixture on 4471–4474, a scratch `DEMO_STUDIO_HOME`), driven in the installed Google Chrome
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
- *"From this version"* (H1) compared the file, the capture and the theme name only: a `studio render --no-intro
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
L1.8: two sandboxes of the fixture project — `sandbox` (process: `node server.mjs` on 4501–4504, started by Demo
Studio) and `sandbox-docker` (docker-compose, `sandbox/docker/{sandbox.yaml,compose.yaml}`: the fixture image on
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
  (journal, rollback order, allow-list, destructive detection; sql against a real Postgres if `$DEMO_STUDIO_TEST_PG` —
  `pnpm test:pg`: `scripts/test-pg.mjs` starts a throwaway `demo-studio-pg-test-<hex>` container (label
  `demo-studio.test=pg`) from the local `postgres:17-alpine` image (never pulled) on a loopback port Docker picks,
  with password auth (scram, what the connection-failure test needs), waits for a password-authenticated `SELECT 1`
  over TCP (the image's init server listens on no TCP socket), runs `packages/hooks/test/sql.test.ts` and removes that
  container by its exact name with its anonymous data volume (`docker rm -f -v`: the image declares a volume, which
  `--rm` does not drop when the container is removed by name) in `finally` and on SIGINT / SIGTERM; a labelled
  container a killed run left is listed with its `docker rm -f -v`, never removed; `--all` runs the whole suite with Postgres, Docker and slow tests on).
- Integration (L1.4, `packages/cli/test/catalogue-acceptance.test.ts`, gated by `DEMO_STUDIO_TEST_SLOW=1` —
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
  `DEMO_STUDIO_TEST_DOCKER=1` — `packages/sandbox/test/compose.test.ts` (the init scaffold with Postgres snapshots, a
  health stuck at `starting`, busy ports) and `packages/cli/test/sandbox-docker.test.ts` (the fixture's image built,
  a sign-up mail relayed to the real Mailpit and read with runner-web's `MailboxClient`, the PDF refused, reset empties
  Mailpit, `down --volumes`), plus another checkout sharing the project name and another container publishing the
  sandbox's port on [::1] (K2, K3). Their compose projects, containers and images are named
  `demo-studio-test-<run token>-*` / `demo-studio-test-fixture-<run token>-*` and swept after the run — that run's
  only, so two runs (another worktree) never remove each other's (containers, networks, volumes, the images they
  built; never base images, never `--rmi all`, never a prune).
