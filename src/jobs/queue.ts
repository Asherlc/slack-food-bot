import { type ConnectionOptions, Queue } from "bullmq";

type BaseFoodJob = {
  id: string;
  teamId: string;
  userId: string;
  channelId: string;
};

export type FoodJob =
  | (BaseFoodJob & {
      kind: "analyze";
      threadTs: string;
      sourceMessageTs: string;
      text: string;
      localDate: string;
      localTime: string;
    })
  | (BaseFoodJob & { kind: "confirm"; entryIds: ReadonlyArray<string> })
  | (BaseFoodJob & { kind: "cancel"; entryIds: ReadonlyArray<string> })
  | (BaseFoodJob & {
      kind: "refine";
      confirmationMessageTs: string;
      text: string;
      localDate: string;
      localTime: string;
    });

export interface FoodJobQueue {
  enqueue(job: FoodJob): Promise<void>;
}

export class InMemoryFoodJobQueue implements FoodJobQueue {
  readonly jobs: FoodJob[] = [];

  async enqueue(job: FoodJob): Promise<void> {
    if (this.jobs.some((existing) => existing.id === job.id)) return;
    this.jobs.push(job);
  }
}

export class BullFoodJobQueue implements FoodJobQueue {
  readonly #queue: Queue<FoodJob>;

  constructor(connection: ConnectionOptions) {
    this.#queue = new Queue<FoodJob>("slack-food-bot", { connection });
  }

  async enqueue(job: FoodJob): Promise<void> {
    await this.#queue.add(job.kind, job, {
      jobId: job.id,
      attempts: 4,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
