# Stovia API

Backend API + Helius webhook indexer for Stovia (Solana **mainnet-beta** only).
Plain ESM JavaScript on Node 22 (no build step), Fastify 5, `@solana/web3.js@1`, zod, `pg`.

## Run

```bash
npm ci
npm start            # node src/index.js, listens on 0.0.0.0:$PORT (default 8080)
```

Boots with no database and no RPC configured (in-memory store, public mainnet RPC).
Set `NETWORK` to anything other than `mainnet-beta` and it refuses to start.

## Env

See `.env.example`. `PORT`, `NETWORK`, `HELIUS_RPC_URL`, `HELIUS_WEBHOOK_SECRET`, `PROGRAM_ID`,
`COMPANY_WALLET`, `CORS_ORIGINS` (+ any `https://*.vercel.app`), `DATABASE_URL` (optional; tables
auto-created on boot), `RATE_LIMIT_MAX` (per IP per minute, default 300), `LOG_LEVEL`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok, network, programDeployed, db, version}`; program check cached 60s |
| GET | `/config` | public config: program id, company wallet, fee bps, Privacy Rings ids |
| GET | `/tokens`, `/tokens/:mint` | list supports `?limit=&offset=` |
| GET | `/markets`, `/markets/:id` | `?status=open|revealing|settled`; `:id` = market or mint |
| GET | `/stats` | counts, volume, survival rate, indexer counters |
| GET | `/creators`, `/creators/:address` | leaderboard (survived, then volume) |
| POST | `/webhooks/helius` | `Authorization` must equal `HELIUS_WEBHOOK_SECRET` |

Lists return `{items, total, limit, offset}` and are empty until the program emits events.
Bet sides are never returned before a bet is revealed; unrevealed bets expose only the commitment.

## Indexer

Accepts Helius enhanced or raw webhook payloads (array or single object). Transactions that touch
`PROGRAM_ID` are stored raw (idempotent on signature). Anchor events are decoded from
`Program data:` logs (enhanced payloads have no logs, so they are fetched via RPC best effort).
Known events: `LaunchCreated`, `Trade`, `BetCommitted`, `BetRevealed`, `MarketSettled`, `Claimed`
(discriminator `sha256("event:<Name>")[0..8]`). Field layouts live in `src/anchor.js`
(`EVENT_LAYOUTS`) and must match the program's IDL; unknown or undecodable events are kept raw.

Helius webhook setup: URL `https://<railway-domain>/webhooks/helius`, account address = program id,
auth header = your secret. Returns 500 on storage errors so Helius retries.

Local test: `node scripts/sample-webhook.js > /tmp/p.json` then
`curl -X POST -H 'authorization: <secret>' -H 'content-type: application/json' --data @/tmp/p.json localhost:8080/webhooks/helius`.

## Railway

Root directory `backend/`. `railway.json` uses Nixpacks (Node 22 via `nixpacks.toml`),
start `node src/index.js`, healthcheck `/health`. Add the Postgres plugin and reference
`DATABASE_URL` to persist data.
