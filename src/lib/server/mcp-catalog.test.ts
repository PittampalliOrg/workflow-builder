import { describe, expect, it } from 'vitest';
import { buildHostedMcpGatewayInternalUrl, buildProjectMcpCatalogEntry } from './mcp-catalog';

describe('project MCP catalog helpers', () => {
	it('maps piece connections to stable MCPJam server names', () => {
		expect(
			buildProjectMcpCatalogEntry({
				id: 'conn_1',
				projectId: 'project-1',
				sourceType: 'nimble_piece',
				pieceName: '@activepieces/piece-microsoft-onedrive',
				serverKey: null,
				connectionExternalId: 'external-1',
				displayName: 'Microsoft OneDrive',
				serverUrl: 'http://ap-microsoft-onedrive-service:3100/mcp',
				metadata: null
			})
		).toEqual({
			name: 'ap-microsoft-onedrive',
			displayName: 'Microsoft OneDrive',
			url: 'http://ap-microsoft-onedrive-service:3100/mcp',
			sourceType: 'nimble_piece',
			pieceName: '@activepieces/piece-microsoft-onedrive',
			connectionExternalId: 'external-1'
		});
	});

	it('builds hosted workflow entries with bearer auth and the internal gateway URL', () => {
		expect(
			buildProjectMcpCatalogEntry(
				{
					id: 'conn_2',
					projectId: 'project-2',
					sourceType: 'hosted_workflow',
					pieceName: null,
					serverKey: null,
					connectionExternalId: null,
					displayName: 'Workflow Builder Hosted MCP',
					serverUrl: 'https://workflow-builder.cnoe.localtest.me/api/v1/projects/project-2/mcp-server/http',
					metadata: null
				},
				{
					hostedProjectId: 'project-2',
					hostedToken: 'token-123',
					hostedGatewayBaseUrl: 'http://mcp-gateway.workflow-builder.svc.cluster.local:8080/'
				}
			)
		).toEqual({
			name: 'workflow-builder-hosted',
			displayName: 'Workflow Builder Hosted MCP',
			url: 'http://mcp-gateway.workflow-builder.svc.cluster.local:8080/api/v1/projects/project-2/mcp-server/http',
			sourceType: 'hosted_workflow',
			serverKey: null,
			headers: {
				Authorization: 'Bearer token-123'
			}
		});
	});

	it('normalizes shared and custom server names', () => {
		expect(
			buildProjectMcpCatalogEntry({
				id: 'conn_3',
				projectId: 'project-3',
				sourceType: 'custom_url',
				pieceName: null,
				serverKey: 'Browser Tools',
				connectionExternalId: null,
				displayName: 'Browser Tools',
				serverUrl: 'http://browser-tools.example/mcp',
				metadata: null
			})
		).toEqual({
			name: 'custom-browser-tools',
			displayName: 'Browser Tools',
			url: 'http://browser-tools.example/mcp',
			sourceType: 'custom_url',
			serverKey: 'Browser Tools',
			connectionExternalId: null
		});
	});

	it('skips invalid rows that cannot be exposed safely', () => {
		expect(
			buildProjectMcpCatalogEntry({
				id: 'conn_4',
				projectId: 'project-4',
				sourceType: 'nimble_piece',
				pieceName: null,
				serverKey: null,
				connectionExternalId: null,
				displayName: 'Broken Piece',
				serverUrl: 'not-a-url',
				metadata: null
			})
		).toBeNull();

		expect(
			buildProjectMcpCatalogEntry(
				{
					id: 'conn_5',
					projectId: 'project-5',
					sourceType: 'hosted_workflow',
					pieceName: null,
					serverKey: null,
					connectionExternalId: null,
					displayName: 'Hosted',
					serverUrl: null,
					metadata: null
				},
				{ hostedProjectId: 'project-5', hostedToken: '' }
			)
		).toBeNull();
	});

	it('builds the internal hosted gateway URL without duplicate slashes', () => {
		expect(
			buildHostedMcpGatewayInternalUrl(
				'project-6',
				'http://mcp-gateway.workflow-builder.svc.cluster.local:8080/'
			)
		).toBe(
			'http://mcp-gateway.workflow-builder.svc.cluster.local:8080/api/v1/projects/project-6/mcp-server/http'
		);
	});
});
