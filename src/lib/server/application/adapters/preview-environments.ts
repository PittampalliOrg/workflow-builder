import { env } from '$env/dynamic/private';
import { PreviewEnvironmentLaunchAuthorizationError } from '$lib/server/application/preview-environment-launch-broker';
import {
	PreviewEnvironmentOperatorActionRequiredError,
	PreviewEnvironmentUnavailableError,
	validatePreviewEnvironmentLaunchSpec
} from '$lib/server/application/preview-environments';
import type {
	PreviewEnvironment,
	PreviewEnvironmentLaunchOutcome,
	PreviewEnvironmentLaunchPort,
	PreviewGitHubInstallationTokenPort,
	PreviewEnvironmentRevisionResolverPort,
	PreviewEnvironmentUserLaunchInput,
	PreviewEnvironmentUserLaunchPort,
	PreviewEnvironmentVersionedServiceCatalogPort,
	ValidatedPreviewEnvironmentLaunchSpec,
	VclusterPreviewGatewayPort,
	VclusterPreviewLaunchInput
} from '$lib/server/application/ports';
import type { VclusterPreviewRecord } from '$lib/types/dev-previews';

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LIFECYCLE_STATES = new Set([
	'requested',
	'provisioning',
	'ready',
	'sleeping',
	'slept',
	'recycling',
	'terminating',
	'terminated',
	'failed'
]);

export type GithubPreviewRevisionResolverOptions = Readonly<{
	fetch?: typeof globalThis.fetch;
	credentials?: PreviewGitHubInstallationTokenPort;
	token?: () => string | null | Promise<string | null>;
	apiBaseUrl?: string;
}>;

/** Resolve symbolic GitHub refs to immutable commit SHAs. */
export class GithubPreviewEnvironmentRevisionResolver implements PreviewEnvironmentRevisionResolverPort {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly token: () => Promise<string | null>;
	private readonly apiBaseUrl: string;

	constructor(options: GithubPreviewRevisionResolverOptions = {}) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.token = async () => {
			const token = options.credentials
				? await options.credentials.token()
				: await options.token?.();
			return token?.trim() || null;
		};
		this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
	}

	async resolve(input: { repository: string; ref: string }): Promise<string> {
		if (!GITHUB_REPOSITORY_PATTERN.test(input.repository)) {
			throw new Error(`Invalid GitHub repository: ${input.repository}`);
		}
		if (!input.ref.trim()) throw new Error('Git ref is required');
		const token = await this.token();
		const response = await this.fetchImpl(
			`${this.apiBaseUrl}/repos/${input.repository}/commits/${encodeURIComponent(input.ref)}`,
			{
				headers: {
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				signal: AbortSignal.timeout(20_000)
			}
		);
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			throw new Error(
				typeof body.message === 'string'
					? body.message
					: `GitHub ref resolution failed (HTTP ${response.status})`
			);
		}
		const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
		if (!FULL_GIT_SHA_PATTERN.test(sha)) {
			throw new Error('GitHub returned an invalid commit SHA');
		}
		return sha;
	}
}

export type SeaPreviewEnvironmentLaunchOptions = Readonly<{
	gateway: VclusterPreviewGatewayPort;
	maxPreviews: number;
}>;

function lifecycleState(preview: VclusterPreviewRecord): PreviewEnvironment['lifecycleState'] {
	if (preview.state === 'slept') return 'slept';
	if (preview.ready) return 'ready';
	if (/fail|error/i.test(preview.phase)) return 'failed';
	if (/terminat|delet/i.test(preview.phase)) return 'terminating';
	if (/recycl/i.test(preview.phase)) return 'recycling';
	return 'provisioning';
}

function expiration(
	command: ValidatedPreviewEnvironmentLaunchSpec,
	preview: VclusterPreviewRecord
): string {
	if (preview.expiresAt) return preview.expiresAt;
	return new Date(
		Date.parse(command.provenance.requestedAt) + command.ttlHours * 60 * 60 * 1000
	).toISOString();
}

function toEnvironment(
	command: ValidatedPreviewEnvironmentLaunchSpec,
	preview: VclusterPreviewRecord
): PreviewEnvironment {
	return {
		...command,
		allocation: { kind: 'cold' },
		id: preview.name,
		lifecycleState: lifecycleState(preview),
		createdAt: command.provenance.requestedAt,
		expiresAt: expiration(command, preview),
		runtime: {
			placement: 'dev-vcluster',
			phase: preview.phase,
			ready: preview.ready,
			url: preview.url,
			allocationId: null,
			pooled: false
		}
	};
}

function gatewayInput(
	command: ValidatedPreviewEnvironmentLaunchSpec
): VclusterPreviewLaunchInput & { name: string; user: string } {
	return {
		name: command.name,
		user: command.owner.id,
		lifecycle: command.lifecycle,
		origin: command.origin,
		ttlHours: command.ttlHours,
		platformRevision: command.platformRevision,
		sourceRevision: command.sourceRevision,
		catalogDigest: command.catalogDigest,
		candidatePaths: command.candidatePaths,
		delivery: 'reconciler',
		enrollMode: 'agent',
		profile: command.profile,
		lane: command.lane,
		mode: command.mode,
		allocation: command.allocation,
		imageOverrides: command.imageOverrides,
		owner: command.owner,
		services: command.services,
		provenance: command.provenance,
		trustedCode: true,
		createOnly: true
	};
}

/** vCluster launch adapter over the existing SEA gateway. */
export class SeaVclusterPreviewEnvironmentLaunchAdapter implements PreviewEnvironmentLaunchPort {
	constructor(private readonly options: SeaPreviewEnvironmentLaunchOptions) {}

	async launch(
		command: ValidatedPreviewEnvironmentLaunchSpec
	): Promise<PreviewEnvironmentLaunchOutcome> {
		const input = gatewayInput(command);
		const coldInput: VclusterPreviewLaunchInput & {
			name: string;
			user: string;
		} = {
			...input,
			allocation: { kind: 'cold' },
			createOnly: true
		};

		const { previews, counts } = await this.options.gateway.listWithCounts();
		const max = counts?.max && counts.max > 0 ? counts.max : this.options.maxPreviews;
		const awake = counts?.awake ?? previews.length;
		const alreadyExists = previews.some((preview) => preview.name === command.name);
		if (coldInput.createOnly && alreadyExists) {
			return {
				ok: false,
				reason: 'conflict',
				message: `Preview ${command.name} already exists; clean reconciled launches are create-only`
			};
		}
		if (!alreadyExists && awake >= max) {
			return {
				ok: false,
				reason: 'capacity',
				awake,
				max,
				message: `Preview capacity reached (${awake}/${max}). Tear one down or sleep one first.`
			};
		}

		const preview = await this.options.gateway.provision(coldInput);
		return {
			ok: true,
			environment: toEnvironment(command, preview)
		};
	}
}

export type HttpPreviewEnvironmentLaunchBrokerOptions = Readonly<{
	catalog: PreviewEnvironmentVersionedServiceCatalogPort;
	baseUrl?: () => string | null;
	token?: () => string | null;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}>;

/** Normal-BFF adapter. Capability derivation and SEA launch stay physical. */
export class HttpPreviewEnvironmentLaunchBrokerAdapter implements PreviewEnvironmentUserLaunchPort {
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(private readonly options: HttpPreviewEnvironmentLaunchBrokerOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	previewNativeServices(): readonly string[] {
		return this.options.catalog.listPreviewNativeServices();
	}

	async launchForUser(input: PreviewEnvironmentUserLaunchInput) {
		if (
			(input.profile !== undefined && input.profile !== 'app-live') ||
			(input.lane !== undefined && input.lane !== 'application') ||
			(input.candidatePaths?.length ?? 0) > 0 ||
			(input.allocation !== undefined && input.allocation.kind !== 'cold')
		) {
			throw new PreviewEnvironmentLaunchAuthorizationError(
				'infrastructure candidates require the GitHub-verified broker'
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
			throw new PreviewEnvironmentUnavailableError(
				'physical preview launch broker is not configured'
			);
		}
		const response = await this.fetchImpl(`${baseUrl}/api/internal/preview-control/environment`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Preview-Control-Broker-Token': token
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(this.options.timeoutMs ?? 20 * 60_000)
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			const message =
				typeof body.error === 'string'
					? body.error
					: `physical preview launch failed (HTTP ${response.status})`;
			if (response.status === 403 || response.status === 409) {
				throw new PreviewEnvironmentLaunchAuthorizationError(message);
			}
			throw new PreviewEnvironmentUnavailableError(message);
		}
		return parseLaunchOutcome(body, input, this.options.catalog);
	}
}

function parseLaunchOutcome(
	value: Record<string, unknown>,
	input: PreviewEnvironmentUserLaunchInput,
	catalog: PreviewEnvironmentVersionedServiceCatalogPort
): PreviewEnvironmentLaunchOutcome {
	if (value.ok === false) {
		if (
			value.reason === 'capacity' &&
			Number.isInteger(value.awake) &&
			Number.isInteger(value.max) &&
			typeof value.message === 'string'
		) {
			return {
				ok: false,
				reason: 'capacity',
				awake: value.awake as number,
				max: value.max as number,
				message: value.message
			};
		}
		if (value.reason === 'conflict' && typeof value.message === 'string') {
			return { ok: false, reason: 'conflict', message: value.message };
		}
		throw new PreviewEnvironmentUnavailableError(
			'physical preview launch returned an invalid refusal'
		);
	}
	const raw = value.environment;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new PreviewEnvironmentUnavailableError(
			'physical preview launch returned no environment proof'
		);
	}
	const environment = raw as Record<string, unknown>;
	const expectedServices = catalog.assertPreviewNativeServices(
		input.services ?? catalog.listPreviewNativeServices()
	);
	const expectedCapabilities = input.capabilities ?? ['service-live-sync'];
	const currentCatalogDigest = catalog.currentDigest();
	let validated: ValidatedPreviewEnvironmentLaunchSpec;
	try {
		validated = validatePreviewEnvironmentLaunchSpec(environment as never, currentCatalogDigest);
	} catch {
		throw new PreviewEnvironmentUnavailableError(
			'physical preview launch returned an invalid environment contract'
		);
	}
	const runtime = environment.runtime as Record<string, unknown> | undefined;
	const expectedCreatedAt = validated.provenance.requestedAt;
	const returnedExpiresAt = typeof environment.expiresAt === 'string' ? environment.expiresAt : '';
	const returnedExpiryTime = Date.parse(returnedExpiresAt);
	const runtimeUrl = runtime?.url;
	let validRuntimeUrl = runtimeUrl === null;
	if (typeof runtimeUrl === 'string') {
		try {
			const parsed = new URL(runtimeUrl);
			validRuntimeUrl =
				parsed.protocol === 'https:' &&
				parsed.hostname.startsWith(`wfb-${validated.name}.`) &&
				parsed.pathname === '/' &&
				!parsed.search &&
				!parsed.hash;
		} catch {
			validRuntimeUrl = false;
		}
	}
	if (
		validated.name !== input.name ||
		validated.owner.kind !== 'user' ||
		validated.owner.id !== input.userId ||
		validated.origin.kind !== 'user' ||
		validated.origin.reference !== undefined ||
		validated.profile !== 'app-live' ||
		validated.lane !== 'application' ||
		validated.mode !== 'live' ||
		validated.allocation.kind !== 'cold' ||
		!sameStringSets(validated.services, expectedServices) ||
		!sameStringSets(validated.capabilities, expectedCapabilities) ||
		validated.candidatePaths.length !== 0 ||
		Object.keys(validated.imageOverrides).length !== 0 ||
		environment.catalogDigest !== currentCatalogDigest ||
		environment.placement !== 'dev-vcluster' ||
		(input.platformRevision != null &&
			validated.platformRevision !== input.platformRevision.toLowerCase()) ||
		(input.sourceRevision != null &&
			validated.sourceRevision !== input.sourceRevision.toLowerCase()) ||
		validated.ttlHours !== (input.ttlHours ?? 24) ||
		validated.lifecycle !== (input.lifecycle ?? 'retained') ||
		validated.provenance.parentEnvironmentId !== input.provenance?.parentEnvironmentId ||
		environment.id !== validated.name ||
		typeof environment.lifecycleState !== 'string' ||
		!LIFECYCLE_STATES.has(environment.lifecycleState) ||
		environment.createdAt !== expectedCreatedAt ||
		!returnedExpiresAt.endsWith('Z') ||
		!Number.isFinite(returnedExpiryTime) ||
		returnedExpiryTime <= Date.parse(expectedCreatedAt) ||
		!runtime ||
		runtime.placement !== 'dev-vcluster' ||
		typeof runtime.phase !== 'string' ||
		typeof runtime.ready !== 'boolean' ||
		!validRuntimeUrl ||
		runtime.allocationId !== null ||
		runtime.pooled !== false
	) {
		throw new PreviewEnvironmentUnavailableError(
			'physical preview launch proof does not match the request'
		);
	}
	return {
		ok: true,
		environment: {
			...validated,
			id: validated.name,
			lifecycleState: environment.lifecycleState as PreviewEnvironment['lifecycleState'],
			createdAt: environment.createdAt,
			// The physical broker/SEA response is the expiry authority. Recomputing it
			// here would reject a TTL anchored when reconciliation accepts the request.
			expiresAt: returnedExpiresAt,
			runtime: {
				placement: 'dev-vcluster',
				phase: runtime.phase,
				ready: runtime.ready,
				url: runtime.url as string | null,
				allocationId: null,
				pooled: false
			}
		}
	};
}

function sameStringSets(left: readonly string[], right: readonly string[]) {
	const a = [...left].sort();
	const b = [...right].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Operator-only candidates keep cluster administration outside the BFF. */
export class OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter implements PreviewEnvironmentLaunchPort {
	async launch(
		input: ValidatedPreviewEnvironmentLaunchSpec
	): Promise<PreviewEnvironmentLaunchOutcome> {
		const management = input.profile === 'manifest-candidate' && input.lane === 'management';
		const profile = management ? 'manifest-candidate' : 'host-candidate';
		throw new PreviewEnvironmentOperatorActionRequiredError(
			profile,
			management ? 'preview-management-candidate.sh' : 'preview-host-candidate.sh'
		);
	}
}
