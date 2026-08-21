import { describe, expect, it } from "vitest";
import { type FoodJob, InMemoryFoodJobQueue } from "./queue.js";

const job: FoodJob = {
  kind: "analyze",
  id: "event-1",
  teamId: "T1",
  userId: "U1",
  channelId: "D1",
  threadTs: "1.000001",
  sourceMessageTs: "1.000001",
  text: "oatmeal for breakfast",
  localDate: "2026-08-20",
  localTime: "08:00",
};

describe("food job queue", () => {
  it("deduplicates Slack delivery retries by a stable job ID", async () => {
    const queue = new InMemoryFoodJobQueue();

    await queue.enqueue(job);
    await queue.enqueue(job);

    expect(queue.jobs).toEqual([job]);
  });
});
