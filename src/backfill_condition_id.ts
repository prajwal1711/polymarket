/**
 * Targeted backfill script for condition_id
 * Fetches markets from Gamma /markets endpoint and updates condition_id for active markets
 */

import { GammaApiClient } from './api/gamma';
import { MarketStorage } from './storage';
import { GammaApiMarket } from './types/market';

/**
 * Extract condition_id from Gamma API market
 * (Duplicated from ingest_markets.ts for standalone use)
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
 * Parse CLI arguments
 */
function parseArgs(): { limit: number; debugSample: boolean } {
  const args = process.argv.slice(2);
  let limit = 100;
  let debugSample = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer');
      }
      i++;
    } else if (args[i] === '--debugSample') {
      debugSample = true;
    }
  }

  return { limit, debugSample };
}

/**
 * Main backfill function
 */
async function backfillConditionId(): Promise<void> {
  const { limit, debugSample } = parseArgs();
  
  console.log('Starting condition_id backfill for active markets...\n');

  const storage = new MarketStorage(false); // Use SQLite
  const apiClient = new GammaApiClient(10); // 10 requests per second

  try {
    // Step 1: Get markets missing condition_id
    console.log('Step 1: Finding active markets missing condition_id...');
    const marketsNeedingBackfill = storage.getMarketsMissingConditionId();
    const totalNeedingBackfill = marketsNeedingBackfill.length;
    
    console.log(`  Found ${totalNeedingBackfill} active markets missing condition_id\n`);

    if (totalNeedingBackfill === 0) {
      const coverage = storage.getConditionIdCoverage();
      console.log('✓ All active markets already have condition_id');
      console.log(`  Coverage: ${coverage.coveragePercent.toFixed(1)}% (${coverage.activeWithConditionId}/${coverage.activeMarkets})\n`);
      return;
    }

    // Step 2: Fetch markets from Gamma /markets endpoint
    console.log('Step 2: Fetching markets from Gamma /markets endpoint...');
    console.log(`  Page size: ${limit}`);
    console.log(`  Rate limit: 10 requests/second\n`);

    const marketsMap = new Map<string, GammaApiMarket>(); // Map by Gamma numeric id
    let offset = 0;
    let pageCount = 0;
    let hasMore = true;
    let sampleLogged = false;

    while (hasMore) {
      try {
        const markets = await apiClient.fetchMarketsPage(limit, offset);
        
        if (markets.length === 0) {
          hasMore = false;
          break;
        }

        // Log debug sample on first page if requested
        if (debugSample && !sampleLogged && markets.length > 0) {
          console.log('\n  Debug Sample - Raw Market Object:');
          console.log(JSON.stringify(markets[0], null, 2));
          console.log('');
          sampleLogged = true;
        }

        // Index markets by their numeric id
        for (const market of markets) {
          const marketId = String(market.id);
          marketsMap.set(marketId, market);
        }

        pageCount++;
        const fetchedCount = markets.length;
        const uniqueCount = marketsMap.size;
        
        console.log(`  Page ${pageCount}: Fetched ${fetchedCount} markets (${uniqueCount} unique total)`);

        // If we got fewer markets than the limit, we've reached the end
        if (markets.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }

        // Stop if we've fetched enough to cover all markets needing backfill
        // (with some buffer for potential mismatches)
        if (uniqueCount >= totalNeedingBackfill * 1.5) {
          console.log(`  Fetched enough markets (${uniqueCount}) to cover backfill needs (${totalNeedingBackfill})`);
          break;
        }
      } catch (error) {
        console.error(`  Error fetching page at offset ${offset}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }

    console.log(`✓ Fetched ${marketsMap.size} unique markets from Gamma API across ${pageCount} pages\n`);

    // Step 3: Match and update condition_id
    console.log('Step 3: Matching and updating condition_id...');
    
    const updates = new Map<string, string>();
    let matchedCount = 0;
    let skippedNoConditionId = 0;
    let skippedNoMatch = 0;

    for (const market of marketsNeedingBackfill) {
      const gammaMarket = marketsMap.get(market.id);
      
      if (!gammaMarket) {
        skippedNoMatch++;
        continue;
      }

      const conditionId = extractConditionId(gammaMarket);
      
      if (!conditionId) {
        skippedNoConditionId++;
        continue;
      }

      updates.set(market.id, conditionId);
      matchedCount++;
    }

    console.log(`  Matched: ${matchedCount}`);
    console.log(`  Skipped (no condition_id in API): ${skippedNoConditionId}`);
    console.log(`  Skipped (not found in API): ${skippedNoMatch}\n`);

    // Step 4: Bulk update database
    if (updates.size > 0) {
      console.log(`Step 4: Updating ${updates.size} markets with condition_id...`);
      const { updated } = storage.bulkUpdateConditionIds(updates);
      console.log(`✓ Updated ${updated} markets\n`);
    } else {
      console.log('Step 4: No markets to update\n');
    }

    // Step 5: Final statistics
    console.log('Step 5: Final condition_id coverage statistics...');
    const coverage = storage.getConditionIdCoverage();

    console.log('═══════════════════════════════════════════════════════');
    console.log('✓ BACKFILL COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Markets Processed: ${totalNeedingBackfill}`);
    console.log(`Markets Updated: ${matchedCount}`);
    console.log(`Markets Skipped: ${skippedNoConditionId + skippedNoMatch}`);
    console.log('');
    console.log(`Active Markets: ${coverage.activeMarkets}`);
    console.log(`Active Markets with condition_id: ${coverage.activeWithConditionId}`);
    console.log(`Condition ID Coverage: ${coverage.coveragePercent.toFixed(1)}%`);
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ BACKFILL FAILED');
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

// Run backfill
backfillConditionId().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

