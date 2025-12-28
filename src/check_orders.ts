/**
 * Quick check of account orders and trades
 */

import * as dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, Chain } from '@polymarket/clob-client';

dotenv.config();

const HOST = 'https://clob.polymarket.com';

async function check() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log('No PRIVATE_KEY set');
    return;
  }

  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);

  const apiCreds = {
    key: process.env.API_KEY || '',
    secret: process.env.API_SECRET || '',
    passphrase: process.env.API_PASSPHRASE || '',
  };

  if (!apiCreds.key) {
    console.log('No API credentials set');
    return;
  }

  const client = new ClobClient(
    HOST,
    Chain.POLYGON,
    wallet,
    apiCreds,
    parseInt(process.env.SIGNATURE_TYPE || '1', 10),
    process.env.FUNDER_ADDRESS
  );

  try {
    console.log('Checking account status...\n');

    const openOrders = await client.getOpenOrders();
    console.log('Open orders:', Array.isArray(openOrders) ? openOrders.length : 0);

    if (Array.isArray(openOrders) && openOrders.length > 0) {
      console.log('\nRecent open orders:');
      openOrders.slice(0, 5).forEach((o: any, i: number) => {
        console.log(`  ${i + 1}. Price: ${o.price} | Size: ${o.size || o.original_size} | Status: ${o.status || 'open'}`);
      });
    }

    const trades = await client.getTrades();
    console.log('\nTrades (filled orders):', Array.isArray(trades) ? trades.length : 0);

    if (Array.isArray(trades) && trades.length > 0) {
      console.log('\nRecent trades:');
      trades.slice(0, 5).forEach((t: any, i: number) => {
        console.log(`  ${i + 1}. Price: ${t.price} | Size: ${t.size} | Side: ${t.side}`);
      });
    }

  } catch (e: any) {
    console.error('Error:', e.message || e);
  }
}

check();
