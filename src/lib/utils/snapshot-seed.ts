/**
 * Node-boundary snapshot seed helpers (durability phase 3).
 *
 * A forked/resumed run records the workspace it was seeded from in
 * `workflow_executions.seed_workspace_from`. When that value is a
 * `.snapshots/<key>/<node>` path, the fork was seeded from a node-boundary
 * snapshot (consistent fork) rather than the source lineage's end-state
 * workspace. Both the server (lineage read model) and the client (run-page
 * badge) derive "seeded from snapshot" from this single rule.
 */

const SNAPSHOT_SEED_PREFIX = ".snapshots/";

/** True when a seed-workspace path points at a node-boundary snapshot. */
export function isSnapshotSeedPath(
	seedWorkspaceFrom: string | null | undefined,
): boolean {
	return (
		typeof seedWorkspaceFrom === "string" &&
		seedWorkspaceFrom.startsWith(SNAPSHOT_SEED_PREFIX)
	);
}

/**
 * The snapshot's source node id from a `.snapshots/<key>/<node>` path, or null
 * when the value is not a snapshot seed path. This is the node whose COMPLETION
 * state was reused — distinct from the fork point (`resumeFromNode`).
 */
export function snapshotSeedNodeId(
	seedWorkspaceFrom: string | null | undefined,
): string | null {
	if (!isSnapshotSeedPath(seedWorkspaceFrom)) return null;
	const parts = (seedWorkspaceFrom as string).split("/").filter(Boolean);
	// [".snapshots", "<key>", "<node>", ...] — the node id is the tail.
	return parts.length >= 3 ? (parts.at(-1) ?? null) : null;
}
