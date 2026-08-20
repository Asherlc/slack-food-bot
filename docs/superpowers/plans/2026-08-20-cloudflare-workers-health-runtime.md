# Cloudflare Workers Health Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the existing health-only runtime to Cloudflare Workers and automatically publish a tested `main` revision through GitHub Actions.

**Architecture:** Extract the HTTP health behavior into a Fetch API handler shared by the Node server and Cloudflare Worker. The Worker validates its bindings before routing, while Node continues to validate configuration before opening a TCP listener. A `workflow_run` CD workflow deploys only the exact `main` revision whose existing CI workflow completed successfully.

**Tech Stack:** TypeScript, Node.js 26, Vitest, Cloudflare Workers, Wrangler, GitHub Actions, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-20-cloudflare-workers-health-runtime-design.md`

## Global Constraints

- Do not implement Slack events, OAuth, Redis client creation, Dofek transport, target access, or AI calls.
- Keep the existing Node HTTP entrypoint and Dockerfile functional.
- The Worker must not expose configuration errors, secret names, or secret values in HTTP responses.
- Store runtime values only in Cloudflare Worker secrets/variables; store only the Cloudflare API token and account ID in GitHub repository secrets.
- CD deploys only successful CI `push` workflow runs for `main`, using the exact tested commit SHA.
- Run every shell command through `rtk`.

---

### Task 1: Add a platform-neutral health handler

**Files:**
- Create: `src/http/health-handler.ts`
- Create: `src/http/health-handler.test.ts`

**Interfaces:**
- Produces: `handleHealthRequest(request: Request): Response`
- Consumes: standard Fetch API `Request` and `Response` only.
- Used by: Node adapter in `src/index.ts` and Worker module in `src/worker.ts`.

- [ ] **Step 1: Write the failing handler tests**

```ts
import { describe, expect, it } from "vitest";
import { handleHealthRequest } from "./health-handler.js";

describe("handleHealthRequest", () => {
  it("returns a secret-free status document for GET /health", async () => {
    const response = handleHealthRequest(new Request("https://bot.example/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns the standard not-found response for other requests", async () => {
    const response = handleHealthRequest(new Request("https://bot.example/not-found"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
```

- [ ] **Step 2: Verify the tests fail because the handler module does not exist**

Run: `rtk pnpm test src/http/health-handler.test.ts`

Expected: FAIL with a module-resolution error for `health-handler.js`.

- [ ] **Step 3: Implement the minimal shared handler**

```ts
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function handleHealthRequest(request: Request): Response {
  if (request.method === "GET" && new URL(request.url).pathname === "/health") {
    return Response.json({ status: "ok" }, { headers: jsonHeaders });
  }
  return Response.json({ error: "Not found" }, { status: 404, headers: jsonHeaders });
}
```

- [ ] **Step 4: Verify handler tests pass**

Run: `rtk pnpm test src/http/health-handler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the handler slice**

```sh
rtk git add src/http/health-handler.ts src/http/health-handler.test.ts
rtk git commit -m "feat: add shared health request handler"
```

### Task 2: Route the Node server through the shared handler

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

**Interfaces:**
- Consumes: `handleHealthRequest(request: Request): Response` from `src/http/health-handler.ts`.
- Produces: unchanged `createHealthServer(options?): Promise<HealthServer>` and `startApplication(env?): Promise<HealthServer>`.
- Preserves: `GET /health` returns 200 JSON and unknown routes return the shared 404 JSON.

- [ ] **Step 1: Run the existing Node integration tests before the behavior-preserving refactor**

Run: `rtk pnpm test src/index.test.ts`

Expected: PASS. The existing health and configuration tests establish the
behavior that the adapter must preserve; this task is an internal refactor and
therefore has no new externally visible behavior to drive with a red test.

- [ ] **Step 2: Adapt `node:http` traffic to Fetch requests and responses**

In `src/index.ts`, replace the inline route branches in `createServer` with an async handler that:

```ts
const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
const handled = handleHealthRequest(new Request(requestUrl, { method: request.method }));
response.writeHead(handled.status, Object.fromEntries(handled.headers));
response.end(await handled.text());
```

Import `handleHealthRequest` using the existing `.js` ESM convention. Preserve `listen`, `closeServer`, the direct-invocation block, and all public exports.

- [ ] **Step 3: Verify Node integration tests pass**

Run: `rtk pnpm test src/index.test.ts`

Expected: PASS, including the pre-existing missing-configuration test.

- [ ] **Step 4: Commit the Node adapter slice**

```sh
rtk git add src/index.ts src/index.test.ts
rtk git commit -m "refactor: share health routing with Node server"
```

### Task 3: Add the Worker module and platform-neutral configuration input

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Create: `src/worker.ts`
- Create: `src/worker.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `type Environment = Readonly<Record<string, string | undefined>>` and `loadConfig(env?: Environment): AppConfig`.
- Produces: default Worker module with `fetch(request: Request, env: Environment): Response | Promise<Response>`.
- Consumes: `loadConfig`, `createExceptionReporter`, and `handleHealthRequest`.
- Error contract: invalid Worker bindings yield `500 { "error": "Internal Server Error" }` only.

- [ ] **Step 1: Add failing Worker tests**

```ts
import { describe, expect, it } from "vitest";
import worker from "./worker.js";

const completeEnvironment = {
  SLACK_CLIENT_ID: "client-id",
  SLACK_CLIENT_SECRET: "client-secret",
  SLACK_SIGNING_SECRET: "signing-secret",
  REDIS_URL: "redis://localhost:6379",
  TARGET_API_BASE_URL: "https://target.example.test",
  TARGET_API_CLIENT_CREDENTIAL: "credential",
  AI_PROVIDER: "test-provider",
  AI_API_KEY: "api-key",
};

describe("Cloudflare Worker", () => {
  it("serves the health response with valid bindings", async () => {
    const response = await worker.fetch(new Request("https://bot.example/health"), completeEnvironment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("hides invalid binding details", async () => {
    const response = await worker.fetch(new Request("https://bot.example/health"), {});

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal Server Error" });
  });
});
```

Add a configuration test that passes a plain `Readonly<Record<string, string | undefined>>` value with the same complete fields and expects the current parsed `AppConfig`. This proves config is no longer coupled to `NodeJS.ProcessEnv`.

- [ ] **Step 2: Verify the Worker test fails because the module does not exist**

Run: `rtk pnpm test src/worker.test.ts`

Expected: FAIL with a module-resolution error for `worker.js`.

- [ ] **Step 3: Generalize the config environment type and implement the Worker**

Replace the `NodeJS.ProcessEnv` parameter in `loadConfig` with:

```ts
export type Environment = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Environment = process.env): AppConfig {
```

Create `src/worker.ts`:

```ts
import { loadConfig, type Environment } from "./config.js";
import { handleHealthRequest } from "./http/health-handler.js";
import { createExceptionReporter } from "./telemetry.js";

const worker = {
  fetch(request: Request, env: Environment): Response {
    try {
      loadConfig(env);
      return handleHealthRequest(request);
    } catch (error: unknown) {
      createExceptionReporter().captureException(error, { operation: "worker-request" });
      return Response.json(
        { error: "Internal Server Error" },
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
};

export default worker;
```

Update `tsconfig.json` includes so Worker sources and tests compile under the existing strict TypeScript configuration. Do not add Cloudflare runtime globals or a Node-only dependency to the Worker.

- [ ] **Step 4: Verify focused config and Worker tests pass**

Run: `rtk pnpm test src/config.test.ts src/worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Worker runtime slice**

```sh
rtk git add src/config.ts src/config.test.ts src/worker.ts src/worker.test.ts tsconfig.json
rtk git commit -m "feat: add Cloudflare Worker health runtime"
```

### Task 4: Add Wrangler tooling and deployment documentation

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `wrangler.jsonc`
- Modify: `README.md`
- Modify: `.env.example`
- Create: `src/deployment/cloudflare-config.test.ts`

**Interfaces:**
- Produces: `pnpm dev:workers` for local Worker preview and `pnpm deploy:workers` for authenticated publication.
- Produces: Wrangler configuration whose entrypoint is `src/worker.ts` and whose compatibility date is the deployment date.
- Documents: Cloudflare variables/secrets, the Worker health URL, Upstash's intentionally deferred integration, and free-tier limits.

- [ ] **Step 1: Add a failing configuration assertion**

Create `src/deployment/cloudflare-config.test.ts` that reads `wrangler.jsonc`
with `node:fs/promises`, asserts it contains `"main": "src/worker.ts"`, and
does not contain `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`SLACK_SIGNING_SECRET`, `REDIS_URL`, or `AI_API_KEY`. The first execution must
fail because the configuration file does not yet exist.

- [ ] **Step 2: Verify the configuration test fails**

Run: `rtk pnpm test src/deployment/cloudflare-config.test.ts`

Expected: FAIL because `wrangler.jsonc` does not exist.

- [ ] **Step 3: Install Wrangler and add Worker scripts**

Run: `rtk pnpm add --save-dev wrangler`

Update `package.json` scripts:

```json
"dev:workers": "wrangler dev",
"deploy:workers": "wrangler deploy"
```

Create `wrangler.jsonc` without an account ID or runtime secrets:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "slack-food-bot",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-20",
  "vars": {
    "TELEMETRY_ENVIRONMENT": "production"
  }
}
```

- [ ] **Step 4: Document setup without recording secrets**

Add a `Cloudflare Workers deployment` section to `README.md` that names every required Worker secret from `.env.example`, explains `wrangler secret put <NAME>`, lists `pnpm dev:workers` and `pnpm deploy:workers`, and states that the current deployment exposes only `GET /health`.

Update `.env.example` comments to distinguish Node's optional `PORT` from Worker secrets; do not put a Cloudflare API token or account ID in this file. State that Upstash Redis is future integration configuration, not an active runtime dependency.

- [ ] **Step 5: Verify configuration test passes and preview compiles**

Run: `rtk pnpm test src/deployment/cloudflare-config.test.ts && rtk pnpm exec wrangler deploy --dry-run`

Expected: PASS; Wrangler bundles `src/worker.ts` without publishing.

- [ ] **Step 6: Commit the deployment tooling slice**

```sh
rtk git add package.json pnpm-lock.yaml wrangler.jsonc src/deployment/cloudflare-config.test.ts README.md .env.example
rtk git commit -m "chore: configure Cloudflare Workers deployment"
```

### Task 5: Add CD deployment after successful main CI

**Files:**
- Create: `.github/workflows/deploy-workers.yml`
- Create: `src/deployment/github-workflow.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: successful `CI` `workflow_run` event, `github.event.workflow_run.head_sha`, and GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Produces: one serialized `pnpm deploy:workers` execution for a successful `push` to `main`.
- Security contract: no pull-request deployments; runtime application secrets never enter GitHub Actions.

- [ ] **Step 1: Add the YAML parser required by the workflow test**

Run: `rtk pnpm add --save-dev yaml`

- [ ] **Step 2: Write failing workflow structure tests**

Create `src/deployment/github-workflow.test.ts` that reads and parses
`.github/workflows/deploy-workers.yml` with the `yaml` package and asserts:

```ts
expect(workflow.on.workflow_run.workflows).toEqual(["CI"]);
expect(workflow.on.workflow_run.types).toEqual(["completed"]);
expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.head_branch == 'main'");
expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.event == 'push'");
expect(JSON.stringify(workflow)).toContain("github.event.workflow_run.head_sha");
expect(JSON.stringify(workflow)).toContain("CLOUDFLARE_API_TOKEN");
expect(JSON.stringify(workflow)).toContain("CLOUDFLARE_ACCOUNT_ID");
expect(JSON.stringify(workflow)).not.toContain("SLACK_SIGNING_SECRET");
```

Use an installed YAML parser, adding it as a development dependency if the project does not already have one.

- [ ] **Step 3: Verify the workflow test fails**

Run: `rtk pnpm test src/deployment/github-workflow.test.ts`

Expected: FAIL because `deploy-workers.yml` does not exist.

- [ ] **Step 4: Implement the least-privilege deployment workflow**

Create `.github/workflows/deploy-workers.yml`:

```yaml
name: Deploy Cloudflare Worker

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

permissions:
  contents: read

concurrency:
  group: deploy-cloudflare-worker-main
  cancel-in-progress: false

jobs:
  deploy:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == 'main'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      - uses: pnpm/action-setup@v4
        with:
          version: 11.17.0
      - uses: actions/setup-node@v5
        with:
          node-version: 26.7.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm deploy:workers
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Keep `cancel-in-progress: false` so an active publish finishes; GitHub retains only the newest pending deployment for the concurrency group.

- [ ] **Step 5: Verify workflow tests pass**

Run: `rtk pnpm test src/deployment/github-workflow.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the CD workflow slice**

```sh
rtk git add .github/workflows/deploy-workers.yml src/deployment/github-workflow.test.ts package.json pnpm-lock.yaml
rtk git commit -m "ci: deploy Worker after successful main CI"
```

### Task 6: Run the complete verification and publish the branch

**Files:**
- Verify: all modified files above.

**Interfaces:**
- Verifies: Node health runtime, Worker runtime, tool configuration, documentation, and safe CD workflow structure.

- [ ] **Step 1: Run formatting/lint checks**

Run: `rtk pnpm lint`

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `rtk pnpm test`

Expected: PASS.

- [ ] **Step 3: Run static type checking and production build**

Run: `rtk pnpm typecheck && rtk pnpm build`

Expected: PASS.

- [ ] **Step 4: Inspect the final change and commit history**

Run: `rtk git status --short && rtk git diff origin/main...HEAD --check && rtk git log --oneline origin/main..HEAD`

Expected: only the intended Worker runtime, tooling, CD, tests, documentation, and specification/plan commits.

- [ ] **Step 5: Push every implementation commit**

Run: `rtk git push origin HEAD`

Expected: the feature branch is updated on GitHub. Do not merge to `main`; CD begins only after the user merges the reviewed branch.
