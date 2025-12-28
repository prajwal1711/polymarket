/**
 * Minimal Express server for Polymarket dashboard
 */

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { MarketStorage } from './storage';
import { DEFAULT_GUARDRAILS, GuardrailConfig, validateOrder } from './guardrails';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3456;
const storage = new MarketStorage();

// Runtime state
let guardrails: GuardrailConfig = { ...DEFAULT_GUARDRAILS };
let dailyStats = {
  ordersToday: 0,
  spentToday: 0,
  lastReset: new Date().toDateString(),
};

// Reset daily stats if new day
function checkDailyReset() {
  const today = new Date().toDateString();
  if (dailyStats.lastReset !== today) {
    dailyStats = { ordersToday: 0, spentToday: 0, lastReset: today };
  }
}

// Install POLY_ADDRESS fix for Magic wallet
function installPolyAddressFix(): void {
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);
  const funderAddress = process.env.FUNDER_ADDRESS;
  if (signatureType === 1 && funderAddress) {
    axios.interceptors.request.use((config) => {
      if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
        config.headers['POLY_ADDRESS'] = funderAddress;
      }
      return config;
    });
  }
}

// Create authenticated ClobClient
function createClient(): ClobClient {
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);

  return new ClobClient(
    'https://clob.polymarket.com',
    Chain.POLYGON,
    wallet,
    {
      key: process.env.API_KEY!,
      secret: process.env.API_SECRET!,
      passphrase: process.env.API_PASSPHRASE!,
    },
    signatureType,
    process.env.FUNDER_ADDRESS
  );
}

// API Routes

// Get all strategies
app.get('/api/strategies', (req, res) => {
  try {
    const strategies = storage.getStrategies();

    // Add stats for each strategy
    const strategiesWithStats = strategies.map(s => {
      const stats = storage.getStrategyStats(s.id);
      return {
        ...s,
        stats: {
          totalTrades: stats.totalTrades,
          totalCost: stats.totalCost,
          totalShares: stats.totalShares,
          potentialPayout: stats.totalShares,
          roi: stats.totalCost > 0 ? ((stats.totalShares / stats.totalCost) - 1) * 100 : 0,
        },
      };
    });

    res.json(strategiesWithStats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new strategy
app.post('/api/strategies', (req, res) => {
  try {
    const { id, name, description, color } = req.body;

    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' });
    }

    storage.createStrategy(
      id,
      name,
      description || null,
      color || '#4ade80'
    );

    res.json({ success: true, id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get positions by strategy
app.get('/api/strategies/:strategyId/positions', async (req, res) => {
  try {
    const { strategyId } = req.params;
    const trades = storage.getTrackedTradesByStrategy(strategyId);

    // Group by token
    const positionMap = new Map<string, {
      tokenId: string;
      side: string;
      totalSize: number;
      totalCost: number;
      avgPrice: number;
      tradeCount: number;
    }>();

    for (const trade of trades) {
      const existing = positionMap.get(trade.tokenId);

      if (existing) {
        existing.totalSize += trade.size;
        existing.totalCost += trade.cost;
        existing.avgPrice = existing.totalCost / existing.totalSize;
        existing.tradeCount++;
      } else {
        positionMap.set(trade.tokenId, {
          tokenId: trade.tokenId,
          side: trade.side,
          totalSize: trade.size,
          totalCost: trade.cost,
          avgPrice: trade.price,
          tradeCount: 1,
        });
      }
    }

    // Enrich with market data
    const positions: any[] = [];

    for (const [tokenId, pos] of positionMap.entries()) {
      const market = storage.db.prepare(`
        SELECT id, question, slug, endDate, closeDate, active, closed,
               yesTokenId, noTokenId
        FROM markets
        WHERE yesTokenId = ? OR noTokenId = ?
        LIMIT 1
      `).get(tokenId, tokenId) as any;

      const isYesToken = market?.yesTokenId === tokenId;

      positions.push({
        tokenId,
        strategyId,
        side: pos.side,
        outcome: isYesToken ? 'YES' : 'NO',
        totalShares: pos.totalSize,
        totalCost: pos.totalCost,
        avgPrice: pos.avgPrice,
        tradeCount: pos.tradeCount,
        potentialPayout: pos.totalSize,
        currentROI: ((1 / pos.avgPrice) - 1) * 100,
        market: market ? {
          id: market.id,
          question: market.question,
          slug: market.slug,
          endDate: market.endDate,
          closeDate: market.closeDate,
          active: market.active === 1,
          closed: market.closed === 1,
        } : null,
      });
    }

    // Sort by endDate ascending
    positions.sort((a, b) => {
      const dateA = a.market?.endDate ? new Date(a.market.endDate).getTime() : Infinity;
      const dateB = b.market?.endDate ? new Date(b.market.endDate).getTime() : Infinity;
      return dateA - dateB;
    });

    res.json(positions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Import existing trades to a strategy
app.post('/api/strategies/:strategyId/import-trades', async (req, res) => {
  try {
    const { strategyId } = req.params;

    // Verify strategy exists
    const strategies = storage.getStrategies();
    if (!strategies.find(s => s.id === strategyId)) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    // Fetch trades from CLOB
    const client = createClient();
    const trades = await client.getTrades();

    let imported = 0;
    for (const trade of trades) {
      const tokenId = trade.asset_id;
      if (!tokenId) continue;

      // Find market for this token
      const market = storage.db.prepare(`
        SELECT id FROM markets WHERE yesTokenId = ? OR noTokenId = ? LIMIT 1
      `).get(tokenId, tokenId) as any;

      const price = parseFloat(trade.price) || 0;
      const size = parseFloat(trade.size) || 0;

      storage.saveTrackedTrade({
        id: trade.id,
        strategyId,
        marketId: market?.id || null,
        tokenId,
        side: trade.side,
        price,
        size,
        cost: price * size,
        orderId: trade.taker_order_id || null,
        matchTime: trade.match_time || null,
      });
      imported++;
    }

    res.json({ success: true, imported });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get rotation stats
app.get('/api/rotation-stats', (req, res) => {
  try {
    const stats = storage.getRotationStats();
    res.json({
      ...stats,
      targetFills: 1000,
      progress: (stats.totalFilled / 1000) * 100,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get dashboard summary
app.get('/api/summary', async (req, res) => {
  try {
    checkDailyReset();

    const totalMarkets = storage.db.prepare('SELECT COUNT(*) as count FROM markets').get() as any;
    const activeMarkets = storage.db.prepare('SELECT COUNT(*) as count FROM markets WHERE active = 1 AND closed = 0').get() as any;
    const enrichedMarkets = storage.db.prepare('SELECT COUNT(*) as count FROM markets WHERE min_tick_size IS NOT NULL').get() as any;

    const latestPlan = storage.db.prepare(`
      SELECT id, mode, created_at,
        (SELECT COUNT(*) FROM planned_orders WHERE plan_run_id = plan_runs.id AND is_valid = 1) as valid_orders,
        (SELECT COUNT(*) FROM planned_orders WHERE plan_run_id = plan_runs.id) as total_orders,
        (SELECT SUM(cost) FROM planned_orders WHERE plan_run_id = plan_runs.id AND is_valid = 1) as total_cost
      FROM plan_runs ORDER BY created_at DESC LIMIT 1
    `).get() as any;

    // Get aggregate stats from tracked trades (source of truth for spending)
    const trackedStats = storage.db.prepare(`
      SELECT
        COUNT(*) as trade_count,
        COALESCE(SUM(cost), 0) as total_spent,
        COALESCE(SUM(size), 0) as total_shares
      FROM tracked_trades
    `).get() as any;

    res.json({
      markets: {
        total: totalMarkets?.count || 0,
        active: activeMarkets?.count || 0,
        enriched: enrichedMarkets?.count || 0,
      },
      latestPlan: latestPlan || null,
      trackedStats: {
        tradeCount: trackedStats?.trade_count || 0,
        totalSpent: trackedStats?.total_spent || 0,
        totalShares: trackedStats?.total_shares || 0,
      },
      dailyStats,
      guardrails: {
        readOnlyMode: guardrails.readOnlyMode,
        maxSingleOrderCost: guardrails.maxSingleOrderCost,
        maxDailySpend: guardrails.maxDailySpend,
        remainingDailyBudget: guardrails.maxDailySpend - dailyStats.spentToday,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get guardrails config
app.get('/api/guardrails', (req, res) => {
  res.json(guardrails);
});

// Update guardrails config
app.post('/api/guardrails', (req, res) => {
  const updates = req.body;

  // Validate updates
  if (updates.maxSingleOrderCost !== undefined) {
    if (updates.maxSingleOrderCost > 1.0) {
      return res.status(400).json({ error: 'maxSingleOrderCost cannot exceed $1.00' });
    }
    guardrails.maxSingleOrderCost = updates.maxSingleOrderCost;
  }
  if (updates.maxDailySpend !== undefined) {
    if (updates.maxDailySpend > 10.0) {
      return res.status(400).json({ error: 'maxDailySpend cannot exceed $10.00' });
    }
    guardrails.maxDailySpend = updates.maxDailySpend;
  }
  if (updates.readOnlyMode !== undefined) {
    guardrails.readOnlyMode = updates.readOnlyMode;
  }
  if (updates.maxOrdersPerDay !== undefined) {
    guardrails.maxOrdersPerDay = Math.min(updates.maxOrdersPerDay, 100);
  }

  res.json(guardrails);
});

// Get planned orders from latest run
app.get('/api/planned-orders', (req, res) => {
  try {
    const validOnly = req.query.valid === 'true';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const orders = storage.db.prepare(`
      SELECT po.*, pr.mode, pr.created_at as plan_created_at
      FROM planned_orders po
      JOIN plan_runs pr ON po.plan_run_id = pr.id
      WHERE pr.id = (SELECT id FROM plan_runs ORDER BY created_at DESC LIMIT 1)
      ${validOnly ? 'AND po.is_valid = 1' : ''}
      ORDER BY po.cost ASC
      LIMIT ?
    `).all(limit);

    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get open orders from Polymarket
app.get('/api/open-orders', async (req, res) => {
  try {
    const client = createClient();
    const openOrders = await client.getOpenOrders();
    res.json(openOrders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent trades
app.get('/api/trades', async (req, res) => {
  try {
    const client = createClient();
    const trades = await client.getTrades();
    res.json(trades.slice(0, 50));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get positions with market details, sorted by resolution date
app.get('/api/positions', async (req, res) => {
  try {
    const client = createClient();
    const trades = await client.getTrades();

    // Group trades by asset_id (token) and aggregate
    // Only count floor orders (price < 0.10) as our actual positions
    const positionMap = new Map<string, {
      tokenId: string;
      side: string;
      totalSize: number;
      totalCost: number;
      avgPrice: number;
      tradeCount: number;
    }>();

    for (const trade of trades) {
      const tokenId = trade.asset_id;
      if (!tokenId) continue;

      const size = parseFloat(trade.size) || 0;
      const price = parseFloat(trade.price) || 0;

      // Only count floor orders (low price trades)
      // Skip high-price trades which are likely counterparty or different activity
      if (price >= 0.10) continue;

      const existing = positionMap.get(tokenId);
      const cost = size * price;

      if (existing) {
        existing.totalSize += size;
        existing.totalCost += cost;
        existing.avgPrice = existing.totalCost / existing.totalSize;
        existing.tradeCount++;
      } else {
        positionMap.set(tokenId, {
          tokenId,
          side: trade.side,
          totalSize: size,
          totalCost: cost,
          avgPrice: price,
          tradeCount: 1,
        });
      }
    }

    // Enrich positions with market data from database
    const positions: any[] = [];

    for (const [tokenId, pos] of positionMap.entries()) {
      const market = storage.db.prepare(`
        SELECT id, question, slug, endDate, closeDate, active, closed,
               yesTokenId, noTokenId
        FROM markets
        WHERE yesTokenId = ? OR noTokenId = ?
        LIMIT 1
      `).get(tokenId, tokenId) as any;

      const isYesToken = market?.yesTokenId === tokenId;

      positions.push({
        tokenId,
        side: pos.side,
        outcome: isYesToken ? 'YES' : 'NO',
        totalShares: pos.totalSize,
        totalCost: pos.totalCost,
        avgPrice: pos.avgPrice,
        tradeCount: pos.tradeCount,
        potentialPayout: pos.totalSize, // Each share pays $1 if correct
        currentROI: ((1 / pos.avgPrice) - 1) * 100, // ROI if wins
        market: market ? {
          id: market.id,
          question: market.question,
          slug: market.slug,
          endDate: market.endDate,
          closeDate: market.closeDate,
          active: market.active === 1,
          closed: market.closed === 1,
        } : null,
      });
    }

    // Sort by endDate ascending (soonest resolution first)
    positions.sort((a, b) => {
      const dateA = a.market?.endDate ? new Date(a.market.endDate).getTime() : Infinity;
      const dateB = b.market?.endDate ? new Date(b.market.endDate).getTime() : Infinity;
      return dateA - dateB;
    });

    res.json(positions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Validate an order (dry run)
app.post('/api/validate-order', (req, res) => {
  checkDailyReset();
  const { marketId, price, size, cost } = req.body;

  const validation = validateOrder(guardrails, { marketId, price, size, cost }, dailyStats);
  res.json(validation);
});

// Place an order (with full guardrail checks)
app.post('/api/place-order', async (req, res) => {
  try {
    checkDailyReset();
    const { marketId, tokenId, price, size, side = 'BUY', strategyId = 'floor_arb' } = req.body;
    const cost = price * size;

    // Validate against guardrails
    const validation = validateOrder(guardrails, { marketId, price, size, cost }, dailyStats);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    // Double-check read-only mode
    if (guardrails.readOnlyMode) {
      return res.status(400).json({
        success: false,
        errors: ['Read-only mode is enabled'],
      });
    }

    const client = createClient();

    // Create and post order
    const order = await client.createOrder({
      tokenID: tokenId,
      price,
      size,
      side: side as any,
    });

    const result = await client.postOrder(order);

    if (result.success) {
      // Update daily stats
      dailyStats.ordersToday++;
      dailyStats.spentToday += cost;

      // Track the trade with strategy attribution
      storage.saveTrackedTrade({
        id: result.orderID || `order_${Date.now()}`,
        strategyId,
        marketId: marketId || null,
        tokenId,
        side,
        price,
        size,
        cost,
        orderId: result.orderID || null,
        matchTime: new Date().toISOString(),
      });
    }

    res.json({
      success: result.success,
      orderID: result.orderID,
      strategyId,
      warnings: validation.warnings,
      dailyStats,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel an order
app.post('/api/cancel-order', async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: 'orderID required' });
    }

    const client = createClient();
    const result = await client.cancelOrder({ orderID });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel all orders
app.post('/api/cancel-all', async (req, res) => {
  try {
    const client = createClient();
    const result = await client.cancelAll();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get markets
app.get('/api/markets', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const activeOnly = req.query.active === 'true';

    const markets = storage.db.prepare(`
      SELECT id, question, slug, active, closed,
             yes_token_id, no_token_id, condition_id,
             min_tick_size, min_order_size, enable_order_book
      FROM markets
      ${activeOnly ? 'WHERE active = 1 AND closed = 0' : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit);

    res.json(markets);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
installPolyAddressFix();
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Guardrails: Read-only=${guardrails.readOnlyMode}, MaxOrder=$${guardrails.maxSingleOrderCost}, MaxDaily=$${guardrails.maxDailySpend}`);
});
