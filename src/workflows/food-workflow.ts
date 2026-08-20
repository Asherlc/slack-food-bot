import { createHash } from "node:crypto";
import type { NutritionAnalyzer } from "../ai/nutrition-analyzer.js";
import type { DofekLinkStore } from "../dofek/link-store.js";
import type { PendingEntryInput, PendingEntryStore } from "../slack/pending-entry-store.js";
import type { ConfirmedNutritionWrite, NutritionItem, NutritionTarget } from "../targets/types.js";

export type DraftMessenger = {
  publishDraft(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<{ confirmationMessageTs: string }>;
};

type ConfirmationMessenger = {
  publishConfirmed(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    result: ConfirmedNutritionWrite;
  }): Promise<void>;
};

type RefinementMessenger = {
  publishRefinedDraft(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
    items: ReadonlyArray<NutritionItem>;
  }): Promise<void>;
};

type CancellationMessenger = {
  publishCancelled(input: {
    teamId: string;
    channelId: string;
    confirmationMessageTs: string;
  }): Promise<void>;
};

type WorkflowPendingStore = Partial<
  Pick<PendingEntryStore, "save" | "loadByIds" | "deleteByIds" | "findIdsByMessage">
>;
type FoodTarget = Pick<NutritionTarget, "reissueGrant" | "confirmFood">;
type GrantStore = Pick<DofekLinkStore, "loadGrant" | "saveGrant">;

export class FoodWorkflow {
  readonly #analyzer: Partial<Pick<NutritionAnalyzer, "analyze" | "refine">> | undefined;
  readonly #pending: WorkflowPendingStore;
  readonly #messenger:
    | (Partial<DraftMessenger> &
        Partial<ConfirmationMessenger> &
        Partial<RefinementMessenger> &
        Partial<CancellationMessenger>)
    | undefined;
  readonly #grants: GrantStore | undefined;
  readonly #target: FoodTarget | undefined;

  constructor(input: {
    analyzer?: Partial<Pick<NutritionAnalyzer, "analyze" | "refine">>;
    pending: WorkflowPendingStore;
    messenger?: Partial<DraftMessenger> &
      Partial<ConfirmationMessenger> &
      Partial<RefinementMessenger> &
      Partial<CancellationMessenger>;
    grants?: GrantStore;
    target?: FoodTarget;
  }) {
    this.#analyzer = input.analyzer;
    this.#pending = input.pending;
    this.#messenger = input.messenger;
    this.#grants = input.grants;
    this.#target = input.target;
  }

  async refine(input: {
    teamId: string;
    userId: string;
    channelId: string;
    confirmationMessageTs: string;
    text: string;
    localTime: string;
  }): Promise<void> {
    if (
      !this.#analyzer?.refine ||
      !this.#pending.findIdsByMessage ||
      !this.#pending.loadByIds ||
      !this.#pending.deleteByIds ||
      !this.#pending.save ||
      !this.#messenger?.publishRefinedDraft
    ) {
      throw new Error("Food refinement workflow is not configured");
    }
    const ids = await this.#pending.findIdsByMessage(input.channelId, input.confirmationMessageTs);
    const entries = await this.#pending.loadByIds(ids);
    if (entries.length === 0) return;
    const externalSubject = `slack:${input.teamId}:${input.userId}`;
    if (
      entries.some(
        (entry) =>
          entry.externalSubject !== externalSubject ||
          entry.slackUserId !== input.userId ||
          entry.channelId !== input.channelId,
      )
    ) {
      throw new Error("Pending food entries do not belong to this Slack user");
    }
    const items = await this.#analyzer.refine(
      entries.map((entry) => entry.item),
      input.text,
      input.localTime,
    );
    await this.#messenger.publishRefinedDraft({
      teamId: input.teamId,
      channelId: input.channelId,
      confirmationMessageTs: input.confirmationMessageTs,
      items,
    });
    await this.#pending.deleteByIds(entries.map((entry) => entry.id));
    await this.#pending.save(
      items.map(
        (item): PendingEntryInput => ({
          externalSubject,
          date: entries[0]?.date ?? new Date().toISOString().slice(0, 10),
          item,
          channelId: input.channelId,
          confirmationMessageTs: input.confirmationMessageTs,
          threadTs: entries[0]?.threadTs ?? input.confirmationMessageTs,
          sourceMessageTs: entries[0]?.sourceMessageTs ?? input.confirmationMessageTs,
          slackUserId: input.userId,
        }),
      ),
    );
  }

  async analyze(input: {
    teamId: string;
    userId: string;
    channelId: string;
    threadTs: string;
    sourceMessageTs: string;
    text: string;
    localDate: string;
    localTime: string;
  }): Promise<void> {
    if (!this.#analyzer?.analyze || !this.#pending.save || !this.#messenger?.publishDraft) {
      throw new Error("Food analysis workflow is not configured");
    }
    const items = await this.#analyzer.analyze(input.text, input.localTime);
    const draft = await this.#messenger.publishDraft({
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      items,
    });
    await this.#pending.save(
      items.map(
        (item): PendingEntryInput => ({
          externalSubject: `slack:${input.teamId}:${input.userId}`,
          date: input.localDate,
          item,
          channelId: input.channelId,
          confirmationMessageTs: draft.confirmationMessageTs,
          threadTs: input.threadTs,
          sourceMessageTs: input.sourceMessageTs,
          slackUserId: input.userId,
        }),
      ),
    );
  }

  async confirm(input: {
    teamId: string;
    userId: string;
    channelId: string;
    entryIds: ReadonlyArray<string>;
  }): Promise<void> {
    if (
      !this.#pending.loadByIds ||
      !this.#pending.deleteByIds ||
      !this.#grants ||
      !this.#target ||
      !this.#messenger?.publishConfirmed
    ) {
      throw new Error("Food confirmation workflow is not configured");
    }
    const identity = { namespace: "slack", subject: `${input.teamId}:${input.userId}` };
    const externalSubject = `slack:${input.teamId}:${input.userId}`;
    const entries = await this.#pending.loadByIds(input.entryIds);
    const firstEntry = entries[0];
    if (!firstEntry) return;
    if (
      entries.some(
        (entry) =>
          entry.externalSubject !== externalSubject ||
          entry.slackUserId !== input.userId ||
          entry.channelId !== input.channelId,
      )
    ) {
      throw new Error("Pending food entries do not belong to this Slack user");
    }
    const grant =
      (await this.#grants.loadGrant(identity)) ?? (await this.#target.reissueGrant({ identity }));
    await this.#grants.saveGrant(identity, grant);
    const result = await this.#target.confirmFood({
      grant,
      idempotencyKey: confirmationIdempotencyKey(entries.map((entry) => entry.id)),
      entries: entries.map((entry) => ({ ...entry.item, date: entry.date, externalId: entry.id })),
    });
    await this.#messenger.publishConfirmed({
      teamId: input.teamId,
      channelId: input.channelId,
      confirmationMessageTs: firstEntry.confirmationMessageTs,
      result,
    });
    await this.#pending.deleteByIds(entries.map((entry) => entry.id));
  }

  async cancel(input: {
    teamId: string;
    userId: string;
    channelId: string;
    entryIds: ReadonlyArray<string>;
  }): Promise<void> {
    if (
      !this.#pending.loadByIds ||
      !this.#pending.deleteByIds ||
      !this.#messenger?.publishCancelled
    ) {
      throw new Error("Food cancellation workflow is not configured");
    }
    const entries = await this.#pending.loadByIds(input.entryIds);
    const firstEntry = entries[0];
    if (!firstEntry) return;
    const externalSubject = `slack:${input.teamId}:${input.userId}`;
    if (
      entries.some(
        (entry) =>
          entry.externalSubject !== externalSubject ||
          entry.slackUserId !== input.userId ||
          entry.channelId !== input.channelId,
      )
    ) {
      throw new Error("Pending food entries do not belong to this Slack user");
    }
    await this.#messenger.publishCancelled({
      teamId: input.teamId,
      channelId: input.channelId,
      confirmationMessageTs: firstEntry.confirmationMessageTs,
    });
    await this.#pending.deleteByIds(entries.map((entry) => entry.id));
  }
}

function confirmationIdempotencyKey(entryIds: ReadonlyArray<string>): string {
  const hash = createHash("sha256")
    .update([...entryIds].sort().join(":"), "utf8")
    .digest("hex");
  return `slack-food-confirmation:${hash}`;
}
