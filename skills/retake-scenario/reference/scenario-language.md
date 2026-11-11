# The scenario language, condensed

A scenario is `scenarios/<name>.yaml` of a project. This page is enough for most videos; the full language is the
section "Scenario language" of `docs/guide/scenarios.md` in the Retake repository, and `scenario_validate` is the judge: every issue
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
  never add one the user did not ask for, and they need the user's approval to run. `hooks: {<name>: <hook or list>}`
  names hooks a `hook: <name>` step runs during the take (project.yaml may declare shared ones, under the same rules).
  An http hook acts as a persona with `auth: {persona: <name>}`: the persona's saved session (its cookies, and the
  sign-in token of an app on Firebase) goes with the request — the way to call the product as an account. In a
  scenario you write, its URL starts with one of that persona's own pages (`{{<page>}}/…`): another origin is refused.
  A shell hook you write in a scenario is plain words — letters, digits and `. / : = @ % + , - _` — separated by
  single spaces, commands joined by ` && ` (`pnpm run seed --small`, `sh hooks/seed.sh`, the hook's `cwd` instead of
  `cd`): no quotes, `$`, pipes, redirections, globs, `cd` / `eval`, inline code (`node -e`…), `npx`, `{{hooks.…}}`
  values or secrets (`{{env:…}}`), loader variables (`PATH=`, `NODE_OPTIONS`…), and no path through README.md,
  `scenarios/`, `runs/` and the other folders you can write, into `hooks/` or to project.yaml. Anything else is refused
  before the user is asked: ask the user to put it in `hooks/<name>.yaml`.
- Scene keys: `id` (unique), `caption` (a string or `{kicker, text}`), `page`, `open`, `persona`, `steps`, `still`,
  `cursor`, `transition`, `frame`, `irreversible`, `skip`, `offscreen` (played but left out of the video: a scene that
  only brings the product to the state the next one films), `note`.
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
| `type` | `type: {into: {label: Email}, text: buyer@example.com}` | type character by character (`clear`, `enter`, `cps`); `fill: true` sets it at once, as a browser autofill |
| `press` | `press: Enter` | a key (Playwright key names; `{key, times}`) |
| `select` | `select: {field: Country, option: Sweden}` | a native select or a combobox; a long list with a search field: the option is typed there when it does not show — `search: Swe` types something else; `search_instant: true` fills the search at once (only the final list is filmed), `search_cps: 20` types it faster |
| `pick` | `pick: {field: Bag sizes, option: [1 kg, 5 kg], search: kg}` | a multi-select popover; `search` types in its search field first (without it, the first option's text when it does not show); `search_instant` / `search_cps` as for `select` |
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
| `hook` | `hook: mark-paid` | run a named hook now, off camera (an API call, SQL, a queue job): the edit cuts it |

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

## Rules that hold for every product

What reviews of client videos kept asking for, written once:

- **Never a load on screen.** Every navigation or reload (an `open`, a submit that changes page) goes in an
  `offscreen` scene that ends with `wait_for: {network_idle: true}`: no blank screen, no skeleton. The review says
  `loading-filmed` when a skeleton or a spinner still shows.
- **Show the state, not the path.** A filter already set (`open: /catalogue?available=true`), an account already
  approved (a hook off camera), a page already loaded: never the intermediate state.
- **Overlays never on the last step of a scene**: the scene ends under them (`overlay-lost`, `overlay-cut`). Put
  them on an earlier step, or hold after them.
- **Speed you can read.** Forms fill fast (`type: {…, fill: true}`, `select` with `search_instant: true`), but a
  scene is never faster than ×2.
- **Camera: one zoom at most**, centred on a point (the middle of a form, not its title), never while the page
  scrolls, and done before it scrolls back (`zoom-during-scroll`).
- **A live update shows in two beats**: the message that triggers it, held long enough to read; then the view of
  what changes, before the change arrives, so it happens on screen.
- **Captions say only what is true on screen**: never a word the UI contradicts ("Not a quote" over a "Request a
  quote" button: `caption-contradicts-ui`), never ahead of the product ("Booking confirmed" before the payment).
- **Inspect the app's language and theme first** (`page_inspect`): captions, demo data and the theme follow them.
- **Dates**: pick a day in next month's calendar, never today or a day the calendar may not offer.
- **Look before you send**: besides the review, step through each render at 2–3 frames a second around transitions,
  submits and navigations; that is where artefacts hide.

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
- `caption_component: studio/caption-overlay` (scenario key) sets the caption component of the whole video instead of
  the theme's (`component_list {kind: caption}` names them); `render {overrides: {components: {caption: …}}}` still
  wins over it for one render.
- Cards, captions, overlays, durations, the title, intro / outro, the caption component and template are the edit: a
  change renders on the same capture. Steps, pages, hooks and capture settings are filmed: a change needs `run_capture` first.
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
