# Slack Food Bot Cloudflare Design

## Goal

Deploy the production Slack food bot at no recurring hosting cost without an
always-on Node process. Cloudflare Workers receives Slack and browser traffic;
Cloudflare Queues performs AI analysis and confirmed Dofek writes asynchronously.

## Architecture

The Worker immediately verifies each Slack request, performs only a D1
deduplication insert plus a Queue send, and returns within Slack's three-second
limit. The Queue consumer performs Gemini/Mistral requests, Dofek linking and
nutrition writes, and Slack Web API calls. It retries transient provider
failures through Cloudflare Queue retries and never writes food before a user
confirmation.

The Worker uses D1 rather than Redis. D1 stores installation records, PKCE
link states, encrypted Dofek grants, pending drafts, and delivery receipts.
All secret-bearing blobs are AES-GCM encrypted with `BOT_STATE_ENCRYPTION_KEY`
via Web Crypto; encryption uses a fresh 96-bit IV for every record. D1 rows are
keyed by team ID, Slack user ID, opaque state/draft IDs, or Slack delivery IDs.
SQL `INSERT ... ON CONFLICT DO NOTHING` provides deterministic deduplication.

## HTTP routes

- `GET /health` returns `{ "status": "ok" }` without loading secret bindings.
- `GET /slack/install` redirects to Slack OAuth with the required bot scopes.
- `GET /slack/oauth_redirect` exchanges the code and stores the installation
  encrypted by team ID.
- `POST /slack/events` verifies Slack's v0 HMAC signature, responds to URL
  verification, deduplicates `event_id`, and queues valid DMs/app mentions.
- `POST /slack/actions` verifies Slack's signature, parses the form payload,
  records a stable confirm/cancel job, and returns 200 before background work.
- `POST /slack/commands` handles `/link-dofek`, starts the Dofek PKCE flow,
  stores encrypted short-lived state, and returns the link ephemerally.
- `GET /dofek/link/callback` consumes PKCE state once, exchanges the code,
  saves the encrypted grant, and returns a secret-free page.

## Queue messages

Queue messages use the existing `analyze`, `refine`, `confirm`, and `cancel`
job shapes. The consumer loads the encrypted installation/grant/draft state,
uses Gemini as primary with Mistral only on Gemini rate limits, and calls Slack
`chat.postMessage` or `chat.update`. Confirmed writes use one SHA-256-derived
idempotency key per pending draft and Dofek's documented external API. A
missing or revoked grant updates Slack with a re-link prompt instead of retrying.

## Cloudflare resources and secrets

`wrangler.jsonc` binds `FOOD_BOT_DB` (D1) and `FOOD_JOBS` (Queue) to the
Worker. `migrations/0001_initial.sql` creates all tables and uniqueness
constraints. The CI deploy workflow runs only after successful `main` CI and
uses the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
Cloudflare Worker secrets are set outside git: Slack client/signing/state
secrets, Dofek API credentials, the base64url encryption key, public URL, and
one or both AI keys.

Render files and the Render Key Value instance are not part of the final
runtime. The previously created free Key Value instance should be deleted only
after the Cloudflare Worker is deployed and healthy.

## Verification

Tests cover signature checks, unauthenticated error redaction, D1 encryption,
one-time PKCE/dedupe semantics, async event acknowledgement, action ownership,
queue consumer writes, and manifest bindings. CI runs typecheck, lint, tests,
and a Wrangler dry-run. Deployment is verified with a public `/health` request
and Cloudflare Queue consumer logs.
