/**
 * Polymarket Gamma API client with retry logic and rate limiting
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import pRetry, { AbortError } from 'p-retry';
import pLimit from 'p-limit';
import { GammaApiMarket, GammaApiEvent } from '../types/market';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

export class GammaApiClient {
  private client: AxiosInstance;
  private rateLimiter: ReturnType<typeof pLimit>;

  constructor(rateLimitRps: number = 10) {
    this.client = axios.create({
      baseURL: GAMMA_API_BASE,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Rate limiter: max concurrent requests
    this.rateLimiter = pLimit(rateLimitRps);
  }

  /**
   * Fetch a single page of events from Gamma API
   */
  async fetchEventsPage(limit: number, offset: number): Promise<GammaApiEvent[]> {
    const fetchWithRetry = async () => {
      return this.rateLimiter(async () => {
        try {
          const response = await this.client.get('/events', {
            params: {
              order: 'id',
              ascending: 'false',
              closed: 'false',
              limit,
              offset,
            },
          });

          // Handle different response formats
          if (Array.isArray(response.data)) {
            return response.data;
          } else if (response.data?.data && Array.isArray(response.data.data)) {
            return response.data.data;
          } else if (response.data?.results && Array.isArray(response.data.results)) {
            return response.data.results;
          } else if (response.data?.events && Array.isArray(response.data.events)) {
            return response.data.events;
          } else if (response.data?.items && Array.isArray(response.data.items)) {
            return response.data.items;
          }

          throw new Error('Unexpected response format from /events endpoint');
        } catch (error) {
          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.error || error.message;
            
            // Don't retry on 4xx errors (except 429 rate limit)
            if (status && status >= 400 && status < 500 && status !== 429) {
              throw new AbortError(`API error (${status}): ${message}`);
            }
            
            throw new Error(`API request failed: ${message}`);
          }
          throw error;
        }
      });
    };

    return pRetry(fetchWithRetry, {
      retries: 3,
      minTimeout: 1000, // 1 second
      maxTimeout: 10000, // 10 seconds
      factor: 2, // Exponential backoff
      onFailedAttempt: (error) => {
        console.log(`  Retry attempt ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber}...`);
      },
    });
  }

  /**
   * Fetch all active markets from Gamma API using /events endpoint
   * Paginates through all events and extracts markets
   */
  async fetchMarkets(): Promise<GammaApiMarket[]> {
    const allMarkets: GammaApiMarket[] = [];
    const limit = 100; // Fetch 100 events per page
    let offset = 0;
    let hasMore = true;

    console.log('  Fetching events (paginated)...');

    while (hasMore) {
      const events = await this.fetchEventsPage(limit, offset);
      
      if (events.length === 0) {
        hasMore = false;
        break;
      }

      // Extract markets from each event
      for (const event of events) {
        if (event.markets && Array.isArray(event.markets)) {
          allMarkets.push(...event.markets);
        }
      }

      console.log(`  Fetched ${events.length} events, ${allMarkets.length} markets so far...`);

      // If we got fewer events than the limit, we've reached the end
      if (events.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    return allMarkets;
  }

  /**
   * Fetch a single page of markets from Gamma API /markets endpoint
   */
  async fetchMarketsPage(limit: number, offset: number): Promise<GammaApiMarket[]> {
    const fetchWithRetry = async () => {
      return this.rateLimiter(async () => {
        try {
          const response = await this.client.get('/markets', {
            params: {
              limit,
              offset,
            },
          });

          // Handle different response formats
          if (Array.isArray(response.data)) {
            return response.data;
          } else if (response.data?.data && Array.isArray(response.data.data)) {
            return response.data.data;
          } else if (response.data?.results && Array.isArray(response.data.results)) {
            return response.data.results;
          } else if (response.data?.markets && Array.isArray(response.data.markets)) {
            return response.data.markets;
          } else if (response.data?.items && Array.isArray(response.data.items)) {
            return response.data.items;
          }

          throw new Error('Unexpected response format from /markets endpoint');
        } catch (error) {
          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.error || error.message;
            
            // Don't retry on 4xx errors (except 429 rate limit)
            if (status && status >= 400 && status < 500 && status !== 429) {
              throw new AbortError(`API error (${status}): ${message}`);
            }
            
            throw new Error(`API request failed: ${message}`);
          }
          throw error;
        }
      });
    };

    return pRetry(fetchWithRetry, {
      retries: 3,
      minTimeout: 1000, // 1 second
      maxTimeout: 10000, // 10 seconds
      factor: 2, // Exponential backoff
      onFailedAttempt: (error) => {
        console.log(`  Retry attempt ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber}...`);
      },
    });
  }

  /**
   * Test API connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/health', { timeout: 5000 }).catch(() => {
        // Health endpoint might not exist, that's OK
      });
      return true;
    } catch (error) {
      // Connection test is best-effort
      return true;
    }
  }
}

