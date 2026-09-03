import { describe, expect, it, vi } from "vitest";
import { processFoodQueueJob } from "./consumer.js";

const oatmeal = {
  foodName: "oatmeal",
  foodDescription: "one bowl",
  category: "breads_and_cereals" as const,
  meal: "breakfast" as const,
  nutrients: { calories: 220 },
};

describe("Cloudflare food Queue consumer", () => {
  it("uses the Slack sender's timezone for meal inference", async () => {
    const analyzedLocalTimes: string[] = [];

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvPacificLunch",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1788463800.000001",
            text: "large plate of steak fajitas",
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        resolveUserTimeZone: async () => "America/Los_Angeles",
        analyze: async (_text, localTime) => {
          analyzedLocalTimes.push(localTime);
          return [oatmeal];
        },
        publishDraft: async () => ({ confirmationMessageTs: "1788463801.000001" }),
        savePending: async () => undefined,
      },
    );

    expect(analyzedLocalTimes).toEqual(["12:30"]);
  });

  it("persists the Slack sender's local calendar date", async () => {
    const savedDates: string[] = [];

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvPacificEvening",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1719793800.000001",
            text: "large plate of steak fajitas",
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        resolveUserTimeZone: async () => "America/Los_Angeles",
        analyze: async () => [oatmeal],
        publishDraft: async () => ({ confirmationMessageTs: "1719793801.000001" }),
        savePending: async (entries) => {
          savedDates.push(...entries.map((entry) => entry.date));
        },
      },
    );

    expect(savedDates).toEqual(["2024-06-30"]);
  });

  it("analyzes an image-only DM without persisting the Slack photo", async () => {
    const analyzed: unknown[] = [];
    const saved: unknown[] = [];

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvPhoto",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            subtype: "file_share",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1710000000.000001",
            files: [
              {
                id: "F1",
                mimetype: "image/jpeg",
                url_private_download: "https://files.slack.test/F1.jpg",
              },
            ],
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        analyzeImage: async (input) => {
          analyzed.push(input);
          return [oatmeal];
        },
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async (entries) => {
          saved.push(...entries);
        },
      },
    );

    expect(analyzed).toEqual([
      expect.objectContaining({
        teamId: "T1",
        url: "https://files.slack.test/F1.jpg",
        mediaType: "image/jpeg",
        text: "",
        localTime: "16:00",
      }),
    ]);
    expect(saved).toEqual([expect.objectContaining({ id: "entry:EvPhoto:0", item: oatmeal })]);
  });

  it("routes an image with pending Slack metadata by file id instead of analyzing its text", async () => {
    const analyzed: unknown[] = [];
    const analyzeText = vi.fn(async () => [oatmeal]);

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvPendingPhoto",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1710000000.000001",
            text: "toilet.jpg",
            files: [
              {
                id: "F1",
                mode: "file_access",
                file_access: "check_file_info",
              },
            ],
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        analyze: analyzeText,
        analyzeImage: async (input) => {
          analyzed.push(input);
          return [oatmeal];
        },
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async () => undefined,
      },
    );

    expect(analyzeText).not.toHaveBeenCalled();
    expect(analyzed).toEqual([
      expect.objectContaining({ teamId: "T1", fileId: "F1", text: "toilet.jpg" }),
    ]);
  });

  it("defers a filename-only upload placeholder instead of analyzing it as food", async () => {
    const analyzeText = vi.fn(async () => [oatmeal]);

    await expect(
      processFoodQueueJob(
        {
          kind: "event",
          deliveryId: "EvUploadPlaceholder",
          payload: {
            team_id: "T1",
            event: {
              type: "message",
              subtype: "file_share",
              channel_type: "im",
              user: "U1",
              channel: "D1",
              ts: "1710000000.000001",
              text: "Uploaded a file",
            },
          },
        },
        {
          loadGrant: async () => ({
            externalSubject: "T1:U1",
            grantId: "grant-1",
            accessToken: "token",
            expiresInSeconds: 900,
          }),
          publishLinkRequired: async () => undefined,
          analyze: analyzeText,
          publishDraft: async () => {
            throw new Error("must not publish a draft");
          },
          savePending: async () => undefined,
        },
      ),
    ).resolves.toBe("image-pending");
    expect(analyzeText).not.toHaveBeenCalled();
  });

  it("defers Slack's private-file URL placeholder instead of analyzing it as food", async () => {
    const analyzeText = vi.fn(async () => [oatmeal]);

    await expect(
      processFoodQueueJob(
        {
          kind: "event",
          deliveryId: "EvPrivateFilePlaceholder",
          payload: {
            team_id: "T1",
            event: {
              type: "message",
              channel_type: "im",
              user: "U1",
              channel: "D1",
              ts: "1710000000.000001",
              text: "<https://files.slack.com/files-pri/T1-F1/photo.heic|photo.heic>",
            },
          },
        },
        {
          loadGrant: async () => ({
            externalSubject: "T1:U1",
            grantId: "grant-1",
            accessToken: "token",
            expiresInSeconds: 900,
          }),
          publishLinkRequired: async () => undefined,
          analyze: analyzeText,
          publishDraft: async () => {
            throw new Error("must not publish a draft");
          },
          savePending: async () => undefined,
        },
      ),
    ).resolves.toBe("image-pending");
    expect(analyzeText).not.toHaveBeenCalled();
  });

  it("analyzes the completed image nested in Slack's message_changed event", async () => {
    const analyzed: unknown[] = [];

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvCompletedUpload",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            subtype: "message_changed",
            channel_type: "im",
            channel: "D1",
            message: {
              type: "message",
              user: "U1",
              text: "toilet.jpg",
              ts: "1710000000.000001",
              files: [
                {
                  id: "F1",
                  mimetype: "image/jpeg",
                  url_private_download: "https://files.slack.test/F1.jpg",
                  thumb_1024: "https://files.slack.test/F1_1024.jpg",
                  thumb_480: "https://files.slack.test/F1_480.jpg",
                },
              ],
            },
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        analyzeImage: async (input) => {
          analyzed.push(input);
          return [oatmeal];
        },
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async () => undefined,
      },
    );

    expect(analyzed).toEqual([
      expect.objectContaining({
        teamId: "T1",
        url: "https://files.slack.test/F1_1024.jpg",
        mediaType: "image/jpeg",
      }),
    ]);
  });

  it("tells the user when photo analysis fails instead of going silent", async () => {
    const failures: unknown[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        processFoodQueueJob(
          {
            kind: "event",
            deliveryId: "EvPhotoFailure",
            payload: {
              team_id: "T1",
              event: {
                type: "message",
                subtype: "file_share",
                channel_type: "im",
                user: "U1",
                channel: "D1",
                ts: "1710000000.000001",
                files: [
                  {
                    mimetype: "image/jpeg",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/F1.jpg",
                  },
                ],
              },
            },
          },
          {
            loadGrant: async () => ({
              externalSubject: "T1:U1",
              grantId: "grant-1",
              accessToken: "token",
              expiresInSeconds: 900,
            }),
            publishLinkRequired: async () => undefined,
            analyzeImage: async () => {
              throw new Error("Slack image download failed with status 403");
            },
            publishAnalysisFailure: async (input) => {
              failures.push(input);
            },
            publishDraft: async () => {
              throw new Error("must not publish a draft");
            },
            savePending: async () => {
              throw new Error("must not save pending entries");
            },
          },
        ),
      ).resolves.toBe("analysis-failed");

      expect(errorLog).toHaveBeenCalledWith("Slack analysis failed", {
        deliveryId: "EvPhotoFailure",
        kind: "image",
        error: "Slack image download failed with status 403",
      });
    } finally {
      errorLog.mockRestore();
    }

    expect(failures).toEqual([
      {
        teamId: "T1",
        channelId: "D1",
        threadTs: "1710000000.000001",
        reason: "error",
      },
    ]);
  });

  it("tells the user when text analysis times out", async () => {
    const failures: unknown[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        processFoodQueueJob(
          {
            kind: "event",
            deliveryId: "EvTextTimeout",
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
            loadGrant: async () => ({
              externalSubject: "T1:U1",
              grantId: "grant-1",
              accessToken: "token",
              expiresInSeconds: 900,
            }),
            publishLinkRequired: async () => undefined,
            analysisTimeoutMs: 1,
            analyze: async () => new Promise(() => undefined),
            publishAnalysisFailure: async (input) => {
              failures.push(input);
            },
            publishDraft: async () => {
              throw new Error("must not publish a draft");
            },
            savePending: async () => undefined,
          },
        ),
      ).resolves.toBe("analysis-failed");
    } finally {
      errorLog.mockRestore();
    }

    expect(failures).toEqual([
      {
        teamId: "T1",
        channelId: "D1",
        threadTs: "1710000000.000001",
        reason: "timeout",
      },
    ]);
  });

  it("tells the user when a photo does not clearly contain food", async () => {
    const failures: unknown[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        processFoodQueueJob(
          {
            kind: "event",
            deliveryId: "EvNotFood",
            payload: {
              team_id: "T1",
              event: {
                type: "message",
                subtype: "file_share",
                channel_type: "im",
                user: "U1",
                channel: "D1",
                ts: "1710000000.000001",
                files: [
                  {
                    mimetype: "image/jpeg",
                    url_private_download: "https://files.slack.com/not-food.jpg",
                  },
                ],
              },
            },
          },
          {
            loadGrant: async () => ({
              externalSubject: "T1:U1",
              grantId: "grant-1",
              accessToken: "token",
              expiresInSeconds: 900,
            }),
            publishLinkRequired: async () => undefined,
            analyzeImage: async () => {
              const error = new Error("No food or beverage was confidently detected in the image");
              error.name = "NoFoodDetectedError";
              throw error;
            },
            publishAnalysisFailure: async (input) => {
              failures.push(input);
            },
            publishDraft: async () => {
              throw new Error("must not publish a draft");
            },
            savePending: async () => undefined,
          },
        ),
      ).resolves.toBe("analysis-failed");
    } finally {
      errorLog.mockRestore();
    }

    expect(failures).toEqual([
      {
        teamId: "T1",
        channelId: "D1",
        threadTs: "1710000000.000001",
        reason: "no-food",
      },
    ]);
  });

  it("requires a Dofek link before analyzing or drafting a food message", async () => {
    const analyze = vi.fn(async () => [oatmeal]);
    const prompts: unknown[] = [];

    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvLinkRequired",
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
        loadGrant: async () => null,
        publishLinkRequired: async (input) => {
          prompts.push(input);
        },
        analyze,
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async () => undefined,
      },
    );

    expect(prompts).toEqual([{ teamId: "T1", channelId: "D1", threadTs: "1710000000.000001" }]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("creates encrypted pending entries after analyzing a Slack DM", async () => {
    const saved: unknown[] = [];
    const loadedSubjects: string[] = [];
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
        loadGrant: async (subject) => {
          loadedSubjects.push(subject);
          return {
            externalSubject: "T1:U1",
            grantId: "grant-1",
            accessToken: "token",
            expiresInSeconds: 900,
          };
        },
        publishLinkRequired: async () => undefined,
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
    expect(loadedSubjects).toEqual(["T1:U1"]);
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
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
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

  it("asks for components instead of estimating a bare multi-word food label", async () => {
    const clarifications: unknown[] = [];
    const clarificationStates: unknown[] = [];
    const analyze = vi.fn(async () => [oatmeal]);
    const saved: unknown[] = [];
    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvClarify",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1710000000.000001",
            text: "1 hot dog",
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        analyze,
        publishClarification: async (input) => {
          clarifications.push(input);
        },
        saveClarification: async (input) => {
          clarificationStates.push(input);
        },
        publishDraft: async () => ({ confirmationMessageTs: "1710000001.000001" }),
        savePending: async (entries) => {
          saved.push(...entries);
        },
      },
    );

    expect(clarifications).toEqual([
      {
        teamId: "T1",
        channelId: "D1",
        threadTs: "1710000000.000001",
        description: "1 hot dog",
      },
    ]);
    expect(analyze).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(clarificationStates).toEqual([
      {
        teamId: "T1",
        channelId: "D1",
        threadTs: "1710000000.000001",
        userId: "U1",
        description: "1 hot dog",
      },
    ]);
  });

  it("combines a clarification reply with the original food description", async () => {
    const analyzed: string[] = [];
    const saved: unknown[] = [];
    await processFoodQueueJob(
      {
        kind: "event",
        deliveryId: "EvClarificationReply",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1710000002.000001",
            thread_ts: "1710000000.000001",
            text: "no bun",
          },
        },
      },
      {
        loadGrant: async () => ({
          externalSubject: "T1:U1",
          grantId: "grant-1",
          accessToken: "token",
          expiresInSeconds: 900,
        }),
        publishLinkRequired: async () => undefined,
        consumeClarification: async () => ({ description: "1 hot dog" }),
        analyze: async (text) => {
          analyzed.push(text);
          return [oatmeal];
        },
        publishDraft: async () => ({ confirmationMessageTs: "1710000003.000001" }),
        savePending: async (entries) => {
          saved.push(...entries);
        },
      },
    );

    expect(analyzed).toEqual(["1 hot dog\nClarification: no bun"]);
    expect(saved).toEqual([
      expect.objectContaining({
        sourceMessageTs: "1710000002.000001",
        threadTs: "1710000000.000001",
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
        publishProcessing: async () => undefined,
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
        publishConfirmationFailure: async () => {
          throw new Error("must not publish failure");
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

  it("shows a failed save state and keeps the draft when Dofek confirmation fails", async () => {
    const phases: string[] = [];
    const failures: unknown[] = [];
    const deleted: unknown[] = [];
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

    await expect(
      processFoodQueueJob(
        {
          kind: "action",
          action: "confirm",
          deliveryId: "action:confirm:T1:U1:2.0:1710000000.000001",
          payload: {
            team: { id: "T1" },
            user: { id: "U1" },
            container: { channel_id: "D1", message_ts: "2.0" },
          },
        },
        {
          findPending: async () => [entry],
          loadGrant: async () => ({
            externalSubject: "T1:U1",
            grantId: "grant-1",
            accessToken: "token",
            expiresInSeconds: 900,
          }),
          saveGrant: async () => undefined,
          reissueGrant: async () => {
            throw new Error("must not reissue");
          },
          publishProcessing: async () => {
            phases.push("processing");
          },
          confirmFood: async () => {
            throw new Error("Dofek nutrition write failed with status 503");
          },
          publishConfirmationFailure: async (input) => {
            phases.push("failed");
            failures.push(input);
          },
          publishConfirmed: async () => {
            throw new Error("must not publish success");
          },
          deletePending: async (ids) => {
            deleted.push(ids);
          },
        },
      ),
    ).resolves.toBe("action");

    expect(phases).toEqual(["processing", "failed"]);
    expect(failures).toEqual([expect.objectContaining({ dofekStatus: 503 })]);
    expect(deleted).toEqual([]);
  });

  it("shows a failed save state when updating the processing card fails", async () => {
    const failures: unknown[] = [];
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

    await expect(
      processFoodQueueJob(
        {
          kind: "action",
          action: "confirm",
          deliveryId: "action:confirm:T1:U1:2.0:1710000000.000001",
          payload: {
            team: { id: "T1" },
            user: { id: "U1" },
            container: { channel_id: "D1", message_ts: "2.0" },
            response_url: "https://hooks.slack.test/response",
          },
        },
        {
          findPending: async () => [entry],
          loadGrant: async () => {
            throw new Error("must not load grant");
          },
          saveGrant: async () => undefined,
          reissueGrant: async () => {
            throw new Error("must not reissue");
          },
          publishProcessing: async () => {
            throw new Error("Slack chat.update failed with status 500");
          },
          confirmFood: async () => {
            throw new Error("must not confirm");
          },
          publishConfirmationFailure: async (input) => {
            failures.push(input);
          },
          publishConfirmed: async () => {
            throw new Error("must not publish success");
          },
          deletePending: async () => undefined,
        },
      ),
    ).resolves.toBe("action");

    expect(failures).toEqual([
      expect.objectContaining({ responseUrl: "https://hooks.slack.test/response" }),
    ]);
  });

  it("reissues a rejected Dofek grant and retries the confirmation once", async () => {
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
    const writes: string[] = [];
    const savedTokens: string[] = [];
    const reissues: unknown[] = [];

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
        loadGrant: async () => ({
          externalSubject: "opaque-subject",
          grantId: "grant-1",
          accessToken: "rejected-token",
          expiresInSeconds: 900,
        }),
        saveGrant: async (_subject, grant) => {
          savedTokens.push(grant.accessToken);
        },
        reissueGrant: async (input) => {
          reissues.push(input);
          return {
            externalSubject: "opaque-subject",
            grantId: "grant-1",
            accessToken: "fresh-token",
            expiresInSeconds: 900,
          };
        },
        publishProcessing: async () => undefined,
        confirmFood: async ({ grant }) => {
          writes.push(grant.accessToken);
          if (grant.accessToken === "rejected-token")
            throw new Error("Dofek nutrition write failed with status 401");
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
        publishConfirmed: async () => undefined,
        publishConfirmationFailure: async () => {
          throw new Error("must not publish failure");
        },
        deletePending: async () => undefined,
      },
    );

    expect(writes).toEqual(["rejected-token", "fresh-token"]);
    expect(savedTokens).toEqual(["rejected-token", "fresh-token"]);
    expect(reissues).toEqual([{ identity: { namespace: "slack", subject: "T1:U1" } }]);
  });
});
