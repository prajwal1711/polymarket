/**
 * Generate report.json from latest plan run
 */

import { MarketStorage } from './storage';
import * as fs from 'fs';
import * as path from 'path';

const REPORT_PATH = path.join(process.cwd(), 'data', 'report.json');

function generateReport(): void {
  console.log('Generating report from latest plan run...\n');

  const storage = new MarketStorage(false); // Use SQLite

  try {
    // Get latest plan run
    const planRun = storage.getLatestPlanRun();
    if (!planRun) {
      console.error('No plan runs found. Run the plan script first.');
      process.exit(1);
    }

    console.log(`Loading plan run: ${planRun.id}`);
    console.log(`Mode: ${planRun.mode}`);
    console.log(`Created at: ${planRun.createdAt}\n`);

    // Get all planned orders for this run
    const orders = storage.getPlannedOrders(planRun.id);

    // Aggregate statistics
    const totalMarketsConsidered = orders.length;
    const validOrders = orders.filter(o => o.isValid);
    const invalidOrders = orders.filter(o => !o.isValid);
    const validCount = validOrders.length;
    const invalidCount = invalidOrders.length;

    // Calculate total planned cost (sum of cost for valid orders)
    const totalPlannedCost = validOrders.reduce((sum, order) => {
      return sum + (order.cost || 0);
    }, 0);

    // Skip reason breakdown
    const skipReasonBreakdown: Record<string, number> = {};
    invalidOrders.forEach(order => {
      const reason = order.skipReason || 'unknown';
      skipReasonBreakdown[reason] = (skipReasonBreakdown[reason] || 0) + 1;
    });

    // Price bucket counts (count of valid orders by price)
    const priceBucketCounts: Record<string, number> = {};
    validOrders.forEach(order => {
      if (order.price !== null) {
        const priceKey = String(order.price);
        priceBucketCounts[priceKey] = (priceBucketCounts[priceKey] || 0) + 1;
      }
    });

    // Sample valid orders (first 20)
    const sampleValidOrders = validOrders.slice(0, 20).map(order => ({
      market_id: order.marketId,
      question: order.question,
      yes_token_id: order.yesTokenId,
      price: order.price,
      size: order.size,
      cost: order.cost,
      min_tick_size: order.minTickSize,
      min_order_size: order.minOrderSize,
    }));

    // Top 20 by cost
    const top20ByCost = validOrders
      .sort((a, b) => (b.cost || 0) - (a.cost || 0))
      .slice(0, 20)
      .map(order => ({
        market_id: order.marketId,
        question: order.question,
        yes_token_id: order.yesTokenId,
        price: order.price,
        size: order.size,
        cost: order.cost,
        min_tick_size: order.minTickSize,
        min_order_size: order.minOrderSize,
      }));

    // Build report
    const report = {
      plan_run_id: planRun.id,
      mode: planRun.mode,
      created_at: planRun.createdAt,
      params: JSON.parse(planRun.paramsJson),
      summary: {
        total_markets_considered: totalMarketsConsidered,
        valid_count: validCount,
        invalid_count: invalidCount,
        total_planned_cost: totalPlannedCost,
        skip_reason_breakdown: skipReasonBreakdown,
        price_bucket_counts: priceBucketCounts,
      },
      sample_valid_orders: sampleValidOrders,
      top_20_by_cost: top20ByCost,
    };

    // Ensure data directory exists
    const dataDir = path.dirname(REPORT_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Write report
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    console.log('Report generated successfully!');
    console.log(`  Total Markets Considered: ${totalMarketsConsidered}`);
    console.log(`  Valid Orders: ${validCount}`);
    console.log(`  Invalid Orders: ${invalidCount}`);
    console.log(`  Total Planned Cost: ${totalPlannedCost.toFixed(4)}`);
    console.log(`  Report saved to: ${REPORT_PATH}\n`);

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ REPORT GENERATION FAILED');
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

// Run report generation
generateReport();

