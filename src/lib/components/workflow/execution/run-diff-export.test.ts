import { describe, expect, it } from "vitest";

import {
  aggregateRunDiff,
  hasDownloadablePatch,
  runPatchFilename,
  type DiffArtifactLike,
} from "./run-diff-export";

function artifact(
  overrides: Partial<DiffArtifactLike> & { patch?: string | null; createdAt: string },
): DiffArtifactLike {
  const { patch, ...rest } = overrides;
  return {
    nodeId: rest.nodeId ?? "node",
    title: rest.title ?? "diff",
    createdAt: rest.createdAt,
    inlinePayload:
      "inlinePayload" in rest
        ? rest.inlinePayload
        : patch === undefined
          ? {}
          : { patch },
  };
}

const PATCH_A = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+one`;
const PATCH_B = `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@\n+two`;

describe("aggregateRunDiff", () => {
  it("concatenates inline patches in completion order", () => {
    const result = aggregateRunDiff([
      artifact({ patch: PATCH_B, createdAt: "2026-07-24T10:05:00Z" }),
      artifact({ patch: PATCH_A, createdAt: "2026-07-24T10:00:00Z" }),
    ]);
    expect(result.includedNodes).toBe(2);
    expect(result.omittedLargeNodes).toBe(0);
    // Ordered by createdAt: A (10:00) before B (10:05).
    expect(result.patch.indexOf("a.ts")).toBeLessThan(result.patch.indexOf("b.ts"));
    expect(result.patch.endsWith("\n")).toBe(true);
  });

  it("counts nodes with no inline patch as omitted large diffs", () => {
    const result = aggregateRunDiff([
      artifact({ patch: PATCH_A, createdAt: "2026-07-24T10:00:00Z" }),
      artifact({ createdAt: "2026-07-24T10:01:00Z", inlinePayload: { stats: { files: 9 } } }),
    ]);
    expect(result.includedNodes).toBe(1);
    expect(result.omittedLargeNodes).toBe(1);
    expect(result.patch).toContain("a.ts");
  });

  it("returns an empty patch when nothing is inline", () => {
    const result = aggregateRunDiff([
      artifact({ createdAt: "2026-07-24T10:00:00Z", inlinePayload: {} }),
    ]);
    expect(result.patch).toBe("");
    expect(result.includedNodes).toBe(0);
    expect(result.omittedLargeNodes).toBe(1);
  });

  it("ignores whitespace-only patches", () => {
    const result = aggregateRunDiff([
      artifact({ patch: "   \n  ", createdAt: "2026-07-24T10:00:00Z" }),
    ]);
    expect(result.patch).toBe("");
    expect(result.includedNodes).toBe(0);
  });
});

describe("hasDownloadablePatch", () => {
  it("is true only when at least one inline patch exists", () => {
    expect(hasDownloadablePatch([artifact({ patch: PATCH_A, createdAt: "2026-07-24T10:00:00Z" })])).toBe(
      true,
    );
    expect(
      hasDownloadablePatch([artifact({ createdAt: "2026-07-24T10:00:00Z", inlinePayload: {} })]),
    ).toBe(false);
    expect(hasDownloadablePatch([])).toBe(false);
  });
});

describe("runPatchFilename", () => {
  it("builds a stable, filesystem-safe name", () => {
    expect(runPatchFilename("exec_abc-123")).toBe("run-exec_abc-123.patch");
  });

  it("strips unsafe characters and falls back", () => {
    expect(runPatchFilename("a/b c!")).toBe("run-abc.patch");
    expect(runPatchFilename("")).toBe("run-run.patch");
    expect(runPatchFilename("/////")).toBe("run-run.patch");
  });
});
