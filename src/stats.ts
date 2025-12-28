/**
 * Statistics script for market ingestion data
 */

import { MarketStorage } from './storage';

function printStats(): void {
  const storage = new MarketStorage(false); // Use SQLite

  try {
    const allMarkets = storage.getAllMarkets();
    const activeMarkets = allMarkets.filter(m => m.active && !m.closed);
    
    // Count markets with clobTokenIds (have at least one token ID)
    const marketsWithClobTokenIds = allMarkets.filter(m => m.yesTokenId || m.noTokenId);
    
    // Count markets with both token IDs
    const marketsWithBothTokenIds = allMarkets.filter(m => m.yesTokenId && m.noTokenId);

    // Count markets with trading constraints
    const marketsWithEnableOrderBook = activeMarkets.filter(m => m.enableOrderBook === true);
    const marketsWithMinTickSize = activeMarkets.filter(m => m.minTickSize !== null && m.minTickSize !== undefined);
    const marketsWithMinOrderSize = activeMarkets.filter(m => m.minOrderSize !== null && m.minOrderSize !== undefined);

    // Calculate percentage coverage
    const tokenizedPercentage = activeMarkets.length > 0
      ? ((marketsWithBothTokenIds.length / activeMarkets.length) * 100).toFixed(2)
      : '0.00';

    const enableOrderBookCoverage = activeMarkets.length > 0
      ? ((marketsWithEnableOrderBook.length / activeMarkets.length) * 100).toFixed(2)
      : '0.00';

    const minTickSizeCoverage = activeMarkets.length > 0
      ? ((marketsWithMinTickSize.length / activeMarkets.length) * 100).toFixed(2)
      : '0.00';

    const minOrderSizeCoverage = activeMarkets.length > 0
      ? ((marketsWithMinOrderSize.length / activeMarkets.length) * 100).toFixed(2)
      : '0.00';

    console.log('═══════════════════════════════════════════════════════');
    console.log('MARKET INGESTION STATISTICS');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Total Markets: ${allMarkets.length}`);
    console.log(`Active Markets: ${activeMarkets.length}`);
    console.log(`Markets with clobTokenIds: ${marketsWithClobTokenIds.length}`);
    console.log(`Markets with YES+NO Token IDs: ${marketsWithBothTokenIds.length}`);
    console.log(`Tokenization Coverage: ${tokenizedPercentage}% (${marketsWithBothTokenIds.length}/${activeMarkets.length} active markets)`);
    console.log('');
    console.log(`Active Markets with enableOrderBook=true: ${marketsWithEnableOrderBook.length}`);
    console.log(`Enable Order Book Coverage: ${enableOrderBookCoverage}%`);
    console.log(`Active Markets with min_tick_size: ${marketsWithMinTickSize.length}`);
    console.log(`Min Tick Size Coverage: ${minTickSizeCoverage}%`);
    console.log(`Active Markets with min_order_size: ${marketsWithMinOrderSize.length}`);
    console.log(`Min Order Size Coverage: ${minOrderSizeCoverage}%`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Show ingestion state
    const lastOffset = storage.getLastEventOffset();
    const lastStarted = storage.getLastRunStartedAt();
    const lastCompleted = storage.getLastRunCompletedAt();

    if (lastOffset > 0 || lastStarted || lastCompleted) {
      console.log('Ingestion State:');
      console.log(`  Last Event Offset: ${lastOffset}`);
      if (lastStarted) {
        console.log(`  Last Run Started: ${lastStarted}`);
      }
      if (lastCompleted) {
        console.log(`  Last Run Completed: ${lastCompleted}`);
      }
      console.log('');
    }

  } catch (error) {
    console.error('Error generating statistics:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    storage.close();
  }
}

// Run stats
printStats();

