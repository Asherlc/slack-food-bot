import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Cloudflare Worker configuration", () => {
  it("uses the Worker entrypoint without tracked credentials or runtime secrets", async () => {
    const configuration = await readFile("wrangler.jsonc", "utf8");

    expect(configuration).toContain('"main": "src/worker.ts"');
    for (const prohibitedName of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "SLACK_SIGNING_SECRET",
      "REDIS_URL",
      "AI_API_KEY",
    ]) {
      expect(configuration).not.toContain(prohibitedName);
    }
  });
});
