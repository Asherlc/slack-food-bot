# Cloudflare Workers Health Runtime Design

## Purpose

Make the repository's existing secret-free health endpoint deployable on
Cloudflare Workers' free tier without changing the current product boundary:
the Slack event workflow and live Dofek transport remain unimplemented.

## Scope

The change adds a Worker runtime for the existing `GET /health` behavior,
Cloudflare deployment metadata, and deployment documentation. It retains the
Node HTTP entrypoint and Dockerfile for local and container use.

The change does not implement Slack event handling, Redis client creation,
OAuth, a target HTTP client, or background work. Upstash Redis remains the
selected future backing store; no credentials or client are added until the
existing approval boundary for live integrations is satisfied.

## Architecture

The health route becomes a platform-neutral function that accepts a standard
`Request` and returns a standard `Response`. The Node server adapts incoming
`node:http` requests to that route and serializes its response; the Worker
exports a module `fetch` handler that calls the same function directly.

Configuration parsing accepts a read-only map of string values instead of
`NodeJS.ProcessEnv`, so it can validate both Node process variables and
Cloudflare Worker bindings. The parsed configuration continues to contain
`port` for the Node runtime only. The Worker validates the same required
secrets at request time but never exposes values in its health response.

`wrangler.jsonc` defines the Worker entrypoint, compatibility date, and a
development-safe `TELEMETRY_ENVIRONMENT` variable. Secrets remain absent from
source control and must be supplied with `wrangler secret put` or through the
Cloudflare dashboard.

## Components

### `src/http/health-handler.ts`

Exports `handleHealthRequest(request: Request): Response`. It returns JSON
`{ "status": "ok" }` with HTTP 200 only for `GET /health`; every other
request receives JSON `{ "error": "Not found" }` with HTTP 404. The handler
does not read configuration or secrets.

### `src/index.ts`

Remains the Node entrypoint. Its server uses the shared handler for every
request, preserves its local TCP lifecycle API, and loads config before
listening.

### `src/worker.ts`

Exports Cloudflare's module Worker object with `fetch(request, env)`. It
validates the supplied environment with `loadConfig` before dispatching to the
shared health handler. Startup/configuration errors are reported through the
existing telemetry boundary and are returned as a generic HTTP 500 response;
no error details or secret names are disclosed remotely.

### Configuration and tooling

`src/config.ts` uses `Readonly<Record<string, string | undefined>>` as the
environment input type. `wrangler.jsonc`, a `wrangler` development dependency,
and `deploy:workers` / `dev:workers` package scripts support local preview and
deployment.

## Data Flow

1. Cloudflare sends an HTTP request to the Worker.
2. The Worker validates its environment values without logging secrets.
3. The shared handler returns the health response for `GET /health`, or the
   standard 404 JSON response.
4. Cloudflare returns that response to the requester.

The Node flow is the same after the TCP adapter creates a Fetch API `Request`.

## Error Handling

- The health route is deterministic and contains no secret-derived content.
- Missing or malformed Worker configuration returns HTTP 500 with
  `{ "error": "Internal Server Error" }` and reports the exception through
  telemetry.
- Node startup behavior remains fail-fast and continues to identify missing
  keys locally through `ConfigError`.
- The Worker does not initialize Redis or contact Slack, AI, or target APIs.

## Testing

- Unit-test the shared handler's success and not-found responses.
- Preserve Node HTTP integration coverage to prove that its adapter serves the
  same health response.
- Test the Worker module handler with complete valid bindings and with missing
  bindings, verifying the latter returns only the generic 500 payload.
- Run the complete test suite, typecheck, lint, and production build before
  publishing.

## Deployment

Deploy through `pnpm deploy:workers` after authenticating Wrangler and setting
all required secrets in the Cloudflare Worker. The resulting Worker URL can be
used for `GET /health`. Upstash Redis setup is documented but intentionally
not connected to runtime code until a later approved Slack workflow change.
