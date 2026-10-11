# Northfield (fixture)

Demo Studio project that films **Northfield**, the fictional specialty-coffee wholesale platform
bundled with the tool (`fixtures/wholesale`). It exists to test Demo Studio end to end — capture,
edit, review — without access to any real staging site, and to produce sample videos.

## Product

Northfield connects coffee roasters with the cafés they supply.

- **Supplier console** — roasters import price lists, manage which lots are offered in which market
  (delivery windows, bag sizes, grinds, label languages), add coffees from a lot registry (tasting
  notes, producer and awards are filled in automatically) and answer quote requests.
- **Buyer shop** — cafés discover lots, request a quote for a quantity and a delivery window, receive
  the roaster's proposal as a notification and download it as a PDF.

## Audience

- Roasters and green-coffee traders evaluating the supplier console (video: `catalogue`).
- Café owners and head baristas who order coffee (video: `quote`; on a phone: `mobile-quote`, the shop at 390 × 844
  framed with the phone layout).

## Goals

1. Show that a whole price list goes live in every market in seconds.
2. Show fine-grained control per market without spreadsheets.
3. Show that adding a coffee takes one search — the product page fills in by itself.
4. Show the buyer journey from discovery to a priced proposal in under a minute.

## Tone

Calm, precise, premium. Short captions that state the benefit, never the click. Real product capture
with light motion design: no zoom at every cut, one slow zoom on the key reveal at most.

## Environments & links

| Environment | Page key | URL |
| --- | --- | --- |
| `local` | `console` | http://localhost:4401 |
| `local` | `shop` | http://localhost:4402 |

Start the fixture before running a scenario: `pnpm fixture` (or `node fixtures/wholesale/server.mjs`;
ports: `--console-port` / `--shop-port` or `NORTHFIELD_CONSOLE_PORT` / `NORTHFIELD_SHOP_PORT`).
`POST /api/reset` restores the seed data (this is the project's `reset` hook); `GET /api` lists every
endpoint usable from http hooks.

## Accounts (by reference)

No login: the console is signed in as the supply manager of *Northfield Roasters*, the shop as the
café account *Demo Café* (Stockholm, Sweden). Real projects reference a pre-authenticated profile in
`project.yaml` (`auth.profile`) — never credentials.

## Data the videos rely on

- Product `finca-lirandel-geisha` — availability in 16 markets (Iceland and Sweden first).
- Registry lot *Finca Quenaro 2026* (GCR-26-0412) — linked to an archived product, so the
  `catalogue` setup frees its registry ref (`DELETE /api/products/finca-quenaro/refs`, rolled
  back automatically); the new product gets the slug `finca-quenaro-2`.
- Product `selowa-ridge` — 3 × 5 kg bags at €36.40/kg + €30 delivery + 25 % VAT = **€720.00**.
- The `quote` setup arms an automatic proposal for the next quote request
  (`POST /api/quotes/auto-proposal`), stamped 4 h 18 min after the request, which the shop shows on
  its next page load ("A few hours later").
- The demo clock starts on 2 November 2026, 10:24 at every reset, so dates and times are identical
  on every run.

## Do

- Reset the fixture in setup so every run starts from the same state.
- Keep the cursor still while something reveals itself (enrichment, the proposal total).
- Close pickers by clicking outside (Escape closes the whole Edit dialog).

## Don't

- Don't show the duplicate-lot warning in the catalogue video — it belongs to a separate how-to.
- Don't zoom on tables; zoom only on the Awards reveal.
- Don't name real companies, brands, people, farms or producers in captions — Northfield and everything in it
  (lots, farms, washing stations, producers, cafés) is fictional.
