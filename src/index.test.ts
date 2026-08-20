import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer, startApplication } from "./index.js";

type RawResponse = {
  status: number | undefined;
  contentType: string | undefined;
  body: string;
};

function sendRawRequest(
  port: number,
  options: { method?: string; host?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const rawRequest = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: options.method ?? "GET",
        ...(options.host ? { headers: { host: options.host } } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            contentType: response.headers["content-type"],
            body,
          });
        });
      },
    );

    rawRequest.setTimeout(1_000, () => {
      rawRequest.destroy(new Error("Raw HTTP request timed out"));
    });
    rawRequest.on("error", reject);
    rawRequest.end();
  });
}

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

  it("returns the standard not-found response for a raw TRACE request", async () => {
    const health = await createHealthServer({ port: 0 });
    close = health.close;

    const response = await sendRawRequest(health.port, { method: "TRACE" });

    expect(response.status).toBe(404);
    expect(response.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
  });

  it("returns the standard not-found response for a malformed Host header", async () => {
    const health = await createHealthServer({ port: 0 });
    close = health.close;

    const response = await sendRawRequest(health.port, { host: "malformed host" });

    expect(response.status).toBe(404);
    expect(response.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
  });

  it("fails startup before creating a server when required configuration is absent", () => {
    expect(() => startApplication({})).toThrow(/SLACK_CLIENT_ID/);
  });
});
