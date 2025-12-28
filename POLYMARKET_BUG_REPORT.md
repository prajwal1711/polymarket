# GitHub Issue: POLY_ADDRESS header bug for Magic wallet

**Submit this issue at:** https://github.com/Polymarket/clob-client/issues/new

---

## Title

POLY_ADDRESS header uses signer address instead of funderAddress for Magic wallet (signature type 1)

---

## Body

### Description

When using signature type 1 (Magic/email wallet) with a `funderAddress`, the `createL2Headers` function incorrectly sets `POLY_ADDRESS` to the signer's EOA address instead of the `funderAddress`. This causes `postOrder` and other L2 authenticated endpoints to fail with `401 Unauthorized / Invalid api key`.

### Root Cause

In `src/headers/index.ts`, `createL2Headers` always uses `signer.getAddress()`:

```typescript
export const createL2Headers = async (signer, creds, l2HeaderArgs, timestamp) => {
    const address = await signer.getAddress();  // ❌ Always uses signer address
    // ...
    const headers = {
        POLY_ADDRESS: address,  // Should be funderAddress for sig type 1
        // ...
    };
};
```

For Magic wallet users:
- The API key is associated with the `funderAddress` (Polymarket profile address)
- But `POLY_ADDRESS` is set to the EOA signer address
- Server sees mismatch → 401 Unauthorized

### Reproduction

```typescript
const client = new ClobClient(
  host,
  Chain.POLYGON,
  wallet,           // EOA signer
  apiCreds,
  SignatureType.POLY_PROXY,  // Signature type 1
  funderAddress     // Polymarket profile address
);

// ✅ Works - no L2 auth needed
await client.getMarkets();

// ✅ Works
await client.getTrades();

// ❌ Fails with 401 - POLY_ADDRESS mismatch
await client.postOrder(order);
```

**Error response:**
```json
{
  "error": "Unauthorized/Invalid api key"
}
```

### Workaround

Use an axios interceptor to fix the header before requests are sent:

```typescript
import axios from 'axios';

const funderAddress = process.env.FUNDER_ADDRESS;

axios.interceptors.request.use((config) => {
  if (config.headers?.['POLY_ADDRESS'] && config.headers?.['POLY_API_KEY']) {
    config.headers['POLY_ADDRESS'] = funderAddress;
  }
  return config;
});
```

### Suggested Fix

The `ClobClient` already has access to `funderAddress` and `signatureType`. Pass these to `createL2Headers` and use the funder address when appropriate:

```typescript
export const createL2Headers = async (
  signer,
  creds,
  l2HeaderArgs,
  timestamp?,
  funderAddress?,
  signatureType?
) => {
    const signerAddress = await signer.getAddress();
    // Use funderAddress for Magic wallet, otherwise signer address
    const address = (signatureType === SignatureType.POLY_PROXY && funderAddress)
      ? funderAddress
      : signerAddress;

    const sig = await buildPolyHmacSignature(...);

    return {
        POLY_ADDRESS: address,
        POLY_SIGNATURE: sig,
        // ...
    };
};
```

### Environment

- `@polymarket/clob-client`: v5.1.3
- Node.js: v20+
- Signature Type: 1 (POLY_PROXY / Magic wallet)

### Related Issues

- Python client has similar issue: https://github.com/Polymarket/py-clob-client/issues/187
