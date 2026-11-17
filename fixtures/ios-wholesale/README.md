# Northfield Buyer — the iOS fixture app

An invented SwiftUI app the iOS runner films, the phone side of the fictional "Northfield" coffee wholesaler
(`fixtures/wholesale`): a café browses the roaster's coffees and sends a quote request. Every name in it is fictional;
the catalogue is taken from `fixtures/wholesale/server/seed.mjs`. It has no network access and keeps its state in
memory, so every launch starts from the same catalogue and an empty quote.

- Bundle id `com.example.northfield.buyer`, URL scheme `northfield`, iOS 17 or later, portrait, iPhone.
- Built for the iOS Simulator only, signed ad hoc: no signing identity, no team.

## Build

```sh
node fixtures/ios-wholesale/build.mjs --out <dir>
```

Runs `xcodebuild` for the simulator with its derived data, log (`xcodebuild.log`) and product under `<dir>`, and
prints the `.app`'s path. Nothing is written in the checkout. The project (`NorthfieldBuyer.xcodeproj`) is committed
as is: no project generator is needed.

## Screens

| Screen | What is on it | Accessibility identifiers |
| --- | --- | --- |
| Catalogue | a searchable list of coffees (search field "Search coffees"), a quote button in the toolbar | `catalogue-list`, `product-row-<lot>`, `catalogue-empty`, `open-quote` |
| Product | name, origin, tasting notes, lot, price, a quantity stepper (5 kg steps), "Add to quote" | `product-name`, `product-notes`, `product-sku`, `product-price`, `quantity-stepper`, `line-total`, `add-to-quote`, `added-banner` |
| Quote (sheet) | the lines, the total, a notes field, "Send request" | `quote-empty`, `quote-line-<lot>`, `quote-total`, `quote-notes`, `send-request`, `close-quote` |
| Confirmation | "Request sent" and a reference | `confirmation-title`, `confirmation-reference`, `confirmation-done` |
| Calibration | a full-screen surface, white while touched, black otherwise | `calibration-surface` (label "Calibration surface"), `calibration-done` |

## Deep links

- `northfield://product/<lot>` — a coffee's page, for example `northfield://product/NF-26-031`.
- `northfield://catalogue` — back to the catalogue.
- `northfield://quote` — the quote sheet.
- `northfield://calibrate` — the calibration surface. It is used to measure the runner's timing: the surface turns
  white in the touch-down event itself and its accessibility value reads
  `touches=<count> down=<epoch ms> up=<epoch ms>` (the simulator shares the host's clock), so a tap's time can be
  compared with the app's and with the first white frame of a recording.

`xcrun simctl openurl` asks "Open in Northfield Buyer?" before it opens a link; the runner's driver opens links
through XCUITest instead, which does not ask.

## Project

`project/` is the Retake project that films the app: an iOS environment `simulator` (device "iPhone 17 Pro", scheme
`northfield`), `frame: phone`, and `scenarios/quote.yaml` (browse, search, a coffee's quantity, the quote by deep link, a
note, the request sent; about 35 s). Its `app` names `build/NorthfieldBuyer.app`: the tests copy the project into a
workspace of their own and write there the path `build.mjs` printed
(`RETAKE_TEST_IOS=1 npx vitest run packages/runner-ios/test/ios-acceptance.test.ts`).
