# Phase 3 acceptance (lot L3.8)

SPEC §14.3: *a Claude session creates a project from a README, drafts a scenario from a timecoded script (or
inspects/records the site), creates a theme from a brand or a site, creates a component through the skill, dry-runs,
captures, renders, reviews, reads frame comments and iterates without human steps except approval.* Done on 2026-10-20
on the Mac (Apple M4, macOS 26.6, Node 22.16, headless Chromium from playwright-core 1.56.1) with the engine as built in
L3.8. Verdict: **accepted for the automated part; the live run by Claude itself is pending** (`docs/MACOS-CHECKLIST.md`
step 12j). R-ACC3-01..06 stay *partial* until it comes back.

What this proves and what it cannot: the whole loop runs over MCP on one empty workspace, in a scripted order that
follows the skills (each phase's calls an exact sequence; the tools it uses all named by the skill sections it follows,
compared as a set, not in the skills' order; the rules the skills state checked over every call), with no approval, no
write to the product outside the two captures and two clean reviews. The client is a script, not a model: it follows
the skills deterministically (see "What only the live run proves").

## The scripted acceptance

`packages/mcp/test/phase3-acceptance.test.ts`, in `pnpm test:slow` (gated by `RETAKE_TEST_SLOW=1` and ffmpeg /
ffprobe). An SDK `Client` drives `retake mcp` over stdio, started from the sources with the workspace as its folder
(`engine_info.started_outside_workspace` is false). The workspace is empty: a `retake.yaml`, an empty `templates/` (the
starters still resolve), and a `brand/` folder with an invented plain-SVG mark and four font files (the starters' OFL
fonts under other names). The fixture product runs on free ports, and `RETAKE_HOME` is a scratch folder. The
client declares `elicitation.form`, records every request and declines it. Alone, the file takes 7:06–7:20 on the Mac
(scenario ≈ 140 s, film ≈ 140 s, comment loop ≈ 150 s, theme + component ≈ 6 s); inside `pnpm test:slow` (7 files,
42 tests, 9:44 wall) it took 518 s. The numbers below are from the kept run of part 2 (renders 64.20 s / 66.23 s); the
part-3 `test:slow` run, after the kit change, gave 64.43 s / 66.80 s, both reviews clean.

One `it` per requirement, sharing the workspace. Each one ends with three checks over the calls it recorded:
- **the exact sequence** of non-polling calls (the agent's own file writes appear as `write:<file>`);
- **every tool used is named** by the skill sections that phase follows, as a set;
- **the rules the skills state** hold over the whole story so far:
  - every write to the component's code is followed by a clean `component_validate` before the next preview;
  - every `scenario_save` passes the hash the last get or save returned, and saves the text last validated;
  - no `render` after a `scenario_save` until a capture started after it has succeeded, and every `render` is of the
    newest succeeded capture (the `run_id` the render tool returns: a render of the old run after a re-capture fails);
  - `comment_resolve` passes the hash `comment_reply` returned and a render of the newest capture.

The checker itself is tested on synthetic call logs without the slow gate (13 cases, one per broken rule, plus the
`sent` hold tolerance of ±0.25 s on the run timeline).

| Requirement | What the client does | Result |
|---|---|---|
| **R-ACC3-01** project from a README | `engine_info` (0 projects) → `project_list` → `project_create {name, slug: northfield, readme, environments: {local: {shop, console}}}` with the README the user hands (invented product, tone, brand colours, environments) → `project_get` | the README stored byte for byte with its hash, `local` read-write with both pages, no scenario; the folder holds `.gitignore`, `README.md`, `assets/`, `hooks/`, `project.yaml`, `scenarios/`; `project.yaml` unchanged at the end of the story |
| **R-ACC3-02** scenario from a script | `scenario_from_script` on a 6-row timecoded table (title, discover, request, delivery, quotes, outro) → 8 `page_inspect` (the shop home, a `targets` check, `until` the product page, the dialog, the calendar, January, Send, the quotes page) → each beat rewritten from the inspection hints, `scenario_validate` + `scenario_save` (if_match) after each → `run_dry` | 4 scenes, 26 steps, no `note:` hold left, the script's captions kept; Send carries `irreversible: true` and sits in one scene with `wait_for: Quote request sent`, `mark: sent` and `hold` (the confirmation text comes from the script's action column, since a replay never sends). The inspection up to Send reports 1 skipped irreversible step. Dry run: succeeded, stopped at `delivery.6` (irreversible), 25 of 26 steps. Fixture `mutations`: **+0** across the 8 inspections and the dry run |
| **R-ACC3-03** theme from brand files | `template_list` (default, editorial, motion) → `template_create_from_brand {name: roastery, colors: the README's five, logo and fonts from brand/, brand name and address}` → `template_list` → `template_preview` | `roastery (workspace, real)`, based on editorial; every contrast check ok and nothing lifted (the README colours were chosen to pass text 7:1, muted 4.5:1 and accent 3:1 on the paper **and** the dark tone); 5 stills, pixel checks: interstitial = the dark tone, outro = the paper |
| **R-ACC3-04** component through the skill | look first: `component_list {kind: intro}`, `component_get studio/intro-stack`, its preview in roastery → `component_create northfield/intro-split` → the kit reference's `component.yaml` and `index.tsx` written into the folder (standing for Claude's file tools once the user agreed) → `component_validate` → preview A → **a code iteration** (the logo 96 → 150 px) → `component_validate` → preview B → one preview in editorial | validate clean both times; still A on the roastery paper; still B's bytes differ from A's (the code change shows); the editorial still adapts (its paper, fonts and mark) |
| **R-ACC3-05** capture, render, review | `run_capture` → `plan_preview {template: roastery, overrides.components.intro: northfield/intro-split}` → `render` (same arguments) → `review` | capture succeeded, `sent` hold 1.0 s on the timeline; plan **≥ 60 s** checked before rendering (it prints the segments when it fails), segment 0 = the workspace component, `scenario_changed: false`; render **quote-tour-v1 = 64.20 s**, template roastery, nothing blocked; review **clean** (no error, no warning), key frames include `intro-hold` (on the paper), `sent`, `outro-hold` |
| **R-ACC3-06** comment → fix → re-render | the person, in their own terminal: `retake comment add northfield quote-tour-v1 --marker sent --region 0.72,0.73,0.18,0.11 "Keep the confirmation on screen longer"` → `comments_list` → `scenario_get` → hold 1 → 3 → `scenario_validate` → `scenario_save` (if_match) → `plan_preview` on run 1 → `run_capture` → `plan_preview` on run 2 → `render` → `review` → `comment_reply` → `comment_resolve {render_id: quote-tour-v2, if_match: the reply's hash}` → `comments_list` | anchor `delivery.7` (`wait_for`, marker `sent`), the still as an image, the comment's text only under `untrusted`; the trusted summary says a scenario change needs `run_capture`. `plan_preview` on the old run: `scenario_changed: true` and the exact trusted line `scenario quote-tour changed since run … was captured: a render shows the run as captured — …: run_capture {project: "northfield", scenario: "quote-tour"}, then render`. Run 2: `sent` hold 3.0 s, the delivery clip ≥ 1.5 s longer, `scenario_changed: false`; render **quote-tour-v2 = 66.23 s**, review **clean**, `diff.previous` = quote-tour-v1; resolved via `mcp` on quote-tour-v2, no open thread left |

End of the story: **zero approval requests** (`asked = []`, with elicitation declared, so the server would have
asked), `templates/` holds only roastery and `components/` only `northfield/intro-split`, nothing written into the
repository, no `Unhandled` / `TypeError` on the server's stderr. Fixture `mutations`: the same delta (≥ 1) for each
capture, none otherwise.

By construction nothing in this chain needs an approval (no hook, no URL to read), so "zero approvals" is a regression
guard, not a proof of the approval path. That path stays covered by `fixture-acceptance.test.ts` (a hook) and
`theme-acceptance.test.ts` (a site URL).

## The frames looked at

A run with `RETAKE_ACCEPTANCE_KEEP=<folder>` copies the marked inspections, the theme and component stills, both
renders' contact sheets, key frames and videos, the comment's still, the diff sheet and the scenario before and after.
Read as an agent reads them, against `docs/reference/look.md`:

- **Inspections** (8 marked screenshots): numbers on every element in view; the dialog's fields, the calendar's two
  months, January's days, Send with the message typed, the quotes list with its three seeded rows.
- **Theme stills** (`roastery`): the intro with the mark, the wordmark in the display face, the accent kicker and rule;
  the card layout, its caption and brand mark; the chapter card; the clock interstitial on the README's dark tone; the
  outro with the tagline and `NORTHFIELD-ROASTERS.TEST`.
- **Component stills**: `studio/intro-stack` (looked at first); intro-split A (mark and title in one row: centred in
  part 2's run, when the kit example ignored `align`; on the left in part 3's, now that it reads the default `align:
  left`) and B (the larger mark); the editorial still (its own mark, paper and serif). Nothing cut, the theme's colours throughout.
- **quote-tour-v1 contact sheet** (64.20 s, 6 segments, 1 frame per second): the custom intro in roastery (mark left,
  title right: the kit example's default `align: left`), discover (hover, scroll to the fresh arrivals, the lot opened,
  hovers on a tasting note and the 5 kg price), the dialog filled (3 × 5 kg, whole bean), the January window and the
  typed note, Send, the toast "Quote request sent" at the bottom right of the card, the quotes list and an accepted
  proposal, the crossfade into the outro. Every caption on one line.
- **Key frames**: `intro-hold`, `sent` (the toast fully inside the card), `outro-hold`, and each scene's first and last
  frame.
- **The comment's still**: the frame of `sent`, with the person's box around the toast.
- **quote-tour-v2 contact sheet** and **the diff sheet against v1** (8 of 64 sample frames changed, 64.20 → 66.23 s):
  the longer hold on the toast, plus take-to-take differences of a new capture. Discover is 4–21 % different (scroll
  timing), and the quotes list has one more row (the second request sent by the second capture). Expected: a new
  capture is a new take.
- **Both mp4s** played once (part 2); v1's frames around the request → delivery join extracted at 10 per second
  (part 3): continuous, only the caption changes.

### `request-last` — the screen looks shifted left, the right half empty (checked: expected)
In `request-last.png` of both renders, the shop's right half looks empty and the page seems pushed left. Checked
against the plan and the frames:
- It is **not a transition frame**. `request` and `delivery` are contiguous scenes on the same page, so the planner
  joins them without a transition ("continues … on the same page: joined without a transition", plan.ts). The review
  takes a scene's last frame inside its clear span (`keyframePlan`: `clearTo − 1`, before any transition window), and
  a joined clip has none.
- The frame is the end of the `request` scene's `hold: 3`: the quote dialog filled in (3 bags, 5 kg, whole bean, the
  delivery window still empty), the cursor parked over "Delivery window". It equals the next frame, `delivery-first`
  (PSNR of the card area 68.5 dB in v1, 70.0 dB in v2 of part 2's run; 71.5 / 70.9 dB in part 3's).
- The dialog is centred in the shop's viewport (x 684–1236 of the 180–1740 card, centre 960). Behind it the fixture's
  modal backdrop dims and blurs the product page: the bright photo column on the left stays visible, and the small text
  of the details column on the right washes out. The raw page with the dialog open looks the same (the inspection's
  `3-dialog` screenshot, no edit applied).

So it is the product's own modal look, not a layout or planner defect: no fix. The intro (`intro-hold`) is the other
frame with an empty right half; that is the component's `align: left` default (logo left, title right), as designed.

## Problems found during the lot, and their fixes
1. **A scenario change after a capture never showed in a render** (part 1). A render plans from the run's scenario
   snapshot and its `timeline.json` (title, intro, outro, template included), never from the current file. Yet the
   instructions, the scenario skill and checklist 12h said "change the scenario, render, review". Fix:
   - one core check, `scenarioChangedSinceRun` (`.yaml` / `.yml` against `<run>/scenario.yaml`), and one wording,
     `scenarioChangedMessage`;
   - `plan_preview` and `render` return `scenario_changed` and a trusted summary line naming `run_capture`; after the
     review, `plan_preview`'s last line says "capture first" instead of offering to render the old run, and the files
     are compared by their data (a comment-only edit is no change; a link, a FIFO or a huge file is not read);
   - `retake plan` and `retake render` warn on stderr;
   - the INSTRUCTIONS, the three skills, README and MACOS-CHECKLIST 12h now say "A change to the scenario (steps,
     captions, timing, title, intro/outro, template) shows only in a new capture: `run_capture`, then render."
   Tests in core, engine, CLI and MCP, each mutation-checked.
2. **`comments_list`'s trusted summary still said "change the scenario …, render and review"** (part 2). That is the
   same failure at the exact point where Claude reads a comment. It now says the change needs `run_capture` first (a
   theme or a render override needs only a render). Regression: `stdio-comments.test.ts` (mutation-checked); the
   acceptance asserts it too.
3. **`fixture-acceptance`'s comment was answered without a re-capture** (part 1). "Keep the total on screen longer"
   was resolved by a theme switch. The comment is now "Try a laptop frame for the proposal", which a layout switch does
   answer. The scenario-fix loop is R-ACC3-06 here.
4. **The kit reference's example declared `params.align` and never read it** (part 3). A Claude following the skill
   would change a param that changes nothing. `reference/kit.md` now reads it (`justifyContent`); the acceptance's code
   iteration is the logo size. `skills.test.ts` compiles the example.

Not changed (BACKLOG BL-78): the same scenario-changed check on `comments_list` / `comment_resolve` (a resolving
render whose run snapshot differs from today's scenario).

## What only the live run proves (MACOS-CHECKLIST 12j)
The script knows the answers; Claude has to find them. Only a real Claude Code session shows that Claude:
- picks the right skill without being told, reads the README to derive the name, slug and environments (the test
  hard-codes them), and writes YAML from the hints with judgement (the test picks elements by name);
- asks before editing component code, and re-captures after a scenario edit because the wording tells it to (the test
  does so because its author knows);
- reads image blocks within `MAX_MCP_OUTPUT_TOKENS` and judges the contact sheets and the comment's still;
- handles approval forms in a real client (none occurs here by design), and copes with a real person's comment and
  wording;
- takes the confirmation text from the user's script, not from an inspection (a replay never sends).

Also live-only, from earlier lots and still pending: 12c–12i (the separate deep checks per lot: capture with
approvals, render / review / export with images, authoring, recording by a person, themes from a kit and a site,
frame comments, the plugin and its probes) and Claude desktop (not tried). 12j is the consolidated run; 12c–12i stay as
optional deep checks.

## Reproduce
```sh
pnpm build
RETAKE_TEST_SLOW=1 RETAKE_ACCEPTANCE_KEEP=/tmp/phase3-keep npx vitest run packages/mcp/test/phase3-acceptance.test.ts
# or the whole slow suite: RETAKE_ACCEPTANCE_KEEP=/tmp/phase3-keep pnpm test:slow
```
The test starts and stops its own fixture and workspace; the kept folder holds `inspect/`, `theme/`, `component/`,
`render1/`, `render2/` (with `diff_quote-tour-v1.jpg` and both mp4s), `comment/` and `quote-tour-1.yaml` /
`quote-tour-2.yaml`. Delete it after looking (videos).
