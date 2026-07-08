import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { currentGoalSessionId } from "./goal-context.js";
import type { ResolvedWorkflowTarget } from "./targets.js";

const REMOTE_MCP_CALL_TIMEOUT_MS = Number(
	process.env.REMOTE_MCP_CALL_TIMEOUT_MS ?? 150_000,
);

export type RemoteToolCallOptions = {
	userId?: string;
	sessionId?: string | null;
};

export function stripRoutingArgs<T extends Record<string, unknown>>(
	args: T,
): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...args };
	delete copy.target;
	delete copy.sessionId;
	return copy;
}

export async function callRemoteWorkflowTargetTool(
	target: ResolvedWorkflowTarget,
	toolName: string,
	args: Record<string, unknown>,
	opts?: RemoteToolCallOptions,
): Promise<any> {
	if (!target.mcpBaseUrl) {
		throw new Error(`Target "${target.info.target}" has no MCP URL.`);
	}

	const headers: Record<string, string> = {};
	const sessionId = opts?.sessionId ?? currentGoalSessionId();
	if (opts?.userId) headers["X-User-Id"] = opts.userId;
	if (sessionId) headers["X-Wfb-Session-Id"] = sessionId;

	const client = new Client(
		{ name: "workflow-mcp-target-router", version: "1.0.0" },
		{ capabilities: {} },
	);
	const transport = new StreamableHTTPClientTransport(
		new URL(`${target.mcpBaseUrl.replace(/\/$/, "")}/mcp`),
		{
			requestInit: { headers },
		},
	);

	try {
		await client.connect(transport, { timeout: 30_000 });
		return await client.callTool(
			{ name: toolName, arguments: stripRoutingArgs(args) },
			undefined,
			{
				timeout: REMOTE_MCP_CALL_TIMEOUT_MS,
				maxTotalTimeout: REMOTE_MCP_CALL_TIMEOUT_MS,
			},
		);
	} finally {
		await transport.terminateSession().catch(() => undefined);
		await client.close().catch(() => undefined);
	}
}
