# Slack Food Bot Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a secure, asynchronous Slack food bot that confirms itemized AI drafts before writing them to Dofek.

**Architecture:** A public Bolt/HTTP process verifies and acknowledges Slack requests, persists encrypted state in Redis, and enqueues durable work. A separate Node worker parses food and calls the Dofek External Write API, using stable draft IDs and idempotency keys; Render runs the web and worker roles from one Docker image.

**Tech Stack:** Node 26.7.0, TypeScript, @slack/bolt, Redis, BullMQ, Vercel AI SDK, Gemini 2.5 Flash, Mistral Small, Zod, Vitest, Docker, Render.

**Spec:** `docs/superpowers/specs/2026-08-20-slack-food-bot-production-design.md`

## Global Constraints

- Use Node `26.7.0` and pnpm `11.17.0`.
- Acknowledge Slack events and interactions in fewer than three seconds; workers do all AI and Dofek work.
- Store Slack installations and Dofek bearer grants only as authenticated-encrypted Redis values.
- Use external subject `slack:<team-id>:<user-id>` and Dofek REST `/api/external/v1` only.
- Confirmed Dofek writes use stable pending-entry IDs as `externalId` and one deterministic `Idempotency-Key` per confirmation.
- Use Gemini 2.5 Flash first and Mistral Small only for retryable Gemini rate limits.
- Never log raw Slack payloads, raw food descriptions, model input/output, client credentials, bot tokens, or Dofek access tokens.
- Continue to expose a credential-free `GET /health` response and bind public HTTP to `0.0.0.0:$PORT`.
- Remove Cloudflare Worker deployment configuration; define Render web and worker services in `render.yaml`.
- The Dofek token-reissue route is supplied by the companion branch before the confirmation worker is merged.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Strict production configuration and secret validation. |
| `src/security/encrypted-record.ts` | AES-256-GCM envelope encoding for Redis secrets. |
| `src/redis/client.ts` | Shared Redis connection lifecycle. |
| `src/slack/installation-store.ts` | Encrypted Bolt installation persistence by team. |
| `src/dofek/client.ts` | Validated Dofek External Write REST client. |
| `src/dofek/link-store.ts` | PKCE and grant state stored in encrypted Redis records. |
| `src/ai/nutrition-analyzer.ts` | Structured Gemini/Mistral item parsing and refinement. |
| `src/jobs/queue.ts` | Stable, retryable BullMQ job contract. |
| `src/workflows/food-workflow.ts` | Parse, refine, confirm, cancel orchestration. |
| `src/slack/app.ts` | Bolt OAuth, event, action, and callback route registration. |
| `src/worker.ts` | Background job consumer. |
| `src/index.ts` | Web-role server and health endpoint. |
| `render.yaml` | Render web and private worker service definition. |

### Task 1: Production dependencies and strict configuration

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `.env.example`, `src/config.ts`
- Modify: `src/config.test.ts`

**Interfaces:**
- Produces `loadConfig(env): AppConfig` with `slack`, `redisUrl`, `target`, `ai`, `security`, `publicBaseUrl`, `port`, and telemetry fields.
- Requires `SLACK_STATE_SECRET`, `BOT_STATE_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, and at least `GEMINI_API_KEY` or `MISTRAL_API_KEY` in addition to the existing production secrets.

- [ ] **Step 1: Add failing configuration tests**

```ts
it("requires an encrypted-state key and public callback URL", () => {
  expect(() => loadConfig(validEnv())).toThrow(/BOT_STATE_ENCRYPTION_KEY, PUBLIC_BASE_URL/);
});

it("accepts Gemini-only production parsing configuration", () => {
  expect(loadConfig(validEnv({ GEMINI_API_KEY: "key" })).ai).toEqual({
    geminiApiKey: "key",
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `pnpm vitest run src/config.test.ts`

Expected: FAIL because the new configuration fields and AI provider shape do not exist.

- [ ] **Step 3: Add the runtime dependencies and minimal configuration implementation**

```sh
pnpm add @ai-sdk/google @ai-sdk/mistral @slack/bolt ai bullmq ioredis
```

```ts
security: { stateEncryptionKey: value.BOT_STATE_ENCRYPTION_KEY, slackStateSecret: value.SLACK_STATE_SECRET },
publicBaseUrl: value.PUBLIC_BASE_URL,
ai: {
  ...(value.GEMINI_API_KEY ? { geminiApiKey: value.GEMINI_API_KEY } : {}),
  ...(value.MISTRAL_API_KEY ? { mistralApiKey: value.MISTRAL_API_KEY } : {}),
},
```

- [ ] **Step 4: Run the focused test and verify green**

Run: `pnpm vitest run src/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add package.json pnpm-lock.yaml .env.example src/config.ts src/config.test.ts
git commit -m "feat: configure production Slack bot runtime"
```

### Task 2: Encrypted Redis records and persistent bot state

**Files:**
- Create: `src/security/encrypted-record.ts`, `src/security/encrypted-record.test.ts`
- Create: `src/redis/client.ts`
- Create: `src/slack/installation-store.ts`, `src/slack/installation-store.test.ts`
- Create: `src/dofek/link-store.ts`, `src/dofek/link-store.test.ts`

**Interfaces:**
- Produces `encryptRecord(key, value): string` and `decryptRecord<T>(key, ciphertext): T`.
- Produces `RedisInstallationStore` compatible with Bolt `InstallationStore`.
- Produces `DofekLinkStore.create(state)`, `consume(state)`, `saveGrant(subject, grant)`, and `loadGrant(subject)`.

- [ ] **Step 1: Add failing round-trip, tamper, and storage-isolation tests**

```ts
it("refuses a ciphertext whose authentication tag was changed", () => {
  const value = encryptRecord(key, { accessToken: "secret" });
  expect(() => decryptRecord(key, `${value.slice(0, -1)}x`)).toThrow();
});

it("stores the Bolt bot token encrypted rather than as plaintext", async () => {
  await store.storeInstallation(installation);
  expect(redis.values().join(" ")).not.toContain(installation.bot!.token!);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm vitest run src/security/encrypted-record.test.ts src/slack/installation-store.test.ts src/dofek/link-store.test.ts`

Expected: FAIL because the encryption and persistent stores do not exist.

- [ ] **Step 3: Implement AES-256-GCM records and Redis stores**

```ts
export function encryptRecord(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}
```

Use separate namespaced keys for installations, PKCE states, grants, and
pending entries. Set PKCE keys to the Dofek link expiration and remove state
atomically on callback consumption.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `pnpm vitest run src/security/encrypted-record.test.ts src/slack/installation-store.test.ts src/dofek/link-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/security src/redis src/slack/installation-store.ts src/slack/installation-store.test.ts src/dofek/link-store.ts src/dofek/link-store.test.ts
git commit -m "feat: persist encrypted Slack and Dofek state"
```

### Task 3: Dofek External Write client and account-link flow

**Files:**
- Modify: `src/targets/types.ts`, `src/targets/types.test.ts`
- Create: `src/dofek/client.ts`, `src/dofek/client.test.ts`
- Create: `src/dofek/link-flow.ts`, `src/dofek/link-flow.test.ts`

**Interfaces:**
- Extends `NutritionTarget` with `reissueGrant(input: { identity: ExternalIdentity }): Promise<TargetGrant>`.
- Produces `DofekClient` methods for `startIdentityLink`, `exchangeIdentityLink`, `reissueGrant`, and `confirmFood`.
- Produces `startSlackDofekLink(input)` and `completeSlackDofekLink(input)`.

- [ ] **Step 1: Add failing protocol tests**

```ts
it("reissues a grant with client credentials and never sends the old token", async () => {
  await client.reissueGrant({ identity: { namespace: "slack", subject: "T1:U1" } });
  expect(fetch).toHaveBeenCalledWith("https://dofek.test/api/external/v1/link/token", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer ext_client.secret" }),
  }));
});

it("rejects a callback whose PKCE state was already consumed", async () => {
  await expect(completeSlackDofekLink(callback)).rejects.toThrow("Invalid or expired link state");
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm vitest run src/targets/types.test.ts src/dofek/client.test.ts src/dofek/link-flow.test.ts`

Expected: FAIL because reissue and the concrete REST client/link flow do not exist.

- [ ] **Step 3: Implement validated requests, PKCE, and token reissue**

```ts
const identity = { namespace: "slack", subject: `${teamId}:${userId}` };
const verifier = randomBytes(48).toString("base64url");
const state = randomBytes(32).toString("base64url");
const start = await target.startIdentityLink({
  redirectUri: `${config.publicBaseUrl}/dofek/link/callback`,
  codeChallenge: pkceS256(verifier),
  requestedScopes: ["nutrition:write"],
});
```

Validate every Dofek success body with Zod. Convert public Dofek problem codes
to typed errors without copying provider payloads into logs. Use `/link/token`
only after the Dofek companion branch defines that endpoint and response shape.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `pnpm vitest run src/targets/types.test.ts src/dofek/client.test.ts src/dofek/link-flow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/targets/types.ts src/targets/types.test.ts src/dofek
git commit -m "feat: link Slack identities to Dofek grants"
```

### Task 4: Structured nutrition analysis with Dofek-compatible fallback

**Files:**
- Create: `src/ai/nutrition-analyzer.ts`, `src/ai/nutrition-analyzer.test.ts`
- Modify: `src/nutrition/parser.ts`, `src/nutrition/parser.test.ts`

**Interfaces:**
- Produces `NutritionAnalyzer.analyze(text, localTime): Promise<NutritionItem[]>`.
- Produces `NutritionAnalyzer.refine(items, instruction, localTime): Promise<NutritionItem[]>`.

- [ ] **Step 1: Add failing analyzer tests**

```ts
it("falls back from Gemini to Mistral only after a retryable rate limit", async () => {
  gemini.generate.mockRejectedValueOnce(new Error("429 Too Many Requests"));
  mistral.generate.mockResolvedValueOnce(itemsResponse);
  await expect(analyzer.analyze("eggs and toast", "08:00")).resolves.toEqual(items);
});

it("rejects model output containing expenditure nutrients", async () => {
  await expect(analyzer.analyze("ran 5k and ate a banana", "08:00")).rejects.toThrow(/intake nutrients/);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm vitest run src/ai/nutrition-analyzer.test.ts src/nutrition/parser.test.ts`

Expected: FAIL because the structured provider adapter is missing.

- [ ] **Step 3: Implement Gemini-first structured parsing and Mistral fallback**

```ts
const generated = await generateText({
  model,
  output: Output.object({ schema: z.object({ items: nutritionItemsSchema }) }),
  telemetry: { isEnabled: true, recordInputs: false, recordOutputs: false },
  system: MULTI_ITEM_SYSTEM_PROMPT,
  prompt: text,
});
return parseNutritionItems(generated.output);
```

Use the Dofek-compatible category, granular-item, meal-inference, conservative
calorie, and thread-refinement prompts. Do not emit the description or model
output to logs or telemetry.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `pnpm vitest run src/ai/nutrition-analyzer.test.ts src/nutrition/parser.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/ai src/nutrition/parser.ts src/nutrition/parser.test.ts
git commit -m "feat: analyze Slack food descriptions"
```

### Task 5: Durable jobs and draft-card formatting

**Files:**
- Create: `src/jobs/queue.ts`, `src/jobs/queue.test.ts`
- Modify: `src/slack/formatting.ts`, `src/slack/formatting.test.ts`
- Modify: `src/slack/pending-entry-store.ts`, `src/slack/pending-entry-store.test.ts`

**Interfaces:**
- Produces `FoodJob` variants `parse`, `refine`, `confirm`, and `cancel`.
- Produces `FoodJobQueue.enqueue(job): Promise<void>` and `FoodJobQueue.process(handler): Promise<void>`.
- Produces `formatDraft(entries, actionValue)`, `formatConfirmation(result)`, `formatCancellation()`, and `formatFailure(message)`.

- [ ] **Step 1: Add failing job identity and Block Kit tests**

```ts
it("uses one deterministic BullMQ job ID for a retried Slack event", async () => {
  await queue.enqueue(parseJob);
  await queue.enqueue(parseJob);
  expect(await queue.count()).toBe(1);
});

it("renders confirm and cancel actions with opaque draft IDs only", () => {
  expect(formatDraft(entries, "draft-1")).toMatchObject([{ type: "actions" }]);
  expect(JSON.stringify(formatDraft(entries, "draft-1"))).not.toContain("accessToken");
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm vitest run src/jobs/queue.test.ts src/slack/formatting.test.ts src/slack/pending-entry-store.test.ts`

Expected: FAIL because durable jobs and draft cards are missing.

- [ ] **Step 3: Implement queue contracts and terminal-safe draft persistence**

```ts
export type FoodJob =
  | { kind: "parse"; deliveryId: string; teamId: string; userId: string; channelId: string; messageTs: string; text: string }
  | { kind: "confirm"; actionId: string; teamId: string; userId: string; channelId: string; messageTs: string };
```

Generate queue job IDs from `kind` plus Slack delivery/action identity. Add a
draft revision to pending records so a refinement invalidates stale confirmation
cards. Confirmation cards contain only opaque draft IDs; item details are
rendered from pending state.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `pnpm vitest run src/jobs/queue.test.ts src/slack/formatting.test.ts src/slack/pending-entry-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/jobs src/slack/formatting.ts src/slack/formatting.test.ts src/slack/pending-entry-store.ts src/slack/pending-entry-store.test.ts
git commit -m "feat: queue Slack food drafts"
```

### Task 6: Food workflow and authorization-safe confirmation

**Files:**
- Create: `src/workflows/food-workflow.ts`, `src/workflows/food-workflow.test.ts`
- Modify: `src/slack/dedupe-store.ts`, `src/slack/dedupe-store.test.ts`

**Interfaces:**
- Produces `FoodWorkflow.parse`, `refine`, `confirm`, and `cancel` worker methods.
- Consumes `NutritionAnalyzer`, `NutritionTarget`, `DofekLinkStore`, `PendingEntryStore`, and a narrow Slack message client.

- [ ] **Step 1: Add failing orchestration tests**

```ts
it("writes each confirmed draft exactly once with pending IDs as external IDs", async () => {
  await workflow.confirm(confirmJob);
  await workflow.confirm(confirmJob);
  expect(target.confirmFood).toHaveBeenCalledOnce();
  expect(target.confirmFood).toHaveBeenCalledWith(expect.objectContaining({
    entries: [expect.objectContaining({ externalId: "pending-1" })],
  }));
});

it("does not let another Slack user confirm a draft", async () => {
  await expect(workflow.confirm({ ...confirmJob, userId: "U2" })).rejects.toThrow(/own draft/);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `pnpm vitest run src/workflows/food-workflow.test.ts src/slack/dedupe-store.test.ts`

Expected: FAIL because worker orchestration does not exist.

- [ ] **Step 3: Implement parse, refine, confirm, and cancel workflows**

```ts
const grant = await grants.loadGrant(subject);
const activeGrant = !grant || expiresSoon(grant) ? await target.reissueGrant({ identity }) : grant;
const result = await target.confirmFood({
  grant: activeGrant,
  idempotencyKey: confirmationIdempotencyKey(pendingIds),
  entries: pending.map(toNutritionWriteEntry),
});
await pendingStore.deleteByIds(pendingIds);
```

Map Dofek link/auth errors to a fresh link prompt, `423` to a non-retryable
unavailability card, and `429`/`503` to retryable job failures. Delete pending
state only after a successful Dofek response or explicit cancel.

- [ ] **Step 4: Run the focused test and verify green**

Run: `pnpm vitest run src/workflows/food-workflow.test.ts src/slack/dedupe-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/workflows src/slack/dedupe-store.ts src/slack/dedupe-store.test.ts
git commit -m "feat: confirm Slack food drafts in Dofek"
```

### Task 7: Bolt receiver, callbacks, and worker role

**Files:**
- Create: `src/slack/app.ts`, `src/slack/app.test.ts`
- Create: `src/worker.ts`, `src/worker.test.ts`
- Modify: `src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Produces `createSlackApp(deps): { receiver; app }` and `createWebServer(deps): HealthServer`.
- Produces `startWorker(deps): Promise<void>`.

- [ ] **Step 1: Add failing HTTP and acknowledgement tests**

```ts
it("returns 200 before a queued message parse runs", async () => {
  const response = await server.inject(signedSlackEvent(messageEvent));
  expect(response.statusCode).toBe(200);
  expect(queue.enqueue).toHaveBeenCalledOnce();
  expect(analyzer.analyze).not.toHaveBeenCalled();
});

it("accepts a Dofek callback only once and sends Slack a success message", async () => {
  await server.inject(dofekCallback);
  await expect(server.inject(dofekCallback)).resolves.toMatchObject({ statusCode: 400 });
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `pnpm vitest run src/slack/app.test.ts src/worker.test.ts src/index.test.ts`

Expected: FAIL because Bolt routes and worker role are missing.

- [ ] **Step 3: Register OAuth, events, actions, and callbacks**

```ts
app.event("app_mention", async ({ event }) => {
  await queue.enqueue(toParseJob(event));
});
app.action("confirm_food", async ({ ack, body, action }) => {
  await ack();
  await queue.enqueue(toConfirmJob(body, action));
});
```

Filter bot and edited events before enqueueing. Reply to unlinked `link`
messages with a one-time Dofek authorization URL. Run `startWorker` only when
`APP_ROLE === "worker"`; otherwise start the Bolt receiver and health server.

- [ ] **Step 4: Run the focused tests and verify green**

Run: `pnpm vitest run src/slack/app.test.ts src/worker.test.ts src/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/slack/app.ts src/slack/app.test.ts src/worker.ts src/worker.test.ts src/index.ts src/index.test.ts
git commit -m "feat: receive Slack food logging requests"
```

### Task 8: Render deployment, CI, and operator documentation

**Files:**
- Create: `render.yaml`
- Modify: `Dockerfile`, `.github/workflows/ci.yml`, `README.md`, `.env.example`
- Delete: Cloudflare Worker deployment workflow and Worker-only configuration files, if present after rebasing on `main`.

**Interfaces:**
- `APP_ROLE=web` starts the public HTTP role; `APP_ROLE=worker` starts the private queue consumer.
- `GET /health` returns HTTP 200 without contacting Slack, Redis, Dofek, or an AI provider.

- [ ] **Step 1: Add failing deployment-shape tests**

```ts
it("binds the public health server on all interfaces", async () => {
  const server = await createWebServer({ host: "0.0.0.0", port: 0 });
  expect(server.host).toBe("0.0.0.0");
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `pnpm vitest run src/index.test.ts`

Expected: FAIL because the server still binds only to loopback.

- [ ] **Step 3: Implement Render services and production commands**

```yaml
services:
  - type: web
    name: slack-food-bot-web
    runtime: docker
    healthCheckPath: /health
    envVars: [{ key: APP_ROLE, value: web }]
  - type: worker
    name: slack-food-bot-worker
    runtime: docker
    envVars: [{ key: APP_ROLE, value: worker }]
```

Make the Docker command select `dist/src/index.js` or `dist/src/worker.js`
from `APP_ROLE`. Document Slack Redirect URLs, event/interactivity Request URL,
Dofek external-client provisioning, Render secrets, Redis, DNS-only Cloudflare
record, and the required always-on production service rather than a sleeping
free tier.

- [ ] **Step 4: Run complete verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && docker build -t slack-food-bot:verify .`

Expected: every command exits 0; the Docker image builds with the production
entrypoints.

- [ ] **Step 5: Commit and push**

```sh
git add Dockerfile .github/workflows/ci.yml README.md .env.example render.yaml src/index.ts src/index.test.ts
git add -u .github
git commit -m "feat: deploy Slack bot on Render"
git push
```

## Plan self-review

- **Spec coverage:** Tasks 1–2 cover strict config, secret handling, and Redis; Tasks 3–4 cover Dofek linking/token reissue and AI parsing; Tasks 5–7 cover queueing, user flows, authorization, and Slack acknowledgement; Task 8 covers Render, Docker, CI, DNS, and operator setup.
- **Placeholder scan:** No deferred implementation markers are present. The Dofek route dependency is explicit and assigned to the already-running companion workspace.
- **Type consistency:** `NutritionTarget.reissueGrant`, `DofekLinkStore`, `NutritionAnalyzer`, `FoodJob`, `FoodWorkflow`, `createSlackApp`, and `startWorker` are defined before their consumers in later tasks.
