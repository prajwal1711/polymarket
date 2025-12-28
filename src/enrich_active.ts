/**
 * Targeted market enrichment script for Polymarket CLOB trading constraints
 * Enriches only active markets that have condition_id but are missing constraints
 */

import axios, { AxiosError } from 'axios';
import pRetry, { AbortError } from 'p-retry';
import pLimit from 'p-limit';
import { MarketStorage } from './storage';
import { GammaMarket } from './types/market';

// CLOB API configuration
const CLOB_API_BASE = 'https://clob.polymarket.com';

// Rate limiting: 8 requests per second
const RATE_LIMIT_RPS = 8;
const rateLimiter = pLimit(RATE_LIMIT_RPS);

/**
 * CLOB Market response interface
 */
interface ClobMarketResponse {
  condition_id?: string;
  minimum_tick_size?: string | number;
  minimum_order_size?: string | number;
  [key: string]: any;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): { max: number } {
  const args = process.argv.slice(2);
  let max = Infinity;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max' && i + 1 < args.length) {
      max = parseInt(args[i + 1], 10);
      if (isNaN(max) || max < 1) {
        throw new Error('--max must be a positive integer');
      }
      i++;
    }
  }

  return { max };
}

/**
 * Fetch CLOB market by condition_id
 */
async function fetchClobMarket(conditionId: string): Promise<ClobMarketResponse> {
  const fetchWithRetry = async () => {
    return rateLimiter(async () => {
      try {
        const url = `${CLOB_API_BASE}/markets/${encodeURIComponent(conditionId)}`;
        const response = await axios.get<ClobMarketResponse>(url, {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = error.response?.data?.error || error.message;
          
          // Don't retry on 4xx errors (except 429 rate limit)
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw new AbortError(`API error (${status}): ${message}`);
          }
          
          throw new Error(`API request failed: ${message}`);
        }
        throw error;
      }
    });
  };

  return pRetry(fetchWithRetry, {
    retries: 3,
    minTimeout: 1000, // 1 second
    maxTimeout: 10000, // 10 seconds
    factor: 2, // Exponential backoff
    onFailedAttempt: (error) => {
      // Silent retries for rate limiting
    },
  });
}

/**
 * Extract and normalize CLOB market constraints
 */
function extractClobConstraints(market: ClobMarketResponse): {
  minTickSize: number | null;
  minOrderSize: number | null;
} {
  // Parse minimum_tick_size
  let minTickSize: number | null = null;
  if (market.minimum_tick_size !== undefined && market.minimum_tick_size !== null) {
    const tickSize = typeof market.minimum_tick_size === 'string' 
      ? parseFloat(market.minimum_tick_size) 
      : Number(market.minimum_tick_size);
    if (!isNaN(tickSize) && tickSize > 0) {
      minTickSize = tickSize;
    }
  }

  // Parse minimum_order_size
  let minOrderSize: number | null = null;
  if (market.minimum_order_size !== undefined && market.minimum_order_size !== null) {
    const orderSize = typeof market.minimum_order_size === 'string'
      ? parseFloat(market.minimum_order_size)
      : Number(market.minimum_order_size);
    if (!isNaN(orderSize) && orderSize > 0) {
      minOrderSize = orderSize;
    }
  }

  return { minTickSize, minOrderSize };
}

/**
 * Check condition_id coverage and warn if needed
 */
function checkConditionIdCoverage(storage: MarketStorage): boolean {
  const coverage = storage.getConditionIdCoverage();
  
  console.log(`Active markets: ${coverage.activeMarkets}`);
  console.log(`Active markets with condition_id: ${coverage.activeWithConditionId} (${coverage.coveragePercent.toFixed(1)}%)`);
  
  if (coverage.coveragePercent < 50) {
    console.log('\n⚠️  WARNING: Missing condition_id for most active markets.');
    console.log('   Rerun ingest with condition_id extraction: npm run ingest\n');
    return false;
  }
  
  return true;
}

/**
 * Main enrichment function
 */
async function enrichActiveMarkets(): Promise<void> {
  const { max } = parseArgs();
  
  console.log('Starting targeted CLOB market enrichment for active markets...\n');
  if (max !== Infinity) {
    console.log(`  Max markets to enrich: ${max} (testing mode)\n`);
  }

  const storage = new MarketStorage(false); // Use SQLite

  try {
    // Step 1: Check condition_id coverage
    console.log('Step 1: Checking condition_id coverage...');
    const hasGoodCoverage = checkConditionIdCoverage(storage);
    if (!hasGoodCoverage) {
      console.log('⚠️  Proceeding with limited coverage...\n');
    }

    // Step 2: Get markets needing enrichment
    console.log('Step 2: Finding markets that need enrichment...');
    const marketsToEnrich = storage.getMarketsNeedingEnrichment();
    const totalToEnrich = marketsToEnrich.length;
    const marketsToProcess = max !== Infinity 
      ? marketsToEnrich.slice(0, max)
      : marketsToEnrich;

    console.log(`  Found ${totalToEnrich} markets needing enrichment`);
    if (max !== Infinity && totalToEnrich > max) {
      console.log(`  Processing first ${max} markets (--max limit)`);
    }
    console.log('');

    if (marketsToProcess.length === 0) {
      console.log('✓ No markets need enrichment. All active markets with condition_id already have constraints.\n');
      const stats = storage.getEnrichmentStats();
      console.log('═══════════════════════════════════════════════════════');
      console.log('ENRICHMENT STATISTICS');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Active Markets: ${stats.activeMarkets}`);
      console.log(`Active Markets with condition_id: ${stats.activeMarketsWithConditionId}`);
      console.log(`Active Markets Enriched: ${stats.activeEnriched}`);
      console.log(`Active Markets Coverage: ${stats.activeEnrichedPercent.toFixed(1)}%`);
      console.log('═══════════════════════════════════════════════════════\n');
      return;
    }

    // Step 3: Enrich markets
    console.log(`Step 3: Enriching ${marketsToProcess.length} markets...`);
    console.log(`  Rate limit: ${RATE_LIMIT_RPS} requests/second`);
    console.log(`  Progress updates every 250 markets\n`);

    let enrichedCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < marketsToProcess.length; i++) {
      const market = marketsToProcess[i];
      const conditionId = market.conditionId!;

      try {
        // Fetch CLOB market data
        const clobMarket = await fetchClobMarket(conditionId);
        const constraints = extractClobConstraints(clobMarket);

        // Update database if we got constraints
        if (constraints.minTickSize !== null || constraints.minOrderSize !== null) {
          storage.updateClobConstraintsByConditionId(
            conditionId,
            constraints.minTickSize,
            constraints.minOrderSize
          );
          // Mark as having an active orderbook
          storage.markConditionIdHasOrderbook(conditionId);
          enrichedCount++;
        }

        // Progress update every 250 markets
        if ((i + 1) % 250 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = ((i + 1) / (Date.now() - startTime) * 1000).toFixed(1);
          console.log(`  Progress: ${i + 1}/${marketsToProcess.length} markets processed (${enrichedCount} enriched, ${errorCount} errors) - ${rate} markets/sec`);
        }
      } catch (error) {
        errorCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);

        // If market not found (404), mark as no orderbook so we skip it in future
        if (errorMsg.includes('404') || errorMsg.includes('market not found')) {
          storage.markConditionIdNoOrderbook(conditionId);
        }

        // Only log errors for first few and every 100th error to avoid spam
        if (errorCount <= 3 || errorCount % 100 === 0) {
          console.log(`  ⚠️  Error enriching market ${market.id} (${conditionId}): ${errorMsg}`);
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✓ Processed ${marketsToProcess.length} markets in ${elapsed}s`);
    console.log(`  Enriched: ${enrichedCount}`);
    console.log(`  Errors: ${errorCount}\n`);

    // Step 4: Final statistics
    console.log('Step 4: Final enrichment statistics...');
    const stats = storage.getEnrichmentStats();

    console.log('═══════════════════════════════════════════════════════');
    console.log('✓ ENRICHMENT COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Markets Processed: ${marketsToProcess.length}`);
    console.log(`Markets Enriched: ${enrichedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('');
    console.log(`Active Markets: ${stats.activeMarkets}`);
    console.log(`Active Markets with condition_id: ${stats.activeMarketsWithConditionId}`);
    console.log(`Active Markets Enriched: ${stats.activeEnriched}`);
    console.log(`Active Markets Coverage: ${stats.activeEnrichedPercent.toFixed(1)}%`);
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ ENRICHMENT FAILED');
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

// Run enrichment
enrichActiveMarkets().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

