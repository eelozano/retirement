---
name: run-app
description: Launch and visually verify the Retirement Planner desktop app on macOS. Use whenever you need to run the app, screenshot it, or confirm a UI change works in the real app rather than in tests. Runs against the committed demo household by default, so screenshots never show the user's real finances and you can add, edit and delete plans freely. Covers the two traps that cost several past sessions - `open_application` resolving to a stale bundle, and the dev binary being invisible to screenshots.
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

This runs against the **demo household**, not the user's finances — that is
the default here, and you should stay on it unless you have a specific reason
not to. See below for what that buys you and how to opt out.

Tear down anything already running *first*, every time — not just when a
port conflict shows up. A previous session that got interrupted (see the
wait-for-binary note below) leaves its dev server, Vite, and bundled app
running with nothing to signal that. Starting clean is what actually
prevents the pile-up; only cleaning up at the end does not, because
interrupts skip the end:

```bash
pkill -f "bundle/macos/Retirement Planner.app"; pkill -f "target/debug/retirement"; pkill -f "@tauri-apps/cli/tauri.js"; lsof -ti:1420 | xargs kill 2>/dev/null; true
```

```bash
pnpm demo > dev.log 2>&1
```

Run that in the background. (`pnpm demo` seeds `/tmp/retirement-demo` from the
committed fixtures if it is empty, then starts the dev server pointed at it.) Then wait for the *binary* to start, not just for
Vite — Vite is ready in ~100ms while the Rust build can take minutes on a cold
target dir.

**Do not spawn a second background task to poll for it**, and do not use a
foreground `sleep` — the harness blocks a bare `sleep N && tail` outright.
Fold the wait into the launch step instead: one background command that
polls the log and, once the binary is up, does the swap-and-open below
itself. The line to wait for is the cargo `Running` line, and it is wrapped
in ANSI colour codes, so **grep for the binary path, not for `Running \``**
— a session hung indefinitely on `grep "Running \`"` while the app was
already running:

```bash
until grep -q "Running.*target/debug/retirement" dev.log; do sleep 3; done; sleep 2; APP="target/debug/bundle/macos/Retirement Planner.app"; cp target/debug/retirement "$APP/Contents/MacOS/retirement" && open --env "RETIREMENT_DATA_DIR=/tmp/retirement-demo" "$APP"
```

Run that in the background too (it is the second and last background task;
the dev server is the first). If it has not reported back after a couple of
minutes on a cold target dir, read `dev.log` yourself rather than starting
another waiter.

The swap-and-open at the end of that command is the whole trick: the fresh
binary runs from inside the bundle, so it inherits the bundle id and shows
up in screenshots, while still pointing at the Vite dev server.

The `--env` is not optional: `open` does not pass the calling shell's
environment, so without it the bundled copy reads the *real* plans directory
even though the dev server is on demo data.

No `codesign` step. An ad-hoc re-sign was tried and is **not** required — it
also emits a "resource fork ... detritus not allowed" error that looks like a
failure and isn't. Skip it.

**Leave the unbundled dev binary running while you do this.** It is tempting
to `pkill -f target/debug/retirement` first, since that process is the one
you can't screenshot and you're about to run a second copy. Don't: `pnpm
tauri dev` treats its child exiting as the session ending, and takes Vite
down with it — so the bundled copy you open next points at a dead port 1420
and shows a blank window. Two copies of the app running is harmless; recover
from the mistake, if made, with `pnpm exec vite --port 1420 --strictPort` in
the background and reopen the bundle.

Screenshot now and you will see the current UI. Give it a couple of seconds
first: the window paints white before the frontend loads, and a screenshot
taken the instant `open` returns shows an empty window that reads like a
blank-page bug. Wait and take a second one before concluding anything.

Edits hot-reload; take another screenshot rather than relaunching.

If `target/debug/bundle/` does not exist on a fresh clone, create it once with
`pnpm tauri build --debug`, then use the copy step above from then on.

## Demo data, and when you actually need real data

`pnpm demo` — what the recipe above runs — seeds `/tmp/retirement-demo` from
the committed fixtures and launches against it, so the app opens Alex and
Jordan's invented household rather than the user's finances.

It works by setting `RETIREMENT_DATA_DIR`, which relocates *all* app state,
settings and plans both, under that one root. It has to cover settings too:
settings.json is where a chosen plans location is recorded, so redirecting
only the plans dir would let the real settings.json point the run straight
back at real data.

Seeding is conditional, so a restart keeps whatever you changed last time:

- `pnpm demo` — seed if the root is empty, then run.
- `pnpm demo:seed` — seed without running.
- `pnpm demo:reset` — throw the root away and re-seed the four committed
  scenarios.

**Change whatever you like in demo mode.** Edit inputs, add scenarios, delete
them, rename them, restore snapshots, let autosave fire as often as it likes.
The root is a throwaway copy in `/tmp`, the fixtures it came from are committed,
and `pnpm demo:reset` is one command back to a clean household. Adding and
removing plans is frequently the fastest way to test something — do it, and
don't ask first.

**Confirm before you screenshot.** The demo household is Alex and Jordan; the
real one is not. If the plan picker shows anything other than the four demo
scenarios — Base plan, Retire two years early, Claim Social Security at 62,
Leaner retirement spending — the var did not take, and you are looking at real
data. Stop and fix it rather than cropping around it.

### When you do need real data

Reproducing a bug that only the user's own plan triggers is the usual reason.
Run `pnpm tauri dev` instead of `pnpm demo`, and open the bundle *without*
`--env`. Then treat the app as read-only — see the first bullet under Driving
the UI. Never screenshot that session.

## Cleanup

Killing the `tauri.js` CLI does **not** kill Vite — it is spawned as the
`beforeDevCommand` and survives, holding port 1420. The next `pnpm demo`
then dies with `Port 1420 is already in use`, which reads like a broken
project. Always tear down all three once you're done looking at the app:

```bash
pkill -f "bundle/macos/Retirement Planner.app"; pkill -f "target/debug/retirement"; pkill -f "@tauri-apps/cli/tauri.js"; lsof -ti:1420 | xargs kill 2>/dev/null; true
```

This is the same command the recipe runs *before* starting, too. Don't treat
either copy as optional: the one at the start catches whatever an earlier,
interrupted run left behind; this one is what keeps the next run — yours or
a future session's — from inheriting a mess. If the user interrupts you
mid-task, run this the moment you're back, before doing anything else — it's
cheap, and skipping it is exactly how processes accumulate across sessions.

## Driving the UI

- **The window opens on whichever Space the user is on, and stays there.**
  Background `app_*` clicks are refused or silently dropped when the window
  is on another Space, and `app_bring_to_current_space` cannot move it into
  a full-screen Space. If `app_screenshot` reports the window is off-Space
  and clicks have no effect, ask the user to switch to a regular desktop
  Space (or to bring the window over) before driving the UI; do not keep
  re-clicking.
- **Editing is free on demo data, off-limits on real data.** On the demo root
  (the default) change anything you want. In a deliberate real-data session
  every edit debounces into a real save of the user's finances: reading,
  scrolling, clicking, and opening disclosures are safe, but if you need to
  change an input, restart on demo data instead — or, if it genuinely must be
  their numbers, duplicate into a scenario first via the Scenarios button.
- **Coordinate gate errors naming another app.** Clicks and scrolls sometimes
  fail with `would land on "Wispr Flow", which is not in the allowed
  applications` — an overlay occupying part of the screen. It is not about the
  Retirement Planner window. Retry the same gesture at a different y
  coordinate; near the top of a column usually works when the middle does not.
- **Menu bar clicks need a Finder grant**, which is usually not worth
  requesting. Prefer in-app controls.
- The left rail is the navigation: chart icon is Plan, arrows are Cash flow,
  sliders are Inputs, layers are Scenarios (which holds the compare view), database at the bottom is Storage.
