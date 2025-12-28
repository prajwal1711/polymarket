#!/bin/bash
#
# Copytrade Daemon Setup Script
# Run this on a fresh Ubuntu server (AWS, Oracle Cloud, etc.)
#
# Usage:
#   curl -sSL https://your-repo/setup.sh | bash
#   OR
#   chmod +x setup.sh && ./setup.sh
#

set -e

echo "╔═══════════════════════════════════════════════════════╗"
echo "║       COPYTRADE DAEMON SETUP                          ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# Update system
echo "Step 1: Updating system..."
sudo apt-get update -y
sudo apt-get upgrade -y

# Install Node.js 20.x
echo "Step 2: Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install build tools (for native modules like better-sqlite3)
echo "Step 3: Installing build tools..."
sudo apt-get install -y build-essential python3

# Verify installation
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"

# Create app directory
echo "Step 4: Setting up application..."
mkdir -p /home/ubuntu/polymarket
cd /home/ubuntu/polymarket

# Clone or copy your code here
# git clone https://your-repo.git .
# OR copy files manually

echo ""
echo "═══════════════════════════════════════════════════════"
echo "Manual steps required:"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "1. Copy your project files to /home/ubuntu/polymarket/"
echo "   scp -r ./* ubuntu@your-server:/home/ubuntu/polymarket/"
echo ""
echo "2. Create .env file with your credentials:"
echo "   nano /home/ubuntu/polymarket/.env"
echo ""
echo "3. Install dependencies and build:"
echo "   cd /home/ubuntu/polymarket"
echo "   npm install"
echo "   npm run build"
echo ""
echo "4. Install the systemd service:"
echo "   sudo cp deploy/copytrade.service /etc/systemd/system/"
echo "   sudo systemctl daemon-reload"
echo "   sudo systemctl enable copytrade"
echo "   sudo systemctl start copytrade"
echo ""
echo "5. Check status:"
echo "   sudo systemctl status copytrade"
echo "   sudo journalctl -u copytrade -f"
echo ""
echo "═══════════════════════════════════════════════════════"
