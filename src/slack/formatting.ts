import type { ConfirmedNutritionWrite } from "../targets/types.js";

export type BlockKitBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

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
