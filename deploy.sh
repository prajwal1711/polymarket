#!/bin/bash
# Deploy script for copytrade
# Usage: ./deploy.sh [--restart]

set -e

SERVER="ubuntu@13.49.224.112"
KEY="$HOME/.ssh/copytrade-key.pem"
REMOTE_DIR="~/polymarket"

echo "=== Deploying to production ==="

# Sync files (excluding data, node_modules, dist, git)
echo "1. Syncing files..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude 'data' --exclude '*.db' \
  -e "ssh -i $KEY" \
  /Users/apple/Desktop/polymarket/ $SERVER:$REMOTE_DIR/

# Install deps and build on server
echo "2. Installing dependencies and building..."
ssh -i $KEY $SERVER "cd $REMOTE_DIR && npm install && npm run build"

# Restart services if --restart flag is passed
if [ "$1" == "--restart" ]; then
  echo "3. Restarting services..."
  ssh -i $KEY $SERVER "pkill -f 'dist/copytrade/daemon.js' || true; pkill -f 'dist/copytrade/dashboard.js' || true; sleep 1; cd $REMOTE_DIR && nohup node -r dotenv/config dist/copytrade/dashboard.js > /tmp/dashboard.log 2>&1 & nohup node -r dotenv/config dist/copytrade/daemon.js > /tmp/daemon.log 2>&1 &"
  echo "Services restarted!"
else
  echo "3. Skipping restart (use --restart to restart services)"
fi

echo "=== Deploy complete ==="
