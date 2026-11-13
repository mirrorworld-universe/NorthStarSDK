# Northstar SDK

TypeScript bindings for the unreleased Northstar continuity protocol. This branch
accepts only the framed session, receipt and bridge accounts used by that protocol.
It does not fall back to legacy instruction selectors or account layouts.

The native runtime must enable `checkpoint-continuity-v2`. These bindings do not
establish hosted deployment qualification or new proof acceptance.

## Build and test

```bash
npm ci
npm run build
npm test -- --runInBand
```

The default test command excludes funded live tests. Unit tests use deterministic
RPC fixtures; they are not evidence of a deployed validator lifecycle.

## Explicit deployment identity

Obtain all identities from the actual deployment. The SDK provides no production
checkpoint profile or implicit shared bridge deployment.

```typescript
import { NorthStarSDK, PublicKey } from "@sonicsvm/northstar-sdk";

function connect(deployment: {
  portal: PublicKey;
  tokenBridge: PublicKey;
  l1GenesisHash: string;
  checkpointProfile: Uint8Array;
  l1Rpc: string;
  erRpc: string;
}) {
  return new NorthStarSDK({
    portalProgramId: deployment.portal,
    tokenBridgeProgramId: deployment.tokenBridge,
    l1GenesisHash: deployment.l1GenesisHash,
    checkpointProfile: deployment.checkpointProfile,
    customEndpoints: {
      solana: deployment.l1Rpc,
      ephemeralRollup: deployment.erRpc,
    },
  });
}
```

The genesis hash must decode to exactly 32 nonzero bytes. The profile must also be
32 nonzero bytes. Before preparing L1 actions, the SDK verifies the RPC genesis.
Session actions additionally validate canonical address, ownership, incarnation,
profile, TTL and input counters. A stale input sequence fails on-chain; refresh the
snapshot only after resolving the previous transaction's outcome.

`getSessionSnapshot()` returns the L1 session, decoded state, context commitment
and next input sequence. `getExecutionSession()` additionally requires a healthy
ER runtime and the same session incarnation on both endpoints. Checkpoint errors,
missing session identity and malformed status fail closed.

## Supported L1 actions

- `buildOpenSession` / `openSession` bind the full network/profile identity and
  persistent session-epoch PDA. Pass the actual native validator in
  `OpenSessionConfig.validator` when it differs from the signing wallet.
- `buildDepositFee` / `depositFee` use a mutable session, context-derived receipt
  and the next authenticated input PDA.
- `buildDelegate` / `delegate` support at most two wallet accounts per transaction.
  The SDK stages System Program ownership transfer and reserves one input per
  account. Program-owned accounts require CPI from their owner program; a wallet
  signature cannot replace that authorization.
- `buildRegisterSessionBridgeInstruction` requires the session authority and
  configured bridge program. Registration is not permissionless.

Amounts accept `bigint` or safe integer numbers. Encoders reject overflow, unsafe
number precision, nonpositive amounts and out-of-range mint decimals.

Wallet methods first apply local signatures, then call `WalletSignTransaction`.
They send to L1 and confirm by bounded HTTP polling. Preflight is enabled by
default. A confirmation timeout is an uncertain outcome, not permission to sign a
replacement transaction.

```typescript
import { signVersionedTransaction } from "@sonicsvm/northstar-sdk";

await sdk.depositFee(
  user.publicKey,
  10_000_000n,
  async transaction => signVersionedTransaction(transaction, [user]),
  {},
);
```

Builder-only methods return instructions, fee payer, blockhash and last valid
block height. `buildDelegate` also returns buffer keypairs that must sign.

## Token custody and delegation

Low-level token builders do not sign, send or establish RPC readiness. Use a fresh
L1 snapshot for input creation and an execution snapshot before ER submission.
Their explicit context and sequence allow composition without hidden counters.

```typescript
const snapshot = await sdk.getSessionSnapshot();
const registry = await sdk.portal.deriveSessionBridgePDA(snapshot.context, mint);
const erTokenAccount = sdk.tokenBridge.deriveErTokenAccountPDA(registry, owner);

const deposit = sdk.buildTokenBridgeDepositInstruction({
  payer,
  owner,
  session: snapshot.address,
  sessionContext: snapshot.context,
  sequence: snapshot.nextSequence,
  sessionBridge: registry,
  vault: sdk.tokenBridge.deriveVaultPDA(registry),
  erTokenAccount,
  sourceTokenAccount,
  vaultTokenAccount,
  mint,
  tokenProgram,
  amount: 600n,
  decimals: 6,
});
```

`buildInitializeTokenVaultInstruction` and
`buildInitializeErTokenAccountInstruction` initialize custody metadata.
`buildDelegateErTokenAccountInstruction` takes the same explicit session context,
sequence and mint, plus `gridId`. Its 13-account contract includes the origin
baseline and authenticated input. The bridge signs its account PDA during CPI.
A program-owned token authority must provide its own signed CPI; `payer` remains a
separate funded signer.

Deposits use the 17-account custody/input contract. The SDK rejects mismatched
registry, owner-derived ER account, vault and session bindings. The on-chain
programs remain responsible for custody and instruction authorization.

Before the first token deposit, call `depositFee` with the session validator as
recipient to fund the runtime manager's ER SOL balance. The manager signs
authenticated token-input executions and pays their fees and cursor rent,
independently of the user transaction fee payer. L1 SOL alone does not fund it.
This SOL funding input must precede the token input in session ingress order.

## Deferred payouts

`buildErSolWithdrawalInstructions` constructs Portal `StartWithdrawal` after
checking L1/ER identity and runtime health. Submit its instructions to
`getEphemeralRpc()`, not L1. `buildErSolWithdrawal` uses the same account as source
and recipient.

For SPL, call `getExecutionSession()` and pass its context to
`buildTokenBridgeStartWithdrawalInstruction`. Include `mint`: the seven-account
contract checks mint decimals before the ER debit. Settlement pays the destination
on L1 later. An ER debit alone is not evidence of payout; inspect the finalized L1
destination balance and settlement status.

`buildTokenBridgeTransferInstruction` constructs an ER token transfer without a
payout. It does not submit transactions.

## ER transaction submission

Use `sdk.sendAndConfirmErTransaction(signedTransaction, options)` for transactions
already built and signed for `getEphemeralRpc()`. It pins the execution session,
polls ER receipts, and retries only the exact checkpoint-settlement-pending
`SendTransactionError` with an empty submission signature. Every broadcast uses
the original signed bytes; it never refreshes the blockhash or signs a replacement.
Other errors propagate. An observed receipt suppresses further broadcasts even if
a later status poll returns null. Defaults are a five-minute timeout, 500 ms polling,
and at most 600 attempts. Timeout/expiry requires reconciling the saved signature,
not generating another request. Existing L1 submission methods are unchanged.

For checkpoint-gated VRF, use `calculateErVrfDeadlineSlots(budget, limits)` with the
actual ER slot duration and Coordinator limits. Include checkpoint wait,
challenge/finality, queue wait, delivery, and a safety margin in milliseconds.
For example, 60,000 + 30,000 + 60,000 + 30,000 + 60,000 ms at 10 ms per ER slot
requires 24,000 slots. The helper rounds up and rejects an insufficient ceiling;
it does not silently clamp to the old L1-oriented 1,000-slot limit. This is budget
calculation, not a latency guarantee or an on-chain configuration update.

## Unavailable lifecycle operations

Close-session, undelegation, undelegation-request and immediate token-payout APIs
currently throw before signing. They are not implemented continuity lifecycle
bindings. No legacy instruction is emitted as a substitute.

## Funded live tests

`npm run test:integration` exercises wallet delegation, explicit SOL credit, two
payouts and a later top-up. `npm run test:spl-token-live` exercises token custody,
owner-program delegation, ER transfer and deferred SPL payout. Both require a
running matching native runtime; they do not start or restart a validator.

Set `PORTAL_PROGRAM_ID`, `TOKEN_BRIDGE_PROGRAM_ID`, `VALIDATOR_IDENTITY`,
`L1_GENESIS_HASH`, `CHECKPOINT_PROFILE` (64 hex digits), and
`TRANSFER_SOURCE_PRIVATE_KEY` (base58). Set `VALIDATOR_RPC` and
`EPHEMERAL_ROLLUP_RPC` for the actual endpoints; `NORTHSTAR_GRID_ID` defaults to 0.
Existing sessions must match the expected authority, validator, grid and profile.
They are never closed or reset automatically.

Funded tests reject mainnet. Other than the exact devnet genesis, they permit only
loopback L1 endpoints inside `NORTHSTAR_SANDBOX=1`. They use disposable development
accounts and leave active delegated state; do not use production funding keys.
A type-checked live test is not a successful live run or restart qualification.
The [local RPC report](tests/evidence/continuity-local-rpc.json) records SPL custody,
transfer and payout, retained balances after a same-ledger restart, and two SOL
payouts after that restart. It does not qualify hosted deployment or proof acceptance.

## Wire contract

`PortalProgram` parses exact-length frames: Session 378 bytes, DepositReceipt 137
bytes and SessionBridge 209 bytes. It rejects legacy frames and trailing bytes.
The stable embedded structs are part of these frames, not an alternate API.

Session commitments match native `SessionIdentityV2`: domain-separated Borsh,
full little-endian `u128` nonce and SHA-256 with the protocol field mask. Tests
include independently generated native vectors for low and high nonce bits.

Context-derived PDA seeds use `session_bridge_v2`, `deposit_receipt_v2` and
`ingress_v2`. The session context binds L1 genesis, Portal, session, nonce, grid,
validator and checkpoint profile. Never reuse an old context after reopening a
session.

## License

MIT
