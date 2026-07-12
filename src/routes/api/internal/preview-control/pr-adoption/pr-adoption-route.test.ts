import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryableDevPreviewActivationError } from '$lib/server/application/ports/dev-preview-provisioner';

const mocks = vi.hoisted(() => {
	const identity = {
		previewName: 'pr-42',
		environmentRequestId: 'request-42',
		environmentPlatformRevision: 'b'.repeat(40),
		environmentSourceRevision: 'c'.repeat(40),
		catalogDigest: `sha256:${'a'.repeat(64)}`,
	};
	return {
		identity,
		adopt: vi.fn(),
		requireCapability: vi.fn(),
	};
});

vi.mock('$env/dynamic/private', () => ({
	env: {
		PREVIEW_ENVIRONMENT_SERVICES_JSON: JSON.stringify(['workflow-builder']),
		PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN: 'f'.repeat(64),
	},
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		previewLocalControlIdentity: { current: () => mocks.identity },
		previewPrAdoption: { adopt: mocks.adopt },
	}),
}));
vi.mock('$lib/server/internal-auth', () => ({
	requirePreviewControlCapability: mocks.requireCapability,
}));

import { POST } from './+server';

const requestBody = {
	name: mocks.identity.previewName,
	requestId: mocks.identity.environmentRequestId,
	platformRevision: mocks.identity.environmentPlatformRevision,
	sourceRevision: mocks.identity.environmentSourceRevision,
	catalogDigest: mocks.identity.catalogDigest,
	services: ['workflow-builder'],
	origin: 'https://wfb-pr-42.tail286401.ts.net',
	waitReadySeconds: 300,
};

function routeRequest(body = requestBody): { request: Request } {
	return {
		request: new Request(
			'http://preview-bff/api/internal/preview-control/pr-adoption',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			},
		),
	};
}

describe('preview-control PR adoption route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('keeps adoption behind the application service and preserves activation status', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '+server.ts'),
			'utf8',
		);

		expect(source).toContain('previewPrAdoption.adopt');
		expect(source).toContain(
			'status: !result.ok ? 409 : result.complete ? 200 : 202',
		);
		expect(source).toContain('RetryableDevPreviewActivationError');
		expect(source).not.toContain('$lib/server/workflows/dev-preview');
	});

	it('maps only retryable activation uncertainty to a non-terminal 503 receipt', async () => {
		mocks.adopt.mockRejectedValueOnce(
			new RetryableDevPreviewActivationError(
				'batch activation response was not observed',
			),
		);

		const response = (await POST(routeRequest() as never)) as Response;

		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toEqual({
			retryable: true,
			complete: false,
			pending: true,
			error: 'batch activation response was not observed',
		});
		expect(body).not.toHaveProperty('ok');
		expect(body).not.toHaveProperty('activationPhase');
	});
});
