import { describe, expect, it } from 'vitest';
import {
	acceptsDevSyncToken,
	deriveDevSyncAgentActionToken,
	deriveDevSyncReceiverToken,
	hashDevSyncToken
} from '$lib/server/dev-sync/capability';

const ROOT = '1'.repeat(64);

describe('dev-sync scoped capabilities', () => {
	it('separates receiver and agent action authority by purpose', () => {
		const receiver = deriveDevSyncReceiverToken(ROOT, 'execution-1', 'workflow-builder');
		const agent = deriveDevSyncAgentActionToken(ROOT, 'execution-1', 'workflow-builder');
		expect(receiver).toMatch(/^[a-f0-9]{64}$/);
		expect(agent).toMatch(/^[a-f0-9]{64}$/);
		expect(receiver).not.toBe(agent);
		expect(acceptsDevSyncToken(receiver, receiver, hashDevSyncToken(agent))).toBe(true);
		expect(acceptsDevSyncToken(agent, receiver, hashDevSyncToken(agent))).toBe(true);
	});

	it('denies leaves from another execution or service', () => {
		const receiver = deriveDevSyncReceiverToken(ROOT, 'execution-1', 'workflow-builder');
		const agent = deriveDevSyncAgentActionToken(ROOT, 'execution-1', 'workflow-builder');
		const agentHash = hashDevSyncToken(agent);
		for (const foreign of [
			deriveDevSyncReceiverToken(ROOT, 'execution-2', 'workflow-builder'),
			deriveDevSyncReceiverToken(ROOT, 'execution-1', 'function-router'),
			deriveDevSyncAgentActionToken(ROOT, 'execution-2', 'workflow-builder'),
			deriveDevSyncAgentActionToken(ROOT, 'execution-1', 'function-router'),
			ROOT
		]) {
			expect(acceptsDevSyncToken(foreign, receiver, agentHash)).toBe(false);
		}
	});

	it('rejects ambiguous or invalid coordinates', () => {
		expect(() => deriveDevSyncReceiverToken(ROOT, '', 'workflow-builder')).toThrow('execution id');
		expect(() => deriveDevSyncReceiverToken(ROOT, 'execution-1', '../other')).toThrow('service');
	});

	it('rejects a malformed host derivation root', () => {
		expect(() =>
			deriveDevSyncReceiverToken('short-root', 'execution-1', 'workflow-builder')
		).toThrow('WFB_DEV_SYNC_TOKEN is invalid');
	});
});
