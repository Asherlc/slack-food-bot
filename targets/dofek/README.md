# Dofek target fixture boundary

This directory is fixture-only until the external-write API workspace records
an explicit approval marker for its contract. The schemas and examples are
derived from the evidenced OpenAPI 1.0.0 document and its companion
`docs/external-api.md` in the Dofek workspace.

There is intentionally no HTTP client, URL constant, authentication flow,
database access, Dofek package import, or live route wiring here. A future
adapter must be added only after the approved wire contract is available.
