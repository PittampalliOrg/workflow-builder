import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
	workflowAgentRuns,
	workflowExecutions,
	workflowWorkspaceSessions,
} from "@/lib/db/schema";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function readNestedString(
	record: Record<string, unknown> | null,
	path: string[],
): string | undefined {
	let current: unknown = record;
	for (const segment of path) {
		if (!current || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current !== "string") {
		return undefined;
	}
	const trimmed = current.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function buildNodeConfigMap(
	nodes: unknown,
): Map<
	string,
	{ actionType?: string; cwd?: string; sandboxRepoPath?: string }
> {
	const result = new Map<
		string,
		{ actionType?: string; cwd?: string; sandboxRepoPath?: string }
	>();
	if (!Array.isArray(nodes)) {
		return result;
	}

	for (const node of nodes) {
		const record = asRecord(node);
		const nodeId = readNestedString(record, ["id"]);
		const config = asRecord(asRecord(record?.data)?.config);
		if (!nodeId || !config) {
			continue;
		}
		result.set(nodeId, {
			actionType: readNestedString(config, ["actionType"]),
			cwd: readNestedString(config, ["cwd"]),
			sandboxRepoPath: readNestedString(config, ["sandboxRepoPath"]),
		});
	}

	return result;
}

function findOpenShellSandbox(
	nodes: unknown,
	executionOutput: unknown,
	agentRuns: Array<{
		nodeId: string;
		daprInstanceId: string;
		status: string;
		result: Record<string, unknown> | null;
	}>,
) {
	const nodeConfigMap = buildNodeConfigMap(nodes);

	for (const run of agentRuns) {
		const nodeConfig = nodeConfigMap.get(run.nodeId);
		if (nodeConfig?.actionType !== "openshell/run") {
			continue;
		}
		const sandboxName =
			readNestedString(run.result, ["sandboxName"]) ??
			readNestedString(run.result, ["result", "sandboxName"]) ??
			readNestedString(run.result, ["agentProgress", "currentStepName"]);
		if (!sandboxName) {
			continue;
		}
		return {
			templateName: "openshell",
			sandboxName,
			repoPath: nodeConfig.sandboxRepoPath ?? nodeConfig.cwd,
			agentRunId: run.daprInstanceId,
			status: run.status,
		};
	}

	const output = asRecord(executionOutput);
	const outputs = asRecord(output?.outputs);
	if (!outputs) {
		return null;
	}

	for (const [nodeKey, value] of Object.entries(outputs)) {
		const nodeConfig = nodeConfigMap.get(nodeKey);
		if (nodeConfig?.actionType !== "openshell/run") {
			continue;
		}
		const record = asRecord(value);
		const sandboxName =
			readNestedString(record, ["sandboxName"]) ??
			readNestedString(record, ["result", "sandboxName"]) ??
			readNestedString(record, ["agentProgress", "currentStepName"]);
		if (!sandboxName) {
			continue;
		}
		return {
			templateName: "openshell",
			sandboxName,
			repoPath: nodeConfig.sandboxRepoPath ?? nodeConfig.cwd,
			agentRunId:
				readNestedString(record, ["agentWorkflowId"]) ??
				readNestedString(record, ["daprInstanceId"]),
			status:
				readNestedString(record, ["agentProgress", "status"]) ??
				readNestedString(record, ["phase"]),
		};
	}

	return null;
}

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string; executionId: string }> },
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

		const workspaceSession = await db.query.workflowWorkspaceSessions.findFirst(
			{
				where: and(
					eq(workflowWorkspaceSessions.workflowExecutionId, executionId),
					eq(workflowWorkspaceSessions.status, "active"),
				),
				orderBy: [desc(workflowWorkspaceSessions.updatedAt)],
			},
		);

		if (!workspaceSession) {
			const agentRuns = await db
				.select({
					nodeId: workflowAgentRuns.nodeId,
					daprInstanceId: workflowAgentRuns.daprInstanceId,
					status: workflowAgentRuns.status,
					result: workflowAgentRuns.result,
				})
				.from(workflowAgentRuns)
				.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
				.orderBy(desc(workflowAgentRuns.createdAt));
			const openShellSandbox = findOpenShellSandbox(
				execution.workflow.nodes,
				execution.output,
				agentRuns,
			);
			if (openShellSandbox) {
				return NextResponse.json(openShellSandbox);
			}
			return NextResponse.json(
				{ error: "No active sandbox found" },
				{ status: 404 },
			);
		}

		const sandboxState = workspaceSession.sandboxState as Record<
			string,
			any
		> | null;
		const podIp = sandboxState?.podIp;

		if (!podIp) {
			return NextResponse.json(
				{ error: "Sandbox IP not assigned yet" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			podIp,
			templateName: sandboxState?.templateName || "dapr-agent",
		});
	} catch (error) {
		console.error("Failed to get sandbox status:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get sandbox status",
			},
			{ status: 500 },
		);
	}
}
