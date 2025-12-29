/**
 * Storage for copytrading - tracks copied trades, target wallets, and runs
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { CopiedTrade, CopytradeRun, CopyTarget, SubledgerTransaction, WalletStats, OperatingAccount } from './types';

const DB_PATH = path.join(process.cwd(), 'data', 'markets.db');

export class CopytradeStorage {
  private db: Database.Database;

  constructor() {
    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.initTables();
  }

  private initTables(): void {
    // Table for target wallets to copy
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copy_targets (
        address TEXT PRIMARY KEY,
        alias TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table for copytrade runs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copytrade_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        target_address TEXT NOT NULL,
        trades_found INTEGER DEFAULT 0,
        trades_new INTEGER DEFAULT 0,
        trades_copied INTEGER DEFAULT 0,
        trades_skipped INTEGER DEFAULT 0,
        trades_failed INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0
      )
    `);

    // Table for copied trades
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copied_trades (
        id TEXT PRIMARY KEY,
        original_trade_id TEXT NOT NULL UNIQUE,
        target_address TEXT NOT NULL,
        token_id TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        side TEXT NOT NULL,
        original_price REAL NOT NULL,
        original_size REAL NOT NULL,
        copy_price REAL,
        copy_size REAL,
        copy_cost REAL,
        order_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        skip_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        executed_at TEXT
      )
    `);

    // Add market_title and market_slug columns if they don't exist
    try {
      this.db.exec(`ALTER TABLE copied_trades ADD COLUMN market_title TEXT`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copied_trades ADD COLUMN market_slug TEXT`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copied_trades ADD COLUMN rule_evaluation TEXT`);
    } catch (e) { /* column exists */ }

    // Subledger columns for copy_targets
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN total_deposited REAL DEFAULT 0`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN total_withdrawn REAL DEFAULT 0`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN max_cost_per_trade REAL`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN max_exposure REAL`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN sizing_mode TEXT`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN fixed_dollar_amount REAL`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN min_price REAL`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN max_price REAL`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN allow_overdraft INTEGER DEFAULT 0`);
    } catch (e) { /* column exists */ }
    try {
      this.db.exec(`ALTER TABLE copy_targets ADD COLUMN copy_ratio REAL`);
    } catch (e) { /* column exists */ }

    // Subledger transactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subledger_transactions (
        id TEXT PRIMARY KEY,
        target_address TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Operating account table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operating_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_deposited REAL DEFAULT 0,
        total_withdrawn REAL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Ensure operating account row exists
    this.db.exec(`INSERT OR IGNORE INTO operating_account (id, total_deposited, total_withdrawn) VALUES (1, 0, 0)`);

    // Table for tracking the last seen trade timestamp per target
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copy_cursors (
        target_address TEXT PRIMARY KEY,
        last_trade_timestamp INTEGER NOT NULL,
        last_trade_id TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table for tracking our positions from copied trades
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copied_positions (
        id TEXT PRIMARY KEY,
        target_address TEXT NOT NULL,
        token_id TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        side TEXT NOT NULL,
        shares REAL NOT NULL,
        avg_entry_price REAL NOT NULL,
        total_cost REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_price REAL,
        exit_proceeds REAL,
        pnl REAL,
        UNIQUE(target_address, token_id)
      )
    `);

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_copied_trades_original ON copied_trades(original_trade_id);
      CREATE INDEX IF NOT EXISTS idx_copied_trades_target ON copied_trades(target_address);
      CREATE INDEX IF NOT EXISTS idx_copied_trades_status ON copied_trades(status);
      CREATE INDEX IF NOT EXISTS idx_copytrade_runs_target ON copytrade_runs(target_address);
      CREATE INDEX IF NOT EXISTS idx_copied_positions_token ON copied_positions(token_id);
      CREATE INDEX IF NOT EXISTS idx_copied_positions_status ON copied_positions(status);
    `);
  }

  // ============ Target Management ============

  addTarget(address: string, alias?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO copy_targets (address, alias, enabled, created_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    `).run(address.toLowerCase(), alias || null);
  }

  removeTarget(address: string): void {
    this.db.prepare(`
      DELETE FROM copy_targets WHERE address = ?
    `).run(address.toLowerCase());
  }

  getTargets(enabledOnly: boolean = true): CopyTarget[] {
    let query = 'SELECT * FROM copy_targets';
    if (enabledOnly) {
      query += ' WHERE enabled = 1';
    }
    query += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(query).all() as any[];
    return rows.map(row => ({
      address: row.address,
      alias: row.alias,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      totalDeposited: row.total_deposited || 0,
      totalWithdrawn: row.total_withdrawn || 0,
      maxCostPerTrade: row.max_cost_per_trade,
      maxExposure: row.max_exposure,
      sizingMode: row.sizing_mode,
      fixedDollarAmount: row.fixed_dollar_amount,
      copyRatio: row.copy_ratio,
      minPrice: row.min_price,
      maxPrice: row.max_price,
      allowOverdraft: row.allow_overdraft === 1,
    }));
  }

  /**
   * Get a single target by address
   */
  getTarget(address: string): CopyTarget | null {
    const row = this.db.prepare('SELECT * FROM copy_targets WHERE address = ?').get(address.toLowerCase()) as any;
    if (!row) return null;

    return {
      address: row.address,
      alias: row.alias,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      totalDeposited: row.total_deposited || 0,
      totalWithdrawn: row.total_withdrawn || 0,
      maxCostPerTrade: row.max_cost_per_trade,
      maxExposure: row.max_exposure,
      sizingMode: row.sizing_mode,
      fixedDollarAmount: row.fixed_dollar_amount,
      copyRatio: row.copy_ratio,
      minPrice: row.min_price,
      maxPrice: row.max_price,
      allowOverdraft: row.allow_overdraft === 1,
    };
  }

  setTargetEnabled(address: string, enabled: boolean): void {
    this.db.prepare(`
      UPDATE copy_targets SET enabled = ? WHERE address = ?
    `).run(enabled ? 1 : 0, address.toLowerCase());
  }

  /**
   * Update target guardrails config
   */
  updateTargetConfig(address: string, config: {
    maxCostPerTrade?: number | null;
    maxExposure?: number | null;
    sizingMode?: string | null;
    fixedDollarAmount?: number | null;
    copyRatio?: number | null;
    minPrice?: number | null;
    maxPrice?: number | null;
    allowOverdraft?: boolean;
    alias?: string;
  }): void {
    const updates: string[] = [];
    const values: any[] = [];

    if (config.maxCostPerTrade !== undefined) {
      updates.push('max_cost_per_trade = ?');
      values.push(config.maxCostPerTrade);
    }
    if (config.maxExposure !== undefined) {
      updates.push('max_exposure = ?');
      values.push(config.maxExposure);
    }
    if (config.sizingMode !== undefined) {
      updates.push('sizing_mode = ?');
      values.push(config.sizingMode);
    }
    if (config.fixedDollarAmount !== undefined) {
      updates.push('fixed_dollar_amount = ?');
      values.push(config.fixedDollarAmount);
    }
    if (config.copyRatio !== undefined) {
      updates.push('copy_ratio = ?');
      values.push(config.copyRatio);
    }
    if (config.minPrice !== undefined) {
      updates.push('min_price = ?');
      values.push(config.minPrice);
    }
    if (config.maxPrice !== undefined) {
      updates.push('max_price = ?');
      values.push(config.maxPrice);
    }
    if (config.allowOverdraft !== undefined) {
      updates.push('allow_overdraft = ?');
      values.push(config.allowOverdraft ? 1 : 0);
    }
    if (config.alias !== undefined) {
      updates.push('alias = ?');
      values.push(config.alias);
    }

    if (updates.length === 0) return;

    values.push(address.toLowerCase());
    this.db.prepare(`UPDATE copy_targets SET ${updates.join(', ')} WHERE address = ?`).run(...values);
  }

  // ============ Subledger: Deposits & Withdrawals ============

  /**
   * Deposit funds to a wallet's subledger
   */
  depositToWallet(targetAddress: string, amount: number, note?: string): SubledgerTransaction {
    const id = uuidv4();
    const addr = targetAddress.toLowerCase();

    // Record transaction
    this.db.prepare(`
      INSERT INTO subledger_transactions (id, target_address, type, amount, note, created_at)
      VALUES (?, ?, 'deposit', ?, ?, CURRENT_TIMESTAMP)
    `).run(id, addr, amount, note || null);

    // Update target's total_deposited
    this.db.prepare(`
      UPDATE copy_targets SET total_deposited = total_deposited + ? WHERE address = ?
    `).run(amount, addr);

    return {
      id,
      targetAddress: addr,
      type: 'deposit',
      amount,
      note: note || null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Withdraw funds from a wallet's subledger
   */
  withdrawFromWallet(targetAddress: string, amount: number, note?: string): SubledgerTransaction {
    const id = uuidv4();
    const addr = targetAddress.toLowerCase();

    // Record transaction
    this.db.prepare(`
      INSERT INTO subledger_transactions (id, target_address, type, amount, note, created_at)
      VALUES (?, ?, 'withdrawal', ?, ?, CURRENT_TIMESTAMP)
    `).run(id, addr, amount, note || null);

    // Update target's total_withdrawn
    this.db.prepare(`
      UPDATE copy_targets SET total_withdrawn = total_withdrawn + ? WHERE address = ?
    `).run(amount, addr);

    return {
      id,
      targetAddress: addr,
      type: 'withdrawal',
      amount,
      note: note || null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get transaction history for a wallet
   */
  getWalletTransactions(targetAddress: string, limit: number = 50): SubledgerTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM subledger_transactions
      WHERE target_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(targetAddress.toLowerCase(), limit) as any[];

    return rows.map(row => ({
      id: row.id,
      targetAddress: row.target_address,
      type: row.type as 'deposit' | 'withdrawal',
      amount: row.amount,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get comprehensive wallet stats (subledger view)
   */
  getWalletStats(targetAddress: string): WalletStats | null {
    const target = this.getTarget(targetAddress);
    if (!target) return null;

    const addr = targetAddress.toLowerCase();

    // Get current exposure (sum of open positions)
    const exposureRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_cost), 0) as exposure, COUNT(*) as count
      FROM copied_positions
      WHERE target_address = ? AND status = 'open'
    `).get(addr) as any;

    // Get realized P&L (sum of closed positions)
    const pnlRow = this.db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) as pnl, COUNT(*) as count
      FROM copied_positions
      WHERE target_address = ? AND status = 'closed'
    `).get(addr) as any;

    const currentExposure = exposureRow?.exposure || 0;
    const realizedPnl = pnlRow?.pnl || 0;
    const openPositions = exposureRow?.count || 0;
    const closedPositions = pnlRow?.count || 0;

    // Available = deposited - withdrawn + realized_pnl - current_exposure
    const availableBalance = target.totalDeposited - target.totalWithdrawn + realizedPnl - currentExposure;

    // Return % = (current value - net deposits) / net deposits * 100
    const netDeposits = target.totalDeposited - target.totalWithdrawn;
    const currentValue = availableBalance + currentExposure;
    const returnPercent = netDeposits > 0 ? ((currentValue - netDeposits) / netDeposits) * 100 : 0;

    return {
      address: target.address,
      alias: target.alias || null,
      enabled: target.enabled,
      totalDeposited: target.totalDeposited,
      totalWithdrawn: target.totalWithdrawn,
      currentExposure,
      realizedPnl,
      availableBalance,
      returnPercent,
      openPositions,
      closedPositions,
    };
  }

  /**
   * Get available balance for a wallet (for trade decisions)
   */
  getWalletAvailableBalance(targetAddress: string): number {
    const stats = this.getWalletStats(targetAddress);
    return stats?.availableBalance || 0;
  }

  /**
   * Get all wallet stats
   */
  getAllWalletStats(): WalletStats[] {
    const targets = this.getTargets(false);
    return targets.map(t => this.getWalletStats(t.address)).filter(s => s !== null) as WalletStats[];
  }

  // ============ Operating Account ============

  /**
   * Deposit to operating account
   */
  depositToOperating(amount: number): void {
    this.db.prepare(`
      UPDATE operating_account SET total_deposited = total_deposited + ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(amount);
  }

  /**
   * Withdraw from operating account
   */
  withdrawFromOperating(amount: number): void {
    this.db.prepare(`
      UPDATE operating_account SET total_withdrawn = total_withdrawn + ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(amount);
  }

  /**
   * Get operating account status
   */
  getOperatingAccount(): OperatingAccount {
    const row = this.db.prepare('SELECT * FROM operating_account WHERE id = 1').get() as any;

    // Total allocated to wallets = sum of all wallet deposits - withdrawals
    const allocRow = this.db.prepare(`
      SELECT COALESCE(SUM(total_deposited - total_withdrawn), 0) as allocated
      FROM copy_targets
    `).get() as any;

    const totalDeposited = row?.total_deposited || 0;
    const totalWithdrawn = row?.total_withdrawn || 0;
    const totalAllocatedToWallets = allocRow?.allocated || 0;

    return {
      totalDeposited,
      totalWithdrawn,
      totalAllocatedToWallets,
      availableBalance: totalDeposited - totalWithdrawn - totalAllocatedToWallets,
    };
  }

  // ============ Cursor Management (track last seen trade) ============

  getCursor(targetAddress: string): { timestamp: number; tradeId: string | null } | null {
    const row = this.db.prepare(`
      SELECT last_trade_timestamp, last_trade_id FROM copy_cursors WHERE target_address = ?
    `).get(targetAddress.toLowerCase()) as any;

    if (!row) return null;
    return {
      timestamp: row.last_trade_timestamp,
      tradeId: row.last_trade_id,
    };
  }

  setCursor(targetAddress: string, timestamp: number, tradeId?: string): void {
    this.db.prepare(`
      INSERT INTO copy_cursors (target_address, last_trade_timestamp, last_trade_id, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(target_address) DO UPDATE SET
        last_trade_timestamp = excluded.last_trade_timestamp,
        last_trade_id = excluded.last_trade_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(targetAddress.toLowerCase(), timestamp, tradeId || null);
  }

  // ============ Copied Trade Tracking ============

  /**
   * Check if we've already processed this trade (by original trade ID)
   */
  hasProcessedTrade(originalTradeId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM copied_trades WHERE original_trade_id = ?
    `).get(originalTradeId);
    return !!row;
  }

  /**
   * Check if we've already processed this trade by transaction hash
   */
  hasProcessedTradeByTxHash(txHash: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM copied_trades WHERE original_trade_id = ?
    `).get(txHash);
    return !!row;
  }

  /**
   * Save a copied trade record
   */
  saveCopiedTrade(trade: CopiedTrade): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO copied_trades (
        id, original_trade_id, target_address, token_id, condition_id,
        side, original_price, original_size, copy_price, copy_size, copy_cost,
        order_id, status, skip_reason, created_at, executed_at, market_title, market_slug, rule_evaluation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id,
      trade.originalTradeId,
      trade.targetAddress.toLowerCase(),
      trade.tokenId,
      trade.conditionId,
      trade.side,
      trade.originalPrice,
      trade.originalSize,
      trade.copyPrice,
      trade.copySize,
      trade.copyCost,
      trade.orderId,
      trade.status,
      trade.skipReason,
      trade.createdAt,
      trade.executedAt,
      trade.marketTitle || null,
      trade.marketSlug || null,
      trade.ruleEvaluation ? JSON.stringify(trade.ruleEvaluation) : null
    );
  }

  /**
   * Update copied trade status
   */
  updateCopiedTradeStatus(
    id: string,
    status: CopiedTrade['status'],
    updates: {
      orderId?: string;
      copyPrice?: number;
      copySize?: number;
      copyCost?: number;
      skipReason?: string;
      executedAt?: string;
    } = {}
  ): void {
    const sets: string[] = ['status = ?'];
    const values: any[] = [status];

    if (updates.orderId !== undefined) {
      sets.push('order_id = ?');
      values.push(updates.orderId);
    }
    if (updates.copyPrice !== undefined) {
      sets.push('copy_price = ?');
      values.push(updates.copyPrice);
    }
    if (updates.copySize !== undefined) {
      sets.push('copy_size = ?');
      values.push(updates.copySize);
    }
    if (updates.copyCost !== undefined) {
      sets.push('copy_cost = ?');
      values.push(updates.copyCost);
    }
    if (updates.skipReason !== undefined) {
      sets.push('skip_reason = ?');
      values.push(updates.skipReason);
    }
    if (updates.executedAt !== undefined) {
      sets.push('executed_at = ?');
      values.push(updates.executedAt);
    }

    values.push(id);

    this.db.prepare(`
      UPDATE copied_trades SET ${sets.join(', ')} WHERE id = ?
    `).run(...values);
  }

  /**
   * Get copied trades with optional filters
   */
  getCopiedTrades(options: {
    targetAddress?: string;
    status?: CopiedTrade['status'];
    limit?: number;
  } = {}): CopiedTrade[] {
    const { targetAddress, status, limit = 100 } = options;

    let query = 'SELECT * FROM copied_trades WHERE 1=1';
    const params: any[] = [];

    if (targetAddress) {
      query += ' AND target_address = ?';
      params.push(targetAddress.toLowerCase());
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      originalTradeId: row.original_trade_id,
      targetAddress: row.target_address,
      tokenId: row.token_id,
      conditionId: row.condition_id,
      side: row.side as 'BUY' | 'SELL',
      originalPrice: row.original_price,
      originalSize: row.original_size,
      copyPrice: row.copy_price,
      copySize: row.copy_size,
      copyCost: row.copy_cost,
      orderId: row.order_id,
      status: row.status as CopiedTrade['status'],
      skipReason: row.skip_reason,
      createdAt: row.created_at,
      executedAt: row.executed_at,
      marketTitle: row.market_title,
      marketSlug: row.market_slug,
      ruleEvaluation: row.rule_evaluation ? JSON.parse(row.rule_evaluation) : null,
    }));
  }

  // ============ Run Tracking ============

  /**
   * Save a copytrade run
   */
  saveRun(run: CopytradeRun): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO copytrade_runs (
        id, started_at, completed_at, target_address,
        trades_found, trades_new, trades_copied, trades_skipped, trades_failed, total_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.startedAt,
      run.completedAt,
      run.targetAddress.toLowerCase(),
      run.tradesFound,
      run.tradesNew,
      run.tradesCopied,
      run.tradesSkipped,
      run.tradesFailed,
      run.totalCost
    );
  }

  /**
   * Get recent runs
   */
  getRuns(limit: number = 20): CopytradeRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM copytrade_runs ORDER BY started_at DESC LIMIT ?
    `).all(limit) as any[];

    return rows.map(row => ({
      id: row.id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      targetAddress: row.target_address,
      tradesFound: row.trades_found,
      tradesNew: row.trades_new,
      tradesCopied: row.trades_copied,
      tradesSkipped: row.trades_skipped,
      tradesFailed: row.trades_failed,
      totalCost: row.total_cost,
    }));
  }

  // ============ Statistics ============

  /**
   * Get copytrade statistics
   */
  getStats(): {
    totalTargets: number;
    totalRuns: number;
    totalTradesCopied: number;
    totalCost: number;
    successRate: number;
  } {
    const targets = this.db.prepare('SELECT COUNT(*) as count FROM copy_targets WHERE enabled = 1').get() as any;
    const runs = this.db.prepare('SELECT COUNT(*) as count FROM copytrade_runs').get() as any;
    const trades = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('placed', 'filled') THEN 1 ELSE 0 END) as successful,
        COALESCE(SUM(copy_cost), 0) as total_cost
      FROM copied_trades
    `).get() as any;

    const successRate = trades.total > 0 ? (trades.successful / trades.total) * 100 : 0;

    return {
      totalTargets: targets.count,
      totalRuns: runs.count,
      totalTradesCopied: trades.successful || 0,
      totalCost: trades.total_cost || 0,
      successRate,
    };
  }

  // ============ Position Tracking ============

  /**
   * Position record type
   */


  /**
   * Get an open position for a token (if we hold it)
   */
  getOpenPosition(targetAddress: string, tokenId: string): {
    id: string;
    targetAddress: string;
    tokenId: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    shares: number;
    avgEntryPrice: number;
    totalCost: number;
    status: 'open' | 'closed';
    openedAt: string;
  } | null {
    const row = this.db.prepare(`
      SELECT * FROM copied_positions
      WHERE target_address = ? AND token_id = ? AND status = 'open'
    `).get(targetAddress.toLowerCase(), tokenId) as any;

    if (!row) return null;

    return {
      id: row.id,
      targetAddress: row.target_address,
      tokenId: row.token_id,
      conditionId: row.condition_id,
      side: row.side,
      shares: row.shares,
      avgEntryPrice: row.avg_entry_price,
      totalCost: row.total_cost,
      status: row.status,
      openedAt: row.opened_at,
    };
  }

  /**
   * Open or add to a position (when we copy a BUY)
   */
  openOrAddPosition(params: {
    id: string;
    targetAddress: string;
    tokenId: string;
    conditionId: string;
    shares: number;
    price: number;
    cost: number;
  }): void {
    const existing = this.getOpenPosition(params.targetAddress, params.tokenId);

    if (existing) {
      // Add to existing position - calculate new average price
      const newShares = existing.shares + params.shares;
      const newTotalCost = existing.totalCost + params.cost;
      const newAvgPrice = newTotalCost / newShares;

      this.db.prepare(`
        UPDATE copied_positions
        SET shares = ?, avg_entry_price = ?, total_cost = ?
        WHERE id = ?
      `).run(newShares, newAvgPrice, newTotalCost, existing.id);
    } else {
      // Open new position
      this.db.prepare(`
        INSERT INTO copied_positions (
          id, target_address, token_id, condition_id, side,
          shares, avg_entry_price, total_cost, status, opened_at
        ) VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, 'open', ?)
      `).run(
        params.id,
        params.targetAddress.toLowerCase(),
        params.tokenId,
        params.conditionId,
        params.shares,
        params.price,
        params.cost,
        new Date().toISOString()
      );
    }
  }

  /**
   * Close a position (when we copy a SELL)
   */
  closePosition(params: {
    targetAddress: string;
    tokenId: string;
    exitPrice: number;
    exitProceeds: number;
  }): {
    success: boolean;
    position?: { shares: number; avgEntryPrice: number; pnl: number }
  } {
    const existing = this.getOpenPosition(params.targetAddress, params.tokenId);

    if (!existing) {
      return { success: false };
    }

    const pnl = params.exitProceeds - existing.totalCost;

    this.db.prepare(`
      UPDATE copied_positions
      SET status = 'closed',
          closed_at = ?,
          exit_price = ?,
          exit_proceeds = ?,
          pnl = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      params.exitPrice,
      params.exitProceeds,
      pnl,
      existing.id
    );

    return {
      success: true,
      position: {
        shares: existing.shares,
        avgEntryPrice: existing.avgEntryPrice,
        pnl,
      },
    };
  }

  /**
   * Get all open positions
   */
  getOpenPositions(targetAddress?: string): Array<{
    id: string;
    targetAddress: string;
    tokenId: string;
    conditionId: string;
    shares: number;
    avgEntryPrice: number;
    totalCost: number;
    openedAt: string;
  }> {
    let query = `SELECT * FROM copied_positions WHERE status = 'open'`;
    const params: any[] = [];

    if (targetAddress) {
      query += ' AND target_address = ?';
      params.push(targetAddress.toLowerCase());
    }

    query += ' ORDER BY opened_at DESC';

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      targetAddress: row.target_address,
      tokenId: row.token_id,
      conditionId: row.condition_id,
      shares: row.shares,
      avgEntryPrice: row.avg_entry_price,
      totalCost: row.total_cost,
      openedAt: row.opened_at,
    }));
  }

  /**
   * Get closed positions with PnL
   */
  getClosedPositions(limit: number = 20): Array<{
    id: string;
    targetAddress: string;
    tokenId: string;
    conditionId: string;
    shares: number;
    avgEntryPrice: number;
    totalCost: number;
    exitPrice: number;
    exitProceeds: number;
    pnl: number;
    openedAt: string;
    closedAt: string;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM copied_positions
      WHERE status = 'closed'
      ORDER BY closed_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(row => ({
      id: row.id,
      targetAddress: row.target_address,
      tokenId: row.token_id,
      conditionId: row.condition_id,
      shares: row.shares,
      avgEntryPrice: row.avg_entry_price,
      totalCost: row.total_cost,
      exitPrice: row.exit_price,
      exitProceeds: row.exit_proceeds,
      pnl: row.pnl,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
    }));
  }

  /**
   * Get total exposure (open position cost) for a target
   */
  getTotalExposure(targetAddress: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(total_cost), 0) as exposure
      FROM copied_positions
      WHERE target_address = ? AND status = 'open'
    `).get(targetAddress.toLowerCase()) as any;

    return row?.exposure || 0;
  }

  /**
   * Get position statistics
   */
  getPositionStats(): {
    openPositions: number;
    closedPositions: number;
    totalInvested: number;
    totalPnl: number;
    winRate: number;
  } {
    const open = this.db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total_cost), 0) as invested
      FROM copied_positions WHERE status = 'open'
    `).get() as any;

    const closed = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(pnl), 0) as total_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
      FROM copied_positions WHERE status = 'closed'
    `).get() as any;

    const winRate = closed.count > 0 ? (closed.wins / closed.count) * 100 : 0;

    return {
      openPositions: open.count,
      closedPositions: closed.count,
      totalInvested: open.invested,
      totalPnl: closed.total_pnl,
      winRate,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
