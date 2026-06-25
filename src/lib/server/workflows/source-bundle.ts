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
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { workflowArtifacts, workflowExecutions } from "$lib/server/db/schema";
import { createFile } from "$lib/server/files/registry";

export const SOURCE_BUNDLE_KIND = "source-bundle";
const DEFAULT_TITLE = "Source bundle";

export type SourceBundleMeta = {
	base?: string | null;
	head?: string | null;
	tier?: string | null;
	clonePath?: string | null;
	fileCount?: number | null;
};

export type PersistSourceBundleInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	fileName?: string;
	bytes: Buffer;
	meta?: SourceBundleMeta;
};

/** Deterministic id so a node re-capture UPSERTs the same version row. */
function sourceBundleArtifactId(executionId: string, nodeId: string | null): string {
	return createHash("sha256")
		.update(`${executionId}|${nodeId ?? ""}|${SOURCE_BUNDLE_KIND}`)
		.digest("hex")
		.slice(0, 24);
}

export async function persistSourceBundle(
	input: PersistSourceBundleInput,
): Promise<{ id: string; fileId: string; bytes: number }> {
	if (!db) throw new Error("Database not configured");
	const id = sourceBundleArtifactId(input.executionId, input.nodeId ?? null);
	const sizeBytes = input.bytes.byteLength;

	const { file } = await createFile({
		userId: input.userId,
		projectId: input.projectId ?? null,
		name: input.fileName?.trim() || `source-${input.executionId}.bundle`,
		purpose: "output",
		scopeId: input.executionId,
		contentType: "application/x-git-bundle",
		bytes: input.bytes,
	});

	const title = input.nodeId ? `${DEFAULT_TITLE} (${input.nodeId})` : DEFAULT_TITLE;
	const values = {
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
		} as unknown,
		fileId: file.id,
		contentType: "application/x-git-bundle",
		sizeBytes,
		metadata: { createdBy: "source-bundle", capturedAt: new Date().toISOString() },
	};
	await db
		.insert(workflowArtifacts)
		.values(values)
		.onConflictDoUpdate({ target: workflowArtifacts.id, set: values });

	return { id, fileId: file.id, bytes: sizeBytes };
}

/** All source-bundle versions for one execution, newest node first. */
export async function listSourceBundlesForExecution(executionId: string) {
	if (!db) return [];
	return db
		.select()
		.from(workflowArtifacts)
		.where(
			and(
				eq(workflowArtifacts.workflowExecutionId, executionId),
				eq(workflowArtifacts.kind, SOURCE_BUNDLE_KIND),
			),
		)
		.orderBy(desc(workflowArtifacts.createdAt));
}

/** Source-bundle versions across ALL executions of a workflow (cross-run). */
export async function listSourceBundlesForWorkflow(workflowId: string) {
	if (!db) return [];
	const execs = await db
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.workflowId, workflowId));
	if (execs.length === 0) return [];
	const rows = await db
		.select()
		.from(workflowArtifacts)
		.where(
			and(
				inArray(
					workflowArtifacts.workflowExecutionId,
					execs.map((e) => e.id),
				),
				eq(workflowArtifacts.kind, SOURCE_BUNDLE_KIND),
			),
		)
		.orderBy(desc(workflowArtifacts.createdAt));
	return rows;
}
