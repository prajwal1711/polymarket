/**
 * Copytrade Dashboard - Simple web UI to monitor copy trading
 *
 * Usage:
 *   npm run copytrade:dashboard
 *   Open http://localhost:3456
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { CopytradeStorage } from './storage';
import { PolymarketDataApi } from './data-api';

const PORT = parseInt(process.env.COPYTRADE_DASHBOARD_PORT || '3457', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';

// Generate a session secret for signing cookies
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Simple session store (in-memory, resets on restart)
const sessions = new Set<string>();

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function isAuthenticated(req: Request): boolean {
  const token = req.cookies?.session;
  return token && sessions.has(token);
}

// Auth middleware - allows /login and /api/login through
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow login page and login API
  if (req.path === '/login' || req.path === '/api/login') {
    return next();
  }

  if (!isAuthenticated(req)) {
    // For API calls, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // For page requests, redirect to login
    return res.redirect('/login');
  }

  next();
}

const app = express();
app.use(express.json());
app.use(cookieParser());

// Initialize storage
const storage = new CopytradeStorage();
const dataApi = new PolymarketDataApi();

// Apply auth middleware to all routes
app.use(authMiddleware);

// ============ Auth Endpoints ============

// Login page
app.get('/login', (req: Request, res: Response) => {
  // If already logged in, redirect to dashboard
  if (isAuthenticated(req)) {
    return res.redirect('/');
  }

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Copytrade Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      color: #fff;
      font-size: 24px;
      margin-bottom: 8px;
      text-align: center;
    }
    .subtitle {
      color: #888;
      font-size: 14px;
      text-align: center;
      margin-bottom: 30px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      color: #888;
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    input[type="password"] {
      width: 100%;
      background: #222;
      border: 1px solid #444;
      color: #fff;
      padding: 14px;
      border-radius: 6px;
      font-size: 16px;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: #666;
    }
    button {
      width: 100%;
      background: #22c55e;
      color: #fff;
      border: none;
      padding: 14px;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #16a34a;
    }
    .error {
      background: #7f1d1d;
      color: #fca5a5;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .error.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Copytrade Dashboard</h1>
    <p class="subtitle">Enter password to continue</p>
    <div class="error" id="error">Invalid password</div>
    <form id="loginForm">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter password" autofocus required>
      </div>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });

        if (res.ok) {
          window.location.href = '/';
        } else {
          errorEl.classList.add('show');
          document.getElementById('password').value = '';
          document.getElementById('password').focus();
        }
      } catch (err) {
        errorEl.classList.add('show');
      }
    });
  </script>
</body>
</html>
  `);
});

// Login API
app.post('/api/login', (req: Request, res: Response) => {
  const { password } = req.body;

  if (password === DASHBOARD_PASSWORD) {
    const token = generateSessionToken();
    sessions.add(token);

    // Set cookie (httpOnly for security, 7 day expiry)
    res.cookie('session', token, {
      httpOnly: true,
      secure: false, // Set to true if using HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'strict',
    });

    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout API
app.post('/api/logout', (req: Request, res: Response) => {
  const token = req.cookies?.session;
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie('session');
  res.json({ success: true });
});

// ============ API Endpoints ============

// Get dashboard summary
app.get('/api/summary', (req: Request, res: Response) => {
  try {
    const positionStats = storage.getPositionStats();
    const stats = storage.getStats();
    const openPositions = storage.getOpenPositions();
    const targets = storage.getTargets(false);
    const pendingOrders = storage.getPendingOrderCount();

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
        pendingOrders: pendingOrders,
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

// Get open positions (with target alias and market info)
app.get('/api/positions', (req: Request, res: Response) => {
  try {
    const positions = storage.getOpenPositions();
    const targets = storage.getTargets(false);

    // Create a map of address -> alias for quick lookup
    const aliasMap = new Map<string, string>();
    for (const t of targets) {
      aliasMap.set(t.address.toLowerCase(), t.alias || t.address.substring(0, 10) + '...');
    }

    // Get market info from trades for each position's token
    const trades = storage.getCopiedTrades({ limit: 500 });
    const marketInfoMap = new Map<string, { title: string; slug: string; eventSlug: string }>();
    for (const trade of trades) {
      if (trade.marketTitle && !marketInfoMap.has(trade.tokenId)) {
        marketInfoMap.set(trade.tokenId, {
          title: trade.marketTitle,
          slug: trade.marketSlug || '',
          eventSlug: trade.eventSlug || '',
        });
      }
    }

    // Enrich positions
    const enrichedPositions = positions.map(pos => {
      const marketInfo = marketInfoMap.get(pos.tokenId);
      return {
        ...pos,
        targetAlias: aliasMap.get(pos.targetAddress.toLowerCase()) || pos.targetAddress.substring(0, 10) + '...',
        marketTitle: marketInfo?.title || null,
        marketSlug: marketInfo?.slug || null,
        eventSlug: marketInfo?.eventSlug || null,
      };
    });

    res.json(enrichedPositions);
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

// Manually settle a position (mark as won or lost)
app.post('/api/positions/:id/settle', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { outcome } = req.body; // 'won' or 'lost'

    if (outcome !== 'won' && outcome !== 'lost') {
      return res.status(400).json({ error: 'Outcome must be "won" or "lost"' });
    }

    // Find the position by ID
    const positions = storage.getOpenPositions();
    const position = positions.find(p => p.id === id);

    if (!position) {
      return res.status(404).json({ error: 'Open position not found' });
    }

    // Settlement price: 1 if won, 0 if lost
    const settlementPrice = outcome === 'won' ? 1 : 0;

    const result = storage.closePositionAsSettled({
      targetAddress: position.targetAddress,
      tokenId: position.tokenId,
      settlementPrice,
    });

    if (!result.success) {
      return res.status(500).json({ error: 'Failed to settle position' });
    }

    res.json({
      success: true,
      outcome,
      pnl: result.position?.pnl,
      shares: result.position?.shares,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Manually record a sale (when you sold via Polymarket directly)
app.post('/api/positions/:id/sold', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { exitPrice } = req.body; // Price per share you sold at (0.00 - 1.00)

    if (exitPrice === undefined || exitPrice < 0 || exitPrice > 1) {
      return res.status(400).json({ error: 'Exit price must be between 0 and 1' });
    }

    // Find the position by ID
    const positions = storage.getOpenPositions();
    const position = positions.find(p => p.id === id);

    if (!position) {
      return res.status(404).json({ error: 'Open position not found' });
    }

    // Calculate proceeds based on exit price
    const exitProceeds = position.shares * exitPrice;

    const result = storage.closePosition({
      targetAddress: position.targetAddress,
      tokenId: position.tokenId,
      exitPrice,
      exitProceeds,
    });

    if (!result.success) {
      return res.status(500).json({ error: 'Failed to record sale' });
    }

    res.json({
      success: true,
      exitPrice,
      exitProceeds,
      pnl: result.position?.pnl,
      shares: result.position?.shares,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent copied trades (with target alias)
app.get('/api/trades', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const trades = storage.getCopiedTrades({ limit });
    const targets = storage.getTargets(false);

    // Create a map of address -> alias for quick lookup
    const aliasMap = new Map<string, string>();
    for (const t of targets) {
      aliasMap.set(t.address.toLowerCase(), t.alias || t.address.substring(0, 10) + '...');
    }

    // Enrich trades with target alias
    const enrichedTrades = trades.map(trade => ({
      ...trade,
      targetAlias: aliasMap.get(trade.targetAddress.toLowerCase()) || trade.targetAddress.substring(0, 10) + '...',
    }));

    res.json(enrichedTrades);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent runs (with target alias)
app.get('/api/runs', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const runs = storage.getRuns(limit);
    const targets = storage.getTargets(false);

    // Create a map of address -> alias for quick lookup
    const aliasMap = new Map<string, string>();
    for (const t of targets) {
      aliasMap.set(t.address.toLowerCase(), t.alias || t.address.substring(0, 10) + '...');
    }

    // Enrich runs with target alias
    const enrichedRuns = runs.map(run => ({
      ...run,
      targetAlias: aliasMap.get(run.targetAddress.toLowerCase()) || run.targetAddress.substring(0, 10) + '...',
    }));

    res.json(enrichedRuns);
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

// ============ Subledger API Endpoints ============

// Get all wallet stats
app.get('/api/wallets/stats', (req: Request, res: Response) => {
  try {
    const stats = storage.getAllWalletStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single wallet stats
app.get('/api/wallets/:address/stats', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const stats = storage.getWalletStats(address);
    if (!stats) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Deposit to wallet
app.post('/api/wallets/:address/deposit', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    const tx = storage.depositToWallet(address, amount, note);
    res.json({ success: true, transaction: tx });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Withdraw from wallet
app.post('/api/wallets/:address/withdraw', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { amount, note } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    const tx = storage.withdrawFromWallet(address, amount, note);
    res.json({ success: true, transaction: tx });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get wallet transactions
app.get('/api/wallets/:address/transactions', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = parseInt(req.query.limit as string || '50', 10);
    const txs = storage.getWalletTransactions(address, limit);
    res.json(txs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get full wallet config
app.get('/api/wallets/:address/config', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const target = storage.getTarget(address);
    if (!target) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    res.json({
      address: target.address,
      alias: target.alias,
      maxCostPerTrade: target.maxCostPerTrade,
      maxExposure: target.maxExposure,
      sizingMode: target.sizingMode,
      fixedDollarAmount: target.fixedDollarAmount,
      copyRatio: target.copyRatio,
      minPrice: target.minPrice,
      maxPrice: target.maxPrice,
      allowOverdraft: target.allowOverdraft,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update wallet config
app.patch('/api/wallets/:address/config', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const config = req.body;
    storage.updateTargetConfig(address, config);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Operating Account API ============

// Get operating account
app.get('/api/operating', (req: Request, res: Response) => {
  try {
    const account = storage.getOperatingAccount();
    res.json(account);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Deposit to operating account
app.post('/api/operating/deposit', (req: Request, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    storage.depositToOperating(amount);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Withdraw from operating account
app.post('/api/operating/withdraw', (req: Request, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    storage.withdrawFromOperating(amount);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Global Config API ============

// Get global config
app.get('/api/config', (req: Request, res: Response) => {
  try {
    const config = storage.getGlobalConfig();
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update global config
app.patch('/api/config', (req: Request, res: Response) => {
  try {
    const config = req.body;
    storage.updateGlobalConfig(config);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============ Reconciliation API ============

// Get our Polymarket wallet state (USDC + positions)
app.get('/api/polymarket/balance', async (req: Request, res: Response) => {
  try {
    const walletAddress = process.env.FUNDER_ADDRESS;
    if (!walletAddress) {
      return res.status(400).json({ error: 'FUNDER_ADDRESS not configured' });
    }

    const state = await dataApi.getWalletState(walletAddress);
    res.json({
      wallet: walletAddress,
      usdcBalance: state.usdcBalance,
      positionValue: state.totalPositionValue,
      totalEquity: state.totalEquity,
      positionCount: state.positions.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Full reconciliation - compare our tracking vs Polymarket reality
app.get('/api/reconcile', async (req: Request, res: Response) => {
  try {
    const walletAddress = process.env.FUNDER_ADDRESS;
    if (!walletAddress) {
      return res.status(400).json({ error: 'FUNDER_ADDRESS not configured' });
    }

    // Get actual Polymarket state
    const polymarket = await dataApi.getWalletState(walletAddress);

    // Get our internal tracking
    const operating = storage.getOperatingAccount();
    const walletStats = storage.getAllWalletStats();

    // Calculate our totals
    const ourTotalDeposited = operating.totalDeposited;
    const ourTotalExposure = walletStats.reduce((sum, w) => sum + w.currentExposure, 0);
    const ourRealizedPnl = walletStats.reduce((sum, w) => sum + w.realizedPnl, 0);
    const ourAvailable = walletStats.reduce((sum, w) => sum + w.availableBalance, 0) + operating.availableBalance;

    // Build position comparison
    const ourPositions = storage.getOpenPositions(); // Get all open positions
    const polymarketPositionsByToken = new Map<string, { size: number; value: number }>();

    for (const pos of polymarket.positions) {
      if (pos.size > 0) {
        polymarketPositionsByToken.set(pos.asset, { size: pos.size, value: pos.size * pos.curPrice });
      }
    }

    const positionDiffs: any[] = [];
    const trackedTokens = new Set<string>();

    for (const ourPos of ourPositions) {
      trackedTokens.add(ourPos.tokenId);
      const pmPos = polymarketPositionsByToken.get(ourPos.tokenId);

      positionDiffs.push({
        tokenId: ourPos.tokenId.substring(0, 20) + '...',
        ourShares: ourPos.shares,
        pmShares: pmPos?.size || 0,
        diff: (pmPos?.size || 0) - ourPos.shares,
        match: Math.abs((pmPos?.size || 0) - ourPos.shares) < 0.01,
      });
    }

    // Check for positions on Polymarket we don't track
    for (const [tokenId, pmPos] of polymarketPositionsByToken) {
      if (!trackedTokens.has(tokenId)) {
        positionDiffs.push({
          tokenId: tokenId.substring(0, 20) + '...',
          ourShares: 0,
          pmShares: pmPos.size,
          diff: pmPos.size,
          match: false,
          untracked: true,
        });
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      polymarket: {
        wallet: walletAddress,
        usdcBalance: polymarket.usdcBalance,
        positionValue: polymarket.totalPositionValue,
        totalEquity: polymarket.totalEquity,
        positionCount: polymarket.positions.length,
      },
      ourTracking: {
        totalDeposited: ourTotalDeposited,
        totalExposure: ourTotalExposure,
        realizedPnl: ourRealizedPnl,
        availableBalance: ourAvailable,
        trackedPositions: ourPositions.length,
      },
      comparison: {
        equityMatch: Math.abs(polymarket.totalEquity - (ourTotalDeposited + ourRealizedPnl)) < 1,
        exposureMatch: Math.abs(polymarket.totalPositionValue - ourTotalExposure) < 1,
        positionDiffs,
      },
    });
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
    .badge.pending { background: #f59e0b33; color: #f59e0b; }
    .badge.placed { background: #22c55e33; color: #22c55e; }
    .badge.filled { background: #22c55e33; color: #22c55e; }
    .badge.skipped { background: #6b728033; color: #9ca3af; }
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

    /* Modal styles */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      max-width: 700px;
      width: 90%;
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      border-bottom: 1px solid #333;
      position: sticky;
      top: 0;
      background: #1a1a1a;
    }
    .modal-header h3 { margin: 0; color: #fff; font-size: 16px; }
    .modal-close {
      background: none;
      border: none;
      color: #888;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .modal-close:hover { color: #fff; }
    .modal-body { padding: 20px; }

    .rule-item {
      display: flex;
      align-items: flex-start;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 8px;
      background: #222;
    }
    .rule-item.passed { border-left: 3px solid #22c55e; }
    .rule-item.failed { border-left: 3px solid #ef4444; }
    .rule-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      margin-right: 12px;
      flex-shrink: 0;
    }
    .rule-icon.passed { background: #22c55e33; color: #22c55e; }
    .rule-icon.failed { background: #ef444433; color: #ef4444; }
    .rule-content { flex: 1; }
    .rule-name { font-weight: 600; color: #fff; margin-bottom: 4px; }
    .rule-details { font-size: 12px; color: #888; }
    .rule-math {
      font-family: monospace;
      font-size: 11px;
      color: #666;
      background: #1a1a1a;
      padding: 4px 8px;
      border-radius: 4px;
      margin-top: 6px;
    }

    .sizing-box {
      background: #222;
      border-radius: 6px;
      padding: 15px;
      margin-top: 15px;
    }
    .sizing-box h4 {
      margin: 0 0 10px 0;
      color: #888;
      font-size: 12px;
      text-transform: uppercase;
    }
    .sizing-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 13px;
    }
    .sizing-row .label { color: #888; }
    .sizing-row .value { color: #fff; font-family: monospace; }

    tr.clickable { cursor: pointer; }
    tr.clickable:hover { background: #333 !important; }

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
      <button class="btn" onclick="showGlobalSettingsModal()" style="background:#4a4a00">Global Settings</button>
      <button class="btn success" id="resumeAllBtn" onclick="resumeAll()">Resume All</button>
      <button class="btn danger" id="pauseAllBtn" onclick="pauseAll()">Pause All</button>
      <button class="btn" onclick="logout()" style="background:#333;margin-left:20px">Logout</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Capital</h2>
      <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
        <div class="stat">
          <div class="stat-value positive" id="allocatableCapital">$0</div>
          <div class="stat-label">Allocatable</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="lockedInWallets">$0</div>
          <div class="stat-label">Locked in Wallets</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="totalExposure">$0</div>
          <div class="stat-label">In Positions</div>
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
          <div class="stat-value" id="pendingOrders">0</div>
          <div class="stat-label">Pending Orders</div>
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
    <div class="tab" onclick="showSection('wallets')">Wallets</div>
    <div class="tab" onclick="showSection('reconcile')">Reconcile</div>
    <div class="tab" onclick="showSection('runs')">Run History</div>
  </div>

  <!-- Operating Account Card -->
  <div class="card" style="margin-bottom:20px;background:#1a2a1a;border-color:#2d4a2d">
    <h2 style="color:#4ade80">Operating Account</h2>
    <div class="stat-grid" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat">
        <div class="stat-value" id="opDeposited">$0</div>
        <div class="stat-label">Total Deposited</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="opWithdrawn">$0</div>
        <div class="stat-label">Withdrawn</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="opAllocated">$0</div>
        <div class="stat-label">Allocated to Wallets</div>
      </div>
      <div class="stat">
        <div class="stat-value positive" id="opAvailable">$0</div>
        <div class="stat-label">Available</div>
      </div>
    </div>
    <div style="margin-top:15px;text-align:right">
      <button class="btn success" onclick="showFundingModal('operating', 'deposit')">Deposit</button>
      <button class="btn danger" onclick="showFundingModal('operating', 'withdraw')">Withdraw</button>
    </div>
  </div>

  <!-- Global Config Summary Card -->
  <div class="card" style="margin-bottom:20px;background:#2a2a1a;border-color:#4a4a2d">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="color:#fbbf24">Conviction Sizing (Global Defaults)</h2>
      <button class="btn" onclick="showGlobalSettingsModal()" style="background:#4a4a00">Edit</button>
    </div>
    <div class="stat-grid" style="grid-template-columns: repeat(6, 1fr); margin-top:10px">
      <div class="stat">
        <div class="stat-value" id="gcSizingMode" style="font-size:18px">-</div>
        <div class="stat-label">Sizing Mode</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="gcCopyRatio" style="font-size:18px">-</div>
        <div class="stat-label">Copy Ratio</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="gcMaxCost" style="font-size:18px">-</div>
        <div class="stat-label">Max Cost/Trade</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="gcMaxExposure" style="font-size:18px">-</div>
        <div class="stat-label">Max Exposure</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="gcMinPrice" style="font-size:18px">-</div>
        <div class="stat-label">Min Price</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="gcMaxPrice" style="font-size:18px">-</div>
        <div class="stat-label">Max Price</div>
      </div>
    </div>
    <div style="margin-top:10px;font-size:12px;color:#888">
      <strong>Conviction mode:</strong> Trades $1-$5 matched 1:1 | Trades >$5 scaled by Copy Ratio (min $1, max by Max Cost)
    </div>
  </div>

  <div id="positions" class="section active">
    <div class="card">
      <h2>Open Positions</h2>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th>Market</th>
            <th>Shares</th>
            <th>Entry Price</th>
            <th>Cost</th>
            <th>Opened</th>
            <th>Settle</th>
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
            <th>From</th>
            <th>Market</th>
            <th>Side</th>
            <th>Price</th>
            <th>Shares</th>
            <th>Cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="tradesTable"></tbody>
      </table>
    </div>
  </div>

  <div id="wallets" class="section">
    <div class="card">
      <h2>Wallet Subledgers</h2>
      <table>
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Deposited</th>
            <th>Exposure</th>
            <th>P&L</th>
            <th>Available</th>
            <th>Return</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="walletsTable"></tbody>
      </table>
      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;">
        <input type="text" id="newTargetAddress" placeholder="0x... wallet address" style="background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;width:350px;font-family:monospace;">
        <input type="text" id="newTargetAlias" placeholder="Alias (optional)" style="background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;width:150px;margin-left:8px;">
        <button class="btn success" onclick="addTarget()">Add Wallet</button>
      </div>
    </div>
  </div>

  <div id="reconcile" class="section">
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
        <h2>Polymarket vs Our Tracking</h2>
        <button class="btn" onclick="fetchReconciliation()">Refresh</button>
      </div>

      <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr); gap: 20px">
        <!-- Polymarket Reality -->
        <div style="background:#1a1a2a;border:1px solid #2d2d4a;border-radius:8px;padding:15px">
          <h3 style="color:#818cf8;margin:0 0 15px 0;font-size:14px">POLYMARKET (Actual)</h3>
          <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
            <div class="stat">
              <div class="stat-value" id="pmUsdcBalance">-</div>
              <div class="stat-label">USDC Balance</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="pmPositionValue">-</div>
              <div class="stat-label">Position Value</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="pmTotalEquity">-</div>
              <div class="stat-label">Total Equity</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="pmPositionCount">-</div>
              <div class="stat-label">Positions</div>
            </div>
          </div>
        </div>

        <!-- Our Tracking -->
        <div style="background:#1a2a1a;border:1px solid #2d4a2d;border-radius:8px;padding:15px">
          <h3 style="color:#4ade80;margin:0 0 15px 0;font-size:14px">OUR TRACKING (Subledger)</h3>
          <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr)">
            <div class="stat">
              <div class="stat-value" id="ourDeposited">-</div>
              <div class="stat-label">Total Deposited</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="ourExposure">-</div>
              <div class="stat-label">Current Exposure</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="ourPnl">-</div>
              <div class="stat-label">Realized P&L</div>
            </div>
            <div class="stat">
              <div class="stat-value" id="ourPositions">-</div>
              <div class="stat-label">Tracked Positions</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Match Status -->
      <div id="reconcileStatus" style="margin-top:15px;padding:15px;border-radius:8px;background:#222;text-align:center">
        <span style="color:#888">Click Refresh to load reconciliation data</span>
      </div>
    </div>

    <div class="card">
      <h2>Position Differences</h2>
      <p style="color:#888;font-size:12px;margin-bottom:15px">Compares positions we track vs actual positions on Polymarket</p>
      <table>
        <thead>
          <tr>
            <th>Token ID</th>
            <th>Our Shares</th>
            <th>PM Shares</th>
            <th>Difference</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="reconcileTable">
          <tr><td colspan="5" style="text-align:center;color:#666">No data loaded</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div id="runs" class="section">
    <div class="card">
      <h2>Run History</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>From</th>
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
    // Global variables - must be declared at top to avoid hoisting issues
    let allTrades = [];
    let currentFundingTarget = null;
    let currentFundingType = null;
    let currentSettingsAddress = null;

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
      const [summaryRes, operatingRes] = await Promise.all([
        fetch('/api/summary'),
        fetch('/api/operating')
      ]);
      const data = await summaryRes.json();
      const operating = await operatingRes.json();

      // Capital section
      document.getElementById('allocatableCapital').textContent = formatMoney(operating.availableBalance);
      document.getElementById('lockedInWallets').textContent = formatMoney(operating.totalAllocatedToWallets);
      document.getElementById('totalExposure').textContent = formatMoney(data.positions.totalInvested);
      document.getElementById('openPositions').textContent = data.positions.open;

      const pnl = data.positions.totalPnl;
      const pnlEl = document.getElementById('totalPnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + formatMoney(pnl);
      pnlEl.className = 'stat-value ' + (pnl >= 0 ? 'positive' : 'negative');

      document.getElementById('winRate').textContent = data.positions.winRate.toFixed(1) + '%';
      document.getElementById('tradesCopied').textContent = data.activity.totalTradesCopied;
      document.getElementById('pendingOrders').textContent = data.activity.pendingOrders || 0;
      document.getElementById('totalRuns').textContent = data.activity.totalRuns;
      document.getElementById('targetsEnabled').textContent = data.targets.enabled;
      document.getElementById('targetsTotal').textContent = data.targets.total;
    }

    async function fetchPositions() {
      const res = await fetch('/api/positions');
      const positions = await res.json();

      // Store for modal access
      window.allPositions = positions;

      const tbody = document.getElementById('positionsTable');
      tbody.innerHTML = positions.length === 0
        ? '<tr><td colspan="7" style="text-align:center;color:#666">No open positions</td></tr>'
        : positions.map(p => \`
          <tr>
            <td style="font-size:12px;color:#fbbf24" title="\${p.targetAddress}">\${p.targetAlias || '-'}</td>
            <td style="max-width:250px">\${formatMarket(p.marketTitle, p.marketSlug, p.eventSlug, null)}</td>
            <td>\${p.shares.toFixed(1)}</td>
            <td>\${formatMoney(p.avgEntryPrice)}</td>
            <td>\${formatMoney(p.totalCost)}</td>
            <td>\${formatDate(p.openedAt)}</td>
            <td style="white-space:nowrap">
              <button class="btn small" onclick="showSoldModal('\${p.id}')" title="I sold this manually" style="background:#1e3a5f;color:#60a5fa">Sold</button>
              <button class="btn small success" onclick="settlePosition('\${p.id}', 'won')" title="Market resolved - I won">Won</button>
              <button class="btn small danger" onclick="settlePosition('\${p.id}', 'lost')" title="Market resolved - I lost">Lost</button>
            </td>
          </tr>
        \`).join('');
    }

    function formatMarket(title, slug, eventSlug, txHash) {
      const displayTitle = title ? (title.length > 50 ? title.substring(0, 50) + '...' : title) : 'Unknown';
      // Correct link format: /event/{eventSlug}/{slug}
      const polyLink = (eventSlug && slug) ? \`https://polymarket.com/event/\${eventSlug}/\${slug}\` :
                       eventSlug ? \`https://polymarket.com/event/\${eventSlug}\` : null;
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

      // Store for modal access
      allTrades = trades;

      const tbody = document.getElementById('tradesTable');
      tbody.innerHTML = trades.length === 0
        ? '<tr><td colspan="8" style="text-align:center;color:#666">No trades yet</td></tr>'
        : trades.map(t => \`
          <tr class="clickable" onclick="showTradeModal('\${t.id}')" title="Click to see guardrail details">
            <td style="white-space:nowrap">\${formatDate(t.createdAt)}</td>
            <td style="font-size:12px;color:#fbbf24" title="\${t.targetAddress}">\${t.targetAlias || '-'}</td>
            <td style="max-width:250px">\${formatMarket(t.marketTitle, t.marketSlug, t.eventSlug, t.originalTradeId)}</td>
            <td><span class="badge \${t.side.toLowerCase()}">\${t.side}</span></td>
            <td>\${formatMoney(t.copyPrice || t.originalPrice)}</td>
            <td>\${t.copySize ? t.copySize.toFixed(0) : '-'}</td>
            <td style="font-weight:bold">\${t.copyCost ? formatMoney(t.copyCost) : '-'}</td>
            <td><span class="badge \${t.status}" title="\${t.skipReason || ''}">\${t.status}</span></td>
          </tr>
        \`).join('');
    }

    async function fetchWallets() {
      const res = await fetch('/api/wallets/stats');
      const wallets = await res.json();

      const tbody = document.getElementById('walletsTable');
      tbody.innerHTML = wallets.length === 0
        ? '<tr><td colspan="8" style="text-align:center;color:#666">No wallets configured</td></tr>'
        : wallets.map(w => {
            const returnClass = w.returnPercent >= 0 ? 'positive' : 'negative';
            const returnSign = w.returnPercent >= 0 ? '+' : '';
            const pnlClass = w.realizedPnl >= 0 ? 'positive' : 'negative';
            const pnlSign = w.realizedPnl >= 0 ? '+' : '';
            return \`
          <tr>
            <td>
              <div class="address" title="\${w.address}">\${formatAddress(w.address)}</div>
              <div style="font-size:11px;color:#888">\${w.alias || ''}</div>
            </td>
            <td>\${formatMoney(w.totalDeposited)}</td>
            <td>\${formatMoney(w.currentExposure)}</td>
            <td class="\${pnlClass}">\${pnlSign}\${formatMoney(w.realizedPnl)}</td>
            <td style="font-weight:bold">\${formatMoney(w.availableBalance)}</td>
            <td class="\${returnClass}">\${returnSign}\${w.returnPercent.toFixed(1)}%</td>
            <td><span class="badge \${w.enabled ? 'enabled' : 'disabled'}">\${w.enabled ? 'Active' : 'Paused'}</span></td>
            <td>
              <button class="btn small" onclick="showSettingsModal('\${w.address}')" title="Settings">⚙</button>
              <button class="btn small success" onclick="showFundingModal('\${w.address}', 'deposit')" title="Deposit">+$</button>
              <button class="btn small" onclick="showFundingModal('\${w.address}', 'withdraw')" title="Withdraw">-$</button>
              \${w.enabled
                ? \`<button class="btn small danger" onclick="toggleTarget('\${w.address}', false)">Pause</button>\`
                : \`<button class="btn small success" onclick="toggleTarget('\${w.address}', true)">Resume</button>\`
              }
              <button class="btn small" onclick="removeTarget('\${w.address}')" title="Remove">X</button>
            </td>
          </tr>
        \`}).join('');
    }

    async function fetchOperatingAccount() {
      const res = await fetch('/api/operating');
      const op = await res.json();

      document.getElementById('opDeposited').textContent = formatMoney(op.totalDeposited);
      document.getElementById('opWithdrawn').textContent = formatMoney(op.totalWithdrawn);
      document.getElementById('opAllocated').textContent = formatMoney(op.totalAllocatedToWallets);
      document.getElementById('opAvailable').textContent = formatMoney(op.availableBalance);
    }

    async function fetchReconciliation() {
      try {
        document.getElementById('reconcileStatus').innerHTML = '<span style="color:#888">Loading...</span>';

        const res = await fetch('/api/reconcile');
        const data = await res.json();

        if (data.error) {
          document.getElementById('reconcileStatus').innerHTML = '<span style="color:#ef4444">Error: ' + data.error + '</span>';
          return;
        }

        // Update Polymarket stats
        document.getElementById('pmUsdcBalance').textContent = formatMoney(data.polymarket.usdcBalance);
        document.getElementById('pmPositionValue').textContent = formatMoney(data.polymarket.positionValue);
        document.getElementById('pmTotalEquity').textContent = formatMoney(data.polymarket.totalEquity);
        document.getElementById('pmPositionCount').textContent = data.polymarket.positionCount;

        // Update Our Tracking stats
        document.getElementById('ourDeposited').textContent = formatMoney(data.ourTracking.totalDeposited);
        document.getElementById('ourExposure').textContent = formatMoney(data.ourTracking.totalExposure);
        document.getElementById('ourPnl').textContent = formatMoney(data.ourTracking.realizedPnl);
        document.getElementById('ourPositions').textContent = data.ourTracking.trackedPositions;

        // Update status
        const equityDiff = Math.abs(data.polymarket.totalEquity - (data.ourTracking.totalDeposited + data.ourTracking.realizedPnl));
        const exposureDiff = Math.abs(data.polymarket.positionValue - data.ourTracking.totalExposure);

        let statusHtml = '';
        if (data.comparison.equityMatch && data.comparison.exposureMatch) {
          statusHtml = '<span style="color:#4ade80;font-weight:bold">IN SYNC</span>';
        } else {
          statusHtml = '<span style="color:#f59e0b;font-weight:bold">OUT OF SYNC</span>';
          statusHtml += '<div style="margin-top:8px;font-size:12px;color:#888">';
          if (!data.comparison.equityMatch) {
            statusHtml += 'Equity diff: $' + equityDiff.toFixed(2) + '<br>';
          }
          if (!data.comparison.exposureMatch) {
            statusHtml += 'Exposure diff: $' + exposureDiff.toFixed(2);
          }
          statusHtml += '</div>';
        }
        document.getElementById('reconcileStatus').innerHTML = statusHtml;

        // Update position diffs table
        const tbody = document.getElementById('reconcileTable');
        if (data.comparison.positionDiffs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#666">No positions to compare</td></tr>';
        } else {
          tbody.innerHTML = data.comparison.positionDiffs.map(p => {
            let statusBadge = '';
            if (p.match) {
              statusBadge = '<span class="badge enabled">Match</span>';
            } else if (p.untracked) {
              statusBadge = '<span class="badge" style="background:#1a1a2a;color:#818cf8">Untracked</span>';
            } else if (p.ourShares > 0 && p.pmShares === 0) {
              statusBadge = '<span class="badge danger">Missing on PM</span>';
            } else {
              statusBadge = '<span class="badge" style="background:#451a03;color:#f59e0b">Mismatch</span>';
            }

            const diffClass = p.diff > 0 ? 'positive' : (p.diff < 0 ? 'negative' : '');
            const diffSign = p.diff > 0 ? '+' : '';

            return \`
              <tr>
                <td style="font-family:monospace;font-size:11px">\${p.tokenId}</td>
                <td>\${p.ourShares.toFixed(2)}</td>
                <td>\${p.pmShares.toFixed(2)}</td>
                <td class="\${diffClass}">\${diffSign}\${p.diff.toFixed(2)}</td>
                <td>\${statusBadge}</td>
              </tr>
            \`;
          }).join('');
        }

      } catch (e) {
        document.getElementById('reconcileStatus').innerHTML = '<span style="color:#ef4444">Error: ' + e.message + '</span>';
      }
    }

    async function settlePosition(positionId, outcome) {
      const action = outcome === 'won' ? 'WON (receive $1/share)' : 'LOST (receive $0)';
      if (!confirm(\`Mark this position as \${action}? This cannot be undone.\`)) return;

      try {
        const res = await fetch(\`/api/positions/\${encodeURIComponent(positionId)}/settle\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          alert('Error: ' + (data.error || 'Failed to settle'));
          return;
        }

        const pnlText = data.pnl >= 0 ? '+$' + data.pnl.toFixed(2) : '-$' + Math.abs(data.pnl).toFixed(2);
        alert(\`Position settled as \${outcome.toUpperCase()}. PnL: \${pnlText}\`);
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // ============ Sold Modal Functions ============
    let currentSoldPositionId = null;

    function showSoldModal(positionId) {
      currentSoldPositionId = positionId;
      const position = window.allPositions?.find(p => p.id === positionId);
      if (!position) {
        alert('Position not found');
        return;
      }

      const modal = document.getElementById('soldModal');
      document.getElementById('soldPositionInfo').innerHTML = \`
        <div style="margin-bottom:10px">
          <strong>\${position.marketTitle || 'Unknown Market'}</strong>
        </div>
        <div style="font-size:12px;color:#888">
          Shares: \${position.shares.toFixed(2)} | Entry: $\${position.avgEntryPrice.toFixed(4)} | Cost: $\${position.totalCost.toFixed(2)}
        </div>
      \`;
      document.getElementById('soldExitPrice').value = '';
      document.getElementById('soldProceeds').textContent = '-';
      document.getElementById('soldPnl').textContent = '-';
      document.getElementById('soldExitPrice').focus();

      modal.classList.add('active');
    }

    function closeSoldModal() {
      document.getElementById('soldModal').classList.remove('active');
      currentSoldPositionId = null;
    }

    function updateSoldPreview() {
      const position = window.allPositions?.find(p => p.id === currentSoldPositionId);
      if (!position) return;

      const exitPrice = parseFloat(document.getElementById('soldExitPrice').value);
      if (isNaN(exitPrice) || exitPrice < 0 || exitPrice > 1) {
        document.getElementById('soldProceeds').textContent = '-';
        document.getElementById('soldPnl').textContent = '-';
        return;
      }

      const proceeds = position.shares * exitPrice;
      const pnl = proceeds - position.totalCost;

      document.getElementById('soldProceeds').textContent = '$' + proceeds.toFixed(2);
      document.getElementById('soldPnl').textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
      document.getElementById('soldPnl').style.color = pnl >= 0 ? '#22c55e' : '#ef4444';
    }

    async function submitSold() {
      if (!currentSoldPositionId) return;

      const exitPrice = parseFloat(document.getElementById('soldExitPrice').value);
      if (isNaN(exitPrice) || exitPrice < 0 || exitPrice > 1) {
        alert('Please enter a valid exit price (0.00 - 1.00)');
        return;
      }

      try {
        const res = await fetch(\`/api/positions/\${encodeURIComponent(currentSoldPositionId)}/sold\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exitPrice })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          alert('Error: ' + (data.error || 'Failed to record sale'));
          return;
        }

        const pnlText = data.pnl >= 0 ? '+$' + data.pnl.toFixed(2) : '-$' + Math.abs(data.pnl).toFixed(2);
        alert(\`Sale recorded. Proceeds: $\${data.exitProceeds.toFixed(2)}, PnL: \${pnlText}\`);
        closeSoldModal();
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Close sold modal on overlay click
    document.getElementById('soldModal')?.addEventListener('click', function(e) {
      if (e.target === this) closeSoldModal();
    });

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
            <td style="font-size:12px;color:#fbbf24" title="\${r.targetAddress}">\${r.targetAlias || '-'}</td>
            <td>\${r.tradesFound}</td>
            <td>\${r.tradesCopied}</td>
            <td>\${r.tradesSkipped}</td>
            <td>\${r.tradesFailed}</td>
            <td>\${formatMoney(r.totalCost)}</td>
          </tr>
        \`).join('');
    }

    async function fetchGlobalConfig() {
      const res = await fetch('/api/config');
      const config = await res.json();

      document.getElementById('gcSizingMode').textContent = config.sizingMode || 'conviction';
      document.getElementById('gcCopyRatio').textContent = ((config.copyRatio || 0.1) * 100).toFixed(0) + '%';
      document.getElementById('gcMaxCost').textContent = formatMoney(config.maxCostPerTrade || 10);
      document.getElementById('gcMaxExposure').textContent = formatMoney(config.maxExposurePerTarget || 50);
      document.getElementById('gcMinPrice').textContent = (config.minPrice || 0.01).toFixed(2);
      document.getElementById('gcMaxPrice').textContent = (config.maxPrice || 0.99).toFixed(2);
    }

    async function refreshAll() {
      document.getElementById('lastUpdate').textContent = 'Updating...';
      await Promise.all([
        fetchSummary(),
        fetchPositions(),
        fetchTrades(),
        fetchWallets(),
        fetchOperatingAccount(),
        fetchGlobalConfig(),
        fetchRuns(),
      ]);
      document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login';
      } catch (e) {
        window.location.href = '/login';
      }
    }

    // Initial load
    refreshAll();

    // Auto-refresh every 30 seconds
    setInterval(refreshAll, 30000);

    // ============ Modal Functions ============

    function showTradeModal(tradeId) {
      const trade = allTrades.find(t => t.id === tradeId);
      if (!trade) return;

      const modal = document.getElementById('tradeModal');
      const content = document.getElementById('modalContent');

      // Build modal content
      let html = '<div class="modal-header">';
      html += '<h3>Guardrail Evaluation</h3>';
      html += '<button class="modal-close" onclick="closeModal()">&times;</button>';
      html += '</div>';
      html += '<div class="modal-body">';

      // Trade summary
      html += '<div style="margin-bottom:15px;padding:10px;background:#222;border-radius:6px">';
      html += '<div style="font-weight:600;color:#fff;margin-bottom:5px">' + (trade.marketTitle || 'Unknown Market').substring(0, 60) + '</div>';
      html += '<div style="font-size:12px;color:#888">';
      html += '<span class="badge ' + trade.side.toLowerCase() + '">' + trade.side + '</span> ';
      html += 'at $' + (trade.copyPrice || trade.originalPrice).toFixed(4) + ' ';
      html += '• <span class="badge ' + trade.status + '">' + trade.status.toUpperCase() + '</span>';
      html += '</div>';
      html += '</div>';

      // Check if we have rule evaluation
      const eval_ = trade.ruleEvaluation;
      if (!eval_ || !eval_.rules || eval_.rules.length === 0) {
        html += '<div style="text-align:center;color:#666;padding:20px">No rule evaluation data available for this trade</div>';
      } else {
        // Rules breakdown
        html += '<h4 style="color:#888;font-size:12px;text-transform:uppercase;margin-bottom:10px">Rules Checked</h4>';

        for (const rule of eval_.rules) {
          const statusClass = rule.passed ? 'passed' : 'failed';
          const icon = rule.passed ? '✓' : '✗';

          html += '<div class="rule-item ' + statusClass + '">';
          html += '<div class="rule-icon ' + statusClass + '">' + icon + '</div>';
          html += '<div class="rule-content">';
          html += '<div class="rule-name">' + rule.rule + '</div>';
          html += '<div class="rule-details">';
          html += '<strong>Actual:</strong> ' + rule.actual + ' | ';
          html += '<strong>Required:</strong> ' + rule.threshold;
          html += '</div>';
          if (rule.math) {
            html += '<div class="rule-math">' + rule.math + '</div>';
          }
          html += '</div>';
          html += '</div>';
        }

        // Sizing calculation
        if (eval_.sizingCalculation) {
          const sizing = eval_.sizingCalculation;
          html += '<div class="sizing-box">';
          html += '<h4>Sizing Calculation</h4>';
          html += '<div class="sizing-row"><span class="label">Mode:</span><span class="value">' + sizing.mode + '</span></div>';
          html += '<div class="sizing-row"><span class="label">Input Value:</span><span class="value">' + sizing.inputValue + '</span></div>';
          html += '<div class="sizing-row"><span class="label">Calculated Shares:</span><span class="value">' + sizing.calculatedShares.toFixed(0) + '</span></div>';
          html += '<div class="sizing-row"><span class="label">Final Cost:</span><span class="value">$' + sizing.finalCost.toFixed(4) + '</span></div>';
          html += '</div>';
        }
      }

      html += '</div>';

      content.innerHTML = html;
      modal.classList.add('active');
    }

    function closeModal() {
      document.getElementById('tradeModal').classList.remove('active');
    }

    // Close modal on overlay click
    document.getElementById('tradeModal').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeModal();
        closeFundingModal();
      }
    });

    // ============ Funding Modal Functions ============

    function showFundingModal(target, type) {
      currentFundingTarget = target;
      currentFundingType = type;

      const modal = document.getElementById('fundingModal');
      const title = document.getElementById('fundingTitle');
      const input = document.getElementById('fundingAmount');

      const isOperating = target === 'operating';
      const targetLabel = isOperating ? 'Operating Account' : formatAddress(target);

      title.textContent = (type === 'deposit' ? 'Deposit to ' : 'Withdraw from ') + targetLabel;
      input.value = '';
      input.focus();

      modal.classList.add('active');
    }

    function closeFundingModal() {
      document.getElementById('fundingModal').classList.remove('active');
      currentFundingTarget = null;
      currentFundingType = null;
    }

    async function submitFunding() {
      const amount = parseFloat(document.getElementById('fundingAmount').value);
      const note = document.getElementById('fundingNote').value.trim();

      if (!amount || amount <= 0) {
        alert('Please enter a valid amount');
        return;
      }

      try {
        const isOperating = currentFundingTarget === 'operating';
        const endpoint = isOperating
          ? \`/api/operating/\${currentFundingType}\`
          : \`/api/wallets/\${encodeURIComponent(currentFundingTarget)}/\${currentFundingType}\`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, note: note || undefined })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          alert('Error: ' + (data.error || 'Request failed'));
          return;
        }

        closeFundingModal();
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Close funding modal on overlay click
    document.getElementById('fundingModal').addEventListener('click', function(e) {
      if (e.target === this) closeFundingModal();
    });

    // ============ Settings Modal Functions ============

    async function showSettingsModal(address) {
      currentSettingsAddress = address;

      const modal = document.getElementById('settingsModal');
      const title = document.getElementById('settingsTitle');

      title.textContent = 'Settings: ' + formatAddress(address);

      // Fetch current config
      try {
        const res = await fetch(\`/api/wallets/\${encodeURIComponent(address)}/config\`);
        const config = await res.json();

        // Populate form
        document.getElementById('settingsMaxCost').value = config.maxCostPerTrade || '';
        document.getElementById('settingsMaxExposure').value = config.maxExposure || '';
        document.getElementById('settingsMinPrice').value = config.minPrice || '';
        document.getElementById('settingsMaxPrice').value = config.maxPrice || '';
        document.getElementById('settingsSizingMode').value = config.sizingMode || '';
        document.getElementById('settingsFixedDollar').value = config.fixedDollarAmount || '';
        document.getElementById('settingsCopyRatio').value = config.copyRatio || '';
        document.getElementById('settingsOverdraft').checked = config.allowOverdraft || false;

        // Show/hide mode-specific rows
        updateSizingModeVisibility();

      } catch (e) {
        alert('Error loading settings: ' + e.message);
        return;
      }

      modal.classList.add('active');
    }

    function closeSettingsModal() {
      document.getElementById('settingsModal').classList.remove('active');
      currentSettingsAddress = null;
    }

    function updateSizingModeVisibility() {
      const mode = document.getElementById('settingsSizingMode').value;
      document.getElementById('fixedDollarRow').style.display = mode === 'fixed_dollar' ? 'block' : 'none';
      document.getElementById('copyRatioRow').style.display = mode === 'conviction' ? 'block' : 'none';
    }

    // Add event listener for sizing mode change
    document.getElementById('settingsSizingMode').addEventListener('change', updateSizingModeVisibility);

    async function saveSettings() {
      if (!currentSettingsAddress) return;

      const maxCost = document.getElementById('settingsMaxCost').value;
      const maxExposure = document.getElementById('settingsMaxExposure').value;
      const minPrice = document.getElementById('settingsMinPrice').value;
      const maxPrice = document.getElementById('settingsMaxPrice').value;
      const sizingMode = document.getElementById('settingsSizingMode').value;
      const fixedDollar = document.getElementById('settingsFixedDollar').value;
      const copyRatio = document.getElementById('settingsCopyRatio').value;
      const allowOverdraft = document.getElementById('settingsOverdraft').checked;

      const config = {
        maxCostPerTrade: maxCost ? parseFloat(maxCost) : null,
        maxExposure: maxExposure ? parseFloat(maxExposure) : null,
        minPrice: minPrice ? parseFloat(minPrice) : null,
        maxPrice: maxPrice ? parseFloat(maxPrice) : null,
        sizingMode: sizingMode || null,
        fixedDollarAmount: fixedDollar ? parseFloat(fixedDollar) : null,
        copyRatio: copyRatio ? parseFloat(copyRatio) : null,
        allowOverdraft: allowOverdraft,
      };

      try {
        const res = await fetch(\`/api/wallets/\${encodeURIComponent(currentSettingsAddress)}/config\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          alert('Error: ' + (data.error || 'Failed to save'));
          return;
        }

        closeSettingsModal();
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Close settings modal on overlay click
    document.getElementById('settingsModal').addEventListener('click', function(e) {
      if (e.target === this) closeSettingsModal();
    });

    // ============ Global Settings Modal Functions ============

    async function showGlobalSettingsModal() {
      const modal = document.getElementById('globalSettingsModal');

      try {
        const res = await fetch('/api/config');
        const config = await res.json();

        document.getElementById('globalSizingMode').value = config.sizingMode || 'conviction';
        document.getElementById('globalCopyRatio').value = config.copyRatio || 0.10;
        document.getElementById('globalMaxCost').value = config.maxCostPerTrade || 10;
        document.getElementById('globalMaxExposure').value = config.maxExposurePerTarget || 50;
        document.getElementById('globalMinPrice').value = config.minPrice || 0.01;
        document.getElementById('globalMaxPrice').value = config.maxPrice || 0.99;
        document.getElementById('globalPollInterval').value = config.pollInterval || 10;

      } catch (e) {
        alert('Error loading global config: ' + e.message);
        return;
      }

      modal.classList.add('active');
    }

    function closeGlobalSettingsModal() {
      document.getElementById('globalSettingsModal').classList.remove('active');
    }

    async function saveGlobalSettings() {
      const config = {
        sizingMode: document.getElementById('globalSizingMode').value,
        copyRatio: parseFloat(document.getElementById('globalCopyRatio').value) || 0.10,
        maxCostPerTrade: parseFloat(document.getElementById('globalMaxCost').value) || 10,
        maxExposurePerTarget: parseFloat(document.getElementById('globalMaxExposure').value) || 50,
        minPrice: parseFloat(document.getElementById('globalMinPrice').value) || 0.01,
        maxPrice: parseFloat(document.getElementById('globalMaxPrice').value) || 0.99,
        pollInterval: parseInt(document.getElementById('globalPollInterval').value) || 10,
      };

      try {
        const res = await fetch('/api/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          alert('Error: ' + (data.error || 'Failed to save'));
          return;
        }

        closeGlobalSettingsModal();
        await refreshAll();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Close global settings modal on overlay click
    document.getElementById('globalSettingsModal').addEventListener('click', function(e) {
      if (e.target === this) closeGlobalSettingsModal();
    });

    // Close global settings modal on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeGlobalSettingsModal();
    });
  </script>

  <!-- Trade Modal Overlay -->
  <div id="tradeModal" class="modal-overlay">
    <div class="modal" id="modalContent"></div>
  </div>

  <!-- Sold Modal Overlay -->
  <div id="soldModal" class="modal-overlay">
    <div class="modal" style="max-width:420px">
      <div class="modal-header">
        <h3>Record Manual Sale</h3>
        <button class="modal-close" onclick="closeSoldModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div id="soldPositionInfo" style="background:#222;padding:12px;border-radius:6px;margin-bottom:15px"></div>

        <div style="margin-bottom:15px">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Exit Price (per share)</label>
          <input type="number" id="soldExitPrice" step="0.01" min="0" max="1" placeholder="0.00 - 1.00"
                 oninput="updateSoldPreview()"
                 style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:12px;border-radius:4px;font-size:18px">
          <div style="font-size:11px;color:#666;margin-top:4px">Enter the price you sold at (e.g., 0.65 for 65 cents)</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:20px;background:#1a1a1a;padding:12px;border-radius:6px">
          <div style="text-align:center">
            <div style="color:#888;font-size:11px;margin-bottom:4px">PROCEEDS</div>
            <div id="soldProceeds" style="font-size:18px;font-weight:bold;color:#fff">-</div>
          </div>
          <div style="text-align:center">
            <div style="color:#888;font-size:11px;margin-bottom:4px">P&L</div>
            <div id="soldPnl" style="font-size:18px;font-weight:bold">-</div>
          </div>
        </div>

        <button class="btn" style="width:100%;padding:12px;background:#1e3a5f;color:#60a5fa" onclick="submitSold()">Record Sale</button>
      </div>
    </div>
  </div>

  <!-- Funding Modal Overlay -->
  <div id="fundingModal" class="modal-overlay">
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <h3 id="fundingTitle">Deposit</h3>
        <button class="modal-close" onclick="closeFundingModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:15px">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Amount ($)</label>
          <input type="number" id="fundingAmount" step="0.01" min="0" placeholder="0.00" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:12px;border-radius:4px;font-size:18px">
        </div>
        <div style="margin-bottom:20px">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Note (optional)</label>
          <input type="text" id="fundingNote" placeholder="e.g., Initial funding" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
        </div>
        <button class="btn success" style="width:100%;padding:12px" onclick="submitFunding()">Confirm</button>
      </div>
    </div>
  </div>

  <!-- Settings Modal Overlay -->
  <div id="settingsModal" class="modal-overlay">
    <div class="modal" style="max-width:450px">
      <div class="modal-header">
        <h3 id="settingsTitle">Wallet Settings</h3>
        <button class="modal-close" onclick="closeSettingsModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="color:#888;font-size:12px;margin-bottom:15px">Leave blank to use global defaults</p>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:15px">
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Cost Per Trade ($)</label>
            <input type="number" id="settingsMaxCost" step="0.01" min="0" placeholder="Global default" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Exposure ($)</label>
            <input type="number" id="settingsMaxExposure" step="0.01" min="0" placeholder="Global default" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:15px">
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Min Price (0.00-1.00)</label>
            <input type="number" id="settingsMinPrice" step="0.01" min="0" max="1" placeholder="No minimum" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Price (0.00-1.00)</label>
            <input type="number" id="settingsMaxPrice" step="0.01" min="0" max="1" placeholder="No maximum" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
        </div>

        <div style="margin-bottom:15px">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Sizing Mode</label>
          <select id="settingsSizingMode" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
            <option value="">Use global default</option>
            <option value="conviction">Conviction (match small, scale large)</option>
            <option value="fixed_dollar">Fixed dollar amount</option>
            <option value="match">Match target size</option>
          </select>
        </div>

        <div id="copyRatioRow" style="margin-bottom:15px;display:none">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Copy Ratio (for trades > $5)</label>
          <input type="number" id="settingsCopyRatio" step="0.01" min="0" max="1" placeholder="e.g., 0.10 = 10%" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          <div style="font-size:11px;color:#666;margin-top:4px">$1-$5 trades: match 1:1 | >$5 trades: this ratio × target size (min $1, max by Max Cost)</div>
        </div>

        <div id="fixedDollarRow" style="margin-bottom:15px;display:none">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Fixed Dollar Amount ($)</label>
          <input type="number" id="settingsFixedDollar" step="0.01" min="0" placeholder="e.g., 5.00" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
        </div>

        <div style="margin-bottom:20px">
          <label style="display:flex;align-items:center;gap:8px;color:#fff;cursor:pointer">
            <input type="checkbox" id="settingsOverdraft" style="width:16px;height:16px">
            Allow overdraft (trade even if balance goes negative)
          </label>
        </div>

        <button class="btn success" style="width:100%;padding:12px" onclick="saveSettings()">Save Settings</button>
      </div>
    </div>
  </div>

  <!-- Global Settings Modal -->
  <div id="globalSettingsModal" class="modal-overlay">
    <div class="modal" style="max-width:500px">
      <div class="modal-header">
        <h3>Global Default Settings</h3>
        <button class="modal-close" onclick="closeGlobalSettingsModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="color:#888;font-size:12px;margin-bottom:15px">These defaults apply to all wallets unless overridden per-wallet</p>

        <div style="margin-bottom:15px">
          <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Sizing Mode</label>
          <select id="globalSizingMode" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
            <option value="conviction">Conviction (match small, scale large)</option>
            <option value="fixed_dollar">Fixed dollar amount</option>
            <option value="match">Match target size</option>
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:15px">
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Copy Ratio (0.01-1.00)</label>
            <input type="number" id="globalCopyRatio" step="0.01" min="0.01" max="1" placeholder="0.10" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
            <div style="font-size:11px;color:#666;margin-top:2px">e.g., 0.10 = 10% of target trade</div>
          </div>
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Cost Per Trade ($)</label>
            <input type="number" id="globalMaxCost" step="0.5" min="1" placeholder="10" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:15px">
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Exposure Per Target ($)</label>
            <input type="number" id="globalMaxExposure" step="5" min="1" placeholder="50" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Poll Interval (seconds)</label>
            <input type="number" id="globalPollInterval" step="1" min="1" max="60" placeholder="10" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
            <div style="font-size:11px;color:#ef4444;margin-top:2px">Requires daemon restart</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:20px">
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Min Price (0.01-0.99)</label>
            <input type="number" id="globalMinPrice" step="0.01" min="0.01" max="0.99" placeholder="0.01" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
          <div>
            <label style="display:block;color:#888;font-size:12px;margin-bottom:5px">Max Price (0.01-0.99)</label>
            <input type="number" id="globalMaxPrice" step="0.01" min="0.01" max="0.99" placeholder="0.99" style="width:100%;background:#222;border:1px solid #444;color:#fff;padding:8px;border-radius:4px">
          </div>
        </div>

        <div style="background:#222;border-radius:6px;padding:12px;margin-bottom:20px">
          <div style="font-size:12px;color:#fbbf24;margin-bottom:8px">Conviction Sizing Logic:</div>
          <div style="font-size:11px;color:#888;line-height:1.6">
            • Trades < $1: <span style="color:#ef4444">Skip</span> (dust)<br>
            • Trades $1-$5: <span style="color:#22c55e">Match 1:1</span><br>
            • Trades > $5: <span style="color:#3b82f6">max($1, ratio × target)</span>, capped at Max Cost
          </div>
        </div>

        <button class="btn success" style="width:100%;padding:12px" onclick="saveGlobalSettings()">Save Global Settings</button>
      </div>
    </div>
  </div>
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
