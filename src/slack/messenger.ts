import type { ConfirmedNutritionWrite } from "../targets/types.js";
import type { DraftMessenger } from "../workflows/food-workflow.js";
import { formatCancellation, formatConfirmation, formatDraft } from "./formatting.js";

type SlackChatClient = {
  postMessage(input: Record<string, unknown>): Promise<{ ts?: string }>;
  update(input: Record<string, unknown>): Promise<unknown>;
};

export class SlackMessenger implements DraftMessenger {
  readonly #chat: SlackChatClient;

  constructor(client: { chat: SlackChatClient }) {
    this.#chat = client.chat;
  }

  async publishDraft(input: Parameters<DraftMessenger["publishDraft"]>[0]): Promise<{
    confirmationMessageTs: string;
  }> {
    const response = await this.#chat.postMessage({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: "Food draft ready for confirmation.",
      blocks: formatDraft(input.items),
    });
    if (!response.ts)
      throw new Error("Slack did not return a message timestamp for the food draft");
    return { confirmationMessageTs: response.ts };
  }

  async publishConfirmed(input: {
    channelId: string;
    confirmationMessageTs: string;
    result: ConfirmedNutritionWrite;
  }): Promise<void> {
    await this.#chat.update({
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food confirmed.",
      blocks: formatConfirmation(input.result),
    });
  }

  async publishRefinedDraft(input: {
    channelId: string;
    confirmationMessageTs: string;
    items: Parameters<DraftMessenger["publishDraft"]>[0]["items"];
  }): Promise<void> {
    await this.#chat.update({
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food draft updated for confirmation.",
      blocks: formatDraft(input.items),
    });
  }

  async publishCancelled(input: {
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void> {
    await this.#chat.update({
      channel: input.channelId,
      ts: input.confirmationMessageTs,
      text: "Food draft cancelled.",
      blocks: formatCancellation(),
    });
  }
}
