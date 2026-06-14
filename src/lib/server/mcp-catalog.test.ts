import { describe, expect, it } from 'vitest';
import {
	buildAvailablePieceMcpCatalogEntry,
	buildMcpServerAvailabilityEntry,
	buildHostedMcpGatewayInternalUrl,
	buildProjectMcpCatalogEntry,
	parseRegisteredPieceMcpCatalog
} from './mcp-catalog';

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
			url: 'http://ap-microsoft-onedrive-service.workflow-builder.svc.cluster.local/mcp',
			sourceType: 'nimble_piece',
			pieceName: '@activepieces/piece-microsoft-onedrive',
			connectionExternalId: 'external-1',
			headers: {
				'X-Connection-External-Id': 'external-1'
			}
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

	it('builds browser-safe predefined MCP catalog entries', () => {
		expect(
			buildAvailablePieceMcpCatalogEntry({
				pieceName: '@activepieces/piece-github',
				displayName: 'GitHub',
				description: 'Repository automation',
				logoUrl: 'https://example.test/github.svg',
				categories: ['developer-tools'],
				auth: {
					type: 'OAUTH2',
					displayName: 'GitHub account'
				},
				actions: {
					search_repositories: {},
					get_repository: {}
				},
				oauthAppConfigured: true,
				appConnections: [
					{
						id: 'app-1',
						externalId: 'conn_app_1',
						displayName: 'Main GitHub',
						type: 'PLATFORM_OAUTH2',
						status: 'ACTIVE'
					}
				],
				mcpConnection: null
			})
		).toMatchObject({
			pieceName: 'github',
			canonicalPieceName: '@activepieces/piece-github',
			displayName: 'GitHub',
			authType: 'OAUTH2',
			authDisplayName: 'GitHub account',
			requiresAuth: true,
			isOAuth2: true,
			oauthAppConfigured: true,
			actionCount: 2,
			registryRef: 'ap-github-service',
			serverUrl: 'http://ap-github-service/mcp',
			appConnections: [
				{
					externalId: 'conn_app_1',
					status: 'ACTIVE'
				}
			]
		});
	});

	it('parses the activepieces MCP registered service catalog', () => {
		expect(
			parseRegisteredPieceMcpCatalog(
				JSON.stringify({
					github: {
						serviceName: 'ap-github-service',
						namespace: 'workflow-builder',
						piece: '@activepieces/piece-github',
						version: '0.0.0',
						categories: ['DEVELOPER_TOOLS'],
						reason: 'pinned',
						mcpUrl: 'http://ap-github-service.workflow-builder.svc.cluster.local/mcp'
					}
				})
			)
		).toEqual([
			{
				pieceName: 'github',
				canonicalPieceName: '@activepieces/piece-github',
				serviceName: 'ap-github-service',
				namespace: 'workflow-builder',
				version: '0.0.0',
				categories: ['DEVELOPER_TOOLS'],
				reason: 'pinned',
				registryRef: 'ap-github-service',
				serverUrl: 'http://ap-github-service.workflow-builder.svc.cluster.local/mcp'
			}
		]);
	});

	it('marks registered OAuth MCP entries ready only when the project binding has an app connection', () => {
		const registered = parseRegisteredPieceMcpCatalog(
			JSON.stringify({
				github: {
					serviceName: 'ap-github-service',
					namespace: 'workflow-builder',
					piece: '@activepieces/piece-github',
					reason: 'pinned',
					mcpUrl: 'http://ap-github-service.workflow-builder.svc.cluster.local/mcp'
				}
			})
		)[0];

		expect(
			buildMcpServerAvailabilityEntry({
				pieceName: '@activepieces/piece-github',
				displayName: 'GitHub',
				auth: { type: 'OAUTH2' },
				actions: { get_repository: {} },
				oauthAppConfigured: true,
				registered,
				appConnections: [
					{
						id: 'app-1',
						externalId: 'conn_github',
						displayName: 'Main GitHub',
						type: 'PLATFORM_OAUTH2',
						status: 'ACTIVE'
					}
				],
				mcpConnection: {
					id: 'mcp-1',
					displayName: 'GitHub',
					sourceType: 'nimble_piece',
					pieceName: 'github',
					serverKey: null,
					connectionExternalId: 'conn_github',
					serverUrl: 'http://ap-github-service/mcp',
					status: 'ENABLED',
					metadata: null
				}
			})
		).toMatchObject({
			registered: true,
			enabled: true,
			ready: true,
			authStatus: 'READY',
			authStatusLabel: 'Connected: Main GitHub',
			mcpConnectionExternalId: 'mcp-1',
			serviceName: 'ap-github-service'
		});
	});
});
