import { describe, expect, it } from "vitest";
import { formatCancellation, formatConfirmation, formatDraft } from "./formatting.js";

describe("Slack Block Kit formatting", () => {
  it("formats a parsed draft with confirm and cancel actions", () => {
    expect(
      formatDraft([
        {
          foodName: "Oatmeal",
          foodDescription: "One bowl",
          category: "breads_and_cereals",
          meal: "breakfast",
          nutrients: { calories: 320 },
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "section" }),
        expect.objectContaining({
          type: "actions",
          elements: expect.arrayContaining([
            expect.objectContaining({ action_id: "food_confirm" }),
            expect.objectContaining({ action_id: "food_cancel" }),
          ]),
        }),
      ]),
    );
  });

  it("renders target-returned IDs and available server summary", () => {
    const blocks = formatConfirmation({
      entries: [{ id: "entry-1", externalId: "draft-1" }],
      dailyIntake: {
        date: "2026-08-13",
        state: "available",
        summary: { calories: 1_200, protein_g: 80 },
        resolution: {},
      },
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain("entry-1");
    expect(text).toContain("1,200");
    expect(text).not.toContain("expenditure");
  });

  it("reports an unavailable server summary without computing a replacement", () => {
    const blocks = formatConfirmation({
      entries: [{ id: "entry-1", externalId: "draft-1" }],
      dailyIntake: {
        date: "2026-08-13",
        state: "unavailable",
        summary: null,
        resolution: { message: "Nutrition sources conflict" },
      },
    });
    const text = JSON.stringify(blocks);

    expect(text).toContain("Nutrition sources conflict");
    expect(text).toContain("unavailable");
    expect(text).not.toContain("Daily total:");
  });

  it("renders opaque undefined summary values without throwing", () => {
    expect(() =>
      formatConfirmation({
        entries: [{ id: "entry-1", externalId: "draft-1" }],
        dailyIntake: {
          date: "2026-08-13",
          state: "available",
          summary: { note: undefined },
          resolution: {},
        },
      }),
    ).not.toThrow();
  });

  it("renders cancellation as a standalone message", () => {
    expect(formatCancellation()).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Food draft cancelled." },
      },
    ]);
  });
});
