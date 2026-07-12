import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type {
	PrPreviewCommandPort,
	PrPreviewDevPodPort,
	PrPreviewDevPodResult,
	PrPreviewPullRequestPort,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewSeedTarget,
	PrPreviewStatus,
	PrPreviewVerifyPort,
	PreviewGitHubInstallationTokenPort,
} from '$lib/server/application/ports';
import {
	provisionWorkspaceHelperPod,
	runHelperCommand,
} from '$lib/server/workflows/helper-pod';
import { getVclusterPreview } from '$lib/server/workflows/vcluster-preview';
import { previewApiBaseUrl } from '$lib/server/application/adapters/preview-read-proxy';
import {
	DEV_PREVIEW_SERVICES,
	devPreviewCaptureOnly,
	devPreviewSyncPaths,
} from '$lib/server/workflows/dev-preview-registry';
import { derivePreviewControlCapability } from '$lib/server/preview-control-capability';

const GITHUB_API = 'https://api.github.com';
const FULL_SHA = /^[0-9a-f]{40}$/;
const DEFAULT_MAX_CHANGED_FILES = 3_000;

function prPreviewRepo(): string {
	return (
		env.PR_PREVIEW_REPO ??
		process.env.PR_PREVIEW_REPO ??
		'PittampalliOrg/workflow-builder'
	);
}

function internalToken(): string {
	return env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? '';
}

/** Registry slice for changed-path mapping + seed targets (repoSubdir/syncPaths
 * per service, from the canonical dev-preview registry). */
export function prPreviewRegistryEntries(): PrPreviewRegistryEntry[] {
	return Object.values(DEV_PREVIEW_SERVICES).map((d) => ({
		service: d.service,
		repoSubdir: d.repoSubdir,
		syncPaths: devPreviewSyncPaths(d),
		extraSync: [...(d.extraSync ?? []), ...devPreviewCaptureOnly(d)].map(
			(e) => ({
				from: e.from,
				to: e.to,
			}),
		),
		// #41 readiness gate: the seed polls the dev server itself (app port +
		// health route), not the sync receiver — the sidecar is up long before
		// the app, and the plugin-mode BFF's sync port IS the app port.
		appPort: d.port,
		healthPath: d.healthPath,
	}));
}

/** Deterministic per-preview sync token: stable across re-seeds (adopted pods
 * keep the token they were provisioned with), derived from a secret so it is
 * not guessable from the public alias. */
export function prPreviewSyncToken(alias: string): string {
	const secret = internalToken().trim();
	if (!secret) {
		throw new Error(
			'INTERNAL_API_TOKEN is required for PR preview sync auth',
		);
	}
	return createHash('sha256')
		.update(`wfb-pr-preview:${alias}:${secret}`)
		.digest('hex')
		.slice(0, 40);
}

export type HttpPrPreviewCommandBrokerOptions = Readonly<{
	baseUrl?: () => string | null;
	token?: () => string | null;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}>;

/** Persistent-BFF adapter; all privileged PR commands execute on the broker. */
export class HttpPrPreviewCommandBrokerAdapter implements PrPreviewCommandPort {
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(
		private readonly options: HttpPrPreviewCommandBrokerOptions = {},
	) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	async up(input: {
		prNumber: number;
		headSha: string;
		verify?: boolean;
	}): Promise<PrPreviewStatus> {
		return parseBrokerStatus(
			await this.command({ action: 'up', ...input }),
			input.prNumber,
		);
	}

	async down(input: {
		prNumber: number;
	}): Promise<{ state: 'down' | 'absent' }> {
		const response = await this.command({ action: 'down', ...input });
		if (response.state !== 'down' && response.state !== 'absent') {
			throw new Error(
				'preview-control broker returned an invalid teardown result',
			);
		}
		return { state: response.state };
	}

	async status(prNumber: number): Promise<PrPreviewStatus> {
		return parseBrokerStatus(
			await this.command({ action: 'status', prNumber }),
			prNumber,
		);
	}

	private async command(
		body: Readonly<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
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
		if (!baseUrl)
			throw new Error('PREVIEW_CONTROL_BROKER_URL is not configured');
		if (!token)
			throw new Error('PREVIEW_CONTROL_BROKER_TOKEN is not configured');
		const response = await this.fetchImpl(
			`${baseUrl}/api/internal/preview-control/pr-preview`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Preview-Control-Broker-Token': token,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(
					this.options.timeoutMs ?? 12 * 60_000,
				),
			},
		);
		const result = (await response.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!response.ok) {
			throw new Error(
				typeof result.error === 'string'
					? result.error
					: `preview-control PR command failed (HTTP ${response.status})`,
			);
		}
		return result;
	}
}

function parseBrokerStatus(
	value: Record<string, unknown>,
	prNumber: number,
): PrPreviewStatus {
	const states = new Set([
		'provisioning',
		'seeding',
		'tearing_down',
		'ready',
		'error',
		'capacity_full',
		'absent',
		'unknown',
	]);
	if (
		value.prNumber !== prNumber ||
		typeof value.alias !== 'string' ||
		!states.has(String(value.state)) ||
		!Array.isArray(value.services) ||
		!value.services.every((service) => typeof service === 'string')
	) {
		throw new Error(
			'preview-control broker returned an invalid PR preview status',
		);
	}
	return value as PrPreviewStatus;
}

/**
 * Adopt dev-mode pods INSIDE the preview by calling the PREVIEW BFF's own
 * internal dev-preview route (preview-native provisioning is served by the
 * preview's own SEA; the shared INTERNAL_API_TOKEN authorizes it — same value
 * fleet-wide via the ExternalSecret chain). Pod IPs come back host-reachable
 * (vcluster pods are host pods).
 *
 * REACHABILITY: in-cluster pods cannot resolve tailnet MagicDNS (NXDOMAIN on
 * dev) — the call targets the preview's SYNCED Service (same routing as the E2
 * read proxy, keyed `pool ?? name` for claimed members); the tailnet URL is
 * only sent as the user-facing `origin` field.
 */
export class PreviewBffDevPodGateway implements PrPreviewDevPodPort {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly sleepImpl: (milliseconds: number) => Promise<void>;
	private readonly now: () => number;

	constructor(
		private readonly options: Readonly<{
			fetch?: typeof globalThis.fetch;
			sleep?: (milliseconds: number) => Promise<void>;
			now?: () => number;
			resolveBaseUrl?: (
				alias: string,
				origin: string,
			) => Promise<string | null>;
			activationTimeoutMs?: number;
			retryDelayMs?: number;
		}> = {},
	) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.sleepImpl =
			options.sleep ??
			((milliseconds) =>
				new Promise((resolve) => setTimeout(resolve, milliseconds)));
		this.now = options.now ?? Date.now;
	}

	async provision(input: {
		previewUrl: string;
		alias: string;
		services: string[];
		syncToken: string;
		requestId: string;
		platformRevision: string;
		sourceRevision: string;
		catalogDigest: `sha256:${string}`;
	}): Promise<PrPreviewDevPodResult[]> {
		const origin = input.previewUrl.replace(/\/+$/, '');
		let base = origin;
		if (this.options.resolveBaseUrl) {
			base =
				(await this.options.resolveBaseUrl(input.alias, origin)) ??
				origin;
		} else {
			try {
				const preview = await getVclusterPreview(input.alias);
				const inCluster = previewApiBaseUrl({
					name: preview.pool ?? input.alias,
					pool: preview.pool,
					url: preview.url,
				});
				if (inCluster) base = inCluster;
			} catch {
				// SEA unreachable — keep the tailnet fallback and let the POST report.
			}
		}
		const waitReadySeconds = 300;
		const capability = derivePreviewControlCapability(
			(
				env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
				process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
				''
			).trim(),
			{
				previewName: input.alias,
				environmentRequestId: input.requestId,
				environmentPlatformRevision: input.platformRevision,
				environmentSourceRevision: input.sourceRevision,
				catalogDigest: input.catalogDigest,
			},
		);
		const requestBody = JSON.stringify({
			name: input.alias,
			requestId: input.requestId,
			platformRevision: input.platformRevision,
			sourceRevision: input.sourceRevision,
			catalogDigest: input.catalogDigest,
			services: input.services,
			origin,
			waitReadySeconds,
		});
		const timeoutMs =
			this.options.activationTimeoutMs ??
			waitReadySeconds * 1000 + 60_000;
		const retryDelayMs = this.options.retryDelayMs ?? 1_000;
		const deadline = this.now() + timeoutMs;
		let expectedBatchId: string | null = null;
		let lastDetail = 'activation remained pending';
		while (this.now() < deadline) {
			const remainingMs = Math.max(1, deadline - this.now());
			let res: Response;
			try {
				res = await this.fetchImpl(
					`${base}/api/internal/preview-control/pr-adoption`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-Preview-Control-Capability': capability,
						},
						body: requestBody,
						signal: AbortSignal.timeout(remainingMs),
					},
				);
			} catch (cause) {
				lastDetail =
					cause instanceof Error ? cause.message : String(cause);
				await this.waitForRetry(deadline, retryDelayMs);
				continue;
			}
			let body: Record<string, unknown>;
			try {
				const value = (await res.json()) as unknown;
				if (
					typeof value !== 'object' ||
					value === null ||
					Array.isArray(value)
				) {
					throw new Error('receipt body was not an object');
				}
				body = value as Record<string, unknown>;
			} catch (cause) {
				lastDetail =
					cause instanceof Error
						? `preview dev-pod activation receipt was not observed: ${cause.message}`
						: 'preview dev-pod activation receipt was not observed';
				if (res.ok || isTransientCutoverStatus(res.status)) {
					await this.waitForRetry(deadline, retryDelayMs);
					continue;
				}
				throw new Error(lastDetail);
			}
			const explicitFailure =
				body.activationPhase === 'failed' || body.ok === false;
			if (!res.ok) {
				lastDetail =
					typeof body.error === 'string'
						? body.error
						: `preview dev-pod provision failed (HTTP ${res.status})`;
				if (explicitFailure || !isTransientCutoverStatus(res.status)) {
					throw new Error(lastDetail);
				}
				await this.waitForRetry(deadline, retryDelayMs);
				continue;
			}
			if (explicitFailure) {
				throw new Error(
					typeof body.error === 'string'
						? body.error
						: 'preview dev-pod activation was explicitly rejected',
				);
			}
			let parsed: ReturnType<typeof parsePrAdoptionReceipt>;
			try {
				parsed = parsePrAdoptionReceipt(body, res.status, input);
			} catch (cause) {
				lastDetail =
					cause instanceof Error ? cause.message : String(cause);
				await this.waitForRetry(deadline, retryDelayMs);
				continue;
			}
			if (expectedBatchId && parsed.batchId !== expectedBatchId) {
				throw new Error(
					'preview dev-pod activation batch identity changed during polling',
				);
			}
			expectedBatchId = parsed.batchId;
			if (parsed.complete) return parsed.services;
			lastDetail = `activation ${parsed.activationPhase}`;
			await this.waitForRetry(deadline, retryDelayMs);
		}
		throw new Error(`preview dev-pod activation timed out: ${lastDetail}`);
	}

	private async waitForRetry(
		deadline: number,
		retryDelayMs: number,
	): Promise<void> {
		const remainingMs = deadline - this.now();
		if (remainingMs <= 0) return;
		await this.sleepImpl(Math.min(retryDelayMs, remainingMs));
	}
}

function isTransientCutoverStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

function parsePrAdoptionReceipt(
	body: Record<string, unknown>,
	status: number,
	input: Readonly<{ requestId: string; services: string[] }>,
): Readonly<{
	complete: boolean;
	activationPhase: 'scheduled' | 'activating' | 'active';
	batchId: string;
	services: PrPreviewDevPodResult[];
}> {
	const phase = body.activationPhase;
	const pending =
		body.ok === true &&
		body.complete === false &&
		body.pending === true &&
		(phase === 'scheduled' || phase === 'activating');
	const active =
		body.ok === true &&
		body.complete === true &&
		body.pending === false &&
		phase === 'active';
	const batchId = typeof body.batchId === 'string' ? body.batchId : '';
	const rawServices = Array.isArray(body.services) ? body.services : [];
	const parsedServices = rawServices.map((raw) => {
		const service =
			typeof raw === 'object' && raw !== null
				? (raw as Record<string, unknown>)
				: {};
		const info =
			typeof service.info === 'object' && service.info !== null
				? (service.info as Record<string, unknown>)
				: {};
		return {
			service: typeof service.service === 'string' ? service.service : '',
			ok: service.ok === true,
			podIp: typeof info.podIP === 'string' ? info.podIP : null,
			syncPort: typeof info.syncPort === 'number' ? info.syncPort : null,
			syncCapability:
				typeof info.syncCapability === 'string' &&
				/^[a-f0-9]{64}$/.test(info.syncCapability)
					? info.syncCapability
					: null,
			...(typeof service.error === 'string'
				? { error: service.error }
				: {}),
		};
	});
	const expectedServices = [...input.services].sort();
	const receivedServices = parsedServices
		.map(({ service }) => service)
		.sort();
	if (
		body.executionId !== `pr-adopt-${input.requestId}` ||
		(!pending && !active) ||
		(pending && status !== 202) ||
		(active && status !== 200) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId) ||
		new Set(receivedServices).size !== receivedServices.length ||
		JSON.stringify(receivedServices) !== JSON.stringify(expectedServices) ||
		parsedServices.some((service) => !service.ok)
	) {
		throw new Error(
			'preview dev-pod activation returned an invalid lifecycle receipt',
		);
	}
	return {
		complete: active,
		activationPhase: phase as 'scheduled' | 'activating' | 'active',
		batchId,
		services: parsedServices,
	};
}

/**
 * Seed the PR head into each adopted dev pod: one ephemeral helper pod (the
 * Promote `withGithubToken` pattern) clones the PR head once (depth 1, via
 * `pull/<n>/head` so forks work), stages each service's repoSubdir filtered by
 * syncPaths (+extraSync), and gzip-tar-POSTs to `http://<podIp>:<syncPort>/__sync`
 * with the `x-sync-token` header (the sidecar/plugin wire contract).
 */
export class HelperPodPrHeadSeeder implements PrPreviewSeedPort {
	constructor(
		private readonly credentials: PreviewGitHubInstallationTokenPort,
	) {}

	async seed(input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
	}): Promise<{ ok: boolean; detail: string | null }> {
		const githubToken = (await this.credentials.token()).trim();
		if (!githubToken) {
			return {
				ok: false,
				detail: 'preview control GitHub App token is not configured',
			};
		}
		const helper = await provisionWorkspaceHelperPod(
			`pr-preview-${input.prNumber}-${input.headSha.slice(0, 12)}`,
			'seed',
			{
				githubToken,
				timeoutMinutes: 15,
				sharedWorkspaceKey: `pr-preview-${input.prNumber}-${input.headSha}`,
			},
		);
		if (!helper) {
			return {
				ok: false,
				detail: 'could not provision a helper pod for PR-head seed',
			};
		}
		const command = buildPrSeedCommand(input, prPreviewRepo());
		const result = await runHelperCommand(
			helper.baseUrl,
			helper.token,
			command,
			'/tmp',
			600_000,
		);
		if (!result) {
			return {
				ok: false,
				detail: 'seed command failed (no pod response)',
			};
		}
		const output = `${result.stdout}\n${result.stderr}`;
		const err = output.match(/SEED_ERR=(\S+)/);
		if (err) return { ok: false, detail: `seed failed: ${err[1]}` };
		const failures: string[] = [];
		for (const target of input.targets) {
			const key = seedResultKey(target.service);
			const m = output.match(new RegExp(`${key}=(\\d{3})`));
			if (!m || !m[1].startsWith('2')) {
				failures.push(`${target.service}: HTTP ${m?.[1] ?? 'none'}`);
			}
		}
		if (result.exitCode !== 0) {
			failures.push(`exit ${result.exitCode}`);
		}
		return failures.length
			? { ok: false, detail: `sync rejected: ${failures.join('; ')}` }
			: { ok: true, detail: null };
	}
}

function seedResultKey(service: string): string {
	return `SEED_${service.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Exported for tests: the fixed shell the seeding helper pod runs. */
export function buildPrSeedCommand(
	input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
	},
	repo: string,
): string {
	const lines: string[] = [
		`set -e`,
		`GH="$GITHUB_TOKEN"`,
		`[ -n "$GH" ] || { echo "SEED_ERR=no_github_token"; exit 0; }`,
		`git config --global --add safe.directory '*' 2>/dev/null || true`,
		`rm -rf /tmp/pr-src && mkdir -p /tmp/pr-src && cd /tmp/pr-src`,
		`git init -q .`,
		`git remote add origin "https://x-access-token:$GH@github.com/${repo}.git"`,
		// pull/<n>/head resolves fork heads too (no fork clone URL needed).
		`git fetch -q --depth 1 origin "pull/${input.prNumber}/head" || { echo "SEED_ERR=fetch_failed"; exit 0; }`,
		`git checkout -q FETCH_HEAD`,
		`echo "SEED_HEAD=$(git rev-parse HEAD)"`,
		// A force-push invalidates the server authority; never seed different bytes.
		`[ "$(git rev-parse HEAD)" = ${shQuote(input.headSha)} ] || { echo "SEED_ERR=head_moved"; exit 0; }`,
	];
	for (const target of input.targets) {
		const sub =
			target.repoSubdir === '.'
				? ''
				: `/${target.repoSubdir.replace(/^\/+|\/+$/g, '')}`;
		const stage = `/tmp/stage-${target.service}`;
		const roots = [
			...new Set([
				...target.syncPaths,
				...target.extraSync.map((extra) => extra.to),
			]),
		].sort();
		lines.push(
			`# --- ${target.service} ---`,
			`SYNC_TOKEN=${shQuote(target.syncToken)}`,
			`rm -rf ${shQuote(stage)} && mkdir -p ${shQuote(stage)}`,
			`cd "/tmp/pr-src${sub}"`,
		);
		for (const p of target.syncPaths) {
			lines.push(
				`if [ -e ${shQuote(p)} ]; then d=$(dirname ${shQuote(p)}); mkdir -p "${stage}/$d"; cp -a ${shQuote(p)} "${stage}/$d/"; fi`,
			);
		}
		for (const extra of target.extraSync) {
			lines.push(
				`if [ -e ${shQuote(extra.from)} ]; then rm -rf "${stage}/${extra.to}"; mkdir -p "$(dirname "${stage}/${extra.to}")"; cp -a ${shQuote(extra.from)} "${stage}/${extra.to}"; fi`,
			);
		}
		// #41 readiness gate: on a cold provision the seed can land while the
		// just-adopted dev server is still booting/restarting — a /__sync that
		// ADDS route files in that window never registers them. Poll the APP
		// port's known route (ANY http status = the server is accepting; the
		// sidecar answering /__sync is NOT enough) with a bounded budget
		// (30 × (3s curl cap + 3s sleep) ≈ 90–180s), then seed regardless —
		// the marker records what we saw and the plugin-side route-add restart
		// backstops a straggler.
		const gatePort = target.appPort ?? target.syncPort;
		const rawHealth = target.healthPath ?? '/';
		const gatePath = rawHealth.startsWith('/')
			? rawHealth
			: `/${rawHealth}`;
		lines.push(
			`READY=000`,
			`i=0`,
			`while [ $i -lt 30 ]; do`,
			`  READY=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://${target.podIp}:${gatePort}${gatePath}" || echo 000)`,
			`  [ "$READY" != "000" ] && break`,
			`  i=$((i+1))`,
			`  sleep 3`,
			`done`,
			`echo "${seedReadyKey(target.service)}=$READY"`,
		);
		lines.push(
			`printf '%s' ${shQuote(JSON.stringify(roots))} | jq -r '.[]' > /tmp/seed-roots-${target.service}`,
			`: > /tmp/seed-existing-roots-${target.service}`,
			`while IFS= read -r p; do [ ! -e ${shQuote(stage)}/"$p" ] || printf '%s\n' "$p" >> /tmp/seed-existing-roots-${target.service}; done < /tmp/seed-roots-${target.service}`,
			`tar -czf /tmp/seed-${target.service}.tgz -C ${shQuote(stage)} -T /tmp/seed-existing-roots-${target.service}`,
			`CODE=$(curl -s -o /tmp/resp-${target.service} -w '%{http_code}' -X POST "http://${target.podIp}:${target.syncPort}/__sync" -H 'Content-Type: application/gzip' -H "x-sync-token: $SYNC_TOKEN" -H ${shQuote(`x-sync-generation: ${input.headSha}`)} -H ${shQuote(`x-sync-service: ${target.service}`)} -H ${shQuote(`x-sync-roots: ${JSON.stringify(roots)}`)} --data-binary @/tmp/seed-${target.service}.tgz || echo 000)`,
			`echo "${seedResultKey(target.service)}=$CODE"`,
		);
	}
	return lines.join('\n');
}

/** Informational marker: the last http code the readiness gate saw (000 = the
 * budget elapsed with the app port never answering). Not parsed for failure —
 * the seed still runs and SEED_<svc> stays the authoritative outcome. */
function seedReadyKey(service: string): string {
	return `SEED_READY_${service.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function shQuote(value: string): string {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export type GithubPrPreviewGatewayOptions = Readonly<{
	repository?: string;
	baseRef?: 'main';
	readCredentials?: PreviewGitHubInstallationTokenPort;
	commentCredentials?: PreviewGitHubInstallationTokenPort;
	readToken?: () => string | null | Promise<string | null>;
	commentToken?: () => string | null | Promise<string | null>;
	requiredLabel?: string;
	fetch?: typeof globalThis.fetch;
	maxChangedFiles?: number;
}>;

/**
 * GitHub authority adapter. It verifies the canonical open PR identity before
 * returning any data, then reads every changed-file page up to an explicit hard
 * cap and checks the count GitHub declared on the PR object.
 */
export class GithubPrPreviewGateway implements PrPreviewPullRequestPort {
	private readonly repository: string;
	private readonly baseRef: 'main';
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly maxChangedFiles: number;
	private readonly requiredLabel: string;

	constructor(private readonly options: GithubPrPreviewGatewayOptions = {}) {
		this.repository = options.repository ?? prPreviewRepo();
		this.baseRef = options.baseRef ?? 'main';
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.maxChangedFiles =
			options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
		this.requiredLabel = options.requiredLabel?.trim() || 'preview';
	}

	private async headers(
		kind: 'read' | 'comment',
	): Promise<Record<string, string>> {
		const credentials =
			kind === 'read'
				? this.options.readCredentials
				: this.options.commentCredentials;
		const legacyToken =
			kind === 'read'
				? this.options.readToken
				: this.options.commentToken;
		const token = (
			(credentials ? await credentials.token() : await legacyToken?.()) ??
			''
		).trim();
		if (kind === 'read' && !token) {
			throw new Error(
				'preview control GitHub App token is not configured',
			);
		}
		return {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
	}

	async inspect(input: { prNumber: number; expectedHeadSha: string }) {
		if (
			!Number.isSafeInteger(input.prNumber) ||
			input.prNumber < 1 ||
			!FULL_SHA.test(input.expectedHeadSha)
		) {
			throw new Error('invalid PR number or expected head SHA');
		}
		const headers = await this.headers('read');
		const response = await this.fetchImpl(
			`${GITHUB_API}/repos/${this.repository}/pulls/${input.prNumber}`,
			{
				headers,
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!response.ok) {
			throw new Error(`GitHub PR read failed (HTTP ${response.status})`);
		}
		const pull = (await response.json()) as Record<string, unknown>;
		const base = object(pull.base);
		const head = object(pull.head);
		const baseRepo = object(base.repo);
		const headRepo = object(head.repo);
		const baseSha = typeof base.sha === 'string' ? base.sha : '';
		const headSha = typeof head.sha === 'string' ? head.sha : '';
		const changedFileCount = pull.changed_files;
		const labels = Array.isArray(pull.labels)
			? pull.labels.map((label) => object(label).name)
			: [];
		if (
			pull.state !== 'open' ||
			pull.number !== input.prNumber ||
			base.ref !== this.baseRef ||
			baseRepo.full_name !== this.repository ||
			headRepo.full_name !== this.repository ||
			headSha !== input.expectedHeadSha ||
			!labels.includes(this.requiredLabel) ||
			!FULL_SHA.test(baseSha) ||
			!Number.isSafeInteger(changedFileCount) ||
			(changedFileCount as number) < 0
		) {
			throw new Error(
				`GitHub PR is not the expected open, same-repository main PR at the exact head SHA with label ${this.requiredLabel}`,
			);
		}
		if ((changedFileCount as number) > this.maxChangedFiles) {
			throw new Error(
				`GitHub PR changes ${changedFileCount} files, exceeding the ${this.maxChangedFiles} file cap`,
			);
		}

		const changedPaths = new Set<string>();
		let observedFiles = 0;
		const pageCount = Math.ceil((changedFileCount as number) / 100);
		for (let page = 1; page <= pageCount; page += 1) {
			const filesResponse = await this.fetchImpl(
				`${GITHUB_API}/repos/${this.repository}/pulls/${input.prNumber}/files?per_page=100&page=${page}`,
				{
					headers,
					signal: AbortSignal.timeout(20_000),
				},
			);
			if (!filesResponse.ok) {
				throw new Error(
					`GitHub PR files page ${page} failed (HTTP ${filesResponse.status})`,
				);
			}
			const files = (await filesResponse.json()) as unknown;
			if (!Array.isArray(files)) {
				throw new Error(
					`GitHub PR files page ${page} was not an array`,
				);
			}
			for (const rawFile of files) {
				const file = object(rawFile);
				if (typeof file.filename !== 'string' || !file.filename) {
					throw new Error('GitHub returned an invalid changed path');
				}
				changedPaths.add(file.filename);
				if (
					file.status === 'renamed' &&
					typeof file.previous_filename === 'string' &&
					file.previous_filename
				) {
					changedPaths.add(file.previous_filename);
				}
				observedFiles += 1;
			}
		}
		if (observedFiles !== changedFileCount) {
			throw new Error(
				`GitHub PR changed-file count mismatch (${observedFiles}/${changedFileCount})`,
			);
		}
		return Object.freeze({
			repository: this.repository,
			prNumber: input.prNumber,
			baseRef: this.baseRef,
			baseSha: baseSha as never,
			headSha: headSha as never,
			changedPaths: Object.freeze([...changedPaths]),
		});
	}

	async upsertStickyComment(input: {
		prNumber: number;
		marker: string;
		body: string;
	}): Promise<boolean> {
		try {
			const headers = await this.headers('comment');
			if (!headers.Authorization) return false;
			const list = await this.fetchImpl(
				`${GITHUB_API}/repos/${this.repository}/issues/${input.prNumber}/comments?per_page=100`,
				{ headers },
			);
			const comments = list.ok
				? ((await list.json()) as Array<{ id: number; body?: string }>)
				: [];
			const existing = comments.find((c) =>
				c.body?.includes(input.marker),
			);
			const res = existing
				? await this.fetchImpl(
						`${GITHUB_API}/repos/${this.repository}/issues/comments/${existing.id}`,
						{
							method: 'PATCH',
							headers: {
								...headers,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({ body: input.body }),
						},
					)
				: await this.fetchImpl(
						`${GITHUB_API}/repos/${this.repository}/issues/${input.prNumber}/comments`,
						{
							method: 'POST',
							headers: {
								...headers,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({ body: input.body }),
						},
					);
			return res.ok;
		} catch {
			return false;
		}
	}
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * D2 verify dispatch. There is no reusable URL-taking Playwright-critic
 * workflow in the repo today (the generator-critic fixtures are full coding
 * pipelines) — so the dispatch is CONFIGURED, not hardcoded: set
 * `PR_PREVIEW_VERIFY_WORKFLOW` to a seeded workflow name that accepts
 * `{previewUrl, prNumber, headSha}` trigger data and emits a `verdict` output.
 * Unset → `{started:false}` and the service records verify as skipped.
 */
export class WorkflowDispatchPrPreviewVerifyRunner implements PrPreviewVerifyPort {
	async start(input: {
		prNumber: number;
		previewUrl: string;
		headSha: string;
	}): Promise<{
		started: boolean;
		executionId?: string | null;
		reason?: string | null;
	}> {
		const workflowName = (
			env.PR_PREVIEW_VERIFY_WORKFLOW ??
			process.env.PR_PREVIEW_VERIFY_WORKFLOW ??
			''
		).trim();
		if (!workflowName) {
			return {
				started: false,
				reason: 'no Playwright-critic workflow configured (set PR_PREVIEW_VERIFY_WORKFLOW to a seeded workflow name)',
			};
		}
		// Lazy import: start-run pulls in the composition root; a static import
		// here would cycle (index.ts → this adapter → start-run → index.ts).
		const { startWorkflowRun } =
			await import('$lib/server/workflows/start-run');
		const result = await startWorkflowRun({
			workflowName,
			triggerData: {
				previewUrl: input.previewUrl,
				prNumber: input.prNumber,
				headSha: input.headSha,
				source: 'pr-preview-verify',
			},
			triggerSource: 'pr-preview-verify',
		});
		if (!result.ok) return { started: false, reason: result.error };
		return { started: true, executionId: result.executionId };
	}

	async waitForVerdict(input: {
		executionId: string;
		timeoutMs: number;
	}): Promise<{ status: string; verdict: string | null }> {
		const { getApplicationAdapters } =
			await import('$lib/server/application');
		const workflowData = getApplicationAdapters().workflowData;
		const deadline = Date.now() + input.timeoutMs;
		for (;;) {
			const execution = await workflowData
				.getExecutionById(input.executionId)
				.catch(() => null);
			const status = execution?.status ?? 'unknown';
			if (
				status === 'success' ||
				status === 'error' ||
				status === 'cancelled'
			) {
				const output = (execution?.output ?? null) as Record<
					string,
					unknown
				> | null;
				const verdict =
					output && typeof output.verdict === 'string'
						? output.verdict
						: output
							? JSON.stringify(output).slice(0, 2000)
							: null;
				return {
					status: status === 'success' ? 'completed' : status,
					verdict,
				};
			}
			if (Date.now() >= deadline)
				return { status: 'timeout', verdict: null };
			await new Promise((r) => setTimeout(r, 15_000));
		}
	}
}
