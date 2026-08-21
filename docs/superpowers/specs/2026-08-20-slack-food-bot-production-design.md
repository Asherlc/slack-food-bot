# Slack Food Bot Production Design

## Goal

Deliver a separately deployed Slack food-logging bot. A Slack user can install
the app, link a Dofek account, describe food in a DM or app mention, review an
AI-generated itemized draft, refine it in the message thread, and explicitly
confirm or cancel it. Only confirmed entries are written to Dofek.

## Scope and boundaries

The bot owns Slack OAuth installations, Slack interaction state, Dofek-link
PKCE state, encrypted Dofek access tokens, pending drafts, delivery/action
deduplication, and queue jobs. Dofek owns user authorization, canonical food
rows, write idempotency receipts, nutrient resolution, and daily summaries.

The bot must never send Slack credentials, raw Slack payloads, Redis records,
or Dofek access tokens to Dofek. Dofek must never require access to bot Redis
or Slack installation state. The bot does not calculate calorie goals, daily
progress, energy expenditure, or nutrition totals locally.

## User interaction

1. A Slack administrator installs the app through `/slack/install` and Slack
   redirects to `/slack/oauth_redirect`. The bot stores the Slack installation
   encrypted in Redis, indexed by Slack team ID.
2. A user sends `link` to the bot in a DM or mentions the bot with `link`. The
   bot sends a personal Dofek authorization link. It starts Dofek linking with
   an S256 PKCE verifier and stores the verifier, link ID, Slack team/user
   subject, and an unguessable state value in Redis with the Dofek link TTL.
3. The user signs in to Dofek, approves nutrition-write access, and returns to
   `/dofek/link/callback`. The bot validates the state, exchanges the code,
   persists the encrypted grant/token record, and sends a Slack success message.
4. A linked user sends a food description in a DM or app-mentions the bot.
   The bot immediately acknowledges Slack, queues the work, and posts an
   itemized confirmation card after AI parsing succeeds.
5. A reply in the confirmation card's thread is a refinement instruction. The
   bot replaces the existing unconfirmed draft with a newly parsed version and
   updates the card. Only the original Slack user can refine the draft.
6. The user clicks **Confirm** or **Cancel**. The bot immediately acknowledges
   the interaction, queues the work, and updates the card with the terminal
   result. Confirm calls Dofek once; cancel removes the pending draft.

The first release handles DMs and `app_mention` events. It does not provide a
slash command, file/image parsing, natural-language date overrides, or shared
confirmation ownership.

## Slack and HTTP architecture

The public Node process uses `@slack/bolt` with an HTTP receiver mounted below
`/slack/events`. It verifies Slack signatures using the raw request body and
acknowledges every valid event, action, OAuth callback, and URL-verification
request before any AI, Redis, or Dofek work that might exceed Slack's
three-second deadline.

The public process exposes these routes:

- `GET /health` returns `{"status":"ok"}` without credentials or secrets.
- `GET /slack/install` starts Slack OAuth installation.
- `GET /slack/oauth_redirect` completes Slack OAuth installation.
- `POST /slack/events` is the Bolt events/actions receiver.
- `GET /dofek/link/callback` completes the Dofek PKCE flow and renders a
  secret-free browser success or failure page.

The bot requests only the Slack bot scopes required for this release:
`app_mentions:read`, `chat:write`, `im:history`, `im:read`, and `im:write`.
It subscribes to `app_mention` and DM `message.im` events. It ignores messages
from bots, message edits, duplicate deliveries, channels where it was not
mentioned, and terminal confirmation cards.

## Queueing and reliability

The public web service and a separate worker process share Redis. The web
service performs only signature verification, deterministic deduplication,
state lookup necessary to reject invalid requests, durable job enqueue, and
the Slack acknowledgement. The worker performs parsing, Dofek calls, and
Slack Web API updates.

Jobs have stable keys derived from Slack delivery IDs or action IDs. The
dedupe store prevents both Slack retries and queue retries from creating
duplicate drafts or Dofek writes. Queue retries apply only to transient AI,
Redis, Slack, and Dofek `429`/`503` failures. A non-retryable failure changes
the confirmation card into an actionable error without exposing credentials or
raw provider responses.

Each pending item receives a stable opaque ID at draft creation. A confirm job
uses those IDs as Dofek `externalId` values and derives one stable
`Idempotency-Key` for the whole confirm operation. A repeat click or retry
therefore obtains Dofek's original response instead of writing duplicate food.

## AI parsing

The parser uses Vercel AI SDK structured output, matching Dofek's established
nutrition behavior:

- Gemini 2.5 Flash is primary when `GEMINI_API_KEY` is configured.
- Mistral Small Latest is the fallback when `MISTRAL_API_KEY` is configured
  and Gemini receives a retryable rate-limit error.
- Zod validates a non-empty multi-item result with meal, category, and
  non-negative intake-only nutrient fields.
- The prompt receives local time inferred from the Slack message timestamp for
  meal inference. It asks for granular items, conservative calorie estimates,
  and only nutrients the model can estimate credibly.
- Refinements receive the prior itemized draft and must return the complete
  replacement list.

AI telemetry records neither prompts nor outputs. Raw Slack text and raw model
responses are not logged.

## Dofek integration

The bot uses only the versioned REST API at `/api/external/v1`; it never uses
Dofek tRPC or database internals. An administrator provisions a Dofek external
client with `nutrition:write`, then stores its one-time client credential in
the bot's secret configuration.

For each Slack user the bot uses external subject namespace `slack` and subject
`<team-id>:<user-id>`. It starts the documented PKCE link flow at
`POST /link/start` and completes it at `POST /link/exchange`.

The companion Dofek change adds a client-authenticated token-reissue endpoint
for an active grant owned by that same client and external subject. The bot
requests a new token before a confirmed write when the stored token is near
expiry; it never asks the user to re-link solely because the 15-minute bearer
token elapsed. Token reissue rotates the prior token so it cannot be reused.

Confirmation posts `POST /nutrition/entries` with the Dofek bearer token,
stable idempotency key, and only confirmed item fields. The bot validates the
response using the target-neutral schemas and renders Dofek's daily summary as
returned. A Dofek `401`, `403`, `404`, or revoked-link response disables the
local link and asks the user to link again. `423 ACCOUNT_ERASURE_ACTIVE` is
reported as a non-retryable temporary unavailability. The currently deferred
Dofek erasure callback is deliberately not invented by this bot.

## Data protection

Redis records that contain Slack OAuth installations or Dofek bearer tokens
are authenticated-encrypted with a dedicated 32-byte
`BOT_STATE_ENCRYPTION_KEY` before storage. Encryption uses a fresh random IV
per record; the key is supplied only through hosting-provider secrets.

Redis keys partition data by installation, Slack subject, Dofek link state,
pending draft, dedupe receipt, and queue. Pending drafts have a finite TTL and
are removed on confirmation, cancellation, or expiry. Logs carry opaque IDs,
event categories, request IDs, and sanitized error names only.

## Hosting and delivery

Render replaces the Cloudflare Worker runtime. A Render Blueprint defines two
services from this repository and its Docker image:

- a public Node web service with `APP_ROLE=web`, public HTTPS, and `/health`;
- a private Node worker with `APP_ROLE=worker` consuming Redis jobs.

The service binds to `0.0.0.0:$PORT`. Render receives automatic deployments
from `main` only after CI succeeds. A `food-bot` subdomain may remain in the
existing Cloudflare DNS zone as a DNS-only record pointing to Render; no
Cloudflare Worker or Worker deployment workflow remains.

Required production secrets are `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
`SLACK_SIGNING_SECRET`, `SLACK_STATE_SECRET`, `REDIS_URL`,
`BOT_STATE_ENCRYPTION_KEY`, `TARGET_API_BASE_URL`,
`TARGET_API_CLIENT_CREDENTIAL`, `GEMINI_API_KEY`, and optionally
`MISTRAL_API_KEY` plus telemetry configuration. They are never committed.

## Error handling and user-facing copy

The bot tells an unlinked user to link Dofek, a no-provider deployment to
configure an AI provider, and a transient service failure to retry shortly.
It never claims a food entry was saved until Dofek returns its confirmed-write
response. Confirm/cancel/refine requests by another Slack user are rejected
without revealing the draft contents.

## Verification

Unit and integration tests cover encrypted Redis state, Slack installation
storage, Dofek PKCE state and callback validation, signature-protected Bolt
routes, event/action acknowledgement and deduplication, queued food parsing,
thread refinement, authorization isolation, idempotent confirmation, Dofek
error mapping, and worker retry classification. CI runs the complete Vitest
suite, TypeScript typecheck, Biome lint, Docker build, and a health smoke test.

