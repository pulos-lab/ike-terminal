#!/bin/bash
# Deploy TIX Terminal to production server
# Usage: ./deploy/deploy.sh [user@host]
set -euo pipefail

SERVER="${1:-ike-terminal@tixterminal.app}"
REMOTE_DIR="/opt/ike-terminal/app"

echo "🔨 Building..."
npm run build

echo "📦 Syncing to $SERVER..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='Import' \
  --exclude='.env' \
  server/dist/ "$SERVER:$REMOTE_DIR/server/dist/"

rsync -avz --delete \
  client/dist/ "$SERVER:$REMOTE_DIR/client/dist/"

rsync -avz --delete \
  shared/dist/ "$SERVER:$REMOTE_DIR/shared/dist/"

# Sync package files for npm install
rsync -avz \
  package.json package-lock.json \
  server/package.json shared/package.json client/package.json \
  "$SERVER:$REMOTE_DIR/"

# Create workspace structure for npm ci
ssh "$SERVER" "mkdir -p $REMOTE_DIR/server $REMOTE_DIR/shared $REMOTE_DIR/client"
rsync -avz server/package.json "$SERVER:$REMOTE_DIR/server/"
rsync -avz shared/package.json "$SERVER:$REMOTE_DIR/shared/"
rsync -avz client/package.json "$SERVER:$REMOTE_DIR/client/"

echo "📥 Installing production dependencies on server..."
ssh "$SERVER" "cd $REMOTE_DIR && npm ci --omit=dev"

echo "🔄 Restarting service..."
ssh "$SERVER" "sudo systemctl restart ike-terminal"

echo "⏳ Waiting for startup..."
sleep 3

echo "✅ Checking health..."
curl -sf "https://tixterminal.app/api/health" | python3 -m json.tool || echo "⚠️  Health check failed"

echo "🎉 Deploy complete!"
