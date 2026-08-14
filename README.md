# Slack Food Bot

Standalone, target-agnostic Slack food logging runtime. The bot owns Slack
OAuth/install state, pending drafts, deduplication, parsing, and user-facing
formatting. Confirmed nutrition writes go through a target adapter; the core
does not import target packages or access a target database.

## Current scope

This repository currently contains the tested foundation: strict configuration,
target-neutral nutrition contracts, Redis-compatible pending/deduplication
stores, intake-only parser validation, Block Kit formatting, and a secret-free
health endpoint. `targets/dofek` is fixture-only and is derived from the
evidenced external API OpenAPI 1.0.0/docs. It intentionally has no live Dofek
URL, HTTP client, authentication wiring, or database access until that API has
an explicit approval marker.

## Prerequisites

- Node `26.7.0`
- pnpm `11.17.0`
- Redis for production store adapters
- Docker for the container image

Install and verify the project:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
```

Run the health-only entrypoint after providing required configuration:

```sh
pnpm build
node dist/src/index.js
curl http://127.0.0.1:3000/health
```

Required configuration names are listed in `.env.example`; values are never
committed. Startup fails immediately and names missing or invalid keys.

## Boundaries

- Pending food remains in bot-owned Redis until a future explicit confirmation
  workflow calls a target.
- Target responses own canonical entry IDs and daily nutrition summaries; the
  bot does not calculate progress or expenditure calories.
- Account erasure cleanup is explicit, repeat-safe, and scoped by opaque target
  subject; Slack installations are not stored in a target database.

## Handoff state

This local worktree has no remote and no commits are being created. Add and
verify a remote before asking for the first commit/push. The external API
contract must also carry an explicit approval marker before implementing live
Dofek transport.
