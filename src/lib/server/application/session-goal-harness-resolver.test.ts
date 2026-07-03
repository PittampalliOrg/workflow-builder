import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeSessionGoalHarnessResolver } from '$lib/server/application/adapters/sessions';
import type {
	SessionRuntimeDebugTarget,
	WorkflowDataService,
} from '$lib/server/application/ports';

describe('RuntimeSessionGoalHarnessResolver', () => {
	it('uses workflow-data runtime target lookup for native harness capability', async () => {
		const workflowData = fakeWorkflowData(runtimeTarget({ agentRuntime: 'codex-cli' }));
		const resolver = new RuntimeSessionGoalHarnessResolver(() => workflowData);

		await expect(resolver.sessionHasNativeGoalHarness('session-1')).resolves.toBe(
			true,
		);
		expect(workflowData.getSessionRuntimeDebugTarget).toHaveBeenCalledWith({
			sessionId: 'session-1',
		});
	});

	it.each([
		['claude-code-cli', true],
		['codex-cli', true],
		['agy-cli', false],
		['dapr-agent-py', false],
		[null, false],
	])('maps runtime %s to native harness availability %s', async (agentRuntime, expected) => {
		const workflowData = fakeWorkflowData(runtimeTarget({ agentRuntime }));
		const resolver = new RuntimeSessionGoalHarnessResolver(() => workflowData);

		await expect(resolver.sessionHasNativeGoalHarness('session-1')).resolves.toBe(
			expected,
		);
	});

	it('returns false when workflow-data cannot resolve the session target', async () => {
		const workflowData = fakeWorkflowData(null);
		const resolver = new RuntimeSessionGoalHarnessResolver(() => workflowData);

		await expect(resolver.sessionHasNativeGoalHarness('missing')).resolves.toBe(
			false,
		);
	});

	it('keeps the resolver body off the legacy DB-backed runtime-target helper', () => {
		const source = readFileSync(
			new URL('./adapters/sessions.ts', import.meta.url),
			'utf8',
		);
		const resolverSource = source.slice(
			source.indexOf('export class RuntimeSessionGoalHarnessResolver'),
			source.indexOf('export class LifecycleSessionGoalScopeGuard'),
		);

		expect(resolverSource).toContain('getSessionRuntimeDebugTarget');
		expect(resolverSource).not.toContain(['sessions', 'runtime-target'].join('/'));
		expect(resolverSource).not.toContain(['$lib', 'server', 'db'].join('/'));
		expect(resolverSource).not.toContain(['drizzle', 'orm'].join('-'));
	});
});

function fakeWorkflowData(target: SessionRuntimeDebugTarget | null) {
	return {
		getSessionRuntimeDebugTarget: vi.fn(async () => target),
	} satisfies Pick<WorkflowDataService, 'getSessionRuntimeDebugTarget'>;
}

function runtimeTarget(
	overrides: Partial<SessionRuntimeDebugTarget> = {},
): SessionRuntimeDebugTarget {
	return {
		appId: 'agent-runtime-session-1',
		invokeTarget: 'agent-runtime-session-1',
		runtimeSandboxName: 'sandbox-session-1',
		source: 'agent',
		agentSlug: 'agent-1',
		agentRuntime: 'codex-cli',
		...overrides,
	};
}
