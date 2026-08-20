import { type ConnectionOptions, Worker } from "bullmq";
import type { FoodWorkflow } from "../workflows/food-workflow.js";
import type { FoodJob } from "./queue.js";

type FoodJobWorkflow = Pick<FoodWorkflow, "analyze" | "refine" | "confirm" | "cancel">;

export async function processFoodJob(job: FoodJob, workflow: FoodJobWorkflow): Promise<void> {
  switch (job.kind) {
    case "analyze":
      await workflow.analyze({
        teamId: job.teamId,
        userId: job.userId,
        channelId: job.channelId,
        threadTs: job.threadTs,
        sourceMessageTs: job.sourceMessageTs,
        text: job.text,
        localDate: job.localDate,
        localTime: job.localTime,
      });
      return;
    case "confirm":
      await workflow.confirm({
        teamId: job.teamId,
        userId: job.userId,
        channelId: job.channelId,
        entryIds: job.entryIds,
      });
      return;
    case "cancel":
      await workflow.cancel({
        teamId: job.teamId,
        userId: job.userId,
        channelId: job.channelId,
        entryIds: job.entryIds,
      });
      return;
    case "refine":
      await workflow.refine({
        teamId: job.teamId,
        userId: job.userId,
        channelId: job.channelId,
        confirmationMessageTs: job.confirmationMessageTs,
        text: job.text,
        localTime: job.localTime,
      });
  }
}

export function createFoodWorker(
  connection: ConnectionOptions,
  workflow: FoodJobWorkflow,
): Worker<FoodJob> {
  return new Worker<FoodJob>("slack-food-bot", async (job) => processFoodJob(job.data, workflow), {
    connection,
    concurrency: 4,
  });
}
