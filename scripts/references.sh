#!/usr/bin/env bash

# Setup script for .references/ directory
# Clones or updates all external reference repositories needed for development

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
REFERENCES_DIR="$PROJECT_ROOT/.references"

echo "Setting up .references/ directory..."

# Create .references directory if it doesn't exist
mkdir -p "$REFERENCES_DIR"

cd "$REFERENCES_DIR"

# Clone or update OpenCode
if [ ! -d "opencode" ]; then
  echo "Cloning OpenCode..."
  git clone --depth 1 https://github.com/anomalyco/opencode.git
else
  echo "Pulling OpenCode updates..."
  cd opencode && git pull && cd ..
fi

# Clone or update OpenTUI
if [ ! -d "opentui" ]; then
  echo "Cloning OpenTUI..."
  git clone --depth 1 https://github.com/anomalyco/opentui.git
else
  echo "Pulling OpenTUI updates..."
  cd opentui && git pull && cd ..
fi

# Clone or update Homebridge dbus-native
if [ ! -d "homebridge-dbus-native" ]; then
  echo "Cloning Homebridge dbus-native..."
  git clone --depth 1 https://github.com/homebridge/dbus-native.git
else
  echo "Pulling Homebridge dbus-native updates..."
  cd homebridge-dbus-native && git pull && cd ..
fi

# Clone or update Effect v4 (effect-smol)
if [ ! -d "effect-smol" ]; then
  echo "Cloning Effect v4 (effect-smol)..."
  git clone --depth 1 https://github.com/Effect-TS/effect-smol.git
else
  echo "Pulling Effect v4 (effect-smol) updates..."
  cd effect-smol && git pull && cd ..
fi

echo ""
echo "All reference repositories are up to date!"
echo ""
echo "Repositories:"
ls -1 "$REFERENCES_DIR"
