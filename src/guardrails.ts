/**
 * Guardrails configuration to prevent fund misallocation
 * All limits are in USDC
 */

export interface GuardrailConfig {
  // Maximum cost for a single order
  maxSingleOrderCost: number;

  // Maximum total spend per day
  maxDailySpend: number;

  // Maximum number of orders per day
  maxOrdersPerDay: number;

  // Minimum price (floor) - orders below this are suspicious
  minAllowedPrice: number;

  // Maximum price - orders above this might be mistakes
  maxAllowedPrice: number;

  // Maximum size per order
  maxOrderSize: number;

  // Require explicit confirmation for orders above this cost
  confirmationThreshold: number;

  // Read-only mode - no orders can be placed
  readOnlyMode: boolean;

  // Allowed markets (empty = all allowed)
  allowedMarketIds: string[];

  // Blocked markets
  blockedMarketIds: string[];
}

// Default conservative guardrails
export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxSingleOrderCost: 0.05,      // Max $0.05 per order
  maxDailySpend: 1.00,           // Max $1.00 per day
  maxOrdersPerDay: 50,           // Max 50 orders per day
  minAllowedPrice: 0.001,        // Min price 0.1%
  maxAllowedPrice: 0.10,         // Max price 10% (we're buying floor)
  maxOrderSize: 100,             // Max 100 shares per order
  confirmationThreshold: 0.02,   // Confirm orders over $0.02
  readOnlyMode: true,            // Start in read-only mode
  allowedMarketIds: [],          // Empty = all allowed
  blockedMarketIds: [],          // No blocked markets
};

export interface OrderValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateOrder(
  guardrails: GuardrailConfig,
  order: {
    marketId: string;
    price: number;
    size: number;
    cost: number;
  },
  dailyStats: {
    ordersToday: number;
    spentToday: number;
  }
): OrderValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check read-only mode
  if (guardrails.readOnlyMode) {
    errors.push('Read-only mode is enabled. Disable to place orders.');
  }

  // Check single order cost
  if (order.cost > guardrails.maxSingleOrderCost) {
    errors.push(`Order cost $${order.cost.toFixed(4)} exceeds max $${guardrails.maxSingleOrderCost.toFixed(4)}`);
  }

  // Check daily spend
  if (dailyStats.spentToday + order.cost > guardrails.maxDailySpend) {
    errors.push(`Would exceed daily limit. Spent: $${dailyStats.spentToday.toFixed(4)}, Order: $${order.cost.toFixed(4)}, Limit: $${guardrails.maxDailySpend.toFixed(4)}`);
  }

  // Check daily order count
  if (dailyStats.ordersToday >= guardrails.maxOrdersPerDay) {
    errors.push(`Daily order limit reached: ${guardrails.maxOrdersPerDay}`);
  }

  // Check price bounds
  if (order.price < guardrails.minAllowedPrice) {
    errors.push(`Price $${order.price} below minimum $${guardrails.minAllowedPrice}`);
  }
  if (order.price > guardrails.maxAllowedPrice) {
    errors.push(`Price $${order.price} above maximum $${guardrails.maxAllowedPrice}`);
  }

  // Check size
  if (order.size > guardrails.maxOrderSize) {
    errors.push(`Size ${order.size} exceeds max ${guardrails.maxOrderSize}`);
  }

  // Check blocked markets
  if (guardrails.blockedMarketIds.includes(order.marketId)) {
    errors.push(`Market ${order.marketId} is blocked`);
  }

  // Check allowed markets (if whitelist is set)
  if (guardrails.allowedMarketIds.length > 0 && !guardrails.allowedMarketIds.includes(order.marketId)) {
    errors.push(`Market ${order.marketId} not in allowed list`);
  }

  // Warnings
  if (order.cost > guardrails.confirmationThreshold) {
    warnings.push(`Order cost $${order.cost.toFixed(4)} exceeds confirmation threshold`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
