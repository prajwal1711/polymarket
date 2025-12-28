/**
 * Copytrade entry point
 *
 * Usage:
 *   npm run copytrade                    # Run with default target
 *   npm run copytrade -- --dry-run       # Dry run (no actual orders)
 *   npm run copytrade -- --target 0x...  # Copy from specific address
 *   npm run copytrade -- --add-target 0x... --alias "whale"  # Add target
 *   npm run copytrade -- --list-targets  # List all targets
 *   npm run copytrade -- --stats         # Show statistics
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Copier } from './copier';
import { CopytradeStorage } from './storage';
import { CopytradeConfig, DEFAULT_CONFIG } from './types';
import { ApiKeyCreds } from '@polymarket/clob-client';

// Default target wallet
const DEFAULT_TARGET = '0x063aeee10fbfd55b6def10da28e87a601e7deb4b';

interface CliArgs {
  command: 'run' | 'add-target' | 'remove-target' | 'list-targets' | 'stats' | 'history';
  target?: string;
  alias?: string;
  dryRun: boolean;
  maxCost?: number;
  maxTrades?: number;
  copySide?: 'BUY' | 'SELL' | 'BOTH';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    command: 'run',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--target':
        result.target = args[++i];
        break;
      case '--add-target':
        result.command = 'add-target';
        result.target = args[++i];
        break;
      case '--remove-target':
        result.command = 'remove-target';
        result.target = args[++i];
        break;
      case '--alias':
        result.alias = args[++i];
        break;
      case '--list-targets':
        result.command = 'list-targets';
        break;
      case '--stats':
        result.command = 'stats';
        break;
      case '--history':
        result.command = 'history';
        break;
      case '--max-cost':
        result.maxCost = parseFloat(args[++i]);
        break;
      case '--max-trades':
        result.maxTrades = parseInt(args[++i], 10);
        break;
      case '--copy-side':
        result.copySide = args[++i].toUpperCase() as 'BUY' | 'SELL' | 'BOTH';
        break;
    }
  }

  return result;
}

function loadCredentials(): {
  privateKey: string;
  apiCreds: ApiKeyCreds;
  signatureType: number;
  funderAddress: string;
} {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');
  if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
    throw new Error('PRIVATE_KEY must be 66 characters starting with 0x');
  }

  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error('API_KEY, API_SECRET, and API_PASSPHRASE must be set in .env');
  }

  const funderAddress = process.env.FUNDER_ADDRESS;
  if (!funderAddress) throw new Error('FUNDER_ADDRESS not set in .env');

  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '1', 10);

  return {
    privateKey,
    apiCreds: { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    signatureType,
    funderAddress,
  };
}

async function handleListTargets(): Promise<void> {
  const storage = new CopytradeStorage();
  try {
    const targets = storage.getTargets(false); // Get all, not just enabled

    console.log('\nCopytrade Targets');
    console.log('═══════════════════════════════════════════════════════');

    if (targets.length === 0) {
      console.log('  No targets configured.');
      console.log(`  Add one with: npm run copytrade -- --add-target ${DEFAULT_TARGET}`);
    } else {
      for (const target of targets) {
        const status = target.enabled ? '[ENABLED]' : '[DISABLED]';
        const alias = target.alias ? ` (${target.alias})` : '';
        console.log(`  ${status} ${target.address}${alias}`);
      }
    }

    console.log('═══════════════════════════════════════════════════════\n');
  } finally {
    storage.close();
  }
}

async function handleAddTarget(address: string, alias?: string): Promise<void> {
  const storage = new CopytradeStorage();
  try {
    storage.addTarget(address, alias);
    console.log(`\nAdded target: ${address}${alias ? ` (${alias})` : ''}\n`);
  } finally {
    storage.close();
  }
}

async function handleRemoveTarget(address: string): Promise<void> {
  const storage = new CopytradeStorage();
  try {
    storage.removeTarget(address);
    console.log(`\nRemoved target: ${address}\n`);
  } finally {
    storage.close();
  }
}

async function handleStats(): Promise<void> {
  const storage = new CopytradeStorage();
  try {
    const stats = storage.getStats();
    const recentRuns = storage.getRuns(5);

    console.log('\nCopytrade Statistics');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Targets:         ${stats.totalTargets}`);
    console.log(`  Total runs:      ${stats.totalRuns}`);
    console.log(`  Trades copied:   ${stats.totalTradesCopied}`);
    console.log(`  Total cost:      $${stats.totalCost.toFixed(2)}`);
    console.log(`  Success rate:    ${stats.successRate.toFixed(1)}%`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (recentRuns.length > 0) {
      console.log('Recent Runs:');
      console.log('─────────────────────────────────────────────────────────');
      for (const run of recentRuns) {
        const date = new Date(run.startedAt).toLocaleString();
        console.log(`  ${date} | ${run.targetAddress.substring(0, 10)}... | Copied: ${run.tradesCopied}, Skipped: ${run.tradesSkipped}, Cost: $${run.totalCost.toFixed(2)}`);
      }
      console.log('─────────────────────────────────────────────────────────\n');
    }
  } finally {
    storage.close();
  }
}

async function handleHistory(): Promise<void> {
  const storage = new CopytradeStorage();
  try {
    const trades = storage.getCopiedTrades({ limit: 20 });

    console.log('\nRecent Copied Trades');
    console.log('═══════════════════════════════════════════════════════');

    if (trades.length === 0) {
      console.log('  No trades copied yet.');
    } else {
      for (const trade of trades) {
        const date = new Date(trade.createdAt).toLocaleString();
        const status = trade.status.toUpperCase().padEnd(7);
        const side = trade.side.padEnd(4);
        const cost = trade.copyCost ? `$${trade.copyCost.toFixed(4)}` : 'N/A';
        console.log(`  ${date} | ${status} | ${side} | ${cost} | ${trade.skipReason || trade.orderId?.substring(0, 12) || ''}`);
      }
    }

    console.log('═══════════════════════════════════════════════════════\n');
  } finally {
    storage.close();
  }
}

async function handleRun(args: CliArgs): Promise<void> {
  // Check confirmation if not dry run
  if (!args.dryRun && process.env.CONFIRM !== 'YES_TO_COPYTRADE') {
    console.error('\n═══════════════════════════════════════════════════════');
    console.error('COPYTRADE BLOCKED');
    console.error('═══════════════════════════════════════════════════════');
    console.error('Set CONFIRM=YES_TO_COPYTRADE to place real orders.');
    console.error('Or use --dry-run to simulate without placing orders.');
    console.error('═══════════════════════════════════════════════════════\n');
    process.exit(1);
  }

  // Build config
  const config: Partial<CopytradeConfig> = {
    dryRun: args.dryRun,
    requireConfirmation: !args.dryRun,
  };

  if (args.maxCost !== undefined) {
    config.maxCostPerTrade = args.maxCost;
    config.maxTotalCostPerRun = args.maxCost * 5; // 5x single trade limit per run
  }
  if (args.maxTrades !== undefined) {
    config.maxTradesPerRun = args.maxTrades;
  }
  if (args.copySide !== undefined) {
    config.copySide = args.copySide;
  }

  const copier = new Copier(config);

  try {
    // Initialize client if not dry run
    if (!args.dryRun) {
      console.log('Initializing CLOB client...');
      const creds = loadCredentials();
      await copier.initClient(
        creds.privateKey,
        creds.apiCreds,
        creds.signatureType,
        creds.funderAddress
      );
      console.log('Client initialized.\n');
    }

    // Determine target
    let targetAddress = args.target;

    if (!targetAddress) {
      // Check if we have any targets in storage
      const storage = copier.getStorage();
      const targets = storage.getTargets(true);

      if (targets.length > 0) {
        // Use first enabled target
        targetAddress = targets[0].address;
      } else {
        // Add and use default target
        console.log(`No targets configured. Adding default: ${DEFAULT_TARGET}\n`);
        storage.addTarget(DEFAULT_TARGET, 'default');
        targetAddress = DEFAULT_TARGET;
      }
    }

    // Run copytrade
    const result = await copier.copyFromTarget(targetAddress);

    // Exit with appropriate code
    if (result.run.tradesFailed > 0 && result.run.tradesCopied === 0) {
      process.exit(1);
    }

  } catch (error: any) {
    console.error(`\nError: ${error.message}\n`);
    process.exit(1);
  } finally {
    copier.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║              POLYMARKET COPYTRADE BOT                 ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  switch (args.command) {
    case 'list-targets':
      await handleListTargets();
      break;

    case 'add-target':
      if (!args.target) {
        console.error('Error: --add-target requires an address');
        process.exit(1);
      }
      await handleAddTarget(args.target, args.alias);
      break;

    case 'remove-target':
      if (!args.target) {
        console.error('Error: --remove-target requires an address');
        process.exit(1);
      }
      await handleRemoveTarget(args.target);
      break;

    case 'stats':
      await handleStats();
      break;

    case 'history':
      await handleHistory();
      break;

    case 'run':
    default:
      await handleRun(args);
      break;
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
