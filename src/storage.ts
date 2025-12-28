/**
 * Storage abstraction for market data
 * Uses SQLite by default, but structured to allow easy swapping to JSON
 */

import Database from 'better-sqlite3';
import { GammaMarket } from './types/market';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'markets.db');
const JSON_PATH = path.join(process.cwd(), 'data', 'markets.json');

export class MarketStorage {
  private _db: Database.Database | null = null;
  private useJson: boolean;

  // Public getter for raw database access (for dashboard queries)
  get db(): Database.Database {
    if (!this._db) {
      throw new Error('Database not initialized');
    }
    return this._db;
  }

  constructor(useJson: boolean = false) {
    this.useJson = useJson;
    if (!useJson) {
      this.initSqlite();
    } else {
      this.initJson();
    }
  }

  private initSqlite(): void {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(DB_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this._db = new Database(DB_PATH);
      
      // Create markets table
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS markets (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          slug TEXT,
          active INTEGER DEFAULT 1,
          closed INTEGER DEFAULT 0,
          endDate TEXT,
          closeDate TEXT,
          yesTokenId TEXT,
          noTokenId TEXT,
          condition_id TEXT,
          createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
          updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Add condition_id column if it doesn't exist
      try {
        this._db.exec(`
          ALTER TABLE markets ADD COLUMN condition_id TEXT;
        `);
      } catch (error: any) {
        // Column might already exist, ignore error
        if (!error.message?.includes('duplicate column')) {
          throw error;
        }
      }

      // Add enable_order_book column if it doesn't exist
      try {
        this._db.exec(`
          ALTER TABLE markets ADD COLUMN enable_order_book INTEGER;
        `);
      } catch (error: any) {
        // Column might already exist, ignore error
        if (!error.message?.includes('duplicate column')) {
          throw error;
        }
      }

      // Add CLOB constraint columns if they don't exist
      try {
        this._db.exec(`
          ALTER TABLE markets ADD COLUMN min_tick_size REAL;
        `);
      } catch (error: any) {
        // Column might already exist, ignore error
        if (!error.message?.includes('duplicate column')) {
          throw error;
        }
      }

      try {
        this._db.exec(`
          ALTER TABLE markets ADD COLUMN min_order_size REAL;
        `);
      } catch (error: any) {
        // Column might already exist, ignore error
        if (!error.message?.includes('duplicate column')) {
          throw error;
        }
      }

      // Create ingestion_state table
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS ingestion_state (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      // Create strategies table
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS strategies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          color TEXT DEFAULT '#4ade80',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          is_active INTEGER DEFAULT 1
        )
      `);

      // Insert default "floor_arb" strategy if not exists
      this._db.exec(`
        INSERT OR IGNORE INTO strategies (id, name, description, color)
        VALUES ('floor_arb', 'Floor Arbitrage', 'Buy at floor prices (0.1%) for asymmetric upside', '#4ade80')
      `);

      // Create plan_runs table
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS plan_runs (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          params_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      // Add strategy_id column to plan_runs if not exists
      try {
        this._db.exec(`ALTER TABLE plan_runs ADD COLUMN strategy_id TEXT DEFAULT 'floor_arb'`);
      } catch (error: any) {
        if (!error.message?.includes('duplicate column')) throw error;
      }

      // Create planned_orders table
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS planned_orders (
          plan_run_id TEXT NOT NULL,
          market_id TEXT NOT NULL,
          question TEXT,
          yes_token_id TEXT,
          price REAL,
          size REAL,
          cost REAL,
          min_tick_size REAL,
          min_order_size REAL,
          is_valid INTEGER NOT NULL,
          skip_reason TEXT,
          created_at TEXT NOT NULL
        )
      `);

      // Create tracked_trades table for strategy attribution
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS tracked_trades (
          id TEXT PRIMARY KEY,
          strategy_id TEXT NOT NULL,
          market_id TEXT,
          token_id TEXT NOT NULL,
          side TEXT NOT NULL,
          price REAL NOT NULL,
          size REAL NOT NULL,
          cost REAL NOT NULL,
          order_id TEXT,
          match_time TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (strategy_id) REFERENCES strategies(id)
        )
      `);

      // Create rotation tracking tables
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS attempted_markets (
          market_id TEXT PRIMARY KEY,
          token_id TEXT NOT NULL,
          first_attempt_at TEXT NOT NULL,
          last_attempt_at TEXT NOT NULL,
          attempt_count INTEGER DEFAULT 1,
          filled INTEGER DEFAULT 0,
          filled_at TEXT,
          filled_price REAL,
          filled_size REAL
        )
      `);

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS rotation_runs (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          orders_cancelled INTEGER DEFAULT 0,
          orders_placed INTEGER DEFAULT 0,
          markets_skipped INTEGER DEFAULT 0,
          new_fills_detected INTEGER DEFAULT 0
        )
      `);

      // Create indexes for faster lookups
      this._db.exec(`
        CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
        CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);
        CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);
        CREATE INDEX IF NOT EXISTS idx_planned_orders_plan_run_id ON planned_orders(plan_run_id);
        CREATE INDEX IF NOT EXISTS idx_planned_orders_plan_run_id_valid ON planned_orders(plan_run_id, is_valid);
        CREATE INDEX IF NOT EXISTS idx_tracked_trades_strategy ON tracked_trades(strategy_id);
        CREATE INDEX IF NOT EXISTS idx_tracked_trades_token ON tracked_trades(token_id);
        CREATE INDEX IF NOT EXISTS idx_attempted_markets_filled ON attempted_markets(filled);
        CREATE INDEX IF NOT EXISTS idx_attempted_markets_token ON attempted_markets(token_id);
      `);
    } catch (error) {
      throw new Error(`Failed to initialize SQLite database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private initJson(): void {
    try {
      const dataDir = path.dirname(JSON_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Initialize empty JSON file if it doesn't exist
      if (!fs.existsSync(JSON_PATH)) {
        fs.writeFileSync(JSON_PATH, JSON.stringify([], null, 2));
      }
    } catch (error) {
      throw new Error(`Failed to initialize JSON storage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save or update a market
   */
  saveMarket(market: GammaMarket): void {
    if (this.useJson) {
      this.saveMarketJson(market);
    } else {
      this.saveMarketSqlite(market);
    }
  }

  private saveMarketSqlite(market: GammaMarket): void {
    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      INSERT INTO markets (id, question, slug, active, closed, endDate, closeDate, yesTokenId, noTokenId, condition_id, enable_order_book, min_tick_size, min_order_size, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        slug = excluded.slug,
        active = excluded.active,
        closed = excluded.closed,
        endDate = excluded.endDate,
        closeDate = excluded.closeDate,
        yesTokenId = excluded.yesTokenId,
        noTokenId = excluded.noTokenId,
        condition_id = COALESCE(excluded.condition_id, markets.condition_id),
        enable_order_book = COALESCE(excluded.enable_order_book, markets.enable_order_book),
        min_tick_size = COALESCE(excluded.min_tick_size, markets.min_tick_size),
        min_order_size = COALESCE(excluded.min_order_size, markets.min_order_size),
        updatedAt = CURRENT_TIMESTAMP
    `);

    stmt.run(
      market.id,
      market.question,
      market.slug || null,
      market.active ? 1 : 0,
      market.closed ? 1 : 0,
      market.endDate || null,
      market.closeDate || null,
      market.yesTokenId || null,
      market.noTokenId || null,
      market.conditionId || null,
      market.enableOrderBook !== null && market.enableOrderBook !== undefined ? (market.enableOrderBook ? 1 : 0) : null,
      market.minTickSize ?? null,
      market.minOrderSize ?? null
    );
  }

  private saveMarketJson(market: GammaMarket): void {
    try {
      const data = fs.existsSync(JSON_PATH)
        ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'))
        : [];

      const index = data.findIndex((m: GammaMarket) => m.id === market.id);
      if (index >= 0) {
        data[index] = { ...data[index], ...market, updatedAt: new Date().toISOString() };
      } else {
        data.push({ ...market, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }

      fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
    } catch (error) {
      throw new Error(`Failed to save market to JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save multiple markets in a transaction
   */
  saveMarkets(markets: GammaMarket[]): void {
    if (this.useJson) {
      markets.forEach(m => this.saveMarketJson(m));
    } else {
      this.saveMarketsSqlite(markets);
    }
  }

  private saveMarketsSqlite(markets: GammaMarket[]): void {
    if (!this._db) throw new Error('Database not initialized');

    const transaction = this._db.transaction((markets: GammaMarket[]) => {
      const stmt = this._db!.prepare(`
        INSERT INTO markets (id, question, slug, active, closed, endDate, closeDate, yesTokenId, noTokenId, condition_id, enable_order_book, min_tick_size, min_order_size, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          question = excluded.question,
          slug = excluded.slug,
          active = excluded.active,
          closed = excluded.closed,
          endDate = excluded.endDate,
          closeDate = excluded.closeDate,
          yesTokenId = excluded.yesTokenId,
          noTokenId = excluded.noTokenId,
          condition_id = COALESCE(excluded.condition_id, markets.condition_id),
          enable_order_book = COALESCE(excluded.enable_order_book, markets.enable_order_book),
          min_tick_size = COALESCE(excluded.min_tick_size, markets.min_tick_size),
          min_order_size = COALESCE(excluded.min_order_size, markets.min_order_size),
          updatedAt = CURRENT_TIMESTAMP
      `);

      for (const market of markets) {
        stmt.run(
          market.id,
          market.question,
          market.slug || null,
          market.active ? 1 : 0,
          market.closed ? 1 : 0,
          market.endDate || null,
          market.closeDate || null,
          market.yesTokenId || null,
          market.noTokenId || null,
          market.conditionId || null,
          market.enableOrderBook !== null && market.enableOrderBook !== undefined ? (market.enableOrderBook ? 1 : 0) : null,
          market.minTickSize ?? null,
          market.minOrderSize ?? null
        );
      }
    });

    transaction(markets);
  }

  /**
   * Get all markets
   */
  getAllMarkets(): GammaMarket[] {
    if (this.useJson) {
      return this.getAllMarketsJson();
    } else {
      return this.getAllMarketsSqlite();
    }
  }

  private getAllMarketsSqlite(): GammaMarket[] {
    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare('SELECT * FROM markets ORDER BY updatedAt DESC');
    const rows = stmt.all() as any[];

    return rows.map(row => this.mapRowToMarket(row));
  }

  private getAllMarketsJson(): GammaMarket[] {
    try {
      if (!fs.existsSync(JSON_PATH)) {
        return [];
      }
      return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to read markets from JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get market count
   */
  getMarketCount(): number {
    if (this.useJson) {
      return this.getAllMarketsJson().length;
    } else {
      if (!this._db) throw new Error('Database not initialized');
      const stmt = this._db.prepare('SELECT COUNT(*) as count FROM markets');
      const result = stmt.get() as { count: number };
      return result.count;
    }
  }

  /**
   * Get ingestion state value
   */
  getIngestionState(key: string): string | null {
    if (this.useJson) {
      // JSON mode doesn't support state
      return null;
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare('SELECT value FROM ingestion_state WHERE key = ?');
    const result = stmt.get(key) as { value: string } | undefined;
    return result?.value || null;
  }

  /**
   * Set ingestion state value
   */
  setIngestionState(key: string, value: string): void {
    if (this.useJson) {
      // JSON mode doesn't support state
      return;
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      INSERT INTO ingestion_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  /**
   * Get last event offset (for resumable ingestion)
   */
  getLastEventOffset(): number {
    const value = this.getIngestionState('last_event_offset');
    return value ? parseInt(value, 10) : 0;
  }

  /**
   * Set last event offset
   */
  setLastEventOffset(offset: number): void {
    this.setIngestionState('last_event_offset', String(offset));
  }

  /**
   * Get last run started timestamp
   */
  getLastRunStartedAt(): string | null {
    return this.getIngestionState('last_run_started_at');
  }

  /**
   * Set last run started timestamp
   */
  setLastRunStartedAt(timestamp: string): void {
    this.setIngestionState('last_run_started_at', timestamp);
  }

  /**
   * Get last run completed timestamp
   */
  getLastRunCompletedAt(): string | null {
    return this.getIngestionState('last_run_completed_at');
  }

  /**
   * Set last run completed timestamp
   */
  setLastRunCompletedAt(timestamp: string): void {
    this.setIngestionState('last_run_completed_at', timestamp);
  }

  /**
   * Update CLOB trading constraints for a market by condition_id
   */
  updateClobConstraintsByConditionId(
    conditionId: string,
    minTickSize: number | null,
    minOrderSize: number | null
  ): number {
    if (this.useJson) {
      // JSON mode doesn't support this operation efficiently
      throw new Error('updateClobConstraintsByConditionId is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      UPDATE markets
      SET 
        min_tick_size = COALESCE(?, min_tick_size),
        min_order_size = COALESCE(?, min_order_size),
        updatedAt = CURRENT_TIMESTAMP
      WHERE condition_id = ?
    `);

    const result = stmt.run(
      minTickSize ?? null,
      minOrderSize ?? null,
      conditionId
    );

    return result.changes;
  }

  /**
   * Bulk update CLOB constraints using a map of condition_id -> constraints
   */
  bulkUpdateClobConstraints(
    constraintsMap: Map<string, { minTickSize: number | null; minOrderSize: number | null }>
  ): { updated: number; total: number } {
    if (this.useJson) {
      throw new Error('bulkUpdateClobConstraints is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const transaction = this._db.transaction((map: Map<string, { minTickSize: number | null; minOrderSize: number | null }>) => {
      const stmt = this._db!.prepare(`
        UPDATE markets
        SET 
          min_tick_size = COALESCE(?, min_tick_size),
          min_order_size = COALESCE(?, min_order_size),
          updatedAt = CURRENT_TIMESTAMP
        WHERE LOWER(condition_id) = LOWER(?)
      `);

      let updated = 0;
      for (const [conditionId, constraints] of map.entries()) {
        const result = stmt.run(
          constraints.minTickSize ?? null,
          constraints.minOrderSize ?? null,
          conditionId
        );
        updated += result.changes;
      }
      return updated;
    });

    const updated = transaction(constraintsMap);
    return { updated, total: constraintsMap.size };
  }

  /**
   * Get market by condition_id or token_id
   */
  getMarketByIdentifier(conditionId?: string, tokenId?: string): GammaMarket | null {
    if (this.useJson) {
      const allMarkets = this.getAllMarketsJson();
      if (conditionId) {
        // Try matching by condition_id first, then by id
        const byConditionId = allMarkets.find(m => 
          m.conditionId?.toLowerCase() === conditionId.toLowerCase()
        );
        if (byConditionId) return byConditionId;
        return allMarkets.find(m => m.id === conditionId) || null;
      }
      if (tokenId) {
        return allMarkets.find(m => m.yesTokenId === tokenId || m.noTokenId === tokenId) || null;
      }
      return null;
    }

    if (!this._db) throw new Error('Database not initialized');

    let stmt;
    if (conditionId) {
      // Match by condition_id (case-insensitive)
      stmt = this._db.prepare('SELECT * FROM markets WHERE LOWER(condition_id) = LOWER(?) LIMIT 1');
      const row = stmt.get(conditionId) as any;
      if (!row) return null;
      return this.mapRowToMarket(row);
    } else if (tokenId) {
      stmt = this._db.prepare('SELECT * FROM markets WHERE yesTokenId = ? OR noTokenId = ? LIMIT 1');
      const row = stmt.get(tokenId, tokenId) as any;
      if (!row) return null;
      return this.mapRowToMarket(row);
    }

    return null;
  }

  private mapRowToMarket(row: any): GammaMarket {
    return {
      id: row.id,
      question: row.question,
      slug: row.slug,
      active: row.active === 1,
      closed: row.closed === 1,
      endDate: row.endDate,
      closeDate: row.closeDate,
      yesTokenId: row.yesTokenId,
      noTokenId: row.noTokenId,
      conditionId: row.condition_id,
      enableOrderBook: row.enable_order_book !== null && row.enable_order_book !== undefined ? (row.enable_order_book === 1) : null,
      minTickSize: row.min_tick_size ?? null,
      minOrderSize: row.min_order_size ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Get active markets missing condition_id
   */
  getMarketsMissingConditionId(): GammaMarket[] {
    if (this.useJson) {
      const allMarkets = this.getAllMarketsJson();
      return allMarkets.filter(m => 
        m.active && 
        !m.closed && 
        !m.conditionId
      );
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      SELECT * FROM markets
      WHERE active = 1 
        AND closed = 0
        AND condition_id IS NULL
      ORDER BY id ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToMarket(row));
  }

  /**
   * Update condition_id for a market by Gamma numeric id
   * Only updates if condition_id is currently NULL
   */
  updateConditionIdByMarketId(marketId: string, conditionId: string): number {
    if (this.useJson) {
      throw new Error('updateConditionIdByMarketId is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      UPDATE markets
      SET condition_id = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ? AND condition_id IS NULL
    `);

    const result = stmt.run(conditionId, marketId);
    return result.changes;
  }

  /**
   * Bulk update condition_id for multiple markets
   */
  bulkUpdateConditionIds(updates: Map<string, string>): { updated: number; total: number } {
    if (this.useJson) {
      throw new Error('bulkUpdateConditionIds is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const transaction = this._db.transaction((map: Map<string, string>) => {
      const stmt = this._db!.prepare(`
        UPDATE markets
        SET condition_id = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ? AND condition_id IS NULL
      `);

      let updated = 0;
      for (const [marketId, conditionId] of map.entries()) {
        const result = stmt.run(conditionId, marketId);
        updated += result.changes;
      }
      return updated;
    });

    const updated = transaction(updates);
    return { updated, total: updates.size };
  }

  /**
   * Get active markets that need enrichment (have condition_id but missing constraints)
   */
  getMarketsNeedingEnrichment(): GammaMarket[] {
    if (this.useJson) {
      const allMarkets = this.getAllMarketsJson();
      return allMarkets.filter(m => 
        m.active && 
        !m.closed && 
        m.conditionId && 
        // JSON mode doesn't track min_tick_size/min_order_size, so return all active with condition_id
        true
      );
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      SELECT * FROM markets
      WHERE active = 1 
        AND closed = 0
        AND condition_id IS NOT NULL
        AND (min_tick_size IS NULL OR min_order_size IS NULL)
      ORDER BY updatedAt DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToMarket(row));
  }

  /**
   * Check condition_id coverage for active markets
   */
  getConditionIdCoverage(): {
    activeMarkets: number;
    activeWithConditionId: number;
    coveragePercent: number;
  } {
    if (this.useJson) {
      const allMarkets = this.getAllMarketsJson();
      const activeMarkets = allMarkets.filter(m => m.active && !m.closed);
      const activeWithConditionId = activeMarkets.filter(m => m.conditionId);
      const coveragePercent = activeMarkets.length > 0
        ? (activeWithConditionId.length / activeMarkets.length) * 100
        : 0;
      return { activeMarkets: activeMarkets.length, activeWithConditionId: activeWithConditionId.length, coveragePercent };
    }

    if (!this._db) throw new Error('Database not initialized');

    const activeStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE active = 1 AND closed = 0
    `);
    const activeResult = activeStmt.get() as { count: number };

    const activeWithConditionIdStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE active = 1 AND closed = 0 AND condition_id IS NOT NULL
    `);
    const activeWithConditionIdResult = activeWithConditionIdStmt.get() as { count: number };

    const coveragePercent = activeResult.count > 0
      ? (activeWithConditionIdResult.count / activeResult.count) * 100
      : 0;

    return {
      activeMarkets: activeResult.count,
      activeWithConditionId: activeWithConditionIdResult.count,
      coveragePercent,
    };
  }

  /**
   * Get enrichment statistics
   */
  getEnrichmentStats(): {
    totalMarkets: number;
    totalEnriched: number;
    activeMarkets: number;
    activeMarketsWithConditionId: number;
    activeEnriched: number;
    activeEnrichedPercent: number;
  } {
    if (this.useJson) {
      const allMarkets = this.getAllMarketsJson();
      const activeMarkets = allMarkets.filter(m => m.active && !m.closed);
      const activeWithConditionId = activeMarkets.filter(m => m.conditionId);
      // JSON mode doesn't support CLOB constraints
      return {
        totalMarkets: allMarkets.length,
        totalEnriched: 0,
        activeMarkets: activeMarkets.length,
        activeMarketsWithConditionId: activeWithConditionId.length,
        activeEnriched: 0,
        activeEnrichedPercent: 0,
      };
    }

    if (!this._db) throw new Error('Database not initialized');

    const totalStmt = this._db.prepare('SELECT COUNT(*) as count FROM markets');
    const totalResult = totalStmt.get() as { count: number };

    const enrichedStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE min_tick_size IS NOT NULL OR min_order_size IS NOT NULL
    `);
    const enrichedResult = enrichedStmt.get() as { count: number };

    const activeStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE active = 1 AND closed = 0
    `);
    const activeResult = activeStmt.get() as { count: number };

    const activeWithConditionIdStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE active = 1 AND closed = 0 AND condition_id IS NOT NULL
    `);
    const activeWithConditionIdResult = activeWithConditionIdStmt.get() as { count: number };

    const activeEnrichedStmt = this._db.prepare(`
      SELECT COUNT(*) as count 
      FROM markets 
      WHERE active = 1 AND closed = 0 
      AND (min_tick_size IS NOT NULL OR min_order_size IS NOT NULL)
    `);
    const activeEnrichedResult = activeEnrichedStmt.get() as { count: number };

    const activeEnrichedPercent = activeResult.count > 0
      ? (activeEnrichedResult.count / activeResult.count) * 100
      : 0;

    return {
      totalMarkets: totalResult.count,
      totalEnriched: enrichedResult.count,
      activeMarkets: activeResult.count,
      activeMarketsWithConditionId: activeWithConditionIdResult.count,
      activeEnriched: activeEnrichedResult.count,
      activeEnrichedPercent,
    };
  }

  /**
   * Save a plan run
   */
  savePlanRun(id: string, mode: string, paramsJson: string, createdAt: string): void {
    if (this.useJson) {
      throw new Error('savePlanRun is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      INSERT INTO plan_runs (id, mode, params_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, mode, paramsJson, createdAt);
  }

  /**
   * Save multiple planned orders in a transaction
   */
  savePlannedOrders(orders: Array<{
    planRunId: string;
    marketId: string;
    question: string | null;
    yesTokenId: string | null;
    price: number | null;
    size: number | null;
    cost: number | null;
    minTickSize: number | null;
    minOrderSize: number | null;
    isValid: boolean;
    skipReason: string | null;
    createdAt: string;
  }>): void {
    if (this.useJson) {
      throw new Error('savePlannedOrders is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const transaction = this._db.transaction((orders) => {
      const stmt = this._db!.prepare(`
        INSERT INTO planned_orders (
          plan_run_id, market_id, question, yes_token_id, price, size, cost,
          min_tick_size, min_order_size, is_valid, skip_reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const order of orders) {
        stmt.run(
          order.planRunId,
          order.marketId,
          order.question,
          order.yesTokenId,
          order.price,
          order.size,
          order.cost,
          order.minTickSize,
          order.minOrderSize,
          order.isValid ? 1 : 0,
          order.skipReason,
          order.createdAt
        );
      }
    });

    transaction(orders);
  }

  /**
   * Get the latest plan run
   */
  getLatestPlanRun(): {
    id: string;
    mode: string;
    paramsJson: string;
    createdAt: string;
  } | null {
    if (this.useJson) {
      throw new Error('getLatestPlanRun is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      SELECT id, mode, params_json, created_at
      FROM plan_runs
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as any;
    if (!row) return null;

    return {
      id: row.id,
      mode: row.mode,
      paramsJson: row.params_json,
      createdAt: row.created_at,
    };
  }

  /**
   * Get all planned orders for a plan run
   */
  getPlannedOrders(planRunId: string): Array<{
    planRunId: string;
    marketId: string;
    question: string | null;
    yesTokenId: string | null;
    price: number | null;
    size: number | null;
    cost: number | null;
    minTickSize: number | null;
    minOrderSize: number | null;
    isValid: boolean;
    skipReason: string | null;
    createdAt: string;
  }> {
    if (this.useJson) {
      throw new Error('getPlannedOrders is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      SELECT 
        plan_run_id, market_id, question, yes_token_id, price, size, cost,
        min_tick_size, min_order_size, is_valid, skip_reason, created_at
      FROM planned_orders
      WHERE plan_run_id = ?
      ORDER BY CASE WHEN cost IS NULL THEN 1 ELSE 0 END, cost DESC, market_id ASC
    `);
    const rows = stmt.all(planRunId) as any[];

    return rows.map(row => ({
      planRunId: row.plan_run_id,
      marketId: row.market_id,
      question: row.question,
      yesTokenId: row.yes_token_id,
      price: row.price,
      size: row.size,
      cost: row.cost,
      minTickSize: row.min_tick_size,
      minOrderSize: row.min_order_size,
      isValid: row.is_valid === 1,
      skipReason: row.skip_reason,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get one valid planned order with smallest cost for a plan run
   */
  getOneValidOrder(planRunId: string): {
    planRunId: string;
    marketId: string;
    question: string | null;
    yesTokenId: string | null;
    price: number | null;
    size: number | null;
    cost: number | null;
    minTickSize: number | null;
    minOrderSize: number | null;
    isValid: boolean;
    skipReason: string | null;
    createdAt: string;
  } | null {
    if (this.useJson) {
      throw new Error('getOneValidOrder is not supported in JSON mode');
    }

    if (!this._db) throw new Error('Database not initialized');

    const stmt = this._db.prepare(`
      SELECT 
        plan_run_id, market_id, question, yes_token_id, price, size, cost,
        min_tick_size, min_order_size, is_valid, skip_reason, created_at
      FROM planned_orders
      WHERE plan_run_id = ? 
        AND is_valid = 1 
        AND cost IS NOT NULL
      ORDER BY cost ASC
      LIMIT 1
    `);
    const row = stmt.get(planRunId) as any;
    if (!row) return null;

    return {
      planRunId: row.plan_run_id,
      marketId: row.market_id,
      question: row.question,
      yesTokenId: row.yes_token_id,
      price: row.price,
      size: row.size,
      cost: row.cost,
      minTickSize: row.min_tick_size,
      minOrderSize: row.min_order_size,
      isValid: row.is_valid === 1,
      skipReason: row.skip_reason,
      createdAt: row.created_at,
    };
  }

  /**
   * Get all strategies
   */
  getStrategies(): Array<{
    id: string;
    name: string;
    description: string | null;
    color: string;
    createdAt: string;
    isActive: boolean;
  }> {
    if (!this._db) throw new Error('Database not initialized');

    const rows = this._db.prepare(`
      SELECT id, name, description, color, created_at, is_active
      FROM strategies
      ORDER BY created_at ASC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color,
      createdAt: row.created_at,
      isActive: row.is_active === 1,
    }));
  }

  /**
   * Create a new strategy
   */
  createStrategy(id: string, name: string, description: string | null, color: string): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      INSERT INTO strategies (id, name, description, color)
      VALUES (?, ?, ?, ?)
    `).run(id, name, description, color);
  }

  /**
   * Save a tracked trade
   */
  saveTrackedTrade(trade: {
    id: string;
    strategyId: string;
    marketId: string | null;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    cost: number;
    orderId: string | null;
    matchTime: string | null;
  }): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      INSERT OR REPLACE INTO tracked_trades
      (id, strategy_id, market_id, token_id, side, price, size, cost, order_id, match_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id,
      trade.strategyId,
      trade.marketId,
      trade.tokenId,
      trade.side,
      trade.price,
      trade.size,
      trade.cost,
      trade.orderId,
      trade.matchTime
    );
  }

  /**
   * Get tracked trades by strategy
   */
  getTrackedTradesByStrategy(strategyId: string): Array<{
    id: string;
    strategyId: string;
    marketId: string | null;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    cost: number;
    orderId: string | null;
    matchTime: string | null;
  }> {
    if (!this._db) throw new Error('Database not initialized');

    const rows = this._db.prepare(`
      SELECT id, strategy_id, market_id, token_id, side, price, size, cost, order_id, match_time
      FROM tracked_trades
      WHERE strategy_id = ?
      ORDER BY created_at DESC
    `).all(strategyId) as any[];

    return rows.map(row => ({
      id: row.id,
      strategyId: row.strategy_id,
      marketId: row.market_id,
      tokenId: row.token_id,
      side: row.side,
      price: row.price,
      size: row.size,
      cost: row.cost,
      orderId: row.order_id,
      matchTime: row.match_time,
    }));
  }

  /**
   * Get all tracked trades
   */
  getAllTrackedTrades(): Array<{
    id: string;
    strategyId: string;
    marketId: string | null;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    cost: number;
    orderId: string | null;
    matchTime: string | null;
  }> {
    if (!this._db) throw new Error('Database not initialized');

    const rows = this._db.prepare(`
      SELECT id, strategy_id, market_id, token_id, side, price, size, cost, order_id, match_time
      FROM tracked_trades
      ORDER BY created_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      strategyId: row.strategy_id,
      marketId: row.market_id,
      tokenId: row.token_id,
      side: row.side,
      price: row.price,
      size: row.size,
      cost: row.cost,
      orderId: row.order_id,
      matchTime: row.match_time,
    }));
  }

  /**
   * Get strategy performance stats
   */
  getStrategyStats(strategyId: string): {
    totalTrades: number;
    totalCost: number;
    totalShares: number;
    avgPrice: number;
  } {
    if (!this._db) throw new Error('Database not initialized');

    const row = this._db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        COALESCE(SUM(cost), 0) as total_cost,
        COALESCE(SUM(size), 0) as total_shares,
        COALESCE(AVG(price), 0) as avg_price
      FROM tracked_trades
      WHERE strategy_id = ?
    `).get(strategyId) as any;

    return {
      totalTrades: row.total_trades,
      totalCost: row.total_cost,
      totalShares: row.total_shares,
      avgPrice: row.avg_price,
    };
  }

  // ============ Rotation Tracking Methods ============

  /**
   * Mark a market as attempted
   */
  markMarketAttempted(marketId: string, tokenId: string): void {
    if (!this._db) throw new Error('Database not initialized');

    const now = new Date().toISOString();
    this._db.prepare(`
      INSERT INTO attempted_markets (market_id, token_id, first_attempt_at, last_attempt_at, attempt_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(market_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        attempt_count = attempt_count + 1
    `).run(marketId, tokenId, now, now);
  }

  /**
   * Mark a market as filled
   */
  markMarketFilled(marketId: string, price: number, size: number): void {
    if (!this._db) throw new Error('Database not initialized');

    const now = new Date().toISOString();
    this._db.prepare(`
      UPDATE attempted_markets
      SET filled = 1, filled_at = ?, filled_price = ?, filled_size = ?
      WHERE market_id = ?
    `).run(now, price, size, marketId);
  }

  /**
   * Get markets that haven't been attempted yet (for rotation)
   */
  getUntriedMarkets(limit: number): Array<{
    id: string;
    question: string;
    yesTokenId: string;
    noTokenId: string;
    endDate: string | null;
    minTickSize: number | null;
    minOrderSize: number | null;
  }> {
    if (!this._db) throw new Error('Database not initialized');

    const rows = this._db.prepare(`
      SELECT m.id, m.question, m.yesTokenId, m.noTokenId, m.endDate,
             m.min_tick_size, m.min_order_size
      FROM markets m
      LEFT JOIN attempted_markets am ON m.id = am.market_id
      WHERE m.active = 1
        AND m.closed = 0
        AND m.enable_order_book = 1
        AND m.min_tick_size IS NOT NULL
        AND m.min_order_size IS NOT NULL
        AND m.yesTokenId IS NOT NULL
        AND am.market_id IS NULL
        AND m.endDate > datetime('now')
      ORDER BY m.endDate ASC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(row => ({
      id: row.id,
      question: row.question,
      yesTokenId: row.yesTokenId,
      noTokenId: row.noTokenId,
      endDate: row.endDate,
      minTickSize: row.min_tick_size,
      minOrderSize: row.min_order_size,
    }));
  }

  /**
   * Get rotation stats
   */
  getRotationStats(): {
    totalAttempted: number;
    totalFilled: number;
    fillRate: number;
    marketsRemaining: number;
  } {
    if (!this._db) throw new Error('Database not initialized');

    const attempted = this._db.prepare(`
      SELECT COUNT(*) as count FROM attempted_markets
    `).get() as any;

    const filled = this._db.prepare(`
      SELECT COUNT(*) as count FROM attempted_markets WHERE filled = 1
    `).get() as any;

    const totalEligible = this._db.prepare(`
      SELECT COUNT(*) as count FROM markets
      WHERE active = 1 AND closed = 0 AND enable_order_book = 1
        AND min_tick_size IS NOT NULL AND yesTokenId IS NOT NULL
        AND endDate > datetime('now')
    `).get() as any;

    const totalAttempted = attempted?.count || 0;
    const totalFilled = filled?.count || 0;

    return {
      totalAttempted,
      totalFilled,
      fillRate: totalAttempted > 0 ? (totalFilled / totalAttempted) * 100 : 0,
      marketsRemaining: (totalEligible?.count || 0) - totalAttempted,
    };
  }

  /**
   * Save a rotation run
   */
  saveRotationRun(run: {
    id: string;
    startedAt: string;
    completedAt?: string;
    ordersCancelled: number;
    ordersPlaced: number;
    marketsSkipped: number;
    newFillsDetected: number;
  }): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      INSERT INTO rotation_runs (id, started_at, completed_at, orders_cancelled, orders_placed, markets_skipped, new_fills_detected)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        completed_at = excluded.completed_at,
        orders_cancelled = excluded.orders_cancelled,
        orders_placed = excluded.orders_placed,
        markets_skipped = excluded.markets_skipped,
        new_fills_detected = excluded.new_fills_detected
    `).run(
      run.id,
      run.startedAt,
      run.completedAt || null,
      run.ordersCancelled,
      run.ordersPlaced,
      run.marketsSkipped,
      run.newFillsDetected
    );
  }

  /**
   * Mark a market as having no orderbook (for 404 errors)
   */
  markMarketNoOrderbook(marketId: string): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      UPDATE markets SET enable_order_book = 0, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(marketId);
  }

  /**
   * Mark a market as having no orderbook by condition_id
   */
  markConditionIdNoOrderbook(conditionId: string): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      UPDATE markets SET enable_order_book = 0, updatedAt = CURRENT_TIMESTAMP
      WHERE LOWER(condition_id) = LOWER(?)
    `).run(conditionId);
  }

  /**
   * Mark a market as having an active orderbook by condition_id
   */
  markConditionIdHasOrderbook(conditionId: string): void {
    if (!this._db) throw new Error('Database not initialized');

    this._db.prepare(`
      UPDATE markets SET enable_order_book = 1, updatedAt = CURRENT_TIMESTAMP
      WHERE LOWER(condition_id) = LOWER(?)
    `).run(conditionId);
  }

  /**
   * Bulk mark markets as attempted
   */
  bulkMarkMarketsAttempted(markets: Array<{ marketId: string; tokenId: string }>): void {
    if (!this._db) throw new Error('Database not initialized');

    const now = new Date().toISOString();
    const stmt = this._db.prepare(`
      INSERT INTO attempted_markets (market_id, token_id, first_attempt_at, last_attempt_at, attempt_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(market_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        attempt_count = attempt_count + 1
    `);

    const transaction = this._db.transaction((items: typeof markets) => {
      for (const item of items) {
        stmt.run(item.marketId, item.tokenId, now, now);
      }
    });

    transaction(markets);
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

