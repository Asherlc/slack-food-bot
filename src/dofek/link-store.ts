import type { EncryptedJsonStore } from "../redis/encrypted-json-store.js";
import type { ExternalIdentity, TargetGrant } from "../targets/types.js";

const LINK_STATE_TTL_MS = 15 * 60 * 1_000;
const LINK_STATE_PREFIX = "slack-food-bot:dofek:link-state:";
const GRANT_PREFIX = "slack-food-bot:dofek:grant:";

export type PendingDofekLink = {
  linkId: string;
  codeVerifier: string;
  identity: ExternalIdentity;
};

export class DofekLinkStore {
  readonly #store: EncryptedJsonStore;

  constructor(store: EncryptedJsonStore) {
    this.#store = store;
  }

  async create(state: string, link: PendingDofekLink, ttlMs = LINK_STATE_TTL_MS): Promise<void> {
    await this.#store.set(linkStateKey(state), link, { ttlMs });
  }

  async consume(state: string): Promise<PendingDofekLink | null> {
    return this.#store.take<PendingDofekLink>(linkStateKey(state));
  }

  async saveGrant(identity: ExternalIdentity, grant: TargetGrant): Promise<void> {
    await this.#store.set(grantKey(identity), grant, { ttlMs: grant.expiresInSeconds * 1_000 });
  }

  async loadGrant(identity: ExternalIdentity): Promise<TargetGrant | null> {
    return this.#store.get<TargetGrant>(grantKey(identity));
  }

  async deleteGrant(identity: ExternalIdentity): Promise<void> {
    await this.#store.delete(grantKey(identity));
  }
}

function linkStateKey(state: string): string {
  return `${LINK_STATE_PREFIX}${encodeURIComponent(state)}`;
}

function grantKey(identity: ExternalIdentity): string {
  return `${GRANT_PREFIX}${encodeURIComponent(identity.namespace)}:${encodeURIComponent(identity.subject)}`;
}
