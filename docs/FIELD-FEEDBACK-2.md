# Field feedback 2 — setting up a real project through MCP (2026-11-10)

The second use of Retake on a real product, outside the fixture: a project created from Claude Code through MCP on
v0.2.0 — its README, two brand themes (one from the product's own repository, one from an existing design-token
export), three environments (local, a staging one and production marked read-only) and a docker-compose sandbox. The
product is a web app with several roles on the same pages, signed in with Firebase Auth, kept in a monorepo whose
Docker files cover its infrastructure only (database, cache, object storage, mailbox). Claude wrote down each point
as it met it: what was missing, the workaround used, a proposal. This file is the generic triage of those notes (no
client, product, font or address) and where each point went. The numbers are the notes' own: requirements cite them
("docs/FIELD-FEEDBACK-2.md point N").

**Decisions.** Points 2 and 10 – 26 were fixed as they came, in the hotfixes v0.2.1 – v0.2.6 (2026-11-10 –
2026-11-11; CHANGELOG.md, and the hotfix notes in `docs/archive/HANDOFF-history.md`). On 2026-11-15 the person opened
the lots **L8.1, L8.1b, L8.2 and L8.2b** for the rest (themes, fonts, sandboxes, environments, painted pages); L8.3
(the app's native menus, BACKLOG BL-166) runs in the same chain but does not come from this feedback.

## The points

| # | What the field showed (and the proposal) | Where it went |
|---|---|---|
| 1 | No way to add, change or remove an environment after `project_create`: the agent edited project.yaml by hand. Proposal: MCP tools and a `retake env` command; marking an environment production or read-only is allowed, lowering it stays a person's. | **L8.2b** |
| 2 | `project_create` took page URLs only: no `{url, display}` form, no `default_env`. | hotfix **v0.2.2** |
| 3 | A brand with a wordmark only (no pictogram) was drawn twice (logo + name) in the intro, the outro and the brand mark, and the outro sized the wide logo by its height (it filled the frame). Proposal: a logo kind (mark / wordmark, or detected from a wide shape), sized by its width; the brand name kept for alt text. | **L8.1** |
| 4 | `template_create_from_brand` set no component params (an outro's logo size) and a change of one input meant passing every input again. Proposal: component params in the brand input, and a partial update of a theme the tool made. | **L8.1** |
| 5 | Four body font files at most: a family used at five weights lost one. Proposal: a higher limit, or a variable font serving a weight range. | **L8.1** |
| 6 | No source for an open-licence web font: the agent may not download fonts, so the person had to ask, then a package was unpacked by hand. Proposal: a font reference resolved from a pinned package (licence checked, latin subset), behind an approval. | **L8.1b** |
| 7 | An existing design-token file (colours, families) was mapped to the theme's roles by hand. Proposal: a tool that reads a token file (a list format and DTCG), proposes the roles and lets the person confirm. | **L8.1b** |
| 8 | Two dark brands over the `editorial` base got a warning pointing to another base (which changes the tone), and the dark cursor risked vanishing on a dark app. Proposal: the cursor (and what depends on the tone) chosen from the palette's tone. | **L8.1** |
| 9 | Nothing in MCP creates a sandbox (`retake sandbox init` in a terminal only), and neither provider fitted a monorepo with Docker files for its infrastructure only. Proposal: an MCP `sandbox_init`, a documented hybrid recipe, a line on an external auth service (an emulator in the compose). | **L8.2** |
| 10 | The skills stopped when the session's folder was not the workspace (a second folder added to the session); the README's environment section went stale after environments changed. | hotfix **v0.2.2** |
| 11 | A docker-compose sandbox failed from the app and MCP with OrbStack (`unsupported argv0`); the CLI worked. | hotfix **v0.2.1** |
| 12 | Compose files kept in the product's repository broke: their relative paths resolved from the sandbox folder. | hotfix **v0.2.1** |
| 13 | Every command started with a line about the home of the name before the rename. Decision: say nothing about it any more. | hotfix **v0.2.1** |
| 14 | Demo passwords already in the sandbox's compose env file had to be copied into the keychain. Proposal: `{{compose_env:NAME}}`. | hotfix **v0.2.1** |
| 15 | A page could belong to one account only, though two roles use the same app. | hotfix **v0.2.1** (documented), **v0.2.2** (several accounts per page, `persona:`) |
| 16 | `retake sandbox up --build` printed nothing for minutes. | hotfix **v0.2.2** |
| 17 | `select` in a long list with a search field: the `search` option was undocumented and the error gave no hint. | hotfix **v0.2.2** |
| 18 | A Firebase Auth app's persona never stayed signed in (the sign-in browser closed before the app stored its session). | hotfix **v0.2.2** |
| 19 | A sandbox's hooks could not use its own accounts (passwords copied to the keychain again; no request sent as a persona). | hotfix **v0.2.3** |
| 20 | The MCP server kept running the old engine after an app update. | hotfix **v0.2.5** |
| 21 | A sandbox reset put back Postgres only: an auth emulator kept the last take's account. | hotfix **v0.2.5** (`reset.hooks`, `reset.firebase_auth`) |
| 22 | A call-to-action button's label vanished with a dark accent on a dark page. | hotfix **v0.2.5** |
| 23 | An https address in a call to action's `qr` / `url` was refused as a remote file. | hotfix **v0.2.5** |
| 24 | A list's search was typed letter by letter on camera. | hotfix **v0.2.5** (`search_instant`, `search_cps`) |
| 25 | No way to fill a field at once, as an autofill. | hotfix **v0.2.6** (`type: {…, fill: true}`) |
| 26 | `project_get` reported well-written README environment lines as gone. | hotfix **v0.2.6** |
| 27 | A grey loading skeleton was filmed for half a second after a click that changed the page client-side (the app's header had text, so the page counted as painted), and the review said nothing. Proposal: judge the main region, wait after a client-side route change. | **L8.2b** |
| 28 | After sandbox.yaml changed, a reset ran the seed on the dirty database and froze the take's data into the new snapshot. Proposal: start again from a clean base, or refuse and say so in `sandbox_status`. | **L8.2** |
| 29 | `reset.firebase_auth` put the accounts back and invalidated the personas' saved sessions (an `auth: {persona}` hook got 401). Proposal: sign the personas in again, or say so in the reset's result. | **L8.2** |
| 32 | A project could not be shared on its own: its themes, components and brand files lived at the workspace level, its sandbox's compose file lay outside the workspace, and its run and render records held absolute paths, so a copied folder no longer rendered and nothing exported a project. Proposal: a self-contained project (themes, components and brand files of the project resolved before the workspace's, a migration command), a ZIP export and import (the sandbox's images optional, secrets never by default), and project-relative paths in records. | **L9.1 – L9.5** |
