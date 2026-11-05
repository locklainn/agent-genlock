#!/bin/sh
# Builds the app and puts it in /Applications.
set -eu
cd "$(dirname "$0")/.."
./scripts/build.sh
rm -rf /Applications/Genlock.app
cp -R build/Genlock.app /Applications/Genlock.app
echo "Installed /Applications/Genlock.app"
