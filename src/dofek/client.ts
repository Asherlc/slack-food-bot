import { z } from "zod";
import type {
  ConfirmedNutritionWrite,
  ExternalIdentity,
  IdentityLinkStart,
  NutritionTarget,
  NutritionWriteEntry,
  TargetGrant,
} from "../targets/types.js";
import { dailyIntakeSummarySchema } from "../targets/types.js";

const linkStartSchema = z
  .object({
    linkId: z.string().min(1),
    authorizationUrl: z.url(),
    expiresAt: z.string().min(1),
  })
  .strict();

const grantSchema = z
  .object({
    externalSubject: z.string().min(1),
    grantId: z.string().min(1),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.literal(900),
    scope: z.literal("nutrition:write"),
  })
  .strict();

const confirmedNutritionWriteSchema = z
  .object({
    entries: z.array(z.object({ id: z.string().min(1), externalId: z.string().min(1) }).strict()),
    dailyIntake: dailyIntakeSummarySchema,
  })
  .strict();

export class DofekClient
  implements
    Pick<
      NutritionTarget,
      "startIdentityLink" | "exchangeIdentityLink" | "reissueGrant" | "confirmFood"
    >
{
  readonly #baseUrl: string;
  readonly #clientCredential: string;
  readonly #fetch: typeof fetch;

  constructor(input: { baseUrl: string; clientCredential: string; fetch?: typeof fetch }) {
    this.#baseUrl = input.baseUrl.replace(/\/$/, "");
    this.#clientCredential = input.clientCredential;
    this.#fetch = input.fetch ?? fetch;
  }

  async startIdentityLink(input: {
    redirectUri: string;
    codeChallenge: string;
    requestedScopes: ReadonlyArray<string>;
    state?: string;
  }): Promise<IdentityLinkStart> {
    const response = await this.#fetch(`${this.#baseUrl}/api/external/v1/link/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#clientCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Dofek link start failed with status ${response.status}`);
    return linkStartSchema.parse(await response.json());
  }

  async reissueGrant(input: { identity: ExternalIdentity }): Promise<TargetGrant> {
    const response = await this.#fetch(`${this.#baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#clientCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ externalSubject: input.identity }),
    });
    if (!response.ok) throw new Error(`Dofek token reissue failed with status ${response.status}`);

    return this.#parseGrant(response);
  }

  async exchangeIdentityLink(input: {
    linkId: string;
    code: string;
    codeVerifier: string;
    identity: ExternalIdentity;
  }): Promise<TargetGrant> {
    const response = await this.#fetch(`${this.#baseUrl}/api/external/v1/link/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#clientCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        linkId: input.linkId,
        code: input.code,
        codeVerifier: input.codeVerifier,
        externalSubject: input.identity,
      }),
    });
    if (!response.ok) throw new Error(`Dofek link exchange failed with status ${response.status}`);
    return this.#parseGrant(response);
  }

  async confirmFood(input: {
    grant: TargetGrant;
    idempotencyKey: string;
    entries: ReadonlyArray<NutritionWriteEntry>;
  }): Promise<ConfirmedNutritionWrite> {
    const response = await this.#fetch(`${this.#baseUrl}/api/external/v1/nutrition/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.grant.accessToken}`,
        "Idempotency-Key": input.idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entries: input.entries }),
    });
    if (!response.ok)
      throw new Error(`Dofek nutrition write failed with status ${response.status}`);
    return confirmedNutritionWriteSchema.parse(await response.json());
  }

  async #parseGrant(response: Response): Promise<TargetGrant> {
    const grant = grantSchema.parse(await response.json());
    return {
      externalSubject: grant.externalSubject,
      grantId: grant.grantId,
      accessToken: grant.accessToken,
      expiresInSeconds: grant.expiresIn,
    };
  }
}
