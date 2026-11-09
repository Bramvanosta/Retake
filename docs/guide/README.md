# Retake guide

The full reference for using Retake. The [README](../../README.md) is the short version: what Retake is, how to
install it, a first video and where to go next.

| Page | What it covers |
|---|---|
| [Install and requirements](install.md) | what a machine needs, and where Retake finds ffmpeg, Chromium and Node.js |
| [Workspaces and projects](workspace.md) | your workspace folder, a project's files, what a run writes, file format versions |
| [Command-line reference](cli.md) | every `retake` command and flag |
| [Scenarios](scenarios.md) | the scenario language, several pages at once, mails and documents, recording a scenario |
| [Themes, components and media](themes-and-components.md) | themes (from your brand or a site), components and the kit, your own media and motion |
| [Editing, rendering and export](editing.md) | the edit plan, tutorial overlays, rendering, variants and 4K, the raw export for editors |
| [Review and frame comments](review.md) | contact sheets, checks and reports; comments on frames |
| [Sign-ins and environments](environments.md) | personas and their sessions, display URLs, production and read-only, the clock |
| [Sandboxes](sandbox.md) | a disposable copy of your product, seeded and reset before every take |
| [Claude and MCP](mcp.md) | the MCP server, the Claude skills and the Claude Code plugin |
| [The Studio](studio.md) | the Studio web app, screen by screen |
| [The desktop app (macOS)](desktop-app.md) | installing Retake.app, its updates, the desktop shell |
| [Security model](security.md) | what Retake protects, and how |
| [Development](development.md) | the repository's layout, the test suites, the phase status |
| [Upgrading from before L5.13](upgrading.md) | moving an installation from the tool's earlier name |
| [Glossary](../GLOSSARY.md) | one word per concept, the Studio's labels for them, and the words with several meanings |

Also in `docs/`: [RELEASING.md](../RELEASING.md) (how a release is built and published),
[BRING-YOUR-OWN-MOTION.md](../BRING-YOUR-OWN-MOTION.md) (your own intro, outro and overlays),
[ARCHITECTURE.md](../ARCHITECTURE.md), [SPEC.md](../SPEC.md), [DESIGN.md](../DESIGN.md) and
[DESIGN-phase2.md](../DESIGN-phase2.md) (the contracts), [reference/studio-ui.md](../reference/studio-ui.md) (the
Studio's design system) and [MACOS-CHECKLIST.md](../MACOS-CHECKLIST.md) (the checks run by hand on a Mac).

## Every section

These sections were the README's until November 2026: a note that says *README "Sandbox mode"* or *README ›
Environments* means the section of that name below.

### [Install and requirements](install.md)

- [Requirements](install.md#requirements)

### [Workspaces and projects](workspace.md)

- [Your own workspace](workspace.md#your-own-workspace)
- [Project layout](workspace.md#project-layout)
- [Outputs of a run](workspace.md#outputs-of-a-run)
- [File formats and versions](workspace.md#file-formats-and-versions)

### [Command-line reference](cli.md)

- [Command line](cli.md#command-line)

### [Scenarios](scenarios.md)

- [Scenario language](scenarios.md#scenario-language)
  - [Actions](scenarios.md#actions)
  - [When a take goes wrong](scenarios.md#when-a-take-goes-wrong)
  - [Components in scenarios](scenarios.md#components-in-scenarios)
  - [Targets](scenarios.md#targets)
  - [Templating and hooks](scenarios.md#templating-and-hooks)
- [Several pages at once](scenarios.md#several-pages-at-once)
- [Mails, documents and notifications](scenarios.md#mails-documents-and-notifications)
- [Recording a scenario](scenarios.md#recording-a-scenario)

### [Themes, components and media](themes-and-components.md)

- [Themes](themes-and-components.md#themes)
  - [Themes from your brand](themes-and-components.md#themes-from-your-brand)
  - [Themes from a site](themes-and-components.md#themes-from-a-site)
- [Components](themes-and-components.md#components)
  - [component.yaml](themes-and-components.md#componentyaml)
  - [Implementation](themes-and-components.md#implementation)
  - [The kit (`@retake/components/kit`)](themes-and-components.md#the-kit-retakecomponentskit)
  - [Creating, checking and previewing components](themes-and-components.md#creating-checking-and-previewing-components)
- [Your own media and motion](themes-and-components.md#your-own-media-and-motion)

### [Editing, rendering and export](editing.md)

- [Editing: the edit plan](editing.md#editing-the-edit-plan)
- [Tutorial overlays and story cards](editing.md#tutorial-overlays-and-story-cards)
- [Rendering](editing.md#rendering)
- [Variants, 4K, music and export](editing.md#variants-4k-music-and-export)
  - [Music bed](editing.md#music-bed)
  - [Export](editing.md#export)
- [Raw export for editors](editing.md#raw-export-for-editors)

### [Review and frame comments](review.md)

- [Reviewing a render](review.md#reviewing-a-render)
- [Frame comments](review.md#frame-comments)

### [Sign-ins and environments](environments.md)

- [Signing in: personas and sessions](environments.md#signing-in-personas-and-sessions)
- [Environments: display URLs, production, read-only, clock](environments.md#environments-display-urls-production-read-only-clock)

### [Sandboxes](sandbox.md)

- [Sandbox mode](sandbox.md#sandbox-mode)
  - [Starting, resetting and filming a sandbox](sandbox.md#starting-resetting-and-filming-a-sandbox)
  - [`retake sandbox init`](sandbox.md#retake-sandbox-init)
  - [Snapshot reset (Postgres)](sandbox.md#snapshot-reset-postgres)
  - [The fixture's Docker sandbox (Mailpit)](sandbox.md#the-fixtures-docker-sandbox-mailpit)
  - [Recipes](sandbox.md#recipes)
  - [A "stage" sandbox: images of a production build](sandbox.md#a-stage-sandbox-images-of-a-production-build)
  - [Limits](sandbox.md#limits)

### [Claude and MCP](mcp.md)

- [MCP: Claude drives Retake](mcp.md#mcp-claude-drives-retake)
  - [Claude skills and the plugin](mcp.md#claude-skills-and-the-plugin)

### [The Studio](studio.md)

- [Studio app](studio.md#studio-app)

### [The desktop app (macOS)](desktop-app.md)

- [Install the app (macOS)](desktop-app.md#install-the-app-macos)
  - [Releasing an update](desktop-app.md#releasing-an-update)
- [Desktop app (macOS)](desktop-app.md#desktop-app-macos)

### [Security model](security.md)

- [Security](security.md#security)

### [Development](development.md)

- [Repository layout](development.md#repository-layout)
- [Phase status](development.md#phase-status)

### [Upgrading from before L5.13](upgrading.md)

- [Two builds on one workspace](upgrading.md#two-builds-on-one-workspace-the-studios-token-in-the-retake-home)
