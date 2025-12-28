/**
 * Place multiple orders from the latest plan run
 */

import * as dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, ApiKeyCreds, Side, Chain } from '@polymarket/clob-client';
import { MarketStorage } from './storage';

// Load environment variables
dotenv.config();

import axios from 'axios';

// Configuration
const HOST = 'https://clob.polymarket.com';
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1', 10);
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
const MAX_COST_PER_ORDER = 0.10; // Safety cap per order
const ORDER_DELAY_MS = 500; // Delay between orders to avoid rate limiting

interface PlacementResult {
  marketId: string;
  question: string;
  success: boolean;
  orderId?: string;
  error?: string;
  cost: number;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): { limit: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  let limit = 10; // Default to 10 orders for safety
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit <= 0) {
        console.error('Invalid --limit value');
        process.exit(1);
      }
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--all') {
      limit = Infinity;
    }
  }

  return { limit, dryRun };
}

/**
 * Install axios interceptor for Magic wallet
 */
function installPolyAddressFix(): void {
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);
  const funderAddress = process.env.FUNDER_ADDRESS;

  if (signatureType !== 1 || !funderAddress) return;

  axios.interceptors.request.use((config) => {
    if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
      config.headers['POLY_ADDRESS'] = funderAddress;
    }
    return config;
  });
}

/**
 * Load private key from environment
 */
function loadPrivateKey(): string {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY is not set');
  if (!privateKey.startsWith('0x')) throw new Error('PRIVATE_KEY must start with 0x');
  if (privateKey.length !== 66) throw new Error('PRIVATE_KEY must be 66 characters');
  return privateKey;
}

/**
 * Load API credentials from environment
 */
function loadApiCredentials(): ApiKeyCreds | null {
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;

  if (apiKey && apiSecret && apiPassphrase) {
    return { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };
  }
  return null;
}

/**
 * Check if error is nonce-related
 */
function isNonceError(error: any): boolean {
  const msg = (error?.response?.data?.error || error?.message || String(error)).toLowerCase();
  return msg.includes('nonce') || msg.includes('already used');
}

/**
 * Create or derive API key
 */
async function createOrDeriveApiKey(l1Client: ClobClient): Promise<ApiKeyCreds> {
  try {
    const creds = await l1Client.deriveApiKey();
    if (creds.key && creds.secret && creds.passphrase) return creds;
  } catch (e) {
    if (isNonceError(e)) {
      for (let nonce = 1; nonce <= 10; nonce++) {
        try {
          const creds = await l1Client.deriveApiKey(nonce);
          if (creds.key && creds.secret && creds.passphrase) return creds;
        } catch { continue; }
      }
    }
  }

  // Try creating new key
  try {
    const creds = await l1Client.createApiKey();
    if (creds.key && creds.secret && creds.passphrase) return creds;
  } catch (e) {
    if (isNonceError(e)) {
      for (let nonce = 1; nonce <= 10; nonce++) {
        try {
          const creds = await l1Client.createApiKey(nonce);
          if (creds.key && creds.secret && creds.passphrase) return creds;
        } catch { continue; }
      }
    }
  }

  throw new Error('Failed to get API credentials');
}

/**
 * Create L1 client
 */
function createL1Client(privateKey: string): ClobClient {
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);
  if (!FUNDER_ADDRESS) throw new Error('FUNDER_ADDRESS required');
  return new ClobClient(HOST, Chain.POLYGON, wallet, undefined, SIGNATURE_TYPE, FUNDER_ADDRESS);
}

/**
 * Create L2 client with API credentials
 */
function createL2Client(privateKey: string, apiCreds: ApiKeyCreds): ClobClient {
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);
  if (!FUNDER_ADDRESS) throw new Error('FUNDER_ADDRESS required');
  return new ClobClient(HOST, Chain.POLYGON, wallet, apiCreds, SIGNATURE_TYPE, FUNDER_ADDRESS);
}

/**
 * Place a single order
 */
async function placeOrder(
  l2Client: ClobClient,
  tokenId: string,
  price: number,
  size: number
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const orderParams = {
      side: Side.BUY,
      tokenID: tokenId,
      price: price,
      size: size,
    };

    const createdOrder = await l2Client.createOrder(orderParams);
    const result = await l2Client.postOrder(createdOrder);

    if (result && typeof result === 'object' && 'error' in result) {
      return { success: false, error: String((result as any).error) };
    }

    const orderId = (result as any)?.orderID || (result as any)?.order_id || (result as any)?.id;
    return { success: true, orderId };
  } catch (error: any) {
    const msg = error?.response?.data?.error || error?.message || String(error);
    return { success: false, error: msg.substring(0, 200) };
  }
}

/**
 * Main batch placement function
 */
async function placeBatchOrders(): Promise<void> {
  installPolyAddressFix();

  const { limit, dryRun } = parseArgs();

  console.log('Batch order placement\n');
  console.log('Configuration:');
  console.log(`  Order limit: ${limit === Infinity ? 'ALL' : limit}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Max cost per order: $${MAX_COST_PER_ORDER}`);
  console.log(`  Delay between orders: ${ORDER_DELAY_MS}ms\n`);

  // Check confirmation
  const confirm = process.env.CONFIRM;
  if (confirm !== 'YES_TO_PLACE_ORDER' && !dryRun) {
    console.error('Set CONFIRM=YES_TO_PLACE_ORDER to place real orders');
    console.error('Or use --dry-run to simulate\n');
    process.exit(1);
  }

  const storage = new MarketStorage(false);

  try {
    // Load plan
    console.log('Step 1: Loading latest plan run...');
    const planRun = storage.getLatestPlanRun();
    if (!planRun) throw new Error('No plan runs found. Run planning first.');
    console.log(`  Plan Run ID: ${planRun.id}`);
    console.log(`  Created: ${planRun.createdAt}\n`);

    // Get all valid orders
    console.log('Step 2: Loading valid orders...');
    const allOrders = storage.getPlannedOrders(planRun.id);
    const validOrders = allOrders.filter(o => o.isValid && o.cost !== null && o.cost <= MAX_COST_PER_ORDER);
    console.log(`  Total orders: ${allOrders.length}`);
    console.log(`  Valid orders: ${validOrders.length}`);

    const ordersToPlace = validOrders.slice(0, limit);
    console.log(`  Orders to place: ${ordersToPlace.length}\n`);

    if (ordersToPlace.length === 0) {
      console.log('No orders to place.\n');
      return;
    }

    // Calculate totals
    const totalCost = ordersToPlace.reduce((sum, o) => sum + (o.cost || 0), 0);
    console.log(`  Total cost: $${totalCost.toFixed(4)}\n`);

    if (dryRun) {
      console.log('DRY RUN - would place these orders:');
      console.log('═══════════════════════════════════════════════════════');
      ordersToPlace.slice(0, 20).forEach((order, idx) => {
        console.log(`${idx + 1}. ${(order.question || 'Unknown').substring(0, 50)}...`);
        console.log(`   Price: ${order.price} | Size: ${order.size?.toFixed(2)} | Cost: $${order.cost?.toFixed(4)}`);
      });
      if (ordersToPlace.length > 20) {
        console.log(`... and ${ordersToPlace.length - 20} more orders`);
      }
      console.log('═══════════════════════════════════════════════════════\n');
      return;
    }

    // Initialize client
    console.log('Step 3: Initializing client...');
    const privateKey = loadPrivateKey();
    const l1Client = createL1Client(privateKey);

    let apiCreds = loadApiCredentials();
    if (!apiCreds) {
      console.log('  Deriving API credentials...');
      apiCreds = await createOrDeriveApiKey(l1Client);
      console.log('  NEW API KEY - save to .env:');
      console.log(`  API_KEY=${apiCreds.key}`);
      console.log(`  API_SECRET=${apiCreds.secret}`);
      console.log(`  API_PASSPHRASE=${apiCreds.passphrase}`);
    }

    const l2Client = createL2Client(privateKey, apiCreds);
    console.log('  Client initialized\n');

    // Place orders
    console.log('Step 4: Placing orders...');
    console.log('═══════════════════════════════════════════════════════');

    const results: PlacementResult[] = [];
    let successCount = 0;
    let failCount = 0;
    let totalSpent = 0;

    for (let i = 0; i < ordersToPlace.length; i++) {
      const order = ordersToPlace[i];

      // Progress indicator
      process.stdout.write(`\r  [${i + 1}/${ordersToPlace.length}] `);

      if (!order.yesTokenId || order.price === null || order.size === null) {
        results.push({
          marketId: order.marketId,
          question: order.question || '',
          success: false,
          error: 'Missing required fields',
          cost: 0,
        });
        failCount++;
        continue;
      }

      const result = await placeOrder(l2Client, order.yesTokenId, order.price, order.size);

      results.push({
        marketId: order.marketId,
        question: order.question || '',
        success: result.success,
        orderId: result.orderId,
        error: result.error,
        cost: order.cost || 0,
      });

      if (result.success) {
        successCount++;
        totalSpent += order.cost || 0;
        process.stdout.write(`OK - ${order.question?.substring(0, 40)}...`);
      } else {
        failCount++;
        process.stdout.write(`FAIL - ${result.error?.substring(0, 40)}...`);
      }

      // Rate limiting delay
      if (i < ordersToPlace.length - 1) {
        await new Promise(resolve => setTimeout(resolve, ORDER_DELAY_MS));
      }
    }

    console.log('\n═══════════════════════════════════════════════════════\n');

    // Summary
    console.log('BATCH PLACEMENT COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Successful: ${successCount}`);
    console.log(`  Failed: ${failCount}`);
    console.log(`  Total spent: $${totalSpent.toFixed(4)}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Show failures if any
    if (failCount > 0) {
      console.log('Failed orders:');
      results.filter(r => !r.success).slice(0, 10).forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.question.substring(0, 50)}...`);
        console.log(`     Error: ${r.error}`);
      });
      if (failCount > 10) {
        console.log(`  ... and ${failCount - 10} more failures`);
      }
    }

  } catch (error) {
    console.error('\nBATCH PLACEMENT FAILED');
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    storage.close();
  }
}

// Run
placeBatchOrders();
