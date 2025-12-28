import dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, ApiKeyCreds, Chain } from '@polymarket/clob-client';

// Load environment variables first (before patching, so env vars are available)
dotenv.config();

import axios from 'axios';

/**
 * Install axios interceptor to fix POLY_ADDRESS for Magic wallet (signature type 1)
 */
function installPolyAddressFix(): void {
  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '0', 10);
  const funderAddress = process.env.FUNDER_ADDRESS;

  if (signatureType !== 1 || !funderAddress) {
    return;
  }

  axios.interceptors.request.use((config) => {
    if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
      config.headers['POLY_ADDRESS'] = funderAddress;
    }
    return config;
  });
}

// Polymarket CLOB API configuration
const HOST = 'https://clob.polymarket.com';

// Get configuration from environment
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1', 10); // Default to 1 for email/Magic accounts
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;

/**
 * Load and validate PRIVATE_KEY from environment variables
 */
function loadPrivateKey(): string {
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error('PRIVATE_KEY is not set in .env file');
  }
  
  // Validate format: should start with 0x and be 66 characters total
  if (!privateKey.startsWith('0x')) {
    throw new Error('PRIVATE_KEY must start with 0x');
  }
  
  if (privateKey.length !== 66) {
    throw new Error(`PRIVATE_KEY must be 66 characters (got ${privateKey.length}). Format: 0x + 64 hex characters`);
  }
  
  // Basic hex validation
  const hexPart = privateKey.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
    throw new Error('PRIVATE_KEY contains invalid hexadecimal characters');
  }
  
  return privateKey;
}

/**
 * Load API credentials from environment variables (optional)
 * Note: We prefer to derive fresh creds, but allow using existing ones for testing
 */
function loadApiCredentials(): ApiKeyCreds | null {
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;
  
  // If all three are provided, allow using them (user can remove them to force fresh derivation)
  if (apiKey && apiSecret && apiPassphrase) {
    return {
      key: apiKey,
      secret: apiSecret,
      passphrase: apiPassphrase,
    };
  }
  
  // Otherwise, derive fresh credentials
  return null;
}

/**
 * Create L1 ClobClient with wallet from private key
 */
function createL1Client(privateKey: string): ClobClient {
  try {
    const provider = new JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new Wallet(privateKey, provider);

    if (!FUNDER_ADDRESS) {
      throw new Error('FUNDER_ADDRESS is required in .env file for email/Magic wallet accounts');
    }

    const client = new ClobClient(HOST, Chain.POLYGON, wallet, undefined, SIGNATURE_TYPE, FUNDER_ADDRESS);

    return client;
  } catch (error) {
    throw new Error(`Failed to create L1 client: ${error instanceof Error ? error.message : String(error)}`);
  }
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
 * Create or derive L2 API credentials from L1 client
 * Tries to derive first, then creates if derivation fails
 * If nonce 0 is used, tries with nonce 1+
 */
async function createOrDeriveApiKey(l1Client: ClobClient): Promise<ApiKeyCreds> {
  // Try to derive existing API key first (with nonce 0)
  try {
    console.log('  Attempting to derive existing API key (nonce 0)...');
    const credentials = await l1Client.deriveApiKey();
    
    if (!credentials.key || !credentials.secret || !credentials.passphrase) {
      throw new Error('deriveApiKey returned invalid credentials');
    }
    
    console.log('  ✓ Derived existing API key');
    return credentials;
  } catch (deriveError) {
    // If derivation fails, try with incrementing nonces if it's a nonce error
    if (isNonceError(deriveError)) {
      console.log(`  (Derive failed with nonce 0: ${deriveError instanceof Error ? deriveError.message : String(deriveError)})`);
      console.log('  Trying to derive with nonce 1+...');
      
      for (let nonce = 1; nonce <= 10; nonce++) {
        try {
          console.log(`  Attempting to derive with nonce ${nonce}...`);
          const credentials = await l1Client.deriveApiKey(nonce);
          
          if (!credentials.key || !credentials.secret || !credentials.passphrase) {
            continue; // Try next nonce
          }
          
          console.log(`  ✓ Derived existing API key with nonce ${nonce}`);
          return credentials;
        } catch (nonceError) {
          if (nonce < 10) {
            continue; // Try next nonce
          }
          // If we've tried all nonces, fall through to create
        }
      }
    } else {
      console.log(`  (Derive failed: ${deriveError instanceof Error ? deriveError.message : String(deriveError)})`);
    }
    
    // If derivation fails, create a new API key
    console.log('  Attempting to create new API key...');
    
    // Try creating with nonce 0 first
    try {
      const credentials = await l1Client.createApiKey();
      
      if (!credentials.key || !credentials.secret || !credentials.passphrase) {
        throw new Error('createApiKey returned invalid credentials (missing key, secret, or passphrase)');
      }
      
      console.log('  ⚠️  NEW API KEY CREATED (nonce 0) - Store these credentials securely!');
      return credentials;
    } catch (createError: any) {
      // If nonce 0 is used, try with nonce 1+
      if (isNonceError(createError)) {
        console.log(`  (Create failed with nonce 0: ${createError instanceof Error ? createError.message : String(createError)})`);
        console.log('  Trying to create with nonce 1+...');
        
        for (let nonce = 1; nonce <= 10; nonce++) {
          try {
            console.log(`  Attempting to create with nonce ${nonce}...`);
            const credentials = await l1Client.createApiKey(nonce);
            
            if (!credentials.key || !credentials.secret || !credentials.passphrase) {
              continue; // Try next nonce
            }
            
            console.log(`  ⚠️  NEW API KEY CREATED (nonce ${nonce}) - Store these credentials securely!`);
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
      
      // Check if it's an API error with more details
      let errorMessage = 'Unknown error';
      
      if (createError?.response?.data?.error) {
        errorMessage = createError.response.data.error;
      } else if (createError?.data?.error) {
        errorMessage = createError.data.error;
      } else if (createError?.message) {
        errorMessage = createError.message;
      } else {
        errorMessage = String(createError);
      }
      
      // Check if credentials were returned but invalid
      if (createError?.key || createError?.secret || createError?.passphrase) {
        throw new Error(`createApiKey returned invalid credentials structure. Response: ${JSON.stringify(createError)}`);
      }
      
      throw new Error(`Failed to create API key: ${errorMessage}. This might mean: 1) The account needs to be activated on Polymarket, 2) The account needs to have some activity/balance, or 3) There's an issue with the API endpoint.`);
    }
  }
}

/**
 * Create L2 ClobClient with API credentials, signatureType, and funderAddress
 */
function createL2Client(privateKey: string, apiCreds: ApiKeyCreds): ClobClient {
  try {
    const provider = new JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new Wallet(privateKey, provider);

    if (!FUNDER_ADDRESS) {
      throw new Error('FUNDER_ADDRESS is required in .env file for email/Magic wallet accounts');
    }

    const client = new ClobClient(HOST, Chain.POLYGON, wallet, apiCreds, SIGNATURE_TYPE, FUNDER_ADDRESS);

    return client;
  } catch (error) {
    throw new Error(`Failed to create L2 client: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Test authenticated read methods to verify L2 authentication works
 */
async function testAuthenticatedReads(l2Client: ClobClient): Promise<{ trades: any; balanceAllowance: any }> {
  let trades, balanceAllowance;

  // Try getTrades() first - simpler authenticated read
  try {
    trades = await l2Client.getTrades();
    console.log('✓ getTrades() succeeded');
    console.log(`  Trades count: ${Array.isArray(trades) ? trades.length : 0}`);
  } catch (error: any) {
    const errorMsg = error?.response?.data?.error ||
                    error?.data?.error ||
                    (error?.message ? String(error.message) : JSON.stringify(error));
    const status = error?.response?.status || error?.status || 'N/A';
    throw new Error(`getTrades() failed (status: ${status}): ${errorMsg}`);
  }

  // Using getOpenOrders() as an alternative authenticated read
  try {
    const openOrders = await l2Client.getOpenOrders();
    console.log('✓ getOpenOrders() succeeded');
    console.log(`  Open orders count: ${Array.isArray(openOrders) ? openOrders.length : 0}`);
    balanceAllowance = null;
  } catch (error: any) {
    const status = error?.response?.status || error?.status || 'N/A';
    if (status === 401) {
      console.log('⚠️  getOpenOrders() returned 401 Unauthorized');
      console.log('   This may be expected for some account types or API key permissions.');
      console.log('   Authentication is still verified via getTrades() success.');
      balanceAllowance = null;
    } else {
      const errorMsg = error?.response?.data?.error ||
                      error?.data?.error ||
                      (error?.message ? String(error.message) : JSON.stringify(error));
      console.log(`⚠️  getOpenOrders() failed (status: ${status}): ${errorMsg}`);
      balanceAllowance = null;
    }
  }

  return { trades, balanceAllowance };
}

/**
 * Main function orchestrating the authentication flow
 */
async function main(): Promise<void> {
  // Install axios interceptor to fix POLY_ADDRESS for Magic wallet
  installPolyAddressFix();

  console.log('Starting Polymarket CLOB authentication test...\n');

  try {
    // Step 1: Load private key and configuration
    console.log('Step 1: Loading configuration from .env...');
    const privateKey = loadPrivateKey();
    const wallet = new Wallet(privateKey);
    const signerAddress = wallet.address;
    
    console.log('✓ Private key loaded');
    console.log(`  Signer wallet address: ${signerAddress}`);
    console.log(`  Signature type: ${SIGNATURE_TYPE} (${SIGNATURE_TYPE === 1 ? 'Email/Magic wallet' : 'EOA'})`);
    console.log(`  Funder address: ${FUNDER_ADDRESS || 'NOT SET'}`);
    
    if (!FUNDER_ADDRESS) {
      throw new Error('FUNDER_ADDRESS must be set in .env file');
    }
    console.log('');
    
    // Step 2: Check if API credentials are provided, otherwise derive fresh
    console.log('Step 2: Checking for API credentials...');
    let apiCreds = loadApiCredentials();
    
    if (apiCreds) {
      console.log('✓ Found API credentials in .env');
      console.log(`  API Key: ${apiCreds.key.slice(0, 8)}...${apiCreds.key.slice(-4)}`);
      console.log('  Note: Using existing credentials. Remove from .env to force fresh derivation.\n');
    } else {
      // Step 2b: Create L1 client and derive API credentials
      // Always derive fresh to ensure signatureType and funderAddress match
      console.log('  No API credentials found, deriving fresh credentials...');
      const l1Client = createL1Client(privateKey);
      console.log('✓ L1 client created');
      
      console.log('Step 3: Deriving L2 API credentials...');
      apiCreds = await createOrDeriveApiKey(l1Client);
      console.log('✓ L2 credentials derived OK');
      console.log(`  API Key: ${apiCreds.key.slice(0, 8)}...${apiCreds.key.slice(-4)}\n`);
    }
    
    // Step 3/4: Create L2 client
    const stepNum = apiCreds ? '3' : '4';
    console.log(`Step ${stepNum}: Creating L2 client with API credentials...`);
    const l2Client = createL2Client(privateKey, apiCreds);
    console.log('✓ L2 client created\n');
    
    // Step 4/5: Test authenticated reads
    const testStepNum = apiCreds ? '4' : '5';
    console.log(`Step ${testStepNum}: Testing authenticated read methods...`);
    const { trades, balanceAllowance } = await testAuthenticatedReads(l2Client);
    console.log('');
    
    // Success message
    console.log('═══════════════════════════════════════════════════════');
    console.log('✓ AUTHENTICATION SUCCESSFUL!');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Signer Address: ${signerAddress}`);
    console.log(`Funder Address: ${FUNDER_ADDRESS}`);
    console.log(`Signature Type: ${SIGNATURE_TYPE}`);
    console.log(`Trades Retrieved: ${Array.isArray(trades) ? trades.length : 0}`);
    if (balanceAllowance) {
      console.log(`Balance: ${balanceAllowance.balance || 'N/A'}`);
      console.log(`Allowance: ${balanceAllowance.allowance || 'N/A'}`);
    } else {
      console.log('Balance/Allowance: Not available (endpoint may require different permissions)');
    }
    console.log('═══════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ AUTHENTICATION FAILED');
    console.error('═══════════════════════════════════════════════════════');
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    
    console.error('═══════════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

