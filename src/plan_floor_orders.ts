/**
 * Floor order planning script (dry run)
 * Plans floor orders for eligible markets with stratified sampling
 */

import { MarketStorage } from './storage';
import { GammaMarket } from './types/market';
import { randomUUID } from 'crypto';

// Configuration defaults
const DEFAULT_BUDGET = 10.0; // Total budget in USDC
const DEFAULT_PER_MARKET = 0.01; // Max spend per market in USDC
const DEFAULT_BUCKETS = [50, 30, 20]; // fast/med/slow weights

// Time bucket thresholds (in days)
const FAST_THRESHOLD_DAYS = 30;
const MED_THRESHOLD_DAYS = 120;

interface PlanConfig {
  mode: 'strict' | 'floor';
  maxFloorPrice: number;
  budget: number;
  perMarket: number;
  bucketWeights: number[]; // [fast, med, slow]
}

// Parse CLI arguments
function parseArgs(): PlanConfig {
  const args = process.argv.slice(2);
  let mode: 'strict' | 'floor' = 'floor'; // default to floor mode for stratified
  let maxFloorPrice = 0.01; // default for floor mode
  let budget = DEFAULT_BUDGET;
  let perMarket = DEFAULT_PER_MARKET;
  let bucketWeights = [...DEFAULT_BUCKETS];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      if (i + 1 < args.length) {
        const modeValue = args[i + 1];
        if (modeValue === 'strict' || modeValue === 'floor') {
          mode = modeValue;
        } else {
          console.error(`Invalid mode: ${modeValue}. Must be 'strict' or 'floor'`);
          process.exit(1);
        }
      } else {
        console.error('--mode requires a value');
        process.exit(1);
      }
    } else if (args[i] === '--maxFloorPrice') {
      if (i + 1 < args.length) {
        const priceValue = parseFloat(args[i + 1]);
        if (isNaN(priceValue) || priceValue <= 0) {
          console.error(`Invalid maxFloorPrice: ${args[i + 1]}. Must be a positive number`);
          process.exit(1);
        }
        maxFloorPrice = priceValue;
      } else {
        console.error('--maxFloorPrice requires a value');
        process.exit(1);
      }
    } else if (args[i] === '--budget') {
      if (i + 1 < args.length) {
        const budgetValue = parseFloat(args[i + 1]);
        if (isNaN(budgetValue) || budgetValue <= 0) {
          console.error(`Invalid budget: ${args[i + 1]}. Must be a positive number`);
          process.exit(1);
        }
        budget = budgetValue;
      } else {
        console.error('--budget requires a value');
        process.exit(1);
      }
    } else if (args[i] === '--perMarket') {
      if (i + 1 < args.length) {
        const perMarketValue = parseFloat(args[i + 1]);
        if (isNaN(perMarketValue) || perMarketValue <= 0) {
          console.error(`Invalid perMarket: ${args[i + 1]}. Must be a positive number`);
          process.exit(1);
        }
        perMarket = perMarketValue;
      } else {
        console.error('--perMarket requires a value');
        process.exit(1);
      }
    } else if (args[i] === '--buckets') {
      if (i + 1 < args.length) {
        const bucketStr = args[i + 1];
        const parts = bucketStr.split(',').map(s => parseInt(s.trim(), 10));
        if (parts.length !== 3 || parts.some(isNaN) || parts.some(p => p < 0)) {
          console.error(`Invalid buckets: ${bucketStr}. Must be 3 comma-separated non-negative integers (e.g., "50,30,20")`);
          process.exit(1);
        }
        bucketWeights = parts;
      } else {
        console.error('--buckets requires a value');
        process.exit(1);
      }
    }
  }

  return { mode, maxFloorPrice, budget, perMarket, bucketWeights };
}

type TimeBucket = 'fast' | 'med' | 'slow';

/**
 * Categorize a market by time-to-resolution
 */
function categorizeByTime(market: GammaMarket): TimeBucket {
  const now = new Date();

  // Use endDate if available, otherwise closeDate
  const endDateStr = market.endDate || market.closeDate;

  if (!endDateStr) {
    // No end date = long tail / unknown
    return 'slow';
  }

  const endDate = new Date(endDateStr);
  const daysToResolution = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysToResolution < 0) {
    // Already past end date but still active - treat as fast (will resolve soon)
    return 'fast';
  } else if (daysToResolution <= FAST_THRESHOLD_DAYS) {
    return 'fast';
  } else if (daysToResolution <= MED_THRESHOLD_DAYS) {
    return 'med';
  } else {
    return 'slow';
  }
}

/**
 * Fisher-Yates shuffle for random sampling
 */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Stratified random sampling from time buckets
 */
function stratifiedSample(
  markets: GammaMarket[],
  bucketWeights: number[],
  targetCount: number
): { sampled: GammaMarket[]; bucketStats: Record<TimeBucket, { available: number; sampled: number }> } {
  // Categorize all markets
  const buckets: Record<TimeBucket, GammaMarket[]> = {
    fast: [],
    med: [],
    slow: [],
  };

  for (const market of markets) {
    const bucket = categorizeByTime(market);
    buckets[bucket].push(market);
  }

  // Calculate target counts per bucket
  const totalWeight = bucketWeights.reduce((a, b) => a + b, 0);
  const bucketNames: TimeBucket[] = ['fast', 'med', 'slow'];

  const targetPerBucket: Record<TimeBucket, number> = {
    fast: Math.round((bucketWeights[0] / totalWeight) * targetCount),
    med: Math.round((bucketWeights[1] / totalWeight) * targetCount),
    slow: Math.round((bucketWeights[2] / totalWeight) * targetCount),
  };

  // Sample from each bucket (with overflow handling)
  const sampled: GammaMarket[] = [];
  const bucketStats: Record<TimeBucket, { available: number; sampled: number }> = {
    fast: { available: buckets.fast.length, sampled: 0 },
    med: { available: buckets.med.length, sampled: 0 },
    slow: { available: buckets.slow.length, sampled: 0 },
  };

  let overflow = 0; // Markets we couldn't sample due to bucket exhaustion

  for (const bucket of bucketNames) {
    const available = buckets[bucket];
    const target = targetPerBucket[bucket];
    const shuffled = shuffle(available);
    const toSample = Math.min(target, shuffled.length);

    sampled.push(...shuffled.slice(0, toSample));
    bucketStats[bucket].sampled = toSample;

    if (toSample < target) {
      overflow += target - toSample;
    }
  }

  // Distribute overflow to other buckets (prioritize by weight)
  if (overflow > 0) {
    for (const bucket of bucketNames) {
      if (overflow <= 0) break;

      const available = buckets[bucket];
      const alreadySampled = bucketStats[bucket].sampled;
      const remaining = available.length - alreadySampled;

      if (remaining > 0) {
        const shuffled = shuffle(available.slice(alreadySampled));
        const extra = Math.min(overflow, remaining);
        sampled.push(...shuffled.slice(0, extra));
        bucketStats[bucket].sampled += extra;
        overflow -= extra;
      }
    }
  }

  return { sampled, bucketStats };
}

/**
 * Check if floor price is valid given min_tick_size (strict mode)
 */
function isValidFloorPriceStrict(floorPrice: number, minTickSize: number | null): boolean {
  if (minTickSize === null || minTickSize === undefined) {
    return false;
  }
  // Floor price must be a multiple of min_tick_size
  // Check if floorPrice is approximately a multiple of minTickSize (with small epsilon for floating point)
  const remainder = floorPrice % minTickSize;
  const epsilon = 0.0000001;
  return remainder < epsilon || remainder > (minTickSize - epsilon);
}

/**
 * Check if min_tick_size is valid for floor mode (min_tick_size <= maxFloorPrice)
 */
function isValidFloorPriceFloor(minTickSize: number | null, maxFloorPrice: number): boolean {
  if (minTickSize === null || minTickSize === undefined) {
    return false;
  }
  return minTickSize <= maxFloorPrice;
}

/**
 * Main planning function
 */
function planFloorOrders(): void {
  const config = parseArgs();
  const mode = config.mode === 'strict' ? 'strict_001' : 'floor_up_to_001';

  // Calculate target market count from budget
  const targetMarketCount = Math.floor(config.budget / config.perMarket);

  console.log('Planning floor orders with stratified sampling (dry run)...\n');
  console.log(`Configuration:`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Max Floor Price: ${config.maxFloorPrice}`);
  console.log(`  Budget: $${config.budget.toFixed(2)}`);
  console.log(`  Per Market: $${config.perMarket.toFixed(4)}`);
  console.log(`  Target Markets: ${targetMarketCount}`);
  console.log(`  Bucket Weights: fast=${config.bucketWeights[0]}%, med=${config.bucketWeights[1]}%, slow=${config.bucketWeights[2]}%`);
  console.log(`  Time Thresholds: fast=<${FAST_THRESHOLD_DAYS}d, med=<${MED_THRESHOLD_DAYS}d, slow=>=${MED_THRESHOLD_DAYS}d\n`);

  const storage = new MarketStorage(false); // Use SQLite

  try {
    // Load eligible markets
    console.log('Step 1: Loading eligible markets...');

    const allMarkets = storage.getAllMarkets();
    const baseEligible = allMarkets.filter(m =>
      m.active &&
      !m.closed &&
      m.enableOrderBook === true &&
      m.yesTokenId !== null &&
      m.minTickSize !== null &&
      m.minOrderSize !== null
    );

    // Filter to markets where we can place an order within perMarket budget
    // cost = price * size, where price = minTickSize, size >= minOrderSize
    // So minimum cost = minTickSize * minOrderSize
    const eligibleMarkets = baseEligible.filter(m => {
      const price = m.minTickSize!;
      const minSize = m.minOrderSize!;
      // Only include if price is within maxFloorPrice
      if (price > config.maxFloorPrice) return false;
      // Calculate minimum viable cost
      const minCost = price * minSize;
      return minCost <= config.perMarket;
    });

    console.log(`  Found ${baseEligible.length} base eligible markets`);
    console.log(`  After cost filter (cost <= $${config.perMarket.toFixed(4)}): ${eligibleMarkets.length} markets\n`);

    if (eligibleMarkets.length > 0) {
      // Step 2: Stratified sampling
      console.log('Step 2: Stratified random sampling...');
      const { sampled, bucketStats } = stratifiedSample(
        eligibleMarkets,
        config.bucketWeights,
        targetMarketCount
      );

      console.log(`  Bucket Distribution:`);
      console.log(`    Fast  (<${FAST_THRESHOLD_DAYS}d):  ${bucketStats.fast.sampled}/${bucketStats.fast.available} available`);
      console.log(`    Med   (<${MED_THRESHOLD_DAYS}d): ${bucketStats.med.sampled}/${bucketStats.med.available} available`);
      console.log(`    Slow  (>=${MED_THRESHOLD_DAYS}d): ${bucketStats.slow.sampled}/${bucketStats.slow.available} available`);
      console.log(`  Total sampled: ${sampled.length}\n`);

      if (sampled.length > 0) {
        processEligibleMarkets(sampled, storage, mode, config, bucketStats);
      } else {
        console.log('No markets sampled.\n');
      }
    } else {
      console.log('No eligible markets found.\n');
    }

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ PLANNING FAILED');
    console.error('═══════════════════════════════════════════════════════');
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);

    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    console.error('═══════════════════════════════════════════════════════\n');
    process.exit(1);
  } finally {
    storage.close();
  }
}

/**
 * Process eligible markets and plan orders
 */
function processEligibleMarkets(
  markets: GammaMarket[],
  storage: MarketStorage,
  mode: 'strict_001' | 'floor_up_to_001',
  config: PlanConfig,
  bucketStats: Record<TimeBucket, { available: number; sampled: number }>
): void {
  const plannedOrders: Array<{
    market: GammaMarket;
    yesTokenId: string;
    floorPrice: number;
    size: number;
    cost: number;
    valid: boolean;
    skipReason: string | null;
    bucket: TimeBucket;
  }> = [];

  let validCount = 0;
  let invalidPriceCount = 0;
  let totalCost = 0;

  for (const market of markets) {
    const minTickSize = market.minTickSize!;
    const minOrderSize = market.minOrderSize!;
    const yesTokenId = market.yesTokenId!;
    const bucket = categorizeByTime(market);

    let valid: boolean;
    let price: number;
    let skipReason: string | null = null;

    if (mode === 'strict_001') {
      // strict_001: price=0.001, valid if price % min_tick_size == 0
      price = 0.001;
      valid = isValidFloorPriceStrict(price, minTickSize);
      if (!valid) {
        skipReason = 'floor price not multiple of min_tick_size';
      }
    } else {
      // floor_up_to_001: price=min_tick_size, valid if min_tick_size <= maxFloorPrice
      price = minTickSize;
      valid = isValidFloorPriceFloor(minTickSize, config.maxFloorPrice);
      if (!valid) {
        skipReason = 'min_tick_size_above_maxFloorPrice';
      }
    }

    if (!valid) {
      invalidPriceCount++;
      plannedOrders.push({
        market,
        yesTokenId,
        floorPrice: price,
        size: 0,
        cost: 0,
        valid: false,
        skipReason,
        bucket,
      });
      continue;
    }

    // For stratified sampling, use perMarket as the target cost
    // Calculate size = perMarket / price (shares to buy)
    // We already filtered to markets where minOrderSize * price <= perMarket
    // So we use either perMarket/price or minOrderSize, whichever is larger
    const targetSize = config.perMarket / price;
    const size = Math.max(targetSize, minOrderSize);

    // Calculate actual cost (should be close to perMarket)
    const cost = price * size;
    totalCost += cost;

    plannedOrders.push({
      market,
      yesTokenId,
      floorPrice: price,
      size,
      cost,
      valid: true,
      skipReason: null,
      bucket,
    });

    validCount++;
  }

  // Print summary
  console.log('Step 3: Planning orders...');
  console.log(`  Sampled Markets: ${markets.length}`);
  console.log(`  Valid Orders: ${validCount}`);
  console.log(`  Invalid Orders: ${invalidPriceCount}`);
  console.log(`  Total Planned Cost: $${totalCost.toFixed(4)}\n`);

  // Save plan run to database
  const planRunId = randomUUID();
  const params: any = {
    budget: config.budget,
    perMarket: config.perMarket,
    bucketWeights: config.bucketWeights,
    maxFloorPrice: config.maxFloorPrice,
    stratified: true,
    bucketStats: {
      fast: bucketStats.fast,
      med: bucketStats.med,
      slow: bucketStats.slow,
    },
  };
  const createdAt = new Date().toISOString();

  console.log('Step 4: Saving plan to database...');
  storage.savePlanRun(planRunId, mode, JSON.stringify(params), createdAt);

  // Prepare orders for database
  const ordersToSave = plannedOrders.map(order => ({
    planRunId,
    marketId: order.market.id,
    question: order.market.question,
    yesTokenId: order.yesTokenId,
    price: order.valid ? order.floorPrice : null,
    size: order.valid ? order.size : null,
    cost: order.valid ? order.cost : null,
    minTickSize: order.market.minTickSize ?? null,
    minOrderSize: order.market.minOrderSize ?? null,
    isValid: order.valid,
    skipReason: order.skipReason,
    createdAt,
  }));

  storage.savePlannedOrders(ordersToSave);
  console.log(`  Saved plan run: ${planRunId}\n`);

  // Print sample orders grouped by bucket
  const validOrders = plannedOrders.filter(o => o.valid);

  console.log('Step 5: Sample planned orders by bucket:');
  console.log('═══════════════════════════════════════════════════════');

  const bucketNames: TimeBucket[] = ['fast', 'med', 'slow'];
  const bucketLabels: Record<TimeBucket, string> = {
    fast: `FAST (<${FAST_THRESHOLD_DAYS} days)`,
    med: `MEDIUM (${FAST_THRESHOLD_DAYS}-${MED_THRESHOLD_DAYS} days)`,
    slow: `SLOW (>${MED_THRESHOLD_DAYS} days)`,
  };

  for (const bucket of bucketNames) {
    const bucketOrders = validOrders.filter(o => o.bucket === bucket);
    console.log(`\n${bucketLabels[bucket]} - ${bucketOrders.length} orders:`);

    const samples = bucketOrders.slice(0, 5);
    if (samples.length === 0) {
      console.log('  (none)');
    } else {
      samples.forEach((order, idx) => {
        const endDateStr = order.market.endDate || order.market.closeDate || 'unknown';
        console.log(`  ${idx + 1}. ${order.market.question.substring(0, 60)}${order.market.question.length > 60 ? '...' : ''}`);
        console.log(`     Price: ${order.floorPrice} | Size: ${order.size.toFixed(2)} | Cost: $${order.cost.toFixed(4)} | End: ${endDateStr}`);
      });
      if (bucketOrders.length > 5) {
        console.log(`  ... and ${bucketOrders.length - 5} more`);
      }
    }
  }

  // Summary stats
  const bucketCosts: Record<TimeBucket, number> = { fast: 0, med: 0, slow: 0 };
  const bucketCounts: Record<TimeBucket, number> = { fast: 0, med: 0, slow: 0 };

  for (const order of validOrders) {
    bucketCosts[order.bucket] += order.cost;
    bucketCounts[order.bucket]++;
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('PLANNING COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Plan Run ID: ${planRunId}`);
  console.log(`\nBudget Allocation:`);
  console.log(`  Fast:   ${bucketCounts.fast} orders, $${bucketCosts.fast.toFixed(4)} (${((bucketCosts.fast / totalCost) * 100).toFixed(1)}%)`);
  console.log(`  Medium: ${bucketCounts.med} orders, $${bucketCosts.med.toFixed(4)} (${((bucketCosts.med / totalCost) * 100).toFixed(1)}%)`);
  console.log(`  Slow:   ${bucketCounts.slow} orders, $${bucketCosts.slow.toFixed(4)} (${((bucketCosts.slow / totalCost) * 100).toFixed(1)}%)`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Total:  ${validCount} orders, $${totalCost.toFixed(4)}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review the plan above`);
  console.log(`  2. Run: CONFIRM=YES_TO_PLACE_ORDER npm run one:order`);
  console.log('═══════════════════════════════════════════════════════\n');
}

// Run planning
planFloorOrders();

