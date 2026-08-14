# Slack Food Bot Initial Slice Design

## Goal

Create the first durable, public, target-agnostic Slack food bot slice: strict configuration, a narrow nutrition-target boundary, Redis-compatible pending/deduplication state, nutrition parsing contracts, and server-summary Block Kit formatting. Keep Dofek as a fixture-only contract boundary until the external API has an explicit approval marker.

## Architecture

The core application owns Slack-facing state and workflow data, but depends on the `NutritionTarget` interface rather than a target package. Pending food drafts and delivery/action deduplication are bot-owned state and are stored behind small interfaces with in-memory implementations for unit tests and Redis implementations for production. Nutrition parsing produces intake-only target-neutral items; formatting consumes target-neutral confirmation results and never computes daily nutrition locally.

The `targets/dofek` directory contains only schemas, typed fixtures, and contract tests derived from the evidenced external API documentation and OpenAPI 1.0.0. It does not contain a live HTTP client, Dofek URL, authentication implementation, database access, Dofek package import, or invented wire semantics. A future live adapter can be added only after the external API workspace records explicit approval.

## Initial slice

- Validate required Slack, Redis, target, AI, telemetry, and runtime configuration with explicit missing-key errors.
- Define target-neutral identity-linking, status, confirmed nutrition-write, server-summary, and erasure acknowledgement types.
- Provide pending-draft and deduplication stores with Redis and in-memory implementations; deletion is explicit and idempotent.
- Define and validate multi-item nutrition parsing results, refinement inputs, and intake-only nutrient fields.
- Render confirmation and cancellation Block Kit from target-neutral data, including unavailable server summaries without local recomputation.
- Add a health-only HTTP entrypoint suitable for Bolt HTTP integration without starting a live Slack or target connection in tests.
- Add Docker, CI, README, and pinned package metadata for Node 26 and pnpm.

## Error and privacy rules

Missing required configuration fails before startup and names every missing key. Unexpected errors are reported through an injectable exception reporter and are not silently swallowed. Logs and test fixtures never include Slack tokens, target access tokens, emails, Dofek user IDs, raw AI payloads, or raw Slack payloads. Pending data remains unconfirmed and bot-owned until a future explicit confirmation workflow calls a target adapter.

## Verification

Vitest covers configuration validation, type/schema boundaries, in-memory and Redis-shaped store behavior, parser validation, formatting, and Dofek fixture validation. TypeScript compilation and a health smoke test run without credentials. The working tree is left uncommitted because no remote exists.
