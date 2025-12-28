# Polymarket CLOB API: postOrder Returns 401 "Unauthorized/Invalid api key" Despite Working Reads

## Issue

API keys authenticate successfully for all read operations but fail with `401 Unauthorized: "Unauthorized/Invalid api key"` when posting orders via `postOrder()`.

## What Works
- ✅ `getTradeHistory()` - Works
- ✅ `getOpenOrders()` - Works  
- ✅ `createLimitOrder()` - Works (order structure is valid)
- ✅ All other read endpoints - Work

## What Fails
- ❌ `postOrder()` - Returns 401 with "Unauthorized/Invalid api key"

## Error Response
```json
{
  "error": {
    "error": "Unauthorized/Invalid api key"
  }
}
```

## Minimal Reproduction Code

```typescript
import { ClobClient } from '@polymarket/clob-client';

// Client initialized with valid API credentials
const client = new ClobClient(host, wallet, apiCreds, signatureType, funderAddress);

// ✅ This works
await client.getTradeHistory({});

// ✅ This works  
const order = await client.createLimitOrder({
  side: Side.BUY,
  tokenID: '...',
  price: 0.001,
  size: 5
});

// ❌ This fails with 401
await client.postOrder(order);
// Error: { "error": { "error": "Unauthorized/Invalid api key" } }
```

## Observations

1. Same API key used for both reads and writes
2. Authentication headers are properly formatted
3. HMAC signatures are correctly generated
4. Order structure is valid (creation succeeds)
5. Issue affects both programmatically generated and UI-generated API keys

## Related Issues

- Python client has similar issue: https://github.com/Polymarket/py-clob-client/issues/187

## Question

Is there a separate permission level required for order posting? Or is this a bug in the API key validation for the `postOrder` endpoint?

---

**Environment**: `@polymarket/clob-client`, TypeScript, Signature Type 1 (Magic wallet), Polygon

