/**
 * Create and trigger a workflow that uses the AIO browser sandbox.
 *
 * Creates a simple 3-node workflow:
 *   trigger → workspace/profile (aio-browser) → workspace/command (echo + whoami)
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/create-and-trigger-aio-browser-workflow.ts
 */

import { db } from "../lib/db/index.js";
import {
	workflows,
	workflowExecutions,
	users,
} from "../lib/db/schema.js";
import { generateWorkflowDefinition } from "../lib/workflow-definition.js";
import { genericOrchestratorClient } from "../lib/dapr-client.js";
import { desc } from "drizzle-orm";
import type { WorkflowNode, WorkflowEdge } from "../lib/workflow-store.js";
import { nanoid } from "nanoid";

async function main() {
	// Get first user
	const user = await db.query.users.findFirst({
		orderBy: [desc(users.createdAt)],
	});
	if (!user) throw new Error("No user found in DB");
	console.log("Using user:", user.email || user.id);

	// Node IDs
	const triggerId = `trigger_${nanoid(8)}`;
	const profileId = `profile_${nanoid(8)}`;
	const commandId = `command_${nanoid(8)}`;

	const nodes: WorkflowNode[] = [
		{
			id: triggerId,
			type: "trigger",
			position: { x: 250, y: 50 },
			data: {
				label: "Start",
				type: "trigger",
				config: {},
				status: "idle",
			},
		},
		{
			id: profileId,
			type: "action",
			position: { x: 250, y: 200 },
			data: {
				label: "AIO Workspace Profile",
				type: "action",
				config: {
					actionType: "workspace/profile",
					name: "aio-browser-demo",
					enabledTools: '["read_file","write_file","edit_file","list_files","delete_file","mkdir","file_stat","execute_command"]',
					requireReadBeforeWrite: "false",
					commandTimeoutMs: "60000",
					sandboxTemplate: "aio-browser",
				},
				status: "idle",
			},
		},
		{
			id: commandId,
			type: "action",
			position: { x: 250, y: 400 },
			data: {
				label: "Run Browser Check",
				type: "action",
				config: {
					actionType: "workspace/command",
					command: "echo '=== AIO Browser Sandbox ===' && whoami && pwd && echo '--- System info ---' && uname -a && echo '--- Chrome check ---' && which google-chrome || which chromium-browser || echo 'no chrome found' && echo '--- VNC check ---' && ls /tmp/.X* 2>/dev/null || echo 'no X display' && echo '--- Done ---'",
					workspaceRef: `{{@${profileId}:AIO Workspace Profile.workspaceRef}}`,
				},
				status: "idle",
			},
		},
	];

	const edges: WorkflowEdge[] = [
		{
			id: `e_${nanoid(6)}`,
			source: triggerId,
			target: profileId,
			type: "default",
		},
		{
			id: `e_${nanoid(6)}`,
			source: profileId,
			target: commandId,
			type: "default",
		},
	];

	// Create workflow
	const workflowId = nanoid(12);
	const [workflow] = await db
		.insert(workflows)
		.values({
			id: workflowId,
			name: "AIO Browser Sandbox Demo",
			userId: user.id,
			projectId: null as any,
			nodes: nodes as any,
			edges: edges as any,
			engineType: "dapr",
		})
		.returning();

	console.log("Created workflow:", workflow.id, workflow.name);

	// Generate definition
	const definition = generateWorkflowDefinition(
		nodes,
		edges,
		workflow.id,
		workflow.name,
		{ author: user.email || user.id },
	);

	// Create execution record
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: user.id,
			status: "running",
			input: {},
		})
		.returning();

	console.log("Created execution:", execution.id);

	// Start workflow via Dapr orchestrator
	const url =
		process.env.GENERIC_ORCHESTRATOR_URL || "http://127.0.0.1:8080";
	const result = await genericOrchestratorClient.startWorkflow(
		url,
		definition,
		{},
		{},
		execution.id,
		{},
	);

	console.log("Started Dapr workflow:", result.instanceId);
	console.log("");
	console.log("=== View in UI ===");
	console.log(
		`https://workflow-builder.cnoe.localtest.me:8443/workflows/${workflow.id}/runs/${execution.id}?tab=sandbox`,
	);
	console.log("");

	// Poll for status
	let lastStatus = "";
	while (true) {
		await new Promise((r) => setTimeout(r, 5000));
		try {
			const st = await genericOrchestratorClient.getWorkflowStatus(
				url,
				result.instanceId,
			);
			if (st.runtimeStatus !== lastStatus) {
				console.log("Status:", st.runtimeStatus);
				lastStatus = st.runtimeStatus;
			}
			if (
				st.runtimeStatus === "COMPLETED" ||
				st.runtimeStatus === "FAILED" ||
				st.runtimeStatus === "TERMINATED"
			) {
				console.log("Final output:", JSON.stringify(st.output, null, 2));
				break;
			}
		} catch (err: any) {
			console.log("Poll error:", err.message);
		}
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
