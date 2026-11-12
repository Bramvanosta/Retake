# Backlog — unprioritised

The MVP scope is **locked** (2026-10-12) to the lots in `docs/ROADMAP.md`. Every new idea lands here instead of in a
lot. Items are **not ordered by priority**: they are grouped by area, and the IDs only make them easy to cite. Moving
an item into a lot is the founder's decision. Efforts are rough (S/M/L/XL, same scale as the roadmap).

**Retake was called Demo Studio before L5.13** (command `studio`, home `~/.demo-studio`, workspace file `studio.yaml`, variables `DEMO_STUDIO_*`): every name in this file is the current one, entries written before L5.13 included (rewritten mechanically by `scripts/rename-l513.mjs`). <!-- old-name: the history line -->

Sources: the founder's ideas, the earlier V2 component candidates (ROADMAP row L6), a multi-lens product review
(market, architecture, users, legal, cloud-first and local-only advocates) and a competitive study
(`docs/COMPETITION.md`), with their third-party claims fact-checked on 2026-10-12.

Also in this file: [guard-rails for planned lots](#guard-rails-for-planned-lots-no-new-scope) (cheap rules so the
backlog stays reachable), [recorder precisions](#recorder-precisions-l34--l48),
[open decisions](#open-decisions) and [suggestions on the locked MVP](#suggestions-on-the-locked-mvp-founder-decides).

**Maintained by hand** (since L2.14): the scratch files the first version was generated from are not in the repository;
edit this file directly — add an item with the next free `BL-` number in the area it belongs to.

**Current goal (decided 2026-10-12): a local tool for our own use.** Commercialisation (plans, licences, billing,
cloud offers, marketplace, distribution) is a future topic: the items and decisions about it stay here, parked.

## Decisions taken

- **2026-10-29 — Studio redesign « Épure » and the name Retake, in principle.** Validated through a four-round design
  exercise (BL-124): a dark, pro editing-suite Studio that follows the system's light appearance, and the name Retake
  with the "two takes" mark. No trademark or domain check: the tool is distributed locally. The redesign and the
  rename come right after L5.2 (decided 2026-10-29: lots L5.9 – L5.13); the desktop shell (L5.2) is built ready for them.
- **2026-10-28 — Captures first.** The load under a take is what must be controlled; renders and other heavy jobs are
  background work whose duration does not matter, and wait for (or pause during) the takes (BL-116). A render's file
  size is not a concern; renders on the GPU (angle) are accepted (BL-114). The job queue moves to pg-boss over an
  embedded Postgres shipped by npm, in principle (BL-117: nothing to install apart; amends ADR-1 for the queue's state
  only). *2026-11-04: BL-117 parked — the file queue stays; captures first was built on it (L5.14).*
- **2026-10-12 — Voice-over is an evolution.** The MVP keeps its silent track (R-ED-18); narration from a file (BL-46),
  AI voice-over (BL-12) and SRT/VTT subtitles (BL-30) stay in this backlog.
- **2026-10-12 — Commercialisation later.** First a local tool for our own use; the open decisions below that are about
  selling are parked, and nothing in the locked MVP changes.
- **2026-10-12 — MVP scope locked** to the lots in `docs/ROADMAP.md`; new ideas land here.
- **2026-10-12 — Remotion licence for internal use: free.** One-person company, within the free licence (up to 3
  people); revisit at 4 people or before selling.

## Direction notes (from the review)

- **Where the engine runs** stays local (ADR-1): capture needs the user's network, sessions and databases. Later it can
  also run in the user's own CI or VPS (self-hosted runner image, BL-05).
- **How the UI is delivered** is a separate choice: one web UI served by the local engine (`retake ui`) works in any
  browser; the Tauri shell is packaging (installer, updater, supervisor), never a second UI. A hosted UI later reaches
  the engine through an outbound relay (BL-38).
- **What lives in the cloud** is only what needs a server: licence and billing, review links, render library, runner
  control plane, then CPU render, and hosted capture last (public targets and a cloud sandbox).
- **Plans** (parked): test a ladder (Free / Pro / Team with free reviewers / Business) with usage add-ons (hosted minutes, AI
  credits, storage) rather than four separate plans; see [open decisions](#open-decisions).

## Collaboration

### BL-01 — Hosted review links with frame comments (free reviewers)
*M · founder idea · builds on: L3.6, L4.6, BL-39; BL-43 recommended*

Upload a render, its review stills and its comment threads to a hosted share page. Reviewers watch and leave frame comments in the browser with a magic link, with nothing to install. Comments sync back into the workspace as the same one-file-per-thread JSON, so Claude reads them through the existing MCP comment tools. Creators pay; reviewers are free.

- **Value:** Brings the non-technical approvers (product marketing leads, docs managers, legal) into the loop, which is what teams actually pay for.
- **Hard parts:** Two-way merge of comment threads between the hosted copy and the workspace files. Hosting customer screenshots makes the founder a GDPR processor (DPA, sub-processor list).

### BL-02 — Team workspace sync (asynchronous, end-to-end encrypted)
*XL · founder idea · builds on: L3.1 (global IDs, if-match writes, storage refs), L3.6, BL-39*

Asynchronous sync of authored files (project.yaml, scenarios, hooks, assets, components, templates, comments) for teams that don't use git. Media syncs on demand by content hash: capture.mp4 + timeline.json for re-renders, and published renders, never frames. Git semantics: write against a base hash, 3-way text merge, a conflict copy when the merge fails. Never syncs profiles, storage states, .retake/, hook journals, .env files or resolved secrets.

- **Value:** Teams without git share one workspace. It is sold inside the Team tier, not as a standalone plan.
- **Hard parts:** Resolving conflicts on YAML edited at the same time by people, Claude and the UI, plus an offline queue. End-to-end encryption rules out server-side search and previews.

### BL-03 — Roles, approvals and a locked brand kit
*M · proposed in review · builds on: BL-01, BL-39, L3.5*

Three parts:
- team roles (admin, creator, reviewer);
- sign-off on a frozen render version, with an audit trail of who approved which render_id and when;
- a team theme that creators use but cannot edit.

Approval state is stored with the render record, so a re-render visibly invalidates it.

- **Value:** Matches what team buyers ask for (sign-off before publishing, consistent branding) and justifies a Team price above Pro.
- **Hard parts:** Needs identity, so it only exists with a cloud account. A locked theme is only advisory on a local engine unless renders are published through the cloud.

### BL-04 — Shared render and capture library with history
*M · proposed in review · builds on: L3.1 (storage refs + sha256 in records), BL-39*

Content-addressed object storage for captures, timelines and renders, which are git-ignored today. History is kept per scenario and per release tag, so a teammate can re-render or compare without capturing again. It plugs in as a remote backend of the media storage abstraction (ADR-1 #3).

- **Value:** Gives teams a version history of the large files git can't hold. That need is real, unlike syncing the text files.
- **Hard parts:** Storage and egress cost, and a retention policy: keep_frames defaults to true, so runs are heavy. Deciding what is pushed automatically and what explicitly.

## Cloud runners

### BL-05 — Self-hosted runner image and CI templates
*M · founder idea · builds on: L1.3, L1.6 (automated login), L1.8, L3.1*

Publish the engine as a Docker image containing Node 22, Playwright Chromium plus Remotion's headless shell, ffmpeg, pdfjs and a documented font set. It runs `retake run/render/review` headless in the customer's CI or on their VPS. Ship ready-made CI workflows (for example GitHub Actions) that regenerate videos on each release. Nothing is hosted by us: the customer's own network, secrets and compute are used.

- **Value:** Delivers runners away from the laptop with no infrastructure cost and no data custody for the founder, and reaches private staging.
- **Hard parts:** Linux font fallback makes captures differ from Mac captures. Smoothness without a GPU depends on L1.3. The image is roughly 1.5–2 GB (estimate). Remotion licence and telemetry would apply on customer machines.

### BL-06 — Runner control plane and scheduled regeneration
*L · founder idea · builds on: BL-05, BL-04, BL-39*

A cloud job queue that self-hosted runners poll over outbound HTTPS, as Checkly's private locations do. It adds a fleet view, scheduled regenerations, upload of results to the shared library, and job status in the Studio. It uses the same serialisable job payloads as the local job runner.

- **Value:** Teams get scheduled, centrally visible regeneration without opening their network, and the founder sells orchestration and history rather than compute.
- **Hard parts:** The job input contract across machines (files, sessions, secrets, network reach). Runner authentication and revocation. Version skew between the control plane and runner images.

### BL-07 — Hosted cloud render (CPU workers)
*L · founder idea · builds on: BL-04, BL-39, Remotion written position (open decision)*

Render and export variants (4K, vertical, languages, batches) on CPU workers, from a capture, timeline and edit plan that were already uploaded. Billed per render minute as an add-on. It needs no access to the customer's environment.

- **Value:** Gives users with slow or fanless machines, and large batches (formats × languages × prospects), fast parallel renders.
- **Hard parts:** Remotion's terms require written approval for a rendering service that renders code end users write or upload (workspace and marketplace components); code generated by the service's own AI is allowed. Renders count toward Automators fees.

### BL-08 — Hosted cloud capture (public targets and cloud sandbox)
*XL · founder idea · builds on: BL-05, BL-06, L1.3, L1.6, L1.8*

Managed runners (Cloud Run or a VM) that capture public sites and a cloud sandbox: the L1.8 docker-compose stack running in the same VM. Billed per minute. Private staging is reachable only through a tunnel the customer runs or a static egress IP they allow-list. Sessions come from an encrypted, time-limited storage-state upload or from automated login with vault-held secrets.

- **Value:** Capture with nothing installed, for public product sites and demos built on sandbox data.
- **Hard parts:** GPU support in containers is unproven, and the software fallback is silently slow. Holding customer credentials and running their shell and SQL hooks means processor duties, per-customer isolation (microVM or gVisor) and SSRF and abuse controls. Accounts behind SSO or 2FA cannot be filmed.

### BL-09 — Out-of-date video checks in CI
*M · proposed in review · builds on: BL-05, L2.6, L1.7, L1.8*

A `studio check` command that dry-runs each scenario against the current app and compares the frame of each step with the last capture. A CI integration comments on pull requests ('3 videos change', with a visual diff) and opens an issue when a scenario breaks ('video X is out of date at scene 3'). It reuses the existing review diff.

- **Value:** Makes 'videos regenerated on every release' the product's moat: deterministic videos defined in code that report when they are out of date.
- **Hard parts:** Avoiding noisy diffs from changing data and clocks, which relies on the L1.7 frozen clock and sandbox seeds. Defining a threshold for acceptable change.

## AI

### BL-10 — In-app AI assistant (bring your own key)
*L · founder idea · builds on: L3.1–L3.3, L3.7, L4.1*

An agent loop inside the Studio that is an MCP client of the engine's own tools and uses the customer's API key. It can:
- draft a scenario from a script or a URL;
- generate the timeline and edit;
- run the automatic contact-sheet review and propose fixes;
- suggest video ideas from product pages or a changelog.

It uses the same tools as Claude through MCP, so there is no second AI feature set to maintain.

- **Value:** Users who don't run Claude Code get the AI workflow inside the app, and data goes straight from their machine to their provider.
- **Hard parts:** Image-heavy review uses many tokens. Keeping prompts in parity with the L3.7 skills. Telling users plainly that screenshots of unreleased product go to their provider.

### BL-11 — Hosted AI credits
*M · founder idea · builds on: BL-10, BL-39, BL-43*

Metered AI through Retake's own account, for users without an API key. It needs a metering proxy, credits included in paid tiers and sold as add-ons, per-project opt-in, and redaction before any frame is sent. Priced per review or per minute, not as a flat plan.

- **Value:** Removes the 'get an API key' step for non-technical buyers.
- **Hard parts:** Thin margin on resold tokens. Becoming a processor of customer screenshots, with the model vendor as a sub-processor (DPA, transfers to the US). Abuse limits.

### BL-12 — AI voice-over and dubbing
*M · proposed in review · builds on: L2.3, L2.8 (audio mix and ducking), BL-10 or BL-11*

Generate a voice-over from the captions or a script track, using the customer's TTS provider or credits. Speech is timed against the timeline so it fits each scene's duration, with a voice per language. This lifts the v1 non-goal in SPEC ('voice-over generation').

- **Value:** Closes the most visible gap with AI-first competitors for product-marketing and customer-education buyers.
- **Hard parts:** Fitting speech to the capture's fixed pacing, by retiming scenes or holding frames. AI Act Art. 50: machine-readable marking of synthetic audio (a provider duty); a visible label only for deep fakes. Cost per minute.

### BL-13 — Release-video skill
*S · proposed in review · builds on: L3.3, L3.7*

A Claude skill and MCP prompt that drafts or updates scenarios from release notes, a PR diff or a preview-deployment URL, then runs capture and review. It works through MCP with the user's own Claude, at no AI cost to the founder.

- **Value:** One video per release with almost no authoring, in line with the 'regenerate on release' positioning.
- **Hard parts:** Turning release-note language into concrete UI paths depends on how good page_inspect is.

## Marketplace

### BL-14 — First-party theme and component packs
*S · proposed in review · builds on: L2.2, R-V2-04 (manifest), BL-39, Remotion written position*

Curated packs of themes, components and templates made by the founder. They are sold as add-ons through the merchant of record and installed into the local registry. No third-party sellers and no payouts.

- **Value:** Tests whether people will pay for looks before building a two-sided marketplace.
- **Hard parts:** If buyers can view or modify a pack's source, Remotion requires their company to hold its own Company licence from 4 people up, and downloadable code must state it is built with Remotion. OFL fonts can't be sold on their own, and commercial fonts rarely allow redistribution.

### BL-15 — Free community component registry
*M · proposed in review · builds on: L2.2, L3.2, L4.5, BL-42*

`retake components add <git-url|npm-package>` with a hash lockfile, a check of the manifest's `engines` / kit-API version, and a preview rendered in the user's theme. A static index page lists community packages. No payments and no hosted code execution.

- **Value:** Lets the community share components with almost no infrastructure, building supply before any marketplace.
- **Hard parts:** Installing third-party code that runs during render and preview requires the isolation in BL-42. Keeping packages compatible across kit-API changes.

### BL-16 — Open cloud marketplace
*XL · founder idea · builds on: BL-14, BL-15, BL-39, BL-41, BL-42, Remotion written position*

A hosted catalogue where anyone can browse, buy and install third-party components and themes into the local marketplace cache, which is resolved after workspace and built-in components (R-V2-03). It shows previews in the user's theme and needs seller accounts, payouts, ratings and takedowns.

- **Value:** Adds ecosystem breadth and a revenue share once there is a user base.
- **Hard parts:** A two-sided cold start. Under EU VAT rules the platform is presumed to be the seller. DSA notice and takedown. Remotion's terms (buyers who can view or modify code need their own licence from 4 people up, downloadable code carries a Remotion notice, rendering uploaded code needs written approval). Code review and revocation.

## Authoring

### BL-25 — Record through the live preview (no local display)
*M · founder idea · builds on: L3.4, L4.4, L4.8; BL-38 for hosted use*

Record a scenario inside the Studio's live headless preview (the L4.4 screencast), forwarding mouse and keyboard input to the headless page instead of opening a headed local window. It reuses the step generation from L3.4. This lets recording work from a hosted UI, on a self-hosted runner and against a cloud sandbox.

- **Value:** Non-developers can write scenarios from a browser tab without a local browser window, which any hosted offer needs.
- **Hard parts:** Input latency and fidelity over the stream (input methods, drag, file pickers, clipboard). The security of forwarding input to a remote browser that holds sessions.
- **Why L4.8 did not build it** (the Record screen opens a real headed window and the Studio is its control panel):
  - *Lag*: the L4.4 picture is at most 10 fps and 960 px (JPEG): too slow and too small to aim at a menu item or to
    watch a hover.
  - *No native widgets*: select popups, file choosers, date pickers, IME, the clipboard and drags do not exist in a
    screencast; each would need its own emulation.
  - *A page→driver channel*: forwarding needs a new input channel from the Studio page to the browser. CDP
    `Input.dispatch*` events are trusted (`isTrusted`), so the recorder could not tell the person from any program
    holding the Studio token (Claude Code's shell included, BL-106): it could drive a signed-in browser and write steps,
    against L3.4's rule "Claude may start a recording, never drive it".
  - *Secrets through the Studio server*: typed passwords would cross the Studio page and server as keystrokes; today
    they never leave the window (masked in the page, hashed on the runner side).

### BL-26 — Recorder assist: narration to captions, data-prep suggestions
*M · proposed in review · builds on: L3.4, L4.8; BL-10 optional*

While recording, optional spoken narration is transcribed into draft captions for each scene. Observed form submits and write requests become suggested data-prep and reset hooks. Both are shown as suggestions to accept or reject.

- **Value:** Turns a click recording into an almost finished scenario, with captions and reproducible data, which competitors' recorders don't offer.
- **Hard parts:** Speech-to-text cost and privacy (local model or provider). Inferring hooks from network traffic without capturing secrets.

### BL-27 — Import from E2E tests and browser recorders
*M · proposed in review · builds on: L3.3, L3.4*

Convert Playwright tests and codegen output, a subset of Cypress specs, and Chrome DevTools Recorder JSON exports into draft scenarios. Locators map to targets and assertions to wait_for.

- **Value:** Teams with an existing E2E suite get videos from flows they already maintain.
- **Hard parts:** Test code isn't declarative, so only linear flows convert cleanly. Mapping test data setup to hooks.

### BL-28 — Personalised batch runs
*M · proposed in review · builds on: L1.6, L1.8; BL-07 for scale*

`retake run --matrix rows.csv` runs one scenario per row. Variables (prospect name, logo, locale, persona) are injected into hooks, templates and captions, then each row is rendered and reviewed under a predictable name.

- **Value:** One video per prospect or segment, which sales-demo tools price highest.
- **Hard parts:** Data preparation and rollback for each row, total runtime of N captures, and Remotion's per-render fees at volume.

### BL-29 — Starter scenario library
*S · proposed in review · builds on: L3.3, L3.7*

Generic starter scenarios for common SaaS flows (signup, onboarding, create/edit/delete, settings, search). page_inspect and Claude adapt them to the target app.

- **Value:** Shortens time to first video on any SaaS product.
- **Hard parts:** Generic targets rarely match a real app, so it depends on page_inspect adapting them well.

### BL-47 — Scenario draft from a URL, without AI
*S · seen in competitors · builds on: L3.3 (page_inspect)*

`retake new --from-url` opens the page, lists headings, navigation and primary actions with robust targets, and writes a draft scenario to edit. Deterministic and offline, no model call.

- **Value:** A first result in minutes for users who don't use Claude, next to scenario_from_script and the recorder.
- **Hard parts:** Choosing a sensible path through an unknown app; the draft is a starting point, not a finished video.

### BL-48 — Scenario lint and selector heal loop
*M · seen in competitors · builds on: L1.2 (target resolver), L3.3; BL-49*

`retake lint` flags fragile targets (nth-child, generated class names, text in a localised project) and predictable freezes (long waits, missing wait_for). After a UI change breaks a run, a heal step proposes replacement targets from page_inspect, applied by the user or by Claude through MCP.

- **Value:** Addresses the first pain of regenerated videos: the selector that breaks after a release.
- **Hard parts:** Proposing the right replacement without silently changing what the video shows; keeping fixes reviewable as diffs.

### BL-49 — Target-resolution trace in the timeline
*S · seen in competitors · builds on: L1.2, L3.3*

timeline.json records which rung of the target ladder resolved each step (role and name, label, text, testid, CSS) and the alternatives that also matched, so degraded targets are visible before they break.

- **Value:** Early warning for fragile scenarios, and the input BL-48 needs.
- **Hard parts:** Few; keeping the timeline compact.

### BL-51 — Theme from the captured app's CSS variables
*S · seen in competitors · builds on: L3.5 (themes from a site URL); could fold into it*

During capture, read the app's design tokens (CSS custom properties such as primary colour, radius, fonts) and propose a theme from them, with a contrast check for captions and cards.

- **Value:** Videos look on-brand with no setup; a competitor already does it automatically.
- **Hard parts:** Apps without tokens; telling brand colours from incidental ones.

*L3.5 note:* this item stays whole. L3.5's `template_from_site` reads a public site's computed colours and font names,
not its `:root` custom properties (cut to BL-75, one less untrusted channel), and nothing is read from the captured app
during a run.

### BL-55 — Frames and components beyond the same-origin case
*M · found in L1.2 (R-ISS-07) · builds on: L1.2*

L1.2 reaches open shadow roots and same-origin iframes from the top kit. Still out of reach: cross-origin iframes
(payment, chat, embedded third-party widgets — they need per-frame kit routing through Playwright frames,
frame-qualified refs and node-side coordinate translation), closed shadow roots, drag events into a frame
(`drop_file` uses the zone's file input there), frames under a CSS transform or zoom (offsets ignore transforms),
a `>>>`-style piercing selector, an app-shell scroll container inside a full-page iframe (`scroll` without a target),
declarative popovers inside shadow roots raising the cursor overlay (`toggle` is not composed), and error DOM snippets
with shadow or frame content.

- **Value:** Products that embed third-party widgets or are built as an app inside an iframe can be filmed end to end.
- **Hard parts:** Cross-origin frames have their own kit and coordinate space; the runner would have to route every
  kit call and merge the results.

### BL-56 — Templating extras
*S · found in L1.2 (R-RUN-16/17) · builds on: L1.2*

L1.2 templates every scene string and treats every `{{env:…}}` / `{{keychain:…}}` as a secret. Left out: an escape for
a literal `{{ }}` in typed text; `{{captured.<as>}}` tokens reading a `capture_text` value in later steps; templated
`vars` values (a `{{…}}` in one is a validation error until then; a var built from `{{env:…}}` would let a value from
the environment show in the video, which an env ref cannot: it is masked and warned about when typed into a visible
field); a `secret: true` on a hook's `save_as` so a
token saved by a setup hook (`{{hooks.login.json.token}}`) is masked in the run files like an env secret.

- **Value:** Fewer workarounds for CI-provided values and hook-made credentials.
- **Hard parts:** Keeping the "values the video may show" vs "secrets" line simple to explain.

### BL-70 — `retake migrate`: rewrite files to the current format version
*S · found in L1.4 (R-PRIN-13) · builds on: L1.4*

Every file now says which version of its format it is (`version`; absent = 1), and a file of a newer version is
refused with one message. When a format first changes incompatibly (version 2), readers keep reading version 1, so
nothing breaks; but files then mix versions in a workspace. A `retake migrate [<project>] [--dry]` would rewrite
scenarios, project.yaml, template.yaml and retake.yaml to the current version — keeping comments and key order (the
`yaml` document API, like `retake sandbox init` does for project.yaml), printing a diff first, never touching runs.

- **Value:** One command after an upgrade instead of hand edits; files that sync between machines converge.
- **Hard parts:** Keeping the user's comments and layout; a rewrite that loses nothing a newer key cannot express.
- Global render ids (L3.6 note): render ids are reused once renders/ is cleaned; frame comments store the render's
  `created_at` beside its id to tell them apart. Moving renders to a ULID with `-vN` as a display label is a format
  change of render records, review/ and exports/ folders, the MCP and CLI arguments — a migration of its own (BL-76).

### BL-71 — Network idle: requests the browser never reports as ended
*S · found in L1.4 (R-ACT-21) · builds on: L1.4*

`wait_for: {network_idle}` and the login steps' idle wait count a page's requests in flight from Playwright's events,
and forget a frame's requests when it commits a new document or goes away. A `fetch()` whose `no-store` body the page
never reads (fire-and-forget) is never reported as ended either: since L1.4 it stops counting 1 s after its response
headers (`UNREAD_BODY_MS`), which also stops counting a body still streaming by then. One kind still never ends, so
every later idle wait on that page times out naming it: a dedicated worker started by an iframe (same-site or not)
that is removed or navigates while the worker has a request in flight — Playwright reports worker requests on the
page's top frame, so nothing tells them apart from the top document's own; they go only when the top document
changes. A fix needs the worker of a request (a CDP session per worker, or a newer Playwright), and the browser-side
network events over CDP would tell an unread body from one still streaming; `optional: true` or a `wait_for: {text}`
is the workaround.

- **Value:** No false "still loading" on sites with workers in embedded frames; long bodies waited for exactly.
- **Hard parts:** Not waiting for a streamed body (an answer that streams for seconds) that is genuinely in flight.

## Outputs

### BL-30 — SRT / WebVTT subtitles
*S · earlier V2 candidate · builds on: L2.3, L2.8*

Export captions and timeline cues as SRT and WebVTT sidecar files, per language, with times taken from the edit plan's time map. Burning them into the video is optional.

- **Value:** Accessibility, muted autoplay on social media, and LMS and help-centre uploads.
- **Hard parts:** Mapping caption times through cuts and time changes in the edit plan.

### BL-31 — Step-by-step guide export
*M · proposed in review · builds on: L2.6, timeline from L1.x*

From timeline.json and the frames of each step, produce a Markdown, HTML or PDF how-to. Each step gets a screenshot or short GIF, its caption as text, and a highlight of the target element. It is regenerated together with the video.

- **Value:** Guides like Scribe's or Tango's that never go out of date, from the same run, widening the buyer to docs and support teams.
- **Hard parts:** Writing good step text when there are no captions; cropping screenshots well.

### BL-32 — Interactive click-through demo export
*M · proposed in review · builds on: L2.6, timeline bounding boxes*

A static, self-hostable HTML demo with one frame per step, a hotspot taken from the recorded element's bounding box, the caption as a tooltip, and keyboard navigation. It does not copy the live page's HTML, which would be XL.

- **Value:** Sales and onboarding interactive demos from the same capture, a market where tools charge around $500/month for 5 seats.
- **Hard parts:** Responsive scaling of hotspots; the steps that are only meaningful as motion.

### BL-33 — Publish targets and stable 'latest' URLs
*M · proposed in review · builds on: L2.8; BL-04 optional*

Publish renders to YouTube, Vimeo, Wistia, help centres or the user's own object storage or CDN. Each video keeps a stable 'latest' URL or embed that is replaced on every regeneration.

- **Value:** Videos embedded in docs update themselves without anyone touching the docs.
- **Hard parts:** Each platform has its own API and OAuth, and some (YouTube) can't replace a file in place. CDN caching.

### BL-34 — Localisation by re-capture
*M · proposed in review · builds on: L1.2 (target resolver), L2.8; BL-12 optional*

Run a scenario once per UI locale, using the project locale for each run. Captions come from a strings file or a translation, and each language gets its own render. The video shows the real translated UI, not dubbed audio over an English UI.

- **Value:** N languages from one scenario.
- **Hard parts:** `text:` targets break when the language changes, so prefer role and testid targets or per-locale text. Longer strings change layouts.

### BL-35 — Automatic cut-downs
*S · proposed in review · builds on: L2.3, L2.8*

Derive a 15 s teaser, a 6 s loop or GIF and social variants from the same edit plan, by picking marked or high-signal scenes. This extends the L2.8 variants.

- **Value:** One scenario serves every channel.
- **Hard parts:** Choosing scenes automatically and keeping a coherent pace in a short format.

### BL-46 — Narration track from a file
*S · seen in competitors · builds on: L2.8 (audio mix), L2.12 (own media)*

A user-supplied narration audio file (or one file per scene) placed on the timeline, with scene holds stretched to fit and the music ducked under it. No speech synthesis: the minimal answer to 'videos without a voice'.

- **Value:** Covers tutorial-style videos, the most visible gap against competitors, without the cost and legal weight of TTS (BL-12).
- **Hard parts:** Fitting a fixed recording to the capture's pacing (holds, retiming); re-recording the voice when the scenario changes.

### BL-50 — Static share page
*M · seen in competitors · builds on: L2.8 (export); BL-33 for publish targets*

Export a self-contained page per video (chapters from scenes, transcript from captions, poster frames, embed code, previous versions) that the user publishes on their own S3, CDN or Pages. No Retake server involved.

- **Value:** Shareable links that stay local-first, before (or instead of) hosted review links (BL-01).
- **Hard parts:** Stable URLs across regenerations without a server; video hosting costs fall on the user.

### BL-53 — Release diff clips
*M · seen in competitors · builds on: L2.6 (diff), L2.11 (split screen), L1.7, L1.8; BL-09*

Given two git refs or two runs, render side-by-side or before/after clips of the scenes that changed, for changelogs and release notes.

- **Value:** Turns the existing render diff into a marketing asset ('what changed in this release').
- **Hard parts:** Aligning scenes whose steps changed; data must be identical across both runs (sandbox seeds, frozen clock).

## Components

### BL-17 — Terminal session component
*S · earlier V2 candidate · builds on: L2.2, L2.10*

Typed commands and streamed output in a themed terminal window, as a card or an overlay. It is driven by a script or a recorded terminal session, with deterministic typing and output timing.

- **Value:** Covers CLI and developer-tool products, a natural fit for the first buyer.
- **Hard parts:** Deterministic rendering of ANSI colours and realistic pacing within the components' import allow-list.

### BL-18 — Code snippet component
*S · earlier V2 candidate · builds on: L2.2*

Syntax-highlighted code with line focus, a typing or diff animation, and colours from theme tokens. The content comes from slots or a file in the workspace.

- **Value:** For API and SDK products and devrel videos.
- **Hard parts:** Bundling a syntax highlighter inside the allow-list while keeping frames deterministic.

### BL-19 — Chat / SMS conversation component
*M · earlier V2 candidate · builds on: L2.2, L2.9*

A message thread (phone or desktop style) with timed reveals and a typing indicator. Messages come from slots or from hook output. It works in the vertical and square variants.

- **Value:** Shows messaging, support or notification features, and onboarding stories.
- **Hard parts:** Keeping the layout readable across 16:9, 9:16 and 1:1, and pacing reveals against captions.

### BL-20 — Dynamic Island / live activity component
*S · earlier V2 candidate · builds on: L2.7, L2.9*

An animated, iOS-style live activity in the phone layouts, for example order status or a timer, fed from slots.

- **Value:** Polished mobile demos, alongside L5.3 and the lock-screen components from L2.9.
- **Hard parts:** Evoking the pattern without copying Apple assets or trade dress. It is tied to the phone layout geometry.

### BL-21 — Calendar invite component
*S · earlier V2 candidate · builds on: L2.2, L2.9*

An invite card or calendar event that appears (like the L2.9 mail notification), with optional data from a hook-generated .ics or an API response.

- **Value:** Covers scheduling and booking features.
- **Hard parts:** Few; mostly design work so it fits each theme.

### BL-22 — Sound effects
*S · earlier V2 candidate · builds on: L2.8*

Click, typing, whoosh and notification sounds placed automatically from timeline events, and mixed with the music bed's ducking and loudness. Themes choose a sound set, or none.

- **Value:** Cheap polish that makes videos feel finished.
- **Hard parts:** Tasteful defaults, licensing of the sound files, and normalising loudness against the music.

### BL-23 — Webcam bubble
*M · earlier V2 candidate · builds on: L2.12*

A presenter bubble from a separately recorded video file, composited as an overlay and placed on the timeline (corner, size, enter/exit). The engine does not capture the webcam live.

- **Value:** Personal touch for sales, onboarding and founder videos.
- **Hard parts:** Syncing separately recorded footage to the timeline. Bringing live camera recording into the engine would be a separate, larger feature.

### BL-24 — Alternative renderer behind the edit-plan contract
*L · earlier V2 candidate · builds on: L2.2–L2.5*

Keep the component format and kit independent of Remotion (R-V2-08), and prototype a fallback renderer behind the EditPlan/component contract. Options: Chromium frames on a fixed clock plus ffmpeg (both already in the engine), or an MIT library such as Motion Canvas.

- **Value:** A bargaining position with Remotion, and an exit if its terms make a plan unviable.
- **Hard parts:** The component scaffolds import `remotion` directly today. Reproducing frame-accurate sequencing, audio and the Player preview.
- **Watched (2026-10-28):** kinetograph, a Rust renderer (wgpu, Skia, Stylo + taffy for CSS, ffmpeg) that resolves
  `remotion` / `@remotion/*` imports to its own implementation and draws without a browser. Not adopted: five days old
  at review (beta 0.2.0), no `@remotion/player` (the Studio's preview would stay on another engine), CLI only, content
  it cannot draw is approximated with a warning unless `--strict`, PolyForm Small Business licence (a question once we
  sell). The API we use is small (about twenty names) and in its compatibility list: revisit later. BL-114 (angle +
  VideoToolbox) is the cheaper step meanwhile.

### BL-54 — Layouts that give the caption block's room back
*S · found in the phase-2 acceptance (L2.14) · builds on: L2.5 (geometry expressions), L2.7*

With a theme whose caption goes over the screen (`caption-overlay`, the motion starter) and a project that asks for
`frame: card`, `studio/layout-card` still keeps the 122 px caption block below the card: the card sits 40 px from the
top with ≈ 160 px of empty background under it (quote-v15). A geometry builtin such as `caption_below` (1 when the
caption component draws in the layout's caption rect, 0 when it draws over the screen) would let the device and card
layouts centre themselves — or grow — when the block is empty.

- **Value:** Balanced frames for every theme / frame combination without a theme-specific layout.
- **Hard parts:** The planner must resolve the caption before evaluating the layout geometry; every layout manifest
  and its previews / tests follow.

## Distribution & packaging

### BL-36 — Signed installer, notarisation and auto-update
*M · earlier V2 candidate · builds on: L5.2, BL-41*

Developer ID signing and notarisation of the macOS app and every bundled executable (Node, Chromium and ffmpeg sidecars). An updater with its own signing key, update channels, and a documented offline install.

- **Value:** Non-developers can install without Gatekeeper warnings and stay up to date.
- **Hard parts:** Notarising Chromium sidecars. Losing the updater key blocks every future update. Apple Developer membership costs about $99/year.
- **One app with everything in it (direction of 2026-10-28):** installing the app is the whole install. It holds the
  engine (Node and our packages: the Studio it shows, the worker), the **CLI** (the app installs a `retake` command on
  the PATH — a small launcher running the bundled Node, so the CLI is always the app's version, like an editor's
  "install command in PATH"), the **MCP server** (the same `retake mcp`, stdio or HTTP served by the app, registered in
  Claude Code / Claude Desktop by the app from `retake mcp --print-config`), and the binaries: Chromium for captures,
  the headless shell and Remotion's compositor for renders, ffmpeg, and the queue's Postgres (BL-117). The app
  supervises the Studio server, the worker and Postgres. The repository clone stays the developers' path.
- **Size and shell:** with Chromium, the headless shell, Postgres (≈ 150 MB) and Node, the app is ≈ 0.7–1 GB.
  L5.2 chose Tauri for a small shell (R-DSK-01 / R-DSK-02: Rust only for OS glue); as Node ships inside anyway, compare
  with Electron (Node and Chromium built in, an all-TypeScript app) when L5.2 is detailed. Unsigned is enough for our
  own use; distributing needs every executable signed and notarised, and the Remotion licence reviewed for a
  redistributed tool (R-V2-08).
- **Electron compared at L5.2's design (2026-10-29):** the Tauri shell is 7.9 MB (release, stripped, thin LTO) and
  builds offline from the cargo cache; Electron bundles Chromium (≈ 200 MB before our own binaries) and was not even
  buildable offline here (not in the pnpm store). Tauri kept. What L5.2 built is the shell only: it runs the
  repository's CLI with the Node.js that built it (launch.json), is signed ad hoc, never installed; the bundled Node /
  engine / Chromium, the `retake` command on the PATH, signing, notarisation and the updater stay here.
- **Scheduled (2026-10-29):** as lot L5.16, right after the rename (L5.13), so the app ships under its final name;
  ffmpeg is bundled too (an LGPL build of our own with VideoToolbox).

### BL-37 — Windows and Linux support
*L · proposed in review · builds on: L4.1, L1.6*

Officially support the engine plus `retake ui` in any browser on Linux, which already runs headless, and on Windows. A Windows shell can come later. This reverses a v1 non-goal in SPEC.

- **Value:** Customer-education and support teams often use Windows.
- **Hard parts:** Shell hooks, keychain equivalents, path handling and file locking on Windows. Windows code signing (an OV certificate, plus SmartScreen reputation).

### BL-38 — Hosted Studio UI through an engine relay
*L · proposed in review · builds on: L3.1, L4.1–L4.9, BL-39*

The same Studio web UI served from the cloud. It talks to the user's local engine, or to a self-hosted runner, through an outbound WebSocket relay that the engine dials. The browser never calls 127.0.0.1 from a public page.

- **Value:** A real cloud-app experience (sign in from any device, even a phone) while capture stays local.
- **Hard parts:** Negotiating versions between a UI and an engine that ship separately. Pairing and authentication on the relay. Latency of the live preview.

### BL-45 — Official GitHub Action and CI recipes
*S · seen in competitors · builds on: L2.6, L3.1; BL-05 optional; could fold into L3.7 packaging*

Not folded into L3.7 (own use for now; a candidate for our own CI).

A packaged GitHub Action wrapping `retake run/render/review`, with copy-ready recipes: regenerate videos on release, commit or upload the media, comment on the PR with the contact sheet and the render diff, refresh on a cron, fail the build when a flow breaks.

- **Value:** The cheapest way to make 'videos regenerated on every release' visible; competitors use it as their main distribution channel.
- **Hard parts:** Chromium, ffmpeg and fonts on hosted runners (the BL-05 image helps); keeping big media out of the repository.

### BL-52 — Distribution in agent channels
*S · seen in competitors · builds on: L3.7 (plugin packaging); could fold into it*

Not folded into L3.7 (own use for now): the local marketplace at the repository root is the shape a public listing reuses (BL-77).

Publish the MCP server to the MCP Registry, the Claude skills and plugin to the Claude Code plugin marketplace, the CLI to npm and Homebrew, with a one-line install in each.

- **Value:** Where agent users discover tools today; the open-source rivals owe most of their visibility to it.
- **Hard parts:** Keeping several listings and versions in step; depends on the licence model (open core or not).

## Business & licensing

### BL-39 — Licensing, accounts and billing
*M · earlier V2 candidate · builds on: L3.1 (one entitlements hook point), BL-41*

Subscription licences sold through a merchant of record that handles VAT and invoices. Activation is checked on the server, with an offline grace period. Each tier maps to features that the cloud enforces. An optional free tier under a size threshold follows the Docker Desktop model (R-V2-01).

- **Value:** Required before any revenue.
- **Hard parts:** Licence checks inside a locally shipped JS engine are trivially patched, so enforcement has to come from cloud features. Counting seats for a CLI.

### BL-40 — Agency and white-label licence
*M · proposed in review · builds on: BL-39, L3.5*

Workspaces with several brand kits (one per client), white-label exports and review pages, and hand-off of a project to the client with its files and themes.

- **Value:** Agencies accept writing scripts and are likely early adopters.
- **Hard parts:** Remotion's rules on collaborative engagements and end-user code access when projects are handed to clients.

### BL-41 — Compliance pack for selling
*M · proposed in review · builds on: Remotion written position, L6*

It contains:
- a B2B-only EULA with a liability cap and an acceptable-use policy;
- a privacy notice that covers our telemetry and Remotion's;
- a DPA template for cloud features;
- third-party notices and GPL/LGPL source offers generated at build time;
- an SBOM, a security contact, and a vulnerability and incident process (CRA);
- a codec decision (system encoders or a patent position).

- **Value:** Unblocks the first sale and enterprise security questionnaires.
- **Hard parts:** The patent questions (H.264, AAC) and CRA scope need a tech lawyer. CRA reporting duties already apply.

## Platform & security

### BL-42 — Component supply-chain security
*L · proposed in review · builds on: L3.2, L4.5*

It covers:
- signed packages with publisher keys, immutable versions and a hash lockfile;
- review on publish;
- a revocation list checked at install and at render;
- render and preview Chromium with network blocked except the asset server;
- the Player in a sandboxed cross-origin iframe with a strict CSP and no engine token.

- **Value:** Makes installing third-party components safe enough for a registry or marketplace.
- **Hard parts:** The static scan in compile.ts can be bypassed, so real isolation is required. Managing publisher keys.

### BL-43 — Redaction and privacy masking
*M · proposed in review · builds on: L1.2 (secret redaction), L2.6*

Declarative masking of form inputs, text patterns and screen regions in captures, frames, contact sheets and exports. It is applied before anything leaves the machine: AI review, review links, the cloud library. Element bounding boxes from the timeline drive moving masks. A first case: an edit-time blur over a visible field a secret was typed into (L1.2 warns about it; the type event has the field's box and `t_type` / `t_typed`).

- **Value:** Lets security-sensitive buyers use AI review and share links, and reduces GDPR exposure for every cloud feature.
- **Hard parts:** Masks must be frame-accurate on moving content, and completeness is hard to prove.

### BL-44 — Enterprise controls
*L · proposed in review · builds on: BL-39, BL-03*

SSO and SCIM, an audit log, an admin console, a private component registry, and a security pack (questionnaire answers, DPA, later SOC 2).

- **Value:** Opens a Business tier priced by quote for larger buyers.
- **Hard parts:** SOC 2 costs about $25–50k in the first year for most startups (Drata estimate), which is heavy for a solo founder.

### BL-57 — Network isolation for hooks
*L · found in L1.2 (R-SEC-06) · builds on: L1.2*

L1.2 reads a shell hook's command line for the hosts it names (a best-effort reading of the shell text: URLs, the
script's own variables, command substitutions, inline interpreter code, proxies, database / ssh / git / nc targets)
and blocks the js hook tab's requests to hosts outside the allow-list. Not covered: what a hook's programs do on their
own — connecting from their own configuration (`pnpm run seed` reading `DATABASE_URL` from a `.env` file, the host
behind an ssh alias, kubectl contexts, cloud CLI profiles, PGSERVICE, docker compose service names), script files they
run, hosts they compute or read (URLs read from files or stdin, `fetch(process.env.API)` in inline code), code they
download or pipe into a shell (`curl … | sh`), commands run in a container or on another machine (`docker exec`,
`kubectl exec`, a remote ssh command), network tools the scanner does not know (socat, ncat, ftp…); in the hook tab,
WebSockets opened by workers, service and shared workers already running for the origin or started by the hook,
WebTransport / WebRTC, preconnect hints, redirect hops inside a cross-site frame, the first request of a popup a link
opens. An OS-level sandbox for hook
processes (macOS Seatbelt, Linux bubblewrap or a network namespace) allowing only localhost and an allow-list proxy
would hold the allow-list for every program a hook runs; the browser side would need a browser-level request guard.

- **Value:** The allow-list holds for what hooks do, not only for what they name.
- **Hard parts:** Hostname filtering needs a proxy, and clients that ignore proxies (psql) need another route;
  platform-specific code on macOS and Linux.

### BL-58 — Choreography extras
*S–M · found in L1.2 (R-CHO-13/18/21/24) · builds on: L1.2*

L1.2 ships the choreography helpers in their minimal form. Left out:
- A scenario-wide automatic parking switch (`pacing.auto_park`: park after every scroll to a target and before every
  `hold`), instead of a `park` per step; a parking spot that also avoids text next to the target (today a spot below
  a heading can sit over the next card's title).
- Parking that sees changes inside shadow roots and frames (the change record watches the top document).
- `date`: dates in other languages than English (matched by label only today, paged forward), a time of day, month /
  year dropdowns.
- An author-given point for a row's menu trigger (`trigger: {x, y}` relative to the row).

- **Value:** Fewer scripted moves for apps whose widgets the helpers do not cover.
- **Hard parts:** Locale-aware date parsing without a dependency; parking choices that read well on any layout.

### BL-59 — Session write-back after a run (rotating refresh tokens)
*S–M · found in L1.6 (R-AUTH-07) · builds on: L1.6*

L1.6 runs every persona on a copy of its session and never writes anything back: a token the app refreshed during a
run dies with the copy. An app that rotates its refresh token on every use (with reuse detection) may then revoke the
saved one, and the persona has to sign in again (`retake login`) more often. Write the copy's cookies (and the
profile's changed session files) back to the master after a successful run, under a lock, only when no other run of
the persona started meanwhile.

- **Value:** Long-lived sessions for apps with rotating refresh tokens.
- **Hard parts:** Concurrent runs (last writer wins, or a merge); never writing back a session that landed on a
  sign-in page.

### BL-60 — Sessions of a workspace: path overrides and namespaces
*S · deferred in L1.6 · builds on: L1.6*

L1.6 derives every session path under the Retake home (`~/.retake/…/<project>/<env>/<persona>`;
`RETAKE_HOME` moves all of them). Not done: a per-persona override in a git-ignored `project.local.yaml` or a user
config (the guard-rail allowed it), and a namespace per workspace — two workspaces with a project of the same slug
share their sessions today.

- **Value:** Several workspaces (clients) on one machine without collisions; a profile kept elsewhere on purpose.
- **Hard parts:** A second config file to validate and document.

### BL-61 — Persona choices beyond L1.6
*M · deferred in L1.6 · builds on: L1.6*

L1.6 ships personas in their minimal form. Left out:
- Another account on the same page id later in a run (re-binding a page per scene: a new browser, its tabs closed).
- A scenario-level `persona` default (cut from L1.6: it would also move a scenario's js hooks to that persona).
- Filming a sign-in or a sign-out: a step allowed to land on a sign-in page (today the guard fails the run; `persona:
  none` pages are the way to film a sign-up).
- sessionStorage and IndexedDB restored for `storage_state` personas (only cookies and localStorage today).
- `retake new` flags for the non-interactive path (`--persona name=page,…`, `--login-url`); `auth status --check` in
  parallel and a `--persona` filter; the personas of a run in `run.json` and a progress event for the preflight.

- **Value:** Fewer workarounds for multi-account and sign-in demos; scripted onboarding.
- **Hard parts:** Each one widens what the static persona plan must predict.

### BL-62 — Dynamic mocks for read-only runs
*M · found in L1.7 (R-ENV-03) · builds on: L1.7*

L1.7 mocks are literal: the same answer every time, matched by method, path and GraphQL operation. Many flows need
more: an answer that echoes the request (a PATCH returning the edited row, an id in the path), an answer from a file,
a list the app reloads afterwards that shows the mocked write (a small stateful store per run), and templated values
(`{{vars.*}}`, `{{run.id}}`; secret references refused: a mock is served into the filmed page). A "discover the
writes" dry run could print a mock skeleton for every write a read-only run stopped.

- **Value:** More flows filmable on production without an error state on screen.
- **Hard parts:** A small, safe expression language for echoes; keeping mocks literal enough to review.

### BL-63 — Display URLs inside what the capture shows
*M · found in L1.7 (R-ENV-01) · builds on: L1.7, L2.9*

L1.7 maps the URLs the edit draws (browser bars, captions, notification apps); what the captured page itself shows is
filmed as it is: its own links and text, a captured email's HTML (the fixture's sign-up email links to localhost), a
PDF's text. Rewrite the environment's real hosts to their display hosts in captured email HTML and documents before
they are rasterised, optionally in the page (a text-node rewrite on screen), and an OCR check of frames for local
hosts in the review.

- **Value:** "Never localhost in a video" holds for the content too.
- **Hard parts:** Rewriting a live page without breaking it; OCR cost and false positives.

### BL-64 — Read-only coverage beyond HTTP writes
*M · found in L1.7 (R-ENV-03) · builds on: L1.7*

The L1.7 guard stops mutating HTTP requests from the run's browsers and hooks. Not covered (README limits): messages
over a WebSocket or an EventSource (warned per host — an app that saves over a socket writes), WebTransport / WebRTC,
unsafe GETs (a write sent as GET: a block list of patterns), a write to an unguarded host that redirects to a guarded
one (only its first hop is seen and recorded `passed`), and `retake login --auto` / `retake auth status --check` on a
read-only environment (outside any run: never guarded). Message rules for sockets (block / allow by frame pattern), a
GET block list and following redirects to the end would close most of it.

- **Value:** Read-only that holds for real-time apps and odd APIs.
- **Hard parts:** Parsing socket protocols (Phoenix, Socket.IO, GraphQL subscriptions) generically.

### BL-65 — Clock extras
*S–M · found in L1.7 (R-ENV-05) · builds on: L1.7, L1.8*

L1.7 sets the product's browser clock once per run (`clock:`, running from capture time 0, or frozen) — `Date` and
Intl's default date only, timers and animation frames stay real. Left out: per-scene time jumps (an interstitial "two
days later" fast-forwards the clock), a `--clock` flag on `retake run`, the clock in a dedicated worker's first lines
(it arrives once the worker started: pausing it needs our own target auto-attach, which Playwright's resumes), in
shared and service workers, a mode that also fakes timers for an app that derives what it shows from `performance`,
and the server's clock (dates the server makes: created_at, emails, PDFs) — for a sandbox, BL-68.

- **Value:** Stories that span days; identical server-made dates on every take.
- **Hard parts:** Keeping the capture's own timing on real time while the product's clock jumps.

### BL-66 — Environment extras cut from L1.7
*S · cut in L1.7 · builds on: L1.7, L2.13*

Cut to keep L1.7 an M: the raw export's manifest `run.environment` and per-clip display URLs (the package names URLs
only in its step markers and click targets, as display URLs or paths since the L1.7 review), `retake doctor
--project` lines per environment (production, access, display URLs, mock and allow counts), absolute-URL and query patterns in `allow` / `mocks`, mocks on read-write runs,
GET mocking / response rewriting, HAR replay, and the Studio app's confirmation of a production write (R-ENV-04, with
the phase 4 run screen).

- **Value:** Small conveniences around environments once they are used daily.
- **Hard parts:** None in particular.

### BL-67 — Sandbox snapshots beyond Postgres
*M · cut in L1.8 (R-SBX-05) · builds on: L1.8*

L1.8 snapshots one database: Postgres 13+, published by a service of the sandbox's own compose project (a template
clone restored before each take). Everything else reseeds. Left out: MySQL / MariaDB (no template databases: a
`mysqldump` / `mysql` round trip, the clone plugin, or a copy of the data directory with the service stopped), SQLite
(a file copy while the app is stopped or through its backup API), copy-on-write volume snapshots for any store (a
volume copied while its service is stopped; ZFS / APFS clones), several databases in one snapshot, and an explicit
opt-in for a Postgres outside the sandbox (a process-provider sandbox, a database another compose project runs) with
a typed confirmation of what will be dropped.

- **Value:** Fast resets for the common stacks that are not Postgres.
- **Hard parts:** Proving the data belongs to the sandbox before dropping it; consistency of a volume copied live.

### BL-68 — A clock for the sandbox's server
*S–M · found in L1.8 (R-SBX-04) · builds on: L1.7, L1.8*

A sandbox reset makes the seeded data equal between takes, not what the server writes during the take: a quote's
`created_at`, a mail's date, a PDF's "issued on" are the time of the take (the fixture is equal only because its demo
clock restarts at each reset). `--sandbox` deliberately sets no browser clock (a pinned browser clock next to real
server timestamps shows "created in 3 weeks"). Give the server the project's clock instead: pass `clock:` to the
sandbox's services as an environment variable (`RETAKE_CLOCK=2026-11-02T10:24:00`, frozen or running from the
reset) for apps that read one, or run them under libfaketime (process provider, or a compose `LD_PRELOAD`); then the
browser clock can follow the same value.

- **Value:** Identical server-made dates on every take, and a coherent browser + server clock.
- **Hard parts:** Each framework reads time differently; libfaketime breaks some runtimes (Go, the JVM's monotonic
  timers); restarting services so they pick up a new value.

### BL-69 — Sandbox extras cut from L1.8
*M · cut in L1.8 · builds on: L1.8, BL-05, BL-08*

Cut to keep L1.8 an L:
- `run --sandbox --no-reset` (take the lock, film as is) and `--wait` for a busy take lock instead of failing fast;
  ephemeral per-take sandboxes (a fresh copy per take, so takes run in parallel); `sandbox up --attach` (foreground,
  logs streamed, Ctrl-C stops it); restarting only the services whose definition changed (today a warning: down,
  then up); `reset.after` steps; `--json` on `up` / `reset` / `down`; `logs --follow` for the process provider; a
  process variant of `retake sandbox init`; `retake new` offering a sandbox.
- A snapshot taken after the accounts signed in (sessions kept across takes, no sign-in before each take); accounts
  that reuse another environment's persona definitions instead of repeating them in sandbox.yaml.
- A per-mark frame comparison of two takes (`compare-takes <run> <run> [--mark m]`: text artefacts plus a frame diff
  outside the cursor), today done by hand with ffmpeg.
- Chromium in the fixture's Docker image (its quote PDF; ≈ +250 MB), a Windows process provider (no process groups),
  and remote sandboxes — the same manifest run on a VPS, in CI or in a cloud runner (BL-05, BL-08; the manifest keeps
  no host path for that).
- The take's own connections pinned to the address Docker publishes a port on, like the health checks, pg, sql seed
  steps and the mailbox clear already are: the browser (`--host-resolver-rules` for the sandbox's host names), the
  runner's `wait_for_email` client and `http` seed steps (fetch cannot pin an address: node:http with a `lookup`).
  Today another container publishing the same port on [::1] is refused right before each take, not during it.

- **Value:** Smoother daily use of sandboxes and parallel takes; the road to CI and hosted capture.
- **Hard parts:** Parallel sandboxes need free ports and project names per copy; remote ones need a tunnel for the
  browser and the health checks.

### BL-72 — MCP render, review and preview extras cut from L3.2
*M · cut in L3.2 · builds on: L3.2, BL-42*

Cut to keep L3.2 an M:
- A `still` tool and job kind (one frame of a render plan as an image): `review_get` key frames and `plan_preview`
  cover it; the CLI keeps `retake still`. A `render_list` tool (renders newest first): `render_status latest` and
  `run_list` cover it. A `render_cancel` alias of `job_cancel` (add it only if a live session shows the agent missing
  it). A render / export / preview cleanup tool (disk use; deleting stays a human's).
- Component mp4 previews; pruning `.retake/previews/` (it grows by one folder per preview); a theme's own media
  file (`components: {intro: {video: …}}`) shown in `template_preview` instead of the component's sample.
- Image caps tuned from the live session (MACOS-CHECKLIST 12d): how Claude Code counts image blocks against
  `MAX_MCP_OUTPUT_TOKENS` decides the defaults (4 images, 1.5 MB of base64, 1280 px).
- A concurrent `retake review` in a terminal and a `review` job of the same render race on `review/<id>/`: the last one
  to finish wins (each swap is atomic). A per-render lock would serialise them.
- The network guard's residual: WebRTC (UDP) and DNS prefetch are not covered by CDP Fetch nor by the bundle's CSP
  (full isolation: an OS-level sandbox, BL-42). The guard applies to renders and previews of the jobs worker only:
  `retake render` keeps the open network (remote images in slots are a CLI feature); a `--guard` option, or the guard
  everywhere with a plan warning per remote image, would close it for human-installed components.
- Queue lanes: one job at a time means a 4K export re-render (minutes) holds captures and previews; a lane per kind, or a
  second worker for renders, with the queue position of each lane in `*_status`.
- Lottie expressions disabled in the kit's player (a Lottie file would then be data, not code, and could come from
  agent-writable folders).
- Remotion's bundle server bound to loopback: `@remotion/renderer` (4.0.534, `port-config` `getHostToBind`) listens on
  `::` / `0.0.0.0` with no option to change it, so during any render or preview (CLI or job) the bundle — the
  project's components and theme — and its `/proxy` route are reachable from the local network (a guarded render's
  `onDownload` check refuses any other `src`, but `retake render` is not guarded: a host of the network can make it
  download a URL of its choice). Fixing it needs a patch of the renderer (`pnpm patch`, to redo on every Remotion
  upgrade) or an upstream option; until then, a render on an untrusted network exposes them for its duration.

- **Value:** A smoother agent loop on long videos, and the last gaps of the render sandbox.
- **Hard parts:** Lanes need two browsers' worth of memory; WebRTC needs an OS-level sandbox.

### BL-73 — Authoring extras cut from L3.3
*M · cut in L3.3 · builds on: L3.3, L3.4, L4.4*

Cut to keep L3.3 an M (Claude writes the scenario; no tool calls a model):
- A held inspection session (inspect, act, inspect again without replaying the scenario): one-shot inspections with
  `scenario` + `until` replay the prefix each time. A held page would occupy the single worker and drift from any
  reproducible state; its natural home is L4.4's live-preview input channel (its wire format leaves room; not built:
  BL-105). Inline `steps` in page_inspect and hooks
  during a replay (an approval path) go with it.
- Landmarks (`main`, `nav`, `aside`…) in the inventory: headings, popups and scroll containers are reported instead.
- An alternatives list per element (every rung of the target ladder with its live match count): one verified
  suggestion plus `matches` and `fragile` today; the recorder (L3.4) needs the ladder and can bring the list.
- `images: clean | both` (the unmarked screenshot inline): `marked | none`; the plain screenshot.png stays on disk.
- Other script formats for `scenario_from_script`: prose, tables without times, `0:05.5` / `00:00:05` / bare seconds
  in the time column, several tables (only the first usable one is read), Google Docs or Notion exports, more header
  languages than English and French.
- MCP sampling (the server asking the client's model to write steps): Claude Code does not offer it to servers, and
  it would hide the work from the user; the calling model writes the scenario.
- A `retake draft` command over the script parser (a human with a table asks Claude), and the `url` of a host
  `allow_hosts` lists as an inspection source (no page key, so no persona and no sign-in guard).

- **Value:** Faster authoring loops on long flows; better targets on apps with weak accessibility.
- **Hard parts:** A held session needs a command channel into a running job and its cleanup when the agent forgets it.

### BL-74 — Recorder extras cut from L3.4
*M · cut in L3.4 · builds on: L3.4, L4.8, BL-25*

Cut to keep L3.4 an M (a person shows the flow in a headed window; the draft comes from it):
- An index cache of the page's interactive elements (rebuilt when a MutationObserver flags a change): nearly every
  press mutates a React page, so it was always dirty. A press resolves with a per-call memo and a 150 ms budget, then
  falls back to the element's text (≈ 0.2 s on a page with ~10,000 controls).
- Up to three verified alternative targets per step: no reader before L4.8's picker (R-UI-21), each costs a
  verification at press time.
- Tabs, pop-ups and frames: a new tab or pop-up is warned and its events dropped (no `new_tab` / `switch_page`
  recording: each page would need its own isolated-world session and correlation); same-origin frames are not
  recorded (`dropped.frame`).
- The in-page pill (Stop / New scene) and its shortcuts: Stop = close the window, Ctrl-C or job_cancel (discard); a
  new scene comes from page changes only. A pill would need every pointer, mouse, click and focus event on it
  swallowed in the isolated world (a press on it closes an open popover otherwise); ⌘⇧N is Chrome's incognito window.
- `hold` generation from idle pauses and `--no-holds`: pauses become `wait_for` the next target only; holds are an
  editing choice.
- Date pickers mapped to `date:` / calendar helpers, drags, hover-to-reveal: recorded as plain clicks (a hover not at
  all), which replay when the product's clock is fixed.
- Thumbnails per step and the quick inserts of R-UI-22 (hold, caption, mark, camera) while recording: L4.8's Record
  screen.

*Applied in L4.8*: up to three verified alternative targets per action (kit 1.6.0, ≤ 10 ms a press, offered by the
Studio's Record screen) and the quick inserts; thumbnails per step and the rest of the Record screen's cuts are BL-118.

- **Value:** Recordings of richer apps (several tabs, embedded frames, date pickers) that need fewer fixes.
- **Hard parts:** Per-page sessions and their correlation; UI-library heuristics for calendars and drags.

### BL-118 — Record screen extras cut from L4.8
*M · cut in L4.8 · builds on: L4.8, L3.4, L4.4, BL-25, BL-74, BL-105*

Cut to keep L4.8 an M (the Studio's Record screen: a real headed window the person clicks in, the Studio as its control
panel — the live draft, target alternatives to pick, quick inserts, Stop, Save as a new scenario, Discard):
- **Thumbnails per step**: a screenshot of the window at each action (a cost at every press, and the window may show
  what the draft does not hold).
- **A live picture of the recording window** in the Studio (BL-105's residue for `record` jobs); the window placed
  beside the Studio automatically (it opens full size: the desktop layout must be filmed).
- **Controls inside the window**: Stop or inserts from an in-page pill or a shortcut (BL-74: every event on it would
  have to be swallowed in the isolated world); keyboard shortcuts for the Studio's inserts.
- **Editing before Save**: changing, moving or deleting recorded steps on the Record screen (the scenario screen does it
  after Save); an insert's values changed in place (Remove, then add it again).
- **A re-check after later changes**: the check replay covers the draft as recorded (the worker never reads the
  Studio's picks and inserts); a pick or an insert made after it is checked by a dry run of the saved scenario.
- **More alternatives**: alternatives after saving and for any step (through page_inspect); for a `pick`, a `menu` row,
  a `select {field}` or a list's label (only a click, double click, typing, a combobox select and a file drop offer
  them); a row-scoped `in: {row}` alternative for a name repeated in a list.
- **Choices and inserts through MCP** (Claude cleans a draft with scenario_save); a CLI or MCP recording annotated in
  the Studio (read-only there).
- **An unsaved Studio draft kept longer**: beyond the newest 20 recordings, one is kept 7 days unless saved or
  discarded.
- **From the reviews of L4.8, not done** (DoS only, or a sentence's worth): a held `record-<id>.lock` or a forged live
  `owner.pid` can keep a recording busy, unpruned or "recording in a terminal"; meta.json keeps the start path as typed
  (as the job input and record.json do: `maskPathSecrets` for all three); a Studio recording whose job was pruned is
  read-only (its origin cannot be verified: an origin signed with the Retake home's key would keep it the person's).
- **Value:** Fewer round trips between the Record screen and the scenario screen; a draft whose check matches what is
  saved.
- **Hard parts:** Thumbnails without slowing presses; an in-window control the page can neither see nor trigger.

### BL-119 — Recorded drafts without YAML anchors (CLI and MCP)
*S · noticed in L4.8 · builds on: L3.4, L4.8*

A recorded draft whose recorder-added `wait_for` / `scroll {to}` share the action's target object is written with a YAML
anchor and alias (`target: &a1 {role: button, name: Request a quote}` … `click: *a1`) — valid YAML, unchanged since L3.4.
A Studio recording's draft has none since the L4.8 reviews (`draftFromRecording(…, {aliases: false})`: the block editor
deletes or duplicates the helper); the drafts of `retake record` and `scenario_record` keep L3.4's bytes (pinned by
golden drafts in core's test fixtures). People reading or editing those files by hand expect the target repeated: a hand
edit of the anchored one changes all three steps. Write each target in full there too, with the goldens updated in one
go.

### BL-75 — Theme extras cut from L3.5
*M · cut in L3.5 · builds on: L3.5, L4.7, BL-51*

Cut to keep L3.5 an M (`template_create_from_brand` makes a theme from the user's files; `template_from_site` reads a
draft from one public page; the model chooses the values):
- Create inputs beyond `base`: a `tone` (light / dark) input, `components` and `style_bias` overrides — the base theme
  carries them (a tone mismatch between the given paper and the base is a warning naming the better base).
- A `javascript: false` option of the site extraction (JavaScript stays on, with the network contract around it).
- The site's `:root` custom properties as colour or font sources (BL-51 stays whole); a `candidates.png` contact strip
  of the logo candidates (the screenshot and up to three logo PNGs come back as images within the image caps);
  detecting a consent dialog that covers the page (the screenshot shows it); clicking consent banners.
- ΔE clustering of the swatches: quantised buckets are enough for ≤ 8 swatches.
- Fonts: WOFF1 table decompression and WOFF2 `name` / `OS/2` parsing (magic and header only; the weight comes from the
  input or the file name); copying a site's font files, even with an approval, and font search or download from font
  services (only family names come from a site).
- `retake theme list` (`retake list` already lists themes).
- Several pages of a site, a mobile viewport, signed-in brand portals; bot-challenge pages are never bypassed.
- Theme media files (intro / outro video, image, Lottie) in generated themes; editing an existing theme through MCP
  beyond `replace` of an unchanged tool-made one (L4.7: people edit existing themes in the Studio's theme editor; MCP
  still never does); a theme diff, variants or a light + dark pair from one brand (BL-113).
- Brand guideline PDFs as input; cleaning a human's SVG with scripts (refused instead) or keeping a site's SVG logos as
  vectors (PNG only).
- Known limits of the site extraction as built: a subresource redirected to another host fails (refused at CONNECT:
  only hosts the route announced are tunnelled); a site that serves its top URL differently to Node and to Chromium
  (user-agent sniffing) may send Chromium elsewhere — refused at CONNECT when it is another host; "public" means a
  public address, not "on the internet" (a VPN or split-horizon DNS can give a company host a public address); colour
  roles are heuristics.
- Known limits after the L3.5 review: a signed `site` job carries no nonce or expiry — a copy of its job.json queued
  again replays the same approved URL (as hooks jobs since L3.1; the URL is still the one a human approved); a
  top-level redirect to another host than the approved one (or its www / apex sibling) fails the extraction instead of
  asking a second approval in the same call; with the unsafe test resolver set (tests only) Chromium accepts any
  certificate for every host of that extraction (Playwright has no per-host switch); `template_list` returns a
  tool-made theme's brand name and URL (agent text) as theme data, not under `untrusted`; the read-back checks of a
  site candidate and the image read through MCP are two steps (a file swapped in between is read once — still a
  plain file).

- **Value:** Closer drafts from richer brand sources (several pages, brand PDFs, the site's own tokens) with less
  hand-picking.
- **Hard parts:** Every extra source is another untrusted channel (strings, files, network) to bound; font licences.

### BL-76 — Comment extras cut from L3.6
*S–M · cut in L3.6 · builds on: L3.6, L4.6, BL-01, BL-02, BL-70*

Cut to keep L3.6 an S (people comment frames with `retake comment add`; Claude lists, replies and resolves through
MCP):
- Claude creating threads (`comment_create`, labelled agent) and a reopen tool for the agent: people create and reopen
  (`retake comment` or, since L4.6, the Studio's Comments screen).
- `step_now` (where the commented step is in today's scenario): `step_id`, `step_fp` / `step_fp_n` and `step_ref` let
  Claude find it in the scenario it reads anyway. Mapping a thread onto the matching frame of a newer render, or across
  variants.
- Re-deriving the anchor on read (the record's plan is no more trusted than the thread file): the stored anchor is
  returned pattern-checked, `render_present` is a boolean instead of present / replaced / missing.
- A second image per thread (a crop of the region) and committed stills (opt-in, never for production environments):
  one still, machine-local; stills for a thread made when ffmpeg failed, or regenerated lazily from the render.
- The JSON Schema file of a thread and `retake schema comment` (the zod schema is the contract; L4.6 imports it);
  `--at 12.4s` / `0:12.4` forms (seconds, `--frame` and `--marker` only).
- Overlay / pane hit-testing for `component` (the overlays on screen are listed instead); interstitial backdrops traced
  to their clip; several regions or drawings per comment; attachments.
- Signed human entries and per-person identities (workspace members; BL-01 / BL-02): a signature would not stop
  Claude Code's own shell (`retake comment add`) anyway — the server's instructions narrow what a comment may ask for
  instead. A merge helper for a thread appended on both sides of a git branch (union of entries by id); editing or
  deleting an entry; notifications or a watch (polling `comments_list` is the loop).
- Entry-stable ids for cards and interstitials without an `id:` (positional `interstitial-4`, like step indexes).
- Global render ids (a ULID with `-vN` as a label): render ids stay `<scenario>-v<N>`; a thread stores the render's
  `created_at` beside its id (and a resolution the answering render's) so a reused id is detected — the format change
  is BL-70's. Comments on renders written with `--out` (no `-vN` id) or on component previews.
- Side finding: `scenario_save` and `project_update_readme` check `if_match` and rename in two steps (no lock): two
  writers within milliseconds can both pass the check and the last rename wins. Comments take a per-thread lock
  (sandbox `TakeLock`); the same lock around those two writes would close it.
- Limits documented after the L3.6 review: a listing reads and parses every thread file (≤ 2000; about 23 s for 2000
  threads) — an index or a cheap stat-based skip of unchanged files; `retake comment add | reopen` run through Claude
  Code's Bash tool write as `cli` (the instructions forbid it, nothing enforces it — see signed entries above); a
  thread holds at most 500 entries and 2 MB (a new thread past it), and the MCP tools carry its last 10 entries and
  60,000 characters of thread text per listing (no paging: narrow by scenario or render); `step_playing` — inside a
  marker window the anchor names the marked step, the step actually playing there (a hover after a satisfied wait) is
  not named beside it.

- **Value:** Fewer hand steps in the review loop (Claude proposing its own notes, comments that follow the step across
  renders) and threads that merge cleanly once several people sync.
- **Hard parts:** Agent-made threads blur the provenance the loop relies on; anchors that survive scenario edits.

### BL-77 — Skill and plugin extras cut from L3.7
*S · cut in L3.7 · builds on: L3.7, L2.7, BL-52*

Cut to keep L3.7 an S (three skills in `skills/`, the plugin with the MCP server, a deterministic lint):
- The built-in library moved to kit imports: its components still import `useCurrentFrame`, `Img` and `AbsoluteFill`
  from `remotion` directly (33 imports); moving them regenerates 27+ committed previews. Then a compile warning for a
  direct `remotion` import of a name the kit re-exports, in workspace components.
- More reference files: recording and scripts, brand inputs and the component.yaml keys were folded into the
  SKILL.md files and `reference/kit.md` (two references instead of five).
- `retake skills install | print`, and a `retake doctor` line for the plugin (installed, a duplicate `claude mcp add`
  registration, values that no longer exist: Claude Code does not check `type: file` values).
- Several workspaces per install and `{{env:…}}` secrets through a `sensitive` userConfig value: one workspace at a
  time, secrets in the keychain or the manual registration. Claude Code keeps the `--config` values once per user
  (`pluginConfigs`), not per `--scope local` folder, so a second install re-points the first folder's sessions (the
  skills stop on a root ≠ session folder; `engine_info` reports `started_in`). The fix to evaluate: `workspace`
  defaulting to `${CLAUDE_PROJECT_DIR}` (the session's folder) in `.mcp.json`, and project-scope installs.
- A copied install (a git or public marketplace) and its version policy: the local plugin loads in place, so its
  `version` pins nothing (BL-52).
- Slash commands, agents or hooks in the plugin (a `/retake:video` that starts the whole loop), MCP prompts that
  mirror the skills, `claude plugin eval` suites measuring triggering; checking argument values written as
  placeholders (`<scene>.<step>`), which the lint skips.
- Lint limits (documented, review of L3.7): a call written without braces (`run_dry` with `headed: true`) is not
  checked against the schema (only `tool {args}` is); the prose rules match words and phrasings (run `retake …`,
  "yourself", "unless", curl, password, "do what it says"…), so a loophole phrased otherwise still passes: the live
  probes of MACOS-CHECKLIST 12i are the check of behaviour.
- Claude desktop chat and claude.ai: a skill folder uploaded there, the desktop app's Code tab; documented as possible,
  not part of the live check (MACOS-CHECKLIST 12i).
- Not folded in L3.7 (own use): public listings (BL-52), the release-video skill (BL-13), the GitHub Action (BL-45).

- **Value:** The built-in library as replaceable as user components; installs that follow the user across workspaces;
  measured triggering.
- **Hard parts:** Many previews to regenerate and look at; keeping skills, prompts and listings in step with the tools.

### BL-78 — Phase 3 acceptance extras cut from L3.8
*S · cut in L3.8 · builds on: L3.8, L3.6, L3.2*

Cut to keep L3.8 an M (one scripted acceptance on an empty workspace, the scenario-changed warning, the live run as
MACOS-CHECKLIST 12j):
- The scenario-changed check where a comment is answered. `comments_list` could flag a thread whose render's run
  snapshot differs from today's scenario, and `comment_resolve`'s trusted summary could say so when the resolving
  render's run was captured from an older scenario file. Today a render of the old run, made after a scenario edit, is
  accepted as resolving (same scenario and variant, made later). Only `plan_preview` / `render` and the CLI warn.
- The same flag in `render_status` and the render job's result (it only matters before rendering).
- `project_create` takes environment URLs only: no `display:` address and no hooks (marking production stays a human
  edit by design). A project that shows a display address in its browser frame needs a hand edit of `project.yaml`.
- `render {like: <render_id>}`: a re-render after a re-capture repeats `template` and `overrides` by hand.
- A model-driven pass before the live run (a throwaway bridge letting Claude drive the stdio server in a test): the
  live run in Claude Code (12j) is the evidence instead.
- Refactoring the six slow MCP acceptances onto a shared helper (client, `call`, `follow`, `keep`, fixture start): each
  file still carries its own copy.
- Checking each phase's call order against the order of the skills' steps (today: an exact scripted sequence, and the
  tools the skill sections name compared as a set).
- `node scripts/requirements.mjs --check-cites` checks only test titles quoted as `'<file> > <describe> > <it>'`;
  evidence that names a test another way (a title alone, a file and a title in prose) is not checked.

- **Value:** The failure a re-capture prevents is caught at the exact point where Claude claims a fix; fewer hand
  edits for projects with display addresses; shorter re-render calls.
- **Hard parts:** A thread's render may come from a run whose snapshot is gone (renders/ or runs/ cleaned).

### BL-79 — Studio extras cut from L4.1
*M · cut in L4.1 · builds on: L4.1, L4.3, L4.4, L4.6, L5.2*

Cut to keep L4.1 an M (the app shell, Projects, the README editor, the index, live updates, MCP over HTTP):
- A Markdown preview of the README (a sanitising renderer or a sandboxed iframe: today plain text only).
- Creating, renaming and configuring projects from the Studio (project.yaml stays a hand edit or `project_create`);
  a workspace switcher (one server per workspace).
- ~~The themes and component gallery of SPEC §12 (R-UI-06 is L4.7)~~ — built in L4.7 (the library and theme screens;
  extras in BL-113); ~~the Geist fonts and the visual identity (R-UI-02, L4.9)~~ — L4.9: the palette closed (every
  colour a token, one accent) and the Geist pair named first in the font stacks; the font files are BL-120 (bundled in
  L5.9).
- How a person proves presence in the Studio — approvals, comment authorship, scenario edits holding secret references
  or outside files: the L4.1 allow-list runs under the agent's trust with no approver (a page's script cannot be told
  from a click). Decide per lot: approvals (L4.4: kept cut — a prompt in the `retake ui` terminal or the Tauri shell's
  OS dialog, BL-106), comments (L4.6: decided — the Studio writes as the channel `studio`, named by the `retake ui`
  process, a channel and not proof of presence; it creates, resolves, reopens and applies Claude's proposals on the
  thread version shown), block edits (L4.3: decided — agent trust kept, hooks unchanged from the Studio, a file
  holding a secret reference or an outside file read-only with why; presence for those is BL-95 / BL-106). L4.2 kept that rule for its Dry run / Capture buttons: a run whose
  hooks need a person is refused from the Studio with the `retake run …` command (shown before the click); approving
  from the UI is BL-106 (L4.4 kept it cut).
- Index-backed MCP tools (`render_list`, a search tool for Claude; BL-72 mentions `render_list`); the search over
  captions, scenario text and comments (today: project names and READMEs, scenario names, run and render ids).
- A stream of job progress to the page (today a `jobs` event carries ids and the page re-reads). ~~`/v1/media` for
  thumbnails (L4.2)~~ — decided in L4.2: no media route; thumbnails are base64 JPEGs over the gated call route
  (`run_thumbs`), shown as `data:` URLs (the CSP already allows `img-src data:`), made in memory and never stored. Video
  serving for the L4.5 Player is BL-80.
- WebKit and Firefox in the automated suite (browsers to install; MACOS-CHECKLIST 13a checks them by hand), keyboard
  end-to-end tests.

Residues documented in L4.1 (accepted for a local tool used by one person per Mac account):
- MCP over HTTP listens on a fixed port (47820) so a registration survives restarts: on a Mac shared with other
  accounts, another user's program could take the port while `retake mcp --http` is not running and receive the token
  Claude Code sends. A check that the listener is ours (a challenge signed with the token) or a per-user socket would
  close it. *Hardening (L5.18):* the server refuses to start beside a listener that is not its own and advises
  `--rotate-token`; the rest is BL-162.
- `.retake/index.sqlite` (and its -wal / -shm) take the umask's mode (0644 by default): other local accounts can
  read the project names and README text in it, as they can read the READMEs themselves.
- ~~`LocalStorage.readText` (README, scenarios) follows links inside the project and refuses those leading out, but it
  has no size cap and would block on a FIFO named README.md or a scenario file~~ — closed in L4.2 (core
  `readPlainFile`: regular file, 2 MiB, no FIFO; also `project.readme` at project load and the scenario a run submit
  reads). Core's other reads of project files — project.yaml, a sandbox.yaml or a template a project names, and
  `loadScenario`'s own read after the submit's check — get the same audit.
- Two Studio servers replacing the same stale ui.json at the same instant can both win (two servers, no corruption).

- **Value:** Fewer hand edits; the Studio as the place a person approves and comments; Claude finds renders and text
  without reading folders; a shared Mac without surprises.
- **Hard parts:** Proving a person's presence in a page without an OS dialog; a Markdown renderer that never becomes
  a script channel; a stable port that a client can authenticate.

### BL-80 — Scenario screen extras cut from L4.2
*M · cut in L4.2 · builds on: L4.2, L4.3, L4.4, L4.5*

Cut to keep L4.2 an M (the scenario as read-only blocks, run pictures, Dry run / Capture / Cancel); critique C1–C5 and
the lot's own cuts:
- The sidebar's scenario list (the project page links each scenario); a deep link to one step
  (`#/p/<slug>/s/<name>/<scene>.<i>`).
- Per-step mixing of runs (a step's picture from an older run that reached it when the source run did not): one source
  run per screen keeps a picture's provenance one fact.
- A disk cache of thumbnails (`<project>/.retake/thumbs/`, link-safe writes and pruning) if a measurement ever
  asks for it — today memory only (≤ 32 MiB in the server, ≤ 600 pictures in the tab).
- Virtualised step lists (today a file of more than 2,000 steps shows its first 2,000 and says so, review A #8; 1,200
  measured: pictures in ≈ 0.3 s); the text layer of a 2 MiB scenario still takes seconds to build once a minute (the
  blocks of 43,000 steps); "Picture shown when on screen" instead of "Loading the picture…" for rows not yet on screen.
- Pictures for the intro, the outro, cards and interstitials (component previews: L4.5 / L4.7); all pages of a
  multi-page step side by side; a large-frame viewer and two runs compared side by side.
- Live thumbnails while a dry run runs (today they appear when it ends; BL-105); ~~the running banner's live step
  list, log and live preview~~ — built in L4.4 as the Run screen (critique C5), "Watch live" from the banner.
- `run_thumbs` as an MCP tool for Claude (Claude reads review contact sheets); captions and scenario text in the
  search (BL-79).
- ~~"Open timeline" from a step (R-UI-15: the timeline screen is L4.5); video serving for the L4.5 Player (Range
  requests: a blob URL against a capability URL — decided there)~~ — built in L4.5: "Show in timeline" on a step bound
  to a capture, the capture served under the player origin's capability URL with Range.
- Approving hooks from the Studio (a capture whose hooks need a person: today the button says "needs the terminal" and
  shows the `retake run …` command); the sandbox reset, `until` and hooks of a dry run from the Studio (pinned out by
  `scenario_run`, critique B11) — L4.4 kept both out: approvals BL-106, the dry run's options BL-105.
- Per-step source slices in the payload (the page slices the text by offsets); a live region announcing the selected
  step (the option's accessible name carries it; screen readers are checked by hand: MACOS-CHECKLIST 13j, BL-122).

Residues documented in L4.2:
- One worker serves the workspace in the environment of the client that started it. Since the review fixes every
  client but the CLI gives it the same cleaned environment (engine `cleanWorkerEnv`): what still differs between an
  MCP-started and a Studio-started worker is only the starter's own variables that pass the cleaner (sign-in secrets,
  HOME, locale). A worker started by `retake worker` in a terminal keeps that terminal's environment and serves the
  clients' jobs too. `started_by` says which (sidebar, `retake jobs`, `retake doctor`); a worker per client
  environment would need a queue split.
- The worker-env cleaner is a deny-list (sign-in secrets are any name a project chose, so no allow-list): a credential
  under a name it does not know reaches the worker. A per-project allow-list of the `{{env:…}}` names project.yaml uses
  would close it.
- A hard link inside a run to a file elsewhere is read like any file of the run (the run folder reader refuses
  symbolic links and swapped folders, review A #7; a hard link is the file itself): only a process of the same user,
  which can read that file anyway, can make one.
- During a run the Studio's project list (L4.1, `project_list`) is read again at every step (a run's run.json is a
  file of its project: the `workspace` event names the project), as is `engine_info` at every job change: cheap reads,
  but a per-source flag in the event would spare them. The window's focus can fire twice (two reads at the same
  millisecond; useCall has no in-flight de-dup).
- The runner's own agent-trust refusal (a backstop after the submit's check) is worded per channel but only tested
  through the hooks package and the submit; a Studio run never reaches it with a scenario the submit accepted.

- **Value:** A scenario screen that scales, shows every segment, compares runs and approves from the UI.
- **Hard parts:** A person's presence in a page (approvals); keeping one picture per step honest when runs are mixed;
  serving video to the Player without a capability leak.

## Field feedback 1 (2026-10-26)

From the first real use (`docs/FIELD-FEEDBACK-1.md`); what went into a lot is L5.5 – L5.8.

### BL-81 — Edit "extras" independent of the capture
*M–L · field feedback 1 (chantier G) · builds on: L5.5*

A notification (and a callout, a badge, an app toast) should land on any shot — a chapter card, an interstitial, a
mail or document card included — at a relative moment (`at: end - 2s`, `at: 1.5s`) instead of only at the end of a
filmed step. A mail captured by a `wait_for_email` without a picture, anywhere in the take, is usable everywhere in the
render by its name (`as`), whatever the scene order; the wait itself happens off camera and is cut. `studio/mail-view`
with `notification: true`: the notification slides over the end of the previous shot, then the card opens. A warning
when a mail's notification shows on another persona's page (needs R-FLD-15). Six chapter starts in the field videos
needed a filmed waiting shot only for this.

### BL-82 — Multilingual scenarios
*L · field feedback 1 (chantier H)*

Switching the product's language rewrote every target, expected text and calendar label. Targets by translation key
(`{i18n: deals.actions.send}`) resolved from translation files declared in project.yaml; multilingual captions and
cards (`caption: {en: …, fr: …}`) and `render {locale}`; locale-formatted values (`{{money:408}}`, `{{date:+10d}}`,
`{{date_range:+10d,+23d}}`); a persona locale applied to the browser (Accept-Language, navigator.language, a
configurable localStorage key) and checked on `<html lang>`; an expected locale per scenario with the review detecting
the language of captured documents and mails.

### BL-83 — Reusable fragments and project vars
*M · field feedback 1 (chantier H)*

Three scenarios repeated the same twenty steps. Parameterised fragments (`use: {fragment: request-quote, with: {…}}`)
and project-level `vars` shared by scenarios; the step identity (comments, thumbnails, fingerprints) must survive
expansion.

### BL-84 — Storyboard before a take
*S–M · field feedback 1 (chantier H)*

`scenario_outline` / `retake outline`: chapters, scenes with page and persona, cards, mails, documents,
notifications and estimated durations, read in ten seconds before paying for a take (it would have caught a document
shown before its mail).

### BL-85 — Project memory
*M · field feedback 1 (chantier H)*

What a session learns while filming is lost: product rules, workarounds in place, checks to repeat, the user's edit
preferences. A `memory/` folder per project with `memory_list` / `memory_add` / `memory_get` in four kinds (rule,
workaround with date and reason, check, feedback); the MCP instructions say to read it before writing a scenario;
checks become review rules where possible and feedback becomes project defaults.

### BL-86 — Controlled data tools instead of direct access
*L · field feedback 1 (chantier H) · builds on: L1.8, L5.8*

Today the assistant prepares and resets data with ad hoc SQL, the mailbox API and scripts that mint tokens and push
queue jobs — allowed for lack of an alternative, but unreviewed and unversioned. Target: seeds and resets declared in
the project (`seeds/`, parameterised: `seed: demo-accounts`, `simulate: period-ended {booking}`), approved once like
hooks; MCP tools to draft, statically check (no DELETE without WHERE, allowed tables, local environments only), run
with a journal and roll back, snapshot and restore; an allow-list of environments and databases and a refusal of
production. Long term, the server's instructions and the machine's permissions refuse direct `psql`, `curl` to the
product's API or queue access outside a validated script. Ready-made hook kinds for queues (BullMQ / Redis) and an
`http` hook authenticated as a persona belong here.

### BL-87 — Demo hygiene checks
*S–M · field feedback 1 (chantier H)*

Real names showed in the account bar and in mails. A `forbidden_text` list per project (real names, "demo", "test")
searched by the review in captured pages, mails and PDFs; `auth_login` says which account is signed in (the visible
name or a persona `check.identity`).

### BL-88 — Iterating past an irreversible step
*L · field feedback 1 (chantier B) · builds on: L3.3, L5.6*

Irreversible steps are skipped in dry runs and inspections, so everything after the first real send is only tested
by real takes (5 takes for one scenario in the field). Options: resume a take from a step on the state a failed take
left, then assemble the parts or re-film once validated (`run_capture {from: <step>}`); an exploration mode that
performs the writes, keeps no video, stops at the first error and leaves `page_inspect` on the reached state; a
`scenario_check` that replays to the first write and checks the remaining targets against the states of the last
successful take; `page_inspect` reusing a previous inspection's state when the steps before `until` did not change.

### BL-89 — A render and a capture at the same time
*M · field feedback 1 (chantier E)*

The worker runs one job at a time (a capture is CPU / GPU heavy), so a 5-minute render blocks the next take. Allow one
render next to one capture, once L5.7 has brought a take's cost down and measured the overlap. *Superseded on
2026-10-28 by BL-116: captures go first and a running render is paused during a take, instead of both running at once.*

### BL-90 — Edit re-plan: project-level changes and unmeasured targets
*S · L5.5 follow-up*

L5.5 re-plans the edit of today's scenario on an existing take while the scenario's filmed part is unchanged. Two
gaps: a change in project.yaml (an environment's URLs, personas, project vars) is neither compared nor reported — a
take filmed against other data still renders as if nothing changed; and an overlay or a camera hint added after the
take that names an element the take never measured falls back to its step's target box (a plan warning). Options:
record a digest of the resolved environment and persona bindings in run.json and compare it; measure every visible
element's box per step cheaply (or the elements the scenario names anywhere) so a later overlay finds its own target.

### BL-91 — Edit-only renders in the Studio
*S · L5.5 follow-up, for L4.5 (not taken by L4.4: BL-105)*

The Studio's scenario screen says "only the edit changed since this run" but offers no render: a Render button on that
notice (and a list of the edit changes, as plan_preview gives them) would close the loop without the terminal or MCP.
*Built in L4.5 (R-UI-26):* Render on the timeline (the capture shown, the version shown: `expect_edit_sha256`) with the
review inline, the queue and the renders with their verdict on the timeline and the scenario screen; the timeline says
what changed since the take ("changed since the take: frame of quotes"). The list of edit changes as plan_preview gives
them stays open.

### BL-92 — A field still covered after the scrolls
*S · L5.6 follow-up*

`type {into}` scrolls a covered field towards the middle of its container twice, then clicks anyway and fails on the
focus check: the click may act on what covers it (on the fixture it picks a day of the calendar left open). Options:
fail before clicking and name the covering element; or close what covers it when it is a popover the previous step
opened (a click on the dialog's title, as `click: {outside: true}` does), with a warning. Decide on real products.

### BL-93 — Dead clicks the page cannot see
*S · L5.6 follow-up*

A click whose only effect is a clipboard write without feedback or a websocket message is reported dead; a page that
keeps changing by itself (a clock in the DOM, attribute-driven animations) hides a dead click. Options: count websocket
frames sent and clipboard writes; ignore DOM changes the page made in the second before the click; a step option
`expect_effect: false` for a click that is meant to do nothing visible.

### BL-94 — Missing targets beyond the page change
*M · L5.6 follow-up · builds on: L3.3*

When a target is missing, R-FLD-10 looks up the scene's later targets on the current page only, up to the first step
that opens another page. An off-camera inspection of the pages the later steps open (as `page_inspect {until}` does)
would check every remaining target of the scenario in the same failed take.

### BL-95 — Blocks editing extras cut from L4.3
*M · cut in L4.3 · builds on: L4.3, L4.4, L4.6*

Cut to keep L4.3 an M (the YAML tab, step moves / duplicates / deletes with drag & drop and Alt+↑ / Alt+↓, undo / redo,
the inspector's form and a palette of 15 actions):
- Scene edits from the Blocks tab: moving, adding, duplicating and deleting scenes, cards and interstitials, and their
  values (page, open, caption, speed, layout); today the YAML tab.
- Forms beyond scalars and a flat target: lists (`steps` of a `menu`, `keys`, `files`), points, nested targets
  (`in: {…}` as a target, `contains`, `last_visible`), the `optional` / `when` style fields a form cannot show today,
  overlays and code (`eval`, `emit`, `cursor`); the form names them for the YAML tab.
- YAML tab saves as entries of the Blocks undo history (today a YAML save clears it — undone in the YAML tab).
- Drag & drop in WebKit and Firefox in the automated suite (checked by hand: MACOS-CHECKLIST 13c); a pointer-only
  drag fallback if a browser's native drag misbehaves.
- Person presence for files the Studio does not write (a secret reference, an outside file: read-only with why) and for
  hook edits from the Studio (today refused: "hooks unchanged") — a presence decision (BL-106), not a structural rule (a
  "moved or deleted, never edited" rule still lets a page script move a secret-typing step onto another page).
- Duplicating a step makes (fingerprint, n) of later identical steps name another one: a comment anchored on such a
  step locates the first copy (L4.6's locator by `step_id` first).

Residues documented in L4.3:
- MCP `scenario_save` can plant a hook agent trust does not refuse: a `shell:` hook that copies a private file into
  the project (`cat ~/.ssh/… > assets/…`), a `python3 -c …` or an inline `js:` hook get no error and no trust problem
  (only a destructive command, which needs `confirm: true`, and a URL host are caught); the person's `retake run` then
  runs it without a prompt (author trust: only destructive hooks ask), and the Studio's own Capture refuses it (needs a
  person). The Studio cannot write one (hooks unchanged). Closing it: an approval at run time for hooks an agent wrote
  or changed (BL-106), e.g. a hooks digest signed by the person.
- Closed in the L4.3 reviews: an undo that brings back a hidden character the file no longer has works (restore takes
  only a version the Studio showed or wrote, which was on disk); a var templated into a hook can no longer be changed
  from the Studio (vars and env are frozen while the file has a hook or a mock).
- A hidden character on a line the file has is kept only while that line is unchanged: a form edit of another field on
  that line (a flow map) is refused; the form locks a field that holds one.
- A move back by hand gives the same value but not always the same bytes (about 2 % in the review's fuzz: a blank
  line or a column-0 comment does not travel with a step); undo is byte-exact.
- The edit's live region and errors are tested in Chromium only; VoiceOver is checked by hand (MACOS-CHECKLIST 13j).

- **Value:** The whole scenario editable from the Studio; one undo history for both tabs; edits of files holding
  sign-in references once a person's presence can be proved.
- **Hard parts:** Scene moves keep comment ownership and page continuity honest; forms for recursive targets without a
  second YAML writer; proving a person's presence in a page.

### BL-96 — One write lock for every writer of a project file
*S · L4.3 review follow-up · builds on: L4.3*

Every `if_match` write of a project file holds the engine's write lock (the Studio, MCP `scenario_save`, the README,
comments). Core's own writers (`saveScenario`, `writeTextAtomic`: a new project's files, scaffolds) take none — core
cannot take the engine's project lock — and write without `if_match`. Moving the lock (TakeLock) where core can use it,
or routing those writes through the engine, would make every writer of a scenario or a README wait for the others.

- **Value:** No write of a project file can interleave with a Studio or MCP save, whoever makes it.
- **Hard parts:** Core stays free of the sandbox package; the CLI's writes of new files have no version to match.

### BL-97 — Throttle a persona's page nobody films
*S · L5.7 follow-up (R-FLD-25)*

L5.7 measured the two-persona fixture (`two-personas`: the console's quote list polls every second while the café is
filmed): the unfilmed browser costs ≈ 0.02 core, so nothing is throttled. run.json `perf.cpu.browsers[].unfilmed`
measures it on every take and the run warns above 0.25 core. When a real product's page costs that much off screen
(animations, a heavy polling list), freeze it while no recorder films it (CDP `Page.setWebLifecycleState: frozen`,
`active` before its scene or a step on it — its polling resumes, so it is fresh when filmed) — watching what a frozen
page misses meanwhile (web notifications, a hook's `js` tab in that browser).

### BL-98 — Fewer screencast frames during motion
*S · L5.7 follow-up*

With capture.mp4 encoded in hardware during the take, Chromium's browser process is the largest cost of a take (≈ 0.45
core on the fixture: it reads every compositor frame back and encodes it as JPEG, ≈ 55–60 frames a second while the
cursor moves, for a 30 fps video). `everyNthFrame: 2` while the output is 30 fps would halve it; measure the judder it
may add (frames then land near the output ticks and their timing noise can pick one twice) and keep 60 Hz for the raw
export (`keep_frames`). Bench of 2026-10-28 (a page moving on every animation frame, 20 s): everyNthFrame 1 → 75
frames a second, 23 cpu-s for the tree; 2 → 37 fps, 17.5; 3 → 25 fps, 13.2. BL-115 removes the JPEG step altogether.

### BL-99 — Slow transitions and waits on page tracks
*S · L5.7 follow-up*

The screen activity behind slow transitions (R-FLD-23) and the waits the edit shortens (R-FLD-26) is computed on the
main capture only; a multi-page scene's tracks have none. Feed each track's encoder the same grey thumbnails and
analyse its clicks (`on:` steps), then cut its waits only where no other page of the run acts (like held loads).

### BL-100 — Pruning beyond runs, renders and reviews
*S · L5.7 follow-up (R-FLD-28)*

`retake prune` / `project_prune` leave `exports/` (raw packages, exported formats), inspections and recordings
(`.retake/…`) and the job history alone. A size budget per project (`prune: {keep_renders, max_gb}` in
project.yaml, applied after each render) and a workspace-wide `retake prune --all` would keep a busy week under control
without thinking about it.

### BL-101 — Scene options and named hooks from the Studio
*S · L5.8 follow-up (R-FLD-31)*

L5.8's `hook:` step moves, edits and is added from the Studio's palette like any step, but a scene's options
(`offscreen`, `skip`, `speed`, `still`…) are edited in the YAML tab only, and the named hooks (`hooks:`) are listed
read-only — they run on this Mac, like setup and teardown. A scene inspector (toggles for `offscreen` / `skip`, a
speed) is the cheap half; editing hooks waits for the Studio to approve hooks (a person's approval in the page, as MCP
elicitation does).

### BL-102 — A hook step that waits for its effect
*S · L5.8 follow-up*

A `hook:` step returns when its entries have run; what they changed reaches the filmed page when the page fetches it
(the fixture's list reloads every second). A `then: {wait_for: …}` on the step — or the cut ending at the first frame
that changed after the hook — would keep the cut tight without a `wait_for` step after it, and a page that never
reloads could be refreshed off camera (`reload: true`).

### BL-103 — Page pre-flight per page
*S · L5.8 follow-up (R-FLD-33)*

The pre-flight GETs every page of the environment and stops the take when one does not answer, used by the scenario
or not. A page the product serves only on demand (an admin started separately, a page behind a VPN for another
scenario) would want `preflight: false` on the page, or the check limited to the pages the scenario opens (core
planPersonas already knows them), with a warning for the others.

### BL-104 — Compact results for the other large tools
*S · L5.8 follow-up (R-FLD-34)*

L5.8 measured and cut `page_inspect`, `run_status` and `review` (and every result's JSON is one line now).
`plan_preview` (segments, trims, notes of a long video), `render_status` (timings, ffprobe), `comments_list` and
`job_list` were not measured on a 4-minute video: measure them on one and give the largest a `detail` too.

### BL-105 — Run screen extras cut from L4.4
*M · cut in L4.4 · builds on: L4.4, L4.5, BL-25, BL-73, BL-80*

Cut to keep L4.4 within its size (the live picture, the Run screen with its steps, log, pause and stop, the Sessions
panel and the capture's session confirmation):
- The live preview's input channel (BL-25 recording through the preview, BL-73 held inspections): the wire format
  leaves room (`kind` / `v`), nothing built.
- A live picture of every page of a multi-page scene side by side (today it follows the acting page); live pictures
  for `record` / `inspect` jobs and for a `retake run` in a terminal (no worker: steps and log only).
- A cheaper picture during a capture — a narrower `maxWidth`, fewer frames a second: measured at ≈ +15 % Chromium CPU
  on a take (DESIGN §4f), which is why it is off by default there.
- An MCP `run_pause` tool (Claude sees `paused` in run_status and can stop a run, not pause one).
- A crossfade (or a review note) at a capture's pause cut; re-anchoring the product's running clock after a pause
  (today what moved meanwhile jumps); pausing inside a step or during hooks.
- The sandbox reset, `until` and the hooks of a dry run from the Studio (BL-80 residue: `scenario_run` pins them out).
- A live "check the sessions now" (a headless check job; today the stored state, and the run's own preflight before it
  films); a keychain item of a persona's login steps checked for existence from the Studio (today counted and taken as
  there: the Studio never touches the keychain); the login variables of the worker actually running (today: the
  environment of the worker this Studio would start).
- A headed sign-in in a temporary copy of the persona's profile, swapped in only when it succeeds (today a stopped
  sign-in leaves what the window changed in an existing profile, and says so).
- ~~Render from the Run screen (BL-91, L4.5)~~ — L4.5: the Run screen's outcome opens the capture's timeline, which
  renders; recording or exporting the preview; live thumbnails on the scenario screen
  while a run runs (BL-80).
- WebKit and Firefox in the automated suite (MACOS-CHECKLIST 13e checks them by hand).

### BL-106 — Person presence in the Studio (approvals from the UI)
*M · cut in L4.4 · builds on: L4.4, L5.2, BL-79, BL-80, BL-95*

The Studio's page runs under an agent's trust with no approver: a page script cannot be told from a click, so what
needs a person stays in the terminal — a capture whose hooks need approval (the button says "needs the terminal" with
the `retake run …` command), hook edits and files holding a secret reference or an outside file (read-only with why,
BL-95), and an approval at run time for hooks an agent wrote or changed (the L4.3 residue). A presence primitive the
page cannot forge would open them: a prompt in the `retake ui` terminal, or the Tauri shell's OS dialog (L5.2).
**Amended in L5.2 (the shell exists; nothing of this is built):** the primitive's shape — the server asks through the
supervised pipe (`{"type":"confirm","id","text","buttons"}` on the stdout of `retake ui --supervised`; `buttons` the
labels, the first the default, the last the cancel), the shell shows a native sheet / NSAlert (the text as plain text,
those labels as the app's own buttons), the answer goes back on the child's stdin (`{"type":"confirmed","id","button"}`,
the index pressed; the same shape as DESIGN §4j); the page can neither raise one nor answer it (it has no IPC and no access to the
pipe); a browser tab keeps the terminal prompt. Today `--supervised` reads and discards its stdin. DESIGN §4j.
**Amended in L5.12d:** the desktop quit question is the first page → shell answer, and it is NOT presence: the page asks
`desktop_answer` (an own op behind the Studio token) and the server writes the answer on its stdout pipe; any program
holding the token could answer a question it was shown the id of — harmless there (the person's own quit question,
taken only for the id the shell put in its window's page, once, and every answer only quits or keeps the app). A
presence primitive still needs the shell's own UI (an NSAlert the page cannot touch), the stdin direction above unused.
Residue documented in L4.4: the capture's session confirmation (`sessions_ack`) is a guard against a wasted take, not
presence — a page script can send it; the run's own preflight stays the authority and stops before filming a persona
it can check (a `check`, or never signed in); one without a `check` is used as saved and fails only when a page lands on
the sign-in page, after its setup hooks (the confirmation says so).
L4.6: a Studio thread's channel `studio` is not presence either — any program of this user that reads the Studio's
token file writes the same entries (Claude Code's shell included; its rule against that is an instruction, not a
barrier), as that shell can write `cli` entries with `retake comment`; Apply of a proposal from the Studio runs the
Studio's agent-trust write rules, never more.

### BL-107 — Timeline editing extras cut from L4.5
*M · cut in L4.5 · builds on: L4.5, L4.7, BL-95*

Cut to keep L4.5 an L (the timeline, the preview, one-click switches of the edit's values, render and review from the
Studio):
- Variants (vertical, square) previewed and rendered from the Studio; ~~a theme picker (L4.7)~~ — built in L4.7 (the
  inspector's *Theme (this scenario)*, the scenario's `template`); a component's params and slots edited from the
  inspector; component previews (pictures or animated) in the inspector's options (still open: the L4.7 library's
  cache makes them cheap, BL-113).
- Caption, card and interstitial text edited on the timeline; per-scene caption components; a general scenario
  `components:` map (L4.5 added the narrow `caption_component` key only, critique B9).
- Durations and holds dragged on the tracks; overlay and camera spans edited on their tracks; per-step speeds (today a
  scene's speed); multi-select; a music waveform on its own track.
- Zoom levels beyond "fit" and "about ten seconds per screen".

### BL-108 — Preview fidelity and media cut from L4.5
*M · cut in L4.5 · builds on: L4.5, L5.7*

The preview plays the render's own composition, so it shows the plan's frames; what it does not do yet:
- Frame-exact playback through speed ramps and cuts (WebCodecs, or `@remotion/media`'s `Video` in preview mode): a
  paused frame is exact, playback seeks at a ramp or a cut (measured smooth on the fixture: 29.7 frames / s of 30).
- A preview proxy made by a worker job and pruned with its run — short GOP, smaller, or VP9 — for a browser without
  H.264 (a Chromium build without proprietary codecs gets a message only, critique Q5) and for takes whose keyframes are
  more than a second apart (the screen's "scrubbing is slow" note names that trigger, critique B14).
- Lottie expressions in the preview (they would need `'unsafe-eval'` in the frame: no).
- The capture's colours: measured in L4.5 part F (DESIGN §4g "Preview versus render"), the preview draws the capture
  ≈ 3–4 levels brighter on near-white and ≈ 10 on mid-tones than the render (renderStill and the encoded render agree
  within 1); what the frame composes around it differs by ≤ 2. Two decoders of a bt709 / limited-range file with no
  transfer or primaries tags: tag the capture's colour metadata at encode time, or convert the same way on both sides.
- Premounting the next clip and `acceptableTimeShiftInSeconds` tuning, if a longer or heavier take ever stutters at a
  segment boundary (not needed on the fixture).

### BL-109 — Verify extras cut from L4.5
*M · cut in L4.5 · builds on: L4.5, L4.6, BL-72*

- Watching a finished render in the preview (a second media mode of the frame, an op, a codec path; critique C1).
- Exports (formats, GIF) started from the Studio; two renders side by side or as a difference view.
- A key-frame gallery and a per-scene sheets' viewer (the review panel lists scene sheets, key frames and the diff
  sheet since the L4.5 review, at most 24 images, one after the other).
- Seeking the preview from a finding of a render of ANOTHER version by its segment and offset (today only a render of
  the same plan and theme files seeks; others say so).
- A review from the Studio with other settings (2 fps, against the previous render); the Studio's renders at another
  scale (today 1920×1080, pinned).
- `scenario_renders` reads at most 200 render jobs and 50 review jobs of a project per call (queue list limits).

### BL-110 — Player isolation residues of L4.5
*M · cut in L4.5 · builds on: L4.5, BL-42, BL-72, BL-79*

The preview frame is a cross-origin `sandbox="allow-scripts"` iframe on a second loopback origin under a strict CSP
(DESIGN §4g); what it does not cover:
- **WebKit has no process isolation for sandboxed cross-origin frames:** in Safari (and Tauri's WKWebView, L5.2) a busy
  component — a long loop in its render — freezes the whole Studio tab until it returns; Chromium runs the frame in its
  own process. A message flood is still stopped by the page's budget in every browser (MACOS-CHECKLIST 13f).
  Confirmed for the desktop app's WKWebView (L5.2): the frame shares the window's web process, so a busy allowed
  component freezes the window; the app's menu stays native and ⌘Q still quits (MACOS-CHECKLIST 14a).
- DNS prefetch (the `X-DNS-Prefetch-Control` header is honoured by Chrome only) and WebRTC (the constructors deleted in
  the frame; a CSP `webrtc 'block'` once browsers have it) — as BL-72 for renders.
- The player origin's port taken by another local account first (as BL-79's Studio port); capability URLs readable by
  any local process while they live (they die with the project's last timeline page, the Studio process, or a
  rotation; a tab closed without leaving keeps its lease two hours).
- **Chrome's prerender ignores a frame's CSP and sandbox** (review A of L4.5: a `<link rel="prerender">` in the frame
  fetched an arbitrary URL and resolved an arbitrary host name; installed Chrome and Chromium, not the headless shell).
  Closed in L4.5 by three layers — boot.js refuses the token on every way to set a `rel` and refuses child frames,
  Trusted Types with no policy close the HTML parsers, and a workspace component runs in the preview only once the
  person allowed it this session (built-in components always run) — but a future browser feature that fetches from a
  frame without the CSP's consent would reach an allowed component again: re-run review A's probe on each new Chrome /
  Safari major (MACOS-CHECKLIST 13f). An allowed component is trusted code for that session.
- Trusted Types are Chromium's (Safari and Firefox enforce them only in recent versions): there the HTML parsers stay
  open to an allowed component; the prerender token checks and the allow-list hold in every browser.
- A message of up to the budget's size (one huge message) is accepted (review A N5): bounded by the browser's own
  limits; an optional bytes budget if it ever matters.
- The render path's webpack bundle has no import allow-list (the preview bundle's checks real paths; BL-42).

### BL-111 — Frame comments UI extras cut from L4.6
*M · cut in L4.6 · builds on: L4.6, BL-76, BL-106, BL-109*

Cut to keep L4.6 an M (the Studio's Comments screen, a render's exact frames, Claude's edit-only proposals previewed,
applied and re-rendered from the Studio):
- **Filmed proposals** (critique C1): a proposal that changes the filmed part (steps, pages, waits) — an "Apply, then
  Capture again" branch and a filmed preview banner. Today a proposal is edit-only (refused otherwise, with the filmed
  keys named) and Claude takes the direct loop for such a thread. Also proposals for anything but the thread's own
  scenario file (a theme, render overrides, project.yaml — never hooks) or for several files at once.
- **Project-page counts** (C2): open comments per scenario on the project page with links (today "Comments (N open)"
  beside a scenario's tabs only; `comments.counts` already answers per project), and a project-wide Comments screen.
- **A keyboard-movable region box** (C3): arrows moving / resizing the drawn box. The four % fields are the WCAG 2.5.7
  single-pointer and keyboard alternative today.
- **The timeline's "Selected comment" strip** (C4): a panel under the tracks for the comment under the playhead (a
  pin's tooltip has Open thread and the other-take card's items are links instead).
- Playing a render in the Comments viewer (BL-109's media mode) and a segment / step strip under its slider;
  commenting the timeline's preview of a version not yet rendered (a comment needs a render's frame).
- A three-way merge of a stale proposal (today: "ask Claude to propose again"); a person editing a proposal before
  applying it, or proposing to Claude; `retake comment apply` and a proposal view in the CLI; Undo apply after a reload
  (the last apply lives in the tab; the YAML tab's history does not hold it either).
- Thread paging past the newest 100 entries in the Studio; comments in the index and its search; notifications when
  Claude answers (live only while a page is open); editing or deleting entries, several regions, attachments (BL-76).
- Safari, Firefox and a real drag in the automated suite (MACOS-CHECKLIST 13g by hand; the suite drives Chromium and,
  gated, the installed Chrome).

### BL-112 — Lazy-loaded Studio screens
*S–M · cut in L4.6 · builds on: L4.1, L4.6*

The Studio app is one esbuild bundle that grows with each screen (L4.6: the Comments screen and the proposal view;
the test budget is raised each time, never a reason to cut). Code splitting with a chunk route under the same gate and
CSP (a hash-named chunk per screen, loaded on its route) would keep the first load small.

### BL-113 — Library and theme editor extras cut from L4.7
*M · cut in L4.7 · builds on: L4.7, L3.5, BL-75, BL-106, BL-107, BL-112*

Cut to keep L4.7 an M (the Studio's component library with posters and looping GIFs rendered by the worker, the theme
editor with a live preview, undo / redo and *Use in this scenario*):
- **Loops as WebM / AV1** in a `<video>` (needs `media-src` in the Studio's CSP and a media route; GIF today, no CSP
  change); loops of the vertical / square variants; animated previews through MCP (`component_preview` keeps its
  stills).
- **A theme reel** (intro → clip → outro with the theme's transition, one composition) instead of the editor's three
  switched previews; the cursor in the live preview (the runner draws it at capture: no component, no loop — R-UI-06b's
  gap).
- **Font adoption**: font files (and their licence notes) added to an existing theme from the Studio (today the type
  pair is limited to the theme folder's own fonts; new fonts come with *New theme*); logo adoption (`theme_adopt`,
  cut in part A: a logo is a file the person drops into the theme folder, then picks); theme media files (intro / outro
  video, image, Lottie) chosen in the editor.
- **Params and text styles**: a component's params and slot defaults edited per theme (layout width, radius…);
  captions' text styles, frame, durations, interstitial and brandmark fields; a template.yaml text tab with live
  validation (the scenario YAML tab's twin).
- **Rename / delete** a theme; a theme diff; light + dark pairs; **Copy to edit** of a project's own folder theme
  (theme_copy takes a listed name: today a hand copy).
- **Site approval from the Studio**: the site panel shows the `retake theme from-site <url>` command to copy; approving
  a URL in the page needs the person's presence (BL-106); a screenshot of the extraction in the panel (`site_image`).
- **Newest-wins job merging**: a queued library job cancelled and merged with a newer request (racy with the worker's
  claim); today each request is a job of ≤ 12 components, ids already queued are skipped and the worker skips cached
  keys.
- **Play live in the library** (the live Player per card; the loop is the library's motion, the live frame is the theme
  editor's) and **hover-play** (loops start on Play only).
- Library extras: editing a workspace component's params from the detail; two components or two themes side by side;
  thumbnails of the library's posters in the timeline inspector's options (BL-107 keeps it: the cache makes it cheap);
  the marketplace source (V2).
- Measured in L4.7 part E, not fixed: `studio/document-pdf`'s loop is the only one that needs the 480 px fallback (1.16 MB
  in editorial); a dark copy of editorial keeps the starter's dark-ink wordmark.svg (invisible on a dark background — a
  theme file, not a component fault; a light wordmark comes with the person's own brand files).
- Left after the L4.7 reviews: a library key recomputed after the bundle (a component edited while its job runs is
  written under its old key — the next view asks the new one again); `<workspace>/node_modules` stays in webpack's
  lookup for workspace components (outside every component folder, same trust as renders); a theme deleted and made
  again at the same path keeps the old one's shown versions for `restore` (they were on disk there once).

### BL-114 — Renders on the GPU, with a lighter load
*S · measured 2026-10-28 (M4, fixture `quote`, 60 s of 1080p video) · lot L5.15 (2026-10-29) · **done in L5.15***

Done in L5.15 (DESIGN §4r), with three corrections from measurement: the no-GPU fallback is today's software path, not
`swangle` (10× slower: 678 s for the fixture); VideoToolbox gets `gopSize` 2 s (Remotion passes no `-g`: ffmpeg's
default of 12 frames) and 0.13 bit per pixel per frame (8 Mb/s at 1080p30; 4 Mb/s was short on scroll frames);
VideoToolbox is chosen before the render (each side ≤ 4096: an oversize session breaks the encoder's pipe mid-render).
The 5-minute render was measured at 4 min 05 s (7 346 frames): no growth of the GPU process, no failure. What follows
is the study as it was.

A render costs far more than a capture: 430 cpu-s for 60 s of video (7.2 cpu-s per video second against 0.85 for a
take), 6.75 cores on average for 64 s and peaks at 14.5 at the default concurrency of 7. Chromium's page renderers take
230 cpu-s of it (the headless shell rasterises in software), ffmpeg 96, Node 35. Measured by injecting options into
`renderMedia` / `openBrowser` (no code change):

| Variant | cpu-s | Wall | Cores mean / peak |
|---|---|---|---|
| Today (concurrency 7) | 430 | 64 s | 6.75 / 14.5 |
| `chromiumOptions.gl: 'angle'` | 258 | 45 s | 5.8 / 7.8 |
| angle + VideoToolbox (`hardwareAcceleration`, `videoBitrate` 4M) | 225 | 43 s | 5.2 / 7.9 |
| angle + VideoToolbox, concurrency 3 | 229 | 58 s | 3.95 / 6.6 |
| Concurrency 2 alone | 386 | 94 s | 4.1 / 7 |

- **angle**: the renderers drop from 230 to 65 cpu-s; SSIM 0.997 against today's render, every frame above 0.994,
  the differences are faint anti-aliasing edges invisible at 1×. Remotion warns of a Chrome memory leak on long renders
  with angle: measure a 5-minute render (memory, failures) before making it the default; keep a software fallback for
  machines without a GPU (`swangle`).
- **VideoToolbox** only engages without `crf` (with it, Remotion silently keeps libx264: the file came out byte for
  byte identical): set `videoBitrate` instead; ffmpeg 96 → 56 cpu-s. The file is 2.5× larger at the same SSIM (26 MB
  against 10 MB): accepted (decision of 2026-10-28, the size of a render is not a concern).
- **Concurrency**: a lower default (3 with angle) renders as fast as today with half the load; the output does not
  depend on it (concurrency 2 gave the same file). Render time matters less than the take's margin: renders run as
  background work after the captures (BL-116), at a lower priority (`nice`).
- Left unexplained: the 56 cpu-s ffmpeg keeps with VideoToolbox (decoding Remotion's JPEG q95 frames, the BT.709
  conversion — to profile). Previews and stills (`preview.ts`) open their own browser: same options there.

### BL-117 — The job queue on pg-boss over an embedded Postgres
*L · decided in principle 2026-10-28 · **parked 2026-11-04 — the file queue stays; captures first was built on it
(L5.14)** · would amend ADR-1 · builds on: L3.1, L4.1, L4.4, L4.8*

Parked: on 2026-11-04 the person chose no new dependency; captures first (BL-116) was built on the file queue in
L5.14 (DESIGN §4q). What follows is kept as the study, should a standard queue be wanted later.

Replace the file queue's state (`packages/engine/src/jobs/`, ≈ 5,800 lines with the job kinds; `FileJobQueue` used by
`engine.ts`, `renders.ts`, `reviews.ts`, `record.ts`, the index's `jobs-watch.ts` and the Studio server's live
routes; 21 test files) with pg-boss on a Postgres Retake ships and runs itself. **Why:** a standard queue instead of
a format of our own (pg-boss is the most used Node queue, MIT; a queue viewer that reads pg-boss reads Retake
with nothing specific to it, and `@pg-boss/dashboard` exists meanwhile), with what BL-116 needs built in, and **nothing
to install apart**: the Postgres binaries come with `pnpm install` (`embedded-postgres`, per-platform packages for
macOS, Linux and Windows), as Chromium and Remotion's compositor already do — and later inside the macOS app (L5.2,
BL-36) like the other bundled executables.

**Not chosen** (2026-10-28): BullMQ over Valkey (a Redis-compatible server to install apart: no macOS binaries
published, Homebrew only — not self-contained); pg-boss on PGlite (Postgres in WASM, 26 MB, supported by pg-boss, but
one connection in one process: the CLI, the Studio server, the MCP server and the worker would go through a socket
multiplexer that "does not guarantee all use cases"); SQLite queues (no daemon, but niche: a viewer adapter would be as
specific as one for our files); Restate (durable execution replays journaled steps, which a capture driving a browser
cannot do; server under BSL 1.1); Faktory, a Rust queue (apalis 1.0 still a release candidate, Rust workers only).
Keeping the file queue stays the fallback: self-contained already, BL-116 is a small change there.

**Postgres on the machine** (one for every workspace, so captures-first holds machine-wide):
- `embedded-postgres` (MIT, ≈ 1 M downloads a week; the macOS arm64 package is ≈ 148 MB unpacked; its version carries
  a "beta" suffix — pin it and check its update cadence). Its data in `~/.retake/postgres/` (0700), initialised
  on first use; started on demand by the studio as the worker is today, left running, stopped by `retake` on request;
  `retake doctor` checks it.
- Listening on 127.0.0.1 on a port of its own, password authentication, a random password in a discovery file (0600)
  — no `trust`: the capture browser's pages can reach loopback ports (the Postgres protocol is not HTTP, still to test
  with a hostile page). A viewer connects with host, port, user and password.
- pg-boss needs PostgreSQL 13+ and Node 22.12+ (we require 22): check our Node floor.

**Mapping** (from pg-boss's queue and job docs, to check while planning):
- Queues: `capture` (run, record, auth_login, inspect, hooks, env_reset, sandbox_up / reset) with the **`singleton`**
  policy (one active job, any number queued) and `heavy` (render, export, review, preview, site), `singleton` too;
  priorities inside a queue (higher number first). The workspace root travels in the job data, checked against the
  workspaces the machine knows. One worker process per machine (`work()` on both queues), started on demand, exiting
  when idle, handing over on a new build as `worker.ts` does.
- **No retry of a capture**: `retryLimit: 0` everywhere; `heartbeatSeconds` (≥ 10, sent by `work()`) fails the job of
  a dead worker — today's `interrupted`, kept as its failure reason — and its clean-up runs from the next worker as now.
  `expireInSeconds` (default 15 min, max 24 h) raised for long takes and 4K exports.
- **Captures first**: the heavy worker watches the capture queue; a capture becomes active → it stops its running
  job's process group (SIGSTOP) and resumes it (SIGCONT) when none is. A stopped process sends no heartbeat: send one
  (`touch()`) and suspend the heartbeat check for that job, or set its heartbeat longer than any take, or it is failed.
  Jobs run inside the worker process today: a heavy job needs its own child process to be stopped alone.
- States: `created` / `retry` → queued, `active` → running, `completed` → succeeded, **`cancelled`** (native), `failed`
  (with interrupted as a reason). Cancel → `boss.cancel(name, id)` for a queued or active job; the worker sees an
  active job cancelled and aborts it (the runner already honours an AbortSignal). A capture's pause (L4.4) and a
  recording's stop (L4.8: `requestStop` / `stopRequested`, a `record` job finishes its recording and runs its check)
  stay markers the worker polls (a small table or the job's own data instead of files).
- Progress and events: pg-boss documents no progress or log feed for an active job — keep `events.jsonl` in the job's
  folder (one writer, as now) or a table of our own beside pg-boss's; the Studio's job stream reads job states with
  LISTEN/NOTIFY or a poll. Queue position from the queued jobs in priority order.
- **What stays files** (ADR-1 for everything but the queue's state): a job's folder for its files (a render's
  edit.yaml snapshot, browser.json, live.json — the live channel's token never goes to the database), runs reserved
  at submit (`runs/<id>/run.json`), `history.jsonl` and the index. Job data holds no secret already (inputs carry
  `{{env:}}` / `{{keychain:}}` refs, resolved by the worker) and its approvals stay signed (signing.ts).
- Retention: pg-boss's retention settings for finished jobs; the history stays in history.jsonl.
- **CLI commands** (`retake run`, `render`, `export`) run outside the queue today: they enqueue and follow (one path,
  captures-first everywhere), or take the singleton slot themselves — to decide.
- **A queue viewer** acts with pg-boss's own operations (cancel, resume, retry, delete): a retried capture re-runs a
  take — refuse a retry on capture jobs (job data flag the worker checks) or lock that connection in the viewer.

**Cost**: dependencies `pg-boss`, `embedded-postgres` (+ `pg`) — a strong reason: a standard queue and nothing to
install apart; ≈ 150 MB more on install; a server process to start, stop and upgrade (Postgres major versions need a
data migration — the queue is transient, so recreate it after draining). Tests need a throwaway Postgres (one per suite
from the embedded package, in TMPDIR). ADR-1 and DESIGN's queue sections rewritten; jobs queued in the old format
drained before the switch (a local tool: no migration of queued jobs).

### BL-116 — Captures first: heavy jobs wait for the takes
*M · decided 2026-10-28 · builds on: L3.1 (job queue), L4.4 (pause) · replaces BL-89's direction · **done in L5.14 (file
queue)***

Done in L5.14 on the file queue (DESIGN §4q): job classes, two slots per worker (heavy jobs in a job process), a filming
marker per user on this Mac, heavy work waiting while a take films and a running one slowed by background priority
(the spike chose it over SIGSTOP: BL-151), the CLI's wait and `--no-wait`, the surfaces and the measured acceptance.
The text below is the decision as it was taken.

The load under a take is what must be controlled: a loaded machine shows in the take (fewer frames during motion,
freezes the edit has to cut, more kicked frames). Renders, exports, reviews and previews are background work whose
duration does not matter. Rule: **a capture runs first; heavy work only runs while no capture runs.**

Measured on the M4 (fixture `quote`, one take each, 2026-10-28): alone — 40 cpu-s, motion 59 fps at worst, 5 dropped
frames, no stall; during a default render (concurrency 7) — 48 cpu-s (contention), motion 45 fps at worst, 6 dropped,
12 kicked, no stall; during an angle + VideoToolbox render at concurrency 3 under `nice 10` — motion 56 fps, 5 dropped,
no stall. The M4 copes on the fixture; a heavier product, a longer take or a smaller machine has less margin.

Today: the Studio and MCP submit jobs to one worker per workspace that runs one job at a time, oldest first, so a
render queued before a capture delays the capture, and a capture never overlaps a queued render — but CLI commands
(`retake run`, `retake render`, `export`) run outside the queue and can overlap anything, as can a second workspace's
worker.

- **Job classes** (over `JOB_KINDS`): `capture` — `run`, `record`, `auth_login`, `inspect`, and what prepares a take
  (`hooks`, `env_reset`, `sandbox_up`, `sandbox_reset`) so a take's setup is not stuck behind a render; `heavy` —
  `render`, `export`, `review`, `preview`, `site`. The worker claims a queued capture before any heavy job
  whatever their age; a heavy job starts only when no capture runs or waits.
- **A capture asked while a heavy job runs**: pause the heavy job's process group (SIGSTOP; SIGCONT when the take
  ends — zero CPU meanwhile, no work lost, Remotion's own timeouts to check against a long pause) rather than make the
  take wait or cancel the render. Windows has no SIGSTOP: wait there.
- **A machine-wide marker** (`~/.retake`, pid + start time, stale when the process is gone) set by every capture —
  queued or CLI, any workspace — and honoured by every heavy job, CLI renders included (they pause, or wait to start
  with a message).
- **Light work during a take** (listing, planning, the live preview's own cost — L4.4 measured +15.6 % Chromium CPU for
  a watched take) stays allowed; the run's perf report already records the load (`perf.machine`), so a take can warn
  when the machine was busy.
- **Where it is built**: on pg-boss over an embedded Postgres (BL-117, decided later the same day): its `singleton`
  queue policy and priorities give the gate and the classes, one Postgres per machine gives the machine-wide view.
  Done on the file queue instead, the same rules are a change to `claimNext` plus a machine-wide marker.

### BL-115 — Capture without JPEG frames (tab capture, hardware H.264)
*M–L spike · measured 2026-10-28*

The CDP screencast only sends JPEG or PNG: every frame is encoded as JPEG by Chromium's browser process, sent base64
to Node, then decoded by ffmpeg and encoded again as H.264. On a take of the fixture (`quote`, ≈ 40 cpu-s for 47 s,
three takes within 5 %) the browser process takes 18.5 cpu-s, ffmpeg 7.5, Node 6.5 (its main thread is idle > 90 % of
the take), the GPU process 4.2 and the page's renderer 2.6. JPEG quality 75 instead of 90 saves only 5 %.

A throwaway bench filmed the same moving page for 20 s at 30 fps through `getDisplayMedia({preferCurrentTab: true})`
(`--auto-accept-this-tab-capture`, started by a CDP click) → `MediaStreamTrackProcessor` → WebCodecs `VideoEncoder`
(H.264, `prefer-hardware`; `prefer-software` stalls at 1080p): ≈ 8.7 cpu-s for the whole tree against ≈ 15 for the
screencast + ffmpeg path at a comparable frame rate, and no ffmpeg at all. `MediaRecorder` cannot replace WebCodecs:
Playwright's Chromium has no H.264 for it (mp4, webm and matroska all refused).

Open before it can replace the screencast:
- **Geometry**: tab capture films the window's real surface and ignores the viewport Playwright emulates — the frames
  came out stretched and blurred (a 1920×941 surface scaled to 1080). The headless window's real size moves with the
  window chrome it emulates; scale 2 / 4K captures need the same check.
- **Quality**: a realtime constant-bitrate encoder on small text — compare with today's capture (SSIM against PNG
  screenshots once the geometry matches).
- **Timing**: per-frame timestamps onto the capture clock (pause, kicked frames after a press, stalls), the activity
  thumbnails ffmpeg gives today (`activity.ts`), the raw export's 60 fps frames (`keep_frames`).
- **Where it runs**: in the filmed page it shares the product's renderer and needs a user gesture; an extension
  (`chrome.tabCapture` in an offscreen document) would keep it out of the page. Two-page scenes need one per page.

A small gain stays on the current path: the capture encoder's `scale=…:flags=lanczos` at the same size (full-range
BT.601 → limited BT.709) is ≈ 40 % of its CPU (2.2 of 5.05 cpu-s per 900 frames) — a cheaper conversion (or tagging
BT.601 instead of converting) saves ≈ 3 cpu-s a take, checked against players and the colour tests.

### BL-120 — The Geist pair bundled
*S · cut in L4.9 · builds on: L4.9 · **done in L5.9***

*Done in L5.9 (R-UI-02):* the official variable woff2 pair and its OFL 1.1 licence in `packages/ui/fonts`, served from
memory by the Studio at `/fonts/<file>`, declared by the generated tokens.css; the checker waits for the fonts before it
measures (DESIGN §4i, §4k). What follows is the item as it was cut.

The Studio names `'Geist'` and `'Geist Mono'` first in its font stacks by local family name only (app.css `--font`,
`--mono`; DESIGN §4i): a Mac with the fonts installed shows them in Chrome and Firefox, everything else falls back to
the system fonts, and Safari never exposes installed fonts to a page. Bundling the official OFL-1.1 release files
(variable woff2, ≈ 2 × 70 KB, with OFL.txt beside them) under the ui package, served from memory by the Studio like
`/app.css` (the CSP already allows `font-src 'self'`), `@font-face` with `font-display: swap`, needs one download the
person approves. Then R-UI-02 → done, and the tour's text widths no longer depend on the machine's fonts.

### BL-121 — Safari and Firefox in the automated suite
*S–M · cut in L4.9 · builds on: L4.9*

The L4.9 checker and tours run in Playwright's Chromium (and the installed Chrome for the acceptance); WebKit was run
once by hand from a cached build that belongs to another tool (webkit-2370 through `executablePath`: 14 screens, 0
contrast or overflow finding after the fixes), Firefox and Safari are by hand (MACOS-CHECKLIST 13j). Automating them
needs a WebKit build matching the pinned Playwright (a download) or a tour pinned to a known build; Firefox through
Playwright's BiDi channel once Playwright and the installed Firefox agree (today `network.addDataCollector` is unknown
to Firefox 137); Safari through `safaridriver`, which needs an admin setting. The checker's name rule would use an aria
snapshot there (no CDP), and its Tab walk needs Safari's "Press Tab to highlight each item".
L5.2: WKWebView has no WebDriver on macOS (tauri-driver is Linux / Windows only): the desktop shell's automated checks
stay black box — the server's `/v1/info` counters, process tables, lsof and window screenshots (desktop-shell.test.ts).

### BL-122 — Accessibility beyond the L4.9 pass
*M · cut in L4.9 · builds on: L4.9*

- Reflow below 1280 px wide and at 200 % zoom (the Studio is desktop-class; two narrow media queries only).
- Target sizes ≥ 24 px everywhere; forced colours and macOS Increase Contrast; ~~a dark appearance for the Studio~~ —
  L5.9: dark by default and following the system, every legacy screen mapped and toured in dark (DESIGN §4k).
- `prefers-reduced-motion` once anything animates (nothing does today; library loops play on Play only).
- A live region announcing the selected step (BL-79 residue); automated screen-reader runs (VoiceOver scripting).
- The checker's limits (found by the L4.9 review, each probed): contrast over a picture is measured over black and white
  only (a mid-grey picture under a thin veil can be worse); `filter` and `mix-blend-mode`, `-webkit-text-fill-color`, text
  of a `display: contents` element, and a dark sibling layer painted under the text (an absolutely placed box that is not
  an ancestor) are not measured — `elementsFromPoint` per text would find the last; text clipped by an `overflow: hidden`
  panel passes the overflow rule (page and `main` only); label-in-name (`aria-label="Delete"` on a button that reads
  "Save") is not checked; text that shows only on hover is not reached; a ring clipped by an `overflow: hidden` ancestor
  still counts as a ring; a status glyph other than a dot (▲ in two colours) passes the colour-only rule by its shape; an
  axe-class rule set if the in-repo rules stop sufficing.
- The UI component boundaries (inputs' borders `--line-strong` on white ≈ 1.5:1) meet WCAG 1.4.11 through their labels
  and focus ring, not their border; a stronger field border if wanted.
- ⌘Z is dropped without a word while an edit is still in flight: StepEditing's `undo` (and the timeline inspector's
  pick) return early while `busyRef` is set — from the write until the reloaded view lands — so a quick ⌘Z after a move
  does nothing and says nothing (the L4.9 review reproduced it under load; the tests now wait for Undo to be enabled).
  Queue the undo until the write lands, or say "Saving… undo in a moment" in the live region.

### BL-123 — A render job's inline review that once never finished
*S · found in L4.9 · builds on: L4.5*

The first green-path run of the R-ACC4-01 acceptance (a fresh worktree, the shared render cache just created empty)
sat 600 s with the render's review `running`: the render record existed, its job had not finished (renders.ts reads
that as `running`). Not reproduced: a run with the cache moved away bundled in ≈ 3 s and rendered and reviewed in
42.9 s (2026-10-29), warm runs take ≈ 36 s; the job's phase was not recorded then. The acceptance now fails fast with
the job's phase (no live worker while it runs, or the same phase for 5 min). If it comes back: the phase it stopped at
(`review:frames` → ffmpeg, `review:sheets` …), the worker's log, and whether a cancel reaches it.

### BL-124 — Studio redesign « Épure » and the Retake name
*L–XL · design validated 2026-10-29 · lots L5.9 – L5.13, right after L5.2 · builds on: L4.9 · amends R-UI-02 ·
overlaps BL-120, BL-122 and L5.2*

The founder validated a new Studio design through four rounds on a design canvas (private:
`https://claude.ai/artifact/FhBXE6GvhbPsbpg592GfnR`; one page per round, decisions noted on it). Two reference
screens, Project and Scenario, then thirteen more: Welcome (no project open), Scenario source (YAML), Shoot — prepare a
take, a live rehearsal, record a scenario —, Edit (timeline and live preview), Review — frame comments with Claude's
proposal, the review report and exports —, Library, Theme editor, a confirmation sheet, the ⌘K palette and the light
appearance.

- **Layout.** A pro three-pane app (references: Final Cut Pro, Logic Pro). The title bar carries the
  pipeline as a centred segmented control, Script · Shoot · Edit · Review: one way to navigate, replacing the
  breadcrumb, the tabs and the inline links. Left, a browser: Productions with smart groups (Ready to render, Needs a
  shoot, Failed), Library, Locations, Cast — or, inside a scenario, its scenes with their lengths. Centre, the content
  (a poster grid of productions, a storyboard of real frames per scene). Right, the inspector. A status bar holds the
  actions — Rehearse, Capture, Render — on every screen.
- **Drawing.** Panes separated by surface tone only (centre ≈ #111214, panes ≈ #18191c), hairlines inside lists only;
  three type sizes (13 / 15 / 20 px) and two weights, sentence case; mono only for timecodes and ids, tabular numbers;
  one blue accent for selection and the primary action, red only for Capture and recording; a state is a shape and a
  word; storyboard frames ≈ 248 × 140, three per row; inspector labels in one right-aligned column, switches for
  modifiers. The light appearance follows the system with the same layout and a mapped palette.
- **Behaviour.** State in short words, the explanation on demand: a capture blocked by a hook to approve says so in one
  line with Copy command. Paths, run ids and the worker's state live in the inspector and the status bar, not in
  titles. Real frames wherever a step appears. The same UI on the web and in the desktop app; in the app the menu bar
  carries the commands and sheets replace modal pages; ⌘K everywhere.
- **R-UI-02 amended.** Dark by default and following the system (it said light), the Geist pair kept (BL-120), one blue
  accent kept plus a red reserved for recording. R-UI-03 unchanged; the dark appearance item of BL-122 becomes part of
  this.
- **Name and mark.** "Retake": the take you redo — the video re-shoots itself at each release. The mark "two takes"
  (declension "Nette"): the previous take as a blue outline behind, the new one in front with a play triangle, on an
  ink plate; the command becomes `retake`, everything renamed at once with no alias (2026-10-29). No trademark or domain check (local distribution). Also considered: Cue (its
  command collides with an existing open-source configuration language's CLI), Dolly, Stand-in. The rename touches the
  CLI binary, package and MCP server names, the skills and the docs — a lot of its own, right after the redesign lots, both after L5.2.
- **A possible split.** (1) A reference note `docs/reference/studio-ui.md`: tokens, type scale, pane anatomy and the
  screens, exported from the canvas. (2) A design system for the Studio — one token file for dark and light, reusable
  accessible components, a gallery, screens built from the kit only — with the shell. (3) Project and Scenario. (4) Shoot (prepare,
  live, record). (5) Edit and Review. (6) Library and Theme editor. (7) The rename. The menu bar and the sheets land
  with the desktop shell (L5.2).

### BL-125 — Desktop shell extras cut from L5.2
*M · cut in L5.2 · builds on: L5.2, BL-106, BL-36*

What the L5.2 shell (apps/desktop, DESIGN §4j) does not do — L5.2b added job notifications (UNUserNotificationCenter)
and the quit / Open Workspace… / restart question for running jobs and unsaved text (the supervised pipe's `pending`
and `job_end` lines); what remains:
- **A notification's click opening the job's screen** (the run banner, the render, the Record screen): it shows the
  window only — opening the screen needs a second `.eval` and a route built from the line.
- **Guard and notifications for an attached server** (L5.2b D8): no pipe reaches a server another process started;
  the `--supervised` child could stay alive as a relay (it already holds the server's token, read from the Retake home's
  record, in its reuse path), poll a
  token-gated `GET /v1/pending` and run the job watch on the shared queue, writing the same lines.
- **More unsaved text**: the Record screen's typed words (a recording's name: not marked; L5.2b review B L7 marked
  the Library's component words, the new-theme form and the theme editor's colour draft), the browser's `beforeunload` prompt for the
  marks (component-local text: a step form, a comment — the drafts' only today; Playwright dismisses such a prompt and
  e2e tests that navigate with a typed comment would hang), and a Reload item now guardable through the same question.
- A Dock badge / progress, recent workspaces and one window per workspace, a menu-bar item, launch at login,
  `retake://` deep links (`tauri-plugin-deep-link` is in the cargo cache), App Nap measurements and an
  NSProcessInfo activity while jobs run.
- **Native pickers for the Studio's own path fields** (brand files, a scenario file): a narrow page→shell command, with
  BL-106's presence primitive.
- **Watching an attached server** (critique M2): when another process already serves the workspace, the app attaches
  and nothing watches that server; if it stops, the window shows "run retake ui again" — File › Open Workspace… (the
  same folder) starts a server the app owns; a navigation (a reload) after it stopped is refused and offers Restart
  (L5.2 review A L3). A watcher (pid + port) that restarts it at once, and the page's wording inside the app.
- A per-workspace environment file for Finder launches (`{{env:}}` references resolve from launchd's environment,
  which holds none of the shell's variables). The same holds for the shared jobs worker a Finder-launched app's server
  starts: it keeps that minimal environment until it idles out (60 s), so MCP jobs submitted meanwhile run with it
  (L5.2 review B L5; documented in README and MACOS-CHECKLIST 14a). The file, or the server passing the worker a
  marker so a terminal client restarts it, would close it.
- **⌘Tab to a hidden window** (L5.2 review B M3): Window › Show Studio Window (⌘0) and the Dock icon bring it back;
  showing it when the app becomes active needs an `NSApplicationDidBecomeActiveNotification` observer — cheap since
  L5.2b (`block2` is a dependency now).
- **A hidden window keeps the page live** (review B L11): its event stream stays open, so the server's 1 s workspace
  poll and the stream's keepalive run while the app sits closed in the Dock — measure with the App Nap item above;
  pausing the stream while hidden would need a shell→page signal. Also tiny: Ctrl-C under `desktop:dev` signals the
  whole process group, and if the watcher sees the child's exit before the app's own quit, a "server stopped" alert
  can flash during the quit.
- **One shared job watch** (L5.2b review B L15): the supervised server's `Supervisor` and the event stream's `Live`
  each poll the queue (a running job's read checks its worker with `ps`) while a page is open; one watch feeding both
  would halve it (the Supervisor already reads each live job once per poll).
- **The quit question's reason by hand** (L5.2b review B M2): logout / restart / shut down are read from the quit
  Apple event's `kAEQuitReason`; a gated test would need to send such an event (Automation permission) — checked by
  hand (MACOS-CHECKLIST 14a). Also the picker ended by SIGTERM (review B M1): test mode never shows a real
  NSOpenPanel (it would write the test bundle's preferences).
- **Every job end notified** (L5.2b review B L12): past 20 `job_end` lines a minute the server counts the rest on its
  stderr only (a summary can undercount a flood), and a 17th tab's unsaved report is refused (`busy`, retried every
  5 s). A count line (`{"type":"job_end_dropped","n"}`) and a board without a tab cap but with a byte cap would close
  both.
- Windows and Linux shells (BL-37).

### BL-126 — Desktop shell extras cut from L5.9
*M · cut in L5.9 · builds on: L5.9, L5.2 · see BL-125*

- **The integrated (overlay) title bar.** `TITLE_BAR = Overlay { buttons: (16, 18) }` with the page's 48 px bar under
  it: the page's side is built and tested (`__studioShell`, `html[data-titlebar]`, an 80 px inset, no selectable text
  in the bar; studio-e2e-kit), the window drag is not. A probe, half a day, by hand: does WKWebView (macOS 26) honour
  `app-region: drag` / `-webkit-app-region: drag` (stated "no" in L5.2, never measured)? If not, a native drag band —
  an NSEvent local monitor on the main window (`block2` is a dependency) passing a press in the top 48 pt to the page
  and calling `performWindowDragWithEvent:` once the pointer moved ≥ 3 pt. Pass criteria (DESIGN §4j, critique H2): a
  drag from the bar's empty area or a mode button moves the window and never navigates; no stuck `:active`, no text
  selection or step drag on the next hover (WebKit must get its mouse-up: AppKit's tracking loop takes it; a synthetic
  one only outside the webview's bounds); the next click works; a `<select>` in the bar opens; a double-click on the
  empty bar zooms as macOS does, never on a control; menu, sheets and full screen (the inset following it) unaffected.
  Any criterion failing keeps the standard bar. L5.9 did not run it: every criterion needs a real window drag, which an
  unattended run cannot post (Accessibility permission).
- **Menu state from the page**: Capture / Render greyed when the page cannot run them (server→shell `state` lines on
  the supervised pipe, or a narrow page→shell request); L5.9 keeps every item enabled and answers in the page.
- **The Scenario menu** — Rehearse ⌘R, Capture ⇧⌘R, Render ⌘B, Stop ⌘. — and the status bar's actions: L5.11, when
  they act (critique M6), through the same `Item::Page` table and `MENU_COMMANDS`.
- The inset following full screen (the buttons hidden: the 80 px could go), and native confirmation sheets through the
  pipe (BL-106 amended, unchanged). L5.12d: the quit question is a page Sheet answered through the server's pipe
  (DESIGN §4j), the native alert its fallback; Open Workspace… through the page is BL-135.

### BL-127 — Design-system extras cut from L5.9
*S–M · cut in L5.9 · builds on: L5.9*

- A `Tooltip` (hover and focus; the checker cannot reach hover-only text: BL-122) and a `Toast`.
- A `Tabs` component (the scenario's Blocks / YAML become a View segmented control in L5.10 instead); a `Disclosure`
  tree for the browser's smart groups and a scenario's scenes (L5.10a built a plain `Disclosure`; the groups are always
  shown).
- An appearance switch inside the app (the system's only today), density options, Increase Contrast and forced-colour
  token sets (BL-122).
- Visual regression snapshots of the gallery (no committed images today; the tours and the checker are the guard).
- WebKit conventions met in L5.9's scratch WebKit run (DESIGN §4k): radios that stop at the last enabled segment
  instead of wrapping, a dialog opened by a click giving the focus back to nothing (WebKit does not focus a clicked
  button: the opener could be remembered by the click's target), and the CSP `style-src-attr` report WebKit makes for
  every `<select>` it draws (nothing the app writes; a console line in Safari and the app).
- The kit e2e and the tours in WebKit and Firefox (BL-121).
- The light appearance toured at 1440 too (L5.9's review B-L9: light is toured at 1280 only — L4.9 proved its values at
  both widths on the old frame, and a layout overflow does not depend on the appearance; one more audit per station,
  ≈ 40, was not worth it then).
- An IME composition test in a real input method (the palette's `isComposing` guard is tested with a synthetic event).

### BL-128 — « Épure » 2 extras cut from L5.10a (the project side)
*S–M · cut in L5.10a · builds on: L5.10a*

- Welcome: a poster per project (R4-Welcome draws one; posters span projects: a thumbnail fetch keyed by project and
  run), the "This Mac is ready" panel (an engine `doctor` op), New project and Open a folder from the page (no write
  path; a page → desktop bridge: BL-125's narrow command).
- The Project screen: the canvas's Location select (a meaning to define on a project), component and theme counts in
  the browser, Show in Finder, a poster made from the render's frames, "Render outdated" from the plan signature
  instead of the file's bytes and theme name (render-words `sameVersion` today: a theme folder's edit or a project
  setting is not seen), Render acting from the inspector (done in L5.11a: the status bar's Render), Locations as a page of their own (an inspector today), a production's Lately from an
  `activity_list {scenario}` filter (filtered on the page from the project's newest 20 today).
- The README editor (legacy until L5.12). The Cast was rebuilt on the kit in L5.11a.
- `timelineRun` (the scenario screen's Render / Open timeline) takes a capture whose frames were kept as "no video":
  the board counts it (video or kept frames) — one rule for both.
- Left after the L5.10a fixes: a type-ahead in the poster listbox; the `workspace` event says a run started or ended
  but not which project file changed beyond project.yaml / sandbox.yaml / the scenario list (hooks/ is not watched: a
  hook edit reaches the board at its next read — a focus, another event); Welcome's "Recent projects" are listed by name, not by
  recency; the Recent activity (`Lately`) still re-reads on every job event (a render's progress).

### BL-129 — « Épure » 2 extras cut from L5.10b (the scenario side)
*S–M · cut in L5.10b · builds on: L5.10b*

- The step inspector: the canvas's action Type select (changing a step's action stays the YAML's: a form per action
  today) and its "Rest ms" field; a Zoom (camera) modifier switch (the forms' modifiers are core `MODIFIER_KEYS`:
  caption, hold, speed, mark); verified alternative targets from the page under "Other ways to find it" (a live probe,
  the recorder's kind — today the target's other fields of the form).
- The YAML source: syntax colours (tokens with contrast in both appearances), Ln / Col in the status bar, R4's Outline
  (the scenes browser plays its part), Show in Finder.
- The Location: remembered across reloads (L5.11a made Shoot and the status bar use the tab's choice), a Location on
  the Project screen (a meaning to define).
- The storyboard: a type-ahead in a scene's frames, several steps dragged at once, scenes reordered from the browser,
  a frame's picture from the render rather than the capture, per-scene colours (B·3c, not chosen); windowed scenes if
  a file past the view's 2,000-step cap ever needs them (content-visibility holds the 1,200-step budget today).
- The take strip stays above the board (L5.11a moved Rehearse / Capture to the status bar's actions); the renders stay the legacy card in a closed section until L5.12 (planned there, not a backlog item). Until then the
  strip pushes the first frames down at 1440 × 900 when two picture notices show (review B L5: watched, not changed).
- The scenes browser's layout (review B L4): B32 puts the total length beside "Scenes" and a Video block (title,
  outro) at the bottom; the browser keeps "Video" as its first row with the total.
- The selection follows a step by its key ("<scene>.<index>", the language's): a step deleted from outside before the
  selected one shifts the keys, so the selection lands on the step now at that place (the inspector and the board show
  the same one); a gone key leaves its scene selected (L5.10b fixes, review B M2). Following a step by its content
  across outside edits is a later topic.

### BL-130 — « Épure » 3 extras cut from L5.11a (Shoot)
*S–M · cut in L5.11a · builds on: L5.11a*

- "Pages that answer" on Prepare (R4-Confirm's "both pages answer"): a page probe from the Studio — cut (critique M1): a
  run a safety gate refuses at submit never reaches its pages, so Prepare must not either; if ever, only on a click,
  skipped when the location is protected or refused, keyed on the pages' hash, `openWorldHint: true`.
- A live session check from the Studio (a job for `auth status --check`) and the check command as a line to copy.
- Prepare's estimates ("about 50 s"), the status bar's "+n" count of the hidden blockers, the Last take's hooks /
  rollbacks facts and "Watch replay" (a replay of a run's frames), a manual "Check replay".
- The Recordings group in Shoot's browser on Prepare and the live route (L5.11b shows it on the Record routes).
- The sheet's "Sign in … first…" opening the sign-in window itself (it opens Prepare at that persona's Sign in today).
- The status bar's progress on the Project screen reads `run_status` beside the Project screen's own poster progress
  (two readers of one run; both throttled): one shared progress entry.
- A run stopped from elsewhere (CLI, MCP) while it is still queued and no worker runs changes no file: the Scenario
  screen sees it at its next read (a focus, an event) — a Stop from this tab reads it at once.
- The engine's, the CLI's and MCP's own wording of "dry run" (the Studio says Rehearse; its mapping line names both).

### BL-131 — « Épure » 3 extras cut from L5.11b (Record)
*S · cut in L5.11b · builds on: L5.11b*

- The selected step's "Recorded 00:41 into the recording" (R4-Record): the view carries no event times per row.
- The inspector's second set of insert buttons under "Add after this step" (R4-Record draws both): one Insert toolbar
  at the draft's cursor, the inspector's button focuses it.
- The title bar's Location on the Record routes (R4-Record): the start form's Location select instead.
- A Stop button in the status bar during a recording (the canvas has none; the one visible Stop is the inspector's,
  ⌘. from anywhere in the app).
- "Show the window" and a manual "Check replay" stay BL-130's.

### BL-132 — « Épure » 4 extras cut from L5.12a (Edit, the Review report)
*S–M · cut in L5.12a · builds on: L5.12a*

- The checks that ran (a review.json field) and R4's "n passed" — the report says what was found, never "passed".
- Exports from the Studio beyond the MP4: other formats, an engine `export-capture` job kind (the raw package stays a
  command to copy), a file route or Show in Finder (BL-125's page → desktop bridge), a download.
- "Open the step" from a check (a `step` on the scenario route) and the per-scene contact-sheet rows with their times
  (R4-Review; the review's own scene sheets are shown as they are).
- Edit's own ruler component (time labels sit on the scrubber), R4-Edit's selects for transition / speed / theme (the
  inspector keeps chips), the take as captured / proposed edit as a caption under the preview (the status bar says it).
- A render queued from Edit opens its report by itself (Edit's status bar says "vN reviewed" with Open the review: the
  page stays where you work); the report opens one queued from the report.
- (Thread rows' thumbnails and the palette's "Open renders": moved to BL-133, L5.12b's.)

### BL-133 — « Épure » 4 extras cut from L5.12b (frame comments, the proposal, README, ⌘K)
*S–M · cut in L5.12b · builds on: L5.12b*

- Thread rows' 64 px thumbnails (R4-Comments): one `thread_still` per visible row is a read storm — a batched still read
  (one op, the visible rows' stills, capped) first; rows keep their timecode and first line.
- The palette's "Open renders" as a place of its own (it is Review › Report) and R4-Palette's "Render <scenario> with
  the theme X" wording (the project read carries no per-scenario theme; Edit's theme is in the Themes group).
- The browser pane's Workspace footer: a long path wraps to three lines (every screen, the shell's foot) — shorten it in
  the middle (`~` for the home folder), the full path on hover.
- `useCall` reads again on every window focus: a tab coming back to the front (or the first key press in an unfocused
  tab) sends every read of the screen at once (~10 on Comments) — a focus refresh throttled or limited to what is stale.
- "Press C on any frame" on the Comments screen (the key belongs to Edit; Comments has "Comment at this frame" in ⌘K).
- A Markdown preview of the README stays out (deliberate: a renderer is the largest script-injection surface).

### BL-134 — « Épure » 4 extras cut from L5.12c (the Library, the theme editor)
*S–M · cut in L5.12c · builds on: L5.12c*

- R4-Theme's "Content from <scenario>" select: theme_preview has no scenario target (intro, clip, outro or a
  component) — a preview of a scenario's own clip with the theme first.
- R4-Theme's three-tile preview grid (Intro, Outro, Clip): one Player exists; the other two tiles have no picture
  source — a still per target (a frame from theme_preview) first. The editor keeps one preview and a target Segmented.
- R4-Theme's Undo / Redo in the title bar (they are in the status bar) and the browser's per-section notes ("5 colours",
  "2 pass").
- R4-Library's card without visible buttons (Play sits under each poster, inside the card's frame: the selected card's
  Play / Retry are its tab stops after the card; L5.12c fixes made the grid one tab stop).
- The Themes list's site panel keeps a plain layout (kit fields, no R4 drawing of its own).

### BL-135 — « Épure » 4 extras cut from L5.12d (the quit sheet, the end of the legacy layer)
*S–M · cut in L5.12d · builds on: L5.12d, L5.2b · see BL-106, BL-126*

- **File › Open Workspace…'s question through the page** (critique M4): today the native alert. Through the page it
  turns the synchronous `confirm_open_other` called from a menu callback into an async flow (dispatch, wait for an
  answer that comes on the pipe, then run the open flow on the main thread — and the picker after it), with the same
  rules as the quit question (an id taken once, a fallback after 1.5 s, every exit closing the sheet).
- The quit sheet's words for logout / restart / shut down stay native by design (loginwindow never waits on a web
  page); a page Sheet for the restart alert needs a server, which is what is gone.
- A Show in Finder / export download from the sheet's text (it names unsaved text of other tabs): BL-125's page →
  desktop bridge.
- A quit sheet on the Connecting and session-ended screens (L5.12d fixes, review B-L5): they have no session, so no
  answer path; a page → shell "no sheet here" word would need one (BL-125's bridge) — until then ⌘Q there waits the
  1.5 s for the native alert, by design.
- The className lint reads a template's literal parts only: a variable part (`k-btn-${variant}`) passes on its prefix,
  and a class built in another file is not followed (review B-L2); a runtime check of the classes in the DOM (the
  review's probe) would close it.
<!-- old-name:begin — BL-136 names the old names it would drop -->
### BL-136 — Rename extras cut from L5.13a and L5.13b (and the old names to drop later)
*S–M · cut in L5.13a / L5.13b · builds on: L5.13a, L5.13b · see BL-124*

- *Done in v0.2.1 (decision, user, 2026-11-10: nothing of the old name is kept):* the old outgoing variables, the
  rename script, every old name the code detected or recognised (home, workspace file, tool folders, variables,
  safety lists, theme and raw-package markers, the snapshot key, the old perf field) and the idea of a migration
  command are gone — an installation from before L5.13 is simply not seen.
- The `ds` abbreviations (`__ds_snapshot` is a database name in the person's sandboxes, `ds-asset`…).
- The built-in `studio/` component namespace → `retake/`, with a migration of every theme and scenario that names it
  (if ever wanted); the `studio` comment channel and the `studio:*` page events likewise.
- One `TOOL_DIR` constant for the ~45 `.retake` path literals.
- **The mark's extras, cut from L5.13b:** the macOS 26 icon appearance variants (Icon Composer: dark, tinted and clear
  icons — an `.icon` file next to the icns; today one appearance, the ink plate, in every mode); a favicon that follows
  the page's appearance in Safari (today the tiny mark on its fixed ink plate, a `data:` SVG — Safari may ignore SVG
  favicons); a menu-bar / template-image form of the mark (none needed while the app has no status item).
<!-- old-name:end -->

### BL-137 — Relocatable-engine extras cut from L5.16a (the stage, the resolver)
*S–M · cut in L5.16a · builds on: L5.16a · see BL-41*

- **A thinner engine**: @remotion/bundler still pulls @remotion/studio, studio-server, codemods, the ElevenLabs /
  Whisper packages (≈ 60 MB of the 314 MB engine) and the deploy keeps every `README` / `test/` folder of third-party
  packages; a prune list per package (checked by a render from the stage) would cut them.
- **The lockfile tool**: `pnpm install --offline --lockfile-only` dropped the platform-specific optional packages it
  has no metadata for (Remotion's compositors) when an importer's dependencies were re-resolved (L5.16a removing
  `@remotion/cli`); on unchanged manifests it reproduces the lockfile byte for byte. A dependency removal offline was a
  pure deletion, done by hand; a small script (prune one importer dependency and what only it reached) in `scripts/`
  if it happens again.
- `retake init` options: a name for the first project, a theme copied from a starter, a git repository started.
- Doctor's own probes under Node's permission model (docker places, `.git` above the workspace, `which` of security /
  osascript): a doctor that degrades to "not checked" instead of throwing when a read is refused.
- An SSIM-calibrated VideoToolbox quality per site (one q:v 85 everywhere today: same SSIM as libx264 CRF 18 on the
  fixture's 1080p render, ≈ 3× the size) — only matters for a foreign ffmpeg without libx264.
- A Chromium licence file of its own in the stage (today a notice pointing at chrome://credits).
- The write guard covers the workspace, its folders, a project folder (even a link into the app), `retake init`,
  component previews, `RETAKE_HOME` and the CLI's `--out` paths; a write a third-party library makes on its own
  (playwright-core's 30-day `DEPENDENCIES_VALIDATED` refresh, empty) is not guarded.

### BL-138 — Remotion's compositor ffmpeg before a sale (GPL source offer, fdk-aac)
*S · found in L5.16a's review · builds on: L5.16a, BL-41 · before the first sale*

- **Accepted 2026-11-04 for own-use releases; resolve before any sale** (the person's decision with L5.16e: the
  public GitHub releases ship the compositor as it is; the licence note of `docs/guide/desktop-app.md` and the
  README's Licence section say so). A public release is still
  distribution: anyone can download the DMG, so the GPL source offer for the compositor's FFmpeg applies to those
  copies as it would to a sold one — the risk accepted is that offer being incomplete and fdk-aac being in the build
  until this item is done.

- `@remotion/compositor-darwin-arm64` ships its own FFmpeg n7.1 build, GPL v2+ (`--enable-gpl`, libx264, libx265),
  in the app (`apps/desktop/licenses/remotion-compositor/README.md`). A sold app needs a written source offer for it
  as for our own ffmpeg: confirm where Remotion publishes the exact source and build script of each compositor
  release, mirror them next to the disk image, and extend the offer.
- That build also compiles in fdk-aac with `--enable-gpl` (FFmpeg's configure calls the pair non-redistributable
  without `--enable-nonfree`), and Remotion encodes AAC with it. Ask Remotion (the same email as the licence question)
  or render the audio track elsewhere (our ffmpeg's AAC) before the first sale.

- **The repository's own licence: MIT (the person's decision, 2026-11-04, with the public README).** `LICENSE` at the
  root (copyright "The Retake authors": the repository names no person), `license` in the root package.json and both
  Cargo manifests. It covers Retake's own code only:
  - **Remotion is not open source.** Its own licence (`node_modules/remotion/LICENSE.md`, v4: free for individuals
    and companies of up to 3 people, a Company licence from 4) binds everyone who renders with Retake, from the app or
    from source; a permissive licence on Retake does not relicense it. The README says so, and a sold or hosted Retake
    needs the parked Remotion decision (Open decisions) first.
  - **Retake patches Remotion's renderer** (`patches/@remotion__renderer@<version>.patch`: the render browser's
    sandbox and site isolation on macOS, its bundle server on loopback only). The free licence allows modifying
    Remotion for one's own use case, not copying or modifying it to sell or license a derivative. Before a sale: check
    the patched copy the app ships against the Company licence's terms with Remotion, or offer the changes upstream
    (as options of `openBrowser` and of the bundle server) so the app ships Remotion unmodified.
  - **The DMG carries GPL programs**: our ffmpeg / ffprobe (GPL v2+ with x264, `scripts/build-ffmpeg.mjs`) and
    Remotion's compositor with its own GPL FFmpeg. They ship as separate programs beside Retake's code (an aggregate),
    which a permissive or a copyleft licence for Retake both allow, as long as each keeps its notice and written
    source offer (`apps/desktop/licenses/`) and Retake never links them into its own code. The fdk-aac point above
    stays open whatever licence is chosen.
  - Bundled fonts keep their own licences: Geist (`packages/ui/fonts/LICENSE.txt`) and the starter templates' fonts
    (each template's `LICENSES.md`).
  - **To do:** the app carries Retake's own code, so the MIT notice belongs in it too: the stage's `licenses/`
    (`apps/desktop/scripts/bundle.mjs`) should copy the root `LICENSE` beside the third-party notices, checked by the
    bundle tests.

### BL-139 — The app bundle on other platforms
*M · cut in L5.16a · builds on: L5.16a*

- `apps/desktop/scripts/bundle.mjs stage` is macOS on Apple silicon only (Remotion's compositor, our ffmpeg build,
  Playwright's browser folders and the Node.js copy are per platform). An Intel Mac (x64 or universal) or a Linux
  engine bundle would stage the matching compositor, ffmpeg and browsers.

### BL-140 — App bundle extras cut from L5.16b (the DMG's look, the build)
*S–M · cut in L5.16b · builds on: L5.16b*

- **A styled DMG window**: a background picture, the icon positions and the window size need Finder scripting
  (AppleScript on a mounted image) or a hand-written `.DS_Store`; today's DMG is `hdiutil create -srcfolder` (the app
  and an Applications link, Finder's default layout). Tauri's own DMG step (`bundle_dmg.sh`, `CI=true` to skip Finder)
  in a CI release is the other route.
- **The Tauri CLI as a dev dependency**: `pnpm add -D @tauri-apps/cli --offline` rewrote the lockfile without every
  optional platform package it had no offline metadata for (esbuild, rspack, emnapi…), so `bundle.mjs` rebuilds the CLI
  from the pnpm store, every file checked against the sha512 pinned in `apps/desktop/bundle/tauri-cli.json`. With a
  network once, a normal `pnpm add -D @tauri-apps/cli@2.12.4` (lockfile kept whole, its integrity then in the lockfile)
  would let `bundle.mjs` use `node_modules/.bin/tauri` instead.
- **Faster builds**: Tauri copies the ≈ 1 GB payload from the stage into the app (≈ 10 s) and the DMG compresses it
  again (≈ 40 s); building the app around the stage in place (clonefile copies) and a reused cargo target per checkout
  would cut a rebuild to well under a minute.
- **A stray package above the workspace** (`~/node_modules/react` beside a workspace in the home folder): from the app,
  the render bundle refuses modules outside the app, the workspace and its cache (DESIGN §4p), so such a package makes
  the bundle fail to resolve it rather than bundling a second React; a message naming the stray folder would help.


### BL-141 — Hooks and sandbox commands run on the app's Node.js first
*M · noted in L5.16 (critique M5) · builds on: L5.16c*

- From the installed app, the PATH a client starts its processes with (`clientPath`) puts the app's own Node.js first:
  a person's `npm` / `npx` / `#!/usr/bin/env node` scripts in hooks and sandbox commands then run on the bundled Node.js
  22 — the wrong ABI for their native modules. README says it (doctor's MCP line names the app's Node.js, which is the
  one hooks get first, without saying so); the fix is a PATH
  for hooks and sandbox services without the app's Node.js folder (the engine still runs its own children by absolute
  path), with the person's own Node.js found the way their shell would (never by running their login shell).

### BL-142 — Set-up extras cut from L5.16c (the installed app's integrations)
*S–M · cut in L5.16c · builds on: L5.16c*

- **Claude Code's settings folder**: a Finder-launched app does not have the `CLAUDE_CONFIG_DIR` of the person's shell
  profile; the Set-up sheet shows the folder Run uses (critique M5 suggested a field to change it — the page would then
  send a path, which the setup ops never take today).
- **A Claude Desktop extension file** the person opens (Claude's own consent screen installs it) instead of editing its
  config: not verified offline (critique M7).
- **Doctor checks the Claude Desktop entry is still there** (Claude Desktop may write its settings over it while it
  runs): the sheet refuses while it runs and reads the file back, doctor does not read Claude Desktop's config yet.
- **`/usr/local/bin` without ownership**: no admin escalation — the sheet offers folders the person owns; a privileged
  helper (or the `sudo ln -s …` line to copy) for a root-owned folder.
- **The Help menu's state**: Install / Uninstall the retake Command… are always enabled (the page's sheet says what
  applies); a menu that reflects the link's state needs the server to tell the shell.
- **Uninstall another copy's link from the sheet**: the op removes a link to another copy of Retake (a dangling one
  too), but the sheet offers Uninstall only for this app's link (review c B-L4); doctor gives the `rm` line meanwhile.
- **A remembered workspace on a disk that is not mounted**: the first-run alert greets it as a new start ("Welcome to
  Retake") — it could name the missing folder and wait for its disk (review c B-L5).


### BL-143 — Updater extras cut from L5.16d
*S–M · cut in L5.16d · builds on: L5.16d*

- **Delta updates and a staged rollout**: every update downloads the whole app (≈ 400 MB archive); the feed has no
  percentage or cohort.
- **An admin install** for an app in a folder this account may not write (a root-owned /Applications): today the sheet
  says to install from the disk image; the plugin's privileged path (an administrator prompt from AppleScript) is never
  reached from the background flow.
- **The Help menu's state**: Check for Updates… is always enabled; an "Update available" item or a menu badge needs the
  shell to keep a menu in sync with the update's state.
- **Other running copies told before the swap**: processes started from the old bundle (another workspace's worker, an
  MCP server Claude started) keep their loaded code; a count of them in the sheet (libproc, plan §7) was not built — an
  idle worker hands over by itself (critique M6).
- **A feed that expires**: a frozen `latest.json` stops updates silently; doctor warns after 30 days without a
  successful check (critique L7), the feed itself carries no expiry or signature of its own.
- **The download's progress** in the sheet (bytes received): it says "Downloading" until the archive is checked.
- **A download streamed to disk**: the plugin gathers the archive in memory until it has verified it (the byte cap
  bounds that: 1.5 GB), then the shell writes it to its cache folder and drops it; streaming it to the file would take
  a download of our own (or a newer plugin).

### BL-144 — A CI workflow for pull requests and main
*S · noted in L5.16e · builds on: L5.16e · partly done (2026-11-10): `.github/workflows/ci.yml` exists (build, guards,
the shell's rules; the test suite taken out until BL-163); left: the suite back in the CI, the release job waiting for
main's green run, `actionlint`*

- The repository has only the release workflow (`.github/workflows/release.yml`, on `v*` tags): nothing runs
  `pnpm build` and the test suite on a pull request or a push to main, so the release job checks that the tagged
  commit is on main but not that its tests passed (the person runs `pnpm test` before tagging). A `ci.yml` (macOS
  runner: the fast suite, `pnpm desktop:test`; the gated Chromium / Docker / Postgres tests opt-in) would let the
  release job wait for main's green run on the tagged commit, as `gh run list --commit` can tell.
- Release extras cut from L5.16e: an Intel or universal build (BL-139), the release's DMG styled (BL-140), a
  Homebrew cask, `actionlint` in that CI.
- The release workflow keeps no cache (every run starts from the checkout, the lockfile and the pinned sources), so
  nothing a pull request's run filled can reach a release build: a CI workflow's caches stay its own — keep it so.

### BL-145 — Build provenance for the release
*S · noted in L5.16e's review · builds on: L5.16e*

- `SHA256SUMS-macos.txt` is made by the release workflow's `sign` job from what the `build` job handed it: it protects
  the download, not the build. A provenance attestation of the build job's artifact (GitHub's build-provenance
  attestation, pinned like the other actions, `id-token: write` + `attestations: write` on that job only) and, on the
  release page, how to check it (`gh attestation verify`) would let anyone tie a DMG to the tagged commit and the
  workflow run. Not needed for own-use releases.

### BL-146 — One filming take at a time on this Mac
*S · cut from L5.14*

Two takes may film at once today (a terminal's `retake run` beside a Studio take, two workspaces): each says it ("another
take films … at the same time") and records `perf.machine.takes_beside`, and `choppyCause` names it. Serialising them —
the second waits, as a render does — would keep each take's machine to itself; it needs a wait in `retake run` and a
capture slot that looks at other workspaces' markers, with the same cap.

### BL-147 — Captures first on Linux and Windows
*S · cut from L5.14*

Elsewhere than macOS the markers live in `<RETAKE_HOME>/captures` and heavy work only waits to start: there is no
background QoS to lower a running render's priority without root (`nice` cannot be reversed by the user). Options:
SIGSTOP / SIGCONT on Linux (with the timeout and watchdog work of BL-151), job objects on Windows, or the wait only.

### BL-148 — One heavy job per machine, and a light lane
*S · cut from L5.14*

Each workspace's worker runs one heavy job: two workspaces render at once. One heavy job per machine (a heavy marker
beside the filming ones), and a light lane so a component preview never waits behind a long 4K export.

### BL-149 — Queued takes of other workspaces hold heavy work too
*S · cut from L5.14*

A take queued in workspace B holds B's renders, not A's: A's render may start in the second before B's worker claims and
films the take (then it is slowed at once). A "queued take" marker written at submit would close that window; it needs
a liveness for a submitter that has gone away.

### BL-150 — A held heavy job adopted by the next worker
*S · cut from L5.14*

A job process whose worker died ends its job (`interrupted`) and a next worker stops what is left of it. Adopting it
instead (the next worker becomes its supervisor and lets it finish) would save a long render; it needs a hand-over of the
supervisor identity and of the QoS hold.

### BL-151 — Pausing a render (SIGSTOP) instead of slowing it during a take
*M · cut from L5.14 — the spike's numbers kept here for later*

L5.14a's spike measured both mechanisms on the M4 (fixture `quote`, a 47 s take, a 61 s render of 1832 frames; DESIGN
§4q has every run): takes alone 60.5 / 51.4 / 59.7 / 60.3 / 60.4 fps at worst during motion (median 60.3, spread 9.1);
beside a render SIGSTOPped for the take 60.5 / 29.6 (disturbed) / 51.5 today, 60.5 / 60.5 / 58.4 with BL-114's
settings; beside a render under background QoS 41.7 / 52.1 / 57.3 today, 56.3 / 60.7 / 57.7 with BL-114's. Both
passed the bar (median ≥ 51.2); QoS was chosen (no timer to defeat, nothing stopped to recover, reversible without
root) with a margin of 0.9 fps today. SIGSTOP would need: Remotion's frame timeout raised (with today's 90 s a 120 s stop
failed 1 of 2 renders in both settings: a timeout, or an EPIPE), a watchdog of active time instead, the stopped tree
recovered after a worker crash (macOS sends nothing to an orphaned group), and the memory it holds (2.9 GB today, 2.2 GB
with BL-114's settings, for a 60-min stop: 21 000 / 24 600 pageouts). Frames stayed identical after every stop with
the 6 h timeout. Worth it if QoS proves too weak on a smaller Mac (MACOS-CHECKLIST 16.6) or with L5.15's settings.

### BL-152 — The ffmpeg-only exports on VideoToolbox
*S · cut from L5.15*

The `mp4_1080p` transcode of a 4K master (libx264 CRF 18) and `webm` (VP9) still run on the CPU; VideoToolbox could take
the H.264 one (HEVC too, BL-155). Measure the CPU saved against the size, as L5.15 did for the render.

### BL-153 — Renders on the GPU on Linux
*M · cut from L5.15*

On Linux `auto` keeps the software path: no GPU in the containers and runners Retake has run in. A machine with one
could use ANGLE on EGL or Vulkan (`angle-egl`, `vulkan`) and NVENC / VA-API; it needs a GPU probe for containers and
its own measurements. `encoder: videotoolbox` there stays an error.

### BL-154 — The CPU the GPU path keeps: ffmpeg's 56 cpu-s and Node's
*S · cut from L5.15 (critique L5)*

On the GPU path the compositor's ffmpeg still spends ≈ 56 cpu-s per minute of 1080p (decoding Remotion's JPEG q95 frames
and the BT.709 conversion) and Node 22–47 (282–335 on the 4-minute render, ≈ 30 % of its total). Profile both: PNG or
raw frames, Remotion's shared-memory capture, a lower JPEG quality, the colour conversion done once.

### BL-155 — HEVC or ProRes masters through VideoToolbox
*S · cut from L5.15*

A render master in HEVC (smaller at the same quality) or ProRes (for an editing tool) through the Mac's media engine.

### BL-156 — A per-render `--gl` / `--encoder` flag
*S · cut from L5.15*

The settings are per machine (retake.yaml `render:`, `RETAKE_RENDER_*`), and a retake.yaml key wins over its variable:
a flag for one render (`retake render --gl software`) if that proves too coarse.

### BL-157 — A fallback for stills and previews
*S · cut from L5.15 (critique M2)*

Stills, component previews and the Library's loops share the render's GPU check but have no mid-render fallback: a
failure is said (the Library offers Retry). Retry them once in software if GPU failures show up there.

### BL-158 — Renders on a smaller Mac (8–16 GB)
*S · cut from L5.15 (MACOS-CHECKLIST 17.6)*

Measured on an M4 with 24 GB only: the GPU path's tree sums ≈ 2.7 GB of RSS on a 1080p render (today's ≈ 4.1 GB; a sum
counts shared pages once per process, so the footprint is lower — the final harness reports it per process kind), the
GPU process ≈ 0.7 GB per browser; two renders at once (two workspaces, BL-148) add ≈ 1.3 GB. Check memory pressure and
swap on an 8 GB and a 16 GB Mac, and the take beside a render there.

### BL-159 — A stall watchdog for the hardware encoder
*S · cut from L5.15 (review A L1)*

A cancel now ends the wait for the VideoToolbox probe at once, and a render can always be cancelled; but a hardware
encoding session that stops taking frames mid-render (libx264 cannot) has no time limit of its own — the render waits
until it is cancelled. Watch the encoded-frame count on the VideoToolbox path: no progress for N seconds → cancel the
attempt and count it as a GPU-path failure (one software retry, as for the other encoder failures).

### BL-160 — The bundled Chromium, bumped in one command
*S · noted in a review of the release workflow · builds on: L5.16e*

The app ships Playwright's Chromium, so each release starts by bumping Playwright (`playwright-core` and every
package that names it, one exact version), installing its browsers and re-recording `apps/desktop/bundle/browsers.json`
(docs/RELEASING.md, step 1) — by hand today. A script doing the three (the digests printed for review, nothing
recorded unchecked) would make it one step; the release job could then warn when the tagged commit's Chromium is older
than the newest Playwright release.

### BL-161 — Sandboxed browsers on Linux, as root and in containers
*S · noted in a review of the browser sandbox · builds on: the hardening of the capture and render browsers*

Every capture browser runs in Chromium's OS sandbox, which on Linux needs unprivileged user namespaces and a user that
is not root: as root (the default user of many containers) Chromium does not start, and `retake doctor` says to run
as a regular user. Renders on Linux still run as Remotion starts them (without the sandbox). What remains: a documented
container recipe (a non-root user, the namespaces it needs), a check of the setuid sandbox helper where user namespaces
are off, and the render browser sandboxed on Linux like on macOS.

### BL-162 — MCP over HTTP: a peer check per connection, and clients that verify the server
*S–M · cut from the hardening of MCP over HTTP (L5.18) · builds on: L4.1, BL-79*

`retake mcp --http` listens on a fixed port (47820) so a registration survives restarts. At start it refuses a port
held by a listener that is not this account's Retake MCP server (and advises `--rotate-token`), but two gaps remain on
a Mac shared with other accounts:
- **Who connects.** Any local process that holds the token is served. A check per new TCP connection (cached per
  socket) could find the client end with `lsof -nP -a -iTCP@127.0.0.1:<client port> -sTCP:ESTABLISHED` (a non-root
  `lsof` lists this account's processes only, about 40 ms) and refuse, before the token is compared, a connection
  this account cannot see. It does not stop squatting (the client sends the token before anything is checked), so it
  was cut.
- **Who answers.** While the server is down, another account's program can take the port and receive the token the
  client sends. Closing it needs the client to check the server: a challenge answered with the token (an HMAC of a
  client nonce) before the bearer header is sent, or a Unix socket in a folder only this account can read — neither
  is something an MCP client does today.
- **Which listener is ours.** At start, a listener is told apart by its account (lsof) and its command line (ps):
  `… bin.js|retake … mcp … --http`. Another program of the same account can copy that command line, so it gets the
  "port busy" answer instead of the rotate-token advice. A challenge (the listener proves it holds the token without
  sending it) would close this; within one account, that program could read the token file anyway.

### BL-163 — A faster, steadier test suite, back in the CI
*M · noted when the suite left the CI (2026-11-10) · builds on: BL-144, the architecture series*

The default suite (`pnpm test`, about 440 files) takes about 20 minutes on the Mac and about 50 on a shared macOS
runner (three cores, no GPU), where some timing tests failed on every run — a different set each time (19, 7, then 12
failures with two files at a time; with two retries, still 4 tests in 2 files: a held tab load in
`runner-web/test/navigation.test.ts`, three Studio-in-Chromium tests in `ui/test/studio-e2e.test.ts`). One file at
a time stalled after 62 files and ran past two hours. So `ci.yml` runs the build and the guards only. What to do:
- **Measure where the time goes**: the slowest files and tests (`vitest --reporter=json` durations), how many browser
  launches, renders and ffmpeg runs the default suite does, and which of them a cheaper test (a unit test on the
  function, a shared browser per file, a smaller frame size, fewer frames) would cover as well.
- **Split the suite**: a fast tier (no browser, no render, no ffmpeg: a few minutes) for every pull request, and the
  browser / render tier on the Mac or a nightly run; the gated tiers stay opt-in.
- **Waits, not timings**: a test that asserts a duration or races a paint waits for the event it measures
  (`expect.poll`, the page's own signal) or keeps its bound to the Mac (`MAC_TIMING`, the eleven files
  `ci-workflow.test.ts` lists); find the tests that fail under load (run the suite with the cores busy) and fix them.
- **Why one file at a time stalled**: a test that never ends (a browser or ffprobe left behind, a wait with no
  limit) — every wait in the suite needs a limit, and a file that outlives it fails with what it was waiting for.
- Then the suite (or its fast tier) goes back into `ci.yml`, and the release can wait for main's green run (BL-144).
### BL-165 — Runs and takes: what the one rule left
*From:* L7.6a. Small pieces, any order.

- Run ids compared as text where "is this run newer" is asked — the board's "failed after the capture" and its
  poster, the scenario view's "newer partial run" note, the front end's board words: with a run folder named by hand
  the text order and the one order of runs (dated ids first) disagree. One `isNewerRun(a, b)` in the domain, used by
  the four places.
- `--json` output of `render`, `still`, `plan` and `export-capture` carries nothing of what `latest` passed over or
  did not consider (the line is on stderr only): a member for scripts.
- A run record that says `running` whose process is gone is never closed: lists show it running, prune keeps it for
  ever, and `latest` can only say "not finished, or interrupted". A liveness fact in the record (or a sweep that
  closes such records) would let each say which.
- A run id's date stamp is not compared with its record's `started_at`: a complete capture folder with a future date
  is the latest capture everywhere.
- The head of a timeline is read by parsing the whole file: the Studio's scenario view parses one timeline per listed
  succeeded capture the first time it is shown (not measurable at tens of KB; about 0.6 s once with twenty captures of
  7 MB), and the timeline view's default asks the rule on each call (one run.json per newer run). A head read that
  stops early, or a memo for the default.
- `latest` reads one run.json per newer run (about 0.1 ms each): a project with hundreds of failed or foreign runs
  above its last capture pays it on every `render`, twice (the "scenario changed" note resolves the run too).
- `run_status` reads the record of a run folder that is a symbolic link, which the lists skip.
- Through MCP a capture whose film has more than one name (a hard link) is picked as `latest` and then refused by the
  plan: it could be passed over like a linked film, so that an older capture renders.
- `retake plan` resolves `latest` with the editor's rule but plans on its own (it reads no film): a named run without
  its film still plans there and fails at `render`.
- The raw export's manifest for a run whose run.json is no record: `run.status` / `run.env` are absent with no word
  in the package's notes.

### BL-166 — The app's native menus, reworked
*M–L · founder's request (2026-11-11) · builds on: L5.2, L5.9, L5.11a, L5.16c · see BL-126*

The menu bar (`apps/desktop/src/menu.rs`) is a fixed table: every page command is always enabled and answers in the
status bar when it cannot act, the page has no right-click menu, and the shortcuts live in two places (the menu's
accelerators, the page's MENU_COMMANDS). Other desktop apps built on the same shell now do it this way:
- **One command registry** feeding the menu bar, the command palette, the window's shortcuts and a Help › Keyboard
  Shortcuts list, always with the same chord. The component that owns an action registers it with whether it applies
  now and a label for the context ("Capture 'quote'", "Render 2 Scenarios"); the menu greys out and relabels as they
  come and go. This absorbs BL-126's "menu state from the page" (the page's state reaching the shell: the supervised
  pipe, or a narrow page→shell request).
- **Native context menus**: a right-click on a scenario, a step, a take, a render, a comment or a library item opens
  a native menu in the app and an in-window menu in a browser, from the same list of actions; on a selection it acts on
  all of it and says so first.
- **A menu audit**: what each menu should hold — File (New Scenario, Open Recent Workspace, Reveal in Finder), the
  app menu (Settings… ⌘,), Scenario (Validate, Review), Help (the guide, Keyboard Shortcuts, Report an Issue) — with
  the standard macOS items kept the platform's own, and no chord that collides with a field's editing keys.
- **Open question: windows and tabs.** File › New Window ⌘N / New Tab ⌘T (system tabs) to open a scenario or a run
  beside another; today the Studio is one window per workspace, and a second window on the same server needs its
  state (selection, live recording) per window.

- **Value:** the app feels like a Mac app: what can act now is visible in the menus, right-click works where people
  expect it, every shortcut is discoverable.
- **Hard parts:** the page's availability reaching the shell without a page→shell channel that a page script could
  abuse (the shell trusts nothing the page says today); keeping the browser runtime and the app on one action list;
  the e2e kit cannot click a native menu (an unattended run cannot post to the menu bar), so menu tests stay on the
  table and the registry.

### BL-167 — An update you can watch: download progress and the restart
*S–M · founder's request (2026-11-11), from the first in-app updates · builds on: L5.16d · see BL-166*

*Done in hotfix v0.2.4, in part:* `State::Downloading` carries the bytes and the announced size (update_flow
`watch_reporting`: each new count, at most every 250 ms); the sheet lists the steps (download, signature, jobs, quit;
the failed one marked) with a kit Progress (megabytes, percent; indeterminate without a size); the badge says the
percent, then "Checking vX…"; the Dock icon's badge label says the percent (NSDockTile `badgeLabel`, not a progress
view). *Left:* the native progress panel on the alert path. *Done in hotfix v0.2.6:* the restart gap — the
installing step says the window goes for a few seconds, the Dock badge shows ↻ while the process installs, and the
restarted app says "Updated to vX" once (desktop-updates.json `updated`, state `updated`; the release notes are not
shown again).

The update archive is large (about 370 MB in v0.2.2), and once Install and Restart is clicked nothing moves: the sheet
says "Downloading vX" with no figure, the badge only turns busy, and the native alert path (Help › Check for Updates…
when the page cannot answer) shows nothing at all until the app quits. The shell already counts the bytes and the
announced size (`update_flow::Progress`, polled every 250 ms by `watch`); `State::Downloading` just does not carry them.
- **The download**: bytes received of the total, a percentage and a bar in the sheet (`progressWords`), the badge
  showing the percentage while the sheet is closed, and an indeterminate bar when the server announces no size. The
  state line reaches the page at most a few times a second.
- **Outside the page**: the Dock icon's progress (NSDockTile with a progress view) so it shows from another app or with
  the window closed, and a native progress panel on the alert path.
- **The steps after it**: "Verifying the signature", "Waiting for 2 jobs", "Installing — Retake restarts" said in turn,
  then, after the restart, a one-time "Updated to vX" notice (the release notes one click away) — today the window just
  vanishes and comes back.

- **Value:** a person sees that the update is moving and how long is left, and never quits the app thinking it hung
  (which would abort the download).
- **Hard parts:** the Dock progress needs a custom NSDockTile content view (objc, as `macos.rs` does already); the
  restart gap itself (the old app gone, the new one not yet up) has no window to draw in, so the notice after it is
  what closes the loop.

### BL-168 — After an update, the Dock's pinned icon is no longer the running app
*S–M · founder's report (2026-11-11), from the first in-app updates · builds on: L5.16d*

*Done in hotfix v0.2.4, with another cause than the one guessed below:* Tauri's `AppHandle::restart` runs `open -n` on
the bundle while the old process still runs, so LaunchServices starts a second instance and the Dock gives it its own
icon. The restart is now a detached shell (desktop_core `relaunch`) that waits until the old pid is gone from the
kernel and from LaunchServices (`lsappinfo`), then runs a plain `open` on the bundle (`open -n` after 30 s). The
plugin's swap is unchanged. The update *to* v0.2.4 still restarts the old way (the old app restarts itself).

With the app kept in the Dock, an update ends with two icons: the pinned one, which looks closed, and a second
one on the right for the app that restarted, although both are `/Applications/Retake.app`. Likely cause, to confirm:
the updater plugin's install (`swap` in `update.rs`) moves the old bundle aside to a temporary folder and renames the
new one into place, so the bundle at that path is a new directory. The Dock's pinned item is a bookmark that follows
the old directory (by file id, before the path), so it points at the copy moved aside, then deleted, and the restarted
app is not the pinned one.
- **Probe first**: pin the app, update an ad hoc build through the e2e feed (`app-update-e2e.test.ts`), and read the
  pinned item before and after (`defaults read com.apple.dock persistent-apps`: its bookmark, never written); same with
  the Finder's sidebar and Login Items, which hold bookmarks too.
- **Fix candidates**: keep the bundle's top directory and swap only its `Contents` (the code signature seals
  `Contents`, not the folder that holds it), with `renamex_np(RENAME_SWAP)` so the swap stays atomic and the old
  `Contents` can be put back on failure; or re-register the bundle with LaunchServices after the swap and relaunch
  through it. Either way the updater's own signature check stays where it is.

- **Value:** the Dock, the Finder sidebar and Login Items keep pointing at the app after every update.
- **Hard parts:** the swap is in a dependency today (an own swap means keeping the restore-on-failure path, and its
  test, ours); a Dock already holding a dangling pin from an earlier update is fixed only by pinning again.

## Guard-rails for planned lots (no new scope)

Cheap rules to apply when these lots start, so the backlog above is not blocked later.

- **L1.2** — Close R-RUN-17: redact `{{env:…}}` and keychain values from timeline, log.jsonl and run.json. Today values in open URLs are written in clear. *Why:* Runs will later be shared through review links, the library, CI artefacts and sync, and any secret left in a run file leaks.
- **L1.3** — Treat L1.3 as a decision gate and write the result down: either CPU-only capture reaches 24 fps or more with time dilation, or it doesn't and the limit is documented. *Why:* That result decides whether CI runners, self-hosted runners and hosted capture (BL-05, BL-08) are viable, and whether 4K can be sold.
- **L1.4** — Finish R-PRIN-13: add a `version` field to scenario, project.yaml, template.yaml, retake.yaml and run.json. Also record the engine version, Chromium version, OS and installed font set in run.json. *Why:* Files will meet clients of different versions through sync, CI and a hosted UI, and differences between local and CI captures must be explainable. *Applied in L1.4:* `version` optional in those five files (absent = 1; a newer one is one positioned error), written by `retake new` and the runner, carried by the starter templates and the fixture; run.json `engine` = Retake, Node.js and Chromium versions, OS and the installed fonts (count + digest of their names); a migration command is BL-70.
- **L1.6** — Reference personas by name. Resolve profile and storage-state paths from user config (~/.retake) or a git-ignored project.local.yaml, never from project.yaml. Mark storage states as tied to one machine. *Why:* SPEC §4 currently puts `auth.profile: ~/.retake/...` in project.yaml, so a path specific to one user would sync and break on every other machine. *Applied in L1.6:* personas by name, paths derived under `~/.retake` (`RETAKE_HOME`), snapshots stamped with the machine; the `project.local.yaml` override is BL-60.
- **L1.6** — Make automated login (R-AUTH-05) work headless, with credentials from secret refs (env or keychain) and no copied profile. *Why:* A CI or self-hosted runner has no signed-in profile, so login is the first thing BL-05 needs. *Applied in L1.6:* `login:` steps run headless with no profile at all (in a run's preflight, or `retake login --auto`).
- **L1.7** — Read-only interception must let the off-camera session check and the automated login through (their tabs, `POST /sign-in`). *Why:* L1.6 checks every persona before a run and may sign it in, before any recording; blocking those requests would fail every signed-in run. *Applied in L1.7:* the automated sign-in tab is exempt while it is on its persona's sign-in page (its writes there are recorded `exempt`, `via: sign-in`; what the page it lands on sends is guarded); the session check only reads, so it is guarded like the capture pages and passes; the product clock is installed after both (they run on the real time). Token refreshes from capture pages go in `read_only.allow`.
- **L1.8** — Keep host paths out of the sandbox manifest, so the same file runs on a laptop, a VPS or in CI. *Why:* A cloud or CI sandbox (BL-05, BL-08) can then reuse the manifest unchanged.
- **L3.1** — Engine API security contract: bind to 127.0.0.1, require a per-session token, check Host and Origin against DNS rebinding, allow exact origins only in CORS (never `*`). Keep the asset server's `*` only together with tokenised paths. *Why:* The API runs shell and SQL hooks, so any web page, or a component inside the Player, could otherwise drive it. This becomes critical with marketplace components or a hosted UI. *Moved to L4.1* (L3.1 has no HTTP API: the MCP server is stdio only). *Applied in L4.1:* the engine's gate (DESIGN §4c) — 127.0.0.1 only, Host (421), Origin and Sec-Fetch-Site (403), no CORS at all (no `Access-Control-*` header, a preflight always fails), a bearer token per Studio launch (a one-time bootstrap code in the link, never the token in a URL), a stable token for MCP over HTTP; the asset server is L4.2's.
- **L3.1** — Version the API (`/v1`) and add a capabilities endpoint that returns the engine version and features. Use one discovery file (port, token, pid) shared by the CLI, MCP and the Tauri shell. *Why:* A UI and an engine that ship separately (hosted UI, relay, desktop shell) must negotiate what each supports. *Partly applied in L3.1:* the engine has an API version and a features list (`engine_info`); `/v1`, the capabilities endpoint and the discovery file come with the HTTP API in L4.1. *Applied in L4.1:* `/v1` with `GET /v1/info` (engine info, `http_api: 1`, the allowed ops) and `<workspace>/.retake/ui.json` (0600, claimed exclusively). *L5.2:* the Tauri shell does not read it — it runs `retake ui --supervised`, whose reuse of ui.json gives it a one-time URL (and the player origin) without the token.
- **L3.1** — Make job payloads serialisable (kind, project ref, relative paths plus hashes, options) and use a worker interface that pulls jobs. Run the worker in a separate process, at least in tests. *Why:* This makes ADR-1's 'remote worker later' real rather than a paper interface, and a pulling worker works behind NAT (BL-05, BL-06). *Applied in L3.1:* core `JobInputSchema` (v1: slugs, scenario names + the sha256 of their bytes, reserved run ids, approvals as fingerprints; never a path, session or secret), a file queue under `<workspace>/.retake/jobs/`, one worker per workspace in its own process (`worker.lock`) that claims jobs; tested in a separate process.
- **L3.1** — Run, render and export records store storage refs plus sha256, never absolute paths. *Why:* The remote library and cloud storage (BL-04) then plug into the existing storage abstraction. *Partly applied in L3.1:* the engine's `LocalStorage` gives refs + sha256 at its boundary (MCP results); run.json / render.json still hold absolute paths (a format change: L3.6 / BL-70). *L3.6:* comment threads hold ids only (render id, run id; paths rebuilt from ids, never read from a file); render and run records unchanged (BL-70).
- **L3.1** — Writes from the UI and MCP carry `if-match: <hash>`. All file writes are atomic (temp file then rename). The engine watches the workspace for outside edits. *Why:* Under ADR-2, Claude, the UI and the engine already write the same files, and sync would add another writer. *Applied in L3.1:* `if_match` (sha256 of the bytes written) on `scenario_save` and `project_update_readme`, atomic writes, a must-not-exist create; watching the workspace moves to L4.1. *Applied in L4.1:* a bounded stat poll of the workspace while a Studio tab is open (no recursive fs.watch), told to the page as events; the README editor saves with `if_match` and shows a conflict.
- **L3.1 / L3.6** — Use globally unique IDs (ULID, or UTC plus random) for runs, renders and comment threads; `-vN` becomes a display label only. *Why:* `newRunId` (core/src/util.ts:14) and `nextVersion` (editor/src/render/runs.ts:92) collide across machines, and comments anchor on render_id. *Partly applied in L3.1:* job ids are ULID-style (`j_` + 26 Crockford base32); run ids keep their readable format (L3.6 / BL-70). *Applied in L3.6:* comment threads are `c_` + a ULID and their entries `r_` + a ULID; render ids stay `<scenario>-v<N>` with the render's `created_at` stored beside them in a thread (BL-76, BL-70).
- **L3.1** — Parked (commercialisation). Add one entitlements function that returns 'all features' for now, and keep a count of renders (videos and stills) in the job history. *Why:* R-V2-01 notes that no licence hook point exists. A render count enables Remotion usage reporting, or the monthly report required when telemetry is blocked. *Applied in L3.1:* engine `entitlements()` (internal, all features, no limit; in `engine_info`) and `<workspace>/.retake/history.jsonl` — one line per finished job and per CLI run / render / still (and per `retake export` that re-rendered formats, counted per format), with captures, dry runs and renders counted (`engine.usage()`); component previews (a development tool) are not counted.
- **L3.1** — Amend ADR-1 when L3.1 starts: split 'engine runs locally' from 'UI delivery'; define the job input contract (files, sessions, secrets, network reach); replace 'data never leave the machine' with a data-flow table. *Why:* It keeps the UI delivery decision open and makes the privacy claim accurate before it is used in sales material. *Applied in L3.1:* the ADR-1 amendment in docs/ARCHITECTURE.md.
- **L3.6** — Done 2026-10-12 (DESIGN-phase2 §4, R-CMT-02). Fix DESIGN-phase2 §4 and R-CMT-02 to one file per thread (R-ARC-04). Make replies append-only (one file each, or entries with their own ids). Anchor comments on step `id` or a fingerprint, not only the step index. *Why:* This avoids sync conflicts on threads, and drag-and-drop in L4.3 reorders steps, which breaks anchors based on the index. *Applied in L3.6:* threads `c_<ULID>` with append-only `r_<ULID>` entries, the anchor with `step_id`, a step fingerprint and its occurrence (DESIGN-phase2 §4).
- **L3.2 / L4.5** — Render and preview Chromium with the network blocked except the asset server. Run the Player in a cross-origin sandboxed iframe with no engine token and a strict CSP. Add `engines` / kit-API version to the component manifest. *Why:* Even a workspace component written by Claude can get past the regex scan in compile.ts. These are the foundations of BL-15, BL-16 and BL-42. *Partly applied in L3.2:* renders and previews of the jobs worker run with a network guard (CDP Fetch on the browser: asset and bundle servers only, Remotion's `/proxy` and Node-side media downloads checked; a CSP meta without WebSocket in every bundle); WebRTC / DNS prefetch and CLI renders are BL-72; the Player iframe and `engines` stay L4.5. *`engines` applied in L4.5 part A:* manifest `engines: {kit: "^1"}` (absent = kit API 1); a component written for another kit API is not loaded (registry notice), its uses fall back. *Applied in L4.5:* the Studio's preview runs the Remotion Player in a cross-origin `sandbox="allow-scripts"` iframe on a second loopback origin, every file of it (frame, bundle, plan, media) under one session capability, no engine token in the frame, a strict CSP with `sandbox` (`connect-src` / `media-src` / `font-src` that origin only, no `unsafe-eval`), WebRTC removed, one MessageChannel to the page with a strict schema and a flood budget, the bundle's imports on an allow-list of real paths (DESIGN §4g); each rule mutation-checked. Residues: BL-110.
- **L3.7** — Component scaffolds and the component skill import renderer primitives through the kit module, not directly from `remotion`, wherever that is feasible. The aim is keeping the renderer replaceable, not hiding Remotion: attribution and licence terms still apply. *Why:* R-V2-08 and BL-24: a change of renderer then touches one module instead of every user component. *Applied in L3.7:* the kit re-exports `useCurrentFrame`, `useVideoConfig`, `Img`, `AbsoluteFill`, `Sequence` and `random` (`kit/renderer.ts`) and the eight scaffolds import nothing from `remotion`; `remotion` stays allowed by the compile check for what the kit does not re-export, and the `retake-component` skill tells Claude the same. The built-in library keeps its direct imports for now (BL-77).
- **L3.1** — Keep a single list of authored, generated and machine-bound files, and use it for the `.gitignore` written by createProject. It will double as the future sync-ignore list. *Why:* Sync (BL-02) and the library (BL-04) need exactly this list, and it must never include profiles, journals or secrets. *Applied in L3.1:* core `WORKSPACE_FILES` (authored / generated / machine, for a workspace and a project); `PROJECT_GITIGNORE` (same list as before) and `WORKSPACE_GITIGNORE` derive from it; `retake doctor` warns when a workspace's `.retake/` is not git-ignored.
- **L4.4** — Design the live preview stream with an input channel, even if it is unused at first. *Why:* Recording and driving a remote or headless browser from the UI (BL-25, BL-38) can then reuse it. *Applied in L4.4:* the worker's live channel records carry `{v, kind}` (`kind: 'frame'` today) so an input channel can be added as a separate authenticated route beside `GET /v1/frames` (DESIGN §4f); nothing of it is built (BL-105).
- **L4.1 / L4.9** — `retake ui` must work and be tested in Chrome, Safari and Firefox. The Player must be checked on WebKit. *Why:* It serves Windows and Linux users, a future hosted UI, and Tauri's WKWebView with the same code. *Partly applied in L4.5:* the timeline's Player is checked by hand in Safari and Firefox (MACOS-CHECKLIST 13f); the automated suite drives Chromium and, gated, the installed Chrome (WebKit's missing frame isolation: BL-110). *L4.6:* the Comments screen the same way — Chromium, a gated installed-Chrome acceptance on the fixture, Safari and Firefox by hand (MACOS-CHECKLIST 13g); its frames are server-made JPEGs, so every browser shows the same exact frame. *L4.9:* the in-repo accessibility checker (a11y.ts: contrast, names, reachable roles, real focus indicators, colour never alone, a selected state more than colour, headings, no sideways scroll) on two screen tours and a keyboard-only path in Chromium, the R-ACC4-01 acceptance in the installed Chrome, one WebKit run by hand from a cached build; Safari, Firefox and VoiceOver by hand (MACOS-CHECKLIST 13j); automating them is BL-121.
- **L5.2** — The Tauri shell only supervises the engine and opens the same UI. Nothing beyond OS glue lives in Rust (reinforces R-DSK-02). *Why:* It keeps parity between the browser, desktop and hosted versions of the UI. *Applied in L5.2:* the shell runs `retake ui --supervised` and opens its one-time URL; it holds no token and never reads ui.json (the CLI's own reuse decides owned / attached); its Rust is process supervision, the menu, two native dialogs and a navigation allow-list (DESIGN §4j).

## Recorder precisions (L3.4 / L4.8)

Founder idea 5 ("human capture": click Start, act, get a scenario — no video) is already planned as L3.4 Recorder
and L4.8 Record screen. Fold these precisions in when the lots start; what goes beyond them is BL-25 to BL-27.
*Applied in L3.4* (README "Recording a scenario", DESIGN §3.11–3.13), with two deviations: secret fields become
`{{vars.<kind>_N}}` placeholders (CHANGE-ME, a showable demo value) — not `{{env:…}}` refs, which a scenario saved
through MCP may not name — and `scenario_record` returns the draft itself (under `untrusted`) through `job_status`. The
alternatives, the quick inserts and the thumbnails stay with L4.8 (BL-74). *Applied in L4.8* (README "Studio app" →
Record a scenario, DESIGN §3.11–3.13 and §4h): the alternatives and the quick inserts; thumbnails per step cut (BL-118).
Noticed in L4.8, not fixed: one instant wheel jump (a headless test's `wheel(0, 2400)`) is scrolled by the compositor
before the passive wheel listener takes its baseline, so no scroll is recorded — a person's wheel makes many small
events and is recorded (take the baseline from the previous scroll position instead).

- Record what the user meant, not coordinates. Generate each target with the same resolver as page_inspect (role and name first, then label, text, testid; prefer role or testid when the project is localised). Check that each target resolves back to the same element, and keep the alternatives the user can pick from (R-UI-21).
- Merge keystrokes into one `type` step and drop the human typing rhythm, since the runner sets pacing. Detect clear and select-all and turn them into the React-safe clear helper from L1.2.
- Filter noise: drop clicks that changed nothing, hovers that revealed nothing, and scroll jitter. Collapse repeated scrolls into one scroll to the next target.
- Turn human pauses into `wait_for` on the next target appearing or the page going idle, never into fixed `wait` steps. Detect full-page navigations and mark them, so the loading handling from L1.2 applies.
- Map clicks on native selects, portal popovers, menus and date pickers to `pick`, `menu` or calendar helpers. When no rule matches, fall back to a plain click with a visible warning. This is the hard part and needs heuristics per UI library.
- Never record secrets: skip values of `type=password` and `autocomplete=current-password|one-time-code` fields, and anything on the persona's login URL. Emit `{{env:…}}` / `{{keychain:…}}` refs instead, and keep these values out of every recorder log.
- Start from a copy of a persona's session (R-AUTH-07). Map hosts to the environment's page keys with relative `open:` paths, so the draft contains no absolute staging URL.
- Recording is a real browser session, and its actions really happen. If the host is marked production or read-only (L1.7), warn before Start. When writes were observed (POST/PUT/DELETE), say so at Stop so the user adds a reset hook.
- Split the recording into scenes on navigation or a major UI change. Support the quick inserts in R-UI-22 (hold, caption, mark, camera zoom) while recording.
- Run an immediate headless dry-run after Stop and list the steps that fail to resolve before the draft is saved. The `scenario_record` MCP tool returns the draft path plus these warnings, so Claude can clean it up.
- No video is captured while recording, as the founder intends. The session produces only the YAML draft, with a `version` field and validated by the normal schema, plus optional small thumbnails for each step in the Record screen list. Reproducibility and review come from re-running the scenario.
- Keep step generation independent of where input comes from (a headed local window in the MVP), so recording through the live preview (BL-25) can reuse it later. Capture stays inside the engine, consistent with the 2026-10-12 decision not to build a browser extension.

## Open decisions

**Settled for internal use (2026-10-12):** Remotion is free for individuals and for companies of up to 3 people
(terms shipped in `node_modules/remotion/LICENSE.md`, v4); the founder's company has one person, so the free licence
applies. Revisit if the company reaches 4 people or when selling (parked decision below). The renderer stays
replaceable behind the EditPlan/component contract (R-V2-08, BL-24).

**Parked — commercialisation is a future topic (2026-10-12).** Recorded so they are not lost:

| When | Question | Options |
|---|---|---|
| Before pricing / before the first sale; ideally before L3.7 and L5.2 | How is the Remotion licence handled for a commercial desktop tool whose users write components and render on their own machines and in CI? | (a) Retake holds an Automators or Enterprise licence and reports customers' renders. (b) Pass-through: customers with more than 3 people buy their own Remotion Company licence, and this is disclosed at purchase. (c) Negotiated Enterprise terms ($500/month minimum). (d) Replace the renderer (BL-24). Also decide whether to stay on v4 terms for now and plan the move to 5.0. |
| Before phase 4 (it shapes Studio UI priorities), and at the latest before the first sale | Who is the first buyer? | (a) SaaS developer, devrel and docs teams: videos in code, regenerated on release, CLI + CI + MCP. (b) Product marketing and sales: a web tool with nothing to install, polish and personalisation. (c) Agencies: several brands, accepting scripts. |
| Before the first sale | What plan structure and licence model? | (a) The founder's four separate plans (Teams, Cloud, AI, Marketplace). (b) A ladder: Free, Pro per creator, Team per creator with free reviewers, Business by quote, plus usage add-ons. Free threshold: watermark, non-commercial use, or company size (Docker model). Licence: subscription checked on the server (the market standard) or perpetual. The engine's licence: closed, source-available, or open source (Cap, for example, is AGPLv3). |
| Before V2 | How do users get AI model access in the app? | (a) Bring your own key, or their Claude through MCP, only. (b) Hosted credits included in tiers. (c) Both, with credits only for AI that has a clear cost per unit (voice, dubbing, translation, review). |
| Before V2 | What does the Team offer lead with, and is sync end-to-end encrypted? | (a) Review links and approvals first, with sync later. (b) Sync first. Encryption: end-to-end like Obsidian (privacy pitch, no server-side search or previews) or encrypted at rest only (more features, processor duties). |
| Later; after the L1.3 result and the Remotion answer | How far does the Cloud plan go, and on what infrastructure? | (a) Self-hosted runner image only. (b) Plus a control plane. (c) Plus hosted CPU render. (d) Plus hosted capture for public targets and a sandbox. Infrastructure: Cloud Run (GPU requires instance billing) or VPS / bare metal. |
| Later | Which path to a marketplace, and who handles payments? | (a) First-party packs through a merchant of record. (b) Plus a free git/npm community registry. (c) Plus a commercial marketplace with payouts, either through Stripe Connect (you are the seller and file VAT) or a merchant of record that supports payouts (unverified). |
| Before L5.2 | How is the desktop app delivered for the first sale? | (a) Tauri shell (L5.2) as planned, macOS only. (b) A signed engine installer plus `retake ui` in any browser first, with Tauri after. (c) Also officially support Windows and Linux through the browser UI. |
| Before the first sale | Which video encoders ship, and with what patent position? | (a) macOS system encoders (VideoToolbox / AudioToolbox) for H.264, AAC and ProRes. (b) Bundled GPL ffmpeg with x264 and AAC, plus a written position from Via LA. Also decide whether to drop libx265 and ffmpeg's ProRes encoder. |

## Suggestions on the locked MVP (founder decides)

Recorded for the founder; nothing here changes the roadmap until they decide.

- Parked (commercialisation); see the active Remotion note above. Take the Remotion licence question out of L6 now. It is an email with no code, but get the written answer before building L3.7 (component skill) and L5.2 (distribution). *Why:* The answer decides whether user-written components, renders on customers' machines, hosted render and the marketplace are allowed and what they cost. Building them first risks rework or a blocked sale. *L3.7:* built for own use under the free licence (settled 2026-10-12, not a blocker); the kit re-exports keep the renderer replaceable.
- Parked (commercialisation). Name the first buyer now, and use it to judge the rest of phases 3–5. The recommendation is SaaS developer, devrel and docs teams who want videos in code, regenerated on every release. *Why:* The product as specified is a developer tool. Without an explicit buyer, UI work (L4.x) and polish lots compete with features that first buyer doesn't need.
- Consider moving L5.3 (iOS Simulator runner, size L) to the backlog. *Why:* First buyers are web SaaS companies. The runner needs Xcode and a Mac, and it can't run in CI or the cloud cheaply (EC2 Mac hosts bill at least 24 hours).
- Consider slimming L2.11–L2.13: keep clips per scene plus a CSV/JSON markers file, and defer FCPXML, EDL, OTIO, ProRes, split screen, picture-in-picture and Lottie. *Why:* They add a lot of scope for a minority use. ProRes via ffmpeg raises a licensing question, and @remotion/lottie falls under Remotion's licence.
- Consider cutting L4.7 back to a read-only component library, and leave theme editing to L3.5 plus Claude through MCP. *Why:* Theme creation from brand inputs and from a site URL is already scoped, and Claude covers the editing.
- First-sale part parked. Re-size L5.2 to L, or ship the first sale as a signed engine installer plus `retake ui` in the browser, with the Tauri shell after. *Why:* Notarising bundled sidecars, the updater key and testing on WebKit make M look optimistic, and the browser UI already works for every user.
- Size the recorder (L3.4 and L4.8) more generously, and keep it early in phase 3/4. *Why:* It is the way non-developers will start, and its value lies entirely in the cleanup work listed in recorder_precisions.
- Parked (commercialisation). Don't advertise 4K until L1.3 and L1.5 have measured it on a Mac. *Why:* HANDOFF measures 9.5–16 fps for the screencast at 4K, against 44–58 fps at 1080p, and 2–3 fps under backdrop blur.
- Parked (commercialisation). Add a 'first sale' checklist next to L6: licence and billing (BL-39), compliance pack (BL-41), signed installer (BL-36), and a first video on the buyer's own app in under 15 minutes. *Why:* None of these are in the locked MVP, yet V2 cannot sell without them, and the external steps (lawyer, Remotion, Apple) take calendar time.
- Decided 2026-10-12: voice-over is an evolution (backlog). From the competitive study: decide explicitly about voice. Either cover the minimum inside the locked lots (a narration track from a file, BL-46, next to L2.12, and SRT/VTT export, BL-30, next to L2.13), or state "videos without a voice" in the positioning and keep TTS (BL-12) for later. *Why:* Almost every close competitor narrates; a silent track (R-ED-18) is fine for motion-design marketing videos but disqualifying for tutorials.
- Agent-channel listings parked; the GitHub Action stays a candidate for our own CI. From the competitive study: fold the GitHub Action (BL-45) and the agent-channel listings (BL-52) into L3.7 packaging. *Why:* Both are small, and they are how the open-source rivals are found. *L3.7:* not folded (own use; BL-77).
- Parked (commercialisation). From the competitive study: consider a first public release (CLI + MCP) at the end of phase 3, before the nine Studio lots, and decide the open-core question then. *Why:* It tests the market early; free MIT engines set the developer price at zero, so what is sold must sit above the engine (Studio, packs, team features).
- From the competitive study: do not trim L1.6 (personas) or L1.8 (sandbox). *Why:* Reproducible data preparation with rollback and a sandbox is the one capability no checked competitor has.

### BL-169 — Render records: what the one reader left
*From:* L7.6b. Small pieces, any order.

- The Studio's render list and the board disagree on a render record whose variant Retake never writes: the list shows
  it as landscape, the board passes it over. Pick one rule (a slug-shaped word shown, anything else `unknown`) when
  the views stop being flat (U7).
- A video in `renders/` without its record is never listed nor pruned.
- A lock left by a killed terminal render burns its version number.
- `nextVersion` reads file names only, which is what frees the number of a render renamed by hand (the root of a
  number reused).
- The `variant` a render record holds is never compared with its id's suffix.
- The board's "render failed" is fed by failed records, which no version writes.
- Prune has no option to list or free a file of `renders/` it left alone (nor the take it keeps for it).
- A terminal's `retake review|export … latest --json` carries nothing of what `latest` passed over (stderr only).
- `retake review|export <name>` reads a named record twice (once for the renamed line, once to work on it): an
  `onFound` callback on the export and review options would read it once (it moves the CLI golden).
- The folder of exports/ or review/ of a render named is compared with the other files of `renders/` only, not with a
  folder an earlier, deleted render left in `exports/` or `review/`.
- The lists of renders check each record against its schema: 7–10 % slower than before at 2 000 records; a cache by
  file signature (as the board's) would take it back.
- `retake prune --json`'s `kept.renders` counts every record file that stays, a file that is no render included (the
  text counts them apart).

### BL-170 — The Studio's other screens compare a render's theme by its folder
The project board compares a scenario's theme with its renders' by the theme's folder (`template_folder`, L7.9). The
Studio's other screens still compare it by name — `sameVersion` in `packages/ui/src/app/render-words.ts`, used by the
Render screen (`Renders.tsx`) to say whether a render shows today's file —, so a render made with another folder of the
same name reads as current there. They should use `template_folder` as the board does (a record of before L7.9 by its
name). *From:* L7.9.

### BL-171 — Elapsed time on the monotonic clock
The engine's stamps go through its Clock port (L7.10); its elapsed time does not, on purpose: the jobs worker's idle and
build-check timers, its cancel and orphan grace periods, the waits and deadlines (`jobs.wait`, the project lock, the
frame probes), the memos' lifetimes (the board, the scenario view, the bootstrap codes), a history line's `ms`. They
read `Date.now()` and are pinned file by file by the import-rules ratchet's `clock-read` check (19 files). Measured on
`performance.now()` (monotonic: a clock set back or forward moves none of them) most of these pins would go, about 8
left (the file times and the app set-up). It touches the worker's scheduler and the tests that set `idleSince` by
`Date.now()`, so it is a lot of its own. *From:* L7.10.

### BL-172 — `retake auth status --check` through the engine
`retake auth status` reads every persona's state through the engine and its capture runner (L7.12); its `--check`
still imports the runner package itself (`packages/cli/src/commands/auth.ts`: `checkSavedSession`, `profileLock`,
`writeStatus`, `PreflightError`) — the CLI's one R4 entry of a session. Moving it means an engine operation for a
live check of saved sessions that also writes each persona's status file, and a member of the CaptureRunner port's
sessions for that write: sessions are security-sensitive, so it is a change of its own, with its tests. *From:* L7.12.

### BL-173 — A queued Studio recording's annotate and save say "not started from the Studio"
`record_annotate` and `record_save` on a recording the Studio started that is still queued (no folder, no meta.json
yet) answer 403 "this recording was not started from the Studio: it is read-only here": the refusal reads who started
it from the folder's meta.json, which does not exist yet, so the starter is unknown (`record-studio.ts` `studioWords(null)`).
The refusal itself is right (there is no draft to arrange or save); its words should say the recording has not opened
yet, from the job's `submitted_by`. Seen in the L7.18 characterization (fixtures/authoring-ops.json). *From:* L7.18.

### BL-174 — The CLI's hooks and export: what the characterization pinned
*From:* L7.21 (U8.0). Each is pinned as it is today in `packages/cli/test/operations-cli.test.ts`.

- `retake hooks run --yes` and its destructive-hook prompt cannot be reached from a hooks file: core's check refuses a
  destructive hook without `confirm: true` when the file loads. Either the flag's words or the check should change.
- Run and journal ids are stamped to the second: two `hooks run` of one source, or two `env reset`, in the same second
  share one id and one journal.
- `retake export-capture --json` drops the template note: it reaches no stream and not the manifest.
- `plan` and `export-capture` word the "no timeline" refusal differently.
- A scaffolded `component.yaml` names its `$schema` by a path relative to the Retake checkout, which breaks when either
  folder moves.
