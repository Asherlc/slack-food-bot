import { describe, expect, it, vi } from "vitest";
import { processFoodJob } from "./worker.js";

describe("food job worker", () => {
  it("routes a confirmed Slack action to the confirmation workflow", async () => {
    const confirm = vi.fn(async () => undefined);

    await processFoodJob(
      {
        kind: "confirm",
        id: "confirm:T1:U1:2.000001",
        teamId: "T1",
        userId: "U1",
        channelId: "D1",
        entryIds: ["entry-1"],
      },
      { analyze: vi.fn(), refine: vi.fn(), confirm, cancel: vi.fn() },
    );

    expect(confirm).toHaveBeenCalledWith({
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      entryIds: ["entry-1"],
    });
  });
});
