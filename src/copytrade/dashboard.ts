/**
 * Copytrade Dashboard - Simple web UI to monitor copy trading
 *
 * Usage:
 *   npm run copytrade:dashboard
 *   Open http://localhost:3456
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import { CopytradeStorage } from './storage';
import { PolymarketDataApi } from './data-api';

const PORT = parseInt(process.env.COPYTRADE_DASHBOARD_PORT || '3457', 10);

const app = express();
app.use(express.json());

// Initialize storage
const storage = new CopytradeStorage();
const dataApi = new PolymarketDataApi();

// ============ API Endpoints ============

// Get dashboard summary
app.get('/api/summary', (req: Request, res: Response) => {
  try {
    const positionStats = storage.getPositionStats();
    const stats = storage.getStats();
    const openPositions = storage.getOpenPositions();
    const targets = storage.getTargets(false);

    // Calculate total exposure
    const totalExposure = openPositions.reduce((sum, p) => sum + p.totalCost, 0);

    res.json({
      exposure: {
        total: totalExposure,
        maxPerTarget: 50, // from config
      },
      positions: {
        open: positionStats.openPositions,
        closed: positionStats.closedPositions,
        totalInvested: positionStats.totalInvested,
        totalPnl: positionStats.totalPnl,
        winRate: positionStats.winRate,
      },
      activity: {
        totalRuns: stats.totalRuns,
        totalTradesCopied: stats.totalTradesCopied,
        totalCost: stats.totalCost,
      },
      targets: {
        total: targets.length,
        enabled: targets.filter(t => t.enabled).length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get open positions
app.get('/api/positions', (req: Request, res: Response) => {
  try {
    const positions = storage.getOpenPositions();
    res.json(positions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get closed positions
app.get('/api/positions/closed', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const positions = storage.getClosedPositions(limit);
    res.json(positions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent copied trades
app.get('/api/trades', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const trades = storage.getCopiedTrades({ limit });
    res.json(trades);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent runs
app.get('/api/runs', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const runs = storage.getRuns(limit);
    res.json(runs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get targets
app.get('/api/targets', (req: Request, res: Response) => {
  try {
    const targets = storage.getTargets(false);

    // Get exposure for each target
    const targetsWithExposure = targets.map(t => ({
      ...t,
      exposure: storage.getTotalExposure(t.address),
    }));

    res.json(targetsWithExposure);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Pause all targets
app.post('/api/targets/pause-all', (req: Request, res: Response) => {
  try {
    const targets = storage.getTargets(false);
    for (const t of targets) {
      storage.setTargetEnabled(t.address, false);
    }
    res.json({ success: true, message: `Paused ${targets.length} targets` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Resume all targets
app.post('/api/targets/resume-all', (req: Request, res: Response) => {
  try {
    const targets = storage.getTargets(false);
    for (const t of targets) {
      storage.setTargetEnabled(t.address, true);
    }
    res.json({ success: true, message: `Resumed ${targets.length} targets` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Add target
app.post('/api/targets', (req: Request, res: Response) => {
  try {
    const { address, alias } = req.body;
    if (!address) {
      return res.status(400).json({ error: 'Address required' });
    }
    storage.addTarget(address, alias);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle target enabled
app.patch('/api/targets/:address', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { enabled } = req.body;
    storage.setTargetEnabled(address, enabled);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete target
app.delete('/api/targets/:address', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    storage.removeTarget(address);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get target's recent trades from Polymarket
app.get('/api/targets/:address/trades', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = parseInt(req.query.limit as string || '20', 10);
    const trades = await dataApi.getTradesForWallet(address, { limit });
    res.json(trades);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Dashboard HTML ============

app.get('/', (req: Request, res: Response) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copytrade Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 { color: #fff; margin-bottom: 20px; }
    h2 { color: #888; font-size: 14px; text-transform: uppercase; margin-bottom: 10px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }

    .card {
      background: #1a1a1a;
      border-radius: 8px;
      padding: 20px;
      border: 1px solid #333;
    }

    .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; color: #fff; }
    .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
    .stat-value.positive { color: #22c55e; }
    .stat-value.negative { color: #ef4444; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px; border-bottom: 1px solid #333; color: #888; font-weight: 500; }
    td { padding: 10px; border-bottom: 1px solid #222; }
    tr:hover { background: #222; }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge.buy { background: #22c55e33; color: #22c55e; }
    .badge.sell { background: #ef444433; color: #ef4444; }
    .badge.open { background: #3b82f633; color: #3b82f6; }
    .badge.closed { background: #6b728033; color: #9ca3af; }
    .badge.placed { background: #22c55e33; color: #22c55e; }
    .badge.skipped { background: #f59e0b33; color: #f59e0b; }
    .badge.failed { background: #ef444433; color: #ef4444; }
    .badge.enabled { background: #22c55e33; color: #22c55e; }
    .badge.disabled { background: #6b728033; color: #9ca3af; }

    .address { font-family: monospace; font-size: 12px; }
    .truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .btn {
      background: #333;
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      margin-left: 8px;
    }
    .btn:hover { background: #444; }
    .btn.danger { background: #7f1d1d; }
    .btn.danger:hover { background: #991b1b; }
    .btn.success { background: #14532d; }
    .btn.success:hover { background: #166534; }
    .btn.small { padding: 4px 10px; font-size: 11px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .last-update { color: #666; font-size: 12px; }

    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab {
      padding: 8px 16px;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 4px;
      cursor: pointer;
      color: #888;
    }
    .tab.active { background: #333; color: #fff; border-color: #555; }
    .tab:hover { background: #222; }

    .section { display: none; }
    .section.active { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Copytrade Dashboard</h1>
    <div>
      <span class="last-update" id="lastUpdate">Loading...</span>
      <button class="btn" onclick="refreshAll()">Refresh</button>
      <button class="btn success" id="resumeAllBtn" onclick="resumeAll()">Resume All</button>
      <button class="btn danger" id="pauseAllBtn" onclick="pauseAll()">Pause All</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Exposure</h2>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value" id="totalExposure">$0</div>
          <div class="stat-label">Total Invested</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="openPositions">0</div>
          <div class="stat-label">Open Positions</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Performance</h2>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value" id="totalPnl">$0</div>
          <div class="stat-label">Realized PnL</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="winRate">0%</div>
          <div class="stat-label">Win Rate</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Activity</h2>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value" id="tradesCopied">0</div>
          <div class="stat-label">Trades Copied</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="totalRuns">0</div>
          <div class="stat-label">Poll Runs</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Targets</h2>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-value" id="targetsEnabled">0</div>
          <div class="stat-label">Active Targets</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="targetsTotal">0</div>
          <div class="stat-label">Total Targets</div>
        </div>
      </div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="showSection('positions')">Positions</div>
    <div class="tab" onclick="showSection('trades')">Recent Trades</div>
    <div class="tab" onclick="showSection('targets')">Targets</div>
    <div class="tab" onclick="showSection('runs')">Run History</div>
  </div>

  <div id="positions" class="section active">
    <div class="card">
      <h2>Open Positions</h2>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Shares</th>
            <th>Entry Price</th>
            <th>Cost</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody id="positionsTable"></tbody>
      </table>
    </div>
  </div>

  <div id="trades" class="section">
    <div class="card">
      <h2>Recent Copied Trades</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Market</th>
            <th>Side</th>
            <th>Price</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody id="tradesTable"></tbody>
      </table>
    </div>
  </div>

  <div id="targets" class="section">
    <div class="card">
      <h2>Target Wallets</h2>
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th>Alias</th>
            <th>Exposure</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="targetsTable"></tbody>
      </table>
      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;">
        <input type="text" id="newTargetAddress" placeholder="0x... wallet address" style="background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;width:350px;font-family:monospace;">
        <input type="text" id="newTargetAlias" placeholder="Alias (optional)" style="background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;width:150px;margin-left:8px;">
        <button class="btn success" onclick="addTarget()">Add Target</button>
      </div>
    </div>
  </div>

  <div id="runs" class="section">
    <div class="card">
      <h2>Run History</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Target</th>
            <th>Found</th>
            <th>Copied</th>
            <th>Skipped</th>
            <th>Failed</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody id="runsTable"></tbody>
      </table>
    </div>
  </div>

  <script>
    function showSection(name) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(name).classList.add('active');
      event.target.classList.add('active');
    }

    function formatDate(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      return d.toLocaleString();
    }

    function formatAddress(addr) {
      if (!addr) return '-';
      return addr.substring(0, 10) + '...' + addr.substring(addr.length - 6);
    }

    function formatMoney(n) {
      if (n === null || n === undefined) return '-';
      return '$' + n.toFixed(2);
    }

    async function fetchSummary() {
      const res = await fetch('/api/summary');
      const data = await res.json();

      document.getElementById('totalExposure').textContent = formatMoney(data.positions.totalInvested);
      document.getElementById('openPositions').textContent = data.positions.open;

      const pnl = data.positions.totalPnl;
      const pnlEl = document.getElementById('totalPnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + formatMoney(pnl);
      pnlEl.className = 'stat-value ' + (pnl >= 0 ? 'positive' : 'negative');

      document.getElementById('winRate').textContent = data.positions.winRate.toFixed(1) + '%';
      document.getElementById('tradesCopied').textContent = data.activity.totalTradesCopied;
      document.getElementById('totalRuns').textContent = data.activity.totalRuns;
      document.getElementById('targetsEnabled').textContent = data.targets.enabled;
      document.getElementById('targetsTotal').textContent = data.targets.total;
    }

    async function fetchPositions() {
      const res = await fetch('/api/positions');
      const positions = await res.json();

      const tbody = document.getElementById('positionsTable');
      tbody.innerHTML = positions.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:#666">No open positions</td></tr>'
        : positions.map(p => \`
          <tr>
            <td class="address truncate">\${p.tokenId.substring(0, 20)}...</td>
            <td>\${p.shares.toFixed(1)}</td>
            <td>\${formatMoney(p.avgEntryPrice)}</td>
            <td>\${formatMoney(p.totalCost)}</td>
            <td>\${formatDate(p.openedAt)}</td>
          </tr>
        \`).join('');
    }

    function formatMarket(title, slug, txHash) {
      const displayTitle = title ? (title.length > 50 ? title.substring(0, 50) + '...' : title) : 'Unknown';
      const polyLink = slug ? \`https://polymarket.com/event/\${slug}\` : null;
      const txLink = txHash ? \`https://polygonscan.com/tx/\${txHash}\` : null;

      let html = \`<span title="\${title || ''}">\${displayTitle}</span>\`;
      if (polyLink || txLink) {
        html += '<br><span style="font-size:11px">';
        if (polyLink) html += \`<a href="\${polyLink}" target="_blank" style="color:#3b82f6">Market</a>\`;
        if (polyLink && txLink) html += ' · ';
        if (txLink) html += \`<a href="\${txLink}" target="_blank" style="color:#888">Tx</a>\`;
        html += '</span>';
      }
      return html;
    }

    async function fetchTrades() {
      const res = await fetch('/api/trades?limit=30');
      const trades = await res.json();

      const tbody = document.getElementById('tradesTable');
      tbody.innerHTML = trades.length === 0
        ? '<tr><td colspan="6" style="text-align:center;color:#666">No trades yet</td></tr>'
        : trades.map(t => \`
          <tr>
            <td style="white-space:nowrap">\${formatDate(t.createdAt)}</td>
            <td style="max-width:300px">\${formatMarket(t.marketTitle, t.marketSlug, t.originalTradeId)}</td>
            <td><span class="badge \${t.side.toLowerCase()}">\${t.side}</span></td>
            <td>\${formatMoney(t.originalPrice)}</td>
            <td><span class="badge \${t.status}">\${t.status}</span></td>
            <td class="truncate" title="\${t.skipReason || ''}" style="max-width:200px;color:#888;font-size:12px">\${t.skipReason || '-'}</td>
          </tr>
        \`).join('');
    }

    async function fetchTargets() {
      const res = await fetch('/api/targets');
      const targets = await res.json();

      const tbody = document.getElementById('targetsTable');
      tbody.innerHTML = targets.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:#666">No targets configured</td></tr>'
        : targets.map(t => \`
          <tr>
            <td class="address" title="\${t.address}">\${formatAddress(t.address)}</td>
            <td>\${t.alias || '-'}</td>
            <td>\${formatMoney(t.exposure)} / $50</td>
            <td><span class="badge \${t.enabled ? 'enabled' : 'disabled'}">\${t.enabled ? 'Enabled' : 'Disabled'}</span></td>
            <td>
              \${t.enabled
                ? \`<button class="btn small danger" onclick="toggleTarget('\${t.address}', false)">Pause</button>\`
                : \`<button class="btn small success" onclick="toggleTarget('\${t.address}', true)">Resume</button>\`
              }
              <button class="btn small" onclick="removeTarget('\${t.address}')" title="Remove target">X</button>
            </td>
          </tr>
        \`).join('');
    }

    async function toggleTarget(address, enabled) {
      try {
        await fetch(\`/api/targets/\${encodeURIComponent(address)}\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function removeTarget(address) {
      if (!confirm('Remove this target? (Positions will be kept)')) return;
      try {
        await fetch(\`/api/targets/\${encodeURIComponent(address)}\`, { method: 'DELETE' });
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function addTarget() {
      const address = document.getElementById('newTargetAddress').value.trim();
      const alias = document.getElementById('newTargetAlias').value.trim();
      if (!address) { alert('Enter a wallet address'); return; }
      try {
        await fetch('/api/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, alias: alias || undefined })
        });
        document.getElementById('newTargetAddress').value = '';
        document.getElementById('newTargetAlias').value = '';
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function pauseAll() {
      if (!confirm('Pause ALL targets? The daemon will stop copying trades.')) return;
      try {
        await fetch('/api/targets/pause-all', { method: 'POST' });
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function resumeAll() {
      try {
        await fetch('/api/targets/resume-all', { method: 'POST' });
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function fetchRuns() {
      const res = await fetch('/api/runs?limit=20');
      const runs = await res.json();

      const tbody = document.getElementById('runsTable');
      tbody.innerHTML = runs.length === 0
        ? '<tr><td colspan="7" style="text-align:center;color:#666">No runs yet</td></tr>'
        : runs.map(r => \`
          <tr>
            <td>\${formatDate(r.startedAt)}</td>
            <td class="address">\${formatAddress(r.targetAddress)}</td>
            <td>\${r.tradesFound}</td>
            <td>\${r.tradesCopied}</td>
            <td>\${r.tradesSkipped}</td>
            <td>\${r.tradesFailed}</td>
            <td>\${formatMoney(r.totalCost)}</td>
          </tr>
        \`).join('');
    }

    async function refreshAll() {
      document.getElementById('lastUpdate').textContent = 'Updating...';
      await Promise.all([
        fetchSummary(),
        fetchPositions(),
        fetchTrades(),
        fetchTargets(),
        fetchRuns(),
      ]);
      document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    }

    // Initial load
    refreshAll();

    // Auto-refresh every 30 seconds
    setInterval(refreshAll, 30000);
  </script>
</body>
</html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         COPYTRADE DASHBOARD                           ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Dashboard running at: http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('');
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  storage.close();
  process.exit(0);
});
