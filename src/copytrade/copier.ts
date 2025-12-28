/**
 * Main copytrading logic with guardrails
 */

import { v4 as uuidv4 } from 'uuid';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ClobClient, ApiKeyCreds, Side, Chain } from '@polymarket/clob-client';
import axios from 'axios';

import { PolymarketDataApi, DataApiTrade } from './data-api';
import { CopytradeStorage } from './storage';
import { CopiedTrade, CopytradeConfig, CopytradeRun, DEFAULT_CONFIG } from './types';

const CLOB_HOST = 'https://clob.polymarket.com';

export interface CopyResult {
  run: CopytradeRun;
  trades: CopiedTrade[];
}

export class Copier {
  private config: CopytradeConfig;
  private dataApi: PolymarketDataApi;
  private storage: CopytradeStorage;
  private l2Client: ClobClient | null = null;

  constructor(config: Partial<CopytradeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataApi = new PolymarketDataApi();
    this.storage = new CopytradeStorage();
  }

  /**
   * Initialize the CLOB client for order placement
   */
  async initClient(
    privateKey: string,
    apiCreds: ApiKeyCreds,
    signatureType: number = 1,
    funderAddress?: string
  ): Promise<void> {
    const provider = new JsonRpcProvider('https://polygon-rpc.com');
    const wallet = new Wallet(privateKey, provider);

    this.l2Client = new ClobClient(
      CLOB_HOST,
      Chain.POLYGON,
      wallet,
      apiCreds,
      signatureType,
      funderAddress
    );

    // Install axios interceptor for Magic wallet
    if (signatureType === 1 && funderAddress) {
      axios.interceptors.request.use((reqConfig) => {
        if (reqConfig.headers?.['POLY_ADDRESS'] && reqConfig.headers?.['POLY_API_KEY']) {
          reqConfig.headers['POLY_ADDRESS'] = funderAddress;
        }
        return reqConfig;
      });
    }
  }

  /**
   * Run copytrading for a single target wallet
   */
  async copyFromTarget(targetAddress: string): Promise<CopyResult> {
    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    const copiedTrades: CopiedTrade[] = [];

    const run: CopytradeRun = {
      id: runId,
      startedAt,
      completedAt: null,
      targetAddress,
      tradesFound: 0,
      tradesNew: 0,
      tradesCopied: 0,
      tradesSkipped: 0,
      tradesFailed: 0,
      totalCost: 0,
    };

    console.log(`\nCopytrade run: ${runId}`);
    console.log(`Target: ${targetAddress}`);

    // Check current exposure for this target
    const currentExposure = this.storage.getTotalExposure(targetAddress);
    const remainingBudget = this.config.maxExposurePerTarget - currentExposure;
    console.log(`Current exposure: $${currentExposure.toFixed(2)} / $${this.config.maxExposurePerTarget.toFixed(2)} max`);
    console.log(`Remaining budget: $${remainingBudget.toFixed(2)}`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (remainingBudget <= 0) {
      console.log('  Max exposure reached for this target. Skipping.\n');
      run.completedAt = new Date().toISOString();
      this.storage.saveRun(run);
      return { run, trades: copiedTrades };
    }

    try {
      // Step 1: Fetch recent trades from target
      console.log('Step 1: Fetching recent trades from target...');
      const trades = await this.dataApi.getAllRecentTrades(targetAddress, {
        maxAgeMs: this.config.maxTradeAgeMs,
        maxTrades: 100,
      });
      run.tradesFound = trades.length;
      console.log(`  Found ${trades.length} trades in the last ${this.config.maxTradeAgeMs / 60000} minutes\n`);

      if (trades.length === 0) {
        console.log('  No trades to process.\n');
        run.completedAt = new Date().toISOString();
        this.storage.saveRun(run);
        return { run, trades: copiedTrades };
      }

      // Step 2: Filter to new trades only
      console.log('Step 2: Filtering to new trades...');
      const newTrades = trades.filter(trade => {
        // Use transaction hash as unique ID
        return !this.storage.hasProcessedTradeByTxHash(trade.transactionHash);
      });
      run.tradesNew = newTrades.length;
      console.log(`  ${newTrades.length} new trades (${trades.length - newTrades.length} already processed)\n`);

      if (newTrades.length === 0) {
        console.log('  No new trades to copy.\n');
        run.completedAt = new Date().toISOString();
        this.storage.saveRun(run);
        return { run, trades: copiedTrades };
      }

      // Step 3: Apply guardrails and filter
      console.log('Step 3: Applying guardrails...');
      const validTrades = this.applyGuardrails(newTrades);
      console.log(`  ${validTrades.candidates.length} trades pass guardrails`);
      console.log(`  ${validTrades.skipped.length} trades skipped`);

      // Log and record skipped trades
      if (validTrades.skipped.length > 0) {
        console.log('\n  Skipped trades:');
        console.log('  ─────────────────────────────────────────────────────');
        for (const { trade, reason } of validTrades.skipped) {
          const marketTitle = trade.title?.substring(0, 40) || trade.conditionId.substring(0, 20);
          console.log(`  SKIP [${trade.side}] ${marketTitle}...`);
          console.log(`        Reason: ${reason}`);

          const skippedRecord: CopiedTrade = this.createTradeRecord(trade, targetAddress);
          skippedRecord.status = 'skipped';
          skippedRecord.skipReason = reason;
          this.storage.saveCopiedTrade(skippedRecord);
          copiedTrades.push(skippedRecord);
          run.tradesSkipped++;
        }
        console.log('  ─────────────────────────────────────────────────────');
      }
      console.log('');

      // Step 4: Copy valid trades
      if (validTrades.candidates.length > 0) {
        console.log('Step 4: Copying trades...');
        console.log('─────────────────────────────────────────────────────────');

        let totalCostSoFar = 0;
        let tradesCopiedCount = 0;

        for (const trade of validTrades.candidates) {
          // Check if we've hit limits (only for BUYs - SELLs don't cost us money)
          if (trade.side === 'BUY') {
            if (tradesCopiedCount >= this.config.maxTradesPerRun) {
              console.log(`\n  Reached max trades per run (${this.config.maxTradesPerRun})`);
              break;
            }
            if (totalCostSoFar >= this.config.maxTotalCostPerRun) {
              console.log(`\n  Reached max cost per run ($${this.config.maxTotalCostPerRun})`);
              break;
            }
            if (currentExposure + totalCostSoFar >= this.config.maxExposurePerTarget) {
              console.log(`\n  Reached max exposure for target ($${this.config.maxExposurePerTarget})`);
              break;
            }
          }

          const tradeRecord = this.createTradeRecord(trade, targetAddress);

          // ============ HANDLE SELL (EXIT) SIGNALS ============
          if (trade.side === 'SELL') {
            // Check if we have an open position in this token
            const position = this.storage.getOpenPosition(targetAddress, trade.asset);

            if (!position) {
              // We don't hold this token - skip
              console.log(`  SKIP SELL: No position in ${trade.title?.substring(0, 40)}...`);
              tradeRecord.status = 'skipped';
              tradeRecord.skipReason = 'No position to sell (we never copied the original BUY)';
              this.storage.saveCopiedTrade(tradeRecord);
              copiedTrades.push(tradeRecord);
              run.tradesSkipped++;
              continue;
            }

            // We have a position - sell it all
            const sellSize = position.shares;
            const sellProceeds = sellSize * trade.price;
            const pnl = sellProceeds - position.totalCost;

            tradeRecord.copySize = sellSize;
            tradeRecord.copyPrice = trade.price;
            tradeRecord.copyCost = -sellProceeds; // Negative cost = proceeds

            if (this.config.dryRun) {
              const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
              console.log(`  [DRY RUN] Would SELL: ${sellSize.toFixed(1)} shares @ $${trade.price}`);
              console.log(`    Market: ${trade.title?.substring(0, 50)}...`);
              console.log(`    Entry: $${position.avgEntryPrice.toFixed(3)} → Exit: $${trade.price.toFixed(3)}`);
              console.log(`    Proceeds: $${sellProceeds.toFixed(2)} | PnL: ${pnlStr}`);
              tradeRecord.status = 'skipped';
              tradeRecord.skipReason = 'Dry run mode';
              run.tradesSkipped++;
            } else {
              // Actually place the SELL order
              const result = await this.placeSellOrder(trade.asset, sellSize, trade.price);
              if (result.success) {
                // Close the position in our tracking
                this.storage.closePosition({
                  targetAddress,
                  tokenId: trade.asset,
                  exitPrice: trade.price,
                  exitProceeds: sellProceeds,
                });

                tradeRecord.status = 'placed';
                tradeRecord.orderId = result.orderId || null;
                tradeRecord.executedAt = new Date().toISOString();
                tradesCopiedCount++;
                run.tradesCopied++;
                const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
                console.log(`  SOLD: ${sellSize.toFixed(1)} shares @ $${trade.price} | PnL: ${pnlStr}`);
              } else {
                tradeRecord.status = 'failed';
                tradeRecord.skipReason = result.error || null;
                run.tradesFailed++;
                console.log(`  SELL FAILED: ${result.error?.substring(0, 50)}`);
              }
            }

            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            continue;
          }

          // ============ HANDLE BUY SIGNALS ============
          // Calculate copy size
          const copySize = this.calculateCopySize(trade);
          const copyCost = copySize * trade.price;

          // Check cost guardrails
          if (copyCost > this.config.maxCostPerTrade) {
            console.log(`  SKIP: Cost $${copyCost.toFixed(4)} > max $${this.config.maxCostPerTrade}`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = `Cost ${copyCost.toFixed(4)} exceeds max ${this.config.maxCostPerTrade}`;
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          if (totalCostSoFar + copyCost > this.config.maxTotalCostPerRun) {
            console.log(`  SKIP: Would exceed run cost limit`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Would exceed run cost limit';
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          if (currentExposure + totalCostSoFar + copyCost > this.config.maxExposurePerTarget) {
            console.log(`  SKIP: Would exceed target exposure limit ($${this.config.maxExposurePerTarget})`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Would exceed target exposure limit';
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          tradeRecord.copySize = copySize;
          tradeRecord.copyPrice = trade.price;
          tradeRecord.copyCost = copyCost;

          // Execute the copy (or dry run)
          if (this.config.dryRun) {
            console.log(`  [DRY RUN] Would BUY: ${copySize} shares @ $${trade.price}`);
            console.log(`    Market: ${trade.title?.substring(0, 50)}...`);
            console.log(`    Cost: $${copyCost.toFixed(4)}`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Dry run mode';
            run.tradesSkipped++;
          } else {
            // Actually place the order
            const result = await this.placeOrder(trade, copySize);
            if (result.success) {
              // Track the position
              this.storage.openOrAddPosition({
                id: tradeRecord.id,
                targetAddress,
                tokenId: trade.asset,
                conditionId: trade.conditionId,
                shares: copySize,
                price: trade.price,
                cost: copyCost,
              });

              tradeRecord.status = 'placed';
              tradeRecord.orderId = result.orderId || null;
              tradeRecord.executedAt = new Date().toISOString();
              totalCostSoFar += copyCost;
              tradesCopiedCount++;
              run.tradesCopied++;
              run.totalCost += copyCost;
              console.log(`  BOUGHT: ${copySize} shares @ $${trade.price} = $${copyCost.toFixed(2)} (Order: ${result.orderId?.substring(0, 12)}...)`);
            } else {
              tradeRecord.status = 'failed';
              tradeRecord.skipReason = result.error || null;
              run.tradesFailed++;
              console.log(`  BUY FAILED: ${result.error?.substring(0, 50)}`);
            }
          }

          this.storage.saveCopiedTrade(tradeRecord);
          copiedTrades.push(tradeRecord);

          // Rate limiting delay between orders
          if (!this.config.dryRun) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        console.log('─────────────────────────────────────────────────────────\n');
      }

      // Update cursor to latest trade
      if (trades.length > 0) {
        const latestTrade = trades[0];
        this.storage.setCursor(targetAddress, latestTrade.timestamp, latestTrade.transactionHash);
      }

    } catch (error: any) {
      console.error(`Error during copytrade: ${error.message}`);
      run.tradesFailed++;
    }

    run.completedAt = new Date().toISOString();
    this.storage.saveRun(run);

    // Print summary
    this.printSummary(run);

    return { run, trades: copiedTrades };
  }

  /**
   * Apply guardrails to filter trades
   */
  private applyGuardrails(trades: DataApiTrade[]): {
    candidates: DataApiTrade[];
    skipped: Array<{ trade: DataApiTrade; reason: string }>;
  } {
    const candidates: DataApiTrade[] = [];
    const skipped: Array<{ trade: DataApiTrade; reason: string }> = [];

    for (const trade of trades) {
      // ============ SELL SIGNAL HANDLING ============
      // SELLs are exit signals - handle them differently
      if (trade.side === 'SELL') {
        // Only process SELLs if copyExits is enabled
        if (!this.config.copyExits) {
          skipped.push({ trade, reason: 'copyExits disabled' });
          continue;
        }

        // For SELLs, check if we have a position to exit
        // (actual position check happens in the copy loop)
        // Price filters DON'T apply to exits - we want to exit when they exit
        candidates.push(trade);
        continue;
      }

      // ============ BUY SIGNAL HANDLING ============
      // Check side filter (for BUYs)
      if (this.config.copySide === 'SELL') {
        skipped.push({ trade, reason: 'Only copying SELLs, not BUYs' });
        continue;
      }

      // Check price range (only for BUYs - we want to filter entry points)
      if (trade.price < this.config.minOriginalPrice) {
        skipped.push({ trade, reason: `Price ${trade.price} below min ${this.config.minOriginalPrice}` });
        continue;
      }
      if (trade.price > this.config.maxOriginalPrice) {
        skipped.push({ trade, reason: `Price ${trade.price} above max ${this.config.maxOriginalPrice}` });
        continue;
      }

      // Check minimum size
      if (trade.size < this.config.minTradeSize) {
        skipped.push({ trade, reason: `Size ${trade.size} below min ${this.config.minTradeSize}` });
        continue;
      }

      // Note: We don't require the market to be in our local database.
      // The trade itself proves the market exists and has an active orderbook.
      // We have all the info we need from the trade: asset (tokenId), conditionId, price, size.

      candidates.push(trade);
    }

    return { candidates, skipped };
  }

  /**
   * Calculate the size to copy based on config
   * Returns number of shares to buy
   */
  private calculateCopySize(trade: DataApiTrade): number {
    switch (this.config.sizingMode) {
      case 'fixed_dollar':
        // Spend a fixed dollar amount → calculate shares
        const dollarAmount = this.config.fixedDollarAmount || 5;
        const shares = dollarAmount / trade.price;
        return Math.floor(shares); // Round down to whole shares

      case 'fixed_shares':
        return this.config.fixedShares || 5;

      case 'proportional':
        const ratio = this.config.proportionalRatio || 0.1;
        return Math.max(1, Math.floor(trade.size * ratio));

      case 'match':
        return trade.size;

      default:
        // Default to $5 fixed
        return Math.floor(5 / trade.price);
    }
  }

  /**
   * Create a trade record from a Data API trade
   */
  private createTradeRecord(trade: DataApiTrade, targetAddress: string): CopiedTrade {
    return {
      id: uuidv4(),
      originalTradeId: trade.transactionHash,
      targetAddress,
      tokenId: trade.asset,
      conditionId: trade.conditionId,
      side: trade.side,
      originalPrice: trade.price,
      originalSize: trade.size,
      copyPrice: null,
      copySize: null,
      copyCost: null,
      orderId: null,
      status: 'pending',
      skipReason: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
    };
  }

  /**
   * Place an order to copy a trade
   */
  private async placeOrder(
    trade: DataApiTrade,
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.l2Client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const side = trade.side === 'BUY' ? Side.BUY : Side.SELL;

      const orderParams = {
        side,
        tokenID: trade.asset,
        price: trade.price,
        size,
      };

      const createdOrder = await this.l2Client.createOrder(orderParams);
      const result = await this.l2Client.postOrder(createdOrder);

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
   * Place a SELL order to exit a position
   */
  private async placeSellOrder(
    tokenId: string,
    size: number,
    price: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.l2Client) {
      return { success: false, error: 'Client not initialized' };
    }

    try {
      const orderParams = {
        side: Side.SELL,
        tokenID: tokenId,
        price: price,
        size: size,
      };

      const createdOrder = await this.l2Client.createOrder(orderParams);
      const result = await this.l2Client.postOrder(createdOrder);

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
   * Print run summary
   */
  private printSummary(run: CopytradeRun): void {
    console.log('═══════════════════════════════════════════════════════');
    console.log('COPYTRADE RUN COMPLETE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Run ID: ${run.id}`);
    console.log(`  Target: ${run.targetAddress}`);
    console.log(`  Duration: ${this.formatDuration(run.startedAt, run.completedAt || '')}`);
    console.log('─────────────────────────────────────────────────────────');
    console.log(`  Trades found:   ${run.tradesFound}`);
    console.log(`  New trades:     ${run.tradesNew}`);
    console.log(`  Copied:         ${run.tradesCopied}`);
    console.log(`  Skipped:        ${run.tradesSkipped}`);
    console.log(`  Failed:         ${run.tradesFailed}`);
    console.log(`  Total cost:     $${run.totalCost.toFixed(4)}`);
    console.log('═══════════════════════════════════════════════════════\n');
  }

  /**
   * Format duration between two ISO timestamps
   */
  private formatDuration(start: string, end: string): string {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const durationMs = endTime - startTime;
    const seconds = Math.floor(durationMs / 1000);
    return `${seconds}s`;
  }

  /**
   * Run copytrading for all enabled targets
   */
  async copyFromAllTargets(): Promise<CopyResult[]> {
    const targets = this.storage.getTargets(true);
    const results: CopyResult[] = [];

    console.log(`\nCopytrading from ${targets.length} target(s)...\n`);

    for (const target of targets) {
      try {
        const result = await this.copyFromTarget(target.address);
        results.push(result);
      } catch (error: any) {
        console.error(`Error copying from ${target.address}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Get storage instance for direct access
   */
  getStorage(): CopytradeStorage {
    return this.storage;
  }

  /**
   * Get current configuration
   */
  getConfig(): CopytradeConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CopytradeConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Close connections
   */
  close(): void {
    this.storage.close();
  }
}
