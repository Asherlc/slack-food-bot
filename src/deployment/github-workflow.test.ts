import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Cloudflare Worker deployment workflow", () => {
  it("deploys only a successful main push from the exact CI head", async () => {
    const workflow = parse(await readFile(".github/workflows/deploy-workers.yml", "utf8"));

    expect(workflow.on.workflow_run.workflows).toEqual(["CI"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow.jobs.deploy.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );

    const checkoutStep = workflow.jobs.deploy.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkoutStep?.with?.ref).toBe(`\${{ github.event.workflow_run.head_sha }}`);

    const deployStep = workflow.jobs.deploy.steps.find(
      (step: { run?: string }) => step.run === "pnpm deploy:workers",
    );
    expect(Object.keys(deployStep?.env ?? {}).sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
    expect(JSON.stringify(workflow)).not.toContain("SLACK_SIGNING_SECRET");
  });
});
