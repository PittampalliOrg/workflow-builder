import { describe, expect, it, vi } from "vitest";
import { GithubPreviewMergedCommitInspectionAdapter } from "$lib/server/application/adapters/preview-merged-commits";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);

function response(url: string | URL | Request) {
  const path = String(url);
  if (path.includes(`/commits/${MERGE_SHA}/pulls`)) {
    return Response.json([
      {
        number: 42,
        merged_at: "2026-07-10T12:00:00Z",
        merge_commit_sha: MERGE_SHA,
        base: { ref: "main", sha: BASE_SHA },
        head: {
          sha: HEAD_SHA,
          repo: { full_name: "PittampalliOrg/workflow-builder" },
        },
      },
    ]);
  }
  if (path.includes(`/git/commits/${HEAD_SHA}`)) {
    return Response.json({ tree: { sha: TREE_SHA } });
  }
  if (path.includes(`/git/commits/${MERGE_SHA}`)) {
    return Response.json({ tree: { sha: TREE_SHA } });
  }
  if (path.includes(`/compare/${MERGE_SHA}...main`)) {
    return Response.json({
      status: "ahead",
      merge_base_commit: { sha: MERGE_SHA },
    });
  }
  if (path.includes("/pulls/42/files?")) {
    return Response.json([{ filename: "src/routes/feature.ts" }]);
  }
  return new Response("not found", { status: 404 });
}

describe("GithubPreviewMergedCommitInspectionAdapter", () => {
  it("proves the merged PR, protected-base ancestry, trees, and complete paths", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      response(url),
    );
    const adapter = new GithubPreviewMergedCommitInspectionAdapter({
      credentials: { token: vi.fn(async () => "read-token") },
      fetch: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.inspect({
        repository: "PittampalliOrg/workflow-builder",
        mergeSha: MERGE_SHA as never,
      }),
    ).resolves.toEqual({
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      baseRef: "main",
      headTreeSha: TREE_SHA,
      mergeTreeSha: TREE_SHA,
      changedPaths: ["src/routes/feature.ts"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("returns no proof for ambiguity, non-main ancestry, or a foreign fork", async () => {
    const ambiguous = new GithubPreviewMergedCommitInspectionAdapter({
      credentials: { token: vi.fn(async () => "read-token") },
      fetch: vi.fn(async (url: string | URL | Request) => {
        const result = response(url);
        if (String(url).includes(`/commits/${MERGE_SHA}/pulls`)) {
          const body = await result.json();
          return Response.json([body[0], body[0]]);
        }
        return result;
      }) as typeof fetch,
    });
    await expect(
      ambiguous.inspect({
        repository: "PittampalliOrg/workflow-builder",
        mergeSha: MERGE_SHA as never,
      }),
    ).resolves.toBeNull();

    const foreign = new GithubPreviewMergedCommitInspectionAdapter({
      credentials: { token: vi.fn(async () => "read-token") },
      fetch: vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes(`/commits/${MERGE_SHA}/pulls`)) {
          return Response.json([
            {
              number: 42,
              merged_at: "2026-07-10T12:00:00Z",
              merge_commit_sha: MERGE_SHA,
              base: { ref: "main", sha: BASE_SHA },
              head: { sha: HEAD_SHA, repo: { full_name: "attacker/fork" } },
            },
          ]);
        }
        return response(url);
      }) as typeof fetch,
    });
    await expect(
      foreign.inspect({
        repository: "PittampalliOrg/workflow-builder",
        mergeSha: MERGE_SHA as never,
      }),
    ).resolves.toBeNull();
  });
});
