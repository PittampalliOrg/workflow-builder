import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewEnvironmentDesiredStateOwnershipError } from '$lib/server/application/ports';

const ticket = {
	name: 'feature-one',
	environmentUid: 'uid-1',
	requestId: 'request-1',
	sourceRevision: 'b'.repeat(40),
	signature: 'e'.repeat(64)
};

const cleanup = {
	name: 'feature-one',
	resourceName: 'feature-one',
	complete: false,
	phase: 'pending',
	checks: {},
	message: null
};

const mocks = vi.hoisted(() => ({
	requirePreviewControlBroker: vi.fn(),
	status: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({
	env: { PREVIEW_CONTROL_BROKER_MODE: 'true' }
}));
vi.mock('$lib/server/internal-auth', () => ({
	requirePreviewControlBroker: mocks.requirePreviewControlBroker
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		previewEnvironmentLifecycleBroker: { status: mocks.status }
	})
}));

import { POST } from './+server';

function event(body: unknown) {
	const url = new URL('http://broker/feature-one/teardown/status');
	return {
		params: { name: 'feature-one' },
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}

describe('physical PreviewEnvironment teardown status route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.status.mockResolvedValue({ cleanup, receipt: { ticket } });
	});

	it('returns ticket-bound retryable progress through the lifecycle broker', async () => {
		const response = (await POST(event({ ticket }) as never)) as Response;

		expect(response.status).toBe(202);
		expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
		expect(mocks.status).toHaveBeenCalledWith(ticket);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			cleanup,
			receipt: { ticket }
		});
	});

	it.each([
		[{}, 'invalid teardown status query'],
		[{ ticket: { ...ticket, name: 'another-preview' } }, 'invalid teardown ticket'],
		[{ ticket: { ...ticket, signature: 'not-a-signature' } }, 'invalid teardown ticket']
	])('rejects malformed status input (%s)', async (body, message) => {
		const response = (await POST(event(body) as never)) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: message });
		expect(mocks.status).not.toHaveBeenCalled();
	});

	it('maps ticket ownership failure to conflict', async () => {
		mocks.status.mockRejectedValueOnce(
			new PreviewEnvironmentDesiredStateOwnershipError('invalid ticket')
		);

		const response = (await POST(event({ ticket }) as never)) as Response;
		expect(response.status).toBe(409);
	});
});
