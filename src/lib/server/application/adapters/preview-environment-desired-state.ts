import { env } from '$env/dynamic/private';
import { kubeApiFetchFromKubeconfig } from '$lib/server/kube/client';
import { validatePreviewEnvironmentLaunchSpec } from '$lib/server/application/preview-environments';
import {
	PreviewEnvironmentDesiredStateConflictError,
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError
} from '$lib/server/application/ports';
import type {
	PreviewEnvironmentCleanupProof,
	PreviewEnvironmentDesiredStateDeleteGuard,
	PreviewEnvironmentDesiredStatePort,
	PreviewEnvironmentDesiredStateSnapshot,
	PreviewEnvironmentVersionedServiceCatalogPort,
	ValidatedPreviewEnvironmentLaunchSpec,
	VclusterPreviewGatewayPort,
	VclusterPreviewLaunchInput
} from '$lib/server/application/ports';
import type { VclusterPreviewRecord } from '$lib/types/dev-previews';

export {
	PreviewEnvironmentDesiredStateConflictError,
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError
} from '$lib/server/application/ports';

const API_GROUP = 'preview.stacks.io';
const API_VERSION = 'v1alpha1';
const API_PLURAL = 'previewenvironments';
const CONTROL_NAMESPACE = 'preview-system';
const API_PATH = `/apis/${API_GROUP}/${API_VERSION}/namespaces/${CONTROL_NAMESPACE}/${API_PLURAL}`;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PHASES = new Set(['Failed', 'Blocked', 'Provisioning', 'Ready', 'Expired', 'Terminating']);
const CLEANUP_CHECK_NAMES = [
	'runnerSucceeded',
	'previewEnvironmentAbsent',
	'applicationAbsent',
	'agentRegistrationAbsent',
	'agentNamespacesAbsent',
	'databaseAbsent',
	'natsStreamAbsent',
	'headlampRegistrationAbsent',
	'tailnetEgressAbsent',
	'hostNamespaceAbsent',
	'storageScopeAbsent',
	'runnerIdentityAbsent'
] as const;

type KubeFetch = (path: string, init?: RequestInit & { retries?: number }) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export type KubernetesPreviewEnvironmentDesiredStateOptions = Readonly<{
	fetch: KubeFetch;
	sleep?: Sleep;
	pollMs?: number;
	now?: () => number;
}>;

type HubKubeconfigEnvironment = Readonly<Record<string, string | undefined>>;

/** Build the only allowed transport for hub PreviewEnvironment authority. */
export function previewEnvironmentHubKubeFetch(
	environment: HubKubeconfigEnvironment = {
		...process.env,
		PREVIEW_ENVIRONMENT_HUB_KUBECONFIG: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG,
		PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH,
		PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT,
		PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML,
		PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT: env.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT
	},
	remoteFetch: typeof kubeApiFetchFromKubeconfig = kubeApiFetchFromKubeconfig
): KubeFetch {
	const kubeconfigPath = (
		environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG ??
		environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_PATH ??
		''
	).trim();
	const kubeconfigContent = (
		environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTENT ??
		environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_YAML ??
		''
	).trim();
	const context = (environment.PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT ?? '').trim();
	if (!kubeconfigPath && !kubeconfigContent) {
		throw new PreviewEnvironmentDesiredStateError(
			'preview desired-state hub kubeconfig is not configured; set PREVIEW_ENVIRONMENT_HUB_KUBECONFIG'
		);
	}
	return (path, init = {}) =>
		remoteFetch(path, init, {
			...(kubeconfigPath ? { kubeconfigPath } : {}),
			...(kubeconfigContent ? { kubeconfigContent } : {}),
			...(context ? { context } : {})
		});
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const object = record(value);
	if (object) {
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function resourcePath(name: string): string {
	return `${API_PATH}/${encodeURIComponent(name)}`;
}

function expiresAt(input: ValidatedPreviewEnvironmentLaunchSpec): string {
	return new Date(
		Date.parse(input.provenance.requestedAt) + input.ttlHours * 60 * 60 * 1_000
	).toISOString();
}

export function buildPreviewEnvironmentDesiredStateManifest(
	input: ValidatedPreviewEnvironmentLaunchSpec
): Record<string, unknown> {
	const spec: Record<string, unknown> = {
		id: input.name,
		platformRevision: input.platformRevision,
		sourceRevision: input.sourceRevision,
		catalogDigest: input.catalogDigest,
		lane: input.lane,
		profile: input.profile,
		mode: input.mode,
		lifecycle: input.lifecycle,
		owner: input.owner,
		origin: input.origin,
		services: [...input.services],
		provenance: input.provenance,
		images: input.imageOverrides,
		allocation: input.allocation,
		trustedCode: true,
		ttlHours: input.ttlHours,
		expiresAt: expiresAt(input)
	};
	if (input.profile === 'manifest-candidate') {
		spec.candidatePaths = [...input.candidatePaths];
	}
	return {
		apiVersion: `${API_GROUP}/${API_VERSION}`,
		kind: 'PreviewEnvironment',
		metadata: {
			name: input.name,
			namespace: CONTROL_NAMESPACE,
			labels: {
				'preview.stacks.io/broker-managed': 'true'
			},
			annotations: {
				'preview.stacks.io/request-id': input.provenance.requestId,
				'preview.stacks.io/platform-revision': input.platformRevision,
				'preview.stacks.io/source-revision': input.sourceRevision,
				'preview.stacks.io/catalog-digest': input.catalogDigest
			}
		},
		spec
	};
}

async function responseObject(
	response: Response,
	operation: string
): Promise<Record<string, unknown>> {
	const body = (await response.json().catch(() => null)) as unknown;
	const value = record(body);
	if (!value) {
		throw new PreviewEnvironmentDesiredStateError(
			`${operation} returned a non-object Kubernetes response`
		);
	}
	return value;
}

async function responseFailure(
	response: Response,
	operation: string
): Promise<PreviewEnvironmentDesiredStateError> {
	const body = (await response.text().catch(() => '')).slice(0, 1_024);
	return new PreviewEnvironmentDesiredStateError(
		`${operation} failed (HTTP ${response.status})${body ? `: ${body}` : ''}`
	);
}

function metadata(resource: Record<string, unknown>) {
	const value = record(resource.metadata);
	if (!value) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment response has no metadata'
		);
	}
	return value;
}

function resourceSpec(resource: Record<string, unknown>) {
	const value = record(resource.spec);
	if (!value) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment response has no spec'
		);
	}
	return value;
}

function assertResourceEnvelope(
	resource: Record<string, unknown>,
	expectedName: string
): { uid: string; generation: number; spec: Record<string, unknown> } {
	const meta = metadata(resource);
	const spec = resourceSpec(resource);
	const uid = typeof meta.uid === 'string' ? meta.uid : '';
	const generation = meta.generation;
	if (
		resource.apiVersion !== `${API_GROUP}/${API_VERSION}` ||
		resource.kind !== 'PreviewEnvironment' ||
		meta.name !== expectedName ||
		meta.namespace !== CONTROL_NAMESPACE ||
		!uid ||
		!Number.isSafeInteger(generation) ||
		(generation as number) < 1 ||
		spec.id !== expectedName
	) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment response does not identify the requested resource'
		);
	}
	return { uid, generation: generation as number, spec };
}

function assertStatusProof(
	resource: Record<string, unknown>,
	spec: Record<string, unknown>,
	generation: number
): PreviewEnvironmentDesiredStateSnapshot['phase'] {
	const status = record(resource.status);
	if (!status || Object.keys(status).length === 0) return 'Pending';
	const phase = status.phase;
	if (typeof phase !== 'string' || !PHASES.has(phase)) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment status has an invalid phase'
		);
	}
	for (const field of ['platformRevision', 'sourceRevision', 'catalogDigest'] as const) {
		if (status[field] !== undefined && status[field] !== spec[field]) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				`PreviewEnvironment status.${field} does not match spec`
			);
		}
	}
	if (status.images !== undefined && canonical(status.images) !== canonical(spec.images)) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment status.images does not match spec'
		);
	}
	if (
		status.observedGeneration !== undefined &&
		(!Number.isSafeInteger(status.observedGeneration) ||
			(status.observedGeneration as number) < 1 ||
			(status.observedGeneration as number) > generation)
	) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment status has an invalid observedGeneration'
		);
	}
	if (phase === 'Ready') {
		const application = record(status.application);
		const expectedAgent = `preview-${String(spec.id)}`;
		if (
			status.observedGeneration !== generation ||
			status.platformRevision !== spec.platformRevision ||
			status.sourceRevision !== spec.sourceRevision ||
			status.catalogDigest !== spec.catalogDigest ||
			canonical(status.images) !== canonical(spec.images) ||
			application?.namespace !== expectedAgent ||
			application.name !== `${expectedAgent}-workflow-builder`
		) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'Ready PreviewEnvironment status is not bound to the current contract'
			);
		}
	}
	return phase as PreviewEnvironmentDesiredStateSnapshot['phase'];
}

function snapshot(
	resource: Record<string, unknown>,
	input: ValidatedPreviewEnvironmentLaunchSpec
): PreviewEnvironmentDesiredStateSnapshot {
	const envelope = assertResourceEnvelope(resource, input.name);
	const desiredSpec = record(buildPreviewEnvironmentDesiredStateManifest(input).spec)!;
	if (canonical(envelope.spec) !== canonical(desiredSpec)) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment spec does not exactly match the launch contract'
		);
	}
	const phase = assertStatusProof(resource, envelope.spec, envelope.generation);
	return {
		name: input.name,
		uid: envelope.uid,
		generation: envelope.generation,
		phase,
		ready: phase === 'Ready'
	};
}

function deletionIdentity(
	resource: Record<string, unknown>,
	expectedName: string,
	guard: PreviewEnvironmentDesiredStateDeleteGuard
) {
	const envelope = assertResourceEnvelope(resource, expectedName);
	const resourceVersion = metadata(resource).resourceVersion;
	const provenance = record(envelope.spec.provenance);
	const requestId = provenance?.requestId;
	const sourceRevision = envelope.spec.sourceRevision;
	if (
		typeof requestId !== 'string' ||
		!requestId ||
		typeof sourceRevision !== 'string' ||
		!FULL_SHA.test(sourceRevision) ||
		typeof envelope.spec.platformRevision !== 'string' ||
		!FULL_SHA.test(envelope.spec.platformRevision) ||
		typeof envelope.spec.catalogDigest !== 'string' ||
		!SHA256.test(envelope.spec.catalogDigest) ||
		typeof resourceVersion !== 'string' ||
		!resourceVersion
	) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment deletion identity is incomplete'
		);
	}
	assertStatusProof(resource, envelope.spec, envelope.generation);
	if (
		guard?.mode === 'owned' &&
		(guard.requestId !== requestId || guard.sourceRevision !== sourceRevision)
	) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment deletion guard does not own the current contract'
		);
	}
	if (guard?.mode === 'superseded' && guard.protectedRequestId === requestId) {
		throw new PreviewEnvironmentDesiredStateOwnershipError(
			'PreviewEnvironment deletion would remove the protected contract'
		);
	}
	return { ...envelope, requestId, sourceRevision, resourceVersion };
}

export class KubernetesPreviewEnvironmentDesiredStateAdapter implements PreviewEnvironmentDesiredStatePort {
	private readonly fetchImpl: KubeFetch;
	private readonly sleep: Sleep;
	private readonly pollMs: number;
	private readonly now: () => number;

	constructor(options: KubernetesPreviewEnvironmentDesiredStateOptions) {
		this.fetchImpl = options.fetch;
		this.sleep =
			options.sleep ??
			((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		this.pollMs = options.pollMs ?? 1_000;
		this.now = options.now ?? Date.now;
	}

	async create(
		input: ValidatedPreviewEnvironmentLaunchSpec
	): Promise<PreviewEnvironmentDesiredStateSnapshot> {
		const desired = buildPreviewEnvironmentDesiredStateManifest(input);
		let response: Response;
		try {
			response = await this.fetchImpl(API_PATH, {
				method: 'POST',
				body: JSON.stringify(desired),
				retries: 0
			});
		} catch (cause) {
			try {
				const observed = await this.inspect(input);
				if (observed) return observed;
			} catch (inspectionCause) {
				if (inspectionCause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
					throw inspectionCause;
				}
				throw new PreviewEnvironmentDesiredStateError(
					'PreviewEnvironment create failed and its durable result could not be inspected',
					{ cause: new AggregateError([cause, inspectionCause]) }
				);
			}
			throw new PreviewEnvironmentDesiredStateError(
				'PreviewEnvironment create failed before ownership could be proved',
				{ cause }
			);
		}
		if (response.status === 409) {
			try {
				const observed = await this.inspect(input);
				if (observed) return observed;
			} catch (cause) {
				if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
					throw new PreviewEnvironmentDesiredStateConflictError(input.name, {
						cause
					});
				}
				throw cause;
			}
			throw new PreviewEnvironmentDesiredStateConflictError(input.name);
		}
		if (!response.ok) throw await responseFailure(response, 'PreviewEnvironment create');
		const created = snapshot(await responseObject(response, 'PreviewEnvironment create'), input);
		const observed = await this.inspect(input);
		if (!observed || observed.uid !== created.uid) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'PreviewEnvironment create was not durably observable'
			);
		}
		return observed;
	}

	async inspect(
		input: ValidatedPreviewEnvironmentLaunchSpec
	): Promise<PreviewEnvironmentDesiredStateSnapshot | null> {
		const response = await this.fetchImpl(resourcePath(input.name), {
			retries: 0
		});
		if (response.status === 404) return null;
		if (!response.ok) throw await responseFailure(response, 'PreviewEnvironment read');
		return snapshot(await responseObject(response, 'PreviewEnvironment read'), input);
	}

	async deleteAndWait(
		input: Readonly<{
			name: string;
			guard: PreviewEnvironmentDesiredStateDeleteGuard;
			timeoutMs: number;
		}>
	): Promise<void> {
		if (!input.guard) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'PreviewEnvironment deletion requires an ownership guard'
			);
		}
		const initial = await this.readForDeletion(input.name);
		if (!initial) return;
		const identity = deletionIdentity(initial, input.name, input.guard);
		const response = await this.fetchImpl(resourcePath(input.name), {
			method: 'DELETE',
			body: JSON.stringify({
				apiVersion: 'v1',
				kind: 'DeleteOptions',
				propagationPolicy: 'Foreground',
				preconditions: {
					uid: identity.uid,
					resourceVersion: identity.resourceVersion
				}
			}),
			retries: 0
		});
		if (response.status !== 404 && !response.ok) {
			throw await responseFailure(response, 'PreviewEnvironment delete');
		}
		const deadline = this.now() + input.timeoutMs;
		while (this.now() <= deadline) {
			const current = await this.readForDeletion(input.name);
			if (!current) return;
			const observed = deletionIdentity(current, input.name, input.guard);
			if (observed.uid !== identity.uid) {
				throw new PreviewEnvironmentDesiredStateOwnershipError(
					'PreviewEnvironment was replaced while deletion was pending'
				);
			}
			await this.sleep(this.pollMs);
		}
		throw new PreviewEnvironmentDesiredStateError(
			`PreviewEnvironment ${input.name} finalizers did not converge`
		);
	}

	async absent(name: string): Promise<boolean> {
		return (await this.readForDeletion(name)) === null;
	}

	private async readForDeletion(name: string): Promise<Record<string, unknown> | null> {
		const response = await this.fetchImpl(resourcePath(name), { retries: 0 });
		if (response.status === 404) return null;
		if (!response.ok) throw await responseFailure(response, 'PreviewEnvironment read');
		return responseObject(response, 'PreviewEnvironment read');
	}
}

function commandFromGatewayInput(
	input: { name: string } & VclusterPreviewLaunchInput,
	catalog: PreviewEnvironmentVersionedServiceCatalogPort
): ValidatedPreviewEnvironmentLaunchSpec {
	const profile = input.profile ?? 'app-live';
	const mode = input.mode ?? (profile === 'manifest-candidate' ? 'reconciled' : 'live');
	const catalogDigest = catalog.currentDigest();
	if (
		input.ttlHours === undefined ||
		input.lifecycle === undefined ||
		input.allocation === undefined ||
		input.catalogDigest !== catalogDigest
	) {
		throw new PreviewEnvironmentDesiredStateError(
			'SEA provision input lacks the exact bounded desired-state contract'
		);
	}
	return validatePreviewEnvironmentLaunchSpec(
		{
			name: input.name,
			profile,
			lane: input.lane ?? 'application',
			capabilities: [
				profile === 'manifest-candidate'
					? 'namespaced-manifests'
					: mode === 'reconciled'
						? 'immutable-image-replay'
						: 'service-live-sync'
			],
			platformRevision: input.platformRevision ?? '',
			sourceRevision: input.sourceRevision ?? '',
			services: input.services ?? [],
			candidatePaths: input.candidatePaths ?? [],
			owner: input.owner ?? { kind: 'automation', id: 'missing-owner' },
			origin: input.origin ?? { kind: 'automation' },
			ttlHours: input.ttlHours,
			mode,
			imageOverrides: input.imageOverrides,
			lifecycle: input.lifecycle,
			allocation: input.allocation,
			provenance: input.provenance as never
		},
		catalogDigest
	);
}

export type DesiredStateVclusterPreviewGatewayOptions = Readonly<{
	gateway: VclusterPreviewGatewayPort;
	desiredState: PreviewEnvironmentDesiredStatePort;
	catalog: PreviewEnvironmentVersionedServiceCatalogPort;
	compensationTimeoutMs?: number;
}>;

/**
 * Transaction boundary between hub desired state and SEA execution.
 *
 * Ordering is intentional: create CR, then SEA up; delete/finalize CR, then SEA
 * down. A runner therefore never needs a hub kubeconfig or cross-preview RBAC.
 */
export class DesiredStateVclusterPreviewGateway implements VclusterPreviewGatewayPort {
	constructor(private readonly options: DesiredStateVclusterPreviewGatewayOptions) {}

	listWithCounts() {
		return this.options.gateway.listWithCounts();
	}

	get(name: string) {
		return this.options.gateway.get(name);
	}

	async provision(
		input: { name: string } & VclusterPreviewLaunchInput
	): Promise<VclusterPreviewRecord> {
		const command = commandFromGatewayInput(input, this.options.catalog);
		await this.options.desiredState.create(command);
		try {
			const preview = await this.options.gateway.provision(input);
			const observed = await this.options.desiredState.inspect(command);
			if (!observed) {
				throw new PreviewEnvironmentDesiredStateOwnershipError(
					'PreviewEnvironment disappeared after SEA provision'
				);
			}
			if (preview.name !== command.name) {
				throw new PreviewEnvironmentDesiredStateOwnershipError(
					'SEA provision returned a different preview identity'
				);
			}
			return preview;
		} catch (cause) {
			try {
				await this.compensate(command, input);
			} catch (compensationCause) {
				throw new PreviewEnvironmentDesiredStateError(
					`preview ${input.name} provision failed and compensation also failed`,
					{ cause: new AggregateError([cause, compensationCause]) }
				);
			}
			throw new PreviewEnvironmentDesiredStateError(
				`preview ${input.name} provision failed and was compensated`,
				{ cause }
			);
		}
	}

	async teardown(
		name: string,
		guard: Parameters<VclusterPreviewGatewayPort['teardown']>[1]
	): Promise<VclusterPreviewRecord> {
		if (!guard) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'physical preview teardown requires an ownership guard'
			);
		}
		await this.options.desiredState.deleteAndWait({
			name,
			guard,
			timeoutMs: this.options.compensationTimeoutMs ?? 10 * 60_000
		});
		return this.options.gateway.teardown(name, guard);
	}

	runtime(name: string) {
		return this.options.gateway.runtime(name);
	}

	async cleanup(name: string) {
		const cleanup = await this.options.gateway.cleanup(name);
		const desiredStateAbsent = await this.options.desiredState.absent(name);
		const checks = {
			...cleanup.checks,
			previewEnvironmentAbsent: desiredStateAbsent
		};
		const complete = cleanup.phase !== 'failed' && Object.values(checks).every(Boolean);
		return {
			...cleanup,
			complete,
			phase: complete ? ('complete' as const) : cleanup.phase,
			checks,
			message: complete ? null : cleanup.message
		};
	}

	touch(name: string) {
		return this.options.gateway.touch(name);
	}

	sleep(name: string) {
		return this.options.gateway.sleep(name);
	}

	private async compensate(
		command: ValidatedPreviewEnvironmentLaunchSpec,
		input: { name: string } & VclusterPreviewLaunchInput
	): Promise<void> {
		const guard = {
			mode: 'owned' as const,
			requestId: command.provenance.requestId,
			sourceRevision: command.sourceRevision
		};
		await this.options.desiredState.deleteAndWait({
			name: command.name,
			guard,
			timeoutMs: this.options.compensationTimeoutMs ?? 10 * 60_000
		});
		try {
			await this.options.gateway.teardown(input.name, guard);
		} catch (cause) {
			if (!(cause && typeof cause === 'object' && 'status' in cause && cause.status === 404)) {
				throw cause;
			}
		}
	}
}

export type BrokeredVclusterPreviewGatewayOptions = Readonly<{
	gateway: VclusterPreviewGatewayPort;
	baseUrl?: () => string | null;
	token?: () => string | null;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}>;

/**
 * Persistent-BFF gateway: reads and sleep/wake remain on SEA, while destructive
 * commands cross the authenticated physical-broker boundary.
 */
export class BrokeredVclusterPreviewGateway implements VclusterPreviewGatewayPort {
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(private readonly options: BrokeredVclusterPreviewGatewayOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	listWithCounts() {
		return this.options.gateway.listWithCounts();
	}

	get(name: string) {
		return this.options.gateway.get(name);
	}

	provision(): Promise<VclusterPreviewRecord> {
		throw new PreviewEnvironmentDesiredStateError(
			'preview provision must use the physical environment launch broker'
		);
	}

	async teardown(
		name: string,
		guard: Parameters<VclusterPreviewGatewayPort['teardown']>[1]
	): Promise<VclusterPreviewRecord> {
		if (!guard) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'brokered preview teardown requires an ownership guard'
			);
		}
		const baseUrl = (
			this.options.baseUrl?.() ??
			env.PREVIEW_CONTROL_BROKER_URL ??
			process.env.PREVIEW_CONTROL_BROKER_URL ??
			''
		)
			.trim()
			.replace(/\/+$/, '');
		const token = (
			this.options.token?.() ??
			env.PREVIEW_CONTROL_BROKER_TOKEN ??
			process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
			''
		).trim();
		if (!baseUrl || !token) {
			throw new PreviewEnvironmentDesiredStateError(
				'physical preview lifecycle broker is not configured'
			);
		}
		const response = await this.fetchImpl(
			`${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(name)}/teardown`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Preview-Control-Broker-Token': token
				},
				body: JSON.stringify({ guard }),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 15 * 60_000)
			}
		);
		const body = (await response.json().catch(() => null)) as unknown;
		const envelope = record(body);
		if (!response.ok) {
			throw new PreviewEnvironmentDesiredStateError(
				typeof envelope?.error === 'string'
					? envelope.error
					: `physical preview teardown failed (HTTP ${response.status})`
			);
		}
		const preview = record(envelope?.preview);
		const receipt = record(envelope?.receipt);
		if (
			!preview ||
			preview.name !== name ||
			typeof preview.phase !== 'string' ||
			!receipt ||
			receipt.name !== name ||
			receipt.desiredStateAbsent !== true ||
			canonical(receipt.guard) !== canonical(guard)
		) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'physical preview teardown returned a mismatched ownership receipt'
			);
		}
		return preview as unknown as VclusterPreviewRecord;
	}

	runtime(name: string) {
		return this.options.gateway.runtime(name);
	}

	async cleanup(name: string) {
		const baseUrl = (
			this.options.baseUrl?.() ??
			env.PREVIEW_CONTROL_BROKER_URL ??
			process.env.PREVIEW_CONTROL_BROKER_URL ??
			''
		)
			.trim()
			.replace(/\/+$/, '');
		const token = (
			this.options.token?.() ??
			env.PREVIEW_CONTROL_BROKER_TOKEN ??
			process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
			''
		).trim();
		if (!baseUrl || !token) {
			throw new PreviewEnvironmentDesiredStateError(
				'physical preview lifecycle broker is not configured'
			);
		}
		const response = await this.fetchImpl(
			`${baseUrl}/api/internal/preview-control/environment/${encodeURIComponent(name)}/cleanup`,
			{
				headers: { 'X-Preview-Control-Broker-Token': token },
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 15 * 60_000)
			}
		);
		const body = record(await response.json().catch(() => null));
		if (!response.ok) {
			throw new PreviewEnvironmentDesiredStateError(
				typeof body?.error === 'string'
					? body.error
					: `physical preview cleanup proof failed (HTTP ${response.status})`
			);
		}
		const cleanup = record(body?.cleanup);
		const checks = record(cleanup?.checks);
		if (
			!cleanup ||
			cleanup.name !== name ||
			typeof cleanup.resourceName !== 'string' ||
			typeof cleanup.complete !== 'boolean' ||
			!['pending', 'complete', 'failed'].includes(String(cleanup.phase)) ||
			!checks ||
			Object.keys(checks).length !== CLEANUP_CHECK_NAMES.length ||
			CLEANUP_CHECK_NAMES.some((key) => typeof checks[key] !== 'boolean') ||
			(cleanup.message !== null && typeof cleanup.message !== 'string')
		) {
			throw new PreviewEnvironmentDesiredStateOwnershipError(
				'physical preview cleanup returned an invalid proof'
			);
		}
		return cleanup as unknown as Awaited<ReturnType<VclusterPreviewGatewayPort['cleanup']>>;
	}

	touch(name: string) {
		return this.options.gateway.touch(name);
	}

	sleep(name: string) {
		return this.options.gateway.sleep(name);
	}
}
