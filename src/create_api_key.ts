/**
 * Standalone script to create a new API key programmatically
 * This script will try to create/derive API keys with incrementing nonces
 * Run this to generate fresh API credentials
 */

import * as dotenv from 'dotenv';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, ApiKeyCreds, Chain } from '@polymarket/clob-client';

// Load environment variables
dotenv.config();

// Polymarket CLOB API configuration
const HOST = 'https://clob.polymarket.com';

// Get configuration from environment
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || '1', 10);
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;

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
         lowerMessage.includes('nonce 0') ||
         lowerMessage.includes('invalid l1 request headers');
}

/**
 * Create L1 ClobClient with wallet from private key
 */
function createL1Client(privateKey: string): ClobClient {
  const provider = new JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(privateKey, provider);
  
  if (!FUNDER_ADDRESS) {
    throw new Error('FUNDER_ADDRESS is required in .env file');
  }
  
  return new ClobClient(HOST, Chain.POLYGON, wallet, undefined, SIGNATURE_TYPE, FUNDER_ADDRESS);
}

/**
 * Try to derive API key with a specific nonce
 */
async function tryDeriveApiKey(l1Client: ClobClient, nonce: number): Promise<ApiKeyCreds | null> {
  try {
    console.log(`  Attempting to derive API key with nonce ${nonce}...`);
    const credentials = await l1Client.deriveApiKey(nonce);
    
    if (!credentials.key || !credentials.secret || !credentials.passphrase) {
      return null;
    }
    
    console.log(`  ✓ Successfully derived API key with nonce ${nonce}`);
    return credentials;
  } catch (error: any) {
    const errorMsg = error?.response?.data?.error || 
                    error?.data?.error || 
                    error?.message || 
                    String(error);
    console.log(`  ✗ Derive failed with nonce ${nonce}: ${errorMsg.substring(0, 100)}`);
    return null;
  }
}

/**
 * Try to create API key with a specific nonce
 */
async function tryCreateApiKey(l1Client: ClobClient, nonce: number): Promise<ApiKeyCreds | null> {
  try {
    console.log(`  Attempting to create API key with nonce ${nonce}...`);
    const credentials = await l1Client.createApiKey(nonce);
    
    if (!credentials.key || !credentials.secret || !credentials.passphrase) {
      return null;
    }
    
    console.log(`  ✓ Successfully created API key with nonce ${nonce}`);
    return credentials;
  } catch (error: any) {
    const errorMsg = error?.response?.data?.error || 
                    error?.data?.error || 
                    error?.message || 
                    String(error);
    console.log(`  ✗ Create failed with nonce ${nonce}: ${errorMsg.substring(0, 100)}`);
    return null;
  }
}

/**
 * Main function to create/derive API key
 */
async function createApiKey(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('API Key Creation Script');
  console.log('═══════════════════════════════════════════════════════\n');
  
  try {
    // Step 1: Load configuration
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
    
    // Step 2: Create L1 client
    console.log('Step 2: Creating L1 client...');
    const l1Client = createL1Client(privateKey);
    console.log('✓ L1 client created\n');
    
    // Step 3: Try to derive existing API key (starting with nonce 0)
    console.log('Step 3: Attempting to derive existing API key...');
    let apiCreds: ApiKeyCreds | null = null;
    
    // Try nonce 0 first
    apiCreds = await tryDeriveApiKey(l1Client, 0);
    
    // If nonce 0 fails, try nonces 1-10
    if (!apiCreds) {
      console.log('  Nonce 0 failed, trying nonces 1-10...');
      for (let nonce = 1; nonce <= 10; nonce++) {
        apiCreds = await tryDeriveApiKey(l1Client, nonce);
        if (apiCreds) {
          break;
        }
      }
    }
    
    // Step 4: If derivation failed, try to create a new API key
    if (!apiCreds) {
      console.log('\nStep 4: Derivation failed, attempting to create new API key...');
      
      // Try nonce 0 first
      apiCreds = await tryCreateApiKey(l1Client, 0);
      
      // If nonce 0 fails, try nonces 1-10
      if (!apiCreds) {
        console.log('  Nonce 0 failed, trying nonces 1-10...');
        for (let nonce = 1; nonce <= 10; nonce++) {
          apiCreds = await tryCreateApiKey(l1Client, nonce);
          if (apiCreds) {
            break;
          }
        }
      }
    }
    
    // Step 5: Output results
    console.log('\n═══════════════════════════════════════════════════════');
    if (apiCreds) {
      console.log('✓ API KEY SUCCESSFULLY CREATED/DERIVED!');
      console.log('═══════════════════════════════════════════════════════');
      console.log('\nAdd these to your .env file:\n');
      console.log(`API_KEY=${apiCreds.key}`);
      console.log(`API_SECRET=${apiCreds.secret}`);
      console.log(`API_PASSPHRASE=${apiCreds.passphrase}`);
      console.log('\n═══════════════════════════════════════════════════════\n');
    } else {
      console.log('✗ FAILED TO CREATE/DERIVE API KEY');
      console.log('═══════════════════════════════════════════════════════');
      console.log('\nPossible reasons:');
      console.log('1. Account needs to be activated on Polymarket');
      console.log('2. Account needs to have some activity/balance');
      console.log('3. All nonces (0-10) are already used');
      console.log('4. There\'s an issue with the API endpoint');
      console.log('5. FUNDER_ADDRESS doesn\'t match your Polymarket profile');
      console.log('\nTry:');
      console.log('- Verify your FUNDER_ADDRESS matches your Polymarket profile');
      console.log('- Generate API key manually from Polymarket UI');
      console.log('- Check if your account is activated and has balance');
      console.log('\n═══════════════════════════════════════════════════════\n');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('✗ ERROR');
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

// Run the script
createApiKey().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

