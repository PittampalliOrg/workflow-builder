import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewEnvironmentDesiredStateOwnershipError } from '$lib/server/application/ports';

const mocks = vi.hoisted(() => ({
	requirePreviewControlBroker: vi.fn(),
	teardown: vi.fn(async (input: { guard: unknown }) => ({
		preview: {
			name: 'feature-one',
			phase: 'terminating',
			sourceRevision: null,
			provenance: null
		},
		receipt: {
			name: 'feature-one',
			guard: input.guard,
			desiredStateAbsent: true
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
		previewEnvironmentLifecycleBroker: { teardown: mocks.teardown }
	})
}));

import { POST } from './+server';

function event(body: unknown) {
	return {
		params: { name: 'feature-one' },
		request: new Request('http://broker/feature-one/teardown', {
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
