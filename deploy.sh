#!/bin/bash
set -e

REPO="$(dirname "$0")"

echo "Pulling latest code..."
git -C "$REPO" pull

echo "Building server..."
cd "$REPO/server"
yarn build

echo "Restarting server..."
pm2 restart video

echo "Building client..."
cd "$REPO/client"
yarn build

echo "Done."
