# Scenarios

The scenario language — scenes, steps, targets, hooks and secrets — then several pages at once, mails, documents and notifications, and recording a scenario by performing it. Part of the [Retake guide](README.md).

## Scenario language

```yaml
# yaml-language-server: $schema=../../../packages/core/schema/scenario.schema.json
version: 1                     # format version: optional, absent = 1 (see File formats and versions)
video: catalogue
title: {kicker: For suppliers, text: Manage your catalogue}
outro: {tagline: "Your catalogue, under control."}
setup:
  - http: {method: POST, url: "{{console}}/api/reset"}
teardown:
  - http: {method: POST, url: "{{console}}/api/reset"}
scenes:
  - id: import
    caption: {kicker: Catalogue import, text: "Import your entire price list in seconds."}
    page: console              # environment page key
    open: /imports             # path on that page, or a full URL
    steps:
      - click: {text: New import}
      - select: {combobox: "#import-organization", option: Northfield Roasters}
      - drop_file: {zone: {text: Click to choose a file}, name: Price list 2027.xlsx, fake: true}
      - click: {text: Start import, in: dialog}
      - wait_for: {text: 921 offers created, timeout: 10}
        mark: import-done
      - hold: 2
  - interstitial: {text: A few hours later, duration: 2.6}
```

**Scenario keys:** `video`, `title`, `intro` (`false` or `{component, params, duration}`), `outro` (`false` or
`{component, params, tagline, url, duration}`), `env`, `vars`, `setup`, `teardown`, `hooks` (named hooks `hook:` steps run
during the take, see [Hooks during the take](#hooks-during-the-take)), `capture`, `frame` (default for
every scene, see [frames](#components-in-scenarios)), `template`, `pacing`, `music` (`{file, volume, duck, loop}`, see
[the music bed](editing.md#music-bed)), `target_length` (`{min_s, max_s}`: the length this video aims at — the review's
`video-length` rule uses it instead of the reference 60–120 s), `caption_component` (the caption component of the whole
video, see [components in scenarios](#components-in-scenarios)), `scenes`.

**Scene keys:** `id`, `caption` (string or `{kicker, text}`), `page`, `open`, `persona` (the account the page is
signed in as, `none` for none: see [Signing in](environments.md#signing-in-personas-and-sessions)), `steps`, `speed` (edit-time),
`still` (seconds still at the start, default 1.6), `cursor` (where the cursor rests at the start, see below),
`transition` (`crossfade`, `cut`, `fade-black`), `frame` (a frame style or a layout component id), `irreversible`,
`skip`, `offscreen` (played during the take but left out of the video: a scene that only brings the product to the
state the next one films — an edit value, a render on the same take can toggle it), `note`. A scene without `page` continues on the previous scene's page; a scene without `open` continues from
the current state. Two other entries take no capture time (the editor shows them between the clips around them):
`interstitial: {text, kicker, duration, component, params}` (a "time passes" card; `style` is the legacy template
style override) and `card: {component, params, slots, duration}` (a full-screen title / chapter / quote card), each
with an optional `id` (default `interstitial-<n>` / `card-<n>`, `n` = position in `scenes`). Ids are unique across
scenes, cards and interstitials. A card or an interstitial without a `duration` stays long enough to read its text
(L5.5): about 250 words a minute plus 1.5 s for its entry and exit, never less than its component's default and
within its min / max (`studio/card-title` 2.5 s, 1–10 s); the review warns (`card-too-short`) when a card is shorter
than its text needs.

**What a scenario opens.** A scene's `open`, each `open` of a multi-page scene's `pages`, an `open` step and a
`new_tab` step's `href` take a path of an environment page (`/quotes`, `quotes/1`, `?tab=2`; in `pages`, also
`<page>:/path`) or a full URL that is `http:` or `https:` — or exactly `about:blank`. Any other scheme (`file:`,
`data:`, `javascript:`, `blob:`, `view-source:`, `chrome:`, `about:srcdoc`…) and a URL holding sign-in details
(`user@`, `user:…@`) are validation errors at the field, in any case and with leading spaces or tabs (the URL is read
as the browser reads it), and so is a scheme whose rest a browser cannot read (`http://exa mple/`): write the page's
http(s) URL or a path, and let a persona sign in (see [Signing in](environments.md#signing-in-personas-and-sessions))
— a staging site behind HTTP authentication takes them in its environment page URL instead (see
[Security](security.md)). In `pages`, a `<page>:` prefix must name a page of the environment. A templated value (`open: "{{vars.start}}"`) is
checked once rendered and resolved against its page, when the step runs: a refused URL fails the step before the page
loads (and `capture.prewarm` does not visit it). When a `new_tab` click opens no tab and the runner follows the clicked
link's own `href`, that link may go to any `http:` / `https:` site (or a `blob:` document of the page's own origin);
any other scheme fails the step. A scenario run through MCP or the Studio also opens only its environment's own
origins (see [MCP](mcp.md)). These rules cover what the runner opens: a redirect, or a link the page follows itself,
may lead elsewhere. Whatever starts it, the capture browser itself never loads a `file:` URL.

**Scene-start cursor** (`cursor:` on a scene):

| Value | Where the cursor rests during the still |
|---|---|
| `auto` (default) | A neutral spot next to the scene's first pointer target (the element the first click, hover, select… travels to; its position after leading `scroll` steps is predicted), next to where it will be clicked, never covering it, inside the viewport and inside the dialog that holds it, preferably over a non-interactive area. Without such a target: the right-centre of the screen. A scene that continues from the current state keeps the cursor where it is when it is already clear of that target and within 240 px of where it will be clicked; otherwise it glides next to it |
| `keep` | Where the previous scene left it |
| `{x: 1500, y: 540}` | That viewport point (CSS px) |
| a target, e.g. `{text: New import}` | On that element, as a hover would (`{text: auto}` for an element whose text is "auto") |

The capture never shows the cursor jump: a scene that opens a page places it while the page loads (the editor cuts
that part); a scene that continues from the current state glides there, eased, during its still. The choice is
recorded as `data.cursor` of the scene's `scene_still` event.

**Full page loads.** A navigation to another document — a link, a form, `open`, a new tab, a redirect — shows nothing
of the new page until it has painted content of its own (text, an image or an SVG: its first contentful paint). The
capture keeps the previous picture meanwhile, so a blank page, an app's empty shell or a skeleton without text is
never filmed; a drawn cursor appears with the first painted picture. The runner waits for that paint before the next
step and before a scene's still (in a multi-page scene, for every page it films): a step that navigated — a click,
an Enter, `open` (also with `wait_until: commit`), a new tab — ends with the new page painted, so its `hold`, its
`park` and a `wait_for` right after it start on the painted page. A page that never paints content (only solid
colours) is shown 3 s after its network went idle (a PDF: 0.5 s); one that paints nothing within 10 s is shown as it
is from then on, with a run warning. A new tab or page still blank (nothing opened in it yet) is not waited for — the
step that opens a page there is what fills it —; it is not shown until that page paints (a run warning after 10 s).
Ctrl-C does not wait for a held load. Each held load is in `timeline.loading`; the edit and the raw export cut it
(a multi-page scene's pages share their timing: a load held on one page is not cut while another page acts — that
page keeps its previous picture meanwhile). What the app shows once it has painted — a spinner with a label, a table
filling in — is the product: wait for its result with `wait_for`.

### Actions

Every step has exactly one action; shorthand forms are shown first.

| Action | Example | What it does |
|---|---|---|
| `open` | `open: /settings` · `{url, page, wait_until}` | Navigate the current (or given) page |
| `click` | `click: Save` · `{text: Save, in: dialog}` | Cursor travels, hovers, presses; popup-aware fallbacks. A click that changes nothing within about a second — no request, DOM change, navigation, dialog, new tab, download, nor a field taking the focus — is reported at once with a screenshot (see [When a take goes wrong](#when-a-take-goes-wrong)); `retry_click: true` clicks once more |
| `click` (outside) | `click: {outside: true}` | Close the open popover by clicking the dialog title or a blank area; with a listbox open over a floating popover, the listbox closes first (a click on the popover's title), the popover on the next one |
| `double_click` | `double_click: {text: Report.pdf}` | Double click |
| `hover` | `hover: {text: Pricing, ms: 900}` | Move onto an element and rest |
| `type` | `type: {into: {label: Email}, text: hi@example.com, cps: 12, clear: true, enter: true}` | Type character by character (`fill: true`: the whole value at once, as a browser autofill — one input event and a change event, `data.rate: fill`; not with `cps`); without `cps` the rate adapts to the field (search ≤ 10, long text up to 24; `data.rate`); `clear` selects all + deletes, and when the field still holds text (select-all blocked, a React input that restored its value) uses the native value setter + an `input` event (`data.clear`); an editor the runner cannot read (in a frame from another origin, or typing into a hidden input: CodeMirror 5, Monaco) gets the keys only, unchecked. With `into`, the field is brought into view inside its own scrolling containers (a scrolling dialog included) and clicked once its box stopped moving; the step fails before typing anything when the focus did not land in the field (the error names what got it), and warns when the field's value does not hold the text typed afterwards |
| `press` | `press: Enter` · `{key: ArrowDown, times: 3}` | Press a key (Playwright key names) |
| `select` | `select: {field: Country, option: Sweden, search: Swe}` · `{combobox: "#country", option: …}` | Native select or combobox listbox. `search` is typed in the list's search field before the option is looked for; without it, an option the open list does not show (a long list that renders its first entries only) is typed there by itself after 0.8 s (`data.searched`). The search is typed at the search pace (at most 10 characters a second); `search_cps` sets its own, `search_instant: true` fills it at once, as a paste (one input event: the list filters once, only its final state is filmed) — not both |
| `pick` | `pick: {field: Bag sizes, option: [1 kg, 5 kg], search: kg, close: outside}` | Multi-select popover, closed without Escape; `search` as for `select` (without it, the first option's text is typed when it does not show); only what the step opened is closed (a popover holding the field stays open) |
| `menu` | `menu: {row: Iceland, item: Pause, confirm: Pause}` · `{trigger: …, item: …}` | Row action menu, optional confirmation. The trigger: an `aria-haspopup` element, a button named like a menu, else the row's last button; actions shown on hover are revealed by hovering the row's right end; a row without any button: the clickable element at its right end, else its top-right corner (warned: give `trigger:`) |
| `date` | `date: {field: Delivery window, day: [10 January 2027, 24 January 2027]}` · `date: 14 March 2027` · `{next, previous, close}` | Date picker: waits for a previous date popover to close, opens the field, pages months with the calendar's **last visible** month button — a button or an element classed next / prev above or beside the days, never one below them nor a form's submit (a wizard's Next) — (the first click ordinary, the next ones quick presses ~110 ms apart, each with its ripple; runs of 5+ play at up to 3× in the edit), clicks each day by its aria-label or date attribute (ISO or English dates with a year, compared as dates: "1 January 2027" never picks "11 January 2027"; a day without a year or written another way — `10/01/2027`, another language — is matched as words of the labels, so `1 January` does not match "January 1st", and is warned at validation), then closes what it opened (`close: auto` waits for it to close by itself, else clicks outside). A native `<input type=date>` is filled in place (a day outside its `min` / `max` fails the step) |
| `scroll` | `scroll: 560` · `{to: {text: Awards}, offset: -140, duration: 2.2, in: …}` · `{by: 400}` | Animated scroll of the page or a container (a target ends 140 px below the top by default) |
| `drag` | `drag: {from: {text: Card A}, to: {text: Done}, duration: 1.2}` | Press, eased move, release |
| `drop_file` | `drop_file: {zone: {text: Drop files}, path: assets/list.xlsx, from: right}` | The cursor fetches the file at the screen edge, a file "ghost" travels to the zone, then a real drop (or the hidden file input) |
| `wait` | `wait: 0.8` | Sleep (may be trimmed by the editor) |
| `wait_for` | `wait_for: Saved` · `{not_text, target, gone, url, network_idle, timeout}` | Wait until a condition holds (checked every 100 ms; `url`: a substring or a `/regex/`). `network_idle: true` waits until the page has had no request in flight for 0.5 s, counted from the step — so a request the previous click started is waited for; a page that never goes quiet (long polling, a request that hangs) times out, naming what is still loading. The requests of a document that went away (a navigation, a removed frame) are not waited for, nor a response body still open 1 s after its headers (a fire-and-forget call whose answer the page never reads); a worker request of a removed iframe still is (BACKLOG BL-71) |
| `hold` | `hold: 2` | Stay still; never trimmed by the editor |
| `assert` | `assert: {text: €720.00}` · `{url, title, gone, count: {target, equals}}` | Fail with a screenshot unless true |
| `screenshot` | `screenshot: proposal` · `{name, full_page: true}` | PNG in `runs/<id>/screenshots/` |
| `new_tab` | `new_tab: {target: {text: Download PDF}, as: pdf}` · `{href: /report}` | Follow a link into a new tab and keep recording |
| `switch_page` | `switch_page: previous` · `{to: admin, close_current: true}` | Change the recorded page: `previous`, `main` (the environment's first page), an environment page key or a `new_tab` `as` id; `close_current` closes the page left |
| `eval` | `eval: "document.body.classList.add('demo')"` · `{file: hooks/setup.js, arg: …}` | JavaScript in the page (function body) |
| `notify` | `notify: Capture finished` · `{title, message}` | Desktop notification |
| `emit` | `emit: {name: chapter, data: {n: 2}}` | Custom event in the timeline |
| `cursor` | `cursor: hide` · `{move: {x: 1500, y: 540}, duration: 0.8}` · `{set: {x: 0, y: 0}}` | Show, hide, move or teleport the cursor |
| `wait_for_email` | `wait_for_email: {to: noa@cafe.example, subject: Confirm, timeout: 20, as: welcome}` · `{to: persona:buyer, …}` | Wait for a new message in the project's test mailbox and capture it (artefact `email: welcome`); `persona:<name>` is that persona's `email` — see [Mails, documents and notifications](#mails-documents-and-notifications) |
| `download` | `download: {click: {text: Download quote PDF}, as: quote, timeout: 30}` | Real click, then capture the file it produces — a download, or a document opened in a new tab (fetched with the session) — as artefact `document: quote`; PDFs are rasterised page by page. A transfer that breaks on the network (socket hang up, reset, timeout, 502 / 503 / 504) is fetched again, 3 attempts in all; a real error (another HTTP error) fails at once |
| `hook` | `hook: mark-paid` · `{name: mark-paid}` | Run a named hook of the scenario's `hooks:` (else project.yaml's) now, during the take and off camera: the page stays as it is and the edit cuts the step's span — see [Hooks during the take](#hooks-during-the-take) |
| `capture_text` | `capture_text: {target: {testid: proposal-total}, as: total, pattern: "/(€\\s?[\\d.,]+)/"}` | Read the element's visible text (a field's value) — or the part the pattern's first group selects — as artefact `capture: total` for a key-figure card; polled until the pattern matches (up to the step timeout); no cursor move — see [Tutorial overlays and story cards](editing.md#tutorial-overlays-and-story-cards) |

**Step modifiers** (on any step): `id` (for `--until` and references), `caption`, `speed` (edit-time),
`hold` (seconds still after the step), `mark` (named marker), `camera` (zoom hint:
`{zoom: 1.3, target: {text: Awards}, ease: slow, duration: 1.2, until: scene_end}`), `overlay` (an overlay component
over the clip: `{component, slots, params, duration, target}`, see below), `tutorial` (this step's tutorial overlays,
e.g. `{spotlight: false}` or `false`, see [Tutorial overlays](editing.md#tutorial-overlays-and-story-cards)), `timeout` (seconds;
default: the scenario's `defaults.timeout_s`, else the project's, else 15 — 30 for `wait_for_email` and `download`),
`optional` (a failure does not abort; it is listed in run.json `optional_failures`), `retry_click` (`click` /
`double_click`: a click that did nothing is made once more, and a second dead click fails the step), `irreversible`
(never executed in dry runs), `park`, `note`. The runner
measures the `camera` and `overlay` targets at the **end** of the step — after a `scroll`, the box is where the
element ended up.

`park: true` (or a number of seconds) parks the cursor after the step, then holds it still: after a `scroll` to a
target, next to the target and clear of its text (`pacing.park_scroll_hold`, 3.2 s); after any other step, away
from what changed on the page since the last action started — added, removed or restyled elements, and the element
the action used — (`pacing.park_hold`, 2 s; the step's `hold` when given). On a `hold` step the cursor parks first,
then the hold runs. A park never leaves an open menu or listbox the step opened (by a click or by hovering). Off unless a step asks for it.

When a select, pick or menu trigger opened nothing (no popup, not `aria-expanded`), the runner clicks it once more
after 3 s; a popup that opened but is still filling is left alone, and a search is typed once, as soon as there is a
field to type into. An option that is not found in a list that has a search field fails saying so (`add search: …`, or that
the search typed matched nothing).

**Click options:** `strategy` (`auto` · `real` · `dom` · `pointer`), `expect_popup`, `outside`, `hover_ms`,
`after_ms` (also replaces the `after_navigation_ms` minimum), `move_ms`, `button`, `modifiers` (`[Shift]`), `offset`
(`{x, y}` from the element's top-left).

**Step defaults:** `defaults: {timeout_s: 30}` in project.yaml or a scenario (the scenario's win) sets the timeout of
every step that has none of its own — the targets of every action, `wait_for`, `wait_for_email`, `download`, the
commit of a navigation a click starts (at least 15 s) — for a product whose actions take long (a PDF generated on the
server). `assert` keeps its 2 s grace unless the step sets `timeout`.

### When a take goes wrong

A take fails early, loudly and completely rather than "succeeding" with a wrong video:

- **Every missing target of the scene at once.** When a step's target is not found, the error also lists the targets
  of the scene's later steps (up to the first step that opens another page) that are not on the page either — looked
  up without acting — each with the closest visible elements (role, name, text): five renamed labels show in one
  failed take. In run.json: `error.missing_targets[]` (`{scene, step, action, target, near: [{role, name, text}]}`);
  some may only appear after the steps before them (a dialog the next click opens).
- **Targets behind a modal dialog are not used.** While a modal dialog is open (`:modal`, `aria-modal`, or the rest of
  the page `aria-hidden` / `inert` as dialog libraries leave it), a target that also matches inside the dialog — or in a
  listbox or menu above it — is never taken from the page behind it (`in: page` searches the whole page).
- **`type` into the right field, or not at all.** `type {into}` scrolls the field into view inside its own scrolling
  container, waits until its box stops moving (a smooth scroll, a dialog still opening, a layout shift), scrolls a field
  a sticky header or footer covers towards the middle, then clicks; when the focus did not land in the field, the step
  fails before typing, with a screenshot, naming the element that got the focus. After typing, a field whose value
  does not hold the typed text warns (`after typing "300" into spinbutton "Quantity", the field holds "3"`); a value
  that only differs by the page's formatting (thousands separators, a phone mask) passes, a password field's value is
  never shown (lengths only), native date / time inputs are not compared.
- **Dead clicks are reported at once.** A plain `click` / `double_click` is watched from its press: a request, a DOM
  change (in every frame and shadow root; the cursor overlay ignored), a navigation, a dialog, a new tab, a download, an
  `input` / `change` / `submit` / `scroll` / `toggle` event or a field taking the focus counts as an effect. Nothing
  within 1 s: a warning right away (the next steps go on — a `wait_for` that follows is not the one that reports it)
  with `screenshots/dead-click-<scene>-<step>.png`. `retry_click: true` on the step clicks once more instead and fails
  the step when the second click did nothing either. A click that opened a popup or changed the page is never dead;
  the next acting step starts once the check of the previous click is over (at most 1 s after its press).
- **Transient download failures are retried** (above); a mail that never came lists what did come (below).
- **Failed `optional` steps are listed** in run.json `optional_failures` (`{scene, step, action, error, screenshot}`),
  by `retake run` under the summary and by `run_status` over MCP — not only among the warnings.

### Components in scenarios

Everything visual in the edit is a **component** with an id `namespace/name` (lower-case letters, digits and `-`,
e.g. `studio/intro-stack`): the built-in library uses the `studio/` namespace, your workspace `components/` folder
your own. The theme picks a default per kind (see [Themes](themes-and-components.md#themes)); a scenario overrides it per use:

```yaml
intro: {component: studio/intro-minimal, duration: 2.4}
outro: {component: studio/outro-stack, tagline: "Your catalogue, under control.", url: example.com}
frame: browser                       # every scene; a scene can set its own `frame`
scenes:
  - card: {slots: {kicker: Step two, title: Ask the roaster for a quote}, duration: 2.2}
    id: chapter-request              # cards and interstitials take no capture time
  - id: proposal
    frame: acme/tablet-frame         # a layout component of the workspace
    steps:
      - wait_for: {text: "€720.00"}
        overlay:                     # shown from the end of the step, at most 30 s
          component: studio/overlay-callout
          slots: {text: "Total incl. VAT, ready to accept"}
          duration: 2.5
          target: {testid: proposal-total}   # default: the step's own target, else the cursor
  - interstitial: {text: A few hours later, component: studio/interstitial-plain, params: {tone: dark}}
```

| Key | Where | Value |
|---|---|---|
| `frame` | project, scenario, scene | `raw`, `card`, `browser`, `laptop`, `phone`, `tablet` (= `studio/layout-<style>`), `split`, `pip` (multi-page scenes: `studio/layout-split`, `studio/layout-pip`, see [several pages at once](#several-pages-at-once)) or a layout component id; default `card` (project) |
| `intro` / `outro` | scenario | `false`, or `{component, params, duration}` (+ `tagline`, `url` for the outro), or **your file**: `{video \| image \| lottie, from, to, fit, background, volume, duration}` ([your own media](themes-and-components.md#your-own-media-and-motion)) |
| `interstitial` | scene entry | `{text, kicker, duration, component, params}`, or your file (as the intro) |
| `card` | scene entry | `{component, params, slots, duration, transition}`; needs `component`, `slots.title` (the theme's card component shows a title) or your file (`video`, `image`, `lottie`) |
| `overlay` | step modifier | `{component, slots, params, duration (0 < s ≤ 30), target}`, or your file over the capture: `{video \| image \| lottie, at, anchor \| rect, scale, duration, loop}` |
| `transition` | scene, card | the transition INTO it: `crossfade` · `cut` · `fade-black` (the theme's of that kind) or a transition component — `studio/transition-tap-open` or `{component, params}` |
| `caption_component` | scenario | the caption component of every clip, e.g. `studio/caption-overlay` (default: the theme's). `retake plan` / `retake render`, MCP `plan_preview` / `render` and the Studio read it the same way; a render's `overrides.components.caption` (MCP `render {overrides}`) wins over it and `captions: false` still turns captions off. An edit value: a render of the same take uses it, no new capture |

No component is ever mandatory: a file given as `video`, `image` or `lottie` is drawn by the built-in `studio/media` /
`studio/lottie` components — see [your own media and motion](themes-and-components.md#your-own-media-and-motion).

Slots are the texts a component shows (`title`, `kicker`, `text`…); params tune it (see the component's params
schema). The run records cards in `timeline.json` (`kind: card`), each overlay on its step event
(`overlay: {component, slots, params, duration, target, bbox | point}`) and the scenario's `title`, `intro`, `outro`,
effective `frame`, `template` and `music` under `video`, so the editor never re-reads the scenario.

### Targets

A plain string is visible text — or a CSS selector when it looks like one (`#id`, `.class`, `[attr]`,
`li.active`, `nav > a`).

| Key | Example | Matches |
|---|---|---|
| `text` | `{text: Save}` | Visible text: exact first, then case-insensitive substring (the page's own matches decide the tier: an exact match inside a frame does not beat a partial one on the page) |
| `contains` | `{contains: [Finca Quenaro, "2026"]}` | Innermost element containing every string |
| `role` + `name` | `{role: button, name: Request a quote}` | ARIA role (explicit or implicit) and accessible name |
| `label` | `{label: Delivery window}` | Form control by its label (`for`, wrapping label, `aria-labelledby`) |
| `aria` | `{aria: Notifications}` | `aria-label` |
| `placeholder` | `{placeholder: Search coffees}` | Placeholder attribute |
| `testid` | `{testid: save-button}` | `data-testid` |
| `css` | `{css: "table tr:nth-child(2) button"}` | Raw CSS selector |
| `in` | `{text: Save, in: dialog}` · `in: {row: Sweden}` · `in: {css: aside}` | Scope: `dialog`, `menu`, `listbox`, `popover`, `page`, a row, or a target |
| `nth` | `{text: Edit, nth: -1}` | Index among visible matches (negative from the end) |
| `last_visible` | `{role: listbox, last_visible: true}` | The most recently mounted visible match (calendars: a popover's month buttons come after the page's — prefer `date`, or `{aria: Next month, last_visible: true}` with plain clicks) |
| `exact` | `{text: Save, exact: true}` | No substring fallback |

Only visible elements count (not hidden, transparent, clipped or off-page); a match is promoted to its clickable
ancestor. When a target is not found, the error lists the nearest visible texts and saves a screenshot and a DOM
snippet next to the run.

Web components and iframes count as part of the page: targets are found inside **open shadow roots** and inside
**same-origin iframes** (nested ones too), and the cursor, its icon, clicks, typing, `select` on a native `<select>`
and scrolling (inside the frame first, then the page) work there as anywhere else. Matches are counted in visual
order: a component's content right after its host, a frame's content where the frame sits — so `nth` and
`last_visible` see them too. A `css` selector is matched inside each tree on its own and never crosses a component
or frame boundary; to search only inside one, scope it: `in: {css: my-widget}` or
`in: {css: 'iframe[title="Shipping estimate"]'}`, and `scroll: {in: {css: iframe}}` scrolls inside the frame.
Out of reach: **closed** shadow roots and **cross-origin** iframes (payment or chat widgets) — the not-found error
says how many cross-origin frames it could not search. `drop_file` onto a zone inside a frame delivers the file
through the zone's `<input type=file>` (no drag events into frames). See the fixture's `embedded` scenario.

### Templating and hooks

Strings in scenarios and hooks accept `{{page}}` (an environment page base URL, e.g. `{{console}}`), `{{vars.x}}` or
`{{x}}`, `{{env:VAR}}`, `{{keychain:service/account}}` (macOS Keychain, Linux `secret-tool`), `{{run.id}}` /
`{{run.dir}}` (the run folder: hooks of `retake hooks run` have no run folder, only `{{run.id}}`),
`{{hooks.<save_as>.json.id}}` (an earlier setup hook's response) and, inside an http rollback, `{{response.json.id}}`.

**Every string of a scene is templated** — typed text, targets (`click: "Open {{vars.customer}}"`), `wait_for` /
`assert` texts and URLs, `open`, `new_tab`, `select` / `menu` options, `notify`, `emit` data, `wait_for_email`
filters, captions, overlays, page labels, cards, interstitials — and so are the video's `title`, `intro`, `outro` and
`tutorial`. A scene is templated when the run reaches it, after the setup hooks (so `{{hooks.…}}` works in steps and
captions; a dry run skips the hooks: add `--hooks run`, else the run stops on the first `{{hooks.…}}` with that
hint). The timeline records the values, never the tokens. Not templated: names (ids, marks, `on`, `as`, page keys, an
`emit` name, a `screenshot` name) and `note`s; `eval` is templated when it runs, its `file` included. Values are
inserted as they are (not URL-encoded in a URL, not escaped in a `/…/` pattern); a string target is read after
templating, so a value that looks like CSS (`#row-1`) is a CSS target. An unknown key is a validation error, and so
is a `{{…}}` inside a `vars` value (vars values are not templated: they would be inserted as written).

```yaml
setup:
  - name: seed-customer
    http:
      method: POST
      url: "{{admin}}/api/customers"
      json: {name: "{{vars.customer}}"}
      headers: {authorization: "Bearer {{env:STAGING_TOKEN}}"}
      expect: 201
      save_as: customer
      rollback: {method: DELETE, url: "{{admin}}/api/customers/{{response.json.id}}"}
  - sql: hooks/unlock-registry.sql             # *.sql = a file of the project; anything else is inline SQL
    confirm: true                              # required: the file contains UPDATE
  - shell: {run: "pnpm run seed --small", cwd: ../app, timeout: 120}
  - js: {code: "localStorage.setItem('tour-done', '1')", page: app}
teardown:
  - http: {method: POST, url: "{{admin}}/api/demo/reset"}
```

**Hooks of a sandbox environment** also read the sandbox itself: `{{compose_env:NAME}}` is the value `NAME` has in
its compose env file, `{{accounts.<persona>.username}}` and `{{accounts.<persona>.password}}` are an account of its
sandbox.yaml (a `{{compose_env:…}}`, `{{env:…}}` or `{{keychain:…}}` one resolved as its login steps get it). Both are
masked like any secret and stay in template form in a rollback's journal entry (read again when it replays); on
another environment they are an error that says so, and in a scene they are refused (they belong to hooks).
`auth: {persona: <name>}` on an http hook (or its rollback) sends the request as that persona: the cookies its saved
session holds for the URL (`Cookie`) and, for a product signed in with Firebase Auth, the ID token of its signed-in
user (`Authorization: Bearer …`, read from the session's IndexedDB or localStorage, refreshed by loading the product's
page when it is about to expire). The run signs the persona in like a filmed one (checked by the preflight, its own
browser) even when no scene films it; `retake hooks run` opens a headless browser on a copy of its session. Not with an
`Authorization` or `Cookie` header of its own, and not in a sandbox seed (nobody is signed in yet: sign in with the
product's API and `{{accounts.<persona>.password}}`, save the token with `save_as`). Work submitted through MCP or the Studio's
agent path sends a persona's session only to that persona's own pages: the hook's URL must have the origin of a page
the persona signs in to (`{{<its page>}}/…`), else the hook is refused before it runs.

```yaml
# a sandbox environment: approve the sign-up as the admin, then answer as the owner
setup:
  - name: approve
    http: {method: POST, url: "{{admin}}/api/sign-ups/42/approve", auth: {persona: admin}}
  - name: owner token                          # without a saved session: the product's own sign-in
    http:
      method: POST
      url: "http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={{compose_env:FIREBASE_API_KEY}}"
      json: {email: "{{accounts.owner.username}}", password: "{{accounts.owner.password}}", returnSecureToken: true}
      save_as: owner
  - http: {method: POST, url: "{{app}}/api/threads/7/replies", headers: {authorization: "Bearer {{hooks.owner.json.idToken}}"}, json: {text: Hello}}
```

Hook kinds: `http` (`method`, `url`, `headers`, `json` or `body`, `expect`, `auth`, `save_as`, `rollback`), `sql` (`file` or
`query`, `db`, `rollback`), `shell` (`run`, `cwd`, `env`, `timeout`, `rollback`), `js` (`code` or `file`, `page`,
`rollback`). A SQL or JS hook file that does not exist in the project is a validation error. Common keys: `name`, `confirm`, `destructive`, `optional`, and `writes: false` on a shell hook that only reads (it may then run on a read-only environment). Setup stops at the first failure and rolls
back what it did; teardown hooks always run (even after a failure — of a step or of the setup itself — or Ctrl-C),
then the pending setup rollbacks are replayed, most recent first. Ctrl-C (or SIGTERM) during the setup stops it at
once: a shell hook's process group gets SIGTERM (SIGKILL 2 s later; an http, sql or js hook running then ends first),
the next hooks do not run, the completed ones are rolled back (rollbacks are never interrupted), then the teardown
runs. A second Ctrl-C quits at once and kills the shell hooks still running; what was not rolled back stays in the
run's journal for `retake hooks rollback`.

A shell hook runs with `RETAKE_PROJECT_DIR`, `RETAKE_ENV`, `RETAKE_RUN_ID`, `RETAKE_ALLOWED_HOSTS` and its own `env:`
on top of the environment it inherits. From a terminal it inherits the command's whole environment. In a job the
Studio, the desktop app or an MCP client starts it inherits only the shell's own variables (`PATH`, `HOME`, `USER`,
the locale, `TZ`, proxy and certificate settings) and the names project.yaml lists in `pass_env:` — so a token
exported in the terminal that started the Studio never reaches it; give it what it needs in `env:`
(`TOKEN: "{{env:STAGING_TOKEN}}"`) or in `pass_env:` (see [Workspace](workspace.md)). When it fails there, its error
names the variables it got and says how to pass another.

A `js` hook runs in a **tab of its own** in the run's browser, opened on its environment page (`page`, default the
first one): cookies, localStorage and IndexedDB are shared with the capture, sessionStorage and page state are not,
and the capture never shows that tab — so a scene must `open` its page (a setup hook no longer leaves the capture on
it, and a teardown hook does not see the scenario's last page). The tab stays open for the whole run and later `js`
hooks on the same page key reuse it: an app left running there keeps working in the background (the fixture's
`quote` scenario keeps its console open that way, polling for the web notification the capture records). Every hook
kind is held to the project's allow-list (see [Security](security.md#security)).

A scenario run through MCP or the Studio is the agent's work, so its shell hooks (`setup`, `teardown`, its own
`hooks:`) — and a project.yaml hook templated with the scenario's `vars` — are held to stricter rules there: they are
shown in full and asked about, and their command, rollback and `cwd` are plain words — letters, digits and
`. / : = @ % + , - _` — separated by single spaces, commands joined by ` && `. No quotes, `$`, pipes, redirections,
`;`, globs, `{{hooks.…}}` values or secrets (`{{env:…}}`); no loader variable (`PATH=`, `NODE_OPTIONS`…), `cd` / `eval`
/ `exec`, a shell's `-c` or inline interpreter code (`node -e`, `python -c`…), `npx`, `git -c`, or a path through
`scenarios/`, `runs/` and the other folders an agent can write, to project.yaml or into `hooks/` (the full list:
[MCP: Claude drives Retake](mcp.md#mcp-claude-drives-retake), *Safety*). Keep such hooks to plain commands with their
values written out — `pnpm run seed --small`, `sh hooks/seed.sh`, `npm run db:reset && npm run db:seed`,
`sleep 1.5`, the hook's `cwd` instead of `cd` — and put anything else in `hooks/<name>.yaml` or project.yaml's
`hooks:`. From a terminal (`retake run`) a scenario's hooks run as written.

#### Hooks during the take

What the product must do at a precise moment of the take without being filmed — a payment marked through its API, a
period moved into the past in SQL, a queue job pushed — is a **named hook** run by a `hook:` step, instead of a side
script polling the database (L5.8):

```yaml
hooks:                         # name → one hook entry, or a list run in order (project.yaml may declare shared ones)
  cafe-requests-a-quote:
    - name: request
      http: {method: POST, url: "{{console}}/api/quotes", json: {product_slug: selowa-ridge, bags: 4}}
    - name: queue
      writes: false
      shell: "sleep 1.5"       # stands for a job queue picking the request up
scenes:
  - id: to-the-list
    offscreen: true            # played, not shown: the video opens on the quote list
    page: console
    open: /products
    steps:
      - click: {role: link, name: Quote requests}
  - id: requests
    steps:
      - hold: 0.8
      - hook: cafe-requests-a-quote    # runs now; the edit cuts this step
      - wait_for: {text: New}
```

- **The same hooks as setup and teardown**: `http`, `sql`, `shell`, `js` entries with their keys, the allow-list, the
  read-only refusals (a read-only run refuses a named hook that writes before anything runs), destructive entries need
  `confirm: true`, and through MCP or the Studio every shell or destructive entry needs a person's approval — bound to
  the entry, its phase (`step`) and its position, asked once whatever the number of steps that run it. A scenario's
  name wins over project.yaml's; validation refuses a step naming a hook neither declares and warns about a named hook
  no step runs, and about a `caption`, `mark`, `overlay`, `camera`, `speed` or `tutorial` on a hook step (the edit
  cuts it).
- **In the take**: the hook runs in the setup's context — `{{hooks.<save_as>…}}` of a setup hook works in it, and its
  own `save_as` in the steps after it —, with the run's cancel (a running shell command is stopped). An entry that
  fails fails the step (an `optional: true` entry is tolerated; the step's own `optional` tolerates the whole hook);
  its rollbacks are journaled like a setup hook's and undone after the teardown. run.json `hooks.steps` says `ok`,
  `failed` or `skipped`; the timeline event's `data` lists each entry's outcome. A dry run skips them unless
  `--hooks run` (`data.skipped`).
- **In the edit**: the step's span (not its `hold`) is cut whole — idle trimming on or off, a mark window included;
  the page may change across the cut (what the hook did shows at once). The raw export cuts it too (reason `hook`)
  and gives an offscreen scene no clip.
- **The filmed part** (L5.5): a `hook:` step is a step like any other, and the named hooks are filmed: a change needs a
  new capture. `offscreen` is edit.

#### Secrets in steps

`{{env:…}}` and `{{keychain:…}}` are secrets: the run resolves every one it will use **before the browser opens**
(a keychain prompt never stalls the capture; a missing variable or item fails the run up front, naming the scene)
and writes `***` instead of their values — raw, URL-encoded (also as the browser writes them in a URL's path or query
and as a GET form submits them), JSON- or HTML-escaped — in `log.jsonl`, `run.json`, `timeline.json` (a URL with a
secret shows `token=***`, in the browser frame of the edit too), `error-*.html` and the terminal (values under 3
characters are not masked). Target descriptions, camera targets, `emit` data and `eval` values are masked wherever
they appear; ids, names, file paths and timestamps are kept as written, so a short secret (a PIN `2026`) never
corrupts them. Captured artefacts (an email, a document, a text) are kept as the app produced them — the description
of the element a `capture_text` read is masked. A secret is a validation error where the video would show it:
captions, overlays, cards, interstitials, scene transitions, page labels, the title.

```yaml
vars: {customer: Harbour Coffee Co., demo_email: agent@northfield.example}
scenes:
  - id: sign-in
    caption: "Signing in to {{vars.customer}}"
    open: /login
    steps:
      - type: {into: {label: Work email}, text: "{{vars.demo_email}}"}      # shown in the video: a var
      - type: {into: {label: Password}, text: "{{keychain:northfield-demo/agent}}"}   # bullets on screen, *** in the files
      - click: Sign in
      - wait_for: "Welcome, {{vars.customer}}"
```

A password field shows bullets; any other field shows what is typed, so typing a secret there warns
(`types the value of a secret reference into a visible field`). For real credentials prefer signing in beforehand —
personas, `retake login`, or their automated `login:` steps off camera (see
[Signing in](environments.md#signing-in-personas-and-sessions)); put values the video may show in `vars`.

## Several pages at once

A scene can film **two pages at the same time** — the buyer's shop and the supplier's console, the same account on a
desktop and on a phone — on one clock, each page with its own recording, viewport and cursor. The video shows them
side by side (`studio/layout-split`) or one over the other (`studio/layout-pip`), both playing from the same source
time: an action on one page is visible on the other as it happens.

```yaml
frame: split                                   # or pip; a single-pane frame picks split / pip from the pages' shapes
scenes:
  - id: request
    pages:                                     # a map: page id → where it opens and how it is filmed
      buyer: {open: "shop:/products/selowa-ridge", viewport: laptop, label: Café · shop}
      supplier: {open: "console:/quotes", viewport: laptop, label: Roaster · console}
    steps:
      - click: {role: button, name: Request a quote}   # acts on the first page (buyer)…
      - on: supplier                                   # …unless the step says which one
        wait_for: {text: New}
  - id: proposal
    pages: [buyer, supplier]                   # a list: the pages of an earlier scene go on (same viewport, label)
    steps:
      - on: supplier
        click: {text: Send proposal, in: {row: New}}

# Lists can also declare pages: the same environment page twice, one of them on a phone.
pages:
  - {id: desk, page: shop, open: /quotes, label: Desktop}
  - {id: phone, page: shop, open: /products/selowa-ridge, viewport: mobile, label: Phone}
```

| Key | Where | Value |
|---|---|---|
| `pages` | scene | a map `id → {page?, open?, viewport?, label?, cursor?}` (`null`: an earlier declaration as it was) or a list of ids (pages an earlier scene declared, else environment pages) and `{id?, page?, open?, viewport?, label?, cursor?}`. Two pages per scene |
| `page` | page | the environment page it starts from (`environments.<env>.<page>`); default the id, or the `x:` of `open: "x:/path"` |
| `open` | page | `"/path"` (on `page`), `"<env page>:/path"` or an absolute URL; omitted for a page an earlier scene already opened |
| `viewport` | page | `desktop` (the capture size, the default), `laptop` 1440×900, `tablet` 820×1180 (mobile, touch), `mobile` 390×844 (mobile, touch, mobile user agent), or `{width, height, mobile?, touch?}`; a page keeps one viewport for the whole run |
| `label` | page | shown above its pane by `studio/layout-split` |
| `cursor` | page | that page's scene-start cursor (as a scene's `cursor`) |
| `persona` | page | the account it is signed in as (default: the persona whose `pages` list its environment page; `none`: none) — one browser per persona, so the supplier and the buyer of one site film side by side ([Signing in](environments.md#signing-in-personas-and-sessions)); a page keeps one persona for the whole run |
| `on` | step | the page the step acts on (default the scene's first page); only inside a multi-page scene |

Validation is positioned (line:column): unknown page ids (with a suggestion), `on:` outside a multi-page scene or
naming a page the scene does not film, a scene with `page` / `open` and `pages`, more or fewer than two pages,
duplicate ids, unknown viewport presets, `new_tab` / `switch_page` inside a multi-page scene, a page id asked at
another viewport than the one it was first filmed at, and a single-page scene that would film a page whose viewport is
not the capture size (its `page`, a `switch_page` / `open` to it, or — without `page` — the first page of the
multi-page scene before it); a page filmed for the first time without `open` is a warning.

**Capture.** The runner opens every page of the scene, emulates its viewport (Chrome DevTools device metrics, touch
and a mobile user agent for `mobile` / `tablet`) and records **one screencast per page**, all on the run's clock; each
is encoded on the shared constant-frame-rate grid as `capture-<page>.mp4` (`frames-<page>/`, `frames-<page>.jsonl`) —
same frame count as `capture.mp4`, so one source frame index addresses every track. A page records only while a scene
films it (it holds its last frame otherwise); single-page scenes record `capture.mp4` exactly as before. Each page has
its **own in-page cursor**: only the acting page's moves; when a step acts on the other page, the runner pauses
`pacing.page_switch_ms` (the eye moves) and that page's cursor glides from where it rests — no cursor ever jumps. A
page with no step of its own in a scene rests its cursor near its centre (a PiP inset sits in a corner: a cursor
resting there would come out from under it). A relative `open` step on a page id resolves against the environment
page that id was declared on, base path included, like the page's own `open`. The
timeline lists the scene's pages (`scenes[].pages`: id, environment page, label, viewport, URL, track), one track per
page (`tracks[]`: file, size, viewport, recorded spans, URL segments, its cursor samples) and tags every event and
marker with its `page`. A single-page scene after a multi-page one continues on its first page (a page with a phone
viewport cannot be filmed by a single-page scene).

**Layouts.**

| id | what it draws (params) |
|---|---|
| `studio/layout-split` | the two pages side by side — stacked top / bottom in vertical, narrow side by side in square (a page wider than its pane is reframed around what it acts on) — each in a rounded card with the reference shadow, or a compact browser window with the page's display URL (`chrome`, on for themes whose layout is a browser window); each page's label above it, the acting page's in the accent colour; the caption below the pair. `margin`, `gap`, `radius`, `shadow`, `chrome`, `labels`, `emphasis: auto \| none \| dim` (auto: the idle page dims a little for balanced / motion themes) |
| `studio/layout-pip` | the main page in a card (or browser window), the other page floating over one of its corners — inside a phone drawn in CSS when it is a mobile page, else a smaller card. The planner picks the corner so the inset **never covers what the main page acts on now or next** (it glides to another corner, at most every 1.2 s, never while its own page acts: a corner the next main-page step needs is reached once the inset's step is over), and keeps it clear of a caption band over the screen; with `emphasis: auto \| grow` (auto: balanced / motion themes) the inset grows ×1.18 while its page acts — less, or not at all, when growing would reach a caption band over the screen (a plan note says so). `width`, `radius`, `shadow`, `chrome`, `inset_height`, `inset_width`, `margin` |

The main page of a PiP is the landscape one (the first page when both are). A scene filmed on two pages with a
single-pane frame (`card`, `browser`…) gets split when the pages have the same shape, else PiP (a plan note says so);
`split` / `pip` asked for single-page scenes falls back to the theme's layout. Each pane has its own camera (the theme's
zoom and the steps' zooms, on their page), reframe and URL; captions, cards, intro and outro are unchanged — except
that a caption band drawn over the screen (`studio/caption-overlay`, `position: over`) goes to the layout's caption
area below a split, where it does not straddle both pages (a plan note says so); the tutorial overlays sit on the pane
of their event's page (an inset's spotlight and step badges stay inside the inset; its key caps and lens, too large
for it, use the main page's room and keep clear of the main page's current and next targets too), the step badges of
a scene are numbered in time order over both pages, and the main page's overlays pass under a PiP inset (clipped
around it). The acting page (label accent, dimmed idle page, grown inset) is the page of the scene's opening still from
the clip's start — a clip joined to the previous one eases from that clip's acting page.
Layout geometry for multi-page layouts declares `panes:` (two rects) or `inset:` beside `screen`, with `aspect2` (the
second page's aspect) next to `aspect` in the expressions — see `packages/components/library/studio/layout-*/component.yaml`.
Contiguous multi-page scenes with the same pages are joined like same-page scenes (the camera and the inset go on).

**Review.** Clicks are placed on their page's pane; the cursor, reframe and tutorial checks run per pane; the still
and freeze comparisons read each page's own track; `overlay-covers-target` warns when key caps, a badge, the loupe or
the PiP inset (bezel included) covers a click target of the current or next step.

The fixture shows both: `projects/northfield-fixture/scenarios/live-quote.yaml` (the café's shop sends a quote request,
the roaster's console — a live list polling every second — shows it arrive, the roaster sends a proposal, the café's
bell — the shop polls its notifications every second — rings with it a second later; `split`) and `phone-and-desktop.yaml` (the request sent from a phone shows up in the desktop's quote list;
`pip`).

## Mails, documents and notifications

A video often needs what happens **outside** the page: the confirmation email that lands, the PDF the product
generates, the notification the app shows. The runner captures them as **artefacts** of the run; components show them,
fed by their name.

**Test mailbox.** `mailbox: {provider, url, poll_ms?, headers?}` in project.yaml points at a test mailbox; its host
must be allowed like a hook's (localhost, an environment host or `allow_hosts`). `provider: mailpit` reads the
[Mailpit](https://mailpit.axllent.org) API (`GET <url>/api/v1/messages`, `GET <url>/api/v1/message/<ID>`, inline
`cid:` images from `…/part/<PartID>`); `provider: http` reads a generic JSON API:

```
GET <url>/messages        → [{id, from, to, subject, date}]   (or {messages: [...]})
GET <url>/messages/<id>   → {id, from, to, cc?, subject, date, text, html}
```

where `from` is `"Name <address>"`, an address or `{name, address}` and `to` a string, a list of those or of objects.
`headers` (e.g. an API token, `{{env:VAR}}` expanded) are sent with every request. The bundled fixture serves a
Mailpit-compatible mailbox at `http://localhost:4401/mailbox` (the fixture project uses it).

**`wait_for_email: {to?, from?, subject?, timeout?, as}`** polls the mailbox (every `poll_ms`, default 500) until a
**new** message matches — one that was not there when the run started (the runner lists the mailbox before the setup
hooks) and that no earlier `wait_for_email` of the run took; the oldest match wins. `to` / `from` match a substring of
the address or the display name (case-insensitive), `subject` a substring or a `/regex/flags`; `timeout` defaults to 30
s (or `defaults.timeout_s`). `to: persona:<name>` is that persona's `email` (`auth.personas.<name>.email`; a sandbox
account signed in with its mail address as `username` has it already), matched as the whole address — validation
fails on a persona without one — and the captured mail remembers the persona: `studio/mail-view` labels its mailbox
after it ("Inbox · Buyer"). When no message matches in time, the error lists the messages that came during the wait
and the earlier ones not captured (subject, sender, recipients) — the mail that went to another address shows there —
or says that nothing came at all. When several new messages match (the same subject sent to several people), a
warning names them and the oldest is taken: narrow the filter. The message is written to `runs/<id>/artefacts/emails/<as>.json` (`{from, to, cc, subject, date, text, html}`,
inline images as data: URLs) and, after the capture, its HTML is rendered in a clean browser — JavaScript off,
offline, a CSP blocking scripts and remote loads — at 600 px layout width, full height, 2× (`<as>.png`).

**`download: {click, as, timeout?}`** clicks the target for real (the cursor travels and clicks) and captures what the
click produces: the browser's download event, or a document opened in a new tab — fetched with the page's request
context (the session's cookies), the tab then closed so the recording stays on the page. The file lands in
`artefacts/documents/<as>.<ext>` (type sniffed from its bytes, else the server's type, else its name); a PDF is
rasterised after the capture with **pdf.js inside Chromium** (no system tool), page by page, at 2× (an A4 page →
1587 × 2245 px) into `artefacts/documents/<as>/page-<n>.png`. A project file works as a document too: a slot
`document: assets/terms.pdf` (PDF, PNG or JPEG) is rasterised by the run that names it.

**Web notifications.** The runner grants the notification permission and the in-page kit reports every
`new Notification(…)` and `ServiceWorkerRegistration#showNotification(…)` called by a page (the page's call goes on
unchanged): title, body, tag, icon (fetched with the session and rendered to a 192 px PNG) and time become
`artefacts/notifications/<name>.json` — `<name>` is the notification's `tag` (else `notification-<n>`) — and a timeline
event `{action: notification, step: -1, data: {name, index, title, body, …}}` in the scene running at that moment.
Notifications a service worker shows on its own (push events) are not seen, nor those of a frame inside the page.
Limits: title, body and tag are cut at 2,048 characters; a run records the first 50 notifications and reads the first
20 icons (a warning says when more came). An icon is a `data:` URL of at most 1 MiB, or an http(s) URL on the notifying
page's origin or one of the environment's, fetched without following a redirect, at most 1 MiB; another icon (another
host or port, a redirect, too large) is not read — a warning, and the artefact keeps its `icon_url`, without `icon`.

**Artefacts in the timeline.** `timeline.json` lists them under `artefacts` (`kind`, `name`, capture time `t`, scene,
step, file, and per kind: email `from`, `to`, `subject`, `date`, `preview`, `image`; document `mime`, `file_name`, `via`
download | tab | project, `url`, `bytes`, `pages` with their size in points; notification `index`, `title`, `body`,
`tag`, `icon`, `origin`, `via`, `time`), so the editor never reads the artefact files.

**Using them in the edit.** Slots of type `email`, `document` and `notification` name an artefact; the planner hands
the component the captured data as `props.media[<slot>]` (images served like every asset) and scenario values still
win over captured ones:

```yaml
steps:
  - click: {text: Create account}
  - wait_for_email: {to: noa@cafe-lumen.example, subject: Confirm, as: welcome}
    overlay: {component: studio/mail-notification, slots: {email: welcome}, duration: 4.5}
  - download: {click: {text: Download quote PDF}, as: quote}
  - hold: 3
    overlay: {component: studio/notification, slots: {notification: quote-request}, params: {style: macos}}
…
- card: {component: studio/mail-view, slots: {email: welcome}, transition: studio/transition-tap-open}
- card: {component: studio/document-pdf, slots: {document: quote, title: "A real PDF"}, params: {motion: zoom}}
- card: {component: studio/document-pdf, slots: {document: assets/terms.pdf}}
```

`notification:` takes a name (the tag) or a 1-based index. Validation checks every `email:` against the scenario's
`wait_for_email` names and every `document:` against its `download` names or the project files (with a suggestion);
the planner warns when the run did not capture a name. An overlay with a `notification` slot starts when that
notification showed (when it is inside the clip), not at the end of its step. An overlay the clip's end cuts short
stays on screen to the last frame (no exit animation), so a **tap-open** transition can open from it.

**Components** (built-in, theme-driven, with committed previews):

| id | kind | what it draws (main params) |
|---|---|---|
| `studio/notification` | overlay | a system notification — `style: macos \| windows \| ios-banner \| android \| in-app` (the last in the theme's own look) — with icon, app, title, body, time; macOS / Windows in the frame corner, the others over the capture (`place: auto \| frame \| screen`), `appearance: auto \| light \| dark`; slides / rises / drops in like the real one. Slots `notification` (captured), `app`, `title`, `body`, `time`, `icon` |
| `studio/mail-notification` | overlay | the same styles fed by an email: sender, subject, first line, a mail glyph on the accent. Slots `email`, `from`, `subject`, `preview`, `app`, `time`, `icon` |
| `studio/mail-view` | card | a mail client window (toolbar, inbox column with the message selected, header with the sender's initials, date) over the rendered email, shown from its top (`scroll: none`, the default since L5.5; `auto` scrolls a tall one slowly), `width`, `sidebar`). Slots `email`, `from`, `address`, `subject`, `date`, `body`, `mailbox` |
| `studio/document-pdf` | card | A4 page(s) with a paper shadow on the theme background — `motion: zoom` (slow push-in to `focus`), `scroll` (pages scroll by) or `static` (a page, or two side by side); `pages: auto \| 2 \| 1-3 \| 1,3 \| all`. Slots `document`, `kicker`, `title` (a column beside the page) |
| `studio/phone-lockscreen` | card | a phone (wallpaper from the theme), date and big time, notifications arriving one by one — newest on top, grouped by app; `notifications: [{app, title, body, time?, icon?}]`, `time`, `date`, `start`, `interval`, `layout: center \| left`. Slots `email`, `notification` (arrive last), `kicker`, `title` |
| `studio/phone-home-badge` | card | a phone home screen whose app icon gets a badge counting up (`from`, `to`, `interval`, `row`, `col`, `badge: system \| accent`). Slots `app`, `icon`, `kicker`, `title` |
| `studio/transition-tap-open` | transition | a touch on the outgoing tap target, then the next segment zooms out of it to the full frame (`duration` 0.8 s, `radius`, `touch`) |

**Tap targets.** A component may declare where its tap target is at the end of its segment — manifest `anchor` (and
`anchor_vertical` / `anchor_square`), `{vars?, x, y, w, h}` in design px, each value an expression over its numeric
params, its string params as one-hot names (`style_ios_banner` is 1 when `style` is `ios-banner`), `frame_w` /
`frame_h` (the format), `screen_x/y/w/h` (the clip's capture rect, for overlays) and `aspect`. The planner evaluates the
outgoing segment's anchor — or that of an overlay still showing at the end of the outgoing clip — and hands it to the
transition (`PlanTransition.anchor`, `props.anchor`): the lock screen's newest notification, the home screen's app icon,
a notification banner. Without one, `studio/transition-tap-open` opens from the centre.

## Recording a scenario

Instead of writing a scenario, a person can **show the flow once**: `retake record` opens a browser window on an
environment page, you click and type through the flow as you would for a colleague, then close the window. A draft
scenario comes out of it, with targets the runner verified at the moment you pressed. Nothing is filmed while
recording: the draft is a starting point you edit, dry-run and capture like any scenario. The Studio's **Record
screen** starts the same recording and is its control panel (picks, quick inserts, Save): see
[Studio app](studio.md#studio-app).

```sh
node packages/cli/dist/bin.js record northfield-fixture my-quote --page shop            # opens the shop's home
node packages/cli/dist/bin.js record northfield-fixture --url http://localhost:4401/imports
node packages/cli/dist/bin.js run northfield-fixture my-quote --dry                     # then check it
```

- **Controls.** Close the window (the last tab) to finish, or press Ctrl-C in the terminal: both stop and **keep**
  what was recorded (a Ctrl-C during the check replay that follows stops the check). The longest recording is 30 min
  (`RETAKE_RECORD_MAX_MIN`): it then stops and keeps. There is no in-page control: nothing is added to the page.
  The window opens at its own size (maximised); a window narrower than the capture is warned and the check replay
  runs at the capture size.
- **What is recorded.** Presses (by mouse or by keyboard) on interactive elements, typing per field (committed when
  you leave the field or press Enter), a few keys (Escape, Enter, arrows, Page Up / Down, shortcuts), selects, file
  choices and drops, scrolls, and page changes. A press is resolved to the target a step would use (`click: Save`,
  `{role: button, name: Increase}`, `{label: Message}`); a dropdown becomes `select` or `pick`, a row's menu `menu
  {row, item, confirm?}`, a file zone `drop_file` (a fake file of the same name: set your own), the typed text a
  `type`, an element you waited for a `wait_for`. Scenes split where the page changed; an address-bar visit opens its
  page (`open:`). Leaving the window in the middle of typing (to look at something else) commits what you typed so
  far; typing on in the same field when you come back still makes one `type` step. Each action also keeps up to three
  other targets that matched the same element when you acted (never one that depends on position, none for a secret
  field), for the Studio's Record screen to offer. Captions are empty and nothing is held: add them.
- **What is never recorded.** Anything typed into a field of a secret kind — passwords, card numbers and codes,
  one-time codes, IBANs, PINs, API keys, a long pasted token, or a value autofill put in — becomes a placeholder
  `type: {into: …, text: "{{vars.password_1}}"}` with `vars: {password_1: CHANGE-ME}` (a project.yaml var of that name
  is used instead): set a **showable demo value**, never the real one (a real secret only as `{{env:…}}`, by hand,
  which makes the scenario CLI-only). A long token pasted **or dropped** into any field makes it secret too. Such a
  value never leaves the page: the recorder remembers the values a secret field was left with (6 characters or more —
  not what it held half-way through typing, so a word a password starts with is not masked elsewhere) and masks them
  everywhere else (a password revealed on screen, pasted elsewhere, a re-mounted field). Also never: query strings
  (except one you typed in the address bar, filtered: keys like `token` and values that look like a token or an
  e-mail address dropped), path segments that look like a token or an e-mail address (masked `•••`, in the paths kept
  and the write labels; an `open:` holding one is warned: put a demo value back), coordinates, frames, pages of other
  sites or sign-in pages (their stretch is left out, with a warning), other tabs or pop-ups, and Space / Backspace /
  Delete pressed in a field the page hides in a closed shadow root. A field's initial value is never recorded on its
  own: text you add at its end is recorded alone, but after an edit inside a prefilled field the step types its whole
  final value (`clear: true`), which includes what you kept of the initial text. Text you typed that holds a `{{…}}`
  template (which a scenario would resolve: a var, an environment variable) is left out, with an issue at its place.
  The recorder runs in an isolated world: the page cannot see it or feed it events.
- **Writes.** The window is a real session with the environment's own access, as a run: on a production / read-only
  environment writes are stopped or answered by a mock (as in a dry run); on a read-write one (local, staging) your
  writes reach the product — each is listed after the recording, whatever its host (an API on another host, a form
  post, a beacon), attached to the step that caused it within 2 s (`note: sends POST shop:/api/quotes`), with the
  advice to add a setup or reset hook so each take starts from the same data.
  `--allow-writes` as for `retake run`. Hooks never run while recording.
- **Signed in.** The window uses the page's persona (or `--persona`, `none` signed out): a session that expired signs
  in again off camera when the persona has `login:` steps, otherwise the recording is refused before any window opens,
  with the `retake login` command.
- **After recording.** The summary lists scenes and steps, issues in the order they came, each at its place
  (`scene.step: …`, the step it is about or the one that came next: a target only found by its text, a secret field, a
  fake file, a page opened from the address bar, a write no action caused…), writes, and the **check replay**: a
  headless dry run of the draft at the capture viewport, up to the step before the first one a write that reached a
  server followed — whatever its host and however long after (nothing is written twice; on a read-only environment the
  writes stopped or mocked do not count, so it usually replays the whole draft); it starts from the state the
  recording left the product in. The draft is validated with the project before it is saved or checked. The draft is
  saved as `scenarios/<name>.yaml` when that name is free (default `recorded-YYYYMMDD-HHMM`; an existing scenario is
  never overwritten), and always kept with the recording in `<project>/.retake/records/<id>/` (`draft.yaml`,
  `record.json`, `events.jsonl`, `meta.json`; private files; the newest 20). Exit 1 when nothing was recorded, the draft does not
  validate or the check failed. `--json` prints the outcome; `--no-check` skips the replay.
- **Through Claude.** `scenario_record` (MCP) starts the same recording as a job: the window opens on the machine the
  worker runs on and **you** perform the flow — Claude never drives the window, types in it or sees keystrokes live.
  It tells you what to do, waits on the job (the window holds the job queue, so it starts nothing else meanwhile), then
  reads the draft: what you typed and the page's names come back to the conversation as untrusted data, counts and the
  check as trusted fields; a value typed into a secret field never does. Claude then inspects flagged steps, fixes,
  validates and dry-runs. Cancelling the job while the window is open discards the recording; stopping the worker
  keeps it (without its check replay).
- **Limits** (BACKLOG BL-74): tabs, pop-ups and frames are not recorded (a new tab is warned); a date picker, a drag
  or a hover-to-reveal is recorded as plain clicks (or not at all for hover); alternative targets are offered by the
  Studio's Record screen only (not for a `pick`, a `menu` or a select by field — BL-118); on a page with ~10,000
  controls a press takes ≈ 0.2 s to resolve, then falls back to its text. Typing not yet committed when the window
  closes is best effort.
