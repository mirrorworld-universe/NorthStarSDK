# North Star SDK

TypeScript/JavaScript SDK for interacting with **Ephemeral Rollup** on Solana and building transactions for the **Portal** on-chain program.

- **Dependencies**: `@solana/web3.js`, `@dao-xyz/borsh`, `axios`, `bs58`
- **Entry point**: After build, `dist/index.js`; types in `dist/index.d.ts`

---

## Installation and build

```bash
npm install
npm run build
```

Example local dependency in another project:

```json
{
  "dependencies": {
    "north-star-sdk": "file:../NorthStarSDK"
  }
}
```

---

## Quick start

### 1. Configure `NorthStarConfig`

```typescript
import { NorthStarSDK, PublicKey } from "north-star-sdk";

const sdk = new NorthStarSDK({
  portalProgramId: new PublicKey("YOUR_PORTAL_PROGRAM_ID"),
  customEndpoints: {
    solana: "https://api.devnet.solana.com",
    ephemeralRollup: "https://ephemeral.devnet.sonic.game",
  },
});
```

| Field | Description |
|------|------|
| `portalProgramId` | Portal program public key on Solana |
| `customEndpoints.solana` | Solana L1 JSON-RPC |
| `customEndpoints.ephemeralRollup` | Ephemeral Rollup JSON-RPC |

After construction, the SDK logs initialization details (RPC endpoints and Portal program address) to the console.

### 2. Wallet signing callback `WalletSignTransaction`

Most on-chain methods follow a **“partial local signing + wallet co-sign”** flow:

1. The SDK builds a `VersionedTransaction` via `Connection.getLatestBlockhash`
2. Signs locally with `Keypair`s provided in `signers` (e.g. delegated accounts)
3. Calls your `signTransaction` so the wallet (or a local keypair) completes remaining signatures
4. Broadcasts and confirms on L1 (HTTP polling, no WebSocket dependency)

Type definition:

```typescript
type WalletSignTransaction = (
  transaction: VersionedTransaction,
) => Promise<VersionedTransaction>;
```

**Pure local testing** (no browser wallet): simulate the wallet by signing again with the required keypairs, e.g. as in integration tests:

```typescript
import {
  NorthStarSDK,
  signVersionedTransaction,
  VersionedTransaction,
  Keypair,
} from "north-star-sdk";

function walletSignLocal(...keypairs: Keypair[]) {
  return async (tx: VersionedTransaction) =>
    signVersionedTransaction(tx, keypairs);
}

await sdk.openSession(
  user.publicKey,
  gridId,
  2000,
  1_000_000,
  walletSignLocal(user),
  {},
);
```

The main entry also exports `signVersionedTransaction`, `getVersionedTxSignatureBase58`, and `toPublicKey` for use with `VersionedTransaction`.

---

## Core class: `NorthStarSDK`

### Connections and program

| Method | Description |
|------|------|
| `getRpc()` | Solana L1 `Connection` (`commitment` is `confirmed`) |
| `getEphemeralRpc()` | Ephemeral Rollup `Connection` |
| `getPortalProgramId()` | Portal program `PublicKey` |
| `portal` | `PortalProgram` instance (PDA derivation, instruction encoding, account parsing) |
| `accountResolver` | `AccountResolver` — resolves accounts by data source |

### Key utilities

| Method | Description |
|------|------|
| `generateKeyPair()` | Generate a new `Keypair` |
| `createKeyPairFromBase58(privateKeyBase58)` | Import from Base58 secret (32-byte seed or 64-byte secret key) |

### Account reads

| Method | Description |
|------|------|
| `getAccountInfo(address, search_source)` | Fetch a single account |
| `getMultipleAccounts(addresses, search_source)` | Batch fetch |

**`search_source` behavior** (must be explicit; no automatic fallback):

- `"ephemeral"`: reads only via Ephemeral Rollup RPC `getAccountInfo`; throws on failure.
- `"solana"`: reads only via L1 `Connection.getAccountInfo`; throws if the account does not exist.

Returned type `AccountInfo`:

```typescript
interface AccountInfo {
  address: PublicKey;
  data: Uint8Array;
  executable: boolean;
  lamports: bigint;
  owner: PublicKey;
  slot: bigint;
  source: "ephemeral-rollup" | "solana";
}
```

Use with `sdk.portal.parseSession` and similar to decode Portal-related account data (see **PortalProgram** below).

### Health check

| Method | Description |
|------|------|
| `checkHealth()` | Returns `{ solana: boolean, ephemeralRollup: boolean }` |

### Sending and confirming transactions

| Method | Description |
|------|------|
| `sendAndConfirmTransactionWithoutWebsocket(tx, options?)` | Send a signed `VersionedTransaction`; confirm via HTTP polling |
| `confirmSignature(signature, options?)` | Wait until the given signature reaches the requested commitment |

**`TransactionOptions`** (optional):

| Field | Description |
|------|------|
| `commitment` | `"processed"` \| `"confirmed"` \| `"finalized"` (default `"confirmed"`) |
| `skipPreflight` | Skip preflight (default `true`) |
| `maxAttempts` | Max confirmation poll attempts (default `20`) |
| `intervalMs` | Poll interval in milliseconds (default `1000`) |

---

## Portal on-chain actions (send in one step)

These methods build a `VersionedTransaction`, sign locally with keypairs in `signers`, call `signTransaction`, then `sendAndConfirmTransactionWithoutWebsocket`.

### `openSession`

Open a session (creates Session PDA, links FeeVault, etc. — exact behavior depends on the on-chain program).

```typescript
await sdk.openSession(
  user,                    // PublicKey: user/payer (user in the instruction)
  gridId,                  // number
  ttlSlots,                // optional, default 2000
  feeCap,                  // optional, default 1_000_000 (lamports; bigint semantics handled at encode time)
  signTransaction,
  signers,                 // SessionV1Signers
  options?,
);
```

**`SessionV1Signers`**: `{ feePayerSigner?: Keypair }`  
If `feePayerSigner` is omitted, the fee payer is `user`.

### `closeSession`

Close the session for the given `gridId`.

```typescript
await sdk.closeSession(
  user,
  gridId,
  signTransaction,
  signers,                 // SessionV1Signers
  options?,
);
```

If `feePayerSigner` is passed, its public key must match the fee payer or an error is thrown.

### `depositFee`

Deposit `lamports` into a user’s session.

```typescript
await sdk.depositFee(
  user,                    // depositor (signing account)
  sessionOwner,            // session owner PublicKey
  gridId,
  lamports,                // number
  signTransaction,
  signers,                 // DepositFeeV1Signers
  options?,
);
```

**`DepositFeeV1Signers`**: `{ depositorSigner?: Keypair; feePayerSigner?: Keypair }`  
If omitted, signing is done by the wallet for `user`; locally you can sign with `depositorSigner` / `feePayerSigner` first, then hand off to the wallet.

### `delegate`

Delegate an **account already owned by the Portal program** to a grid (instruction data includes `gridId`).  
**`ownerProgramId`** is the **current owner program** of the delegated account (typical flow: assign the account to Portal first; when delegating, pass System Program or others per your on-chain convention).

```typescript
await sdk.delegate(
  user,                    // PublicKey: payer / primary signer
  gridId,
  ownerProgramId,          // PublicKey
  signTransaction,
  signers,                 // DelegateV1Signers
  options?,
);
```

**`DelegateV1Signers`**:

```typescript
{
  delegatedAccountSigner: Keypair;  // delegated account — must sign
  feePayerSigner?: Keypair;
}
```

### `undelegate`

Revoke delegation.

```typescript
await sdk.undelegate(
  user,
  signTransaction,
  signers,                 // same as DelegateV1Signers
  options?,
);
```

### `delegate_v1`

Alias for `delegate` for backward compatibility; **deprecated**.

---

## Instruction builders only (no send)

Use when composing custom transactions or showing them in an external wallet:

| Method | Returns |
|------|------|
| `buildOpenSession(signer, gridId, ttlSlots?, feeCap?)` | `{ instructions, feePayer, blockhash, lastValidBlockHeight }` |
| `buildCloseSession(signer, gridId)` | same |
| `buildDepositFee(signer, sessionOwner, gridId, lamports)` | same |
| `buildDelegate(signer, delegatedAccount, gridId)` | same (**note**: account list differs from `delegate()`; the `build*` family targets another layout — compare `src/index.ts` and the on-chain IDL before use) |
| `buildUndelegate(signer, delegatedAccount)` | same |

Here `instructions` is `TransactionInstruction[]`, and `feePayer` is `signer.publicKey`.

---

## `PortalProgram`

Use via `sdk.portal` or `new PortalProgram(programId)` (the SDK binds the configured program ID).

### PDA derivation (static or instance)

| Method | Seeds (conceptual) |
|------|----------------|
| `deriveSessionPDA(owner, gridId)` | `session` + owner + `gridId` (u64 LE) |
| `deriveFeeVaultPDA(owner)` | `fee_vault` + owner |
| `deriveDelegationRecordPDA(delegatedAccount)` | `delegation` + delegatedAccount |
| `deriveDepositReceiptPDA(session, recipient)` | `deposit_receipt` + session + recipient |

### Instruction encoding (Borsh)

| Method | Description |
|------|------|
| `encodeOpenSession({ gridId, ttlSlots, feeCap })` | variant 0 |
| `encodeCloseSession({ gridId })` | variant 1 |
| `encodeDepositFee({ lamports })` | variant 2 |
| `encodeDelegate({ gridId })` | variant 3 |
| `encodeUndelegate()` | variant 4 |

### Account data parsing

After `getAccountInfo` returns `data: Uint8Array`:

| Method | Description |
|------|------|
| `parseSession(data)` | Session state |
| `parseFeeVault(data)` | FeeVault |
| `parseDelegationRecord(data)` | DelegationRecord |
| `parseDepositReceipt(data)` | DepositReceipt |

You can combine with constants like `SESSION_DISCRIMINATOR` for type discrimination.

---

## Helpers

### `encodeSystemProgramAssignData(newProgramOwner: PublicKey): Uint8Array`

Builds **System Program** `Assign` instruction data (to change an account’s owner to a new program).  
Typical use: with `TransactionInstruction`, `programId` is `SystemProgram.programId`, signed by the account itself.

---

## Type exports

The main entry re-exports from `./types`, mainly:

- `NorthStarConfig`
- `AccountInfo`
- `ReadTransactionParams`
- `EphemeralRollupAccountResponse` (Rollup RPC response shape)
- `Address` (alias for `PublicKey`)

Plus `TransactionResult`, `TransactionOptions`, various `*V1Signers`, `WalletSignTransaction`, etc. (see `src/index.ts`).

---

## Integration tests and environment variables

**`tests/real-integration.test.ts`** is a real on-chain integration example (requires Portal and RPC). Common environment variables:

| Variable | Description |
|------|------|
| `PORTAL_PROGRAM_ID` | Portal program ID (Base58) |
| `TRANSFER_SOURCE_PRIVATE_KEY` | Funding private key Base58 (for test transfers) |

Run unit tests (excluding integration):

```bash
npm test
```

Integration tests only:

```bash
npm run test:integration
```

---

## Other modules in source

- **`src/config/networks.ts`**: Example `NETWORKS` constants (**not** exported from the package main entry); copy or maintain your own RPC list as needed.
- **`src/builders/TransactionBuilder.ts`**: Another “structured” transaction layout (`programPublicKey` / `role`); **not currently exported from `src/index.ts`**; import from source paths if needed and keep account layout consistent with `NorthStarSDK`’s built-in instructions.

---

## License

MIT
