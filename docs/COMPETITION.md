# Competition — study of 2026-10-12

**Method.**
1. Four search angles: scripted or automated video, interactive demos and guides, AI demo generators, open-source and developer tools. They found 104 products and projects.
2. Eleven of them were profiled in depth from primary sources (sites, docs, repositories).
3. A comparison against this tool.
4. A fact-check of 45 claims: 21 confirmed, 13 partly wrong, 2 wrong, 9 unverifiable. Most of the unverifiable ones are SaaS sites the sandbox could not reach.

The corrections are applied below, and anything still unverified is marked *(unverified)*. Third-party products are named here for market analysis only. The product itself stays generic.

## Short answer

**Yes, competition exists, and most of it appeared in 2026.**

The core idea already exists several times:
- a versioned script drives a browser with an animated cursor;
- an automatic edit (zooms, idle cuts);
- regeneration in CI;
- an agent driving it through MCP.

Most of these are free open-source projects, each kept up by one person: 0 to 96 GitHub stars, and none has won. Next to them are one commercial hybrid (ScreenCI) and several AI-first SaaS products.

Two platforms are turning that layer into a commodity:
- **Playwright:** 1.59 added the Screencast API with annotations, chapters and HTML overlays; 1.64 added an eased cursor.
- **HeyGen's HyperFrames:** Apache-2.0, about 61k stars, agent-first video rendering, with a product-launch-video skill that starts from a URL.

What is still open is the high end: motion-design-quality product videos of **real, signed-in flows with prepared data**, reproducible on every release. That is where this tool's differentiators sit.

## Closest competitors

| Product | What it is | Delivery and price | Overlap | Where it differs |
|---|---|---|---|---|
| **ScreenCI** | Commercial. Playwright scripts are the videos ("a video is an E2E test") | MIT CLI. Hosted rendering, web editor and public URLs are paid. A free trial gives 3 watermarked recordings; paid tiers are unverified | Scripted, regenerated in CI, multi-language narration, SSO, named login profiles | Uses Playwright's `page.screencast` on the wall clock. Cursor and camera are composited in the hosted render, not drawn in the page. Rendering is cloud-only. No data hooks with rollback, no NLE export. Scenario changes go through an agent prompt; the editor covers narration and overlays only. One developer, 751 commits in 6 months. A branch is preparing a hosted runner and MCP *(unverified)* |
| **aidemo** | Open-source (MIT) CLI with MCP, GitHub Action and Claude Code plugin | Free. Listed on npm, Homebrew, the MCP Registry and the plugin marketplace. Hosted MCP and web UI are on its roadmap | Agent-authored demos regenerated in CI. Local or cloud TTS, multi-language, GIF, walkthrough export, Playwright trace import | Edits with ffmpeg; no component system, no data hooks, no UI yet. About 13 minor versions in 12 weeks; 14 stars |
| **demo-machine** | Open-source (MIT) "demo as code": YAML spec plus MCP | Free | Review bundle for agents, visual diff and golden frames, heal-spec, optional Remotion renderer | Inactive since 2026-07-17 |
| **openvidstudio** | Open-source (Apache-2.0) MCP pipeline on Remotion and Playwright | Free | Contact sheets, per-beat visual regression against the last accepted render, docs drift, release diff, iOS/Android capture, brand extraction | No single scenario file. Each beat stores replayable interactions, and the agent assembles the video. 24 stars |
| **playwright-recast** | Open-source (MIT): Playwright traces become polished videos | Free. TTS providers are paid separately | CLI, MCP, a suite reporter, TTS including local voice cloning (CUDA) | Aimed at teams that already have Playwright tests; edits with ffmpeg. 64 stars, fast release pace |
| **Testreel** | Open-source (MIT): Playwright with JSON step files | Free | Animated cursor, click ripples | Recording library, not a studio. 96 stars |
| **programatic-demo** | Open-source (MIT) template for Playwright and Remotion | Free | Click log with bounding boxes drives a Remotion camera; accessible-name selector ladder; 4K stills | A template, not a product. 4 stars |
| **scriptreel** | Open-source (MIT): YAML script to video | Free | "Write the demo once, get a video on every UI change"; virtual clock; presets from 9:16 to 4K | Launched 2026-10-05; no voice, AI or hooks |
| **Clueso** | AI-first SaaS for non-developers (YC W23) *(unverified)* | Web app, extension, browser agents, hosted MCP. Free tier with 10 minutes; Solo about $40/month on an annual plan *(unverified)* | Video, help article and dubbing from one recording; claims automatic regeneration from GitHub *(unverified)* | Recording by AI or by hand, not deterministic. Everything runs in the cloud |
| **Velo**, **Slideshot**, **Videate** | AI video agents, a pay-per-recording MCP/API (Slideshot, about $0.90 per recording), auto-updating tutorials | Cloud *(all unverified)* | Narration, regeneration, API | Cloud only; tutorials and one-off demos rather than reproducible flows |
| **Arcade** (also Supademo, Storylane, Navattic) | Interactive demos and AI video | Web app and extension; Arcade lists an MCP server *(unverified)* | Hold the go-to-market budgets | Capture by hand; no automatic update |
| **Maestro** (`maestro record`) | E2E framework for mobile flows written in YAML | Apache-2.0; rendering is remote by default | Renders a video of a scripted flow on iOS/Android ("great for demos") | The real rival to the planned iOS runner (L5.3) |

Seen in the sweep but not profiled in depth:
- webreel (Vercel Labs, Apache-2.0);
- DemoTape, supercut, screencaster, demowright, demo-maker, shot-scraper video, HumanJS, demosmith-mcp, Spool, screencli, LooK, codevid;
- PageBolt, Demosmith, InstaDemo, Storyship, Trupeer, Trainn, Vorec, Amorphic Labs (personalised sales videos, YC).

## What only this tool does (after the fact-check)

- **Reproducible data preparation:** http/sql/shell/js hooks with a rollback journal, plus a docker-compose sandbox with seed and reset (L1.8). No checked tool has this. Personas alone are not unique: ScreenCI has named login profiles, and aidemo takes storage state.
- **Flows that leave the browser**, rendered as components: the invitation e-mail, the PDF quote, downloads, web notifications, the lock screen.
- **A plugin library of themeable components**, with themes that pick components. Some rivals use Remotion scenes (openvidstudio, programatic-demo) or a themed overlay kit (ScreenCI), but none has a component contract and a library.
- **Raw capture export for professional editors** (FCPXML/EDL/OTIO markers, clips per scene; L2.13). None found.
- **A Studio where blocks and YAML stay in sync both ways** (phase 4). ScreenCI's editor covers narration and overlays, not the scenario.

**Not unique**, despite first impressions:
- A review loop that an AI can read: openvidstudio, demo-machine and aidemo cover parts of it.
- Local rendering: every open-source rival renders locally.
- A synchronised cursor: a quality entry ticket, now built into Playwright 1.64.
- Using Remotion.

## Gaps buyers will notice

- **Voice-over and narration:** almost every close rival has it; the MVP has a silent track (R-ED-18). See BL-46 and BL-12.
- **Multi-language and SRT/VTT:** see BL-34 and BL-30. Re-capturing the real localised UI would set this tool apart: rivals translate the narration but film the original UI.
- **Ready-made CI:** a packaged GitHub Action (BL-45).
- **Authoring shortcuts:** import from existing tests (BL-27), a draft from a URL (BL-47), lint and selector healing (BL-48).
- **Visual masking** of sensitive data (BL-43).
- **Documentation outputs:** GIFs, stills, step guides (BL-31, BL-35).
- **Sharing:** share pages (BL-50, BL-01).
- **Distribution where agent users look:** MCP Registry, Claude Code plugin marketplace, Homebrew (BL-52).
- **Windows** (BL-37). Clickable interactive demos (BL-32) are outside the scope; say so plainly.

## Threats

- **Free engines.** A dozen free MIT tools, plus a pay-per-recording API at about $0.90 per video *(unverified)*, put developers' willingness to pay for "agent → regenerated video in CI" near zero. What is sold must sit clearly above the engine.
- **ScreenCI** already sells the complete loop to the same buyer, and it moves fast.
- **AI-first SaaS** (Clueso and others) hold non-technical buyers and are already inside Claude, ChatGPT and Cursor.
- **Platforms:** Playwright keeps adding video features. HyperFrames brings company-backed, agent-first rendering. Remotion promotes capture templates of its own.
- **DIY with a general-purpose agent:** Claude plus Playwright MCP plus Remotion skills can improvise a demo in one session. The product has to beat that clearly.
- **Remotion licence:** see the open decision in `docs/BACKLOG.md`. Customers might need their own Remotion licence.
- **Mobile:** Maestro already owns scripted mobile flows rendered as video.

## Positioning recommended by the study

"The studio for reproducible product videos of real SaaS flows":
- launch and feature videos of motion-design quality;
- filmed on signed-in flows with seeded data;
- including e-mail, PDF and mobile;
- kept current on every release.

It is not a narrated-tutorial tool or a URL-to-video generator; leave those to the AI-first SaaS products.

**First buyer:** product marketing or devrel at a B2B SaaS company of 20–200 people that ships every one or two weeks, has a staging environment or a docker-compose stack, and a developer willing to keep YAML files. **Secondary buyer:** agencies making product videos for several SaaS clients (one theme per client, NLE export).

**Model to decide early:** open core (free engine, CLI and MCP, distributed in agent channels) with the Studio, premium packs and team features sold. This is recorded as an open decision in `docs/BACKLOG.md`.

## Impact on the locked MVP

No competitor makes the MVP obsolete, and its real differentiators are already in scope: hooks with rollback, mails, PDF and notifications, components, raw export, and the two-way Studio. Do not trim personas (L1.6) or the sandbox (L1.8).

The founder decides on the suggestions listed in `docs/BACKLOG.md`:
- voice;
- the GitHub Action and agent channels in L3.7;
- the Remotion question now;
- a first public release (CLI + MCP) at the end of phase 3.
