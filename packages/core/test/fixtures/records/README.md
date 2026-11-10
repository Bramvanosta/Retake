# Run records and takes: test data

Test data of the records tests (`packages/*/test/records-characterization.test.ts`, core's `run-record`, `take` and
`run-folder` tests). Nothing here is read by the product. The tests read these files **by path** (`readFileSync`):
a JSON file read that way is not an import, so the layer rules do not see it.

| File | What it is | Made how |
|---|---|---|
| `states.json` | The states of a run folder `NEW` beside a good older capture `OLD` of scenario `quote`: per state, how `NEW`'s `run.json` and `timeline.json` differ from the base ones, whether its film is a file, a link or absent, and whether the folder is a real folder, a link out of the project or a dangling link. | written for the tests |
| `build.ts` | Writes those folders into a temp workspace, one project per state. Each test file holds its own expected answers. | written for the tests |
| `past/run-0.1.0/run.json`, `timeline.json` | A capture of 0.1.0. | real, trimmed: the timeline's lists cut to a few entries, every absolute path rewritten to `/workspace/projects/northfield-fixture/…`, the GPU's name replaced; `engine` and `perf.cpu` are as an older build wrote them minus one key each that this repository no longer names (so both lack `retake`) |
| `past/run-phase1.json` | The first shape of a record: no `version`, `engine`, `environment`, `perf`. | hand-written from the first writer's literal |
| `past/run-queued.json` | A run reserved by a job, before it starts. | hand-written from the writer's literal |
| `past/run-closed-from-queued.json` | A reserved run closed before it started: no `environment`, no `engine`, an `error` with a message only. | hand-written from the writer |
| `past/run-running.json` | A run in flight (a dry run at its fifth step). | hand-written from the writer |
| `past/run-closed-from-running.json` | The same run closed from outside: `failed`, and still its `current`. | hand-written from the writer |
| `past/run-closed-from-paused.json` | A capture closed from outside while paused, late: `cancelled` with `current`, `paused`, `capture` and `timeline`. | hand-written from the writer |
| `past/run-dry.json` | A finished dry run of 0.1.0 stopped by `--until`; its `engine` lacks `retake`. | hand-written (no dry run of that time was at hand), from the writer |
| `past/real/run-real-{1,2,3}.json` | The three run records found on the machine this lot was made on (captures of one scenario of the fixture product, written by 0.1.0). | real shapes, every value that could identify anything replaced by a script: ids and dates of the folder made up, absolute paths rewritten to `/workspace/…`, the GPU's name, the OS, the versions of Node.js and Chromium and the fonts' digest replaced by neutral ones, warnings numbered; a key of `engine` or `perf.cpu` that today's types do not name is left out (two per file: the reader takes unknown keys, and the tests of `past/run-0.1.0` add one back under neutral names). The numbers of `perf` are the files' own. |
| `future/run-next-minor.json` | A record as a later version of the same format might write it: version 1, words this build does not know in `options`, `hooks`, `environment` and `stopped_at`, blocks it does not know (`review`, a `trace` that is `null`, members inside `engine`), a `perf` it cannot read. | hand-written for the tests: no such version exists |

**How honest these are.** Only `past/run-0.1.0` and `past/real/` come from files a build wrote, and all four are
captures of one day by one version. Every other file of `past/` was written by hand from the code of the writer it
names, by the author of the schema it is read with: it tests that reading of the writer, not a file a past version
left. The reader is therefore built not to depend on them: a member that decides nothing can never make a record
unreadable (core `parseRunRecord`).

## The marks on the rows of the tests

The tests of this lot (L7.6a) mark a row with the decision or the fix that makes its value what it is:

| Mark | Meaning |
|---|---|
| D-1 | `latest` is the newest succeeded capture with its timeline and its film |
| D-2 | when `latest` passes over newer runs it says so: ids at a terminal, a count through MCP and the names under `untrusted` |
| D-3 | a run without a readable record is not `latest` |
| D-4 | one order of runs everywhere: dated ids first, newest first, then the other names |
| D-5 | a run's scenario is its record's (and its timeline must agree), never its folder name's |
| D-6 | a record of a newer format is passed over and said; alone, the error is still "update Retake" |
| D-7 | a linked run folder is never `latest`; through MCP a named one is refused when it leaves the project |
| D-8 | no upgrade of old keys: a tolerant reader, and no member that decides nothing loses a run |
| F-1 | fixed: a dangling link in `runs/` made `latest` find nothing |
| F-2 | fixed: with frames kept, the Studio never offered the newest capture |
| F-4 | fixed: a timeline cut short gave a parser's message |
| F-6 | fixed: a `run.json` that is no record was listed as a row of empty fields (now said as what it is) |
| F-8 | fixed: a scenario name too long for a run id was filmed into a folder no list shows |
| U-1 | a capture stopped by `--until` is still `latest`, and says where it ends |
| P | prune's own rule, unchanged by this lot (L7.7 moved it: `L7.7 P-1` — the newest take that can be edited stays, a linked folder and a newer record are left alone —, `L7.7 U-1` — the newest complete capture stays beside one stopped by `--until`; its layouts: `prune-layouts.ts`) |
| small point 3.x | a detail confirmed with the decisions (3.1 a linked film, 3.2 `runs/` on another disk, 3.5 a non-record) |

Where a file also holds marks of the lot before (L7.5 used `D-4` and `D-7` for other things in the `ids`
characterization files), this lot's are written `L7.6a D-4`.

Past timelines are not copied here: the tests read those of `packages/editor/test/fixtures/` by path.
