import { describe, expect, it, vi } from "vitest";
import type { NutritionItem } from "../targets/types.js";
import { FoodWorkflow } from "./food-workflow.js";

const item: NutritionItem = {
  foodName: "Oatmeal",
  foodDescription: "One bowl",
  category: "breads_and_cereals",
  meal: "breakfast",
  nutrients: { calories: 320 },
};

describe("FoodWorkflow", () => {
  it("turns an analysis job into a persisted draft after parsing off the Slack request path", async () => {
    const analyzer = { analyze: vi.fn(async () => [item]) };
    const pending = { save: vi.fn(async () => ["entry-1"]) };
    const messenger = {
      publishDraft: vi.fn(async () => ({ confirmationMessageTs: "2.000001" })),
    };
    const workflow = new FoodWorkflow({ analyzer, pending, messenger });

    await workflow.analyze({
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      threadTs: "1.000001",
      sourceMessageTs: "1.000001",
      text: "oatmeal for breakfast",
      localDate: "2026-08-20",
      localTime: "08:00",
    });

    expect(analyzer.analyze).toHaveBeenCalledWith("oatmeal for breakfast", "08:00");
    expect(pending.save).toHaveBeenCalledWith([
      expect.objectContaining({
        externalSubject: "slack:T1:U1",
        date: "2026-08-20",
        item,
        confirmationMessageTs: "2.000001",
      }),
    ]);
  });

  it("reissues a missing grant and confirms pending entries with a deterministic idempotency key", async () => {
    const entry = {
      id: "entry-1",
      externalSubject: "slack:T1:U1",
      date: "2026-08-20",
      item,
      channelId: "D1",
      confirmationMessageTs: "2.000001",
      threadTs: "1.000001",
      sourceMessageTs: "1.000001",
      slackUserId: "U1",
    };
    const pending = {
      loadByIds: vi.fn(async () => [entry]),
      deleteByIds: vi.fn(async () => undefined),
    };
    const grants = {
      loadGrant: vi.fn(async () => null),
      saveGrant: vi.fn(async () => undefined),
    };
    const target = {
      reissueGrant: vi.fn(async () => ({
        externalSubject: "opaque-subject",
        grantId: "grant-1",
        accessToken: "access-token",
        expiresInSeconds: 900,
      })),
      confirmFood: vi.fn(async () => ({
        entries: [{ id: "dofek-entry-1", externalId: "entry-1" }],
        dailyIntake: {
          date: "2026-08-20",
          state: "available" as const,
          summary: { calories: 320 },
          resolution: {},
        },
      })),
    };
    const messenger = { publishConfirmed: vi.fn(async () => undefined) };
    const workflow = new FoodWorkflow({ pending, grants, target, messenger });

    await workflow.confirm({ teamId: "T1", userId: "U1", channelId: "D1", entryIds: ["entry-1"] });

    expect(target.reissueGrant).toHaveBeenCalledWith({
      identity: { namespace: "slack", subject: "T1:U1" },
    });
    expect(target.confirmFood).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^slack-food-confirmation:[a-f0-9]{64}$/),
        entries: [expect.objectContaining({ date: "2026-08-20", externalId: "entry-1" })],
      }),
    );
    expect(pending.deleteByIds).toHaveBeenCalledWith(["entry-1"]);
    expect(messenger.publishConfirmed).toHaveBeenCalledTimes(1);
  });

  it("refines a thread draft and replaces the pending entries without writing to Dofek", async () => {
    const entry = {
      id: "entry-1",
      externalSubject: "slack:T1:U1",
      date: "2026-08-20",
      item,
      channelId: "D1",
      confirmationMessageTs: "2.000001",
      threadTs: "1.000001",
      sourceMessageTs: "1.000001",
      slackUserId: "U1",
    };
    const analyzer = { refine: vi.fn(async () => [{ ...item, foodDescription: "Two bowls" }]) };
    const pending = {
      findIdsByMessage: vi.fn(async () => ["entry-1"]),
      loadByIds: vi.fn(async () => [entry]),
      deleteByIds: vi.fn(async () => undefined),
      save: vi.fn(async () => ["entry-2"]),
    };
    const messenger = { publishRefinedDraft: vi.fn(async () => undefined) };
    const workflow = new FoodWorkflow({ analyzer, pending, messenger });

    await workflow.refine({
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      confirmationMessageTs: "2.000001",
      text: "make it two bowls",
      localTime: "08:05",
    });

    expect(analyzer.refine).toHaveBeenCalledWith([item], "make it two bowls", "08:05");
    expect(messenger.publishRefinedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationMessageTs: "2.000001" }),
    );
    expect(pending.deleteByIds).toHaveBeenCalledWith(["entry-1"]);
    expect(pending.save).toHaveBeenCalledWith([
      expect.objectContaining({ item: { ...item, foodDescription: "Two bowls" } }),
    ]);
  });
});
