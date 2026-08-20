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
