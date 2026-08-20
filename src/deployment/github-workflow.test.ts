import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Cloudflare Worker deployment workflow", () => {
  it("deploys only a successful main push from the exact CI head", async () => {
    const workflow = parse(await readFile(".github/workflows/deploy-workers.yml", "utf8"));

    expect(workflow.on.workflow_run.workflows).toEqual(["CI"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow.jobs.deploy.if).toContain("github.event.workflow_run.event == 'push'");
    expect(JSON.stringify(workflow)).toContain("github.event.workflow_run.head_sha");
    expect(JSON.stringify(workflow)).toContain("CLOUDFLARE_API_TOKEN");
    expect(JSON.stringify(workflow)).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(JSON.stringify(workflow)).not.toContain("SLACK_SIGNING_SECRET");
  });
});
