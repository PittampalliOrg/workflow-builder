import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceBundlePromotionRunnerInput } from "$lib/server/application/ports";

const mocks = vi.hoisted(() => ({
  cleanupWorkspaceHelperPod: vi.fn(),
  internalBffBaseUrl: vi.fn(),
  provisionWorkspaceHelperPod: vi.fn(),
  runHelperCommand: vi.fn(),
}));

vi.mock("$lib/server/workflows/helper-pod", () => ({
  cleanupWorkspaceHelperPod: mocks.cleanupWorkspaceHelperPod,
  internalBffBaseUrl: mocks.internalBffBaseUrl,
  provisionWorkspaceHelperPod: mocks.provisionWorkspaceHelperPod,
  runHelperCommand: mocks.runHelperCommand,
}));

import { HelperPodSourceBundlePromotionRunner } from "./workflow-code-version-promotion";

function input(): SourceBundlePromotionRunnerInput {
  return {
    executionId: "exec-1",
    fileId: "file-1",
    repo: "PittampalliOrg/workflow-builder",
    base: "main",
    baseRevision: "a".repeat(40),
    mode: "pr",
    title: "Preview source promotion",
    tier: "tar-overlay-set",
    repoSubdir: "",
    syncPaths: [],
  };
}

function encodedChangedPaths(paths: readonly string[]): string {
  return Buffer.from(JSON.stringify(paths))
    .toString("base64url")
    .replace(/=+$/, "");
}

describe("HelperPodSourceBundlePromotionRunner helper cleanup", () => {
  beforeEach(() => {
    mocks.cleanupWorkspaceHelperPod.mockReset().mockResolvedValue("deleted");
    mocks.internalBffBaseUrl.mockReset().mockReturnValue("http://bff");
    mocks.provisionWorkspaceHelperPod.mockReset().mockResolvedValue({
      baseUrl: "http://10.244.1.20:8002",
      token: "internal-token",
      githubToken: "github-token",
      sandboxName: "agent-host-agent-exec-1-preview-source-promotion",
    });
    mocks.runHelperCommand.mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: [
        `BASE_REVISION=${"a".repeat(40)}`,
        `CHANGED_PATHS_B64=${encodedChangedPaths(["src/routes/dashboard/+page.svelte"])}`,
        "PULL_REQUEST_BASE=main",
        "BRANCH_PUSHED=preview-feature-test",
        `COMMIT_SHA=${"b".repeat(40)}`,
        "PR_URL=https://github.com/PittampalliOrg/workflow-builder/pull/1",
      ].join("\n"),
      stderr: "",
    });
  });

  it("deletes the helper sandbox after a successful promotion command", async () => {
    const runner = new HelperPodSourceBundlePromotionRunner({
      githubToken: () => "github-token",
      requireExplicitGithubToken: true,
      helperSuffix: "preview-source-promotion",
    });

    await expect(runner.promoteSourceBundle(input())).resolves.toMatchObject({
      status: "ok",
      branch: "preview-feature-test",
      commitSha: "b".repeat(40),
      changedPaths: ["src/routes/dashboard/+page.svelte"],
      cleanup: { attempted: true, outcome: "deleted", message: null },
    });
    expect(mocks.cleanupWorkspaceHelperPod).toHaveBeenCalledWith({
      baseUrl: "http://10.244.1.20:8002",
      token: "internal-token",
      githubToken: "github-token",
      sandboxName: "agent-host-agent-exec-1-preview-source-promotion",
    });
  });

  it("surfaces a failed helper cleanup on the promotion result", async () => {
    mocks.cleanupWorkspaceHelperPod.mockResolvedValue("failed");
    const runner = new HelperPodSourceBundlePromotionRunner({
      githubToken: () => "github-token",
      requireExplicitGithubToken: true,
      helperSuffix: "preview-source-promotion",
    });

    await expect(runner.promoteSourceBundle(input())).resolves.toMatchObject({
      status: "ok",
      cleanup: {
        attempted: true,
        outcome: "failed",
        message:
          "helper sandbox cleanup failed; it may linger until its shutdownTime",
      },
    });
  });

  it("surfaces a thrown helper cleanup as a failed receipt", async () => {
    mocks.cleanupWorkspaceHelperPod.mockRejectedValue(new Error("sea down"));
    const runner = new HelperPodSourceBundlePromotionRunner({
      githubToken: () => "github-token",
      requireExplicitGithubToken: true,
    });

    await expect(runner.promoteSourceBundle(input())).resolves.toMatchObject({
      status: "ok",
      cleanup: { attempted: true, outcome: "failed", message: "sea down" },
    });
  });

  it("deletes the helper sandbox when the helper command has no response", async () => {
    mocks.runHelperCommand.mockResolvedValue(null);
    const runner = new HelperPodSourceBundlePromotionRunner({
      githubToken: () => "github-token",
      requireExplicitGithubToken: true,
    });

    await expect(runner.promoteSourceBundle(input())).resolves.toEqual({
      status: "unavailable",
      message: "promote command failed (no pod response)",
      cleanup: { attempted: true, outcome: "deleted", message: null },
    });
    expect(mocks.cleanupWorkspaceHelperPod).toHaveBeenCalledTimes(1);
  });
});
