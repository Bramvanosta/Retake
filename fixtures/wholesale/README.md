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
node build.mjs [--dev]                # build only
node scripts/smoke.mjs [--out DIR]    # end-to-end check with real mouse input + screenshots
```

Environment: `NORTHFIELD_CONSOLE_PORT`, `NORTHFIELD_SHOP_PORT`, `NORTHFIELD_HOST`,
`NORTHFIELD_ENRICH_MS` (default 4000), `NORTHFIELD_IMPORT_MS` (default 2000). The server prints its
URLs and exits cleanly on SIGTERM/SIGINT. It listens on 127.0.0.1 and ::1 by default so `localhost`
works whichever address a client resolves first. Programmatic use:
`const fx = await startFixture({ consolePort: 0, shopPort: 0 }); … await fx.close();`

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
Edit / Pause / Archive), `/quotes` (quote requests, "Send proposal"). While open, the console polls the quote list and
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

**Mailbox.** A Mailpit-compatible API on both ports (the subset Demo Studio reads): `GET /mailbox/api/v1/messages`,
`GET /mailbox/api/v1/message/:id` (`Text`, `HTML`, `Inline` parts), `GET /mailbox/api/v1/message/:id/part/:partId`,
`DELETE /mailbox/api/v1/messages`. The confirmation email is a 600 px table layout with the logo as an inline `cid:`
image, delivered 0.6 s after the sign-up. `POST /api/reset` empties the mailbox.

The shop is responsive (same labels and roles at every size, so scenarios target the same elements): at tablet width
(820 × 1180, ≤ 1100 / ≤ 900 px) the search field and the account name collapse, product grids go to 2–3 columns and
the product page stacks; at phone width (390 × 844, ≤ 600 px) the main navigation becomes a row of tabs under the brand,
grids use 2 columns, dialogs become bottom sheets, the delivery-window calendar shows one month at a time and toasts
span the width. `projects/northfield-fixture/scenarios/mobile-quote.yaml` captures it at phone size.

## API (shared by both ports; `GET /api` lists every route)

- `POST /api/reset` — restore the seed data and restart the demo clock (2 Nov 2026, 10:24); empty the mailbox.
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
