/**
 * Pure helpers for exporting a run's per-node `diff` artifacts as one aggregated
 * unified-diff string (the "Download patch" affordance on the Changes tab).
 *
 * Each node's `diff` artifact carries an INCREMENTAL delta in
 * `inlinePayload.patch` (the capture advances a per-workspace baseline after
 * each node). Concatenating them in completion order reproduces the cumulative
 * unified diff for the whole run. Large diffs are gzip-offloaded with no inline
 * `patch`; those cannot be aggregated client-side, so we report how many nodes
 * were omitted and the UI can surface that.
 *
 * No I/O, no Svelte — unit-tested directly by `run-diff-export.test.ts`.
 */

export type DiffArtifactLike = {
  nodeId: string | null;
  title: string;
  inlinePayload: unknown;
  createdAt: string | Date;
};

export type AggregatedRunDiff = {
  /** The concatenated unified diff (empty string when nothing is inline). */
  patch: string;
  /** Nodes whose inline patch was included. */
  includedNodes: number;
  /** Nodes skipped because their (large) diff was offloaded with no inline patch. */
  omittedLargeNodes: number;
};

function inlinePatch(artifact: DiffArtifactLike): string {
  const payload = (artifact.inlinePayload ?? {}) as { patch?: unknown };
  return typeof payload.patch === "string" ? payload.patch : "";
}

function completionTime(artifact: DiffArtifactLike): number {
  const value = new Date(artifact.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

/**
 * Concatenate every node's inline patch in completion order (baseline advances
 * per node, so this order reconstructs the cumulative run diff).
 */
export function aggregateRunDiff(artifacts: readonly DiffArtifactLike[]): AggregatedRunDiff {
  const ordered = [...artifacts].sort((a, b) => completionTime(a) - completionTime(b));
  const parts: string[] = [];
  let includedNodes = 0;
  let omittedLargeNodes = 0;
  for (const artifact of ordered) {
    const patch = inlinePatch(artifact).trim();
    if (patch) {
      parts.push(patch);
      includedNodes += 1;
    } else {
      omittedLargeNodes += 1;
    }
  }
  return {
    patch: parts.length ? parts.join("\n\n") + "\n" : "",
    includedNodes,
    omittedLargeNodes,
  };
}

/** True when at least one node has an inline patch we can download client-side. */
export function hasDownloadablePatch(artifacts: readonly DiffArtifactLike[]): boolean {
  return artifacts.some((artifact) => inlinePatch(artifact).trim().length > 0);
}

/** Stable, filesystem-safe patch filename for a run download. */
export function runPatchFilename(executionId: string): string {
  const safe = (executionId || "run").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "run";
  return `run-${safe}.patch`;
}
