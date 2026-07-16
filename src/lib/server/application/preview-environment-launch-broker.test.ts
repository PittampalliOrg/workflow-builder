import { describe, expect, it, vi } from 'vitest';
import { HttpPreviewEnvironmentLaunchBrokerAdapter } from '$lib/server/application/adapters/preview-environments';
import {
	ApplicationPreviewEnvironmentLaunchBrokerService,
	PreviewEnvironmentLaunchAuthorizationError
} from '$lib/server/application/preview-environment-launch-broker';
import type {
	ImmutableGitSha,
	PreviewEnvironmentLaunchOutcome
} from '$lib/server/application/ports';

const PLATFORM = 'a'.repeat(40) as ImmutableGitSha;
const SOURCE = 'b'.repeat(40) as ImmutableGitSha;
const CATALOG = `sha256:${'c'.repeat(64)}` as const;
const REQUESTED_AT = '2026-07-09T20:00:00.000Z';
const EXPIRES_AT = '2026-07-10T20:00:00.000Z';

const input = {
	name: 'feature-one',
	userId: 'admin-1',
	profile: 'app-live' as const,
	services: ['workflow-builder'],
	platformRevision: PLATFORM,
	sourceRevision: SOURCE,
	ttlHours: 24,
	lifecycle: 'retained' as const,
	allocation: { kind: 'cold' as const }
};

const outcome = {
	ok: true as const,
	environment: {
		name: 'feature-one',
		profile: 'app-live' as const,
		lane: 'application' as const,
		capabilities: ['service-live-sync' as const],
		placement: 'dev-vcluster' as const,
		platformRevision: PLATFORM,
		sourceRevision: SOURCE,
		catalogDigest: CATALOG,
		services: ['workflow-builder'],
		candidatePaths: [],
		owner: { kind: 'user' as const, id: 'admin-1' },
		origin: { kind: 'user' as const },
		ttlHours: 24,
		mode: 'live' as const,
		imageOverrides: {},
		lifecycle: 'retained' as const,
		allocation: { kind: 'cold' as const },
		provenance: {
			requestId: 'request-1',
			requestedAt: REQUESTED_AT,
			platformRepository: 'PittampalliOrg/stacks',
			sourceRepository: 'PittampalliOrg/workflow-builder'
		},
		id: 'feature-one',
		lifecycleState: 'provisioning' as const,
		createdAt: REQUESTED_AT,
		expiresAt: EXPIRES_AT,
		runtime: {
			placement: 'dev-vcluster' as const,
			phase: 'provisioning',
			ready: false,
			url: null,
			allocationId: null,
			pooled: false
		}
	}
} satisfies Extract<PreviewEnvironmentLaunchOutcome, { ok: true }>;

const catalog = {
	currentDigest: () => CATALOG,
	listPreviewNativeServices: () => ['workflow-builder', 'workflow-orchestrator'],
	assertPreviewNativeServices: (services: readonly string[]) => services
};

describe('physical preview environment launch broker', () => {
	it('rechecks platform admin and forces the cold application lane', async () => {
		const environments = {
			previewNativeServices: () => ['workflow-builder'],
			launchForUser: vi.fn(async () => outcome)
		};
		const service = new ApplicationPreviewEnvironmentLaunchBrokerService({
			admins: { isPlatformAdmin: vi.fn(async () => true) },
			environments
		});
		expect('launch' in service).toBe(false);
		await service.launchForUser(input);
		expect(environments.launchForUser).toHaveBeenCalledWith({
			...input,
			profile: 'app-live',
			lane: 'application',
			allocation: { kind: 'cold' },
			candidatePaths: []
		});
	});

	it('rejects non-admin and infrastructure-shaped requests before launch', async () => {
		const environments = {
			previewNativeServices: () => ['workflow-builder'],
			launchForUser: vi.fn()
		};
		const denied = new ApplicationPreviewEnvironmentLaunchBrokerService({
			admins: { isPlatformAdmin: vi.fn(async () => false) },
			environments
		});
		await expect(denied.launchForUser(input)).rejects.toBeInstanceOf(
			PreviewEnvironmentLaunchAuthorizationError
		);
		const allowed = new ApplicationPreviewEnvironmentLaunchBrokerService({
			admins: { isPlatformAdmin: vi.fn(async () => true) },
			environments
		});
		await expect(
			allowed.launchForUser({
				...input,
				profile: 'manifest-candidate',
				candidatePaths: ['packages/base']
			})
		).rejects.toBeInstanceOf(PreviewEnvironmentLaunchAuthorizationError);
		await expect(
			allowed.launchForUser({ ...input, profile: 'host-candidate' })
		).rejects.toBeInstanceOf(PreviewEnvironmentLaunchAuthorizationError);
		expect(environments.launchForUser).not.toHaveBeenCalled();
	});
});

describe('normal BFF preview launch adapter', () => {
	it('sends only authenticated intent and validates the physical proof', async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify(outcome), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000/',
			token: () => 'broker-token',
			fetch: fetchImpl as typeof fetch
		});
		expect('launch' in adapter).toBe(false);
		await expect(adapter.launchForUser(input)).resolves.toEqual(outcome);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe('http://preview-control-broker:3000/api/internal/preview-control/environment');
		expect(new Headers(init?.headers).get('x-preview-control-broker-token')).toBe('broker-token');
		expect(JSON.parse(String(init?.body))).toEqual(input);
	});

	it('validates a workflow-origin proof against the trusted execution context', async () => {
		const workflowInput = {
			...input,
			workflowExecutionId: 'parent-execution-1',
			provenance: { parentEnvironmentId: 'workflow-binding-1' },
		};
		const workflowOutcome = {
			...outcome,
			environment: {
				...outcome.environment,
				origin: { kind: 'workflow' as const, reference: 'parent-execution-1' },
				provenance: {
					...outcome.environment.provenance,
					parentEnvironmentId: 'workflow-binding-1',
				},
			},
		};
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify(workflowOutcome), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			) as typeof fetch,
		});

		await expect(adapter.launchForUser(workflowInput)).resolves.toEqual(workflowOutcome);
	});

	it('rejects a forged owner in an otherwise valid broker response', async () => {
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							...outcome,
							environment: {
								...outcome.environment,
								owner: { kind: 'user', id: 'attacker' }
							}
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			) as typeof fetch
		});
		await expect(adapter.launchForUser(input)).rejects.toThrow('does not match the request');
	});

	it('requires the full preview-native baseline when services are omitted', async () => {
		const fullOutcome = {
			...outcome,
			environment: {
				...outcome.environment,
				services: ['workflow-builder', 'workflow-orchestrator']
			}
		};
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify(fullOutcome), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			) as typeof fetch
		});

		await expect(
			adapter.launchForUser({
				...input,
				services: undefined
			})
		).resolves.toMatchObject({
			ok: true,
			environment: {
				services: ['workflow-builder', 'workflow-orchestrator']
			}
		});
	});

	it.each([
		['catalogDigest', `sha256:${'d'.repeat(64)}`],
		['platformRevision', 'd'.repeat(40)],
		['sourceRevision', 'e'.repeat(40)],
		['placement', 'dev-physical']
	])('rejects a broker proof with changed %s', async (field, value) => {
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							...outcome,
							environment: { ...outcome.environment, [field]: value }
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			) as typeof fetch
		});
		await expect(adapter.launchForUser(input)).rejects.toThrow('does not match the request');
	});

	it("preserves the physical broker's authoritative reconciliation expiry", async () => {
		const authoritativeExpiry = '2026-07-10T20:02:30.000Z';
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							...outcome,
							environment: {
								...outcome.environment,
								expiresAt: authoritativeExpiry
							}
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			) as typeof fetch
		});
		await expect(adapter.launchForUser(input)).resolves.toMatchObject({
			ok: true,
			environment: { expiresAt: authoritativeExpiry }
		});
	});

	it('rejects a physical expiry that is not after creation', async () => {
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							...outcome,
							environment: { ...outcome.environment, expiresAt: REQUESTED_AT }
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } }
					)
			) as typeof fetch
		});
		await expect(adapter.launchForUser(input)).rejects.toThrow('does not match the request');
	});

	it('does not send infrastructure candidates to the generic launch route', async () => {
		const fetchImpl = vi.fn();
		const adapter = new HttpPreviewEnvironmentLaunchBrokerAdapter({
			catalog,
			baseUrl: () => 'http://preview-control-broker:3000',
			token: () => 'broker-token',
			fetch: fetchImpl as typeof fetch
		});
		await expect(
			adapter.launchForUser({
				...input,
				profile: 'manifest-candidate',
				capabilities: ['namespaced-manifests'],
				services: [],
				candidatePaths: ['packages/components/workloads/example']
			})
		).rejects.toThrow('GitHub-verified broker');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
