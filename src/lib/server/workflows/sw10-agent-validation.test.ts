import { describe, expect, it } from 'vitest';
import { getRemovedSw10AgentCallsError } from './sw10-agent-validation';

describe('getRemovedSw10AgentCallsError', () => {
	it('allows the browser MCP testing durable agent runtime', () => {
		const error = getRemovedSw10AgentCallsError({
			do: [
				{
					run_browser_test_agent: {
						call: 'durable/run',
						with: {
							agentRuntime: 'dapr-agent-py-testing',
							workspaceRef: '${ .workspaceProfile.workspaceRef }'
						}
					}
				}
			]
		});

		expect(error).toBeNull();
	});
});
