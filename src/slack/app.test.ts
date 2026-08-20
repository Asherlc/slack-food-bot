import { describe, expect, it, vi } from "vitest";
import { registerSlackHandlers, type SlackActionArgs, type SlackEventArgs } from "./app.js";

class FakeSlackApp {
  readonly events = new Map<string, (args: SlackEventArgs) => Promise<void>>();
  readonly actions = new Map<string, (args: SlackActionArgs) => Promise<void>>();

  event(name: string, handler: (args: SlackEventArgs) => Promise<void>): void {
    this.events.set(name, handler);
  }

  action(name: string, handler: (args: SlackActionArgs) => Promise<void>): void {
    this.actions.set(name, handler);
  }
}

describe("Slack event registration", () => {
  it("queues an app mention without doing AI work in the request", async () => {
    const app = new FakeSlackApp();
    const enqueue = vi.fn(async () => undefined);
    registerSlackHandlers(app, {
      queue: { enqueue },
      pending: { findIdsByMessage: vi.fn() },
      now: () => ({ date: "2026-08-20", time: "08:00" }),
    });

    await app.events.get("app_mention")?.({
      event: { text: "<@B1> oatmeal", user: "U1", channel: "D1", ts: "1.000001" },
      body: { team_id: "T1", event_id: "Ev1" },
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "analyze",
        id: "analyze:T1:Ev1",
        text: "oatmeal",
        localDate: "2026-08-20",
      }),
    );
  });

  it("acknowledges a confirmation action before queuing its worker job", async () => {
    const app = new FakeSlackApp();
    const ack = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    registerSlackHandlers(app, {
      queue: { enqueue },
      pending: { findIdsByMessage: vi.fn(async () => ["entry-1"]) },
      now: () => ({ date: "2026-08-20", time: "08:00" }),
    });

    await app.actions.get("food_confirm")?.({
      ack,
      body: {
        team: { id: "T1" },
        user: { id: "U1" },
        container: { channel_id: "D1", message_ts: "2.000001" },
      },
    });

    expect(ack).toHaveBeenCalledBefore(enqueue);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm", entryIds: ["entry-1"] }),
    );
  });
});
