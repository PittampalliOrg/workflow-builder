import { describe, expect, it } from "vitest";
import { resolveMcpServerConfigsFromRows } from "./mcp-resolution";

describe("agent MCP resolution", () => {
	it("resolves a logical piece descriptor to the enabled project MCP connection", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [
				{
					id: "mcp_0",
					projectId: "project-1",
					sourceType: "nimble_piece",
					pieceName: "microsoft-excel-365",
					serverKey: null,
					connectionExternalId: "conn_excel",
					displayName: "Microsoft Excel 365",
					registryRef: "ap-microsoft-excel-365-service",
					serverUrl: "http://ap-microsoft-excel-365-service:3100/mcp",
					metadata: { transport: "streamable_http" },
				},
				{
					id: "mcp_1",
					projectId: "project-1",
					sourceType: "nimble_piece",
					pieceName: "microsoft-outlook",
					serverKey: null,
					connectionExternalId: "conn_outlook",
					displayName: "Microsoft Outlook",
					registryRef: "ap-microsoft-outlook-service",
					serverUrl: "http://ap-microsoft-outlook-service:3100/mcp",
					metadata: { transport: "streamable_http" },
				},
			],
			requestedServers: [
				{
					server_name: "piece_microsoft-outlook",
					displayName: "Microsoft Outlook",
					sourceType: "nimble_piece",
					pieceName: "microsoft-outlook",
					transport: "streamable_http",
					allowedTools: ["list_emails"],
				},
			],
		});

		expect(result.warnings).toEqual([]);
		expect(result.mcpServers).toEqual([
			{
				server_name: "piece_microsoft-outlook",
				name: "piece_microsoft-outlook",
				displayName: "Microsoft Outlook",
				sourceType: "nimble_piece",
				pieceName: "microsoft-outlook",
				serverKey: null,
				connectionExternalId: "conn_outlook",
				transport: "streamable_http",
				url: "http://ap-microsoft-outlook-service.workflow-builder.svc.cluster.local/mcp",
				headers: { "X-Connection-External-Id": "conn_outlook" },
				allowedTools: ["list_emails"],
			},
		]);
	});

	it("includes all project connections in project mode without duplicating explicit selections", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [
				{
					id: "mcp_1",
					projectId: "project-1",
					sourceType: "nimble_piece",
					pieceName: "github",
					serverKey: null,
					connectionExternalId: "conn_github",
					displayName: "GitHub",
					registryRef: "ap-github-service",
					serverUrl: "http://ap-github-service:3100/mcp",
					metadata: null,
				},
				{
					id: "mcp_2",
					projectId: "project-1",
					sourceType: "custom_url",
					pieceName: null,
					serverKey: "docs",
					connectionExternalId: null,
					displayName: "Docs",
					registryRef: null,
					serverUrl: "https://docs.example.test/mcp",
					metadata: null,
				},
			],
			requestedServers: [{ pieceName: "github", displayName: "GitHub" }],
			includeProjectConnections: true,
		});

		expect(result.mcpServers.map((server) => server.server_name)).toEqual([
			"piece_github",
			"custom_docs",
		]);
	});

	it("resolves hosted workflow connections through the MCP gateway", () => {
		const result = resolveMcpServerConfigsFromRows({
			rows: [
				{
					id: "mcp_hosted",
					projectId: "project-1",
					sourceType: "hosted_workflow",
					pieceName: null,
					serverKey: "workflow-tools",
					connectionExternalId: null,
					displayName: "Workflow Tools",
					registryRef: "mcp-gateway",
					serverUrl: "",
					metadata: {
						transport: "streamable_http",
						endpointPath: "/api/v1/projects/:projectId/mcp-server/http",
					},
				},
			],
			includeProjectConnections: true,
			hostedToken: "hosted-token",
		});

		expect(result).toEqual({
			mcpServers: [
				{
					server_name: "hosted_workflow-tools",
					name: "hosted_workflow-tools",
					displayName: "Workflow Tools",
					sourceType: "hosted_workflow",
					transport: "streamable_http",
					url: "http://mcp-gateway.workflow-builder.svc.cluster.local:8080/api/v1/projects/project-1/mcp-server/http",
					headers: { Authorization: "Bearer hosted-token" },
				},
			],
			warnings: [],
		});
	});
});
