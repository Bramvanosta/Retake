# Reference look — "editorial" product videos

Measured on two hand-made reference videos (1920×1080, 30 fps, 78 s and 106 s) that the default edit and the
`editorial` template must reproduce. All values are at 1920×1080; multiply by `unit` for other sizes. Brand
elements (logo, wordmark, colours, fonts) always come from the template — nothing here is brand-specific.

## Global
- Background: soft radial "paper" gradient, lighter at the top (`#f8f4ef` → `#ebe4dc`).
- Video length 1–2 min; scenes 4–25 s; no voice-over (silent audio track); captions carry the message.
- Transitions: 0.35 s crossfade between scenes; captions crossfade with their clip.
- Camera static; at most one very slow zoom per video (e.g. on a document at the end: 1.0 → ~1.12 over ~6 s).

## Clip layout (frame `card`)
- Card: x 180, y 40, 1560 × 878 (the 16:9 capture fills it), corner radius 18, soft shadow
  (≈ `0 24px 60px rgba(31,20,19,.16), 0 2px 8px rgba(31,20,19,.08)`).
- Caption block, left-aligned with the card (x ≈ 186):
  - kicker row centred at y ≈ 957: an accent rule 36 × 2 px, a 12 px gap, then the kicker — body font SemiBold 15 px,
    uppercase, letter-spacing ≈ 0.14 em, accent colour;
  - caption line centred at y ≈ 996: display font ≈ 38 px, text colour, one line (≈ 75 characters max).
- Brandmark: right-aligned with the card's right edge, vertically centred on the caption block (y ≈ 985): logo mark
  30 px + wordmark (display font 24 px, text colour), gap 10 px.
- Caption change inside a clip: old line fades out (~0.25 s), new one fades in (~0.35 s) with a 6–8 px rise.

## Intro (3.2 s, layout `logo-kicker-title`)
- Centred stack: logo mark 64 px + wordmark (display 44 px) on one row, centred at y ≈ 417; kicker (body SemiBold 18 px,
  uppercase, letter-spacing ≈ 0.18 em, accent) at y ≈ 529; title (display ≈ 96 px, text colour, tight tracking) at
  y ≈ 612; accent rule 120 × 2 px at y ≈ 694.
- Motion: logo row fades in (0–0.5 s); kicker + title fade in with a short rise (0.6–1.1 s); the rule draws from the
  centre (scaleX 0 → 1, ~0.5 s); hold; crossfade into the first clip.

## Interstitial (layout `dark-clock`, ≈ 2.6 s)
- From the current frame: everything dims while a dark warm overlay (`#1e1615`) fades in (~0.5 s); the clock and the
  text fade in on top, centred; full dark card; then crossfade into the next clip.
- Clock: 100 px circle, 3 px stroke in a muted warm brown (`#5a4744`), round-capped hands: minute hand paper-white
  (≈ 34 px), hour hand accent (≈ 22 px); the minute hand sweeps about one turn during the card (eased).
- Text: display font ≈ 72 px, paper colour (`#f3eee8`), centred at y ≈ 612 (clock centre y ≈ 480).

## Outro (3.0 s, layout `logo-wordmark-tagline-url`)
- Centred stack: logo mark 150 px (radius 22) at y 333–483; wordmark display ≈ 88 px at y ≈ 575; accent rule
  120 × 2 px at y ≈ 647; tagline body Regular 30 px muted at y ≈ 690; url body SemiBold 18 px uppercase, letter-spacing
  ≈ 0.14 em, muted at 70 % opacity, at y ≈ 737.
- Motion: logo fades + scales in (0.92 → 1), wordmark follows (~0.2 s later), then rule / tagline / url staggered by
  ~0.15 s. The wordmark is the brand name set in the display font when the template has no wordmark image.
- A wordmark logo (`logo_kind: wordmark`, or a logo 3:1 and wider) is the name already: drawn alone, ≈ 520 px wide
  (40 % of the 1300 px column; at most 150 px high), no wordmark band; the intro row and the brand mark draw it alone
  too, sized by their width.

## Cursor & UI choreography (as seen in the captures)
- macOS-style dark arrow with a white outline and a soft shadow, ~26 px; ripple in the accent colour (alpha ≈ .45).
- Dragged file: a white "file chip" (file-type badge + file name + detail line) tilted −3° following the cursor into
  the drop zone.
- Popovers and menus are visible in the capture; the cursor stays above them.

## Touches
An iOS take has no cursor: each touch draws a fingertip on the film (packages/runner-ios `touch-look.ts`, L5.3).
- A translucent mid-grey disc of 38 pt (rgb 128, alpha .42 — like iOS's own touch indicator: it reads on a white
  list and on a blue button alike) with a 1.5 pt white ring (alpha .60) and a soft shadow; it appears
  150 ms before the touch-down (120 ms, scale 1.12 → 1), presses to .88 in 80 ms, comes back at the lift and fades in
  180 ms.
- The click ripple at the touch-down, as the web cursor's (12 pt disc, scale .4 → 5.5), in the theme's ripple colour.
- The touch-down is timed from the screen's own response to the tap (the first changed frame around it), so the
  ripple meets the app's highlight.

