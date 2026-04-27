# North Star SDK

用于在 Solana 上与 **Ephemeral Rollup（临时 Rollup）** 交互，并构造 **Portal** 链上程序的 TypeScript/JavaScript SDK。

- **依赖**：`@solana/web3.js`、`@dao-xyz/borsh`、`axios`、`bs58`
- **入口**：构建后为 `dist/index.js`，类型声明为 `dist/index.d.ts`

---

## 安装与构建

```bash
npm install
npm run build
```

在其它项目中本地引用示例：

```json
{
  "dependencies": {
    "north-star-sdk": "file:../NorthStarSDK"
  }
}
```

---

## 快速开始

### 1. 配置 `NorthStarConfig`

```typescript
import { NorthStarSDK, PublicKey } from "north-star-sdk";

const sdk = new NorthStarSDK({
  portalProgramId: new PublicKey("你的Portal程序ID"),
  customEndpoints: {
    solana: "https://api.devnet.solana.com",
    ephemeralRollup: "https://ephemeral.devnet.sonic.game",
  },
});
```

| 字段 | 说明 |
|------|------|
| `portalProgramId` | Portal 程序在 Solana 上的公钥 |
| `customEndpoints.solana` | Solana L1 JSON-RPC |
| `customEndpoints.ephemeralRollup` | Ephemeral Rollup 的 JSON-RPC |

构造完成后，SDK 会在控制台打印初始化信息（RPC 与 Portal 程序地址）。

### 2. 钱包签名回调 `WalletSignTransaction`

多数上链方法采用 **「本地部分签名 + 钱包补签」** 流程：

1. SDK 用 `Connection.getLatestBlockhash` 组装 `VersionedTransaction`
2. 使用 `signers` 里提供的 `Keypair` 做本地签名（如被委托账户）
3. 调用你传入的 `signTransaction`，由钱包（或本地 keypair）完成剩余签名
4. 广播并在 L1 上确认（HTTP 轮询，不依赖 WebSocket）

类型定义：

```typescript
type WalletSignTransaction = (
  transaction: VersionedTransaction,
) => Promise<VersionedTransaction>;
```

**纯本地测试**（无浏览器钱包）可模拟钱包：对交易再签一次所需 keypair，例如集成测试中的写法：

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

主入口同时导出 `signVersionedTransaction`、`getVersionedTxSignatureBase58`、`toPublicKey`，便于与 `VersionedTransaction` 组合使用。

---

## 核心类：`NorthStarSDK`

### 连接与程序

| 方法 | 说明 |
|------|------|
| `getRpc()` | Solana L1 的 `Connection`（commitment 为 `confirmed`） |
| `getEphemeralRpc()` | Ephemeral Rollup 的 `Connection` |
| `getPortalProgramId()` | Portal 程序 `PublicKey` |
| `portal` | `PortalProgram` 实例（PDA 推导、指令编码、账户解析） |
| `accountResolver` | `AccountResolver`，按数据源解析账户 |

### 密钥工具

| 方法 | 说明 |
|------|------|
| `generateKeyPair()` | 生成新的 `Keypair` |
| `createKeyPairFromBase58(privateKeyBase58)` | 从 Base58 私钥导入（支持 32 字节 seed 或 64 字节 secret key） |

### 账户读取

| 方法 | 说明 |
|------|------|
| `getAccountInfo(address, search_source)` | 查询单个账户 |
| `getMultipleAccounts(addresses, search_source)` | 批量查询 |

**`search_source` 实际行为**（需显式指定，不会自动降级）：

- `"ephemeral"`：仅通过 Ephemeral Rollup RPC 的 `getAccountInfo` 读取；失败则抛错。
- `"solana"`：仅通过 L1 `Connection.getAccountInfo` 读取；账户不存在则抛错。

返回类型 `AccountInfo`：

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

结合 `sdk.portal.parseSession` 等可解析 Portal 相关账户数据（见下文 **PortalProgram**）。

### 健康检查

| 方法 | 说明 |
|------|------|
| `checkHealth()` | 返回 `{ solana: boolean, ephemeralRollup: boolean }` |

### 交易发送与确认

| 方法 | 说明 |
|------|------|
| `sendAndConfirmTransactionWithoutWebsocket(tx, options?)` | 发送已签名的 `VersionedTransaction`，HTTP 轮询确认 |
| `confirmSignature(signature, options?)` | 仅等待给定签名达到指定 commitment |

**`TransactionOptions`**（可选）：

| 字段 | 说明 |
|------|------|
| `commitment` | `"processed"` \| `"confirmed"` \| `"finalized"`（默认 `"confirmed"`） |
| `skipPreflight` | 是否跳过预检（默认 `true`） |
| `maxAttempts` | 确认轮询最大次数（默认 `20`） |
| `intervalMs` | 轮询间隔毫秒（默认 `1000`） |

---

## Portal 链上操作（一键发送）

以下方法内部会组 `VersionedTransaction`，先本地签 `signers` 中的 keypair，再调用 `signTransaction`，最后 `sendAndConfirmTransactionWithoutWebsocket`。

### `openSession`

打开会话（创建 Session PDA、关联 FeeVault 等，具体以链上程序为准）。

```typescript
await sdk.openSession(
  user,                    // PublicKey：用户/付费者（指令中的 user）
  gridId,                  // number
  ttlSlots,                // 可选，默认 2000
  feeCap,                  // 可选，默认 1_000_000（lamports，bigint 语义在编码时处理）
  signTransaction,
  signers,                 // SessionV1Signers
  options?,
);
```

**`SessionV1Signers`**：`{ feePayerSigner?: Keypair }`  
未提供 `feePayerSigner` 时，fee payer 为 `user`。

### `closeSession`

关闭指定 `gridId` 的会话。

```typescript
await sdk.closeSession(
  user,
  gridId,
  signTransaction,
  signers,                 // SessionV1Signers
  options?,
);
```

若传入 `feePayerSigner`，其公钥必须与 fee payer 一致，否则抛错。

### `depositFee`

向某用户的会话存入 `lamports` 费用。

```typescript
await sdk.depositFee(
  user,                    // 存款人（签名账户）
  sessionOwner,            // 会话所有者 PublicKey
  gridId,
  lamports,                // number
  signTransaction,
  signers,                 // DepositFeeV1Signers
  options?,
);
```

**`DepositFeeV1Signers`**：`{ depositorSigner?: Keypair; feePayerSigner?: Keypair }`  
省略时由 `user` 对应钱包完成签名；本地可先签 `depositorSigner` / `feePayerSigner` 再交给钱包。

### `delegate`

将 **已由 Portal 程序拥有的账户** 委托到指定 grid（指令数据含 `gridId`）。  
参数 **`ownerProgramId`** 为 **undelegate 时账户应归还的 owner 程序**，同时也是 Portal 内部 buffer 账户的 owner（常见流程：先把账户 assign 给 Portal，再 delegate 并指定 `ownerProgramId`）。

SDK 会自动生成一个 0 字节的 buffer Keypair 并预置 `system::createAccount`（owner=`ownerProgramId`），以满足合并后的 Portal::Delegate 强制要求 buffer 账户的约定（参见 northstar#59）。

```typescript
await sdk.delegate(
  user,                    // PublicKey：支付/主签名人
  gridId,
  ownerProgramId,          // PublicKey
  signTransaction,
  signers,                 // DelegateV1Signers
  options?,
);
```

**`DelegateV1Signers`**：

```typescript
{
  delegatedAccountSigner: Keypair;  // 被委托账户，需参与签名
  feePayerSigner?: Keypair;
}
```

### `undelegate`

撤销委托并把账户归还给 `ownerProgramId`。

```typescript
await sdk.undelegate(
  user,
  ownerProgramId,          // 必须等于 delegate 时传入的同一个 owner 程序
  signTransaction,
  signers,                 // 同 DelegateV1Signers
  options?,
);
```

### `delegate_v1`

与 `delegate` 相同，为向后兼容别名，**已弃用**。

---

## 仅构造指令（不发送）

用于自定义组合交易或在外部钱包中展示：

| 方法 | 返回 |
|------|------|
| `buildOpenSession(signer, gridId, ttlSlots?, feeCap?)` | `{ instructions, feePayer, blockhash, lastValidBlockHeight }` |
| `buildCloseSession(signer, gridId)` | 同上 |
| `buildDepositFee(signer, sessionOwner, gridId, lamports)` | 同上 |
| `buildDelegate(signer, delegatedAccount, gridId, ownerProgramId)` | 返回额外字段 `buffer: Keypair`；交易签名时必须把 `buffer` 与 `signer`、`delegatedAccount` 一并加入签名集。 |
| `buildUndelegate(signer, delegatedAccount, ownerProgramId)` | 同上 |

其中 `instructions` 为 `TransactionInstruction[]`，`feePayer` 为 `signer.publicKey`。

---

## `PortalProgram`

通过 `sdk.portal` 或 `new PortalProgram(programId)` 使用（SDK 内已绑定配置中的程序 ID）。

### PDA 推导（静态/实例均可）

| 方法 | Seeds（概念） |
|------|----------------|
| `deriveSessionPDA(owner, gridId)` | `session` + owner + `gridId` (u64 LE) |
| `deriveFeeVaultPDA(owner)` | `fee_vault` + owner |
| `deriveDelegationRecordPDA(delegatedAccount)` | `delegation` + delegatedAccount |
| `deriveDepositReceiptPDA(session, recipient)` | `deposit_receipt` + session + recipient |

### 指令编码（Borsh）

| 方法 | 说明 |
|------|------|
| `encodeOpenSession({ gridId, ttlSlots, feeCap })` | variant 0 |
| `encodeCloseSession({ gridId })` | variant 1 |
| `encodeDepositFee({ lamports })` | variant 2 |
| `encodeDelegate({ gridId })` | variant 3 |
| `encodeUndelegate()` | variant 4 |

### 账户数据解析

在 `getAccountInfo` 取得 `data: Uint8Array` 后：

| 方法 | 说明 |
|------|------|
| `parseSession(data)` | Session 状态 |
| `parseFeeVault(data)` | FeeVault |
| `parseDelegationRecord(data)` | DelegationRecord |
| `parseDepositReceipt(data)` | DepositReceipt |

可结合 `SESSION_DISCRIMINATOR` 等常量做类型判别。

---

## 辅助函数

### `encodeSystemProgramAssignData(newProgramOwner: PublicKey): Uint8Array`

构造 **System Program** `Assign` 指令的 instruction data（用于将账户 owner 改为新程序）。  
典型用法：配合 `TransactionInstruction`，`programId` 为 `SystemProgram.programId`，由账户自身签名。

---

## 类型导出

主入口从 `./types` 再导出，主要包括：

- `NorthStarConfig`
- `AccountInfo`
- `ReadTransactionParams`
- `EphemeralRollupAccountResponse`（Rollup RPC 响应形状）
- `Address`（即 `PublicKey`）

以及 `TransactionResult`、`TransactionOptions`、各类 `*V1Signers`、`WalletSignTransaction` 等（见 `src/index.ts`）。

---

## 集成测试与环境变量

仓库内 **`tests/real-integration.test.ts`** 为真实链上集成示例（需 Portal 与 RPC）。常用环境变量：

| 变量 | 说明 |
|------|------|
| `PORTAL_PROGRAM_ID` | Portal 程序 ID（Base58） |
| `TRANSFER_SOURCE_PRIVATE_KEY` | 资助用私钥 Base58（测试转账） |

运行单元测试（不含集成）：

```bash
npm test
```

仅集成测试：

```bash
npm run test:integration
```

---

## 源码中的其它模块

- **`src/config/networks.ts`**：示例性的 `NETWORKS` 常量（**未**从包主入口导出），可按需复制或自行维护 RPC 列表。
- **`src/builders/TransactionBuilder.ts`**：另一种「结构化」交易拼装格式（`programPublicKey` / `role`），**当前未从 `src/index.ts` 导出**；若使用需自行从源码路径引用并注意与 `NorthStarSDK` 内置指令布局的一致性。

---

## 许可证

MIT
