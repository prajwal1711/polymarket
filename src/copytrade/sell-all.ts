/**
 * Sell all open positions from Polymarket
 * Queries actual positions from Polymarket API
 */

import * as dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { PolymarketDataApi } from './data-api';

dotenv.config();

const CLOB_HOST = 'https://clob.polymarket.com';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('         SELL ALL OPEN POSITIONS');
  console.log('═══════════════════════════════════════════════════════\n');

  const walletAddress = process.env.FUNDER_ADDRESS!;
  console.log(`Wallet: ${walletAddress}\n`);

  // Fetch actual positions from Polymarket
  const dataApi = new PolymarketDataApi();
  const positions = await dataApi.getPositionsForWallet(walletAddress);

  if (positions.length === 0) {
    console.log('No open positions to sell.');
    return;
  }

  console.log(`Found ${positions.length} open positions:\n`);

  let totalValue = 0;
  for (const p of positions) {
    console.log(`  - ${p.size.toFixed(2)} shares @ $${p.curPrice.toFixed(3)} = $${p.currentValue.toFixed(2)}`);
    console.log(`    ${p.title.substring(0, 50)}... [${p.outcome}]`);
    console.log(`    Entry: $${p.avgPrice.toFixed(3)} | PnL: $${p.cashPnl.toFixed(2)} (${p.percentPnl.toFixed(1)}%)`);
    totalValue += p.currentValue;
  }
  console.log(`\nTotal value: $${totalValue.toFixed(2)}\n`);

  // Initialize CLOB client
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);

  const client = new ClobClient(
    CLOB_HOST,
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

  console.log('Selling positions...\n');
  console.log('─────────────────────────────────────────────────────────');

  let sold = 0;
  let failed = 0;
  let totalProceeds = 0;
  let totalInitialValue = 0;

  for (const position of positions) {
    try {
      // Get current orderbook to find best bid
      const orderbook = await client.getOrderBook(position.asset);

      let sellPrice: number;
      if (orderbook.bids && orderbook.bids.length > 0) {
        // Use best bid price
        sellPrice = parseFloat(orderbook.bids[0].price);
      } else {
        // No bids - use current price from position data
        sellPrice = position.curPrice > 0 ? position.curPrice : 0.01;
        console.log(`  Warning: No bids, using curPrice $${sellPrice}`);
      }

      const proceeds = position.size * sellPrice;
      const pnl = proceeds - position.initialValue;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

      console.log(`\n  Selling ${position.size.toFixed(1)} shares @ $${sellPrice.toFixed(3)}`);
      console.log(`    ${position.title.substring(0, 45)}... [${position.outcome}]`);
      console.log(`    Entry: $${position.avgPrice.toFixed(3)} | Exit: $${sellPrice.toFixed(3)} | PnL: ${pnlStr}`);

      // Create and place sell order
      const orderParams = {
        side: Side.SELL,
        tokenID: position.asset,
        price: sellPrice,
        size: position.size,
      };

      const createdOrder = await client.createOrder(orderParams);
      const result = await client.postOrder(createdOrder);

      if (result && typeof result === 'object' && 'error' in result) {
        console.log(`    FAILED: ${(result as any).error}`);
        failed++;
      } else {
        const orderId = (result as any)?.orderID || (result as any)?.order_id || 'unknown';
        console.log(`    SOLD! Order: ${String(orderId).substring(0, 20)}...`);
        sold++;
        totalProceeds += proceeds;
      }

      totalInitialValue += position.initialValue;

      // Rate limit
      await sleep(500);

    } catch (error: any) {
      console.log(`    ERROR: ${error.message?.substring(0, 100)}`);
      failed++;
    }
  }

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Positions sold: ${sold}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total proceeds: $${totalProceeds.toFixed(2)}`);
  console.log(`  Initial investment: $${totalInitialValue.toFixed(2)}`);
  console.log(`  Net PnL: $${(totalProceeds - totalInitialValue).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);
