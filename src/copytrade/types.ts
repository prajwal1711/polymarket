/**
 * Types for copytrading functionality
 */

// Trade from Polymarket Data API
export interface PolymarketTrade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;  // token ID
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;  // ISO timestamp
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;  // wallet address
  maker_address: string;
  transaction_hash: string;
  trader_side: 'TAKER' | 'MAKER';
}

// Activity item from Polymarket Data API
export interface PolymarketActivity {
  id: string;
  type: string;  // 'TRADE', 'REDEEM', etc.
  timestamp: string;
  market?: string;
  asset_id?: string;
  side?: string;
  size?: string;
  price?: string;
  transaction_hash?: string;
}

// Position from Polymarket Data API
export interface PolymarketPosition {
  asset_id: string;  // token ID
  market: string;  // condition ID
  size: string;
  avg_price: string;
  cur_price: string;
  pnl: string;
  realized_pnl: string;
  outcome: string;
}

// Wallet to copy trades from
export interface CopyTarget {
  address: string;
  alias?: string;
  enabled: boolean;
  createdAt: string;
}

// A trade we've identified to copy
export interface CopyCandidate {
  originalTradeId: string;
  targetAddress: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  originalPrice: number;
  originalSize: number;
  matchTime: string;
}

// A copied trade record
export interface CopiedTrade {
  id: string;
  originalTradeId: string;
  targetAddress: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  originalPrice: number;
  originalSize: number;
  copyPrice: number | null;
  copySize: number | null;
  copyCost: number | null;
  orderId: string | null;
  status: 'pending' | 'placed' | 'filled' | 'failed' | 'skipped';
  skipReason: string | null;
  createdAt: string;
  executedAt: string | null;
}

// Copytrade run record
export interface CopytradeRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  targetAddress: string;
  tradesFound: number;
  tradesNew: number;
  tradesCopied: number;
  tradesSkipped: number;
  tradesFailed: number;
  totalCost: number;
}

// Configuration for copytrading
export interface CopytradeConfig {
  // Target wallets to copy
  targets: string[];

  // Guardrails
  maxCostPerTrade: number;      // Max USDC to spend per copied trade
  maxTotalCostPerRun: number;   // Max total USDC to spend per run
  maxExposurePerTarget: number; // Max total exposure per target (open positions)
  maxTradesPerRun: number;      // Max trades to copy per run
  minTradeSize: number;         // Minimum size to consider copying
  maxPriceSlippage: number;     // Max price difference from original (e.g., 0.05 = 5%)

  // Sizing
  sizingMode: 'fixed_dollar' | 'fixed_shares' | 'proportional' | 'match';
  fixedDollarAmount?: number;   // For 'fixed_dollar' mode - spend this much per trade
  fixedShares?: number;         // For 'fixed_shares' mode - buy this many shares
  proportionalRatio?: number;   // For 'proportional' mode (e.g., 0.1 = 10% of their size)

  // Filters
  copySide: 'BUY' | 'SELL' | 'BOTH';
  copyExits: boolean;           // When they SELL a token we hold, sell ours too
  minOriginalPrice: number;     // Only copy trades at this price or higher
  maxOriginalPrice: number;     // Only copy trades at this price or lower

  // Timing
  pollIntervalMs: number;       // How often to check for new trades
  maxTradeAgeMs: number;        // Only copy trades newer than this

  // Safety
  requireConfirmation: boolean; // Require CONFIRM env var
  dryRun: boolean;              // Don't actually place orders
}

// Default configuration
export const DEFAULT_CONFIG: CopytradeConfig = {
  targets: [],

  // Guardrails for $5/trade strategy
  maxCostPerTrade: 5.50,        // Max ~$5 per trade (with buffer)
  maxTotalCostPerRun: 25.00,    // Max $25 per run
  maxExposurePerTarget: 50.00,  // Max $50 total exposure per trader (open positions)
  maxTradesPerRun: 10,          // Max 10 trades per run
  minTradeSize: 1,              // At least 1 share
  maxPriceSlippage: 0.10,       // 10% max slippage

  // Default sizing - $5 per trade
  sizingMode: 'fixed_dollar',
  fixedDollarAmount: 5.00,      // Spend $5 per copied trade

  // Filters
  copySide: 'BOTH',             // Copy both buys and sells
  copyExits: true,              // When they sell, we sell our position too
  minOriginalPrice: 0.01,       // Minimum 1 cent (avoid dust)
  maxOriginalPrice: 0.99,       // Maximum 99 cents (copy everything)

  // Timing
  pollIntervalMs: 60000,        // Check every minute
  maxTradeAgeMs: 2592000000,    // 30 days (for testing - reduce for production)

  // Safety
  requireConfirmation: true,
  dryRun: false,
};
