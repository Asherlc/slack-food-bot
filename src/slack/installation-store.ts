import type { EncryptedJsonStore } from "../redis/encrypted-json-store.js";

type Installation = {
  team?: { id?: string };
  enterprise?: { id?: string };
  [key: string]: unknown;
};

type InstallationQuery = {
  teamId?: string;
  enterpriseId?: string;
};

const INSTALLATION_KEY_PREFIX = "slack-food-bot:installation:";

export class RedisInstallationStore {
  readonly #store: EncryptedJsonStore;

  constructor(store: EncryptedJsonStore) {
    this.#store = store;
  }

  async storeInstallation(installation: Installation): Promise<void> {
    await this.#store.set(installationKey(installation), installation);
  }

  async fetchInstallation(query: InstallationQuery): Promise<Installation> {
    const installation = await this.#store.get<Installation>(installationKey(query));
    if (!installation) throw new Error("Slack installation not found");
    return installation;
  }

  async deleteInstallation(query: InstallationQuery): Promise<void> {
    await this.#store.delete(installationKey(query));
  }
}

function installationKey(value: Installation | InstallationQuery): string {
  const teamId = "team" in value ? value.team?.id : value.teamId;
  const enterpriseId = "enterprise" in value ? value.enterprise?.id : value.enterpriseId;
  const id = teamId ?? enterpriseId;
  if (typeof id !== "string" || id.length === 0)
    throw new Error("Slack installation requires a team or enterprise ID");
  return `${INSTALLATION_KEY_PREFIX}${encodeURIComponent(id)}`;
}
