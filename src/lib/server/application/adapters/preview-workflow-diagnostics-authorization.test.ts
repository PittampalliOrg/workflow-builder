import { describe, expect, it } from 'vitest';
import type { PreviewWorkflowDiagnosticsAuthorizationInput } from '$lib/server/application/ports';
import { HmacPreviewWorkflowDiagnosticsAuthorizationAdapter } from './preview-workflow-diagnostics-authorization';

const key = 'd'.repeat(64);
const now = new Date('2026-07-19T12:00:00.000Z');
const input: PreviewWorkflowDiagnosticsAuthorizationInput = {
	identity: {
		previewName: 'feature-one',
		environmentRequestId: 'request-1',
		environmentPlatformRevision: 'a'.repeat(40),
		environmentSourceRevision: 'b'.repeat(40),
		catalogDigest: `sha256:${'c'.repeat(64)}`
	},
	execution: {
		id: 'execution-1',
		userId: 'user-1',
		projectId: 'project-1',
		startedAt: new Date('2026-07-19T11:59:00.000Z'),
		completedAt: new Date('2026-07-19T12:00:00.000Z'),
		primaryTraceId: 'a'.repeat(32),
		workflowSessionId: 'session-1'
	},
	operation: 'search-spans'
};

describe('preview workflow diagnostics authorization adapter', () => {
	it('binds a short-lived proof to tuple, workspace, execution, and operation', () => {
		const adapter = new HmacPreviewWorkflowDiagnosticsAuthorizationAdapter({
			signingKey: () => key,
			verificationKey: () => key,
			now: () => now
		});
		const token = adapter.issue(input);

		expect(adapter.verify(token, input)).toBe(true);
		expect(
			adapter.verify(token, {
				...input,
				execution: { ...input.execution, id: 'execution-2' }
			})
		).toBe(false);
		expect(adapter.verify(token, { ...input, operation: 'search-logs' })).toBe(false);
		expect(
			adapter.verify(token, {
				...input,
				identity: { ...input.identity, environmentRequestId: 'request-2' }
			})
		).toBe(false);
	});

	it('rejects expired and malformed proofs without throwing', () => {
		let clock = now;
		const adapter = new HmacPreviewWorkflowDiagnosticsAuthorizationAdapter({
			signingKey: () => key,
			verificationKey: () => key,
			now: () => clock,
			ttlMs: 5_000
		});
		const token = adapter.issue(input);
		clock = new Date(now.getTime() + 5_001);

		expect(adapter.verify(token, input)).toBe(false);
		expect(adapter.verify('not-a-proof', input)).toBe(false);
	});
});
