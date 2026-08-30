---
name: run-app
description: Launch and visually verify the Retirement Planner desktop app on macOS. Use whenever you need to run the app, screenshot it, or confirm a UI change works in the real app rather than in tests. Covers the two traps that cost several past sessions - `open_application` resolving to a stale bundle, and the dev binary being invisible to screenshots.
---

# Running the Retirement Planner app

Tauri v2 desktop app. `pnpm tauri dev` builds and runs it, but two macOS
specifics make the obvious path fail in ways that look like the app is
broken. Both are listed below with the reason, so you can tell a real
regression from the environment.

**Skip this entirely if you only need `pnpm check`, `cargo test`, or vitest.**
Logic is far cheaper to verify there. Come here for CSS, layout, and anything
you have to look at.

## The two traps

**1. `open_application "Retirement Planner"` launches the wrong app.**
There is a stale bundle at `target/debug/bundle/macos/Retirement Planner.app`
that shares the bundle id `com.eelozano.retirement`. macOS resolves the display
name to *that*, not to your dev build. It serves a frontend frozen at whenever
it was last bundled, so you get an old UI and conclude your change didn't
apply. **Never call `open_application` for this app.**

**2. The dev binary is invisible to screenshots.**
Screenshot filtering and computer-use grants key on bundle id.
`target/debug/retirement` runs unbundled, so it matches no grant and is
filtered out of every screenshot. The symptom is unmistakable once you know
it: the menu bar says "Retirement Planner" is frontmost, and the screenshot
shows nothing but desktop. It is not a crash and not a window-position
problem — do not go hunting for the window.

## The recipe

Run the dev server, then launch that same fresh binary from inside the bundle
so it inherits a bundle id. It still points at the Vite dev server, so the
frontend is current and HMR works.

```bash
lsof -ti:1420 | xargs kill 2>/dev/null; true
```

```bash
pnpm tauri dev
```

Run that in the background, and wait for the binary to actually start — not
just for Vite. Poll for the launch line rather than sleeping a fixed amount:

```bash
until grep -q 'Running `/Users' dev.log; do sleep 2; done
```

Then swap the fresh binary into the bundle and open the bundle:

```bash
APP="target/debug/bundle/macos/Retirement Planner.app"; cp target/debug/retirement "$APP/Contents/MacOS/retirement"; open "$APP"
```

No `codesign` step. An ad-hoc re-sign was tried and is **not** required — it
also emits a "resource fork ... detritus not allowed" error that looks like a
failure and isn't. Skip it.

Screenshot now and you will see the current UI. Edits hot-reload; take another
screenshot rather than relaunching.

If `target/debug/bundle/` does not exist on a fresh clone, create it once with
`pnpm tauri build --debug`, then use the copy step above from then on.

## Cleanup

Killing the `tauri.js` CLI does **not** kill Vite — it is spawned as the
`beforeDevCommand` and survives, holding port 1420. The next `pnpm tauri dev`
then dies with `Port 1420 is already in use`, which reads like a broken
project. Always tear down all three:

```bash
pkill -f "bundle/macos/Retirement Planner.app"; pkill -f "target/debug/retirement"; pkill -f "@tauri-apps/cli/tauri.js"; lsof -ti:1420 | xargs kill 2>/dev/null; true
```

## Driving the UI

- **Do not edit the plan.** The app opens the user's real financial data, and
  every edit debounces into a real save. Reading, scrolling, clicking, and
  opening disclosures are all safe. If you need to change inputs to test
  something, duplicate into a scenario first via the Scenarios button.
- **Coordinate gate errors naming another app.** Clicks and scrolls sometimes
  fail with `would land on "Wispr Flow", which is not in the allowed
  applications` — an overlay occupying part of the screen. It is not about the
  Retirement Planner window. Retry the same gesture at a different y
  coordinate; near the top of a column usually works when the middle does not.
- **Menu bar clicks need a Finder grant**, which is usually not worth
  requesting. Prefer in-app controls.
- The left rail is the navigation: chart icon is Plan, arrows are Cash flow,
  sliders are Inputs, layers are Compare, database at the bottom is Storage.
