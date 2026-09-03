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

## Cloudflare Workers deployment

The Worker is configured in `wrangler.jsonc` and currently exposes only
`GET /health` at the deployed Worker URL (for example,
`https://slack-food-bot.<your-subdomain>.workers.dev/health`).

For a local health-only preview, copy the safe placeholder configuration into
the existing ignored `.env` file before starting Wrangler. These values are
only schema-valid local placeholders; they do not enable Slack, Redis, target,
or AI integrations:

```sh
cp .env.example .env
pnpm dev:workers
```

Then request the local URL printed by Wrangler with `/health`. Without the
required local bindings in `.env`, the Worker intentionally returns HTTP 500
because it validates configuration before routing.

Use the authenticated publication command only after configuring deployed
Worker secrets:

```sh
pnpm deploy:workers
```

Set each required Worker secret interactively before publishing; do not put
values in `wrangler.jsonc`, source control, or shell history. The required
names are `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
`REDIS_URL`, `TARGET_API_BASE_URL`, `TARGET_API_CLIENT_ID`, `TARGET_API_CLIENT_SECRET`,
and `BOT_STATE_ENCRYPTION_KEY`:

```sh
wrangler secret put SLACK_CLIENT_ID
```

Repeat `wrangler secret put <NAME>` for every required name. `PORT` is only for
the Node HTTP server. `TELEMETRY_ENVIRONMENT` and `DEFAULT_TIME_ZONE` are
non-secret Worker variables defined in `wrangler.jsonc`; the latter is the IANA
timezone used when Slack cannot return a sender's profile timezone.
`TELEMETRY_DSN` is optional and should be set with
`wrangler secret put TELEMETRY_DSN` only when telemetry is enabled.
The Cloudflare deployment always uses the native `AI` binding declared in
`wrangler.jsonc`; provider credentials and provider-selection secrets do not
participate in Worker routing.

Sender-local meal times require the `users:read` bot scope declared in
`slack-app-manifest.json`. Apply that manifest change to the Slack app before
rollout, then reauthorize every existing workspace by opening
`<PUBLIC_BASE_URL>/slack/install`; deployed code cannot add scopes to an
existing bot token. Until reauthorization succeeds, the bot uses
`DEFAULT_TIME_ZONE` rather than blocking food logging.

Upstash Redis is future integration configuration only: no Upstash connection
or Redis store is active in the Worker runtime today. Before planning traffic,
review Cloudflare's current free-tier limits: 100,000 requests per day, 10 ms
CPU time per HTTP request, 128 MB memory, 50 subrequests per invocation, and
64 environment variables per Worker. Limits reset or change under Cloudflare's
plan rules, so consult the [Workers limits documentation](https://developers.cloudflare.com/workers/platform/limits/)
before production use.

## Boundaries

- Pending food remains in bot-owned Redis until a future explicit confirmation
  workflow calls a target.
- Target responses own canonical entry IDs and daily nutrition summaries; the
  bot does not calculate progress or expenditure calories.
- Account erasure cleanup is explicit, repeat-safe, and scoped by opaque target
  subject; Slack installations are not stored in a target database.

## Handoff state

The external API contract must carry an explicit approval marker before
implementing live Dofek transport.
