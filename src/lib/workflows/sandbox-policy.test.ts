import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NEW_AGENT_SANDBOX_POLICY,
	compileSandboxPolicies,
	withDocumentSandboxPolicy
} from './sandbox-policy';

function agentTask(name: string, withBlock: Record<string, unknown> = {}) {
	return {
		[name]: {
			call: 'durable/run',
			with: {
				prompt: `Run ${name}`,
				mode: 'execute_direct',
				agentRuntime: 'dapr-agent-py',
				...withBlock
			}
		}
	};
}

function taskDef(entry: Record<string, Record<string, unknown>>) {
	const name = Object.keys(entry)[0];
	return entry[name];
}

describe('compileSandboxPolicies', () => {
	it('keeps legacy shared-runtime workflows unchanged when no policy is present', () => {
		const spec = {
			document: { dsl: '1.0.0', namespace: 'workflow-builder', name: 'legacy', version: '1.0.0' },
			do: [agentTask('run_agent')]
		};

		expect(compileSandboxPolicies(spec)).toEqual(spec);
	});

	it('adds one workspace/profile for per-run workflows and wires all durable runs to it', () => {
		const spec = withDocumentSandboxPolicy(
			{
				document: { dsl: '1.0.0', namespace: 'workflow-builder', name: 'per-run', version: '1.0.0' },
				do: [agentTask('plan'), agentTask('execute')]
			},
			DEFAULT_NEW_AGENT_SANDBOX_POLICY
		);

		const compiled = compileSandboxPolicies(spec);
		const doArray = compiled.do as Array<Record<string, Record<string, unknown>>>;

		expect(Object.keys(doArray[0])[0]).toBe('workspace_profile');
		expect(taskDef(doArray[0]).call).toBe('workspace/profile');
		expect((taskDef(doArray[1]).with as Record<string, unknown>).workspaceRef).toBe(
			'${ .workspace_profile.workspaceRef }'
		);
		expect((taskDef(doArray[2]).with as Record<string, unknown>).workspaceRef).toBe(
			'${ .workspace_profile.workspaceRef }'
		);
	});

	it('creates separate workspaces for per-node agent tasks', () => {
		const policy = { ...DEFAULT_NEW_AGENT_SANDBOX_POLICY, mode: 'per-node' as const };
		const spec = {
			document: { dsl: '1.0.0', namespace: 'workflow-builder', name: 'per-node', version: '1.0.0' },
			do: [
				agentTask('first', { sandboxPolicy: policy }),
				agentTask('second', { sandboxPolicy: policy })
			]
		};

		const compiled = compileSandboxPolicies(spec);
		const doArray = compiled.do as Array<Record<string, Record<string, unknown>>>;

		expect(doArray).toHaveLength(4);
		expect(Object.keys(doArray[0])[0]).toBe('first_workspace');
		expect(Object.keys(doArray[2])[0]).toBe('second_workspace');
		expect((taskDef(doArray[1]).with as Record<string, unknown>).workspaceRef).toBe(
			'${ .first_workspace.workspaceRef }'
		);
		expect((taskDef(doArray[3]).with as Record<string, unknown>).workspaceRef).toBe(
			'${ .second_workspace.workspaceRef }'
		);
	});

	it('uses provided workspaceRef without inserting a workspace/profile task', () => {
		const policy = {
			mode: 'provided' as const,
			template: 'dapr-agent',
			keepAfterRun: false,
			workspaceRef: 'ws_existing'
		};
		const spec = {
			document: { dsl: '1.0.0', namespace: 'workflow-builder', name: 'provided', version: '1.0.0' },
			do: [agentTask('run_agent', { sandboxPolicy: policy })]
		};

		const compiled = compileSandboxPolicies(spec);
		const doArray = compiled.do as Array<Record<string, Record<string, unknown>>>;

		expect(doArray).toHaveLength(1);
		expect((taskDef(doArray[0]).with as Record<string, unknown>).workspaceRef).toBe('ws_existing');
	});

	it('preserves keep-after-run and ttl on managed workspace profiles', () => {
		const policy = {
			...DEFAULT_NEW_AGENT_SANDBOX_POLICY,
			keepAfterRun: true,
			ttlSeconds: 3600
		};
		const spec = withDocumentSandboxPolicy(
			{
				document: { dsl: '1.0.0', namespace: 'workflow-builder', name: 'keep', version: '1.0.0' },
				do: [agentTask('run_agent')]
			},
			policy
		);

		const compiled = compileSandboxPolicies(spec);
		const doArray = compiled.do as Array<Record<string, Record<string, unknown>>>;
		const workspaceWith = taskDef(doArray[0]).with as Record<string, unknown>;

		expect(workspaceWith.keepAfterRun).toBe(true);
		expect(workspaceWith.ttlSeconds).toBe(3600);
	});
});
