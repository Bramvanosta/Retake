# Design brief — Demo Studio (for a design session)

## Product
Demo Studio turns a written scenario into a professional product video: it drives a real web app headless with an
in-page cursor, records a clean capture, then edits it automatically with themeable components (intro, outro,
captions, layouts, waiting screens, overlays). Generic and product-agnostic, sold as a licence later (V2). Users:
product marketers, founders, designers — and Claude, which operates everything through an MCP server.

## What to design
### A. Studio app (desktop-class web app, 1280–1440 wide; later wrapped in a macOS shell)
1. **Scenario as blocks** — scenes as cards (page, URL, caption, speed, layout, duration); steps as rows with an
   action badge (click, select, pick, menu, type, scroll, drop file, wait, hold, navigation), the target in plain words,
   modifier chips (speed, zoom, mark, caption, irreversible), the real frame thumbnail from the last run, drag handles;
   setup/teardown hooks strip; an inspector for the selected step (args + edit hints); Blocks ↔ YAML toggle;
   Dry run / Capture / Open timeline actions.
2. **Edit & verify timeline** — live preview player (no render), segment track with each segment's component
   (intro, scenes, waiting screen, outro), caption / steps / camera (zoom) / speed / marker tracks, comment pins,
   playhead; segment inspector to switch the layout component in one click (card, browser, laptop, full screen),
   caption component, speed, transition; review status (clean / warnings); Render.
3. **Frame comments** — click a frame, draw a region, write a comment; anchor chips (frame, segment, step, component);
   thread with Claude's reply proposing a scenario diff (Apply and re-render / Preview change); open/resolved list.
4. **Component library** — grid of components by kind with previews rendered in the selected theme (theme switcher),
   source (built-in / workspace "made with Claude" / marketplace V2), slots, actions (preview, set as theme default,
   create with Claude).
5. **Theme editor** — brand (logo, name, URL), colours, type pair, motion bias (real / balanced / motion), max zoom,
   cursor; the component chosen per kind; live previews (intro, clip with caption, outro); "extract from a website".

### B. Video components (1920×1080 frames) — same components in two themes
Intro (logo + wordmark row, kicker, display title, accent rule), clip (capture in a rounded card on a soft background,
caption block below: accent rule + uppercase kicker + display line, brandmark bottom right), waiting screen (dark,
animated clock, display text), outro (big logo, wordmark, rule, tagline, url), plus a browser-window layout with an
overlay caption band. Reference measurements: `docs/reference/look.md`.

## Constraints
- No real client names, logos or data: use the fictional "Northfield" coffee-wholesale product.
- The app UI has its own identity (calm, precise, light; one blue accent; Geist / Geist Mono) — distinct from the
  video themes, which belong to the user's brand.
- Accessibility: real buttons/inputs/labels, 4.5:1 text contrast, colour never the only cue (badges carry labels).
- Show adaptability: the same component must look native in a warm editorial theme and in a dark "Night" theme.

## Current mock-ups
Canvas "Demo Studio — maquettes" (11 artboards): app screens 1–5 and the video frames for the Editorial and Night
themes. Iterate from it rather than from scratch.
