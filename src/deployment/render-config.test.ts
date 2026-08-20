import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Render deployment configuration", () => {
  it("defines public web, private worker, and free Redis services", async () => {
    const manifest = parse(await readFile("render.yaml", "utf8")) as {
      services: Array<{ type: string; name: string; startCommand?: string; plan?: string }>;
    };

    expect(manifest.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web", startCommand: "pnpm start" }),
        expect.objectContaining({ type: "worker", startCommand: "pnpm start:worker" }),
        expect.objectContaining({ type: "redis", plan: "free" }),
      ]),
    );
  });
});
