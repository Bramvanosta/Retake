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
packages/mcp          (L3.1) MCP server over stdio (§4b; HTTP transport: L4.1)
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
runHooks(hooks: HookStep[], ctx: HookContext, opts: { phase: 'setup' | 'teardown' | 'reset' | 'seed'; journal: Journal }):
  Promise<{ ok: boolean; results: HookResult[] }>
//   setup: on the first failure (non-optional), rolls back the completed hooks of this call in reverse and returns ok=false
//          (ctx.signal aborted: a running shell hook is stopped and fails; the rollbacks run without the signal)
//   seed (L1.8, §3.8): stops at the first failure, rolls nothing back, never asks to confirm a destructive step, no js
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
encodeFrames(framesDir, index: FrameIndexEntry[], out: string, opts: { fps; crf; endT }): Promise<void>
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
createEngine({root?, client: 'cli'|'mcp'|'test'}): Promise<Engine>
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
  `clientPath` (PATH with the node's folder first + Homebrew / system folders, without the folders a package manager
  adds for its script: `node_modules/.bin`, corepack, node-gyp-bin), `DEMO_STUDIO_HOME` when set; the
  `mcpServers` JSON (stdout) and the `claude mcp add` line (stderr).
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
