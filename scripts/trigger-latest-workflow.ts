import { db } from "../lib/db/index.js";
import { workflows, workflowExecutions, users } from "../lib/db/schema.js";
import { generateWorkflowDefinition } from "../lib/workflow-definition.js";
import { genericOrchestratorClient } from "../lib/dapr-client.js";
import { eq, desc } from "drizzle-orm";
import type { WorkflowNode, WorkflowEdge } from "../lib/workflow-store.js";

async function main() {
	const [workflow] = await db
		.select()
		.from(workflows)
		.orderBy(desc(workflows.updatedAt))
		.limit(1);
	if (!workflow) throw new Error("No workflow found");

	console.log("Triggering workflow:", workflow.name, workflow.id);
	const user = await db.query.users.findFirst({
		where: eq(users.id, workflow.userId),
	});

	const definition = generateWorkflowDefinition(
		workflow.nodes as WorkflowNode[],
		workflow.edges as WorkflowEdge[],
		workflow.id,
		workflow.name,
		{ author: user?.email || user?.id },
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

	const url = process.env.GENERIC_ORCHESTRATOR_URL || "http://127.0.0.1:8080";
	const result = await genericOrchestratorClient.startWorkflow(
		url,
		definition,
		{},
		{},
		execution.id,
		{},
	);

	console.log("Started Dapr workflow:", result.instanceId);

	// Poll
	while (true) {
		await new Promise((r) => setTimeout(r, 5000));
		const st = await genericOrchestratorClient.getWorkflowStatus(
			url,
			result.instanceId,
		);
		console.log("Status:", st.runtimeStatus);
		if (
			st.runtimeStatus === "COMPLETED" ||
			st.runtimeStatus === "FAILED" ||
			st.runtimeStatus === "TERMINATED"
		) {
			console.log("Done!", st);
			break;
		}
	}
	process.exit(0);
}

main().catch(console.error);
