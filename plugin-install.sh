#!/usr/bin/env bash

set -e  # Exit immediately if any command fails

OPENCLAW="${OPENCLAW:-npx --no-install openclaw}"

echo "Building plugin..."
npm run build

echo "Removing old plugin..."

# Remove any existing installation to avoid duplication warnings.
$OPENCLAW plugins uninstall 8080ai --force || true

echo "Installing plugin..."
# --link is essential for development so we don't have to reinstall every time
$OPENCLAW plugins install ./ --link

echo "Restarting gateway..."
$OPENCLAW gateway restart

echo "✅ Done!"
