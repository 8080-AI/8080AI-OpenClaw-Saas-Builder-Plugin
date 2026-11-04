#!/usr/bin/env bash

set -euo pipefail

# Use the host CLI that owns the active Gateway and config. Using `npx` here
# resolves this repository's development dependency, which may be older than
# the installed host and unable to read a config migrated by a newer release.
OPENCLAW="${OPENCLAW:-$(command -v openclaw || true)}"
PLUGIN_ID="8080ai"

if [[ -z "$OPENCLAW" || ! -x "$OPENCLAW" ]]; then
  echo "OpenClaw CLI not found. Set OPENCLAW to the executable path." >&2
  exit 1
fi

echo "Using OpenClaw CLI: $OPENCLAW"
"$OPENCLAW" --version

echo "Building plugin..."
npm run build

echo "Validating OpenClaw config..."
"$OPENCLAW" config validate

plugin_is_installed() {
  "$OPENCLAW" plugins inspect "$PLUGIN_ID" --json >/dev/null 2>&1
}

reload_plugin() {
  echo "Reloading plugin..."
  # --wait avoids the normal replacement deadline while admitted plugin work
  # finishes. It does not discard in-flight runs; Ctrl-C cancels the wait.
  if "$OPENCLAW" plugins reload "$PLUGIN_ID" --wait --accept-capabilities; then
    return 0
  fi

  echo "Plugin reload did not recover cleanly; restarting the gateway safely..." >&2
  "$OPENCLAW" gateway restart --safe
}

if plugin_is_installed; then
  echo "Plugin is already installed; preserving settings and linked source."

  # Enabling an already-enabled plugin is harmless. If live application is
  # temporarily blocked, reload below retries the saved state with --wait.
  if ! "$OPENCLAW" plugins enable "$PLUGIN_ID"; then
    echo "Enable was saved but could not be applied live; continuing with reload recovery..." >&2
  fi
  reload_plugin
else
  echo "Installing plugin..."
  # --link is essential for development so source edits only require a reload.
  if "$OPENCLAW" plugins install ./ --link --force --accept-capabilities; then
    echo "Plugin installed."
    if "$OPENCLAW" plugins enable "$PLUGIN_ID"; then
      echo "Plugin enabled and applied."
    else
      echo "Enable was saved but could not be applied live; attempting reload recovery..." >&2
      reload_plugin
    fi
  else
    install_status=$?
    if ! plugin_is_installed; then
      echo "Plugin installation failed before an install record was saved." >&2
      exit "$install_status"
    fi

    echo "Installation was saved but live activation failed; attempting reload recovery..." >&2
    if ! "$OPENCLAW" plugins enable "$PLUGIN_ID"; then
      echo "Enable could not be applied live; continuing with reload recovery..." >&2
    fi
    reload_plugin
  fi
fi

echo "✅ Done!"
