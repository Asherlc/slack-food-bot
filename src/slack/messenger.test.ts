import { describe, expect, it, vi } from "vitest";
import { SlackMessenger } from "./messenger.js";

describe("SlackMessenger", () => {
  it("posts a threaded draft and returns its Slack message timestamp", async () => {
    const postMessage = vi.fn(async () => ({ ts: "2.000001" }));
    const messenger = new SlackMessenger({ chat: { postMessage, update: vi.fn() } });

    await expect(
      messenger.publishDraft({
        teamId: "T1",
        channelId: "D1",
        threadTs: "1.000001",
        items: [
          {
            foodName: "Oatmeal",
            foodDescription: "One bowl",
            category: "breads_and_cereals",
            meal: "breakfast",
            nutrients: { calories: 320 },
          },
        ],
      }),
    ).resolves.toEqual({ confirmationMessageTs: "2.000001" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", thread_ts: "1.000001" }),
    );
  });

  it("updates an existing draft when the user refines its thread", async () => {
    const update = vi.fn(async () => ({}));
    const messenger = new SlackMessenger({ chat: { postMessage: vi.fn(), update } });

    await messenger.publishRefinedDraft({
      teamId: "T1",
      channelId: "D1",
      confirmationMessageTs: "2.000001",
      items: [
        {
          foodName: "Oatmeal",
          foodDescription: "Two bowls",
          category: "breads_and_cereals",
          meal: "breakfast",
          nutrients: { calories: 640 },
        },
      ],
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ channel: "D1", ts: "2.000001" }));
  });
});
