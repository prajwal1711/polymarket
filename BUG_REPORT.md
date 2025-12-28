# Polymarket CLOB API: API Key Authentication Issue with postOrder

## Summary

API keys successfully authenticate for read operations but fail with "Unauthorized/Invalid api key" when attempting to post orders via the `postOrder` endpoint. This appears to be a permissions or authentication bug in the Polymarket CLOB API.

## Environment

- **Client Library**: `@polymarket/clob-client` (TypeScript/JavaScript)
- **API Endpoint**: `https://clob.polymarket.com`
- **Signature Type**: 1 (Email/Magic wallet)
- **Chain**: Polygon (137)

## What Works ✅

1. **Read Operations** - All read endpoints work correctly:
   - `getTradeHistory()` - ✅ Success
   - `getOk()` - ✅ Success
   - `getOrderBook()` - ✅ Success
   - Other read endpoints - ✅ Success

2. **Order Creation** - Orders are created successfully:
   - `createLimitOrder()` - ✅ Success
   - Order structure is valid and properly signed

3. **L2 Authentication** - API key authentication works for reads:
   - HMAC signatures are generated correctly
   - Headers are properly formatted
   - Read requests authenticate successfully

## What Fails ❌

1. **Order Posting** - `postOrder()` fails with 401 Unauthorized:
   - Error: `"Unauthorized/Invalid api key"`
   - Status Code: `401`
   - Same API key that works for reads fails for writes

## Error Details

### Request Details
- **Endpoint**: `POST https://clob.polymarket.com/order`
- **Method**: POST
- **Headers**: 
  - `POLY_ADDRESS`: `0x71EDDe80c49E32EB89F2B2dC9b390C1e50c05516`
  - `POLY_API_KEY`: `019b5cd9-a924-7807-8648-529d5f1fc10c`
  - `POLY_PASSPHRASE`: `79b68c528f9750907c4e6faca757b09ef9ce544e15af569fd5ddf94e9b6d21d6`
  - `POLY_SIGNATURE`: (HMAC signature - properly generated)
  - `POLY_TIMESTAMP`: (Unix timestamp)

### Response
```json
{
  "error": {
    "error": "Unauthorized/Invalid api key"
  }
}
```

**Status**: `401 Unauthorized`

## Code Snippet

```typescript
import { ClobClient, ApiKeyCreds, Side } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

// Initialize client with API credentials
const provider = new JsonRpcProvider('https://polygon-rpc.com');
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const client = new ClobClient(
  'https://clob.polymarket.com',
  wallet,
  apiCreds, // API credentials loaded from .env
  1, // Signature type
  process.env.FUNDER_ADDRESS
);

// This works ✅
const tradeHistory = await client.getTradeHistory({});
console.log('Read operation successful');

// This works ✅
const order = await client.createLimitOrder({
  side: Side.BUY,
  tokenID: '48477409091695386761559202853239391470463303066983260592312960625658563043275',
  price: 0.001,
  size: 5
});
console.log('Order created successfully');

// This fails ❌
try {
  const result = await client.postOrder(order);
  console.log('Order posted:', result);
} catch (error: any) {
  // Error: Request failed with status code 401
  // Response: { "error": { "error": "Unauthorized/Invalid api key" } }
  console.error('Order posting failed:', error.response?.data);
}
```

## Steps to Reproduce

1. Generate API credentials using `createApiKey()` or `deriveApiKey()`
2. Initialize `ClobClient` with the API credentials
3. Verify read operations work (e.g., `getTradeHistory()`)
4. Create an order using `createLimitOrder()`
5. Attempt to post the order using `postOrder()`
6. Observe 401 Unauthorized error

## Expected Behavior

The API key should have consistent permissions across all endpoints. If an API key works for read operations, it should also work for write operations (posting orders) with the same authentication.

## Actual Behavior

The API key authenticates successfully for read operations but fails with "Unauthorized/Invalid api key" when attempting to post orders, even though:
- The same API key is used
- The authentication headers are properly formatted
- The HMAC signature is correctly generated
- The order structure is valid

## Additional Context

- This issue has been reported in the Python client repository: [GitHub Issue #187](https://github.com/Polymarket/py-clob-client/issues/187)
- The issue affects both TypeScript and Python clients
- API keys generated both programmatically and from the UI exhibit the same behavior
- The account has been activated and has balance on Polymarket
- `FUNDER_ADDRESS` matches the profile address registered on Polymarket

## Workaround Attempts

1. ✅ Generated fresh API key from Polymarket UI - Same issue
2. ✅ Generated API key programmatically with different nonces - Same issue
3. ✅ Verified `FUNDER_ADDRESS` matches profile - Confirmed correct
4. ✅ Fixed async signature issue (PR 173 equivalent) - Signature now correct, but still fails
5. ✅ Verified order structure is valid - Order creation succeeds

## Request for Support

Could Polymarket support please:
1. Verify if this is a known issue with API key permissions
2. Check if there are additional permissions or settings required for order posting
3. Confirm if there's a difference in how `postOrder` validates API keys vs read endpoints
4. Provide guidance on how to obtain API keys with full trading permissions

## Technical Details

- **API Key Format**: UUID format (e.g., `019b5cd9-a924-7807-8648-529d5f1fc10c`)
- **Signature Algorithm**: HMAC-SHA256 with Base64 encoding
- **Request Body**: Valid limit order JSON structure
- **Content-Type**: `application/json`

---

**Note**: This appears to be a server-side issue with API key validation for the `postOrder` endpoint, as the same authentication works for all read operations.

