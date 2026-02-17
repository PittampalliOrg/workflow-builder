import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { nanoid } from "nanoid";

export type ChangeFileStatus = "A" | "M" | "D" | "R";

export type ChangeFileEntry = {
	path: string;
	status: ChangeFileStatus;
};

export type ChangeArtifactMetadata = {
	changeSetId: string;
	executionId: string;
	workspaceRef: string;
	durableInstanceId?: string;
	operation: string;
	sequence: number;
	format: "git-unified-v1";
	sha256: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	bytes: number;
	compressed: boolean;
	storageRef: string;
	createdAt: string;
	includeInExecutionPatch: boolean;
	truncated: boolean;
	originalBytes: number;
	files: ChangeFileEntry[];
};

type StoredChangeArtifact = {
	metadata: ChangeArtifactMetadata;
	payload: Buffer;
};

type SaveChangeArtifactInput = {
	executionId: string;
	workspaceRef: string;
	operation: string;
	sequence: number;
	patch: string;
	files: ChangeFileEntry[];
	additions: number;
	deletions: number;
	durableInstanceId?: string;
	includeInExecutionPatch?: boolean;
};

const ARTIFACT_TTL_MS = parseInt(
	process.env.WORKSPACE_CHANGE_ARTIFACT_TTL_MS || `${24 * 60 * 60 * 1000}`,
	10,
);
const COMPRESS_THRESHOLD_BYTES = parseInt(
	process.env.WORKSPACE_CHANGE_COMPRESS_THRESHOLD_BYTES || "4096",
	10,
);
const MAX_PATCH_BYTES = parseInt(
	process.env.WORKSPACE_CHANGE_MAX_PATCH_BYTES || `${10 * 1024 * 1024}`,
	10,
);

class WorkspaceChangeArtifactStore {
	private readonly artifacts = new Map<string, StoredChangeArtifact>();
	private readonly executionIndex = new Map<string, string[]>();

	constructor() {
		const timer = setInterval(
			() => {
				this.sweepExpired();
			},
			Math.max(15_000, Math.floor(ARTIFACT_TTL_MS / 8)),
		);
		timer.unref();
	}

	save(input: SaveChangeArtifactInput): ChangeArtifactMetadata {
		const patchBytes = Buffer.byteLength(input.patch, "utf8");
		const truncated = patchBytes > MAX_PATCH_BYTES;
		const storedPatch = truncated
			? input.patch.slice(0, MAX_PATCH_BYTES)
			: input.patch;
		const storedBytes = Buffer.byteLength(storedPatch, "utf8");
		const shouldCompress = storedBytes >= COMPRESS_THRESHOLD_BYTES;
		const payload = shouldCompress
			? gzipSync(Buffer.from(storedPatch, "utf8"))
			: Buffer.from(storedPatch, "utf8");
		const sha256 = createHash("sha256").update(storedPatch).digest("hex");
		const changeSetId = `chg_${nanoid(16)}`;
		const metadata: ChangeArtifactMetadata = {
			changeSetId,
			executionId: input.executionId,
			workspaceRef: input.workspaceRef,
			durableInstanceId: input.durableInstanceId,
			operation: input.operation,
			sequence: input.sequence,
			format: "git-unified-v1",
			sha256,
			filesChanged: input.files.length,
			additions: input.additions,
			deletions: input.deletions,
			bytes: storedBytes,
			compressed: shouldCompress,
			storageRef: changeSetId,
			createdAt: new Date().toISOString(),
			includeInExecutionPatch: input.includeInExecutionPatch !== false,
			truncated,
			originalBytes: patchBytes,
			files: input.files,
		};

		this.artifacts.set(changeSetId, { metadata, payload });
		const executionEntries = this.executionIndex.get(input.executionId) ?? [];
		executionEntries.push(changeSetId);
		this.executionIndex.set(input.executionId, executionEntries);
		return metadata;
	}

	get(
		changeSetId: string,
	): { metadata: ChangeArtifactMetadata; patch: string } | null {
		const stored = this.artifacts.get(changeSetId);
		if (!stored) return null;
		const buf = stored.metadata.compressed
			? gunzipSync(stored.payload)
			: stored.payload;
		return {
			metadata: stored.metadata,
			patch: buf.toString("utf8"),
		};
	}

	listByExecutionId(executionId: string): ChangeArtifactMetadata[] {
		const ids = this.executionIndex.get(executionId) ?? [];
		const entries: ChangeArtifactMetadata[] = [];
		for (const id of ids) {
			const stored = this.artifacts.get(id);
			if (!stored) continue;
			entries.push(stored.metadata);
		}
		entries.sort((a, b) => a.sequence - b.sequence);
		return entries;
	}

	getExecutionPatch(
		executionId: string,
		opts?: { durableInstanceId?: string; includeExcluded?: boolean },
	): {
		patch: string;
		changeSets: ChangeArtifactMetadata[];
	} {
		const includeExcluded = opts?.includeExcluded === true;
		const durableInstanceId = opts?.durableInstanceId;
		const all = this.listByExecutionId(executionId);
		const filtered = all.filter((entry) => {
			if (!includeExcluded && !entry.includeInExecutionPatch) return false;
			if (durableInstanceId && entry.durableInstanceId !== durableInstanceId) {
				return false;
			}
			return true;
		});
		const patches: string[] = [];
		for (const entry of filtered) {
			const resolved = this.get(entry.changeSetId);
			if (!resolved) continue;
			patches.push(resolved.patch);
		}
		return {
			patch: patches.filter(Boolean).join("\n"),
			changeSets: filtered,
		};
	}

	private sweepExpired(): void {
		const now = Date.now();
		for (const [id, stored] of this.artifacts) {
			const createdAt = Date.parse(stored.metadata.createdAt);
			if (!Number.isFinite(createdAt)) continue;
			if (now - createdAt <= ARTIFACT_TTL_MS) continue;
			this.artifacts.delete(id);
			const ids = this.executionIndex.get(stored.metadata.executionId);
			if (!ids) continue;
			const remaining = ids.filter((entry) => entry !== id);
			if (remaining.length === 0) {
				this.executionIndex.delete(stored.metadata.executionId);
			} else {
				this.executionIndex.set(stored.metadata.executionId, remaining);
			}
		}
	}
}

export const changeArtifacts = new WorkspaceChangeArtifactStore();
