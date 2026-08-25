import type { ConfirmedNutritionWrite, NutritionItem } from "../targets/types.js";

export type BlockKitBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | {
      type: "actions";
      elements: Array<{
        type: "button";
        text: { type: "plain_text"; text: string };
        action_id: "food_confirm" | "food_cancel";
        style?: "primary" | "danger";
      }>;
    };

export function formatDraft(items: ReadonlyArray<NutritionItem>): BlockKitBlock[] {
  const lines = items.map(
    (item) =>
      `• *${escapeMrkdwn(item.foodName)}* (${escapeMrkdwn(item.meal)}): ${formatSummary(item.nutrients)}`,
  );
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Draft food log:\n${lines.join("\n")}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm" },
          action_id: "food_confirm",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "food_cancel",
          style: "danger",
        },
      ],
    },
  ];
}

export function formatConfirmation(result: ConfirmedNutritionWrite): BlockKitBlock[] {
  const ids = result.entries.map((entry) => escapeMrkdwn(entry.id)).join(", ");
  const blocks: BlockKitBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Food confirmed. Entry IDs: ${ids || "none returned"}`,
      },
    },
  ];

  if (result.dailyIntake.state === "available") {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Daily intake summary for ${escapeMrkdwn(result.dailyIntake.date)}: ${formatSummary(result.dailyIntake.summary)}`,
        },
      ],
    });
  } else {
    const message = result.dailyIntake.resolution.message;
    const resolution =
      typeof message === "string" ? message : "The target could not resolve a daily summary.";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Daily intake unavailable: ${escapeMrkdwn(resolution)}`,
        },
      ],
    });
  }

  return blocks;
}

export function formatProcessing(): BlockKitBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Saving food log…" },
    },
  ];
}

export function formatConfirmationFailure(input: { dofekStatus?: number } = {}): BlockKitBlock[] {
  const status =
    typeof input.dofekStatus === "number" && input.dofekStatus >= 100 && input.dofekStatus <= 599
      ? ` Dofek status: ${input.dofekStatus}.`
      : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `This food log could not be saved.${status} Link Dofek if needed, then try again.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Try again" },
          action_id: "food_confirm",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "food_cancel",
          style: "danger",
        },
      ],
    },
  ];
}

export function formatCancellation(): BlockKitBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Food draft cancelled." },
    },
  ];
}

function formatSummary(summary: Readonly<Record<string, unknown>>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${escapeMrkdwn(key)}: ${formatValue(value)}`)
    .join(" · ");
}

function formatValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US").format(value);
  }
  if (typeof value === "string") return escapeMrkdwn(value);
  return escapeMrkdwn(JSON.stringify(value) ?? String(value));
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
