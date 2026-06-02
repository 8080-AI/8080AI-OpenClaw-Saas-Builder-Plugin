#!/bin/bash

set -e  # Exit immediately if any command fails

echo "Removing old plugin..."
# Remove any existing installation to avoid duplication warnings
openclaw plugins uninstall ai8080 --force || true

echo "Installing plugin..."
# --link is essential for development so we don't have to reinstall every time
openclaw plugins install ./ --link

echo "Restarting gateway..."
openclaw gateway restart

echo "✅ Done!"
