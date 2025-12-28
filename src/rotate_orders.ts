/**
 * Rotation script for floor order strategy
 *
 * Keeps running until 1000 orders are successfully placed
 */

import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { MarketStorage } from './storage';

dotenv.config();

// Configuration
const CONFIG = {
  targetOrders: 1000,        // Keep placing until 1000 orders
  floorPrice: 0.001,         // $0.001 per share
  batchSize: 200,            // Markets to try per batch
  minOrderSize: 10,          // Minimum shares per order
  maxCostPerOrder: 0.10,     // Max $0.10 per order
  rateLimitMs: 300,          // 300ms between API calls
};

const HOST = 'https://clob.polymarket.com';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createClient(): ClobClient {
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);

  return new ClobClient(
    HOST,
    Chain.POLYGON,
    wallet,
    {
      key: process.env.API_KEY!,
      secret: process.env.API_SECRET!,
      passphrase: process.env.API_PASSPHRASE!,
    },
    signatureType,
    process.env.FUNDER_ADDRESS
  );
}

async function main() {
  console.log('='.repeat(60));
  console.log('FLOOR ORDER PLACER - Target:', CONFIG.targetOrders, 'orders');
  console.log('='.repeat(60));
  console.log('');

  const storage = new MarketStorage();
  const client = createClient();

  let totalPlaced = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batchNumber = 0;

  // Get current open orders count
  try {
    const openOrders = await client.getOpenOrders();
    totalPlaced = openOrders.length;
    console.log('Current open orders:', totalPlaced);
    console.log('Need to place:', CONFIG.targetOrders - totalPlaced, 'more');
    console.log('');
  } catch (e: any) {
    console.error('Error fetching open orders:', e.message);
  }

  // Keep going until we have 1000 orders
  while (totalPlaced < CONFIG.targetOrders) {
    batchNumber++;
    console.log(`\n--- BATCH ${batchNumber} ---`);
    console.log(`Progress: ${totalPlaced} / ${CONFIG.targetOrders}`);

    // Get untried markets
    const markets = storage.getUntriedMarkets(CONFIG.batchSize);

    if (markets.length === 0) {
      console.log('No more untried markets! Run: npm run ingest && npm run enrich:active');
      break;
    }

    console.log(`Found ${markets.length} untried markets`);

    let batchPlaced = 0;
    let batchSkipped = 0;
    let batchErrors = 0;

    for (const market of markets) {
      if (totalPlaced >= CONFIG.targetOrders) break;

      // Calculate order parameters
      const price = Math.max(CONFIG.floorPrice, market.minTickSize || 0.001);
      const size = Math.max(CONFIG.minOrderSize, market.minOrderSize || 10);
      const cost = price * size;

      // Mark as attempted
      storage.markMarketAttempted(market.id, market.yesTokenId);

      // Skip if too expensive
      if (cost > CONFIG.maxCostPerOrder) {
        batchSkipped++;
        continue;
      }

      try {
        const order = await client.createOrder({
          tokenID: market.yesTokenId,
          price,
          size,
          side: 'BUY' as any,
        });

        const result = await client.postOrder(order);

        if (result.success) {
          totalPlaced++;
          batchPlaced++;

          if (batchPlaced % 25 === 0) {
            console.log(`  Placed ${batchPlaced} this batch (${totalPlaced} total)`);
          }
        } else {
          batchErrors++;
        }

        await sleep(CONFIG.rateLimitMs);

      } catch (e: any) {
        batchErrors++;
        totalErrors++;

        // Only log non-orderbook errors
        const msg = e.message || '';
        if (!msg.includes('orderbook') && !msg.includes('does not exist')) {
          console.error(`  Error: ${msg.substring(0, 60)}`);
        }
      }
    }

    totalSkipped += batchSkipped;
    console.log(`Batch ${batchNumber}: +${batchPlaced} placed, ${batchSkipped} skipped, ${batchErrors} errors`);
    console.log(`Total: ${totalPlaced} / ${CONFIG.targetOrders}`);

    // Small delay between batches
    if (totalPlaced < CONFIG.targetOrders) {
      await sleep(1000);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  console.log('Orders placed:', totalPlaced);
  console.log('Markets skipped:', totalSkipped);
  console.log('Errors:', totalErrors);

  if (totalPlaced >= CONFIG.targetOrders) {
    console.log('\nTARGET REACHED!');
  } else {
    console.log('\nNeed more markets. Run:');
    console.log('  npm run ingest && npm run enrich:active && npm run rotate');
  }

  storage.close();
}

main().catch(console.error);
