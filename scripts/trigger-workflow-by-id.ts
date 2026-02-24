/**
 * Trigger a workflow execution by workflow ID (or latest).
 * Usage:
 *   DATABASE_URL=... GENERIC_ORCHESTRATOR_URL=... pnpm tsx scripts/trigger-workflow-by-id.ts [workflowId]
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { desc, eq } from "drizzle-orm";
import {
	workflows,
	workflowExecutions,
	users,
} from "../lib/db/schema";
import { generateWorkflowDefinition } from "../lib/workflow-definition";
import { genericOrchestratorClient } from "../lib/dapr-client";
import type { WorkflowNode, WorkflowEdge } from "../lib/workflow-store";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL required");

const client = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(client, {
	schema: { workflows, workflowExecutions, users },
});

async function main() {
	const workflowId = process.argv[2];

	let workflow;
	if (workflowId) {
		const rows = await db
			.select()
			.from(workflows)
			.where(eq(workflows.id, workflowId))
			.limit(1);
		workflow = rows[0];
	} else {
		const rows = await db
			.select()
			.from(workflows)
			.orderBy(desc(workflows.updatedAt))
			.limit(1);
		workflow = rows[0];
	}
	if (!workflow) throw new Error("No workflow found");

	console.log("Triggering:", workflow.name, workflow.id);

	const user = await db.query.users.findFirst({
		orderBy: [desc(users.createdAt)],
	});

	const nodes = workflow.nodes as WorkflowNode[];
	const edges = workflow.edges as WorkflowEdge[];
	const definition = generateWorkflowDefinition(
		nodes,
		edges,
		workflow.id,
		workflow.name,
		{ author: user?.email || "" },
	);

	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: "running",
			input: {},
		})
		.returning();

	console.log("Execution:", execution.id);

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

	console.log("Started:", result.instanceId);
	console.log("");
	console.log("=== View in UI ===");
	console.log(
		`https://workflow-builder.cnoe.localtest.me:8443/workflows/${workflow.id}/runs/${execution.id}?tab=sandbox`,
	);

	await client.end();
	process.exit(0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
