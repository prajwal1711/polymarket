/**
 * Place exactly ONE order from the latest plan run
 */

import * as dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, ApiKeyCreds, Side, Chain } from '@polymarket/clob-client';
import { MarketStorage } from './storage';

// Load environment variables
dotenv.config();

import axios from 'axios';

/**
 * Install axios interceptor to fix POLY_ADDRESS for Magic wallet (signature type 1)
 * The library uses signer.getAddress() but for Magic wallet, the API key is tied to FUNDER_ADDRESS
 */
function installPolyAddressFix(): void {
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);
  const funderAddress = process.env.FUNDER_ADDRESS;

  // Only apply fix for Magic wallet (signature type 1) with a funder address
  if (signatureType !== 1 || !funderAddress) {
    return;
  }

  // Add axios request interceptor to fix POLY_ADDRESS header
  axios.interceptors.request.use((config) => {
    // Check if this is a Polymarket CLOB request with L2 auth headers
    if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
      // Replace the signer address with the funder address
      config.headers['POLY_ADDRESS'] = funderAddress;
    }
    return config;
  });

  console.log('  ✓ Installed POLY_ADDRESS fix for Magic wallet');
}

// Polymarket CLOB API configuration
const HOST = 'https://clob.polymarket.com';

// Get configuration from environment
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1', 10);
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
const MAX_COST = 0.02; // Hard safety cap

/**
 * Load and validate PRIVATE_KEY from environment variables
 */
function loadPrivateKey(): string {
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error('PRIVATE_KEY is not set in .env file');
  }
  
  if (!privateKey.startsWith('0x')) {
    throw new Error('PRIVATE_KEY must start with 0x');
  }
  
  if (privateKey.length !== 66) {
    throw new Error(`PRIVATE_KEY must be 66 characters (got ${privateKey.length})`);
  }
  
  return privateKey;
}

/**
 * Load API credentials from environment variables
 */
function loadApiCredentials(): ApiKeyCreds | null {
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;
  
  if (apiKey && apiSecret && apiPassphrase) {
    return {
      key: apiKey,
      secret: apiSecret,
      passphrase: apiPassphrase,
    };
  }
  
  return null;
}

/**
 * Check if error is related to nonce being already used
 */
function isNonceError(error: any): boolean {
  const errorMessage = error?.response?.data?.error || 
                      error?.data?.error || 
                      error?.message || 
                      String(error);
  const lowerMessage = errorMessage.toLowerCase();
  return lowerMessage.includes('nonce') || 
         lowerMessage.includes('already used') ||
         lowerMessage.includes('nonce 0');
}

/**
 * Create or derive L2 API credentials
 * If nonce 0 is used, tries with nonce 1+
 */
async function createOrDeriveApiKey(l1Client: ClobClient): Promise<ApiKeyCreds> {
  // Try to derive existing API key first (with nonce 0)
  try {
    const credentials = await l1Client.deriveApiKey();
    
    if (!credentials.key || !credentials.secret || !credentials.passphrase) {
      throw new Error('deriveApiKey returned invalid credentials');
    }
    
    return credentials;
  } catch (deriveError) {
    // If derivation fails with nonce error, try with incrementing nonces
    if (isNonceError(deriveError)) {
      for (let nonce = 1; nonce <= 10; nonce++) {
        try {
          const credentials = await l1Client.deriveApiKey(nonce);
          
          if (!credentials.key || !credentials.secret || !credentials.passphrase) {
            continue; // Try next nonce
          }
          
          return credentials;
        } catch (nonceError) {
          if (nonce < 10) {
            continue; // Try next nonce
          }
          // If we've tried all nonces, fall through to create
        }
      }
    }
    
    // If derivation fails, try to create a new API key
    try {
      const credentials = await l1Client.createApiKey();
      
      if (!credentials.key || !credentials.secret || !credentials.passphrase) {
        throw new Error('createApiKey returned invalid credentials');
      }
      
      return credentials;
    } catch (createError: any) {
      // If nonce 0 is used, try with nonce 1+
      if (isNonceError(createError)) {
        for (let nonce = 1; nonce <= 10; nonce++) {
          try {
            const credentials = await l1Client.createApiKey(nonce);
          
          if (!credentials.key || !credentials.secret || !credentials.passphrase) {
            continue; // Try next nonce
          }
          
            return credentials;
          } catch (nonceError: any) {
            if (nonce < 10) {
              continue; // Try next nonce
            }
            // If we've tried all nonces, use the last error
            createError = nonceError;
          }
        }
      }
      
      const errorMessage = createError?.response?.data?.error || 
                          createError?.data?.error || 
                          createError?.message || 
                          String(createError);
      throw new Error(`Failed to create API key: ${errorMessage}`);
    }
  }
}

/**
 * Create L1 ClobClient with wallet from private key
 */
function createL1Client(privateKey: string): ClobClient {
  // ClobClient requires wallet to be connected to a provider
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);
  
  if (!FUNDER_ADDRESS) {
    throw new Error('FUNDER_ADDRESS is required in .env file');
  }
  
  return new ClobClient(HOST, Chain.POLYGON, wallet, undefined, SIGNATURE_TYPE, FUNDER_ADDRESS);
}

/**
 * Create L2 ClobClient with API credentials
 */
function createL2Client(privateKey: string, apiCreds: ApiKeyCreds): ClobClient {
  // ClobClient requires wallet to be connected to a provider
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);

  if (!FUNDER_ADDRESS) {
    throw new Error('FUNDER_ADDRESS is required in .env file');
  }

  return new ClobClient(HOST, Chain.POLYGON, wallet, apiCreds, SIGNATURE_TYPE, FUNDER_ADDRESS);
}

/**
 * Main function to place one order
 */
async function placeOneOrder(): Promise<void> {
  // Install axios interceptor to fix POLY_ADDRESS for Magic wallet
  installPolyAddressFix();

  console.log('Placing one order from latest plan run...\n');

  // Guardrail: Require CONFIRM=YES_TO_PLACE_ORDER
  const confirm = process.env.CONFIRM;
  if (confirm !== 'YES_TO_PLACE_ORDER') {
    console.error('═══════════════════════════════════════════════════════');
    console.error('✗ ORDER PLACEMENT BLOCKED');
    console.error('═══════════════════════════════════════════════════════');
    console.error('CONFIRM environment variable must be set to "YES_TO_PLACE_ORDER"');
    console.error('This is a safety measure to prevent accidental order placement.');
    console.error('═══════════════════════════════════════════════════════\n');
    process.exit(1);
  }

  const storage = new MarketStorage(false); // Use SQLite

  try {
    // Step 1: Load latest plan run
    console.log('Step 1: Loading latest plan run...');
    const planRun = storage.getLatestPlanRun();
    if (!planRun) {
      throw new Error('No plan runs found. Run the plan script first.');
    }
    console.log(`  Plan Run ID: ${planRun.id}`);
    console.log(`  Mode: ${planRun.mode}`);
    console.log(`  Created at: ${planRun.createdAt}\n`);

    // Step 2: Get one valid order with smallest cost
    console.log('Step 2: Finding valid order with smallest cost...');
    const order = storage.getOneValidOrder(planRun.id);
    if (!order) {
      throw new Error('No valid orders found in latest plan run');
    }

    // Guardrail: Check max cost
    if (order.cost === null || order.cost === undefined || order.cost > MAX_COST) {
      throw new Error(`Order cost (${order.cost}) exceeds maximum allowed cost (${MAX_COST})`);
    }

    // Validate required fields
    if (!order.yesTokenId) {
      throw new Error('Order missing yesTokenId');
    }
    if (order.price === null || order.price === undefined || isNaN(order.price)) {
      throw new Error(`Order has invalid price: ${order.price}`);
    }
    if (order.size === null || order.size === undefined || isNaN(order.size)) {
      throw new Error(`Order has invalid size: ${order.size}`);
    }
    if (order.minTickSize === null || order.minTickSize === undefined || isNaN(order.minTickSize)) {
      throw new Error(`Order has invalid minTickSize: ${order.minTickSize}`);
    }

    // Step 3: Print order details (no secrets)
    console.log('Step 3: Order details:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Market ID: ${order.marketId}`);
    console.log(`  Question: ${order.question || 'N/A'}`);
    console.log(`  YES Token ID: ${order.yesTokenId}`);
    console.log(`  Price: ${order.price}`);
    console.log(`  Size: ${order.size}`);
    console.log(`  Cost: ${order.cost}`);
    console.log(`  Min Tick Size: ${order.minTickSize}`);
    console.log(`  Min Order Size: ${order.minOrderSize || 'N/A'}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Step 4: Initialize authenticated ClobClient
    console.log('Step 4: Initializing authenticated ClobClient...');
    const privateKey = loadPrivateKey();
    const l1Client = createL1Client(privateKey);
    
    // Get or derive API credentials
    let apiCreds = loadApiCredentials();
    if (!apiCreds) {
      console.log('  Deriving/creating API credentials...');
      try {
        apiCreds = await createOrDeriveApiKey(l1Client);
        console.log('  ⚠️  NEW API KEY CREATED - Save these to .env:');
        console.log(`  API_KEY=${apiCreds.key}`);
        console.log(`  API_SECRET=${apiCreds.secret}`);
        console.log(`  API_PASSPHRASE=${apiCreds.passphrase}`);
      } catch (keyError: any) {
        throw new Error(`Failed to get API credentials: ${keyError.message}. Your account may need to be activated or verified on Polymarket.`);
      }
    } else {
      console.log('  Using API credentials from .env');
      console.log('  Attempting to derive fresh API key to check for updates...');
      try {
        const derivedCreds = await l1Client.deriveApiKey();
        if (derivedCreds && derivedCreds.key && derivedCreds.key !== apiCreds.key) {
          console.log('  ⚠️  Found different API key from derivation!');
          console.log('  Using derived API key instead...');
          apiCreds = derivedCreds;
          console.log('  ⚠️  Save these NEW credentials to .env:');
          console.log(`  API_KEY=${apiCreds.key}`);
          console.log(`  API_SECRET=${apiCreds.secret}`);
          console.log(`  API_PASSPHRASE=${apiCreds.passphrase}`);
        } else {
          console.log('  Derived API key matches .env (or derivation failed)');
        }
      } catch (deriveError: any) {
        console.log('  Could not derive API key (this is OK if .env key is valid)');
      }
    }
    
    const l2Client = createL2Client(privateKey, apiCreds);
    
      // Test if the credentials work by trying authenticated calls
      if (apiCreds) {
        console.log('  Testing API credentials...');
        console.log(`  API Key (first 15 chars): ${apiCreds.key.substring(0, 15)}...`);
        console.log(`  API Secret (first 15 chars): ${apiCreds.secret.substring(0, 15)}...`);
        
        // Test read operation
        try {
          const trades = await l2Client.getTrades();
          console.log('  ✓ API credentials work for read operations (getTrades)');
        } catch (testError: any) {
          const errorMsg = testError?.response?.data?.error || testError?.data?.error || testError?.message || String(testError);
          console.log('  ⚠️  Read operation test failed:', errorMsg.substring(0, 150));
        }

        // Test write operation (getOpenOrders) - this works according to GitHub issue #187
        // If this works but postOrder doesn't, it confirms the known API bug
        try {
          const openOrders = await l2Client.getOpenOrders();
          if (openOrders && Array.isArray(openOrders) && openOrders.length > 0) {
            console.log(`  Found ${openOrders.length} open orders - write endpoints accessible`);
            console.log('  ✓ Can access write endpoints (getOpenOrders works)');
          } else {
            console.log('  No open orders found (this is OK)');
            console.log('  ✓ Can access write endpoints (getOpenOrders works)');
          }
        } catch (writeTestError: any) {
          const writeErrorMsg = writeTestError?.response?.data?.error || writeTestError?.data?.error || writeTestError?.message || String(writeTestError);
          console.log('  ⚠️  Write operation test (getOpenOrders) failed:', writeErrorMsg.substring(0, 150));
        }
      }
    
    console.log('  ✓ ClobClient initialized\n');

      // Step 4.5: Test connectivity with a GET request
      console.log('Step 4.5: Testing API connectivity...');
      try {
        const ok = await l2Client.getOk();
        console.log(`  ✓ GET /ok successful\n`);
      } catch (testError: any) {
        console.log(`  ⚠️  GET /ok failed: ${testError.message || String(testError).substring(0, 100)}\n`);
      }

    // Step 5: Place the order
    console.log('Step 5: Placing order...');
    let orderResult: any;
    let orderHash: string | undefined;
    
    try {
      // Create order object - ensure all values are valid numbers
      const price = Number(order.price);
      const size = Number(order.size);
      const tickSize = Number(order.minTickSize);
      
      if (isNaN(price) || isNaN(size) || isNaN(tickSize)) {
        throw new Error(`Invalid numeric values: price=${order.price}, size=${order.size}, tickSize=${order.minTickSize}`);
      }
      
      // Create order params object - UserLimitOrder format
      const orderParams = {
        side: Side.BUY,
        tokenID: order.yesTokenId!,
        price: price,
        size: size,
      };
      
      console.log(`  Order params:`);
      console.log(`    side: ${orderParams.side}`);
      console.log(`    tokenID: ${orderParams.tokenID}`);
      console.log(`    price: ${orderParams.price}`);
      console.log(`    size: ${orderParams.size}`);
      
      // Add small delay to avoid rate limiting
      console.log(`  Waiting 1 second before creating order...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Create order and post it
      try {
        console.log(`  Creating order...`);
        const createdOrder = await l2Client.createOrder(orderParams);
        console.log(`  ✓ Order created successfully`);
        console.log(`  Created order structure:`, JSON.stringify(createdOrder, null, 2).substring(0, 500));
        
        // Add small delay before posting
        console.log(`  Waiting 1 second before posting order...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`  Posting order...`);
        console.log(`  Order structure (first 300 chars):`, JSON.stringify(createdOrder, null, 2).substring(0, 300));
        
        orderResult = await l2Client.postOrder(createdOrder);
        console.log(`  Post order response:`, JSON.stringify(orderResult, null, 2).substring(0, 500));
        
        // Check if the response contains an error
        if (orderResult && typeof orderResult === 'object' && 'error' in orderResult) {
          const errorDetail = orderResult.error;
          const errorString = typeof errorDetail === 'string' ? errorDetail : 
                             (typeof errorDetail === 'object' && errorDetail?.error ? String(errorDetail.error) : 
                              JSON.stringify(errorDetail));
          console.log(`  ✗ Order posting failed with error: ${errorString}`);
          
          // Provide specific guidance based on error
          if (errorString.includes('Unauthorized') || errorString.includes('Invalid api key')) {
            console.log(`  \n  ⚠️  Known Issue: This matches GitHub issue #187`);
            console.log(`  https://github.com/Polymarket/py-clob-client/issues/187`);
            console.log(`  \n  The API key works for read operations and cancelOrder, but postOrder fails.`);
            console.log(`  This appears to be a bug in the Polymarket API.`);
            console.log(`  \n  Possible workarounds:`);
            console.log(`    1. Try generating a fresh API key from Polymarket UI`);
            console.log(`    2. Contact Polymarket support about this specific issue`);
            console.log(`    3. Check if there's an API update or alternative endpoint`);
            console.log(`    4. Verify account has full trading permissions enabled`);
          }
          
          throw new Error(`Order posting failed: ${errorString || 'Unknown error'}`);
        }
        
        // Extract order ID from response (OrderResponse has orderID and transactionHash)
        orderHash = (orderResult as any)?.orderID || (orderResult as any)?.order_id || (orderResult as any)?.id || 
                    (orderResult as any)?.transactionHash || (orderResult as any)?.hash;
        
        if (!orderHash) {
          throw new Error(`Order posting failed: No order hash/ID returned. Response: ${JSON.stringify(orderResult, null, 2)}`);
        }
      } catch (error: any) {
        // Detailed diagnostics for Cloudflare/403 errors
        console.log(`\n  ✗ Request failed - Diagnostics:`);
        
        // Handle string errors (HTML responses)
        const errorString = typeof error === 'string' ? error : String(error);
        const isCloudflareHTML = errorString.includes('Cloudflare') || errorString.includes('Attention Required');
        
        // Try to extract error details from various possible structures
        let status: number | undefined;
        let statusText: string | undefined;
        let url: string | undefined;
        let method: string | undefined;
        let responseData: any;
        
        // Check for axios-style error (object)
        if (error && typeof error === 'object' && 'response' in error) {
          status = error.response?.status;
          statusText = error.response?.statusText;
          url = error.response?.config?.url;
          method = error.response?.config?.method;
          responseData = error.response?.data;
        } 
        // Check for direct error properties
        else if (error && typeof error === 'object' && 'status' in error) {
          status = error.status;
          statusText = error.statusText;
          url = error.config?.url;
          method = error.config?.method;
          responseData = error.data;
        }
        
        console.log(`    Method: ${method ? method.toUpperCase() : 'POST (inferred)'}`);
        console.log(`    URL: ${url || 'unknown (likely /orders endpoint)'}`);
        console.log(`    Status: ${status || (isCloudflareHTML ? '403 (inferred from Cloudflare HTML)' : 'N/A')} ${statusText || ''}`);
        
        // Check if it's a Cloudflare block
        if (status === 403 || isCloudflareHTML) {
          console.log(`    Error Type: Cloudflare WAF Block`);
          
          // Extract Cloudflare Ray ID if present
          const rayIdMatch = errorString.match(/Cloudflare Ray ID[^<]*<strong[^>]*>([^<]+)<\/strong>/);
          if (rayIdMatch) {
            console.log(`    Cloudflare Ray ID: ${rayIdMatch[1]}`);
          }
          
          console.log(`    Response Type: HTML (Cloudflare block page)`);
          console.log(`    Response Preview: ${errorString.substring(0, 300)}...`);
          
          // Log request headers if available
          const config = (error && typeof error === 'object' && 'response' in error) 
            ? error.response?.config 
            : (error && typeof error === 'object' && 'config' in error) 
              ? error.config 
              : null;
              
          if (config?.headers) {
            console.log(`    Request Headers:`);
            const headers = config.headers;
            Object.keys(headers).forEach(key => {
              const lowerKey = key.toLowerCase();
              if (lowerKey !== 'authorization' && lowerKey !== 'api-key' && 
                  lowerKey !== 'api-secret' && lowerKey !== 'x-api-key' && 
                  lowerKey !== 'x-api-secret') {
                console.log(`      ${key}: ${headers[key]}`);
              } else {
                console.log(`      ${key}: [REDACTED]`);
              }
            });
          } else {
            console.log(`    Request Headers: Not available (error is string, not object)`);
          }
          
          throw new Error(`Order posting blocked by Cloudflare (403 Forbidden). GET requests work but POST is blocked. Possible causes: 1) Missing/incorrect headers, 2) Rate limiting, 3) IP reputation, 4) Request format issues. Contact Polymarket support with Cloudflare Ray ID if available.`);
        }
        
        // Extract error message
        let errorMsg: string;
        if (typeof error === 'string') {
          errorMsg = error.substring(0, 200);
        } else if (responseData) {
          if (typeof responseData === 'string') {
            errorMsg = responseData.substring(0, 200);
          } else if (responseData && typeof responseData === 'object' && 'error' in responseData) {
            errorMsg = responseData.error;
          } else {
            errorMsg = String(responseData).substring(0, 200);
          }
        } else if (error && typeof error === 'object' && 'message' in error) {
          errorMsg = error.message;
        } else {
          errorMsg = String(error).substring(0, 200);
        }
        
        console.log(`    Error Message: ${errorMsg}`);
        throw new Error(`Failed to place order: ${errorMsg}`);
      }
    } catch (error: any) {
      // If error is already an Error object with message, use it directly
      if (error instanceof Error) {
        throw error;
      }
      // Otherwise, create a new error with the message
      const errorMsg = error?.message || String(error).substring(0, 200);
      throw new Error(`Failed to place order: ${errorMsg}`);
    }

    console.log('  ✓ Order placed successfully');
    console.log(`  Order Hash/ID: ${orderHash || 'N/A'}\n`);

    // Step 6: Fetch order to confirm
    console.log('Step 6: Confirming order...');
    if (orderHash && orderHash !== 'N/A') {
      try {
        const fetchedOrder = await l2Client.getOrder(orderHash);
        console.log('  ✓ Order confirmed on chain');
        console.log(`  Order Status: ${(fetchedOrder as any).status || 'N/A'}`);
        console.log(`  Side: ${(fetchedOrder as any).side || 'N/A'}`);
        console.log(`  Price: ${(fetchedOrder as any).price || 'N/A'}`);
        console.log(`  Size: ${(fetchedOrder as any).size || (fetchedOrder as any).remainingSize || 'N/A'}`);
      } catch (fetchError: any) {
        console.log(`  ⚠️  Could not fetch order: ${fetchError.message || String(fetchError)}`);
        console.log(`  This may be normal if the order endpoint requires different permissions.`);
      }
    } else {
      console.log(`  ⚠️  No order hash/ID available to confirm. Order may not have been placed.`);
      console.log(`  Check your Polymarket account or try listing open orders.`);
    }
    
    // Try to get open orders as alternative confirmation
    try {
      console.log(`\n  Attempting to list open orders to verify placement...`);
      const openOrders = await l2Client.getOpenOrders({});
      console.log(`  Open orders count: ${Array.isArray(openOrders) ? openOrders.length : 'N/A'}`);
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        const recentOrder = openOrders.find((o: any) => {
          const matchesToken = o.tokenId === order.yesTokenId || o.token_id === order.yesTokenId;
          const matchesPrice = order.price !== null && o.price && 
            Math.abs(Number(o.price) - Number(order.price)) < 0.0001;
          return matchesToken || matchesPrice;
        });
        if (recentOrder) {
          console.log(`  ✓ Found matching order in open orders!`);
          console.log(`  Order ID: ${(recentOrder as any).id || (recentOrder as any).order_id || 'N/A'}`);
          console.log(`  Status: ${(recentOrder as any).status || 'N/A'}`);
        }
      }
    } catch (openOrdersError: any) {
      console.log(`  ⚠️  Could not list open orders: ${openOrdersError.message || String(openOrdersError)}`);
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('✓ ORDER PLACEMENT COMPLETE');
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ ORDER PLACEMENT FAILED');
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

// Run order placement
placeOneOrder();

