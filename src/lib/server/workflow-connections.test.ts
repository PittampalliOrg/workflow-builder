import { describe, expect, it } from 'vitest';
import { collectWorkflowConnectionRefs } from './workflow-connections';

describe('collectWorkflowConnectionRefs', () => {
	it('extracts MCP server connection refs from SW spec agent config', () => {
		const refs = collectWorkflowConnectionRefs(
			'wf-1',
			[],
			{
				do: [
					{
						run_agent: {
							call: 'durable/run',
							with: {
								agentConfig: {
									mcpServers: [
										{
											sourceType: 'nimble_piece',
											pieceName: 'github',
											connectionExternalId: 'conn_github'
										}
									]
								}
							}
						}
					}
				]
			}
		);

		expect(refs).toEqual([
			{
				workflowId: 'wf-1',
				nodeId: 'run_agent',
				connectionExternalId: 'conn_github',
				pieceName: 'github'
			}
		]);
	});

	it('extracts direct action connection refs from SW spec call tasks', () => {
		const refs = collectWorkflowConnectionRefs(
			'wf-1',
			[],
			{
				do: [
					{
						list_repos: {
							call: 'github/list_repos',
							with: {
								connectionExternalId: 'conn_github'
							}
						}
					}
				]
			}
		);

		expect(refs).toEqual([
			{
				workflowId: 'wf-1',
				nodeId: 'list_repos',
				connectionExternalId: 'conn_github',
				pieceName: 'github'
			}
		]);
	});
});
