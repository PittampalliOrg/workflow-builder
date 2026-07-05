import { describe, expect, it } from 'vitest';
import { teardownConfirmMessage } from './vcluster-preview-teardown-confirm';

describe('teardownConfirmMessage (#29)', () => {
	it('plain preview: name + permanence, no pool/origin noise', () => {
		const msg = teardownConfirmMessage({ name: 'feat-x' });
		expect(msg).toContain('Tear down preview "feat-x"?');
		expect(msg).toContain('permanently deletes the vcluster');
		expect(msg).not.toContain('warm-pool');
		expect(msg).not.toContain('Origin:');
	});

	it('claimed pool member: surfaces alias + backing member (the pool-1251 incident gap)', () => {
		const msg = teardownConfirmMessage({ name: 'my-feature', pool: 'pool-9', origin: 'user' });
		expect(msg).toContain('Tear down preview "my-feature"?');
		expect(msg).toContain('alias "my-feature" is backed by pool member pool-9');
		expect(msg).toContain('torn down and recycled');
		expect(msg).toContain('Origin: user.');
	});

	it('PR-origin preview: warns that PR close is the normal teardown path', () => {
		const msg = teardownConfirmMessage({ name: 'pr-416', pool: 'pool-1668', origin: 'pr' });
		expect(msg).toContain('backed by pool member pool-1668');
		expect(msg).toContain('torn down automatically when its pull request closes');
	});

	it('null pool/origin behave as absent', () => {
		const msg = teardownConfirmMessage({ name: 'gan-a', pool: null, origin: null });
		expect(msg).toContain('permanently deletes');
		expect(msg).not.toContain('Origin:');
	});
});
