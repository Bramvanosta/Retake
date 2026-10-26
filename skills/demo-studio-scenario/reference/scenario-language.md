# The scenario language, condensed

A scenario is `scenarios/<name>.yaml` of a project. This page is enough for most videos; the full language is the
README section "Scenario language" of the Demo Studio repository, and `scenario_validate` is the judge: every issue
it gives has a line and a col.

## Skeleton

```yaml
version: 1
video: quote-request
title: {kicker: For buyers, text: Request a quote in a minute}
outro: {tagline: "From request to proposal, in one place."}
scenes:
  - id: discover
    caption: {kicker: Discover, text: "Fresh arrivals, roasted to order."}
    page: shop                  # an environment page key (project_get lists them)
    open: /                     # a path on that page
    steps:
      - scroll: {to: {text: Fresh arrivals}, offset: -100, duration: 1.6}
      - click: {role: button, name: Request a quote}
      - wait_for: {target: {role: dialog}}
        mark: dialog-open
  - id: request                 # no page / open: continues where the previous scene left off
    caption: {kicker: Request a quote, text: "Choose the quantity, the bag size and the grind."}
    steps:
      - click: {aria: Increase, in: dialog}
      - select: {field: Bag size, option: 5 kg}
      - type: {into: {label: Message}, text: "Light roast for filter, please.", cps: 18}
      - click: {text: Send request, in: dialog}
        irreversible: true      # never executed by a dry run or an inspection replay
      - wait_for: {text: Quote request sent}
        mark: sent
        hold: 2
```

- Scenario keys: `video`, `title` (`{kicker, text}`), `intro`, `outro` (`{tagline, url}` or `false`), `env`, `vars`,
  `frame`, `template`, `pacing`, `tutorial`, `scenes`. `setup` and `teardown` hooks exist, but hooks are the user's:
  never add one the user did not ask for, and they need the user's approval to run.
- Scene keys: `id` (unique), `caption` (a string or `{kicker, text}`), `page`, `open`, `persona`, `steps`, `still`,
  `cursor`, `transition`, `frame`, `irreversible`, `skip`, `note`.
- Step modifiers, on any step: `id`, `caption`, `hold` (seconds still after it), `mark` (a named beat), `camera` (a
  zoom hint), `overlay`, `tutorial`, `timeout` (seconds, default 15), `optional`, `irreversible`, `park`, `note`.
- A step reference for `until` is `<scene>.<step id or index>` (from 0), a unique step id, or a scene id.

## Actions

Every step has exactly one action.

| Action | Example | Use |
|---|---|---|
| `open` | `open: /settings` | navigate the current page |
| `click` | `click: {text: Save, in: dialog}` | the cursor travels, hovers, presses |
| `double_click` | `double_click: {text: Report.pdf}` | a double click |
| `hover` | `hover: {text: Pricing, ms: 900}` | rest on an element |
| `type` | `type: {into: {label: Email}, text: buyer@example.com}` | type character by character (`clear`, `enter`, `cps`) |
| `press` | `press: Enter` | a key (Playwright key names; `{key, times}`) |
| `select` | `select: {field: Country, option: Sweden}` | a native select or a combobox |
| `pick` | `pick: {field: Bag sizes, option: [1 kg, 5 kg]}` | a multi-select popover |
| `menu` | `menu: {row: Iceland, item: Pause, confirm: Pause}` | a row's action menu |
| `date` | `date: {field: Delivery window, day: 14 March 2027}` | a date picker |
| `scroll` | `scroll: {to: {text: Awards}, offset: -140}` | an animated scroll (`{by: 400}`, `in`) |
| `drag` | `drag: {from: {text: Card A}, to: {text: Done}}` | press, move, release |
| `drop_file` | `drop_file: {zone: {text: Drop files}, path: assets/list.xlsx}` | a file dropped on a zone (a project file) |
| `wait` | `wait: 0.8` | a fixed pause (the edit may trim it; prefer `wait_for`) |
| `wait_for` | `wait_for: {text: Saved, timeout: 10}` | until a text, a target, `gone`, a `url` or `network_idle` |
| `hold` | `hold: 2` | stay still (never trimmed) |
| `assert` | `assert: {text: Total}` | fail with a screenshot unless true |
| `screenshot` | `screenshot: proposal` | a PNG of the run |
| `new_tab` | `new_tab: {target: {text: Download PDF}, as: pdf}` | follow a link into a new tab |
| `switch_page` | `switch_page: previous` | change the filmed page (`main`, a page key, a tab's `as`) |
| `eval` | (only when the user asks) | JavaScript in the page |
| `notify` | `notify: Capture finished` | a desktop notification |
| `emit` | `emit: {name: chapter}` | a custom timeline event |
| `cursor` | `cursor: hide` | show, hide or move the cursor |
| `wait_for_email` | `wait_for_email: {to: buyer@example.com, subject: Confirm}` | a message in the project's test mailbox |
| `download` | `download: {click: {text: Download quote PDF}, as: quote}` | the file a click produces, as a document card |
| `capture_text` | `capture_text: {target: {testid: total}, as: total}` | an element's text, for a key-figure card |

## Targets

A plain string is visible text, or a CSS selector when it looks like one (`#id`, `.class`). Prefer the target
`page_inspect` verified for that element over one you invent.

- `{text: Save}` visible text (exact first, then a case-insensitive part; `exact: true` turns that off);
  `{contains: [Order, "2027"]}` the innermost element holding every string.
- `{role: button, name: Save}` an ARIA role and accessible name; `{label: Email}` a form control by its label;
  `{aria: Notifications}`, `{placeholder: Search}`, `{testid: save-button}`, `{css: "nav > a"}`.
- Scope with `in`: `dialog`, `menu`, `listbox`, `popover`, `page`, `{row: Sweden}` or another target. `nth: -1` picks
  among visible matches (fragile: it depends on the order); `last_visible: true` the most recently shown one.

## Waits, pacing and beats

- After an action that loads or changes something, `wait_for` its result (a text, `{target: …}`, `{gone: …}`,
  `{url: /quotes}`, `{network_idle: true}`). A `wait` only for a deliberate pause.
- `hold` on a step (or a `hold` step) where the viewer reads; `park: true` moves the cursor out of the way first.
- `mark: <name>` names a beat: review key frames, comment anchors and `--marker` options use it.
- `irreversible: true` on a step that sends something for real (an order, an email): dry runs and inspection replays
  show it without executing it.

## Cards, interstitials, overlays and tutorials

```yaml
version: 1
video: chapters
tutorial: {spotlight: clicks, steps: true}
scenes:
  - card: {slots: {kicker: Step two, title: Ask the roaster for a quote}, duration: 2.2}
    id: chapter-request         # a full-screen card: takes no capture time
  - id: proposal
    caption: Your proposal, ready to accept.
    page: shop
    open: /
    frame: browser              # a browser window around this scene's capture
    steps:
      - wait_for: {text: Request a quote}
        overlay:
          component: studio/overlay-callout
          slots: {text: Everything in one place}
          duration: 2.5
        hold: 1.5
  - interstitial: {text: A few hours later, duration: 2.6}
```

- `card: {component, slots, duration}` is a title or chapter card; `interstitial: {text, kicker, duration}` a "time
  passes" card. Both take no capture time and accept an `id`. Without `duration` they stay long enough to read their
  text (about 250 words a minute + 1.5 s); a `duration` shorter than that gets a review warning (`card-too-short`). A
  card showing a captured mail or document goes after the scene whose step captures it (else `artefact-before-step`).
  `studio/mail-view` shows the mail from its top (`params: {scroll: auto}` scrolls a tall one).
- `target_length: {min_s, max_s}` (scenario key) is the length this video aims at: the review's `video-length` rule
  uses it instead of the reference 60–120 s.
- Cards, captions, overlays, durations, the title, intro / outro and template are the edit: a change renders on the
  same capture. Steps, pages, hooks and capture settings are filmed: a change needs `run_capture` first.
- `overlay` on a step draws a component over the clip from the end of that step (at most 30 s); `component_list
  {kind: overlay}` names them.
- `tutorial` switches (`shortcuts`, `spotlight`, `steps`, `loupe`, `progress`) draw key caps, a spotlight, numbered
  badges, a magnifier on typed fields and a chapter bar from the timeline, with no extra step.
- `frame`: `card` (the project default), `browser`, `laptop`, `phone`, `tablet`, `raw`, or a layout component id.
  The theme is chosen per render (`render {project, scenario, template}`) or per scenario (`template:`), by name.

## Through MCP, these are refused

- `{{env:…}}` and `{{keychain:…}}` references anywhere in a scenario: only files the user wrote resolve secrets.
- A file outside the project (`drop_file` `path`, an `eval` file), or code from a folder you can write (scenarios/).
- A hook approved by the file itself: the server asks the user, whatever the file says.
