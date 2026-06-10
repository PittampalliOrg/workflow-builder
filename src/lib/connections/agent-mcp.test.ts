import { describe, expect, it } from 'vitest';
import {
	attachPieceServerConfig,
	effectiveAgentTools,
	estimateToolTokens,
	materializeAllowedTools,
	serverMatchesEntry,
	TOOL_TOKEN_ESTIMATE,
	type McpAvailabilityEntryLite
} from './agent-mcp';
import type { McpServerProfileConfig } from '$lib/server/agent-profiles';

const entry: McpAvailabilityEntryLite = {
	pieceName: 'github',
	canonicalPieceName: '@activepieces/piece-github',
	displayName: 'GitHub',
	description: null,
	logoUrl: null,
	categories: [],
	actionCount: 27,
	registered: true,
	enabled: true,
	ready: true,
	authStatus: 'READY',
	authStatusLabel: 'Ready',
	mcpConnectionExternalId: 'mcp_gh',
	mcpConnection: {
		id: 'mcp_gh',
		displayName: 'GitHub',
		sourceType: 'nimble_piece',
		pieceName: 'github',
		serverKey: null,
		connectionExternalId: 'conn_gh',
		serverUrl: 'http://ap-github-service:3100/mcp',
		status: 'ENABLED',
		metadata: { toolSelection: { tools: ['create_issue', 'find_issue', 'find_user'] } }
	}
};

describe('agent-mcp helpers', () => {
	it('attaches a piece server with the connection id and NO allowedTools (inherits ceiling)', () => {
		const config = attachPieceServerConfig(entry);
		expect(config.sourceType).toBe('nimble_piece');
		expect(config.pieceName).toBe('github');
		expect(config.mcpConnectionExternalId).toBe('mcp_gh');
		expect(config.server_name).toBe('piece_github');
		// "all enabled" must be absent, never []
		expect('allowedTools' in config).toBe(false);
	});

	it('matches an attached server to its availability entry by connection id then piece name', () => {
		expect(serverMatchesEntry({ mcpConnectionExternalId: 'mcp_gh' }, entry)).toBe(true);
		expect(serverMatchesEntry({ sourceType: 'nimble_piece', pieceName: 'GitHub' }, entry)).toBe(true);
		expect(serverMatchesEntry({ sourceType: 'nimble_piece', pieceName: 'gmail' }, entry)).toBe(false);
	});

	const ceiling = ['create_issue', 'find_issue', 'find_user'];
	const live = ['create_issue', 'find_issue', 'find_user', 'delete_branch'];

	it('absent allowedTools inherits the ceiling intersected with live tools', () => {
		const { enabled, count } = effectiveAgentTools({ sourceType: 'nimble_piece' }, ceiling, live);
		expect([...enabled].sort()).toEqual([...ceiling].sort());
		expect(count).toBe(3);
		// delete_branch is live but outside the ceiling -> excluded
		expect(enabled.has('delete_branch')).toBe(false);
	});

	it('present allowedTools narrows within the ceiling (outside-ceiling requests dropped)', () => {
		const server: McpServerProfileConfig = {
			sourceType: 'nimble_piece',
			allowedTools: ['create_issue', 'delete_branch']
		};
		const { enabled, count } = effectiveAgentTools(server, ceiling, live);
		expect([...enabled]).toEqual(['create_issue']);
		expect(count).toBe(1);
	});

	it('empty allowedTools means ALL DISABLED, not all enabled', () => {
		const { enabled, count } = effectiveAgentTools(
			{ sourceType: 'nimble_piece', allowedTools: [] },
			ceiling,
			live
		);
		expect(count).toBe(0);
		expect(enabled.size).toBe(0);
	});

	it('null ceiling allows all live tools when not narrowed', () => {
		const { count } = effectiveAgentTools({ sourceType: 'nimble_piece' }, null, live);
		expect(count).toBe(4);
	});

	it('materializeAllowedTools de-dupes + sorts a stable array', () => {
		expect(materializeAllowedTools(['b', 'a', 'b'])).toEqual(['a', 'b']);
		expect(materializeAllowedTools(new Set(['x']))).toEqual(['x']);
	});

	it('estimateToolTokens scales by the per-tool heuristic', () => {
		expect(estimateToolTokens(0)).toBe(0);
		expect(estimateToolTokens(10)).toBe(10 * TOOL_TOKEN_ESTIMATE);
	});
});
