/**
 * Polymarket Data API client for fetching trades from target wallets
 */

import axios, { AxiosInstance } from 'axios';

const DATA_API_BASE = 'https://data-api.polymarket.com';

// Trade response from Data API (different from CLOB API format)
export interface DataApiTrade {
  proxyWallet: string;          // Wallet address
  side: 'BUY' | 'SELL';
  asset: string;                // Token ID
  conditionId: string;          // Market condition ID
  size: number;
  price: number;
  timestamp: number;            // Unix timestamp
  title: string;                // Market question
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;              // "Yes" or "No"
  outcomeIndex: number;         // 0 or 1
  name: string;                 // User display name
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  transactionHash: string;
}

// Position response from Data API
export interface DataApiPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
  icon: string;
  eventSlug: string;
}

export class PolymarketDataApi {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: DATA_API_BASE,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Fetch trades for a specific wallet address
   */
  async getTradesForWallet(
    address: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<DataApiTrade[]> {
    const { limit = 100, offset = 0 } = options;

    try {
      const response = await this.client.get('/trades', {
        params: {
          user: address.toLowerCase(),
          limit,
          offset,
        },
      });

      if (Array.isArray(response.data)) {
        return response.data;
      }

      console.warn('Unexpected response format from /trades:', typeof response.data);
      return [];
    } catch (error: any) {
      const msg = error?.response?.data?.error || error?.message || String(error);
      throw new Error(`Failed to fetch trades for ${address}: ${msg}`);
    }
  }

  /**
   * Fetch all recent trades for a wallet (paginated)
   */
  async getAllRecentTrades(
    address: string,
    options: {
      maxTrades?: number;
      maxAgeMs?: number;
    } = {}
  ): Promise<DataApiTrade[]> {
    const { maxTrades = 500, maxAgeMs = 24 * 60 * 60 * 1000 } = options; // Default: 500 trades, 24 hours
    const allTrades: DataApiTrade[] = [];
    const pageSize = 100;
    let offset = 0;
    const cutoffTime = Date.now() - maxAgeMs;

    while (allTrades.length < maxTrades) {
      const trades = await this.getTradesForWallet(address, {
        limit: pageSize,
        offset,
      });

      if (trades.length === 0) break;

      // Filter by age
      for (const trade of trades) {
        const tradeTime = trade.timestamp * 1000; // Convert to ms
        if (tradeTime < cutoffTime) {
          // Trades are ordered by time desc, so we can stop here
          return allTrades;
        }
        allTrades.push(trade);
        if (allTrades.length >= maxTrades) break;
      }

      if (trades.length < pageSize) break;
      offset += pageSize;
    }

    return allTrades;
  }

  /**
   * Fetch positions for a specific wallet address
   */
  async getPositionsForWallet(address: string): Promise<DataApiPosition[]> {
    try {
      const response = await this.client.get('/positions', {
        params: {
          user: address.toLowerCase(),
        },
      });

      if (Array.isArray(response.data)) {
        return response.data;
      }

      console.warn('Unexpected response format from /positions:', typeof response.data);
      return [];
    } catch (error: any) {
      const msg = error?.response?.data?.error || error?.message || String(error);
      throw new Error(`Failed to fetch positions for ${address}: ${msg}`);
    }
  }

  /**
   * Get profile/activity summary for a wallet
   */
  async getActivity(
    address: string,
    options: {
      limit?: number;
    } = {}
  ): Promise<any[]> {
    const { limit = 50 } = options;

    try {
      const response = await this.client.get('/activity', {
        params: {
          user: address.toLowerCase(),
          limit,
        },
      });

      if (Array.isArray(response.data)) {
        return response.data;
      }

      return [];
    } catch (error: any) {
      // Activity endpoint might not exist or have different format
      console.warn(`Activity endpoint error: ${error?.message}`);
      return [];
    }
  }

  /**
   * Test API connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      // Just try to fetch a small amount of data
      await this.client.get('/trades', {
        params: { limit: 1 },
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
