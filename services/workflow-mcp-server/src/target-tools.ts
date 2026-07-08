import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";
import {
	getWorkflowTargetHealth,
	getWorkflowTargetResources,
	listWorkflowTargets,
} from "./targets.js";

const targetInput = z
	.string()
	.optional()
	.describe(
		'Workflow runtime target. Use "dev" for the host dev cluster, or "preview:<name>" / "<name>" / preview alias for a vCluster preview.',
	);

function textResult(data: unknown) {
	setSpanOutput(data);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(msg: string) {
	setSpanOutput({ error: msg });
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

export function registerTargetTools(server: McpServer): RegisteredTool[] {
	const tools: RegisteredTool[] = [];

	(server as any).registerTool(
		"list_workflow_targets",
		{
			title: "List Workflow Targets",
			description:
				"List workflow-builder runtime targets reachable from this MCP server. Includes the host dev cluster and discovered vCluster previews, with internal/tailnet URLs and whether each target can proxy MCP calls.",
			inputSchema: {},
		},
		async () => {
			try {
				return textResult(await listWorkflowTargets());
			} catch (error) {
				return errorResult(
					`Failed to list workflow targets: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	);
	tools.push({
		name: "list_workflow_targets",
		description: "List dev and preview workflow runtime targets",
	});

	(server as any).registerTool(
		"get_workflow_target_health",
		{
			title: "Get Workflow Target Health",
			description:
				"Check the workflow-builder API and workflow-mcp-server health for a target. Defaults to dev; accepts preview:<name> for vCluster previews.",
			inputSchema: {
				target: targetInput,
			},
		},
		async (args: { target?: string }) => {
			try {
				return textResult(await getWorkflowTargetHealth(args.target));
			} catch (error) {
				return errorResult(
					`Failed to check workflow target health: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	);
	tools.push({
		name: "get_workflow_target_health",
		description: "Check workflow-builder and MCP health for a target",
	});

	(server as any).registerTool(
		"get_workflow_target_resources",
		{
			title: "Get Workflow Target Resources",
			description:
				"Return read-only Kubernetes resource summaries for the target namespace: services, pods, and deployments. Defaults to dev; accepts preview:<name> for vCluster previews.",
			inputSchema: {
				target: targetInput,
			},
		},
		async (args: { target?: string }) => {
			try {
				return textResult(await getWorkflowTargetResources(args.target));
			} catch (error) {
				return errorResult(
					`Failed to get workflow target resources: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		},
	);
	tools.push({
		name: "get_workflow_target_resources",
		description: "Read Kubernetes resource summaries for a workflow target",
	});

	return tools;
}
