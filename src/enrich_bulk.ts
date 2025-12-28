/**
 * Market enrichment script for Polymarket CLOB trading constraints
 * Fetches market data from CLOB API using cursor pagination and enriches local SQLite database
 */

import axios from 'axios';
import { MarketStorage } from './storage';

// CLOB API configuration
const CLOB_API_BASE = 'https://clob.polymarket.com';

/**
 * CLOB Market interface based on API response
 */
interface ClobMarket {
  condition_id?: string;
  minimum_tick_size?: string | number;
  minimum_order_size?: string | number;
  tokens?: Array<{
    token_id?: string;
    [key: string]: any;
  }>;
  [key: string]: any;
}

/**
 * CLOB API paginated response
 */
interface ClobMarketsResponse {
  data?: ClobMarket[];
  next_cursor?: string | null;
  [key: string]: any;
}

/**
 * Fetch all markets from CLOB API using cursor pagination
 */
async function fetchAllClobMarkets(): Promise<Map<string, ClobMarket>> {
  const marketsMap = new Map<string, ClobMarket>();
  let nextCursor: string | null = null;
  let pageCount = 0;

  console.log('Fetching markets from CLOB API (cursor pagination)...');

  do {
    try {
      const url: string = nextCursor
        ? `${CLOB_API_BASE}/markets?next_cursor=${encodeURIComponent(nextCursor)}`
        : `${CLOB_API_BASE}/markets`;

      const response = await axios.get<ClobMarketsResponse | ClobMarket[]>(url, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data: ClobMarketsResponse | ClobMarket[] = response.data;
      const markets: ClobMarket[] = Array.isArray(data) ? data : (data?.data || []);
      const cursor: string | null = Array.isArray(data) ? null : (data?.next_cursor || null);

      // Process markets and add to map keyed by condition_id
      for (const market of markets) {
        if (market.condition_id) {
          const conditionId = String(market.condition_id).toLowerCase();
          marketsMap.set(conditionId, market);
        }
      }

      pageCount++;
      const fetchedCount = markets.length;
      const totalCount = marketsMap.size;
      
      console.log(`  Page ${pageCount}: Fetched ${fetchedCount} markets (${totalCount} unique total)`);

      nextCursor = cursor ? String(cursor) : null;

      // If no cursor and we got fewer markets than expected, we're done
      if (!nextCursor && fetchedCount === 0) {
        break;
      }

      // Small delay to avoid rate limiting
      if (nextCursor) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.error || error.message;
        throw new Error(`CLOB API error (${status}): ${message}`);
      }
      throw new Error(`Failed to fetch CLOB markets: ${error instanceof Error ? error.message : String(error)}`);
    }
  } while (nextCursor);

  console.log(`✓ Fetched ${marketsMap.size} unique markets from CLOB API across ${pageCount} pages\n`);

  return marketsMap;
}

/**
 * Extract and normalize CLOB market constraints
 */
function extractClobConstraints(market: ClobMarket): {
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
 * Main enrichment function
 */
async function enrichMarkets(): Promise<void> {
  console.log('Starting CLOB market enrichment...\n');

  const storage = new MarketStorage(false); // Use SQLite

  try {
    // Step 1: Fetch all markets from CLOB API with cursor pagination
    console.log('Step 1: Fetching all markets from CLOB API...');
    const clobMarketsMap = await fetchAllClobMarkets();

    if (clobMarketsMap.size === 0) {
      console.log('⚠️  No markets found in CLOB API response\n');
      return;
    }

    // Step 2: Get local markets statistics
    const localMarkets = storage.getAllMarkets();
    const activeLocalMarkets = localMarkets.filter(m => m.active && !m.closed);
    const activeWithConditionId = activeLocalMarkets.filter(m => m.conditionId);
    
    console.log(`Step 2: Local database statistics`);
    console.log(`  Total markets: ${localMarkets.length}`);
    console.log(`  Active markets: ${activeLocalMarkets.length}`);
    console.log(`  Active markets with condition_id: ${activeWithConditionId.length}\n`);

    // Step 3: Build constraints map and match by condition_id
    console.log('Step 3: Matching CLOB markets to local markets by condition_id...');
    
    const constraintsMap = new Map<string, { minTickSize: number | null; minOrderSize: number | null }>();
    let matchedCount = 0;
    let skippedNoConstraints = 0;
    let skippedNoMatch = 0;

    for (const [conditionId, clobMarket] of clobMarketsMap.entries()) {
      const constraints = extractClobConstraints(clobMarket);

      // Skip if no constraints to add
      if (constraints.minTickSize === null && constraints.minOrderSize === null) {
        skippedNoConstraints++;
        continue;
      }

      // Normalize condition_id for matching (lowercase, remove 0x prefix if inconsistent)
      const normalizedConditionId = conditionId.toLowerCase().startsWith('0x')
        ? conditionId.toLowerCase()
        : conditionId.toLowerCase();

      // Check if we have a market with this condition_id
      const localMarket = storage.getMarketByIdentifier(normalizedConditionId);
      if (!localMarket) {
        skippedNoMatch++;
        continue;
      }

      // Add to constraints map
      constraintsMap.set(normalizedConditionId, constraints);
      matchedCount++;
    }

    console.log(`  Matched ${matchedCount} markets`);
    console.log(`  Skipped (no constraints): ${skippedNoConstraints}`);
    console.log(`  Skipped (no local match): ${skippedNoMatch}\n`);

    // Step 4: Bulk update database
    if (constraintsMap.size > 0) {
      console.log(`Step 4: Updating ${constraintsMap.size} markets with CLOB constraints...`);
      const { updated } = storage.bulkUpdateClobConstraints(constraintsMap);
      console.log(`✓ Updated ${updated} markets\n`);
    } else {
      console.log('Step 4: No markets to update\n');
    }

    // Step 5: Calculate and display statistics
    console.log('Step 5: Final enrichment statistics...');
    const stats = storage.getEnrichmentStats();

    console.log('═══════════════════════════════════════════════════════');
    console.log('✓ ENRICHMENT COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`CLOB Markets Fetched: ${clobMarketsMap.size}`);
    console.log(`Markets Matched & Enriched: ${matchedCount}`);
    console.log('');
    console.log(`Total Markets in Database: ${stats.totalMarkets}`);
    console.log(`Total Markets Enriched: ${stats.totalEnriched}`);
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
enrichMarkets().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
