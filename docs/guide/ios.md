# iOS apps in the Simulator

Retake films an iOS app in the iOS Simulator from the same scenario language as a web product: the scenario picks an
**iOS environment** with `env:`, its steps tap, type and swipe through an XCUITest driver, the take is recorded from
the Simulator and a touch overlay is burnt into the film. The capture keeps the web runner's contract
(`timeline.json` + `capture.mp4`), so editing, review and export work as for a web take, framed in a phone by default.

macOS only. Needs Xcode (with its command-line tools selected: `xcode-select -p`) and an iOS Simulator runtime;
`retake doctor` says whether this Mac is ready, and with `--project` whether a project's iOS environments are.

## An iOS environment

```yaml
# project.yaml
environments:
  simulator:
    ios:
      app: build/MyApp.app       # a .app built for the simulator (a path in the project, or absolute), or a bundle id already installed
      device: iPhone 17 Pro      # a device type: `xcrun simctl list devicetypes`
      schemes: [myapp]           # the URL schemes `open:` may use (deep links)
default_env: simulator
frame: phone
```

- `app`: a path relative to the project (it may not leave the project through `..` or a link) or an absolute path; a
  run started by an agent (the Studio, MCP) refuses an app built inside the workspace, which an agent can write. A
  bundle id names an app already installed on the device.
- An iOS environment is never production, has no pages, no personas and no sandbox. `runtime`, `appearance` and
  `reset` are not supported yet (the newest iOS runtime is used).
- `retake env set | remove` do not edit iOS environments: edit project.yaml by hand.

## The device

A take never uses your own simulators. Retake makes its own, **"Retake - <device> - <runtime>"**, in English with a US
keyboard, boots it headless (the Simulator app does not open), installs the app before each take, overrides the status
bar (9:41, full bars, charged) and shuts the device down after the take if it booted it
(`RETAKE_IOS_KEEP_BOOTED=1` keeps it booted between takes). It stays in Xcode's device list; remove it with
`xcrun simctl delete "Retake - iPhone 17 Pro - iOS 26.5"`.

The XCUITest driver (`packages/runner-ios/driver`) is built once per Xcode version into the Retake home
(`ios-driver/`); the first take of a new device takes a minute or two (boot, driver start).

## Steps on iOS

| Step | On iOS |
|---|---|
| `click` | a tap at the centre of the target |
| `type` | taps `into` (when given), then types; `clear`, `enter` |
| `press` | `Enter` / `Return`, `Backspace` / `Delete` (the on-screen keyboard's keys) |
| `scroll` | a swipe: `by` points, or until a target is in view |
| `open` | a deep link whose scheme is in `schemes` (also a scene's `open:`); http(s) is refused |
| `wait`, `hold`, `emit` | as on the web |
| `wait_for`, `assert` | `text`, `not_text`, `target`, `gone` (not `url`, `title`, `network_idle`) |
| `screenshot` | the device's screen |
| `hook` | `sh`, `http` and `sql` hooks (no `js`: there is no page) |

Every other step (hover, select, drag, new tabs, `eval`…) is refused at validation, on its line. Targets name the
app's accessibility: `text` (label or value), `label` / `aria` (label), `testid` (accessibility identifier), `role`
(`button`, `textbox`, `switch` / `checkbox`, `text` / `heading`, `cell` / `row`) with `name`, `placeholder`, `nth`,
`exact`; CSS selectors are refused. Typing a secret reference is refused (the on-screen keyboard shows each key).
Dry runs, inspection, recording, the live picture and pausing a take are web-only for now.

## The film

`capture.mp4` is the device's screen at its own resolution (an iPhone 17 Pro: 1206 × 2622, scale 3), at the
project's frame rate; the timeline's coordinates are in points. Each touch shows a translucent fingertip disc with the
click ripple, timed from the screen's own response to the tap ([look](../reference/look.md#touches)). The edit frames
a device capture in a phone (`frame: phone`, the device's own status bar under the frame's island) when neither the
scenario nor the project writes a `frame` — a frame written is kept, even `frame: card`, and `retake render --frame
card` keeps the card for one render —, and renders at the theme's size (scale 1).

The fixture app `fixtures/ios-wholesale` (Northfield Buyer) and its project `fixtures/ios-wholesale/project` show a
whole scenario.
