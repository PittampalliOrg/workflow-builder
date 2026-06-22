/**
 * Durable per-run workspace diffs.
 *
 * Captures ONE unified-diff patch per run/session (workspace baseline → final)
 * and persists it in the standard `workflow_artifacts` pipeline as a `diff`
 * kind. The patch text lives in the DB so it survives sandbox reap — no live
 * pod, no Gitea (which is retired). This is the durable successor to the old
 * Gitea-backed `workspace_change_artifacts` + the live-only dapr-agent-py
 * `workflow_code_checkpoints` diffs.
 *
 * Storage policy: inline the patch in `inlinePayload` when small (≤256 KB, the
 * jsonb guideline); otherwise gzip it into the `files` table and reference the
 * `fileId`, keeping only stats inline. Capture is best-effort and runtime-local
 * (cli-agent-py / dapr-agent-py compute `git diff` in-pod at session end); this
 * module owns storage + read-back so both runtimes share one shape.
 */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	workflowArtifacts,
	type WorkflowArtifactRow,
} from "$lib/server/db/schema";
import { createFile, getFileContent } from "$lib/server/files/registry";

/** Patch payloads at/under this size are stored inline; larger ones offload. */
export const RUN_DIFF_INLINE_MAX_BYTES = 256 * 1024;
/** Hard ceiling on the patch we keep at all (truncate beyond this). */
export const RUN_DIFF_MAX_BYTES = 8 * 1024 * 1024;

export const RUN_DIFF_KIND = "diff";
const DEFAULT_TITLE = "Workspace changes";

export type RunDiffStats = {
	files: number;
	additions: number;
	deletions: number;
};

export type RunDiffInlinePayload = {
	/** Present when stored inline (small patch). */
	patch?: string;
	baseRef: string | null;
	headRef: string | null;
	stats: RunDiffStats;
	/** True when the patch was capped at RUN_DIFF_MAX_BYTES. */
	truncated: boolean;
	/** True when the patch is gzip-offloaded to `fileId` (patch omitted inline). */
	gzip?: boolean;
};

export type PersistRunDiffInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	title?: string;
	patch: string;
	baseRef?: string | null;
	headRef?: string | null;
	stats?: Partial<RunDiffStats> | null;
};

/** Deterministic id so retries / re-captures UPSERT the same row. */
function runDiffArtifactId(executionId: string, nodeId: string | null, title: string): string {
	return createHash("sha256")
		.update(`${executionId}|${nodeId ?? ""}|${RUN_DIFF_KIND}|${title}`)
		.digest("hex")
		.slice(0, 24);
}

/** Derive {files,additions,deletions} from a unified diff if not supplied. */
export function computeDiffStats(patch: string): RunDiffStats {
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) files += 1;
		else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { files, additions, deletions };
}

/**
 * Persist a per-run diff as a `diff` workflow artifact. Inline when small;
 * gzip → `files` when large. Idempotent on the deterministic artifact id.
 */
export async function persistRunDiff(
	input: PersistRunDiffInput,
): Promise<{ id: string; fileId: string | null; bytes: number; truncated: boolean }> {
	if (!db) throw new Error("Database not configured");

	const title = input.title?.trim() || DEFAULT_TITLE;
	const id = runDiffArtifactId(input.executionId, input.nodeId ?? null, title);

	let patch = input.patch ?? "";
	let truncated = false;
	if (Buffer.byteLength(patch, "utf8") > RUN_DIFF_MAX_BYTES) {
		// Cap at the ceiling on a line boundary so diff2html still parses it.
		patch = Buffer.from(patch, "utf8").subarray(0, RUN_DIFF_MAX_BYTES).toString("utf8");
		const lastNl = patch.lastIndexOf("\n");
		if (lastNl > 0) patch = patch.slice(0, lastNl + 1);
		truncated = true;
	}

	const stats: RunDiffStats = {
		files: input.stats?.files ?? 0,
		additions: input.stats?.additions ?? 0,
		deletions: input.stats?.deletions ?? 0,
	};
	if (!input.stats || stats.files === 0) {
		const computed = computeDiffStats(patch);
		stats.files = input.stats?.files ?? computed.files;
		stats.additions = input.stats?.additions ?? computed.additions;
		stats.deletions = input.stats?.deletions ?? computed.deletions;
	}

	const patchBytes = Buffer.byteLength(patch, "utf8");
	let fileId: string | null = null;
	let payload: RunDiffInlinePayload;

	if (patchBytes > RUN_DIFF_INLINE_MAX_BYTES) {
		const gz = gzipSync(Buffer.from(patch, "utf8"));
		const { file } = await createFile({
			userId: input.userId,
			projectId: input.projectId ?? null,
			name: `run-diff-${input.executionId}.patch.gz`,
			purpose: "output",
			scopeId: input.executionId,
			contentType: "application/gzip",
			bytes: gz,
		});
		fileId = file.id;
		payload = { baseRef: input.baseRef ?? null, headRef: input.headRef ?? null, stats, truncated, gzip: true };
	} else {
		payload = { patch, baseRef: input.baseRef ?? null, headRef: input.headRef ?? null, stats, truncated };
	}

	const values = {
		id,
		workflowExecutionId: input.executionId,
		nodeId: input.nodeId ?? null,
		slot: "secondary" as const,
		kind: RUN_DIFF_KIND,
		title,
		description: null,
		inlinePayload: payload as unknown,
		fileId,
		contentType: "text/x-diff",
		sizeBytes: patchBytes,
		metadata: { createdBy: "run-diff", capturedAt: new Date().toISOString() },
	};
	await db
		.insert(workflowArtifacts)
		.values(values)
		.onConflictDoUpdate({ target: workflowArtifacts.id, set: values });

	return { id, fileId, bytes: patchBytes, truncated };
}

/**
 * Resolve the full patch text for a `diff` artifact — inline payload or, when
 * offloaded, gunzip the referenced file. Returns null for non-diff artifacts.
 */
export async function resolveRunDiffPatch(
	artifact: Pick<WorkflowArtifactRow, "kind" | "inlinePayload" | "fileId">,
): Promise<{ patch: string; baseRef: string | null; headRef: string | null; stats: RunDiffStats; truncated: boolean } | null> {
	if (artifact.kind !== RUN_DIFF_KIND) return null;
	const payload = (artifact.inlinePayload ?? {}) as RunDiffInlinePayload;
	let patch = typeof payload.patch === "string" ? payload.patch : "";
	if (!patch && artifact.fileId) {
		const content = await getFileContent(artifact.fileId);
		if (content) {
			try {
				patch = gunzipSync(content.bytes).toString("utf8");
			} catch {
				patch = content.bytes.toString("utf8");
			}
		}
	}
	return {
		patch,
		baseRef: payload.baseRef ?? null,
		headRef: payload.headRef ?? null,
		stats: payload.stats ?? { files: 0, additions: 0, deletions: 0 },
		truncated: !!payload.truncated,
	};
}
