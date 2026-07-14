import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewEnvironmentDesiredStateOwnershipError } from '$lib/server/application/ports';

const mocks = vi.hoisted(() => ({
	requirePreviewControlBroker: vi.fn(),
	teardown: vi.fn(async (input: { guard: unknown }) => ({
		preview: {
			name: 'feature-one',
			phase: 'absent',
			sourceRevision: null,
			provenance: null
		},
		receipt: {
			name: 'feature-one',
			guard: input.guard,
			desiredStateAbsent: true
		}
	})),
	requestTeardown: vi.fn(async (input: { guard: unknown }) => ({
		preview: {
			name: 'feature-one',
			phase: 'terminating',
			sourceRevision: null,
			provenance: null
		},
		ticket: {
			name: 'feature-one',
			environmentUid: 'uid-1',
			requestId: 'request-1',
			sourceRevision: 'b'.repeat(40),
			signature: 'e'.repeat(64)
		},
		receipt: {
			name: 'feature-one',
			guard: input.guard,
			ticket: {
				name: 'feature-one',
				environmentUid: 'uid-1',
				requestId: 'request-1',
				sourceRevision: 'b'.repeat(40),
				signature: 'e'.repeat(64)
			},
			desiredStateDeletionAccepted: true
		}
	}))
}));

vi.mock('$env/dynamic/private', () => ({
	env: { PREVIEW_CONTROL_BROKER_MODE: 'true' }
}));
vi.mock('$lib/server/internal-auth', () => ({
	requirePreviewControlBroker: mocks.requirePreviewControlBroker
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		previewEnvironmentLifecycleBroker: {
			teardown: mocks.teardown,
			requestTeardown: mocks.requestTeardown
		}
	})
}));

import { POST } from './+server';


function event(body: unknown, query = '') {
	const url = new URL(`http://broker/feature-one/teardown${query}`);
	return {
		params: { name: 'feature-one' },
		url,
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}

const guard = {
	mode: 'owned',
	requestId: 'request-1',
	sourceRevision: 'b'.repeat(40),
	archiveConfirmed: true
};

describe('physical PreviewEnvironment teardown route', () => {
	beforeEach(() => vi.clearAllMocks());

	it('requires broker auth and delegates only the exact ownership guard', async () => {
		const response = (await POST(event({ guard }) as never)) as Response;
		expect(response.status).toBe(200);
		expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
		expect(mocks.teardown).toHaveBeenCalledWith({
			name: 'feature-one',
			guard
		});
		expect(mocks.requestTeardown).not.toHaveBeenCalled();
	});

	it('preserves the bounded forced-quarantine disposition behind archive proof', async () => {
		const archiveQuarantine = {
			forcedAt: '2026-07-09T23:00:00.000Z',
			graceExpiredAt: '2026-07-09T22:00:00.000Z',
			reason: 'incomplete:active-generation-unverified',
			summaryFileId: 'quarantine-summary-1'
		};
		const response = (await POST(
			event({ guard: { ...guard, archiveQuarantine } }) as never
		)) as Response;
		expect(response.status).toBe(200);
		expect(mocks.teardown).toHaveBeenCalledWith({
			name: 'feature-one',
			guard: { ...guard, archiveQuarantine }
		});
	});

	it('returns 202 for the explicit request-only command', async () => {
		const response = (await POST(event({ guard }, '?wait=false') as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.clone().json()).resolves.toMatchObject({
			ticket: { environmentUid: 'uid-1', signature: 'e'.repeat(64) }
		});
		expect(mocks.requestTeardown).toHaveBeenCalledWith({
			name: 'feature-one',
			guard
		});
		expect(mocks.teardown).not.toHaveBeenCalled();
	});

	it('does not expose request-only deletion for a superseded guard', async () => {
		const response = (await POST(
			event(
				{ guard: { mode: 'superseded', protectedRequestId: 'protected-request' } },
				'?wait=false'
			) as never
		)) as Response;

		expect(response.status).toBe(400);
		expect(mocks.requestTeardown).not.toHaveBeenCalled();
		expect(mocks.teardown).not.toHaveBeenCalled();
	});

	it.each([
		[{}, 'invalid teardown command'],
		[{ guard: { ...guard, sourceRevision: 'main' } }, 'invalid teardown guard'],
		[
			{
				guard: {
					...guard,
					archiveConfirmed: undefined,
					archiveQuarantine: {
						forcedAt: '2026-07-09T23:00:00.000Z',
						graceExpiredAt: '2026-07-09T22:00:00.000Z',
						reason: 'forced'
					}
				}
			},
			'invalid teardown guard'
		],
		[
			{
				guard: {
					...guard,
					archiveQuarantine: {
						forcedAt: 'not-a-date',
						graceExpiredAt: '2026-07-09T22:00:00.000Z',
						reason: 'forced'
					}
				}
			},
			'invalid teardown guard'
		],
		[
			{
				guard: {
					...guard,
					archiveQuarantine: {
						forcedAt: '2026-07-09T21:59:59.999Z',
						graceExpiredAt: '2026-07-09T22:00:00.000Z',
						reason: 'forced-too-early'
					}
				}
			},
			'invalid teardown guard'
		],
		[{ guard, token: 'attacker' }, 'invalid teardown command']
	])('rejects malformed destructive commands', async (body, message) => {
		const response = (await POST(event(body) as never)) as Response;
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: message });
		expect(mocks.teardown).not.toHaveBeenCalled();
	});

	it('maps tuple ownership conflicts to 409', async () => {
		mocks.teardown.mockRejectedValueOnce(
			new PreviewEnvironmentDesiredStateOwnershipError('wrong generation')
		);
		const response = (await POST(event({ guard }) as never)) as Response;
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: 'wrong generation'
		});
	});
});
