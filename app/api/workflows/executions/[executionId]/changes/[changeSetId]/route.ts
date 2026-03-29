import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { parseExecutionFileChangeData } from "@/lib/transforms/workflow-ui";

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
			if (!value || typeof value !== "object") {
				continue;
			}
			records.push(value as Record<string, unknown>);
			const data = (value as Record<string, unknown>).data;
			if (data && typeof data === "object") {
				records.push(data as Record<string, unknown>);
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

function buildPersistedChangeArtifact(args: {
	executionId: string;
	changeSetId: string;
	startedAt: Date | null | undefined;
	output: unknown;
}) {
	const changeData = parseExecutionFileChangeData(args.output);
	if (!changeData) {
		return null;
	}
	const expectedChangeSetId = `derived:${args.executionId}:${changeData.sourceNodeKey ?? "execution"}`;
	if (args.changeSetId !== expectedChangeSetId) {
		return null;
	}
	if (!changeData.patch?.trim()) {
		return null;
	}

	return {
		success: true,
		executionId: args.executionId,
		metadata: {
			changeSetId: args.changeSetId,
			executionId: args.executionId,
			workspaceRef: extractWorkspaceRef(args.output),
			durableInstanceId: changeData.durableInstanceId,
			operation: "execution-output",
			format: "git-unified-v1",
			storageRef: changeData.patchRef ?? args.changeSetId,
			createdAt: args.startedAt?.toISOString() ?? new Date(0).toISOString(),
			includeInExecutionPatch: true,
		},
		patch: changeData.patch,
	};
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string; changeSetId: string }> },
) {
	try {
		const { executionId, changeSetId } = await context.params;
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

		const persistedArtifact = buildPersistedChangeArtifact({
			executionId,
			changeSetId,
			startedAt: execution.startedAt,
			output: execution.output,
		});
		if (persistedArtifact) {
			return NextResponse.json(persistedArtifact, {
				headers: {
					"Cache-Control": "no-store",
				},
			});
		}
		return NextResponse.json(
			{ error: "Change artifact not found for execution" },
			{ status: 404 },
		);
	} catch (error) {
		console.error("Failed to load execution change artifact:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution change artifact",
			},
			{ status: 500 },
		);
	}
}
