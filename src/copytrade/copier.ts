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
import { CopiedTrade, CopytradeConfig, CopytradeRun, DEFAULT_CONFIG, GuardrailEvaluation, RuleEvaluation } from './types';

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

    // Get target config (subledger)
    const target = this.storage.getTarget(targetAddress);
    const walletStats = this.storage.getWalletStats(targetAddress);

    // Build effective config: per-wallet overrides global
    const effectiveConfig = {
      maxCostPerTrade: target?.maxCostPerTrade ?? this.config.maxCostPerTrade,
      maxExposure: target?.maxExposure ?? this.config.maxExposurePerTarget,
      sizingMode: target?.sizingMode ?? this.config.sizingMode,
      fixedDollarAmount: target?.fixedDollarAmount ?? this.config.fixedDollarAmount,
      copyRatio: target?.copyRatio ?? this.config.copyRatio ?? 0.10,
      minPrice: target?.minPrice ?? this.config.minOriginalPrice,
      maxPrice: target?.maxPrice ?? this.config.maxOriginalPrice,
      allowOverdraft: target?.allowOverdraft ?? false,
    };

    // Check wallet balance (subledger)
    const availableBalance = walletStats?.availableBalance ?? 0;
    const currentExposure = walletStats?.currentExposure ?? 0;
    const totalDeposited = walletStats?.totalDeposited ?? 0;

    console.log(`Wallet Stats:`);
    console.log(`  Deposited: $${totalDeposited.toFixed(2)}`);
    console.log(`  Exposure: $${currentExposure.toFixed(2)}`);
    console.log(`  Available: $${availableBalance.toFixed(2)}`);
    console.log(`  Max Exposure: $${effectiveConfig.maxExposure.toFixed(2)}`);
    console.log(`  Overdraft: ${effectiveConfig.allowOverdraft ? 'Enabled' : 'Disabled'}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Check if wallet is funded
    if (totalDeposited === 0) {
      console.log('  Wallet not funded. Skipping.\n');
      run.completedAt = new Date().toISOString();
      this.storage.saveRun(run);
      return { run, trades: copiedTrades };
    }

    // Check if we have available balance (unless overdraft allowed)
    if (!effectiveConfig.allowOverdraft && availableBalance <= 0) {
      console.log('  No available balance. Skipping.\n');
      run.completedAt = new Date().toISOString();
      this.storage.saveRun(run);
      return { run, trades: copiedTrades };
    }

    // Check max exposure limit
    if (currentExposure >= effectiveConfig.maxExposure) {
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
      const validTrades = this.applyGuardrails(newTrades, effectiveConfig);
      console.log(`  ${validTrades.candidates.length} trades pass guardrails`);
      console.log(`  ${validTrades.skipped.length} trades skipped`);

      // Log and record skipped trades
      if (validTrades.skipped.length > 0) {
        console.log('\n  Skipped trades:');
        console.log('  ─────────────────────────────────────────────────────');
        for (const { trade, reason, evaluation } of validTrades.skipped) {
          const marketTitle = trade.title?.substring(0, 40) || trade.conditionId.substring(0, 20);
          console.log(`  SKIP [${trade.side}] ${marketTitle}...`);
          console.log(`        Reason: ${reason}`);

          const skippedRecord: CopiedTrade = this.createTradeRecord(trade, targetAddress);
          skippedRecord.status = 'skipped';
          skippedRecord.skipReason = reason;
          skippedRecord.ruleEvaluation = evaluation;
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

        for (const { trade, evaluation } of validTrades.candidates) {
          // Clone the evaluation to add more rules
          const fullEvaluation: GuardrailEvaluation = {
            ...evaluation,
            rules: [...evaluation.rules],
          };

          // Check if we've hit limits (only for BUYs - SELLs don't cost us money)
          if (trade.side === 'BUY') {
            // Rule: Max trades per run
            const maxTradesRule: RuleEvaluation = {
              rule: 'Max Trades Per Run',
              passed: tradesCopiedCount < this.config.maxTradesPerRun,
              actual: `${tradesCopiedCount} trades this run`,
              threshold: `< ${this.config.maxTradesPerRun}`,
              math: `${tradesCopiedCount} < ${this.config.maxTradesPerRun} = ${tradesCopiedCount < this.config.maxTradesPerRun}`,
            };
            fullEvaluation.rules.push(maxTradesRule);

            if (tradesCopiedCount >= this.config.maxTradesPerRun) {
              console.log(`\n  Reached max trades per run (${this.config.maxTradesPerRun})`);
              break;
            }

            // Rule: Max cost per run
            const maxCostRunRule: RuleEvaluation = {
              rule: 'Max Cost Per Run',
              passed: totalCostSoFar < this.config.maxTotalCostPerRun,
              actual: `$${totalCostSoFar.toFixed(2)} spent this run`,
              threshold: `< $${this.config.maxTotalCostPerRun.toFixed(2)}`,
              math: `${totalCostSoFar.toFixed(2)} < ${this.config.maxTotalCostPerRun.toFixed(2)} = ${totalCostSoFar < this.config.maxTotalCostPerRun}`,
            };
            fullEvaluation.rules.push(maxCostRunRule);

            if (totalCostSoFar >= this.config.maxTotalCostPerRun) {
              console.log(`\n  Reached max cost per run ($${this.config.maxTotalCostPerRun})`);
              break;
            }

            // Rule: Max exposure per target (using per-wallet config)
            const currentTotalExposure = currentExposure + totalCostSoFar;
            const maxExposureRule: RuleEvaluation = {
              rule: 'Max Exposure Per Target',
              passed: currentTotalExposure < effectiveConfig.maxExposure,
              actual: `$${currentTotalExposure.toFixed(2)} total exposure`,
              threshold: `< $${effectiveConfig.maxExposure.toFixed(2)}`,
              math: `$${currentExposure.toFixed(2)} (existing) + $${totalCostSoFar.toFixed(2)} (this run) = $${currentTotalExposure.toFixed(2)} < $${effectiveConfig.maxExposure.toFixed(2)}`,
            };
            fullEvaluation.rules.push(maxExposureRule);

            if (currentTotalExposure >= effectiveConfig.maxExposure) {
              console.log(`\n  Reached max exposure for target ($${effectiveConfig.maxExposure})`);
              break;
            }

            // Rule: Available balance check (subledger)
            const projectedAvailable = availableBalance - totalCostSoFar;
            const balanceCheckPassed = effectiveConfig.allowOverdraft || projectedAvailable > 0;
            const balanceRule: RuleEvaluation = {
              rule: 'Available Balance',
              passed: balanceCheckPassed,
              actual: `$${projectedAvailable.toFixed(2)} available`,
              threshold: effectiveConfig.allowOverdraft ? 'Overdraft allowed' : '> $0',
              math: `$${availableBalance.toFixed(2)} (balance) - $${totalCostSoFar.toFixed(2)} (spent) = $${projectedAvailable.toFixed(2)}`,
            };
            fullEvaluation.rules.push(balanceRule);

            if (!balanceCheckPassed) {
              console.log(`\n  Insufficient balance ($${projectedAvailable.toFixed(2)} available)`);
              break;
            }
          }

          const tradeRecord = this.createTradeRecord(trade, targetAddress);
          tradeRecord.ruleEvaluation = fullEvaluation;

          // ============ HANDLE SELL (EXIT) SIGNALS ============
          if (trade.side === 'SELL') {
            // Check if we have an open position in this token
            const position = this.storage.getOpenPosition(targetAddress, trade.asset);

            // Rule: Must have position to sell
            const hasPositionRule: RuleEvaluation = {
              rule: 'Has Position to Sell',
              passed: !!position,
              actual: position ? `${position.shares.toFixed(1)} shares @ $${position.avgEntryPrice.toFixed(3)}` : 'No position',
              threshold: 'Must hold position in this token',
            };
            fullEvaluation.rules.push(hasPositionRule);

            if (!position) {
              // We don't hold this token - skip
              console.log(`  SKIP SELL: No position in ${trade.title?.substring(0, 40)}...`);
              tradeRecord.status = 'skipped';
              tradeRecord.skipReason = 'No position to sell (we never copied the original BUY)';
              fullEvaluation.outcome = 'skipped';
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

            // Add sell calculation to evaluation
            fullEvaluation.sizingCalculation = {
              mode: 'sell_all',
              inputValue: position.shares,
              calculatedShares: sellSize,
              finalCost: -sellProceeds, // negative = proceeds
            };

            if (this.config.dryRun) {
              const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
              console.log(`  [DRY RUN] Would SELL: ${sellSize.toFixed(1)} shares @ $${trade.price}`);
              console.log(`    Market: ${trade.title?.substring(0, 50)}...`);
              console.log(`    Entry: $${position.avgEntryPrice.toFixed(3)} → Exit: $${trade.price.toFixed(3)}`);
              console.log(`    Proceeds: $${sellProceeds.toFixed(2)} | PnL: ${pnlStr}`);
              tradeRecord.status = 'skipped';
              tradeRecord.skipReason = 'Dry run mode';
              fullEvaluation.outcome = 'skipped';
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
                fullEvaluation.outcome = 'placed';
                tradesCopiedCount++;
                run.tradesCopied++;
                const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
                console.log(`  SOLD: ${sellSize.toFixed(1)} shares @ $${trade.price} | PnL: ${pnlStr}`);
              } else {
                tradeRecord.status = 'failed';
                tradeRecord.skipReason = result.error || null;
                fullEvaluation.outcome = 'failed';
                run.tradesFailed++;
                console.log(`  SELL FAILED: ${result.error?.substring(0, 50)}`);
              }
            }

            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            continue;
          }

          // ============ HANDLE BUY SIGNALS ============
          // Calculate copy size (using per-wallet config)
          const copySize = this.calculateCopySize(trade, effectiveConfig);
          const copyCost = copySize * trade.price;

          // Add sizing calculation to evaluation
          const sizingMode = effectiveConfig.sizingMode || this.config.sizingMode;
          const fixedDollarAmount = effectiveConfig.fixedDollarAmount ?? this.config.fixedDollarAmount ?? 5;
          const targetTradeValue = trade.size * trade.price;
          fullEvaluation.sizingCalculation = {
            mode: sizingMode,
            inputValue: sizingMode === 'conviction' ? targetTradeValue :
                       sizingMode === 'fixed_dollar' ? fixedDollarAmount :
                       sizingMode === 'fixed_shares' ? (this.config.fixedShares || 5) :
                       sizingMode === 'proportional' ? (this.config.proportionalRatio || 0.1) :
                       trade.size,
            calculatedShares: copySize,
            finalCost: copyCost,
          };

          // Rule: Max cost per trade (using per-wallet config)
          const maxCostTradeRule: RuleEvaluation = {
            rule: 'Max Cost Per Trade',
            passed: copyCost <= effectiveConfig.maxCostPerTrade,
            actual: `$${copyCost.toFixed(4)}`,
            threshold: `≤ $${effectiveConfig.maxCostPerTrade.toFixed(2)}`,
            math: `${copySize} shares × $${trade.price.toFixed(4)} = $${copyCost.toFixed(4)} ≤ $${effectiveConfig.maxCostPerTrade.toFixed(2)}`,
          };
          fullEvaluation.rules.push(maxCostTradeRule);

          if (copyCost > effectiveConfig.maxCostPerTrade) {
            console.log(`  SKIP: Cost $${copyCost.toFixed(4)} > max $${effectiveConfig.maxCostPerTrade}`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = `Cost ${copyCost.toFixed(4)} exceeds max ${effectiveConfig.maxCostPerTrade}`;
            fullEvaluation.outcome = 'skipped';
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          // Rule: Would exceed run cost limit
          const projectedRunCost = totalCostSoFar + copyCost;
          const wouldExceedRunRule: RuleEvaluation = {
            rule: 'Run Cost Limit (projected)',
            passed: projectedRunCost <= this.config.maxTotalCostPerRun,
            actual: `$${projectedRunCost.toFixed(2)} after this trade`,
            threshold: `≤ $${this.config.maxTotalCostPerRun.toFixed(2)}`,
            math: `$${totalCostSoFar.toFixed(2)} (spent) + $${copyCost.toFixed(4)} (this trade) = $${projectedRunCost.toFixed(2)}`,
          };
          fullEvaluation.rules.push(wouldExceedRunRule);

          if (projectedRunCost > this.config.maxTotalCostPerRun) {
            console.log(`  SKIP: Would exceed run cost limit`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Would exceed run cost limit';
            fullEvaluation.outcome = 'skipped';
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          // Rule: Would exceed target exposure (using per-wallet config)
          const projectedExposure = currentExposure + totalCostSoFar + copyCost;
          const wouldExceedExposureRule: RuleEvaluation = {
            rule: 'Target Exposure Limit (projected)',
            passed: projectedExposure <= effectiveConfig.maxExposure,
            actual: `$${projectedExposure.toFixed(2)} after this trade`,
            threshold: `≤ $${effectiveConfig.maxExposure.toFixed(2)}`,
            math: `$${currentExposure.toFixed(2)} (existing) + $${totalCostSoFar.toFixed(2)} (run) + $${copyCost.toFixed(4)} (this) = $${projectedExposure.toFixed(2)}`,
          };
          fullEvaluation.rules.push(wouldExceedExposureRule);

          if (projectedExposure > effectiveConfig.maxExposure) {
            console.log(`  SKIP: Would exceed target exposure limit ($${effectiveConfig.maxExposure})`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Would exceed target exposure limit';
            fullEvaluation.outcome = 'skipped';
            this.storage.saveCopiedTrade(tradeRecord);
            copiedTrades.push(tradeRecord);
            run.tradesSkipped++;
            continue;
          }

          // Rule: Would exceed available balance (subledger check for this trade)
          const projectedAvailableAfterTrade = availableBalance - totalCostSoFar - copyCost;
          const balanceAfterTradePassed = effectiveConfig.allowOverdraft || projectedAvailableAfterTrade >= 0;
          const balanceAfterTradeRule: RuleEvaluation = {
            rule: 'Balance After Trade',
            passed: balanceAfterTradePassed,
            actual: `$${projectedAvailableAfterTrade.toFixed(2)} remaining`,
            threshold: effectiveConfig.allowOverdraft ? 'Overdraft allowed' : '>= $0',
            math: `$${availableBalance.toFixed(2)} - $${totalCostSoFar.toFixed(2)} - $${copyCost.toFixed(4)} = $${projectedAvailableAfterTrade.toFixed(2)}`,
          };
          fullEvaluation.rules.push(balanceAfterTradeRule);

          if (!balanceAfterTradePassed) {
            console.log(`  SKIP: Insufficient funds ($${projectedAvailableAfterTrade.toFixed(2)} after trade)`);
            tradeRecord.status = 'skipped';
            tradeRecord.skipReason = 'Insufficient funds';
            fullEvaluation.outcome = 'skipped';
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
            fullEvaluation.outcome = 'skipped';
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
              fullEvaluation.outcome = 'placed';
              totalCostSoFar += copyCost;
              tradesCopiedCount++;
              run.tradesCopied++;
              run.totalCost += copyCost;
              console.log(`  BOUGHT: ${copySize} shares @ $${trade.price} = $${copyCost.toFixed(2)} (Order: ${result.orderId?.substring(0, 12)}...)`);
            } else {
              tradeRecord.status = 'failed';
              tradeRecord.skipReason = result.error || null;
              fullEvaluation.outcome = 'failed';
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
   * Apply guardrails to filter trades - returns detailed evaluations
   */
  private applyGuardrails(trades: DataApiTrade[], effectiveConfig: {
    maxCostPerTrade: number;
    maxExposure: number;
    sizingMode: string;
    fixedDollarAmount: number | undefined;
    minPrice: number;
    maxPrice: number;
    allowOverdraft: boolean;
  }): {
    candidates: Array<{ trade: DataApiTrade; evaluation: GuardrailEvaluation }>;
    skipped: Array<{ trade: DataApiTrade; reason: string; evaluation: GuardrailEvaluation }>;
  } {
    const candidates: Array<{ trade: DataApiTrade; evaluation: GuardrailEvaluation }> = [];
    const skipped: Array<{ trade: DataApiTrade; reason: string; evaluation: GuardrailEvaluation }> = [];

    for (const trade of trades) {
      const rules: RuleEvaluation[] = [];
      let skipReason: string | null = null;

      // ============ SELL SIGNAL HANDLING ============
      if (trade.side === 'SELL') {
        // Rule: copyExits enabled
        const copyExitsRule: RuleEvaluation = {
          rule: 'Copy Exits Enabled',
          passed: this.config.copyExits,
          actual: this.config.copyExits ? 'Yes' : 'No',
          threshold: 'Must be enabled',
        };
        rules.push(copyExitsRule);

        if (!this.config.copyExits) {
          skipReason = 'copyExits disabled';
        }

        const evaluation: GuardrailEvaluation = {
          timestamp: new Date().toISOString(),
          side: 'SELL',
          outcome: skipReason ? 'skipped' : 'placed',
          rules,
        };

        if (skipReason) {
          skipped.push({ trade, reason: skipReason, evaluation });
        } else {
          candidates.push({ trade, evaluation });
        }
        continue;
      }

      // ============ BUY SIGNAL HANDLING ============

      // Rule 1: Side filter
      const sideFilterRule: RuleEvaluation = {
        rule: 'Side Filter (BUYs allowed)',
        passed: this.config.copySide !== 'SELL',
        actual: `copySide = ${this.config.copySide}`,
        threshold: 'Must be BUY or BOTH',
      };
      rules.push(sideFilterRule);

      if (this.config.copySide === 'SELL') {
        skipReason = 'Only copying SELLs, not BUYs';
      }

      // Rule 2: Min price (using per-wallet config)
      const minPriceRule: RuleEvaluation = {
        rule: 'Min Price',
        passed: trade.price >= effectiveConfig.minPrice,
        actual: `$${trade.price.toFixed(4)}`,
        threshold: `≥ $${effectiveConfig.minPrice.toFixed(4)}`,
        math: `${trade.price.toFixed(4)} >= ${effectiveConfig.minPrice.toFixed(4)} = ${trade.price >= effectiveConfig.minPrice}`,
      };
      rules.push(minPriceRule);

      if (!skipReason && trade.price < effectiveConfig.minPrice) {
        skipReason = `Price ${trade.price} below min ${effectiveConfig.minPrice}`;
      }

      // Rule 3: Max price (using per-wallet config)
      const maxPriceRule: RuleEvaluation = {
        rule: 'Max Price',
        passed: trade.price <= effectiveConfig.maxPrice,
        actual: `$${trade.price.toFixed(4)}`,
        threshold: `≤ $${effectiveConfig.maxPrice.toFixed(4)}`,
        math: `${trade.price.toFixed(4)} <= ${effectiveConfig.maxPrice.toFixed(4)} = ${trade.price <= effectiveConfig.maxPrice}`,
      };
      rules.push(maxPriceRule);

      if (!skipReason && trade.price > effectiveConfig.maxPrice) {
        skipReason = `Price ${trade.price} above max ${effectiveConfig.maxPrice}`;
      }

      // Rule 4: Min trade size
      const minSizeRule: RuleEvaluation = {
        rule: 'Min Trade Size',
        passed: trade.size >= this.config.minTradeSize,
        actual: `${trade.size} shares`,
        threshold: `≥ ${this.config.minTradeSize} shares`,
        math: `${trade.size} >= ${this.config.minTradeSize} = ${trade.size >= this.config.minTradeSize}`,
      };
      rules.push(minSizeRule);

      if (!skipReason && trade.size < this.config.minTradeSize) {
        skipReason = `Size ${trade.size} below min ${this.config.minTradeSize}`;
      }

      const evaluation: GuardrailEvaluation = {
        timestamp: new Date().toISOString(),
        side: 'BUY',
        outcome: skipReason ? 'skipped' : 'placed',
        rules,
      };

      if (skipReason) {
        skipped.push({ trade, reason: skipReason, evaluation });
      } else {
        candidates.push({ trade, evaluation });
      }
    }

    return { candidates, skipped };
  }

  /**
   * Calculate the size to copy based on config
   * Returns number of shares to buy
   *
   * Conviction mode sizing strategy:
   * - Target trade value < $1 → skip (dust)
   * - Target trade value $1-$5 → match 1:1 (same dollar amount)
   * - Target trade value > $5 → max($1, copyRatio × targetValue), capped at maxCostPerTrade
   */
  private calculateCopySize(trade: DataApiTrade, effectiveConfig?: {
    sizingMode?: string;
    fixedDollarAmount?: number;
    copyRatio?: number;
    maxCostPerTrade?: number;
  }): number {
    const sizingMode = effectiveConfig?.sizingMode || this.config.sizingMode;
    const fixedDollarAmount = effectiveConfig?.fixedDollarAmount ?? this.config.fixedDollarAmount ?? 5;
    const copyRatio = effectiveConfig?.copyRatio ?? this.config.copyRatio ?? 0.10;
    const maxCostPerTrade = effectiveConfig?.maxCostPerTrade ?? this.config.maxCostPerTrade ?? 10;

    switch (sizingMode) {
      case 'conviction': {
        // Calculate target's trade value in dollars
        const targetTradeValue = trade.size * trade.price;

        // Dust: skip trades < $1
        if (targetTradeValue < 1) {
          return 0;
        }

        let dollarAmount: number;

        // Small trades ($1-$5): match 1:1
        if (targetTradeValue <= 5) {
          dollarAmount = targetTradeValue;
        } else {
          // Large trades (>$5): max($1, copyRatio × targetValue), capped at maxCostPerTrade
          const proportionalAmount = copyRatio * targetTradeValue;
          dollarAmount = Math.max(1, proportionalAmount);
          dollarAmount = Math.min(dollarAmount, maxCostPerTrade);
        }

        // Convert dollars to shares
        const shares = dollarAmount / trade.price;
        return Math.floor(shares); // Round down to whole shares
      }

      case 'fixed_dollar': {
        // Spend a fixed dollar amount → calculate shares
        const shares = fixedDollarAmount / trade.price;
        return Math.floor(shares); // Round down to whole shares
      }

      case 'fixed_shares':
        return this.config.fixedShares || 5;

      case 'proportional': {
        const ratio = this.config.proportionalRatio || 0.1;
        return Math.max(1, Math.floor(trade.size * ratio));
      }

      case 'match':
        return trade.size;

      default:
        // Default to conviction mode
        return this.calculateCopySize(trade, { ...effectiveConfig, sizingMode: 'conviction' });
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
      marketTitle: trade.title || null,
      marketSlug: trade.slug || null,
      ruleEvaluation: null,
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
