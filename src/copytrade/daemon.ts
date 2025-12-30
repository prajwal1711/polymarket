/**
 * Copytrade Daemon - Continuous polling mode
 *
 * Runs continuously, polling target wallets for new trades
 * and copying them automatically.
 *
 * Usage:
 *   npm run copytrade:daemon              # Run with default settings (10s poll)
 *   npm run copytrade:daemon -- --dry-run # Dry run mode
 *   POLL_INTERVAL=60 npm run copytrade:daemon  # Poll every 60 seconds
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Copier } from './copier';
import { CopytradeStorage } from './storage';
import { CopytradeConfig } from './types';
import { ApiKeyCreds } from '@polymarket/clob-client';
import { PolymarketDataApi } from './data-api';

// Default target wallet
const DEFAULT_TARGET = '0x063aeee10fbfd55b6def10da28e87a601e7deb4b';

// Configuration from environment
const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL || '10', 10); // Default: 10 seconds
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_TRADE_AGE_MIN = parseInt(process.env.MAX_TRADE_AGE || '60', 10); // Default: 60 minutes
const RECONCILE_INTERVAL_SEC = parseInt(process.env.RECONCILE_INTERVAL || '300', 10); // Default: 5 minutes

interface DaemonStats {
  startTime: Date;
  pollCount: number;
  tradesFound: number;
  tradesCopied: number;
  tradesSkipped: number;
  tradesFailed: number;
  totalCost: number;
  errors: number;
  lastPollTime: Date | null;
  lastError: string | null;
  // Reconciliation stats
  reconcileCount: number;
  positionsSettled: number;
  lastReconcileTime: Date | null;
}

function loadCredentials(): {
  privateKey: string;
  apiCreds: ApiKeyCreds;
  signatureType: number;
  funderAddress: string;
} | null {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('PRIVATE_KEY not set in .env');
    return null;
  }

  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;
  const apiPassphrase = process.env.API_PASSPHRASE;
  if (!apiKey || !apiSecret || !apiPassphrase) {
    console.error('API_KEY, API_SECRET, and API_PASSPHRASE must be set in .env');
    return null;
  }

  const funderAddress = process.env.FUNDER_ADDRESS;
  if (!funderAddress) {
    console.error('FUNDER_ADDRESS not set in .env');
    return null;
  }

  const signatureType = parseInt(process.env.SIGNATURE_TYPE || '1', 10);

  return {
    privateKey,
    apiCreds: { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    signatureType,
    funderAddress,
  };
}

function formatUptime(startTime: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - startTime.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

function printBanner(): void {
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         POLYMARKET COPYTRADE DAEMON                   ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
}

function printStatus(stats: DaemonStats, targets: string[]): void {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ DAEMON STATUS                                           │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  Mode:         ${DRY_RUN ? 'DRY RUN (no real orders)' : 'LIVE'}`.padEnd(58) + '│');
  console.log(`│  Poll interval: ${POLL_INTERVAL_SEC} seconds`.padEnd(58) + '│');
  console.log(`│  Reconcile:     every ${RECONCILE_INTERVAL_SEC} seconds`.padEnd(58) + '│');
  console.log(`│  Max trade age: ${MAX_TRADE_AGE_MIN} minutes`.padEnd(58) + '│');
  console.log(`│  Targets:       ${targets.length}`.padEnd(58) + '│');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  Uptime:        ${formatUptime(stats.startTime)}`.padEnd(58) + '│');
  console.log(`│  Polls:         ${stats.pollCount}`.padEnd(58) + '│');
  console.log(`│  Trades found:  ${stats.tradesFound}`.padEnd(58) + '│');
  console.log(`│  Copied:        ${stats.tradesCopied}`.padEnd(58) + '│');
  console.log(`│  Skipped:       ${stats.tradesSkipped}`.padEnd(58) + '│');
  console.log(`│  Failed:        ${stats.tradesFailed}`.padEnd(58) + '│');
  console.log(`│  Total cost:    $${stats.totalCost.toFixed(2)}`.padEnd(58) + '│');
  console.log(`│  Errors:        ${stats.errors}`.padEnd(58) + '│');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  Reconciles:    ${stats.reconcileCount}`.padEnd(58) + '│');
  console.log(`│  Settled:       ${stats.positionsSettled} positions`.padEnd(58) + '│');
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

async function runDaemon(): Promise<void> {
  printBanner();

  // Safety check
  if (!DRY_RUN && process.env.CONFIRM !== 'YES_TO_COPYTRADE') {
    console.log('═══════════════════════════════════════════════════════');
    console.log('DAEMON BLOCKED - Live mode requires confirmation');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log('To run in live mode:');
    console.log('  CONFIRM=YES_TO_COPYTRADE npm run copytrade:daemon');
    console.log('');
    console.log('To run in dry-run mode (no real orders):');
    console.log('  npm run copytrade:daemon -- --dry-run');
    console.log('');
    process.exit(1);
  }

  // Load credentials
  const creds = DRY_RUN ? null : loadCredentials();
  if (!DRY_RUN && !creds) {
    process.exit(1);
  }

  // Build config
  const config: Partial<CopytradeConfig> = {
    dryRun: DRY_RUN,
    maxTradeAgeMs: MAX_TRADE_AGE_MIN * 60 * 1000,
    pollIntervalMs: POLL_INTERVAL_SEC * 1000,
  };

  // Initialize copier
  const copier = new Copier(config);
  const storage = new CopytradeStorage();

  // Initialize client if live mode
  if (!DRY_RUN && creds) {
    console.log('Initializing CLOB client...');
    await copier.initClient(
      creds.privateKey,
      creds.apiCreds,
      creds.signatureType,
      creds.funderAddress
    );
    console.log('Client initialized.\n');
  }

  // Ensure we have at least one target
  let targets = storage.getTargets(true);
  if (targets.length === 0) {
    console.log(`No targets configured. Adding default: ${DEFAULT_TARGET}`);
    storage.addTarget(DEFAULT_TARGET, 'default');
    targets = storage.getTargets(true);
  }

  // Initialize stats
  const stats: DaemonStats = {
    startTime: new Date(),
    pollCount: 0,
    tradesFound: 0,
    tradesCopied: 0,
    tradesSkipped: 0,
    tradesFailed: 0,
    totalCost: 0,
    errors: 0,
    lastPollTime: null,
    lastError: null,
    reconcileCount: 0,
    positionsSettled: 0,
    lastReconcileTime: null,
  };

  // Print initial status
  printStatus(stats, targets.map(t => t.address));

  // Initialize data API for reconciliation
  const dataApi = new PolymarketDataApi();
  const funderAddress = creds?.funderAddress || process.env.FUNDER_ADDRESS || '';

  // Reconciliation function - checks for settled positions
  async function reconcileSettledPositions(): Promise<number> {
    if (!funderAddress) {
      console.log('  [Reconcile] No funder address configured, skipping');
      return 0;
    }

    try {
      // Get our open positions from internal DB
      const internalPositions = storage.getAllOpenPositionTokenIds();
      if (internalPositions.length === 0) {
        console.log('  [Reconcile] No open positions to reconcile');
        return 0;
      }

      // Get actual positions from Polymarket
      const actualPositions = await dataApi.getPositionsForWallet(funderAddress);
      const actualTokenIds = new Set(actualPositions.map(p => p.asset));

      let settledCount = 0;

      // Check each internal position
      for (const internal of internalPositions) {
        // If position exists on Polymarket, it's still open
        if (actualTokenIds.has(internal.tokenId)) {
          continue;
        }

        // Position is gone from Polymarket - likely settled
        console.log(`  [Reconcile] Position settled: ${internal.tokenId.substring(0, 16)}...`);
        console.log(`    Shares: ${internal.shares.toFixed(4)}, Cost: $${internal.totalCost.toFixed(2)}`);

        // For MVP: assume worst case (lost) if we can't determine outcome
        // A more sophisticated version would query market resolution status
        // Settlement price: 0 = lost everything, 1 = won (shares worth $1 each)
        // For now, we check if there's any USDC credit that appeared (future enhancement)
        // MVP approach: mark as settled with 0 (conservative)
        const settlementPrice = 0; // Conservative: assume loss

        const result = storage.closePositionAsSettled({
          targetAddress: internal.targetAddress,
          tokenId: internal.tokenId,
          settlementPrice,
        });

        if (result.success && result.position) {
          console.log(`    Closed as settled. PnL: $${result.position.pnl.toFixed(2)}`);
          settledCount++;
        }
      }

      if (settledCount > 0) {
        console.log(`  [Reconcile] Settled ${settledCount} position(s)`);
      } else {
        console.log('  [Reconcile] All positions still active');
      }

      return settledCount;
    } catch (error: any) {
      console.error(`  [Reconcile] Error: ${error.message}`);
      return 0;
    }
  }

  console.log('Starting polling loop...');
  console.log(`Press Ctrl+C to stop\n`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Handle graceful shutdown
  let running = true;
  let lastReconcileTime = 0; // Track last reconcile time in seconds since start
  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT. Shutting down gracefully...');
    running = false;
  });
  process.on('SIGTERM', () => {
    console.log('\n\nReceived SIGTERM. Shutting down gracefully...');
    running = false;
  });

  // Main polling loop
  while (running) {
    stats.pollCount++;
    stats.lastPollTime = new Date();
    const pollTime = stats.lastPollTime.toISOString().replace('T', ' ').substring(0, 19);

    console.log(`[${pollTime}] Poll #${stats.pollCount}`);

    // Refresh targets list in case it changed
    targets = storage.getTargets(true);

    for (const target of targets) {
      try {
        const result = await copier.copyFromTarget(target.address);

        // Update stats
        stats.tradesFound += result.run.tradesFound;
        stats.tradesCopied += result.run.tradesCopied;
        stats.tradesSkipped += result.run.tradesSkipped;
        stats.tradesFailed += result.run.tradesFailed;
        stats.totalCost += result.run.totalCost;

      } catch (error: any) {
        stats.errors++;
        stats.lastError = error.message;
        console.error(`  Error copying from ${target.address}: ${error.message}`);

        // If Cloudflare block, log prominently
        if (error.message?.includes('blocked') || error.message?.includes('403')) {
          console.error('  ⚠️  Cloudflare block detected - may need proxy');
        }
      }
    }

    // Run reconciliation if interval has passed
    const elapsedSec = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
    if (elapsedSec - lastReconcileTime >= RECONCILE_INTERVAL_SEC) {
      console.log(`\n[${new Date().toISOString().replace('T', ' ').substring(0, 19)}] Running reconciliation...`);
      const settled = await reconcileSettledPositions();
      stats.reconcileCount++;
      stats.positionsSettled += settled;
      stats.lastReconcileTime = new Date();
      lastReconcileTime = elapsedSec;
    }

    // Print periodic status update every 10 polls
    if (stats.pollCount % 10 === 0) {
      console.log('\n');
      printStatus(stats, targets.map(t => t.address));
    }

    // Wait for next poll
    if (running) {
      console.log(`\nNext poll in ${POLL_INTERVAL_SEC} seconds...\n`);
      console.log('───────────────────────────────────────────────────────\n');

      // Sleep with interrupt check
      for (let i = 0; i < POLL_INTERVAL_SEC && running; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // Cleanup
  console.log('\nFinal stats:');
  printStatus(stats, targets.map(t => t.address));

  copier.close();
  storage.close();
  console.log('Daemon stopped.\n');
}

// Run the daemon
runDaemon().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
