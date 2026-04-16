#!/bin/bash

set -e  # Exit immediately if any command fails

echo "Removing old plugin..."
rm -rf ~/.openclaw/extensions/8080

echo "Installing plugin..."
openclaw plugins install ./

echo "Restarting gateway..."
openclaw gateway restart

echo "✅ Done!"
