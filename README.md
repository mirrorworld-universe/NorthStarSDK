# North Star SDK

TypeScript SDK for interacting with North Star portal flows on Solana and Sonic's Ephemeral Rollup.

## Install

```bash
npm install
```

## Core scripts

```bash
npm run build
npm run typecheck
npm test
npm run test:integration
```

## Live price feed demo

A full-stack example now lives at `examples/live-price-feed/`.

It uses:
- `NorthStarSDK` for RPC connectivity
- native Pyth push-oracle PDA derivation plus Anchor Borsh decoding for Solana Devnet accounts
- a tiny Node backend that streams updates over Server-Sent Events
- a browser UI that shows current prices and updates per second

Run it with:

```bash
npm install
npm run demo:live-price-feed
```

Then open:

```bash
http://localhost:3000
```

See `examples/live-price-feed/README.md` for the architecture and environment variables.
