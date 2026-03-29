import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { isValidInternalToken } from "@/lib/internal-api";
import { parseExecutionFileChangeData } from "@/lib/transforms/workflow-ui";

function extractWorkspaceRef(output: unknown): string | null {
	if (!output || typeof output !== "object") {
		return null;
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

	return null;
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const { executionId } = await context.params;
		const normalizedExecutionId = executionId.trim();
		if (!normalizedExecutionId) {
			return NextResponse.json(
				{ error: "Execution ID is required" },
				{ status: 400 },
			);
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, normalizedExecutionId),
		});
		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		const changeData = parseExecutionFileChangeData(execution.output);
		if (!changeData?.patch?.trim()) {
			return NextResponse.json(
				{ error: "Change artifact not found for execution" },
				{ status: 404 },
			);
		}

		return NextResponse.json(
			{
				success: true,
				executionId: normalizedExecutionId,
				changeSetId: `derived:${normalizedExecutionId}:${changeData.sourceNodeKey ?? "execution"}`,
				durableInstanceId: changeData.durableInstanceId ?? null,
				workspaceRef: extractWorkspaceRef(execution.output),
				sourceNodeKey: changeData.sourceNodeKey ?? null,
				patch: changeData.patch,
				patchRef: changeData.patchRef ?? null,
				snapshotRefs: changeData.snapshotRefs,
				stats: changeData.stats ?? null,
				files: changeData.files,
				createdAt: execution.startedAt?.toISOString() ?? null,
			},
			{
				headers: {
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		console.error("Failed to load internal execution change artifact:", error);
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
