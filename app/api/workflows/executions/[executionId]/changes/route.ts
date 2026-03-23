import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { invokeService } from "@/lib/dapr/client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { parseExecutionFileChangeData } from "@/lib/transforms/workflow-ui";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

function shouldMarkPending(status: string): boolean {
	return status === "pending" || status === "running";
}

function errorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== "object") {
		return fallback;
	}
	const candidate = (data as Record<string, unknown>).error;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: fallback;
}

type ChangeArtifactMetadata = {
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
	files: Array<{
		path: string;
		status: "A" | "M" | "D" | "R";
		oldPath?: string;
	}>;
	baseRevision?: string;
	headRevision?: string;
};

function extractWorkspaceRef(output: unknown): string {
	if (!output || typeof output !== "object") {
		return "workspace";
	}

	const records: Record<string, unknown>[] = [
		output as Record<string, unknown>,
	];
	const outputs = (output as Record<string, unknown>).outputs;
	if (outputs && typeof outputs === "object") {
		for (const value of Object.values(outputs as Record<string, unknown>)) {
			if (value && typeof value === "object") {
				records.push(value as Record<string, unknown>);
				const data = (value as Record<string, unknown>).data;
				if (data && typeof data === "object") {
					records.push(data as Record<string, unknown>);
				}
			}
		}
	}

	for (const record of records) {
		for (const key of ["workspaceRef", "workspace_ref", "sandboxName"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				return value.trim();
			}
		}
	}

	return "workspace";
}

function hasStructuredExecutionArtifacts(output: unknown): boolean {
	if (!output || typeof output !== "object") {
		return false;
	}

	const records: Record<string, unknown>[] = [
		output as Record<string, unknown>,
	];
	const outputs = (output as Record<string, unknown>).outputs;
	if (outputs && typeof outputs === "object") {
		for (const value of Object.values(outputs as Record<string, unknown>)) {
			if (!value || typeof value !== "object") {
				continue;
			}
			records.push(value as Record<string, unknown>);
			const nestedResult = (value as Record<string, unknown>).result;
			if (nestedResult && typeof nestedResult === "object") {
				records.push(nestedResult as Record<string, unknown>);
			}
		}
	}

	return records.some((record) => {
		for (const key of [
			"fileChanges",
			"changeSummary",
			"patch",
			"patchRef",
			"patch_ref",
			"snapshotRefs",
		]) {
			if (record[key] != null) {
				return true;
			}
		}
		return false;
	});
}

function buildFallbackChangesResponse(args: {
	executionId: string;
	status: string;
	startedAt: Date | null | undefined;
	output: unknown;
}) {
	const changeData = parseExecutionFileChangeData(args.output);
	if (!changeData) {
		return null;
	}

	const patchBytes = changeData.patch
		? Buffer.byteLength(changeData.patch, "utf8")
		: 0;
	const changeSetId = `derived:${args.executionId}:${changeData.sourceNodeKey ?? "execution"}`;
	const derivedStorageRef = changeData.patchRef ?? changeSetId;
	const operation = hasStructuredExecutionArtifacts(args.output)
		? "execution-output"
		: "derived-output";
	const changes: ChangeArtifactMetadata[] = [
		{
			changeSetId,
			executionId: args.executionId,
			workspaceRef: extractWorkspaceRef(args.output),
			durableInstanceId: changeData.durableInstanceId,
			operation,
			sequence: 1,
			format: "git-unified-v1",
			filesChanged: changeData.stats?.files ?? changeData.files.length,
			additions: changeData.stats?.additions ?? 0,
			deletions: changeData.stats?.deletions ?? 0,
			bytes: patchBytes,
			compressed: false,
			storageRef: derivedStorageRef,
			createdAt: args.startedAt?.toISOString() ?? new Date(0).toISOString(),
			includeInExecutionPatch: Boolean(
				changeData.patch?.trim() || changeData.patchRef?.trim(),
			),
			truncated: false,
			originalBytes: patchBytes,
			files: changeData.files,
			sha256: derivedStorageRef,
		},
	];

	return {
		success: true,
		executionId: args.executionId,
		count: changes.length,
		changes,
		pending: shouldMarkPending(args.status),
	};
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	try {
		const { executionId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
			with: {
				workflow: true,
			},
		});

		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		if (execution.workflow.userId !== session.user.id) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const response = await invokeService<{
			success?: boolean;
			executionId?: string;
			count?: number;
			changes?: unknown[];
			pending?: boolean;
			error?: string;
		}>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/changes`,
			timeout: 15_000,
		});

		if (response.status === 404) {
			const fallback = buildFallbackChangesResponse({
				executionId,
				status: execution.status,
				startedAt: execution.startedAt,
				output: execution.output,
			});
			return NextResponse.json(
				fallback ?? {
					success: true,
					executionId,
					count: 0,
					changes: [],
					pending: shouldMarkPending(execution.status),
				},
				{
					headers: {
						"Cache-Control": "no-store",
					},
				},
			);
		}

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(
						response.data,
						"Failed to fetch execution file changes",
					),
				},
				{ status: response.status || 502 },
			);
		}

		const responseData =
			response.data.count || (response.data.changes?.length ?? 0) > 0
				? response.data
				: (buildFallbackChangesResponse({
						executionId,
						status: execution.status,
						startedAt: execution.startedAt,
						output: execution.output,
					}) ?? response.data);

		return NextResponse.json(responseData, {
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Failed to load execution change artifacts:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution change artifacts",
			},
			{ status: 500 },
		);
	}
}
