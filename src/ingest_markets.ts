/**
 * Market ingestion script for Polymarket Gamma API
 * Fetches active markets and persists them locally
 */

import { GammaApiClient } from './api/gamma';
import { MarketStorage } from './storage';
import { GammaMarket, GammaApiMarket } from './types/market';

/**
 * Parse clobTokenIds from various formats
 * Handles: array, JSON string, comma-separated string
 */
function parseClobTokenIds(value: string[] | string | null | undefined): string[] | null {
  if (!value) {
    return null;
  }

  // If already an array, return it
  if (Array.isArray(value)) {
    return value.filter(id => id != null && String(id).trim() !== '');
  }

  // If string, try to parse
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    // Try JSON.parse first
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(id => id != null && String(id).trim() !== '');
      }
    } catch {
      // JSON parse failed, try manual parsing
    }

    // Try to extract array from string like '["id1","id2"]' or 'id1,id2'
    // Remove brackets and quotes
    let cleaned = trimmed
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/^"/, '')
      .replace(/"$/, '')
      .trim();

    // Split by comma and clean each item
    const items = cleaned.split(',').map(item => {
      return item.trim().replace(/^["']/, '').replace(/["']$/, '');
    }).filter(item => item.length > 0);

    if (items.length > 0) {
      return items;
    }
  }

  return null;
}

/**
 * Parse outcomes from various formats
 */
function parseOutcomes(value: any): string[] | null {
  if (!value) {
    return null;
  }

  // If already an array, extract titles
  if (Array.isArray(value)) {
    return value.map(outcome => {
      if (typeof outcome === 'string') {
        return outcome;
      }
      return outcome?.title || outcome?.name || String(outcome);
    }).filter(Boolean);
  }

  // If string, try JSON.parse
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(item => {
          if (typeof item === 'string') {
            return item;
          }
          return item?.title || item?.name || String(item);
        }).filter(Boolean);
      }
    } catch {
      // Parse failed
    }
  }

  return null;
}

/**
 * Extract YES/NO token IDs from market using clobTokenIds and outcomes
 */
function extractTokenIds(market: GammaApiMarket): { 
  yesTokenId: string | null; 
  noTokenId: string | null;
  hasClobTokenIds: boolean;
  orderingVerified: boolean;
} {
  let yesTokenId: string | null = null;
  let noTokenId: string | null = null;
  let orderingVerified = false;

  // Parse clobTokenIds
  const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
  const hasClobTokenIds = clobTokenIds !== null && clobTokenIds.length >= 2;

  if (!hasClobTokenIds) {
    return { yesTokenId: null, noTokenId: null, hasClobTokenIds: false, orderingVerified: false };
  }

  // Parse outcomes
  const outcomes = parseOutcomes(market.outcomes);

  if (outcomes && outcomes.length >= 2) {
    // Find Yes and No indices
    const yesIndex = outcomes.findIndex(o => 
      o.toLowerCase().includes('yes') || o.toLowerCase() === 'yes'
    );
    const noIndex = outcomes.findIndex(o => 
      o.toLowerCase().includes('no') || o.toLowerCase() === 'no'
    );

    if (yesIndex >= 0 && yesIndex < clobTokenIds.length) {
      yesTokenId = String(clobTokenIds[yesIndex]);
    }
    if (noIndex >= 0 && noIndex < clobTokenIds.length) {
      noTokenId = String(clobTokenIds[noIndex]);
    }

    // Verify we found both
    if (yesIndex >= 0 && noIndex >= 0) {
      orderingVerified = true;
    }
  }

  // Fallback: assume clobTokenIds[0] = YES, clobTokenIds[1] = NO
  if (!yesTokenId && clobTokenIds.length > 0) {
    yesTokenId = String(clobTokenIds[0]);
  }
  if (!noTokenId && clobTokenIds.length > 1) {
    noTokenId = String(clobTokenIds[1]);
  }

  return { 
    yesTokenId, 
    noTokenId, 
    hasClobTokenIds: true,
    orderingVerified 
  };
}

/**
 * Extract condition_id from Gamma API market
 * Handles both conditionId (camelCase) and condition_id (snake_case)
 * Returns the value exactly as returned (likely a hex string starting with 0x)
 */
function extractConditionId(apiMarket: GammaApiMarket): string | null {
  // Try conditionId (camelCase) first
  if (apiMarket.conditionId !== undefined && apiMarket.conditionId !== null) {
    const value = String(apiMarket.conditionId).trim();
    if (value) {
      return value;
    }
  }
  // Try condition_id (snake_case)
  if (apiMarket.condition_id !== undefined && apiMarket.condition_id !== null) {
    const value = String(apiMarket.condition_id).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Extract trading constraints from Gamma API market
 */
function extractTradingConstraints(apiMarket: GammaApiMarket): {
  enableOrderBook: boolean | null;
  minTickSize: number | null;
  minOrderSize: number | null;
} {
  // Extract enableOrderBook
  let enableOrderBook: boolean | null = null;
  if (apiMarket.enableOrderBook !== undefined && apiMarket.enableOrderBook !== null) {
    enableOrderBook = Boolean(apiMarket.enableOrderBook);
  }

  // Extract orderPriceMinTickSize -> min_tick_size
  let minTickSize: number | null = null;
  if (apiMarket.orderPriceMinTickSize !== undefined && apiMarket.orderPriceMinTickSize !== null) {
    const tickSize = typeof apiMarket.orderPriceMinTickSize === 'string'
      ? parseFloat(apiMarket.orderPriceMinTickSize)
      : Number(apiMarket.orderPriceMinTickSize);
    if (!isNaN(tickSize) && tickSize > 0) {
      minTickSize = tickSize;
    }
  }

  // Extract orderMinSize -> min_order_size
  let minOrderSize: number | null = null;
  if (apiMarket.orderMinSize !== undefined && apiMarket.orderMinSize !== null) {
    const orderSize = typeof apiMarket.orderMinSize === 'string'
      ? parseFloat(apiMarket.orderMinSize)
      : Number(apiMarket.orderMinSize);
    if (!isNaN(orderSize) && orderSize > 0) {
      minOrderSize = orderSize;
    }
  }

  return { enableOrderBook, minTickSize, minOrderSize };
}

/**
 * Transform Gamma API market to our market format
 */
function transformMarket(apiMarket: GammaApiMarket): GammaMarket & { orderingVerified?: boolean } {
  const { yesTokenId, noTokenId, hasClobTokenIds, orderingVerified } = extractTokenIds(apiMarket);
  const conditionId = extractConditionId(apiMarket);
  const { enableOrderBook, minTickSize, minOrderSize } = extractTradingConstraints(apiMarket);

  const market: GammaMarket & { orderingVerified?: boolean } = {
    id: String(apiMarket.id),
    question: apiMarket.question || apiMarket.title || 'Unknown',
    slug: apiMarket.slug || null,
    active: apiMarket.active ?? true,
    closed: apiMarket.closed ?? false,
    endDate: apiMarket.endDate || null,
    closeDate: apiMarket.closeDate || null,
    yesTokenId: yesTokenId ?? null,
    noTokenId: noTokenId ?? null,
    conditionId: conditionId,
    enableOrderBook: enableOrderBook,
    minTickSize: minTickSize,
    minOrderSize: minOrderSize,
  };

  if (!orderingVerified && hasClobTokenIds) {
    market.orderingVerified = false;
  }

  return market;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): { limit: number; resume: boolean; maxPages: number | null; debugSample: boolean } {
  const args = process.argv.slice(2);
  let limit = 100;
  let resume = true;
  let maxPages: number | null = null;
  let debugSample = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--resume' && i + 1 < args.length) {
      resume = args[i + 1].toLowerCase() === 'true';
      i++;
    } else if (args[i] === '--maxPages' && i + 1 < args.length) {
      maxPages = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--debugSample') {
      debugSample = true;
    }
  }

  return { limit, resume, maxPages, debugSample };
}

/**
 * Main ingestion function
 */
async function ingestMarkets(): Promise<void> {
  const { limit, resume, maxPages, debugSample } = parseArgs();
  
  console.log('Starting Polymarket market ingestion...');
  if (maxPages) {
    console.log(`  Max pages: ${maxPages} (testing mode)`);
  }
  if (debugSample) {
    console.log(`  Debug sample: enabled (will print first market object)`);
  }
  console.log('');

  const storage = new MarketStorage(false); // Use SQLite
  const apiClient = new GammaApiClient(10); // 10 requests per second

  try {
    // Step 1: Test API connection
    console.log('Step 1: Testing Gamma API connection...');
    await apiClient.testConnection();
    console.log('✓ API client initialized\n');

    // Step 2: Determine starting offset
    let startOffset = 0;
    if (resume) {
      startOffset = storage.getLastEventOffset();
      if (startOffset > 0) {
        console.log(`Step 2: Resuming from offset ${startOffset}\n`);
      }
    } else {
      console.log('Step 2: Starting fresh (--resume=false)\n');
      storage.setLastEventOffset(0);
    }

    // Record run start
    storage.setLastRunStartedAt(new Date().toISOString());

    // Step 3: Fetch markets with pagination
    console.log('Step 3: Fetching markets from Gamma API...');
    const allMarkets: GammaApiMarket[] = [];
    let offset = startOffset;
    let hasMore = true;
    let pageCount = 0;
    let totalMarketsSaved = 0;

    while (hasMore) {
      if (maxPages && pageCount >= maxPages) {
        console.log(`  Reached max pages limit (${maxPages})`);
        break;
      }

      const events = await apiClient.fetchEventsPage(limit, offset);
      
      if (events.length === 0) {
        hasMore = false;
        break;
      }

      // Extract markets from this page's events
      const pageMarkets: GammaApiMarket[] = [];
      for (const event of events) {
        if (event.markets && Array.isArray(event.markets)) {
          pageMarkets.push(...event.markets);
        }
      }

      // Log debug sample on first page if requested
      if (debugSample && pageCount === 0 && pageMarkets.length > 0) {
        console.log('\n  Debug Sample - Raw Market Object:');
        console.log(JSON.stringify(pageMarkets[0], null, 2));
        console.log('');
      }

      // Save markets from this page immediately
      if (pageMarkets.length > 0) {
        const transformedMarkets = pageMarkets.map(transformMarket);
        storage.saveMarkets(transformedMarkets);
        totalMarketsSaved += transformedMarkets.length;
        allMarkets.push(...pageMarkets);
      }

      pageCount++;
      const newOffset = offset + limit;
      console.log(`  Page ${pageCount}: ${events.length} events, ${pageMarkets.length} markets (${totalMarketsSaved} total saved)`);

      // Update offset after successful page
      storage.setLastEventOffset(newOffset);
      offset = newOffset;

      // If we got fewer events than the limit, we've reached the end
      if (events.length < limit) {
        hasMore = false;
      }
    }

    console.log(`✓ Fetched ${allMarkets.length} markets from API\n`);

    if (allMarkets.length === 0) {
      console.log('⚠️  No markets found. This might indicate:');
      console.log('   - API endpoint changed');
      console.log('   - No active markets available');
      console.log('   - Network/API issue\n');
      return;
    }

    // Step 4: Count statistics from stored markets
    console.log('Step 4: Calculating statistics...');
    const allStoredMarkets = storage.getAllMarkets();
    const activeMarkets = allStoredMarkets.filter((m: GammaMarket) => m.active && !m.closed);
    
    // Count statistics
    let marketsWithClobTokenIds = 0;
    let marketsWithBothTokenIds = 0;
    let marketsWithOrderingWarning = 0;

    for (const market of allStoredMarkets) {
      if (market.yesTokenId || market.noTokenId) {
        marketsWithClobTokenIds++;
      }
      if (market.yesTokenId && market.noTokenId) {
        marketsWithBothTokenIds++;
      }
    }

    // Record run completion
    storage.setLastRunCompletedAt(new Date().toISOString());

    console.log('═══════════════════════════════════════════════════════');
    console.log('✓ INGESTION COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Total Markets Ingested: ${allStoredMarkets.length}`);
    console.log(`Active Markets: ${activeMarkets.length}`);
    console.log(`Markets with clobTokenIds: ${marketsWithClobTokenIds}`);
    console.log(`Markets with YES+NO Token IDs: ${marketsWithBothTokenIds}`);
    if (marketsWithOrderingWarning > 0) {
      console.log(`⚠️  Markets with unverified ordering: ${marketsWithOrderingWarning}`);
    }
    console.log('═══════════════════════════════════════════════════════\n');

    // Print sample markets with token IDs
    console.log('Sample Markets (first 10 with token IDs):');
    console.log('─────────────────────────────────────────────────────');
    const marketsWithTokens = allStoredMarkets.filter((m: GammaMarket) => m.yesTokenId && m.noTokenId);
    const samples = marketsWithTokens.slice(0, 10);
    
    if (samples.length === 0) {
      console.log('No markets with both YES and NO token IDs found.');
      console.log('Showing first 10 markets regardless:');
      const fallbackSamples = allStoredMarkets.slice(0, 10);
      fallbackSamples.forEach((market: GammaMarket, idx: number) => {
        console.log(`\n${idx + 1}. ${market.question}`);
        console.log(`   ID: ${market.id}`);
        console.log(`   YES Token: ${market.yesTokenId || 'MISSING'}`);
        console.log(`   NO Token: ${market.noTokenId || 'MISSING'}`);
      });
    } else {
      samples.forEach((market: GammaMarket, idx: number) => {
        console.log(`\n${idx + 1}. ${market.question}`);
        console.log(`   ID: ${market.id}`);
        console.log(`   YES Token: ${market.yesTokenId}`);
        console.log(`   NO Token: ${market.noTokenId}`);
      });
    }
    console.log('\n═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ INGESTION FAILED');
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

// Run ingestion
ingestMarkets().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
