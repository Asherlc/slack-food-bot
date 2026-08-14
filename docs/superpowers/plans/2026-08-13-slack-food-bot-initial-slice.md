# Slack Food Bot Initial Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the initial tested, target-agnostic Slack food bot scaffold without live Dofek API wiring.

**Architecture:** The bot core owns configuration, nutrition contracts, parsing, formatting, and Redis-backed Slack state behind target-neutral interfaces. `targets/dofek` contains only OpenAPI-derived fixture schemas and contract tests until an explicit external API approval marker exists.

**Tech Stack:** TypeScript, Node 26, pnpm, Vitest, Zod, `@slack/bolt` HTTP-mode dependency, Redis client, Docker, and GitHub Actions.

## Global Constraints

- The core must not import Dofek packages, access a Dofek database, hardcode Dofek URLs/schema/user IDs, or contain target-specific behavior.
- Dofek remains fixture-only in `targets/dofek`; derive only from the evidenced external API docs and OpenAPI 1.0.0.
- Slack pending drafts and dedupe state are bot-owned and Redis-compatible; no canonical food persistence is added.
- Configuration fails fast with explicit missing names; unexpected errors are reportable and user-safe.
- Use Node 26 and pnpm with pinned production dependency versions; do not add secrets.
- Do not create a remote, switch branches, commit, or modify sibling workspaces.

---

### Task 1: Repository metadata and fail-fast configuration

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.node-version`, `.npmrc`
- Create: `src/config.ts`, `src/telemetry.ts`, `src/config.test.ts`
- Create: `README.md`

**Interfaces:**
- Produces `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` and `ConfigError`.
- Produces `ExceptionReporter` and `createExceptionReporter()`.

- [ ] **Step 1: Write failing configuration tests**

Test that `loadConfig({})` throws a `ConfigError` naming all required keys, that complete environment values are parsed into typed fields, and that optional telemetry values remain absent rather than acquiring secret defaults.

- [ ] **Step 2: Run the focused test and verify the expected missing-module failure**

Run: `pnpm vitest run src/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist yet.

- [ ] **Step 3: Add package metadata and minimal configuration implementation**

Define `AppConfig` with Slack credentials/signing secret, Redis URL, target API base URL/client credential, AI provider configuration, telemetry DSN/environment, and `PORT`. Validate required strings and URL formats with Zod, aggregate missing names, and throw before returning. Keep the target API base URL generic in core configuration; do not use a Dofek default.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run src/config.test.ts && pnpm typecheck`

Expected: PASS with no warnings.

- [ ] **Step 5: Add README and repository ignores**

Document prerequisites, test/typecheck commands, configuration names without values, the fixture-only Dofek boundary, and the no-commit/no-remote handoff state. Ignore `.env*` except an explicit example file.

---

### Task 2: Target-neutral nutrition contract and Dofek fixture boundary

**Files:**
- Create: `src/targets/types.ts`, `src/targets/types.test.ts`
- Create: `targets/dofek/schemas.ts`, `targets/dofek/fixtures.ts`, `targets/dofek/schemas.test.ts`, `targets/dofek/README.md`

**Interfaces:**
- `NutritionTarget` exposes `startIdentityLink`, `exchangeIdentityLink`, `getIdentityStatus`, `confirmFood`, and `acknowledgeErasure` using opaque target values.
- `NutritionItem`, `ExternalIdentity`, `DailyIntakeSummary`, `ConfirmedNutritionWrite`, and erasure/link result types are target-neutral.
- Dofek fixture schemas validate the documented OpenAPI 1.0.0 request/response shapes but export no HTTP client.

- [ ] **Step 1: Write failing type/schema tests**

Cover a valid target-neutral nutrition item, rejection of expenditure-calorie fields in parsed intake data, valid server-computed summary states, and OpenAPI-derived fixture validation for link start, link exchange, nutrition entries, and erasure acknowledgement. Include an idempotency key minimum length assertion from the OpenAPI evidence.

- [ ] **Step 2: Run focused tests and verify expected missing-module failures**

Run: `pnpm vitest run src/targets/types.test.ts targets/dofek/schemas.test.ts`

Expected: FAIL because the contract modules do not exist yet.

- [ ] **Step 3: Implement the minimal target-neutral contracts**

Use Zod schemas for runtime boundaries and inferred TypeScript types. Keep `NutritionTarget` independent of Slack, Redis, Dofek, and HTTP. Represent daily progress as a server-owned summary with `available`/`unavailable` discriminants and opaque details where the target owns shape.

- [ ] **Step 4: Implement fixture-only Dofek schemas**

Encode only the documented OpenAPI fields and statuses: PKCE link start/exchange, link status, nutrition entries with `Idempotency-Key`, daily intake response, and erasure acknowledgement. Do not add routes, auth headers, URL constants, request signing, or network calls.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/targets/types.test.ts targets/dofek/schemas.test.ts && pnpm typecheck`

Expected: PASS.

---

### Task 3: Slack-neutral pending and deduplication stores

**Files:**
- Create: `src/slack/pending-entry-store.ts`, `src/slack/pending-entry-store.test.ts`
- Create: `src/slack/dedupe-store.ts`, `src/slack/dedupe-store.test.ts`

**Interfaces:**
- `PendingEntryStore`: `save`, `loadByIds`, `deleteByIds`, `findIdsByMessage`, `deleteBySubject`.
- `SlackDedupeStore`: `claim` and `deleteBySubject`.
- Redis adapters consume a narrow injected Redis client interface; production connection construction remains isolated from core behavior.

- [ ] **Step 1: Write failing store tests**

Test in-memory pending entries round-trip, missing IDs are ignored, deletion is idempotent, message indexes are cleaned, subject cleanup removes all user-owned pending state, dedupe claims succeed once within TTL, expired claims can be reclaimed, and subject cleanup is safe when repeated.

- [ ] **Step 2: Run focused tests and verify expected missing-module failures**

Run: `pnpm vitest run src/slack/pending-entry-store.test.ts src/slack/dedupe-store.test.ts`

Expected: FAIL because the stores do not exist yet.

- [ ] **Step 3: Implement in-memory stores minimally**

Use opaque `externalSubject` ownership rather than a Dofek user ID. Generate pending IDs with `randomUUID`, preserve message indexes, and make all cleanup operations no-throw for already-removed state.

- [ ] **Step 4: Implement Redis-shaped adapters**

Use namespaced keys, TTL on entries/indexes/dedupe claims, atomic `NX` claims, and explicit subject indexes supplied by the interface. Do not import BullMQ or any Dofek queue helper. Malformed stored JSON is treated as absent and never returned as trusted pending data.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/slack/pending-entry-store.test.ts src/slack/dedupe-store.test.ts && pnpm typecheck`

Expected: PASS.

---

### Task 4: Nutrition parser contracts and Block Kit formatting

**Files:**
- Create: `src/nutrition/types.ts`, `src/nutrition/parser.ts`, `src/nutrition/parser.test.ts`
- Create: `src/slack/formatting.ts`, `src/slack/formatting.test.ts`

**Interfaces:**
- `parseNutritionItems(input: unknown): NutritionItem[]` validates AI-shaped output without calling a provider.
- `parseRefinement(input: unknown): RefinementRequest` validates a prior draft plus user correction.
- `formatConfirmation(result: ConfirmedNutritionWrite): Block[]` and `formatCancellation(): Block[]` return Slack Block Kit-compatible JSON.

- [ ] **Step 1: Write failing parser and formatting tests**

Cover multi-item parsing, meal/category/nutrient validation, refinement shape, rejection of expenditure-calorie fields and negative nutrients, confirmation rendering of target-returned entry IDs and daily summary, unavailable server summary rendering, and cancellation rendering.

- [ ] **Step 2: Run focused tests and verify expected missing-module failures**

Run: `pnpm vitest run src/nutrition/parser.test.ts src/slack/formatting.test.ts`

Expected: FAIL because parser and formatter modules do not exist yet.

- [ ] **Step 3: Implement parser validation and normalization**

Use the target-neutral nutrition schema, preserve intake nutrients only, normalize omitted optional values, and reject unknown expenditure fields rather than silently accepting them. Do not call an AI SDK in this slice.

- [ ] **Step 4: Implement deterministic Block Kit formatting**

Render only server-returned confirmation IDs and summary data. Never calculate calories, daily progress, or nutrient totals in the bot. Escape user-visible text and keep target-owned summary details opaque when unavailable.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm vitest run src/nutrition/parser.test.ts src/slack/formatting.test.ts && pnpm typecheck`

Expected: PASS.

---

### Task 5: Health smoke surface, Docker, CI, and final verification

**Files:**
- Create: `src/index.ts`, `src/index.test.ts`
- Create: `Dockerfile`, `.github/workflows/ci.yml`, `.env.example`
- Modify: `README.md`

**Interfaces:**
- `createHealthServer(options?: { port?: number }): Promise<HealthServer>` starts an HTTP health endpoint without loading target or Slack clients.
- The health response is `{ status: "ok" }` and contains no configuration values.

- [ ] **Step 1: Write failing health smoke test**

Assert that the health server responds with status 200 and `{status: "ok"}`, while a separate startup function fails with named configuration errors when required values are absent.

- [ ] **Step 2: Run the focused test and verify expected missing-module failure**

Run: `pnpm vitest run src/index.test.ts`

Expected: FAIL because the entrypoint does not exist yet.

- [ ] **Step 3: Implement health-only entrypoint and Dockerfile**

Use Node’s built-in HTTP server for the smoke surface. Keep `/health` secret-free and reserve the Bolt HTTP runtime for a later workflow task. Pin the Node 26 base image to the selected current stable patch.

- [ ] **Step 4: Add CI and complete repository documentation**

Run typecheck and Vitest in GitHub Actions using the pinned pnpm version. Document that no remote/commit exists and that live Dofek wiring is intentionally blocked on an approval marker.

- [ ] **Step 5: Run full verification**

Run: `pnpm test && pnpm typecheck && git diff --check && git status --short --branch`

Expected: all tests pass, typecheck exits 0, diff check is clean, and status shows only intended uncommitted files on `main` with no remote changes.

