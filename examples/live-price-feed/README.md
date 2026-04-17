# Live Price Feed Demo

This example uses `NorthStarSDK` as the Solana connection layer and subscribes to Pyth push-oracle price feed accounts on Solana Devnet.

## What it shows

- current token prices for `SOL/USD`, `BTC/USD`, and `ETH/USD`
- aggregate stream updates per second across all tracked feeds
- per-token update rate, publish time, observed slot, and feed account address
- a tiny backend that streams updates to the browser over Server-Sent Events

## Run it

From the repo root:

```bash
npm install
npm run demo:live-price-feed
```

Then open:

```bash
http://localhost:3000
```

## Environment variables

- `PORT` - HTTP port, defaults to `3000`
- `SOLANA_RPC_URL` - defaults to `https://api.devnet.solana.com`
- `EPHEMERAL_ROLLUP_RPC_URL` - defaults to `https://ephemeral.devnet.sonic.game`
- `PORTAL_PROGRAM_ID` - optional for this read-only demo. If omitted, the example falls back to the Solana system program ID because the demo only needs the SDK's connection layer.

## Architecture

1. `NorthStarSDK` boots the Solana and Ephemeral Rollup RPC clients.
2. The backend derives Pyth push-oracle PDAs directly from the feed id and shard id.
3. A tiny Anchor Borsh coder decodes the `priceUpdateV2` account layout without depending on the receiver runtime package.
4. The backend subscribes to account changes with `Connection.onAccountChange` and emits a 1 Hz heartbeat snapshot so the UI stays visibly live even when Devnet feed accounts are quiet.
5. The browser listens on `/events` and refreshes the dashboard live.
