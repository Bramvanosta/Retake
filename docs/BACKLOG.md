# Backlog — unprioritised

The MVP scope is **locked** (2026-10-12) to the lots in `docs/ROADMAP.md`. Every new idea lands here instead of in a
lot. Items are **not ordered by priority**: they are grouped by area, and the IDs only make them easy to cite. Moving
an item into a lot is the founder's decision. Efforts are rough (S/M/L/XL, same scale as the roadmap).

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
- **How the UI is delivered** is a separate choice: one web UI served by the local engine (`studio ui`) works in any
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

Asynchronous sync of authored files (project.yaml, scenarios, hooks, assets, components, templates, comments) for teams that don't use git. Media syncs on demand by content hash: capture.mp4 + timeline.json for re-renders, and published renders, never frames. Git semantics: write against a base hash, 3-way text merge, a conflict copy when the merge fails. Never syncs profiles, storage states, .demo-studio/, hook journals, .env files or resolved secrets.

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

Publish the engine as a Docker image containing Node 22, Playwright Chromium plus Remotion's headless shell, ffmpeg, pdfjs and a documented font set. It runs `studio run/render/review` headless in the customer's CI or on their VPS. Ship ready-made CI workflows (for example GitHub Actions) that regenerate videos on each release. Nothing is hosted by us: the customer's own network, secrets and compute are used.

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

Metered AI through Demo Studio's own account, for users without an API key. It needs a metering proxy, credits included in paid tiers and sold as add-ons, per-project opt-in, and redaction before any frame is sent. Priced per review or per minute, not as a flat plan.

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

`studio components add <git-url|npm-package>` with a hash lockfile, a check of the manifest's `engines` / kit-API version, and a preview rendered in the user's theme. A static index page lists community packages. No payments and no hosted code execution.

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

`studio run --matrix rows.csv` runs one scenario per row. Variables (prospect name, logo, locale, persona) are injected into hooks, templates and captions, then each row is rendered and reviewed under a predictable name.

- **Value:** One video per prospect or segment, which sales-demo tools price highest.
- **Hard parts:** Data preparation and rollback for each row, total runtime of N captures, and Remotion's per-render fees at volume.

### BL-29 — Starter scenario library
*S · proposed in review · builds on: L3.3, L3.7*

Generic starter scenarios for common SaaS flows (signup, onboarding, create/edit/delete, settings, search). page_inspect and Claude adapt them to the target app.

- **Value:** Shortens time to first video on any SaaS product.
- **Hard parts:** Generic targets rarely match a real app, so it depends on page_inspect adapting them well.

### BL-47 — Scenario draft from a URL, without AI
*S · seen in competitors · builds on: L3.3 (page_inspect)*

`studio new --from-url` opens the page, lists headings, navigation and primary actions with robust targets, and writes a draft scenario to edit. Deterministic and offline, no model call.

- **Value:** A first result in minutes for users who don't use Claude, next to scenario_from_script and the recorder.
- **Hard parts:** Choosing a sensible path through an unknown app; the draft is a starting point, not a finished video.

### BL-48 — Scenario lint and selector heal loop
*M · seen in competitors · builds on: L1.2 (target resolver), L3.3; BL-49*

`studio lint` flags fragile targets (nth-child, generated class names, text in a localised project) and predictable freezes (long waits, missing wait_for). After a UI change breaks a run, a heal step proposes replacement targets from page_inspect, applied by the user or by Claude through MCP.

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

Export a self-contained page per video (chapters from scenes, transcript from captions, poster frames, embed code, previous versions) that the user publishes on their own S3, CDN or Pages. No Demo Studio server involved.

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

### BL-37 — Windows and Linux support
*L · proposed in review · builds on: L4.1, L1.6*

Officially support the engine plus `studio ui` in any browser on Linux, which already runs headless, and on Windows. A Windows shell can come later. This reverses a v1 non-goal in SPEC.

- **Value:** Customer-education and support teams often use Windows.
- **Hard parts:** Shell hooks, keychain equivalents, path handling and file locking on Windows. Windows code signing (an OV certificate, plus SmartScreen reputation).

### BL-38 — Hosted Studio UI through an engine relay
*L · proposed in review · builds on: L3.1, L4.1–L4.9, BL-39*

The same Studio web UI served from the cloud. It talks to the user's local engine, or to a self-hosted runner, through an outbound WebSocket relay that the engine dials. The browser never calls 127.0.0.1 from a public page.

- **Value:** A real cloud-app experience (sign in from any device, even a phone) while capture stays local.
- **Hard parts:** Negotiating versions between a UI and an engine that ship separately. Pairing and authentication on the relay. Latency of the live preview.

### BL-45 — Official GitHub Action and CI recipes
*S · seen in competitors · builds on: L2.6, L3.1; BL-05 optional; could fold into L3.7 packaging*

A packaged GitHub Action wrapping `studio run/render/review`, with copy-ready recipes: regenerate videos on release, commit or upload the media, comment on the PR with the contact sheet and the render diff, refresh on a cron, fail the build when a flow breaks.

- **Value:** The cheapest way to make 'videos regenerated on every release' visible; competitors use it as their main distribution channel.
- **Hard parts:** Chromium, ffmpeg and fonts on hosted runners (the BL-05 image helps); keeping big media out of the repository.

### BL-52 — Distribution in agent channels
*S · seen in competitors · builds on: L3.7 (plugin packaging); could fold into it*

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

## Guard-rails for planned lots (no new scope)

Cheap rules to apply when these lots start, so the backlog above is not blocked later.

- **L1.2** — Close R-RUN-17: redact `{{env:…}}` and keychain values from timeline, log.jsonl and run.json. Today values in open URLs are written in clear. *Why:* Runs will later be shared through review links, the library, CI artefacts and sync, and any secret left in a run file leaks.
- **L1.3** — Treat L1.3 as a decision gate and write the result down: either CPU-only capture reaches 24 fps or more with time dilation, or it doesn't and the limit is documented. *Why:* That result decides whether CI runners, self-hosted runners and hosted capture (BL-05, BL-08) are viable, and whether 4K can be sold.
- **L1.4** — Finish R-PRIN-13: add a `version` field to scenario, project.yaml, template.yaml, studio.yaml and run.json. Also record the engine version, Chromium version, OS and installed font set in run.json. *Why:* Files will meet clients of different versions through sync, CI and a hosted UI, and differences between local and CI captures must be explainable.
- **L1.6** — Reference personas by name. Resolve profile and storage-state paths from user config (~/.demo-studio) or a git-ignored project.local.yaml, never from project.yaml. Mark storage states as tied to one machine. *Why:* SPEC §4 currently puts `auth.profile: ~/.demo-studio/...` in project.yaml, so a path specific to one user would sync and break on every other machine.
- **L1.6** — Make automated login (R-AUTH-05) work headless, with credentials from secret refs (env or keychain) and no copied profile. *Why:* A CI or self-hosted runner has no signed-in profile, so login is the first thing BL-05 needs.
- **L1.8** — Keep host paths out of the sandbox manifest, so the same file runs on a laptop, a VPS or in CI. *Why:* A cloud or CI sandbox (BL-05, BL-08) can then reuse the manifest unchanged.
- **L3.1** — Engine API security contract: bind to 127.0.0.1, require a per-session token, check Host and Origin against DNS rebinding, allow exact origins only in CORS (never `*`). Keep the asset server's `*` only together with tokenised paths. *Why:* The API runs shell and SQL hooks, so any web page, or a component inside the Player, could otherwise drive it. This becomes critical with marketplace components or a hosted UI.
- **L3.1** — Version the API (`/v1`) and add a capabilities endpoint that returns the engine version and features. Use one discovery file (port, token, pid) shared by the CLI, MCP and the Tauri shell. *Why:* A UI and an engine that ship separately (hosted UI, relay, desktop shell) must negotiate what each supports.
- **L3.1** — Make job payloads serialisable (kind, project ref, relative paths plus hashes, options) and use a worker interface that pulls jobs. Run the worker in a separate process, at least in tests. *Why:* This makes ADR-1's 'remote worker later' real rather than a paper interface, and a pulling worker works behind NAT (BL-05, BL-06).
- **L3.1** — Run, render and export records store storage refs plus sha256, never absolute paths. *Why:* The remote library and cloud storage (BL-04) then plug into the existing storage abstraction.
- **L3.1** — Writes from the UI and MCP carry `if-match: <hash>`. All file writes are atomic (temp file then rename). The engine watches the workspace for outside edits. *Why:* Under ADR-2, Claude, the UI and the engine already write the same files, and sync would add another writer.
- **L3.1 / L3.6** — Use globally unique IDs (ULID, or UTC plus random) for runs, renders and comment threads; `-vN` becomes a display label only. *Why:* `newRunId` (core/src/util.ts:14) and `nextVersion` (editor/src/render/runs.ts:92) collide across machines, and comments anchor on render_id.
- **L3.1** — Parked (commercialisation). Add one entitlements function that returns 'all features' for now, and keep a count of renders (videos and stills) in the job history. *Why:* R-V2-01 notes that no licence hook point exists. A render count enables Remotion usage reporting, or the monthly report required when telemetry is blocked.
- **L3.1** — Amend ADR-1 when L3.1 starts: split 'engine runs locally' from 'UI delivery'; define the job input contract (files, sessions, secrets, network reach); replace 'data never leave the machine' with a data-flow table. *Why:* It keeps the UI delivery decision open and makes the privacy claim accurate before it is used in sales material.
- **L3.6** — Done 2026-10-12 (DESIGN-phase2 §4, R-CMT-02). Fix DESIGN-phase2 §4 and R-CMT-02 to one file per thread (R-ARC-04). Make replies append-only (one file each, or entries with their own ids). Anchor comments on step `id` or a fingerprint, not only the step index. *Why:* This avoids sync conflicts on threads, and drag-and-drop in L4.3 reorders steps, which breaks anchors based on the index.
- **L3.2 / L4.5** — Render and preview Chromium with the network blocked except the asset server. Run the Player in a cross-origin sandboxed iframe with no engine token and a strict CSP. Add `engines` / kit-API version to the component manifest. *Why:* Even a workspace component written by Claude can get past the regex scan in compile.ts. These are the foundations of BL-15, BL-16 and BL-42.
- **L3.7** — Component scaffolds and the component skill import renderer primitives through the kit module, not directly from `remotion`, wherever that is feasible. The aim is keeping the renderer replaceable, not hiding Remotion: attribution and licence terms still apply. *Why:* R-V2-08 and BL-24: a change of renderer then touches one module instead of every user component.
- **L3.1** — Keep a single list of authored, generated and machine-bound files, and use it for the `.gitignore` written by createProject. It will double as the future sync-ignore list. *Why:* Sync (BL-02) and the library (BL-04) need exactly this list, and it must never include profiles, journals or secrets.
- **L4.4** — Design the live preview stream with an input channel, even if it is unused at first. *Why:* Recording and driving a remote or headless browser from the UI (BL-25, BL-38) can then reuse it.
- **L4.1 / L4.9** — `studio ui` must work and be tested in Chrome, Safari and Firefox. The Player must be checked on WebKit. *Why:* It serves Windows and Linux users, a future hosted UI, and Tauri's WKWebView with the same code.
- **L5.2** — The Tauri shell only supervises the engine and opens the same UI. Nothing beyond OS glue lives in Rust (reinforces R-DSK-02). *Why:* It keeps parity between the browser, desktop and hosted versions of the UI.

## Recorder precisions (L3.4 / L4.8)

Founder idea 5 ("human capture": click Start, act, get a scenario — no video) is already planned as L3.4 Recorder
and L4.8 Record screen. Fold these precisions in when the lots start; what goes beyond them is BL-25 to BL-27.

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
| Before pricing / before the first sale; ideally before L3.7 and L5.2 | How is the Remotion licence handled for a commercial desktop tool whose users write components and render on their own machines and in CI? | (a) Demo Studio holds an Automators or Enterprise licence and reports customers' renders. (b) Pass-through: customers with more than 3 people buy their own Remotion Company licence, and this is disclosed at purchase. (c) Negotiated Enterprise terms ($500/month minimum). (d) Replace the renderer (BL-24). Also decide whether to stay on v4 terms for now and plan the move to 5.0. |
| Before phase 4 (it shapes Studio UI priorities), and at the latest before the first sale | Who is the first buyer? | (a) SaaS developer, devrel and docs teams: videos in code, regenerated on release, CLI + CI + MCP. (b) Product marketing and sales: a web tool with nothing to install, polish and personalisation. (c) Agencies: several brands, accepting scripts. |
| Before the first sale | What plan structure and licence model? | (a) The founder's four separate plans (Teams, Cloud, AI, Marketplace). (b) A ladder: Free, Pro per creator, Team per creator with free reviewers, Business by quote, plus usage add-ons. Free threshold: watermark, non-commercial use, or company size (Docker model). Licence: subscription checked on the server (the market standard) or perpetual. The engine's licence: closed, source-available, or open source (Cap, for example, is AGPLv3). |
| Before V2 | How do users get AI model access in the app? | (a) Bring your own key, or their Claude through MCP, only. (b) Hosted credits included in tiers. (c) Both, with credits only for AI that has a clear cost per unit (voice, dubbing, translation, review). |
| Before V2 | What does the Team offer lead with, and is sync end-to-end encrypted? | (a) Review links and approvals first, with sync later. (b) Sync first. Encryption: end-to-end like Obsidian (privacy pitch, no server-side search or previews) or encrypted at rest only (more features, processor duties). |
| Later; after the L1.3 result and the Remotion answer | How far does the Cloud plan go, and on what infrastructure? | (a) Self-hosted runner image only. (b) Plus a control plane. (c) Plus hosted CPU render. (d) Plus hosted capture for public targets and a sandbox. Infrastructure: Cloud Run (GPU requires instance billing) or VPS / bare metal. |
| Later | Which path to a marketplace, and who handles payments? | (a) First-party packs through a merchant of record. (b) Plus a free git/npm community registry. (c) Plus a commercial marketplace with payouts, either through Stripe Connect (you are the seller and file VAT) or a merchant of record that supports payouts (unverified). |
| Before L5.2 | How is the desktop app delivered for the first sale? | (a) Tauri shell (L5.2) as planned, macOS only. (b) A signed engine installer plus `studio ui` in any browser first, with Tauri after. (c) Also officially support Windows and Linux through the browser UI. |
| Before the first sale | Which video encoders ship, and with what patent position? | (a) macOS system encoders (VideoToolbox / AudioToolbox) for H.264, AAC and ProRes. (b) Bundled GPL ffmpeg with x264 and AAC, plus a written position from Via LA. Also decide whether to drop libx265 and ffmpeg's ProRes encoder. |

## Suggestions on the locked MVP (founder decides)

Recorded for the founder; nothing here changes the roadmap until they decide.

- Parked (commercialisation); see the active Remotion note above. Take the Remotion licence question out of L6 now. It is an email with no code, but get the written answer before building L3.7 (component skill) and L5.2 (distribution). *Why:* The answer decides whether user-written components, renders on customers' machines, hosted render and the marketplace are allowed and what they cost. Building them first risks rework or a blocked sale.
- Parked (commercialisation). Name the first buyer now, and use it to judge the rest of phases 3–5. The recommendation is SaaS developer, devrel and docs teams who want videos in code, regenerated on every release. *Why:* The product as specified is a developer tool. Without an explicit buyer, UI work (L4.x) and polish lots compete with features that first buyer doesn't need.
- Consider moving L5.3 (iOS Simulator runner, size L) to the backlog. *Why:* First buyers are web SaaS companies. The runner needs Xcode and a Mac, and it can't run in CI or the cloud cheaply (EC2 Mac hosts bill at least 24 hours).
- Consider slimming L2.11–L2.13: keep clips per scene plus a CSV/JSON markers file, and defer FCPXML, EDL, OTIO, ProRes, split screen, picture-in-picture and Lottie. *Why:* They add a lot of scope for a minority use. ProRes via ffmpeg raises a licensing question, and @remotion/lottie falls under Remotion's licence.
- Consider cutting L4.7 back to a read-only component library, and leave theme editing to L3.5 plus Claude through MCP. *Why:* Theme creation from brand inputs and from a site URL is already scoped, and Claude covers the editing.
- First-sale part parked. Re-size L5.2 to L, or ship the first sale as a signed engine installer plus `studio ui` in the browser, with the Tauri shell after. *Why:* Notarising bundled sidecars, the updater key and testing on WebKit make M look optimistic, and the browser UI already works for every user.
- Size the recorder (L3.4 and L4.8) more generously, and keep it early in phase 3/4. *Why:* It is the way non-developers will start, and its value lies entirely in the cleanup work listed in recorder_precisions.
- Parked (commercialisation). Don't advertise 4K until L1.3 and L1.5 have measured it on a Mac. *Why:* HANDOFF measures 9.5–16 fps for the screencast at 4K, against 44–58 fps at 1080p, and 2–3 fps under backdrop blur.
- Parked (commercialisation). Add a 'first sale' checklist next to L6: licence and billing (BL-39), compliance pack (BL-41), signed installer (BL-36), and a first video on the buyer's own app in under 15 minutes. *Why:* None of these are in the locked MVP, yet V2 cannot sell without them, and the external steps (lawyer, Remotion, Apple) take calendar time.
- Decided 2026-10-12: voice-over is an evolution (backlog). From the competitive study: decide explicitly about voice. Either cover the minimum inside the locked lots (a narration track from a file, BL-46, next to L2.12, and SRT/VTT export, BL-30, next to L2.13), or state "videos without a voice" in the positioning and keep TTS (BL-12) for later. *Why:* Almost every close competitor narrates; a silent track (R-ED-18) is fine for motion-design marketing videos but disqualifying for tutorials.
- Agent-channel listings parked; the GitHub Action stays a candidate for our own CI. From the competitive study: fold the GitHub Action (BL-45) and the agent-channel listings (BL-52) into L3.7 packaging. *Why:* Both are small, and they are how the open-source rivals are found.
- Parked (commercialisation). From the competitive study: consider a first public release (CLI + MCP) at the end of phase 3, before the nine Studio lots, and decide the open-core question then. *Why:* It tests the market early; free MIT engines set the developer price at zero, so what is sold must sit above the engine (Studio, packs, team features).
- From the competitive study: do not trim L1.6 (personas) or L1.8 (sandbox). *Why:* Reproducible data preparation with rollback and a sandbox is the one capability no checked competitor has.
