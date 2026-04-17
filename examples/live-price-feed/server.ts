import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { createServer, type ServerResponse } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { NorthStarSDK } from "../../src";
import {
  DEFAULT_LIVE_PRICE_FEEDS,
  DEFAULT_PUSH_ORACLE_PROGRAM_ID,
  RollingWindowRateTracker,
  getPriceFeedAccountAddress,
  scalePythPrice,
} from "../../src/utils/livePriceFeed";

type PriceAccount = {
  writeAuthority: PublicKey;
  verificationLevel: { partial?: { numSignatures: number }; full?: Record<string, never> };
  priceMessage: {
    feedId: number[];
    price: bigint | { toString(): string };
    conf: bigint | { toString(): string };
    exponent: number;
    publishTime: bigint | { toString(): string };
    prevPublishTime: bigint | { toString(): string };
    emaPrice: bigint | { toString(): string };
    emaConf: bigint | { toString(): string };
  };
  postedSlot: bigint | { toString(): string };
};

type FeedSnapshot = {
  symbol: string;
  feedId: string;
  accountAddress: string;
  price: number | null;
  confidence: number | null;
  exponent: number | null;
  publishTime: number | null;
  postedSlot: number | null;
  observedSlot: number | null;
  updatesPerSecond: number;
  status: "connecting" | "live" | "error";
  lastObservedAt: string | null;
  error: string | null;
};

type FeedState = {
  symbol: string;
  feedId: string;
  accountPublicKey: PublicKey;
  accountAddress: string;
  tracker: RollingWindowRateTracker;
  snapshot: FeedSnapshot;
};

const PYTH_PRICE_FEED_IDL: Idl = {
  version: "0.1.0",
  name: "pyth_solana_receiver",
  accounts: [
    {
      name: "priceUpdateV2",
      type: {
        kind: "struct",
        fields: [
          { name: "writeAuthority", type: "publicKey" },
          { name: "verificationLevel", type: { defined: "VerificationLevel" } },
          { name: "priceMessage", type: { defined: "PriceFeedMessage" } },
          { name: "postedSlot", type: "u64" },
        ],
      },
    },
  ],
  types: [
    {
      name: "PriceFeedMessage",
      type: {
        kind: "struct",
        fields: [
          { name: "feedId", type: { array: ["u8", 32] } },
          { name: "price", type: "i64" },
          { name: "conf", type: "u64" },
          { name: "exponent", type: "i32" },
          { name: "publishTime", type: "i64" },
          { name: "prevPublishTime", type: "i64" },
          { name: "emaPrice", type: "i64" },
          { name: "emaConf", type: "u64" },
        ],
      },
    },
    {
      name: "VerificationLevel",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Partial",
            fields: [{ name: "numSignatures", type: "u8" }],
          },
          { name: "Full" },
        ],
      },
    },
  ],
} as unknown as Idl;

const priceFeedCoder = new BorshAccountsCoder(PYTH_PRICE_FEED_IDL);
const shardId = Number(process.env.PYTH_SHARD_ID ?? 0);
const port = Number(process.env.PORT ?? 3000);
const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ephemeralRollupRpcUrl =
  process.env.EPHEMERAL_ROLLUP_RPC_URL ?? "https://ephemeral.devnet.sonic.game";
const portalProgramId = new PublicKey(
  process.env.PORTAL_PROGRAM_ID ?? SystemProgram.programId.toBase58(),
);
const publicDir = path.join(__dirname, "public");
const htmlPath = path.join(publicDir, "index.html");

const sdk = new NorthStarSDK({
  portalProgramId,
  customEndpoints: {
    solana: solanaRpcUrl,
    ephemeralRollup: ephemeralRollupRpcUrl,
  },
});

const aggregateTracker = new RollingWindowRateTracker();
const clients = new Set<ServerResponse>();
const feedStates = new Map<string, FeedState>();
let htmlCache = "";

function createEmptySnapshot(symbol: string, feedId: string, accountAddress: string): FeedSnapshot {
  return {
    symbol,
    feedId,
    accountAddress,
    price: null,
    confidence: null,
    exponent: null,
    publishTime: null,
    postedSlot: null,
    observedSlot: null,
    updatesPerSecond: 0,
    status: "connecting",
    lastObservedAt: null,
    error: null,
  };
}

function decodePriceAccount(data: Buffer): PriceAccount {
  return priceFeedCoder.decode("priceUpdateV2", data) as PriceAccount;
}

function toNumeric(value: bigint | { toString(): string }): number {
  return Number(value.toString());
}

function buildSnapshot(
  state: FeedState,
  account: PriceAccount,
  observedSlot: number | null,
): FeedSnapshot {
  return {
    symbol: state.symbol,
    feedId: state.feedId,
    accountAddress: state.accountAddress,
    price: scalePythPrice(account.priceMessage.price, account.priceMessage.exponent),
    confidence: scalePythPrice(
      account.priceMessage.conf,
      account.priceMessage.exponent,
    ),
    exponent: account.priceMessage.exponent,
    publishTime: toNumeric(account.priceMessage.publishTime),
    postedSlot: toNumeric(account.postedSlot),
    observedSlot,
    updatesPerSecond: state.tracker.rate(),
    status: "live",
    lastObservedAt: new Date().toISOString(),
    error: null,
  };
}

function captureError(state: FeedState, error: unknown): void {
  state.snapshot = {
    ...state.snapshot,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    updatesPerSecond: state.tracker.rate(),
  };
}

function payload() {
  const feeds = Array.from(feedStates.values())
    .map((state) => ({
      ...state.snapshot,
      updatesPerSecond: state.tracker.rate(),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    timestamp: new Date().toISOString(),
    network: "solana-devnet",
    transport: "solana-account-change-websocket",
    solanaRpcUrl,
    ephemeralRollupRpcUrl,
    portalProgramId: portalProgramId.toBase58(),
    pushOracleProgramId: DEFAULT_PUSH_ORACLE_PROGRAM_ID.toBase58(),
    shardId,
    aggregate: {
      totalFeeds: feeds.length,
      liveFeeds: feeds.filter((feed) => feed.status === "live").length,
      updatesPerSecond: aggregateTracker.rate(),
    },
    feeds,
  };
}

function broadcast(event: string): void {
  aggregateTracker.record();
  const body = `event: ${event}\ndata: ${JSON.stringify(payload())}\n\n`;
  for (const client of clients) {
    client.write(body);
  }
}

async function syncInitialState(state: FeedState): Promise<void> {
  const accountInfo = await sdk.getRpc().getAccountInfo(state.accountPublicKey, "confirmed");
  if (!accountInfo) {
    throw new Error(`No account found for ${state.symbol} at ${state.accountAddress}`);
  }

  state.snapshot = buildSnapshot(state, decodePriceAccount(accountInfo.data), null);
}

async function startFeed(state: FeedState): Promise<void> {
  await syncInitialState(state);

  await sdk.getRpc().onAccountChange(
    state.accountPublicKey,
    (accountInfo, context) => {
      try {
        state.tracker.record();
        state.snapshot = buildSnapshot(
          state,
          decodePriceAccount(accountInfo.data),
          context.slot,
        );
        broadcast("price-update");
      } catch (error) {
        captureError(state, error);
        broadcast("price-error");
      }
    },
    "confirmed",
  );
}

async function loadHtml(): Promise<string> {
  if (!htmlCache) {
    htmlCache = await readFile(htmlPath, "utf8");
  }

  return htmlCache;
}

async function handleRequest(res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    clients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(payload())}\n\n`);

    res.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (pathname === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload(), null, 2));
    return;
  }

  if (pathname === "/health") {
    const health = await sdk.checkHealth();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, health }, null, 2));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(await loadHtml());
}

async function bootstrap(): Promise<void> {
  for (const feed of DEFAULT_LIVE_PRICE_FEEDS) {
    const accountPublicKey = getPriceFeedAccountAddress(shardId, feed.feedId);
    const state: FeedState = {
      symbol: feed.symbol,
      feedId: feed.feedId,
      accountPublicKey,
      accountAddress: accountPublicKey.toBase58(),
      tracker: new RollingWindowRateTracker(),
      snapshot: createEmptySnapshot(feed.symbol, feed.feedId, accountPublicKey.toBase58()),
    };

    feedStates.set(feed.symbol, state);
  }

  await Promise.all(
    Array.from(feedStates.values()).map(async (state) => {
      try {
        await startFeed(state);
      } catch (error) {
        captureError(state, error);
      }
    }),
  );

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      await handleRequest(res, requestUrl.pathname);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  });

  setInterval(() => {
    broadcast("heartbeat");
  }, 1000).unref();

  server.listen(port, () => {
    console.log(`Live price feed demo running on http://localhost:${port}`);
    console.log(`Tracking ${DEFAULT_LIVE_PRICE_FEEDS.map((feed) => feed.symbol).join(", ")}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start live price feed demo", error);
  process.exit(1);
});
