# Copytrade Daemon Deployment

## Quick Start (Local Test)

```bash
# Dry run (no real orders)
npm run copytrade:daemon:dry

# Live mode
CONFIRM=YES_TO_COPYTRADE npm run copytrade:daemon
```

## Deploy to Cloud (AWS/Oracle/etc.)

### 1. Provision a Server

**Oracle Cloud Free Tier (Recommended - Free Forever):**
- Create an "Always Free" VM.Standard.E2.1.Micro instance
- Use Ubuntu 22.04 image
- Open port 22 for SSH

**AWS Free Tier:**
- Create a t2.micro EC2 instance
- Use Ubuntu 22.04 AMI
- Open port 22 for SSH

### 2. SSH into Server

```bash
ssh ubuntu@your-server-ip
```

### 3. Run Setup Script

```bash
# Update system and install Node.js
sudo apt-get update -y && sudo apt-get upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
```

### 4. Copy Project Files

From your local machine:
```bash
# Create archive (excluding node_modules)
tar --exclude='node_modules' --exclude='.git' -czvf polymarket.tar.gz -C /Users/apple/Desktop polymarket

# Copy to server
scp polymarket.tar.gz ubuntu@your-server-ip:/home/ubuntu/

# On server: extract
ssh ubuntu@your-server-ip
cd /home/ubuntu
tar -xzvf polymarket.tar.gz
cd polymarket
```

### 5. Configure Environment

```bash
# Create .env file
nano /home/ubuntu/polymarket/.env
```

Add your credentials:
```
PRIVATE_KEY=0x...
API_KEY=...
API_SECRET=...
API_PASSPHRASE=...
FUNDER_ADDRESS=0x...
SIGNATURE_TYPE=1
```

### 6. Install Dependencies & Build

```bash
cd /home/ubuntu/polymarket
npm install
npm run build
```

### 7. Install Systemd Service

```bash
# Copy service file
sudo cp deploy/copytrade.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable copytrade

# Start the service
sudo systemctl start copytrade
```

### 8. Monitor

```bash
# Check status
sudo systemctl status copytrade

# View logs (live)
sudo journalctl -u copytrade -f

# View last 100 lines
sudo journalctl -u copytrade -n 100
```

## Configuration

Environment variables in `/home/ubuntu/polymarket/.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `POLL_INTERVAL` | Seconds between polls | 60 |
| `MAX_TRADE_AGE` | Max trade age in minutes | 60 |
| `CONFIRM` | Must be `YES_TO_COPYTRADE` for live mode | - |

## Commands

```bash
# Restart service
sudo systemctl restart copytrade

# Stop service
sudo systemctl stop copytrade

# Disable on boot
sudo systemctl disable copytrade
```

## Troubleshooting

### Cloudflare Block

If you see "blocked" errors:
1. Try a different cloud region
2. Add a residential proxy (see below)

### Add Proxy Support

Edit `.env`:
```
HTTPS_PROXY=http://user:pass@proxy.example.com:8080
```

### Check Positions

```bash
cd /home/ubuntu/polymarket
sqlite3 data/markets.db "SELECT * FROM copied_positions WHERE status='open';"
```

## Cost Summary

| Setup | Monthly Cost |
|-------|--------------|
| Oracle Cloud Free Tier | $0 |
| AWS Free Tier (12 months) | $0 |
| AWS after free tier | ~$8 |
| + Residential Proxy (if needed) | ~$6 |
