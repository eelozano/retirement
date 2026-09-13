#!/bin/sh
#
# Leave a working ibtoold running before Tauri compiles the layered icon.
#
# actool hands every compile to a long-lived ibtoold daemon, and starts one if
# none is running. A daemon started by the actool call inside `tauri build`
# fails every compile of an Icon Composer document with an NSPlaceholderArray
# exception, and keeps failing for every later client until it is killed. One
# started from a shell works, and Tauri's call reuses it. Tauri runs this as
# `build.beforeBundleCommand`, after compiling and just before bundling.
#
# "Works" needs two things here, so both are checked. The compile has to
# succeed, which is proved by compiling the real icon. And a daemon has to still
# be running afterwards: straight after killing a broken one, a compile can
# succeed and leave no daemon behind, and Tauri's call would then start a
# broken one of its own.
#
# Anywhere the layered icon cannot be built anyway (not macOS, no Xcode 26
# actool) there is nothing to warm, and Tauri falls back to icon.icns on its
# own, so this exits 0.
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
icon="$root/src-tauri/icons/RetirementPlanner.icon"

[ "$(uname -s)" = Darwin ] || exit 0
command -v actool >/dev/null 2>&1 || exit 0
major=$(actool --version --output-format human-readable-text 2>/dev/null |
  sed -n 's/^ *short-bundle-version: *\([0-9][0-9]*\).*/\1/p')
[ -n "$major" ] && [ "$major" -ge 26 ] || exit 0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

daemon_running() {
  pgrep -x ibtoold >/dev/null 2>&1
}

# The same invocation tauri-bundler makes (bundle/macos/icon.rs), so a daemon
# that passes here passes there.
compile() {
  rm -rf "$work/Icon.icon" "$work/out" && mkdir "$work/out" &&
    cp -R "$icon" "$work/Icon.icon" &&
    env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="${TMPDIR:-/tmp}" \
      actool "$work/Icon.icon" --compile "$work/out" \
      --output-format human-readable-text --notices --warnings \
      --output-partial-info-plist "$work/out/assetcatalog_generated_info.plist" \
      --app-icon Icon --include-all-app-icons --accent-color AccentColor \
      --enable-on-demand-resources NO --development-region en \
      --target-device mac --minimum-deployment-target 26.0 --platform macosx \
      >"$work/log" 2>&1 &&
    [ -f "$work/out/Assets.car" ]
}

if compile && daemon_running; then
  echo "warm-actool: ibtoold compiles the layered icon"
  exit 0
fi

echo "warm-actool: no working ibtoold; restarting it"
pkill -x ibtoold
waited=0
while daemon_running && [ "$waited" -lt 20 ]; do
  sleep 0.5
  waited=$((waited + 1))
done

for attempt in 1 2 3; do
  if compile && daemon_running; then
    echo "warm-actool: a fresh ibtoold compiles the layered icon"
    exit 0
  fi
  sleep 1
done

if daemon_running; then
  echo "warm-actool: actool still cannot compile $icon:" >&2
  cat "$work/log" >&2
else
  echo "warm-actool: the icon compiled, but no ibtoold stayed running for Tauri to use" >&2
fi
exit 1
