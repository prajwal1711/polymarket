/**
 * Market data types for Polymarket Gamma API
 */

export interface GammaMarket {
  id: string;
  question: string;
  slug: string | null;
  active: boolean;
  closed: boolean;
  endDate?: string | null;
  closeDate?: string | null;
  yesTokenId?: string | null;
  noTokenId?: string | null;
  conditionId?: string | null;
  enableOrderBook?: boolean | null;
  minTickSize?: number | null;
  minOrderSize?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface GammaApiMarket {
  id: string;
  question?: string;
  title?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string | null;
  closeDate?: string | null;
  conditionId?: string | null;
  condition_id?: string | null;
  enableOrderBook?: boolean | null;
  orderPriceMinTickSize?: number | string | null;
  orderMinSize?: number | string | null;
  clobTokenIds?: string[] | string | null;
  outcomes?: Array<{
    id?: string;
    tokenId?: string;
    title?: string;
    [key: string]: any;
  }> | string | null;
  [key: string]: any;
}

export interface GammaApiEvent {
  id: string;
  markets?: GammaApiMarket[];
  [key: string]: any;
}

