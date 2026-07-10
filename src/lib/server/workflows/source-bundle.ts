/**
 * Durable per-node SOURCE bundles (Pattern B2 — docs/code-version-persistence.md).
 *
 * A code-producing agent node emits a git bundle of the produced source (thin
 * `origin/<base>..HEAD`, tiered fallback to HEAD / squashed-root — mirrors Claude
 * Code's teleport bundle). The bytes are stored in the Files API and referenced by
 * a `source-bundle` workflow_artifact, so a *version* of the code is re-accessible
 * and applyable (Promote → PR) long after the per-run sandbox is reaped — without a
 * git server and without a PR per iteration. Pairs with the same node's `diff`
 * artifact (shared nodeId) for preview.
 */

import { createHash } from "node:crypto";
import type {
	ArtifactStore,
	WorkflowFileStore,
} from "$lib/server/application/ports";

export const SOURCE_BUNDLE_KIND = "source-bundle";
const DEFAULT_TITLE = "Source bundle";

export type SourceBundleMeta = {
	base?: string | null;
	head?: string | null;
	tier?: string | null;
	clonePath?: string | null;
	fileCount?: number | null;
	// dev-pod-as-source (tar-overlay) reconstruction context — lets Promote rebuild
	// against the base repo without consulting the dev-preview registry at promote time.
	repoUrl?: string | null;
	repoSubdir?: string | null;
	syncPaths?: string[] | null;
	iteration?: number | null;
	manifestVersion?: number | null;
	captureId?: string | null;
	capturedAt?: string | null;
	serviceCount?: number | null;
	services?: string[] | null;
	captureProtocol?: string | null;
	acceptanceEligible?: boolean | null;
	generation?: string | null;
	overlayDigests?: Record<string, string> | null;
	catalogDigest?: string | null;
	sourceRevision?: string | null;
	platformRevision?: string | null;
};

export type PersistSourceBundleInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	/** Loop iteration index — distinguishes per-iteration versions (no UPSERT collapse). */
	iteration?: number | null;
	fileName?: string;
	bytes: Buffer;
	/** Defaults to a git bundle; tar-overlay snapshots pass "application/gzip". */
	contentType?: string;
	meta?: SourceBundleMeta;
};

export type SourceBundlePersistence = Pick<WorkflowFileStore, "createFile"> &
	Pick<ArtifactStore, "upsertWorkflowArtifact">;

/**
 * Legacy captures keep the deterministic per-node/per-iteration id. Atomic
 * capture sets carry a random captureId in metadata; including it in the key
 * makes repeated captures of the same iteration distinct immutable artifacts.
 */
function sourceBundleArtifactId(
	executionId: string,
	nodeId: string | null,
	iteration: number | null,
	captureId: string | null,
): string {
	const iterSeg = iteration == null ? "" : `iter${iteration}|`;
	const captureSeg = captureId ? `capture${captureId}|` : "";
	return createHash("sha256")
		.update(
			`${executionId}|${nodeId ?? ""}|${iterSeg}${captureSeg}${SOURCE_BUNDLE_KIND}`,
		)
		.digest("hex")
		.slice(0, 24);
}

export async function persistSourceBundle(
	input: PersistSourceBundleInput,
	persistence: SourceBundlePersistence,
): Promise<{ id: string; fileId: string; bytes: number }> {
	const iteration = input.iteration ?? input.meta?.iteration ?? null;
	const captureId = input.meta?.captureId?.trim() || null;
	const id = sourceBundleArtifactId(
		input.executionId,
		input.nodeId ?? null,
		iteration,
		captureId,
	);
	const sizeBytes = input.bytes.byteLength;
	const contentType = input.contentType?.trim() || "application/x-git-bundle";

	const { file } = await persistence.createFile({
		userId: input.userId,
		projectId: input.projectId ?? null,
		name: input.fileName?.trim() || `source-${input.executionId}.bundle`,
		purpose: "output",
		scopeId: input.executionId,
		contentType,
		bytes: input.bytes,
	});

	const iterLabel = iteration == null ? "" : ` #${iteration}`;
	const title = input.nodeId
		? `${DEFAULT_TITLE} (${input.nodeId}${iterLabel})`
		: DEFAULT_TITLE;
	await persistence.upsertWorkflowArtifact({
		id,
		workflowExecutionId: input.executionId,
		nodeId: input.nodeId ?? null,
		slot: "aux" as const,
		kind: SOURCE_BUNDLE_KIND,
		title,
		description: null,
		inlinePayload: {
			base: input.meta?.base ?? null,
			head: input.meta?.head ?? null,
			tier: input.meta?.tier ?? null,
			clonePath: input.meta?.clonePath ?? null,
			fileCount: input.meta?.fileCount ?? null,
			repoUrl: input.meta?.repoUrl ?? null,
			repoSubdir: input.meta?.repoSubdir ?? null,
			syncPaths: input.meta?.syncPaths ?? null,
			iteration,
			...(input.meta?.manifestVersion != null
				? { manifestVersion: input.meta.manifestVersion }
				: {}),
			...(input.meta?.captureId
				? { captureId: input.meta.captureId }
				: {}),
			...(input.meta?.capturedAt
				? { capturedAt: input.meta.capturedAt }
				: {}),
			...(input.meta?.serviceCount != null
				? { serviceCount: input.meta.serviceCount }
				: {}),
			...(input.meta?.services ? { services: input.meta.services } : {}),
			...(input.meta?.captureProtocol
				? { captureProtocol: input.meta.captureProtocol }
				: {}),
			...(input.meta?.acceptanceEligible != null
				? { acceptanceEligible: input.meta.acceptanceEligible }
				: {}),
			...(input.meta?.generation
				? { generation: input.meta.generation }
				: {}),
			...(input.meta?.overlayDigests
				? { overlayDigests: input.meta.overlayDigests }
				: {}),
			...(input.meta?.catalogDigest
				? { catalogDigest: input.meta.catalogDigest }
				: {}),
			...(input.meta?.sourceRevision
				? { sourceRevision: input.meta.sourceRevision }
				: {}),
			...(input.meta?.platformRevision
				? { platformRevision: input.meta.platformRevision }
				: {}),
		} as unknown,
		fileId: file.id,
		contentType,
		sizeBytes,
		metadata: {
			createdBy: "source-bundle",
			capturedAt: new Date().toISOString(),
		},
	});

	return { id, fileId: file.id, bytes: sizeBytes };
}
