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

// Wallet to copy trades from (subledger)
export interface CopyTarget {
  address: string;
  alias?: string;
  enabled: boolean;
  createdAt: string;

  // Subledger: Funding
  totalDeposited: number;       // Sum of all deposits
  totalWithdrawn: number;       // Sum of all withdrawals

  // Per-wallet guardrails (null = use global default)
  maxCostPerTrade: number | null;
  maxExposure: number | null;
  sizingMode: 'fixed_dollar' | 'fixed_shares' | 'proportional' | 'match' | 'conviction' | null;
  fixedDollarAmount: number | null;
  copyRatio: number | null;     // For conviction mode: ratio of target's trade to copy (e.g., 0.1 = 10%)
  minPrice: number | null;
  maxPrice: number | null;
  allowOverdraft: boolean;      // OD facility (default: false)
}

// Subledger transaction (deposit/withdrawal)
export interface SubledgerTransaction {
  id: string;
  targetAddress: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  note: string | null;
  createdAt: string;
}

// Operating account for unallocated funds
export interface OperatingAccount {
  totalDeposited: number;
  totalWithdrawn: number;
  totalAllocatedToWallets: number;  // Sum of deposits to all wallets
  availableBalance: number;         // Calculated
}

// Wallet stats (calculated)
export interface WalletStats {
  address: string;
  alias: string | null;
  enabled: boolean;
  totalDeposited: number;
  totalWithdrawn: number;
  currentExposure: number;      // Sum of open positions
  realizedPnl: number;          // Sum of closed position P&L
  availableBalance: number;     // deposited - withdrawn + pnl - exposure
  returnPercent: number;        // (available + exposure - deposited + withdrawn) / deposited * 100
  openPositions: number;
  closedPositions: number;
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

// Individual rule evaluation result
export interface RuleEvaluation {
  rule: string;           // Rule name/description
  passed: boolean;        // Did the rule pass?
  actual: string;         // Actual value (formatted)
  threshold: string;      // Threshold value (formatted)
  math?: string;          // Optional math breakdown
}

// Complete guardrail evaluation for a trade
export interface GuardrailEvaluation {
  timestamp: string;
  side: 'BUY' | 'SELL';
  outcome: 'placed' | 'skipped' | 'failed';
  rules: RuleEvaluation[];
  sizingCalculation?: {
    mode: string;
    inputValue: number;
    calculatedShares: number;
    finalCost: number;
  };
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
  marketTitle: string | null;
  marketSlug: string | null;
  eventSlug: string | null;
  ruleEvaluation: GuardrailEvaluation | null;
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
  sizingMode: 'fixed_dollar' | 'fixed_shares' | 'proportional' | 'match' | 'conviction';
  fixedDollarAmount?: number;   // For 'fixed_dollar' mode - spend this much per trade
  fixedShares?: number;         // For 'fixed_shares' mode - buy this many shares
  proportionalRatio?: number;   // For 'proportional' mode (e.g., 0.1 = 10% of their size)
  copyRatio?: number;           // For 'conviction' mode (e.g., 0.1 = 10% of target's $ value)

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

  // Guardrails for conviction-based strategy
  maxCostPerTrade: 10.00,       // Max $10 per trade (cap for large trades)
  maxTotalCostPerRun: 50.00,    // Max $50 per run
  maxExposurePerTarget: 50.00,  // Max $50 total exposure per trader (open positions)
  maxTradesPerRun: 10,          // Max 10 trades per run
  minTradeSize: 1,              // At least 1 share
  maxPriceSlippage: 0.10,       // 10% max slippage

  // Default sizing - conviction-based
  sizingMode: 'conviction',
  copyRatio: 0.10,              // 10% of target's trade value for large trades
  fixedDollarAmount: 5.00,      // Fallback for fixed_dollar mode

  // Filters
  copySide: 'BOTH',             // Copy both buys and sells
  copyExits: true,              // When they sell, we sell our position too
  minOriginalPrice: 0.01,       // Minimum 1 cent (avoid dust)
  maxOriginalPrice: 0.99,       // Maximum 99 cents (copy everything)

  // Timing
  pollIntervalMs: 10000,        // Check every 10 seconds
  maxTradeAgeMs: 2592000000,    // 30 days (for testing - reduce for production)

  // Safety
  requireConfirmation: true,
  dryRun: false,
};
