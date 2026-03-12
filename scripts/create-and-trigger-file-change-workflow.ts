import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { genericOrchestratorClient } from "../lib/dapr-client.js";
import { db } from "../lib/db/index.js";
import { users, workflowExecutions, workflows } from "../lib/db/schema.js";
import { generateWorkflowDefinition } from "../lib/workflow-definition.js";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow-store.js";

const ORCHESTRATOR_URL =
	process.env.GENERIC_ORCHESTRATOR_URL || "http://127.0.0.1:18080";
const DURABLE_AGENT_URL =
	process.env.DURABLE_AGENT_URL || "http://127.0.0.1:18001";

async function resolveOwner(): Promise<{
	userId: string;
	projectId: string | null;
	userLabel: string;
}> {
	const latestWorkflow = await db.query.workflows.findFirst({
		orderBy: [desc(workflows.updatedAt)],
	});
	if (latestWorkflow) {
		const user = await db.query.users.findFirst({
			where: (table, { eq }) => eq(table.id, latestWorkflow.userId),
		});
		return {
			userId: latestWorkflow.userId,
			projectId: latestWorkflow.projectId ?? null,
			userLabel: user?.email || latestWorkflow.userId,
		};
	}

	const user = await db.query.users.findFirst({
		orderBy: [desc(users.updatedAt)],
	});
	if (!user) {
		throw new Error("No users found in the database");
	}

	return {
		userId: user.id,
		projectId: null,
		userLabel: user.email || user.id,
	};
}

function buildNodes(): WorkflowNode[] {
	const triggerId = `trigger_${nanoid(8)}`;
	const profileId = `profile_${nanoid(8)}`;
	const commandId = `command_${nanoid(8)}`;

	return [
		{
			id: triggerId,
			type: "trigger",
			position: { x: 0, y: 0 },
			data: {
				label: "Manual Trigger",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			},
		},
		{
			id: profileId,
			type: "action",
			position: { x: 260, y: 0 },
			data: {
				label: "Workspace Profile",
				description: "Create a sandboxed workspace for this execution",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "artifact-smoke-profile",
					enabledTools:
						'["read_file","write_file","edit_file","list_files","delete_file","mkdir","file_stat","execute_command"]',
					requireReadBeforeWrite: "false",
					commandTimeoutMs: "120000",
				},
				status: "idle",
			},
		},
		{
			id: commandId,
			type: "action",
			position: { x: 520, y: 0 },
			data: {
				label: "Create Files",
				description:
					"Write a couple of files so change artifacts are generated",
				type: "action",
				config: {
					actionType: "workspace/command",
					workspaceRef: `{{@${profileId}:Workspace Profile.workspaceRef}}`,
					timeoutMs: "120000",
					command: [
						"set -euo pipefail",
						"mkdir -p artifacts",
						"printf '# Artifact Smoke\\n' > artifacts/generated.md",
						'printf \'{"ok":true,"source":"workflow"}\\n\' > artifacts/result.json',
						"find artifacts -maxdepth 1 -type f | sort",
					].join(" && "),
				},
				status: "idle",
			},
		},
	];
}

function buildEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
	return [
		{
			id: `edge_${nanoid(8)}`,
			source: nodes[0].id,
			target: nodes[1].id,
			type: "default",
		},
		{
			id: `edge_${nanoid(8)}`,
			source: nodes[1].id,
			target: nodes[2].id,
			type: "default",
		},
	];
}

async function fetchJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { status: response.status, body: text };
	}
}

async function main() {
	const owner = await resolveOwner();
	console.log(`Using workflow owner: ${owner.userLabel}`);

	const nodes = buildNodes();
	const edges = buildEdges(nodes);
	const workflowId = nanoid(12);

	const [workflow] = await db
		.insert(workflows)
		.values({
			id: workflowId,
			name: "Artifact Smoke Workflow",
			description:
				"Minimal workflow that writes files and emits change artifacts",
			userId: owner.userId,
			projectId: owner.projectId,
			nodes: nodes as any,
			edges: edges as any,
			engineType: "dapr",
		})
		.returning();

	const definition = generateWorkflowDefinition(
		nodes,
		edges,
		workflow.id,
		workflow.name,
		{
			author: owner.userLabel,
			description: workflow.description || undefined,
		},
	);

	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: owner.userId,
			status: "running",
			input: {},
		})
		.returning();

	console.log(`Created workflow: ${workflow.id}`);
	console.log(`Created execution: ${execution.id}`);

	const start = await genericOrchestratorClient.startWorkflow(
		ORCHESTRATOR_URL,
		definition,
		{},
		{},
		execution.id,
		{},
	);
	console.log(`Started workflow instance: ${start.instanceId}`);
	console.log(
		`Run UI: http://localhost:3002/workflows/${workflow.id}/runs/${execution.id}?tab=changes`,
	);

	let finalStatus: unknown = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const status = await genericOrchestratorClient.getWorkflowStatus(
			ORCHESTRATOR_URL,
			start.instanceId,
		);
		finalStatus = status;
		console.log(
			`Poll ${attempt + 1}: ${status.runtimeStatus} phase=${status.properties?.customStatus?.phase ?? "unknown"}`,
		);
		if (
			status.runtimeStatus === "COMPLETED" ||
			status.runtimeStatus === "FAILED" ||
			status.runtimeStatus === "TERMINATED"
		) {
			break;
		}
	}

	console.log("Final workflow status:");
	console.log(JSON.stringify(finalStatus, null, 2));

	const changes = await fetchJson(
		`${DURABLE_AGENT_URL}/api/workspaces/executions/${execution.id}/changes`,
	);
	const patch = await fetchJson(
		`${DURABLE_AGENT_URL}/api/workspaces/executions/${execution.id}/patch`,
	);

	console.log("Execution changes:");
	console.log(JSON.stringify(changes, null, 2));
	console.log("Execution patch:");
	console.log(JSON.stringify(patch, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
