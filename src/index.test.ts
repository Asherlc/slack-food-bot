import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer, startApplication } from "./index.js";

describe("health entrypoint", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves a secret-free health response", async () => {
    const health = await createHealthServer({ port: 0 });
    close = health.close;

    const response = await fetch(`http://127.0.0.1:${health.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("fails startup before creating a server when required configuration is absent", () => {
    expect(() => startApplication({})).toThrow(/SLACK_CLIENT_ID/);
  });
});
