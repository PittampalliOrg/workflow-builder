import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	resolveMcpServerConfigsFromRows,
	type AgentMcpConnectionRow,
} from "./mcp-resolution";

function row(overrides: Partial<AgentMcpConnectionRow> = {}): AgentMcpConnectionRow {
	return {
		id: "mcp-1",
		projectId: "project-1",
		sourceType: "nimble_piece",
		pieceName: "github",
		serverKey: null,
		connectionExternalId: "conn-1",
		displayName: "GitHub",
		registryRef: null,
		serverUrl: "http://piece-mcp-server/mcp",
		metadata: { transport: "streamable_http" },
		...overrides,
	};
}

describe("agent MCP resolution boundary", () => {
	it("keeps MCP persistence out of the pure resolver module", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "mcp-resolution.ts"),
			"utf8",
		);

		expect(source).toContain("resolveMcpServerConfigsFromRows");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/db/mcp");
		expect(source).not.toContain("drizzle-orm");
	});

	it("resolves logical profile servers to project MCP connections", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [row()],
			requestedServers: [
				{
					server_name: "piece_github",
					pieceName: "github",
					allowedTools: ["list_repositories"],
				},
			],
		});

		expect(result.warnings).toEqual([]);
		expect(result.mcpServers).toEqual([
			expect.objectContaining({
				server_name: "piece_github",
				name: "piece_github",
				displayName: "GitHub",
				sourceType: "nimble_piece",
				pieceName: "github",
				connectionExternalId: "conn-1",
				mcpConnectionExternalId: "mcp-1",
				transport: "streamable_http",
				url: "http://piece-mcp-server.workflow-builder.svc.cluster.local/mcp?tools=list_repositories",
				headers: { "X-Connection-External-Id": "conn-1" },
				allowedTools: ["list_repositories"],
			}),
		]);
	});

	it("narrows piece tools to the project ceiling and agent intersection", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [
				row({
					id: "mcp-gh",
					registryRef: "ap-github-service",
					serverUrl: "http://ap-github-service:3100/mcp",
					metadata: {
						transport: "streamable_http",
						toolSelection: { tools: ["create_issue", "find_issue", "find_user"] },
					},
				}),
			],
			requestedServers: [
				{
					pieceName: "github",
					allowedTools: ["create_issue", "delete_branch"],
				},
			],
		});

		expect(result.warnings).toEqual([]);
		expect(result.mcpServers[0]).toMatchObject({
			url: "http://ap-github-service.workflow-builder.svc.cluster.local/mcp?tools=create_issue",
			allowedTools: ["create_issue"],
		});
	});

	it("resolves hosted workflow connections with the supplied bearer token", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [
				row({
					id: "mcp-hosted",
					sourceType: "hosted_workflow",
					pieceName: null,
					serverKey: "workflow-tools",
					connectionExternalId: null,
					displayName: "Workflow Tools",
					registryRef: "mcp-gateway",
					serverUrl: null,
					metadata: {
						transport: "streamable_http",
						endpointPath: "/api/v1/projects/:projectId/mcp-server/http",
					},
				}),
			],
			includeProjectConnections: true,
			hostedToken: "token:project-1",
		});

		expect(result).toEqual({
			mcpServers: [
				expect.objectContaining({
					server_name: "hosted_workflow-tools",
					name: "hosted_workflow-tools",
					displayName: "Workflow Tools",
					sourceType: "hosted_workflow",
					transport: "streamable_http",
					url: "http://mcp-gateway.workflow-builder.svc.cluster.local:8080/api/v1/projects/project-1/mcp-server/http",
					headers: { Authorization: "Bearer token:project-1" },
				}),
			],
			warnings: [],
		});
	});
});
