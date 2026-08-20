import { describe, expect, it } from "vitest";
import { processFoodQueueJob } from "./consumer.js";

const oatmeal = {
  foodName: "oatmeal",
  foodDescription: "one bowl",
  category: "breads_and_cereals" as const,
  meal: "breakfast" as const,
  nutrients: { calories: 220 },
};

describe("Cloudflare food Queue consumer", () => {
  it("creates encrypted pending entries after analyzing a Slack DM", async () => {
    const saved: unknown[] = [];
    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "Ev1",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1710000000.000001",
            text: "oatmeal",
          },
        },
      },
      {
        analyze: async () => [oatmeal],
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async (entries) => {
          saved.push(...entries);
        },
      },
    );

    expect(saved).toEqual([
      expect.objectContaining({
        id: "entry:Ev1:0",
        externalSubject: "slack:T1:U1",
        channelId: "D1",
        confirmationMessageTs: "1710000001.000001",
        item: oatmeal,
      }),
    ]);
  });

  it("creates a draft when a user messages the writable App Home", async () => {
    const saved: unknown[] = [];
    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvAppHome",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "app_home",
            user: "U1",
            channel: "D1",
            ts: "1710000000.000001",
            text: "oatmeal",
          },
        },
      },
      {
        analyze: async () => [oatmeal],
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async (entries) => {
          saved.push(...entries);
        },
      },
    );

    expect(saved).toEqual([
      expect.objectContaining({
        id: "entry:EvAppHome:0",
        externalSubject: "slack:T1:U1",
        channelId: "D1",
        item: oatmeal,
      }),
    ]);
  });

  it("confirms only the action owner's pending draft with one stable Dofek write", async () => {
    const writes: unknown[] = [];
    const confirmed: unknown[] = [];
    const entry = {
      id: "entry:Ev1:0",
      externalSubject: "slack:T1:U1",
      date: "2024-03-09",
      item: oatmeal,
      channelId: "D1",
      confirmationMessageTs: "2.0",
      slackUserId: "U1",
      threadTs: "1.0",
      sourceMessageTs: "1.0",
    };
    await processFoodQueueJob(
      {
        kind: "action",
        action: "confirm",
        deliveryId: "action:confirm:T1:U1:2.0",
        payload: {
          team: { id: "T1" },
          user: { id: "U1" },
          container: { channel_id: "D1", message_ts: "2.0" },
        },
      },
      {
        findPending: async () => [entry],
        loadGrant: async () => null,
        reissueGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        saveGrant: async () => undefined,
        confirmFood: async (input) => {
          writes.push(input);
          return {
            entries: [{ id: "server-entry", externalId: "entry:Ev1:0" }],
            dailyIntake: {
              date: "2024-03-09",
              state: "unavailable",
              summary: null,
              resolution: {},
            },
          };
        },
        publishConfirmed: async (input) => {
          confirmed.push(input);
        },
        deletePending: async () => undefined,
      },
    );

    expect(writes).toEqual([
      expect.objectContaining({
        entries: [expect.objectContaining({ externalId: "entry:Ev1:0", date: "2024-03-09" })],
        idempotencyKey: expect.stringMatching(/^slack-food-confirmation:[a-f0-9]{64}$/),
      }),
    ]);
    expect(confirmed).toHaveLength(1);
  });
});
