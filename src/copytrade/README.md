# Polymarket Copytrade System

Automated copy trading system for Polymarket. Monitors target wallets and automatically copies their trades with configurable sizing and guardrails.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         COPYTRADE SYSTEM                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐         ┌──────────────┐                      │
│  │   DAEMON     │         │  DASHBOARD   │                      │
│  │              │         │              │                      │
│  │ Polls every  │         │  Web UI on   │                      │
│  │ 10 seconds   │         │  port 3457   │                      │
│  │              │         │              │                      │
│  │ - Fetch      │         │ - View stats │                      │
│  │   trades     │         │ - Manage     │                      │
│  │ - Apply      │◄───────►│   targets    │                      │
│  │   guardrails │   DB    │ - Configure  │                      │
│  │ - Place      │         │   settings   │                      │
│  │   orders     │         │ - Reconcile  │                      │
│  └──────────────┘         └──────────────┘                      │
│         │                        │                               │
│         ▼                        ▼                               │
│  ┌─────────────────────────────────────────┐                    │
│  │              SQLite Database             │                    │
│  │                                          │                    │
│  │  - copy_targets (wallets to copy)       │                    │
│  │  - copied_trades (trade history)        │                    │
│  │  - copied_positions (open/closed)       │                    │
│  │  - copytrade_runs (poll history)        │                    │
│  │  - global_config (default settings)     │                    │
│  │  - operating_account (master balance)   │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Description |
|-----------|------|-------------|
| Daemon | `daemon.ts` | Background worker that polls and copies trades |
| Dashboard | `dashboard.ts` | Web UI for monitoring and configuration |
| Copier | `copier.ts` | Core logic for trade evaluation and execution |
| Storage | `storage.ts` | SQLite database operations |
| Data API | `data-api.ts` | Polymarket API client |
| Types | `types.ts` | TypeScript interfaces and defaults |

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Run dashboard (UI)
npm run copytrade:dashboard

# Run daemon in dry-run mode (no real trades)
npm run copytrade:daemon -- --dry-run

# Run daemon in live mode
CONFIRM=YES_TO_COPYTRADE npm run copytrade:daemon
```

### Production (Server)

Both services run as systemd units:

```bash
# Check status
sudo systemctl status copytrade-dashboard
sudo systemctl status copytrade-daemon

# View logs
sudo journalctl -u copytrade-daemon -f

# Restart
sudo systemctl restart copytrade-daemon
sudo systemctl restart copytrade-dashboard
```

## Configuration

### Environment Variables (.env)

```bash
# Polymarket API credentials
POLY_API_KEY=your_api_key
POLY_API_SECRET=your_api_secret
POLY_PASSPHRASE=your_passphrase

# Wallet
PRIVATE_KEY=your_private_key
FUNDER_ADDRESS=0x...  # Your Polymarket wallet address

# Optional overrides
POLL_INTERVAL=10      # Seconds between polls (default: 10)
MAX_TRADE_AGE=60      # Minutes to look back for trades (default: 60)
```

### Global Settings (via Dashboard)

| Setting | Default | Description |
|---------|---------|-------------|
| Sizing Mode | `conviction` | How to calculate trade size |
| Copy Ratio | `10%` | For trades >$5, copy this % of target's trade |
| Max Cost/Trade | `$10` | Maximum spend per trade |
| Max Exposure | `$50` | Maximum total exposure per target |
| Min Price | `0.01` | Skip trades below this price |
| Max Price | `0.99` | Skip trades above this price |

## Conviction Sizing Strategy

The default sizing mode that adapts to the target's conviction level:

```
Target Trade Value    Action
─────────────────────────────────────────────
< $1                  SKIP (dust)
$1 - $5               MATCH 1:1 (same dollar amount)
> $5                  max($1, copyRatio × value), capped at maxCost
```

**Example with 10% ratio, $10 max:**

| Target Trade | Our Copy | Reasoning |
|--------------|----------|-----------|
| $0.50 | Skip | Dust trade |
| $3.00 | $3.00 | Match 1:1 (small conviction) |
| $5.00 | $5.00 | Match 1:1 (at threshold) |
| $20.00 | $2.00 | 10% × $20 = $2 |
| $150.00 | $10.00 | 10% × $150 = $15, capped at $10 |

## Subledger System

Each target wallet has its own virtual balance for tracking:

```
Operating Account (Master)
├── Total Deposited: $500
├── Total Withdrawn: $0
├── Allocated to Wallets: $200
└── Available: $300

Target Wallet: whale.eth
├── Deposited: $100
├── Current Exposure: $45
├── Realized P&L: +$12
└── Available: $67
```

**Fund Flow:**
1. Deposit to Operating Account (real USDC must exist on Polymarket)
2. Allocate from Operating → Target Wallet
3. Daemon uses Target Wallet balance for trades
4. Withdraw from Target → Operating when done

## Dashboard API Endpoints

### Summary & Stats
- `GET /api/summary` - Dashboard overview stats
- `GET /api/operating` - Operating account balance
- `GET /api/config` - Global settings
- `PATCH /api/config` - Update global settings

### Positions
- `GET /api/positions` - Open positions with market info
- `GET /api/positions/closed` - Closed positions with P&L

### Trades & Runs
- `GET /api/trades` - Recent copied trades
- `GET /api/runs` - Poll history

### Target Management
- `GET /api/targets` - List all targets
- `POST /api/targets` - Add new target
- `PATCH /api/targets/:address` - Enable/disable target
- `DELETE /api/targets/:address` - Remove target

### Wallet Operations
- `GET /api/wallets/stats` - All wallet stats
- `POST /api/wallets/:address/deposit` - Deposit to wallet
- `POST /api/wallets/:address/withdraw` - Withdraw from wallet
- `GET /api/wallets/:address/config` - Get wallet config
- `PATCH /api/wallets/:address/config` - Update wallet config

### Reconciliation
- `GET /api/reconcile` - Compare our tracking vs Polymarket reality

## Guardrails

Every trade goes through these checks:

| Rule | Description |
|------|-------------|
| Side Filter | Only copy BUYs, SELLs, or BOTH |
| Price Range | Skip if price outside min/max |
| Min Trade Size | Skip dust trades |
| Max Cost/Trade | Cap individual trade cost |
| Max Exposure | Cap total exposure per target |
| Available Balance | Check subledger has funds |
| Max Trades/Run | Limit trades per poll cycle |
| Max Cost/Run | Limit total spend per poll cycle |

## Rate Limits

Polymarket API limits (we use <1%):

| Endpoint | Limit | Our Usage |
|----------|-------|-----------|
| `/trades` | 200/10s | ~3-6/min |
| `POST /order` | 3,600/min | ~0-10/min |

Safe to poll every 10 seconds with 3-5 targets.

## Database Schema

### copy_targets
```sql
address TEXT PRIMARY KEY    -- Target wallet address
alias TEXT                  -- Display name
enabled INTEGER            -- 1=active, 0=paused
total_deposited REAL       -- Subledger deposits
total_withdrawn REAL       -- Subledger withdrawals
max_cost_per_trade REAL    -- Override global
max_exposure REAL          -- Override global
sizing_mode TEXT           -- Override global
copy_ratio REAL            -- Override global (for conviction mode)
```

### copied_trades
```sql
id TEXT PRIMARY KEY
original_trade_id TEXT     -- Target's transaction hash
target_address TEXT        -- Who we copied
token_id TEXT              -- Polymarket token
side TEXT                  -- BUY or SELL
original_price REAL        -- Target's price
original_size REAL         -- Target's size
copy_price REAL            -- Our execution price
copy_size REAL             -- Our size
copy_cost REAL             -- Our cost
status TEXT                -- placed, skipped, failed
market_title TEXT          -- Market name
market_slug TEXT           -- URL slug
event_slug TEXT            -- Event URL slug
```

### copied_positions
```sql
id TEXT PRIMARY KEY
target_address TEXT
token_id TEXT
status TEXT                -- open or closed
shares REAL
avg_entry_price REAL
total_cost REAL
exit_price REAL            -- When closed
exit_proceeds REAL         -- When closed
pnl REAL                   -- Realized P&L
```

## Server Setup

### Systemd Services

**Dashboard** (`/etc/systemd/system/copytrade-dashboard.service`):
```ini
[Unit]
Description=Copytrade Dashboard
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/polymarket
ExecStart=/usr/bin/node /home/ubuntu/polymarket/dist/copytrade/dashboard.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Daemon** (`/etc/systemd/system/copytrade-daemon.service`):
```ini
[Unit]
Description=Copytrade Daemon - Auto copy trading
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/polymarket
ExecStart=/usr/bin/node /home/ubuntu/polymarket/dist/copytrade/daemon.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=CONFIRM=YES_TO_COPYTRADE
EnvironmentFile=/home/ubuntu/polymarket/.env

[Install]
WantedBy=multi-user.target
```

### Deployment

```bash
# From local machine
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='*.db' \
  -e "ssh -i /path/to/key.pem" \
  /path/to/polymarket/ ubuntu@server:/home/ubuntu/polymarket/

# On server
cd /home/ubuntu/polymarket
npm run build
sudo systemctl restart copytrade-daemon copytrade-dashboard
```

## Troubleshooting

### Daemon won't start
```bash
# Check logs
sudo journalctl -u copytrade-daemon -n 100

# Common issues:
# - Missing CONFIRM=YES_TO_COPYTRADE
# - Missing .env file
# - API credentials invalid
```

### Trades not copying
1. Check target is enabled in dashboard
2. Check target wallet has balance (Subledger)
3. Check guardrails aren't blocking (view trade details in dashboard)
4. Check rate limits in logs

### Market links broken
- Old trades may have missing `event_slug`
- New trades will have correct links: `/event/{eventSlug}/{slug}`

### Reconciliation mismatch
- Our tracking may drift from Polymarket reality
- Use `/api/reconcile` endpoint to compare
- Manual trades on Polymarket won't be tracked

## Files

```
src/copytrade/
├── README.md          # This file
├── types.ts           # TypeScript interfaces, defaults
├── storage.ts         # SQLite database layer
├── data-api.ts        # Polymarket API client
├── copier.ts          # Core copy logic + guardrails
├── daemon.ts          # Background polling worker
├── dashboard.ts       # Web UI + REST API
├── index.ts           # CLI entry point
└── sell-all.ts        # Emergency sell script
```

## Emergency

### Stop all trading
```bash
sudo systemctl stop copytrade-daemon
```

### Sell all positions
```bash
CONFIRM=YES npm run copytrade:sell-all
```

### Pause all targets (via API)
```bash
curl -X POST http://localhost:3457/api/targets/pause-all
```
