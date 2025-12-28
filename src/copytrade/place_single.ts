/**
 * Place a single copy trade order
 * Usage: CONFIRM=YES npx ts-node src/copytrade/place_single.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, Side, Chain } from '@polymarket/clob-client';
import axios from 'axios';
import { CopytradeStorage } from './storage';
import { v4 as uuidv4 } from 'uuid';

// Order details - copying the Anthropic IPO trade
const ORDER = {
  tokenId: '14495888673864948586083280727326896461319586754303430637766841544809472748499',
  conditionId: '0xaf4c3ba4d1b1568d4309bba0874cb7eec1e5b40a648f4a26b12efa2e9b5ee8a4',
  price: 0.60,  // Rounded to tick size 0.01
  size: 8,      // $4.80 total
  side: Side.BUY,
  market: 'Will Anthropic not IPO by June 30, 2026?',
  targetAddress: '0x063aeee10fbfd55b6def10da28e87a601e7deb4b',
};

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║         PLACE SINGLE COPY TRADE ORDER                 ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // Safety check
  if (process.env.CONFIRM !== 'YES') {
    console.log('Order details:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Market: ${ORDER.market}`);
    console.log(`  Side:   ${ORDER.side === Side.BUY ? 'BUY' : 'SELL'}`);
    console.log(`  Price:  $${ORDER.price}`);
    console.log(`  Size:   ${ORDER.size} shares`);
    console.log(`  Cost:   $${(ORDER.price * ORDER.size).toFixed(2)}`);
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('To place this order, run:');
    console.log('  CONFIRM=YES npx ts-node src/copytrade/place_single.ts\n');
    return;
  }

  // Load credentials
  const privateKey = process.env.PRIVATE_KEY;
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;
  const funderAddress = process.env.FUNDER_ADDRESS;
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '1', 10);

  if (!privateKey || !apiKey || !apiSecret || !apiPassphrase || !funderAddress) {
    console.error('Missing credentials in .env');
    process.exit(1);
  }

  // Install axios interceptor for Magic wallet
  if (signatureType === 1) {
    axios.interceptors.request.use((config) => {
      if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
        config.headers['POLY_ADDRESS'] = funderAddress;
      }
      return config;
    });
  }

  console.log('Initializing client...');
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);
  const client = new ClobClient(
    'https://clob.polymarket.com',
    Chain.POLYGON,
    wallet,
    { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    signatureType,
    funderAddress
  );

  console.log('Placing order...');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Market: ${ORDER.market}`);
  console.log(`  Side:   BUY`);
  console.log(`  Price:  $${ORDER.price}`);
  console.log(`  Size:   ${ORDER.size} shares`);
  console.log(`  Cost:   $${(ORDER.price * ORDER.size).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    const orderParams = {
      side: ORDER.side,
      tokenID: ORDER.tokenId,
      price: ORDER.price,
      size: ORDER.size,
    };

    const createdOrder = await client.createOrder(orderParams);
    console.log('Order created, posting...');

    const result = await client.postOrder(createdOrder);

    if (result && typeof result === 'object' && 'error' in result) {
      console.error(`Order failed: ${(result as any).error}`);
      process.exit(1);
    }

    const orderId = (result as any)?.orderID || (result as any)?.order_id || 'unknown';
    console.log(`\n✓ Order placed successfully!`);
    console.log(`  Order ID: ${orderId}`);

    // Track the position
    const storage = new CopytradeStorage();
    storage.openOrAddPosition({
      id: uuidv4(),
      targetAddress: ORDER.targetAddress,
      tokenId: ORDER.tokenId,
      conditionId: ORDER.conditionId,
      shares: ORDER.size,
      price: ORDER.price,
      cost: ORDER.price * ORDER.size,
    });
    console.log(`  Position tracked in database`);
    storage.close();

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('ORDER COMPLETE');
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error: any) {
    console.error(`\nOrder failed: ${error.message}`);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
