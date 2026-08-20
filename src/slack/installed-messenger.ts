import { WebClient } from "@slack/web-api";
import type { ConfirmedNutritionWrite, NutritionItem } from "../targets/types.js";
import { SlackMessenger } from "./messenger.js";

export class InstalledSlackMessenger {
  readonly #getBotToken: (teamId: string) => Promise<string>;

  constructor(getBotToken: (teamId: string) => Promise<string>) {
    this.#getBotToken = getBotToken;
  }

  async publishDraft(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<{ confirmationMessageTs: string }> {
    return (await this.#messenger(input.teamId)).publishDraft(input);
  }

  async publishConfirmed(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    result: ConfirmedNutritionWrite;
  }): Promise<void> {
    await (await this.#messenger(input.teamId)).publishConfirmed(input);
  }

  async publishRefinedDraft(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<void> {
    await (await this.#messenger(input.teamId)).publishRefinedDraft(input);
  }

  async publishCancelled(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void> {
    await (await this.#messenger(input.teamId)).publishCancelled(input);
  }

  async #messenger(teamId: string): Promise<SlackMessenger> {
    const client = new WebClient(await this.#getBotToken(teamId));
    return new SlackMessenger({
      chat: {
        postMessage: async (input) => client.chat.postMessage(input as never),
        update: async (input) => client.chat.update(input as never),
      },
    });
  }
}
