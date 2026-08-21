# Slack Food Bot Cloudflare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the paid/sleeping process deployment with a free Cloudflare Worker, Queue, and D1 runtime for the Slack food bot.

**Architecture:** A Worker verifies and acknowledges Slack HTTP requests, persists encrypted durable state in D1, and submits stable job payloads to a Cloudflare Queue. The Queue consumer runs AI, Slack Web API, and Dofek work separately from the Slack response path.

**Tech Stack:** Cloudflare Workers, Queues, D1, Web Crypto, TypeScript, Vitest, Wrangler, Gemini, Mistral, Slack Web API, Dofek External API.

**Spec:** `docs/superpowers/specs/2026-08-20-slack-food-bot-cloudflare-design.md`

## Global Constraints

- Acknowledge every validated Slack request before AI, Slack API, or Dofek work.
- Encrypt Slack OAuth installations and Dofek grants before storing them in D1.
- Use SQL uniqueness for Slack-delivery and Queue-job deduplication.
- Write food only after a confirmed action and use one deterministic Dofek idempotency key.
- Do not log raw Slack payloads, food text, access tokens, client credentials, or model output.
- Use Cloudflare bindings only through Worker environment types; do not commit secrets.

---

### Task 1: Cloudflare resource contract and encrypted D1 storage

**Files:**
- Create: `src/cloudflare/types.ts`, `src/cloudflare/store.ts`, `src/cloudflare/store.test.ts`, `migrations/0001_initial.sql`
- Modify: `wrangler.jsonc`, `package.json`, `tsconfig.json`

**Produces:** `CloudflareStore` with encrypted installation, link state, grant, pending-draft, and dedupe methods; Worker bindings for D1 and Queue.

- [ ] Write tests that prove an installation/grant round-trips without plaintext appearing in stored data, a consumed PKCE state cannot be loaded twice, and duplicate delivery IDs are rejected.
- [ ] Run `pnpm vitest run src/cloudflare/store.test.ts` and verify the test fails because the store does not exist.
- [ ] Implement Web-Crypto AES-GCM envelopes and parameterized D1 queries, then add the D1 migration and Wrangler bindings.
- [ ] Run the focused store test, `pnpm typecheck`, and `pnpm lint`.
- [ ] Commit the exact storage, binding, migration, manifest, and dependency files.

### Task 2: Signature-protected Slack Worker endpoints

**Files:**
- Create: `src/cloudflare/slack.ts`, `src/cloudflare/slack.test.ts`, `src/cloudflare/worker.ts`

**Produces:** Worker `fetch()` routes for health, Slack OAuth, events, actions, commands, and Dofek callback.

- [ ] Write tests for valid/invalid Slack v0 signatures, URL verification, immediate event/action acknowledgement, and secret-free invalid request responses.
- [ ] Run `pnpm vitest run src/cloudflare/slack.test.ts` and verify the test fails because routes are absent.
- [ ] Implement raw-body HMAC verification, OAuth code exchange, form-payload parsing, D1-backed PKCE storage, and Queue message submission.
- [ ] Run the focused endpoint tests, `pnpm typecheck`, and `pnpm lint`.
- [ ] Commit the Worker endpoint files and tests.

### Task 3: Cloudflare Queue food workflow consumer

**Files:**
- Create: `src/cloudflare/consumer.ts`, `src/cloudflare/consumer.test.ts`
- Modify: `src/cloudflare/worker.ts`, `src/slack/formatting.ts`, `src/ai/nutrition-analyzer.ts`

**Produces:** `queue()` consumer that creates/refines/cancels drafts, sends Slack confirmation cards, reissues Dofek grants when needed, and performs idempotent confirmed writes.

- [ ] Write consumer tests for an analyze job creating a pending draft/card, confirm writing exactly once with a stable key, and an unlinked user receiving a re-link message.
- [ ] Run `pnpm vitest run src/cloudflare/consumer.test.ts` and verify the test fails because the consumer is absent.
- [ ] Implement native-fetch Gemini/Mistral parsing, Slack Web API calls, Dofek requests, and Queue retry classification without passing credentials to logs.
- [ ] Run all consumer tests, `pnpm typecheck`, and `pnpm lint`.
- [ ] Commit the consumer, tests, and any portability-only shared-module updates.

### Task 4: Deployment migration and live verification

**Files:**
- Modify: `wrangler.jsonc`, `package.json`, `.github/workflows/deploy-workers.yml`, `.env.example`
- Delete: `render.yaml`, `src/deployment/render-config.test.ts`, Node-only worker entrypoints and Render-only dependencies after Cloudflare tests replace their coverage.
- Create: `src/deployment/cloudflare-config.test.ts`

**Produces:** Main-only Worker deployment workflow with queue consumer and D1 migration deployment.

- [ ] Write a manifest/workflow test that asserts D1/Queue bindings, a Worker entrypoint, and a main-only successful-CI deployment guard.
- [ ] Run the deployment test and verify it fails against the Render manifest.
- [ ] Restore the Wrangler command/deployment workflow, remove Render configuration, and run a Wrangler dry-run with the authenticated account.
- [ ] Run `pnpm typecheck && pnpm lint && pnpm test`, then commit and push all changed files.
- [ ] Provision D1 and Queue with Wrangler, set non-committed Worker secrets, deploy, verify `/health`, configure Slack URLs, and remove the unused Render Key Value instance.
