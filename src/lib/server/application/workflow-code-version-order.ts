import type { WorkflowArtifactRecord } from "$lib/server/application/ports";

type ChronologicalArtifact = Pick<WorkflowArtifactRecord, "id" | "createdAt">;

/**
 * Stable artifact chronology shared by read and command application services.
 * Artifact IDs are the deterministic final authority when timestamps collide.
 */
export function compareWorkflowArtifactChronology(
  left: ChronologicalArtifact,
  right: ChronologicalArtifact,
): number {
  const leftTimestamp = left.createdAt.getTime();
  const rightTimestamp = right.createdAt.getTime();
  if (leftTimestamp < rightTimestamp) return -1;
  if (leftTimestamp > rightTimestamp) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function latestWorkflowArtifact<T extends ChronologicalArtifact>(
  artifacts: readonly T[],
  include: (artifact: T) => boolean,
): T | null {
  let latest: T | null = null;
  for (const artifact of artifacts) {
    if (
      include(artifact) &&
      (!latest || compareWorkflowArtifactChronology(artifact, latest) > 0)
    ) {
      latest = artifact;
    }
  }
  return latest;
}
