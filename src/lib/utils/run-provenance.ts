/**
 * Run provenance — the single derivation behind the provenance chip set shown on
 * the run header, the fork-lineage tree, and the runs-list rows.
 *
 * A run can be: a FORK of an earlier run (rerun lineage), SEEDED from a
 * node-boundary snapshot (consistent fork), and/or a REPRODUCE (deterministic
 * replay). These are not mutually exclusive, so the derivation returns
 * independent flags and the chip component renders whichever apply.
 */
import { isSnapshotSeedPath, snapshotSeedNodeId } from './snapshot-seed';

export type RunProvenanceInput = {
	rerunOfExecutionId?: string | null;
	resumeFromNode?: string | null;
	seedWorkspaceFrom?: string | null;
	triggerSource?: string | null;
};

export type RunProvenance = {
	/** This run was forked/resumed from an earlier run. */
	isFork: boolean;
	/** The step the fork replayed from (`@<node>`), when known. */
	forkFromNode: string | null;
	/** Seeded from a node-boundary snapshot (consistent fork). */
	seededFromSnapshot: boolean;
	/** The snapshot's source node id, when derivable. */
	snapshotNode: string | null;
	/** Raw `.snapshots/<key>/<node>` path (badge tooltip). */
	snapshotPath: string | null;
	/** Deterministic replay — only when the backend persisted the trigger source. */
	isReproduce: boolean;
};

export function deriveRunProvenance(input: RunProvenanceInput): RunProvenance {
	const seed = input.seedWorkspaceFrom ?? null;
	const seededFromSnapshot = isSnapshotSeedPath(seed);
	return {
		isFork: !!input.rerunOfExecutionId,
		forkFromNode: input.resumeFromNode?.trim() || null,
		seededFromSnapshot,
		snapshotNode: seededFromSnapshot ? snapshotSeedNodeId(seed) : null,
		snapshotPath: seededFromSnapshot ? seed : null,
		isReproduce: (input.triggerSource ?? '').toLowerCase() === 'reproduce'
	};
}

/** True when a run has any provenance worth a chip (avoids rendering empty rows). */
export function hasRunProvenance(p: RunProvenance): boolean {
	return p.isFork || p.seededFromSnapshot || p.isReproduce;
}
