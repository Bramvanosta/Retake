# Northfield — fixture product

A local stand-in for a real SaaS product so Demo Studio can be tested end to end without any
staging access. *Northfield* is a fictional B2B specialty-coffee wholesale platform: roasters sell
coffee lots to cafés. Everything in it is fictional: companies, people, cafés, competitions, the lot registry and
every farm, washing station and producer name (invented on purpose — never borrow a real lot or producer).
Countries and growing regions are real geography only.

One Node process (`node:http`, no framework) serves two React 19 SPAs bundled with esbuild and one
shared in-memory store:

| App | Default URL | Who |
| --- | --- | --- |
| Supplier console | http://localhost:4401 | Maja Lindqvist, supply manager at Northfield Roasters |
| Buyer shop | http://localhost:4402 | Demo Café, Stockholm (Sweden) |

```sh
node server.mjs                       # builds public/build/ if missing or stale, then serves
node server.mjs --console-port 5501 --shop-port 5502 [--host 127.0.0.1] [--no-build]
node server.mjs --auth-console-port 5503 --auth-shop-port 5504   # move the signed-in side (below); --no-auth: none
node server.mjs --smtp localhost:1025 # also deliver every mail to an SMTP server (a Mailpit: below)
node build.mjs [--dev]                # build only
node scripts/smoke.mjs [--out DIR]    # end-to-end check with real mouse input + screenshots
```

Environment: `NORTHFIELD_CONSOLE_PORT`, `NORTHFIELD_SHOP_PORT`, `NORTHFIELD_AUTH_CONSOLE_PORT`, `NORTHFIELD_AUTH_SHOP_PORT`, `NORTHFIELD_HOST`, `NORTHFIELD_SMTP`,
`NORTHFIELD_ENRICH_MS` (default 4000), `NORTHFIELD_IMPORT_MS` (default 2000), `NORTHFIELD_REPORT_MS` (default 400) and
`NORTHFIELD_REPORT_DATA_MS` (default 1200: the Sales reports, below), `NORTHFIELD_QUOTES_MS` (default 0: the console's Quote requests
page loads its list after it — its polling within 5 s is not slowed — and shows skeleton rows that long; option
`quotesMs`). The server prints its
URLs and exits cleanly on SIGTERM/SIGINT. It listens on 127.0.0.1 and ::1 by default so `localhost`
works whichever address a client resolves first. Programmatic use:
`const fx = await startFixture({ consolePort: 0, shopPort: 0 }); … await fx.close();` (add
`auth: { consolePort: 0, shopPort: 0 }` for the signed-in side: `fx.urls.signedIn`, `fx.expireSessions(persona?)`;
`smtp: 'host:port'` for the SMTP relay). The server needs no npm package at run time: `bundle.mjs` says where the bundle
is and whether it is fresh, esbuild is loaded only when a build runs (`--no-build`: never), playwright-core only when
a PDF is printed — so the Docker image below runs it on Node alone.

## Signed-in side (sessions & personas, Demo Studio L1.6)

The same process also serves both apps behind a sign-in — same store, same API, same mailbox:

| App | Default URL | Account (invented) | Password | Cookie |
| --- | --- | --- | --- | --- |
| Supplier console | http://localhost:4403 | `maja@northfield.example` (Maja Lindqvist) | `roast-lot-2026` | no expiry: lost when the browser closes |
| Buyer shop | http://localhost:4404 | `orders@demo-cafe.example` (Demo Café) | `filter-bloom-2026` | 7 days |

- Every page there needs a session of its app — the console account does not open the shop and the other way round
  — else it answers `302 /sign-in?next=<path>`; the API, the mailbox, the bundle and the icons stay open (hooks keep
  working). `/sign-in` is a server-rendered form (labelled **Email** and **Password**, a **Sign in** button) that
  comes back to `next`; `/sign-out` ends the session.
- Both apps use one cookie name (`northfield_session`) on one host: a browser holds one account at a time, so a scene
  that films the supplier and the buyer side by side needs two browsers — what Demo Studio's personas give.
- Sessions live in memory: a restart signs everyone out. `POST /api/auth/expire` (`{persona: supplier | buyer}`, or no
  body for every session) ends them on purpose, e.g. `curl -X POST localhost:4403/api/auth/expire` — tests and demos of
  an expired session. `POST /api/reset` restores the data but never touches sessions.
- A busy port only skips the signed-in side (the open side keeps running); `--no-auth` never starts it.

The fixture project's environment `signed-in` points at these ports with personas `supplier` and `buyer`; their
automated login reads the passwords from `NORTHFIELD_SUPPLIER_PASSWORD` and `NORTHFIELD_BUYER_PASSWORD`:

```sh
export NORTHFIELD_SUPPLIER_PASSWORD=roast-lot-2026 NORTHFIELD_BUYER_PASSWORD=filter-bloom-2026
node packages/cli/dist/bin.js run northfield-fixture live-quote --env signed-in
```

## As a Demo Studio sandbox (L1.8)

The fixture project's environment `sandbox` (`projects/northfield-fixture/sandbox/sandbox.yaml`, provider `process`)
is this server started by Demo Studio itself — `node server.mjs --console-port 4501 --shop-port 4502
--auth-console-port 4503 --auth-shop-port 4504`, with Demo Studio's own Node — seeded and reset before every take with
`POST /api/reset`, its signed-in side filmed with the accounts above (written in the manifest: they are invented):

```sh
node packages/cli/dist/bin.js run northfield-fixture sandbox-quote --sandbox   # starts it if needed, resets, films
node packages/cli/dist/bin.js sandbox status northfield-fixture                # … logs, reset, down
```

It stops on SIGTERM (closing the PDF browser it may have launched); its output goes to
`projects/northfield-fixture/.demo-studio/sandbox/sandbox/logs/fixture.log`.

**In Docker, with a real Mailpit** — environment `sandbox-docker` (`projects/northfield-fixture/sandbox/docker/`,
provider docker-compose): this server in a container built from `Dockerfile` (`node:22-alpine`, no `npm install`:
the server files and the UI bundle built on the host — `.dockerignore` keeps only those; a missing bundle stops the
build with the command to run), on ports 4511–4514 (the same inside the container: its own links stay right), and
`axllent/mailpit:v1.29.4` on 4525, which receives the fixture's mails through the SMTP relay below. Same seed and
accounts as `sandbox`. The image has **no Chromium**: the real quote PDF (`/quotes/<id>/quote.pdf`) answers 500 there
("The PDF could not be printed"); `sandbox-quote` and `signup` do not need it.

```sh
node fixtures/wholesale/build.mjs                                                # the bundle the image copies
node packages/cli/dist/bin.js sandbox up northfield-fixture --env sandbox-docker  # builds the image the first time
node packages/cli/dist/bin.js run northfield-fixture signup --env sandbox-docker --sandbox
node packages/cli/dist/bin.js sandbox down northfield-fixture --env sandbox-docker
```

The image alone: `docker build -t demo-studio-northfield-fixture fixtures/wholesale`, then `docker run --rm -p
127.0.0.1:4401:4401 -p 127.0.0.1:4402:4402 demo-studio-northfield-fixture` (the open side; `NORTHFIELD_*` variables
move the ports, `NORTHFIELD_SMTP` relays the mails). Remove it with `docker image rm` when done.

## Why real Radix UI *and* Base UI

The runner's click strategies exist for the quirks of these libraries, so the fixture mixes them the
way real products do:

| Where | Component | Quirk |
| --- | --- | --- |
| All dialogs | Radix Dialog / AlertDialog | Escape closes the whole dialog; focus trap; outside pointer events disabled |
| New import → Organisation, quote dialog selects | Radix Select | opens on **pointerdown** |
| Catalogue row actions, account menus | Radix DropdownMenu | opens on **pointerdown** |
| Availability row actions | Base UI Menu | opens on press, items fire on click; modal backdrop |
| Edit availability → Bag sizes, Label languages | Base UI Popover (role=dialog) | opens on **click**; portaled into the Radix dialog and **kept mounted** while hidden, so several popovers coexist in the DOM; Escape inside closes the whole Radix dialog |
| Edit availability → Grind options | Radix Popover | Escape closes only the popover |
| Request a quote → Delivery window | Base UI Popover calendar | month navigation; closes 0.4 s after the 2nd date |
| Request a quote → Number of bags | Base UI NumberField | stepper buttons "Increase" / "Decrease" |
| Notifications bell | Radix Popover | opens on click |
| Toasts | Base UI Toast | |

## Screens

Console: `/imports` (New import dialog: organisation select, drag & drop zone with a hidden
`<input type=file>`, progress, "921 offers created"), `/products` (catalogue, "Add a coffee" registry
search → `/products/<slug>` with ~4 s "Enrichment in progress" then a staggered reveal down to
**Awards**), `/availability/products/<slug>` (delivery-window overview + table by market, row menu
Edit / Pause / Archive), `/quotes` (quote requests, "Send proposal"), `/proforma` (**Pro forma invoices**, Demo Studio L5.6 — capture
reliability: a "Quantity (kg)" filter above the table; "New pro forma" opens a modal dialog whose body scrolls (its
"Quantity (kg)" field below the fold) and whose "Delivery date" opens a calendar that keeps the focus in the field and
covers the fields under it until a click outside; "Preview" is wired to nothing; "Download PDF" opens
`/proforma/<ref>.pdf?flaky=1` in a new tab — the second transfer of each PDF since the reset breaks after half its
bytes; "Send to customer" mails `accounts@demo-cafe.example` and a copy to `maja@northfield.example`, one subject;
`GET /api/proforma`, `POST /api/proforma/draft`, `POST /api/proforma`), **Sales reports** (`/reports`, a plain link in
the sidebar: classic server-rendered pages outside the app, so every move between them and the app is a full page load
— R-ISS-08; `/reports` lists October and September 2026 and links "Back to the console" → `/products`, the app's empty
shell first; `/reports/<yyyy-mm>` answers after `NORTHFIELD_REPORT_MS` and paints only an animated skeleton — no text —
while its script fetches `/reports/<yyyy-mm>/data`, answered after `NORTHFIELD_REPORT_DATA_MS`, then shows the month's
"Total sales" and sales by market; figures in `server/reports.mjs`). While open, the console polls the quote list and
shows a **web notification** (Notification API, tag `quote-request`, icon `/app-icon.svg`) for every new quote request
(it asks for the permission once; Demo Studio's runner grants it).

Shop: `/` (highlight rows), `/coffees`, `/products/<slug>` ("Request a quote"), `/quotes`,
`/quotes/<id>` (proposal, "Download quote PDF" → `/quotes/<id>/quote.pdf` in a new tab: a **real PDF**, printed by
Chromium's `page.pdf` (playwright-core, launched on the first request and kept) from the quote document, cached per
quote state; the older HTML viewer page stays at `/quotes/<id>/pdf`), `/signup` (open a café account: café name, your
name, work email → "Check your inbox"; the server sends a **confirmation email** to the fixture mailbox),
`/signup/confirm?token=…` (the email's link; `token=latest` confirms the most recent sign-up — a convenience for
scenarios). While a shop page is open, its quote list and its notifications bell poll every second: a proposal the
console sends shows on the bell (unread badge, the bell rings) about a second later.

At the bottom of every product page, **Before you order** holds two widgets the runner must reach inside (R-ISS-07):
a **Brew guide** — `<nf-brew-guide>`, a vanilla custom element with an *open* shadow root and its own stylesheet
(method Filter / Espresso, "Less coffee" / "More coffee" stepper, recipe line such as "20 g coffee · 40 g out · 28 s",
"Copy recipe" → "Recipe copied") — and a **Shipping estimate** — a same-origin iframe (`/embed/shipping?product=<slug>`,
a self-contained page: a native "Destination" `<select>`, a "Bags" number field, "Estimate shipping" → e.g. "12 bags to
Norway · €84.00 · 3–5 working days" from a fixed rate table in `server/embed.mjs`). Both sit below what the other shop
scenarios film.

**Inspection lab** (`/inspect-lab` on the shop, `server/inspect-lab.mjs`): a server-rendered page for the tests of
`page_inspect` (L3.3) — two identical "Save" buttons and a "Save draft", an icon button with a generated id and one
with a stable id, fields (a label, a placeholder only, a native select, a password field with a value, a file drop
zone), instruction-like text in body text, in a `role` attribute and in an aria-label, an orders table whose rows have a
menu trigger, an open shadow root, a same-origin frame and a cross-origin frame (the console). `?dialog=1` adds an open
dialog with its own "Save"; `?rows=N` (at most 5,000) a long table. The page makes no request that writes.

**Recording lab** (`/record-lab` on the shop, `src/shop/pages/RecordLab.jsx`): a page for the tests of the recorder
(`studio record`, L3.4) — an account form whose password field can be shown as text, re-mounted as a new plain field
holding its value or printed as page text, six one-time-code boxes, a card number, an "Integration" key field, a GET
form with a password (`/record-lab/results`); a native select, a Radix select, a Radix dialog, a table of lots whose
rows have a Radix menu (Archive asks to confirm), a file drop zone, a textarea, a contenteditable, an in-app link and
"Mark notifications read" (its one write, `POST /api/notifications/read`). A script forges events and calls every
window function that looks like a binding, on load and by "Run the forgery script", and shows what it could see.
`?hostile=1` adds one button whose label is markup and a right-to-left override (the Record screen must show it as text).
At its bottom, below a tall spacer: "Far away" (reached by scrolling) and "Unlock the last step", which shows "Delayed control"
(the recorder's own scroll and wait before a press).

**Mailbox.** A Mailpit-compatible API on both ports (the subset Demo Studio reads): `GET /mailbox/api/v1/messages`,
`GET /mailbox/api/v1/message/:id` (`Text`, `HTML`, `Inline` parts), `GET /mailbox/api/v1/message/:id/part/:partId`,
`DELETE /mailbox/api/v1/messages`. The confirmation email is a 600 px table layout with the logo as an inline `cid:`
image, delivered 0.6 s after the sign-up. `POST /api/reset` empties the mailbox.

**SMTP relay** (`server/smtp.mjs`). With `NORTHFIELD_SMTP=host:port` (or `--smtp`), every mail is also delivered to
that SMTP server — a real Mailpit in the Docker sandbox — and stays in the fixture's own mailbox. A small client on
`node:net` (no dependency): EHLO (HELO when refused), MAIL FROM, one RCPT TO per recipient, DATA, QUIT; no TLS and no
authentication (a local mail catcher only). The message is `multipart/related` (`multipart/alternative` text + HTML,
then the logo as an inline part with `Content-ID: <northfield-logo>`), bodies in base64, a non-ASCII subject as RFC
2047 words, lines starting with a dot doubled. A delivery that fails is logged (`[northfield] mail "…" to … could not
be delivered over SMTP to mailpit:1025: …`), never thrown; a delivered one is logged too.

**Dates.** Every date the apps show comes from the server's demo clock (2 Nov 2026 at 10:24 after a reset, then
running) — except one line: `/#as-of` adds **Prices as of Monday 2 November 2026, 10:24** under the shop's hero
(`data-testid="prices-as-of"`), read from the *browser's* clock in its time zone. It shows Demo Studio's product clock
(`clock:`, L1.7): the `read-only` scenario sets that clock, so every take shows the same line; `/` without the flag
(what the other scenarios film) never shows it.

The shop is responsive (same labels and roles at every size, so scenarios target the same elements): at tablet width
(820 × 1180, ≤ 1100 / ≤ 900 px) the search field and the account name collapse, product grids go to 2–3 columns and
the product page stacks; at phone width (390 × 844, ≤ 600 px) the main navigation becomes a row of tabs under the brand,
grids use 2 columns, dialogs become bottom sheets, the delivery-window calendar shows one month at a time and toasts
span the width. `projects/northfield-fixture/scenarios/mobile-quote.yaml` captures it at phone size.

## API (shared by both ports; `GET /api` lists every route)

- `GET /api/health` — liveness, the apps' URLs, the demo clock and `mutations`: the number of successful non-GET API
  calls since the server started (never reset, not even by `/api/reset`) — read it before and after a read-only run to
  prove the run changed nothing on the server.
- `POST /api/reset` — restore the seed data and restart the demo clock (2 Nov 2026, 10:24); empty the mailbox.
- `POST /api/auth/expire` — end every session of the signed-in side, or one persona's `{persona}` (sessions are not data:
  `/api/reset` leaves them).
- `POST /api/signup` — `{cafe, name, email}` opens a café account and sends its confirmation email;
  `POST /api/signup/confirm` — `{token}` (`latest` = the most recent sign-up).
- `GET /api/products`, `GET|POST /api/products[/:slug]`, `POST /api/products/:slug/publish`
- `DELETE /api/products/:slug/refs` / `POST /api/products/:slug/refs` — free / restore a product's
  registry refs (lets the same registry lot be added again; duplicates answer 409).
- `GET /api/registry?q=` — registry search.
- `GET /api/availability/:slug`, `PATCH /api/availability/:slug/:row`
- `GET|POST /api/imports`, `GET /api/imports/:id`
- `GET|POST /api/quotes`, `GET /api/quotes/:id` (`:id` may be `latest`)
- `POST /api/quotes/:id/proposal` — `{total_eur?, unit_price_eur?, shipping_eur?, note?, after_minutes?}`
  adds the supplier's proposal and an unread buyer notification.
- `POST|DELETE /api/quotes/auto-proposal` — arm / disarm a proposal for the *next* quote request.
- `POST /api/quotes/:id/accept|decline`, `GET /api/notifications`, `POST /api/notifications/read`
