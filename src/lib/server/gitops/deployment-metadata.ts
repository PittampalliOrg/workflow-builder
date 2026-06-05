import dns from "node:dns";
import https from "node:https";
import os from "node:os";
import yaml from "js-yaml";

import {
	getOwnNamespace,
	listDeployments,
	listPods,
	type KubeDeployment,
	type KubePod,
} from "$lib/server/kube/client";
import type {
	DeploymentMetadataResponse,
	DesiredImageMetadata,
	GitCommitMetadata,
	GitOpsDeploymentInventory,
	ImageVersion,
	LiveContainerMetadata,
	LiveDeploymentMetadata,
	ParsedImageRef,
	RuntimeImageMetadata,
	RuntimeMatrixRow,
	RuntimeMetadataResponse,
} from "$lib/types/deployment-metadata";

const STACKS_RELEASE_PINS_PATH =
	"packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml";
const STACKS_RELEASE_PINS_URL = `https://raw.githubusercontent.com/PittampalliOrg/stacks/main/${STACKS_RELEASE_PINS_PATH}`;
const STACKS_PIN_COMMITS_URL = `https://api.github.com/repos/PittampalliOrg/stacks/commits?path=${encodeURIComponent(
	STACKS_RELEASE_PINS_PATH,
)}`;
const STACKS_PIN_BLOB_BASE_URL = `https://raw.githubusercontent.com/PittampalliOrg/stacks/`;
const STACKS_MAIN_REF_URL =
	"https://api.github.com/repos/PittampalliOrg/stacks/commits/main";
const WORKFLOW_BUILDER_COMMIT_URL =
	"https://api.github.com/repos/PittampalliOrg/workflow-builder/commits/";
const GITOPS_CACHE_TTL_MS = 60_000;
const GIT_COMMIT_CACHE_TTL_MS = 12 * 60 * 60_000;
const PIN_HISTORY_CACHE_TTL_MS = 10 * 60_000;
const HUB_INVENTORY_CACHE_TTL_MS = 15_000;
const RUNTIME_METADATA_CACHE_TTL_MS = 15_000;
const DEFAULT_PIN_HISTORY_LIMIT = 50;

type CacheEntry<T> = {
	expiresAt: number;
	value: T;
};

type DeploymentMetadataOptions = {
	fresh?: boolean;
};

let releasePinsCache: CacheEntry<{
	fetchedAt: string | null;
	desiredImages: DesiredImageMetadata[];
	error: string | null;
}> | null = null;
let stacksMainCache: CacheEntry<GitCommitMetadata | null> | null = null;
let pinHistoryCache: CacheEntry<{
	imageHistory: ImageVersion[];
	error: string | null;
}> | null = null;
let hubInventoryCache: CacheEntry<DeploymentMetadataResponse["inventory"]> | null = null;
let runtimeMetadataCache: CacheEntry<RuntimeMetadataResponse> | null = null;
const workflowCommitCache = new Map<string, CacheEntry<GitCommitMetadata | null>>();
const workflowCommitInflight = new Map<string, Promise<GitCommitMetadata | null>>();
const pinBlobCache = new Map<string, PinSnapshotSections>();

export function invalidateGitOpsDeploymentMetadataCaches(): void {
	releasePinsCache = null;
	stacksMainCache = null;
	pinHistoryCache = null;
	hubInventoryCache = null;
	runtimeMetadataCache = null;
}

export async function getDeploymentMetadata(
	options: DeploymentMetadataOptions = {},
): Promise<DeploymentMetadataResponse> {
	const namespace = await getOwnNamespace();
	const [gitops, live, inventory] = await Promise.all([
		loadGitOpsState(options),
		loadLiveState(namespace, options),
		loadHubInventory(options),
	]);
	const appUrl =
		readFirstEnv("APP_PUBLIC_URL", "APP_URL", "ORIGIN", "NEXT_PUBLIC_APP_URL") ?? null;
	const environment = inferEnvironmentMetadata(appUrl);

	return {
		generatedAt: new Date().toISOString(),
		environment: {
			name: environment.name,
			namespace,
			appUrl,
			nodeEnv: process.env.NODE_ENV ?? null,
			podName: os.hostname() || null,
			detectedFrom: environment.detectedFrom,
		},
		gitops,
		live,
		inventory,
	};
}

function readFirstEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function inferEnvironmentMetadata(appUrl: string | null): { name: string; detectedFrom: string } {
	const explicit = readFirstEnvWithName(
		"WORKFLOW_BUILDER_ENV",
		"CLUSTER_NAME",
		"PUBLIC_CLUSTER_NAME",
	);
	if (explicit) {
		return {
			name: explicit.value,
			detectedFrom: `env:${explicit.name}`,
		};
	}
	const source = appUrl ?? "";
	for (const env of ["dev", "staging", "ryzen", "hub"]) {
		if (source.includes(`workflow-builder-${env}`) || source.includes(`${env}.`)) {
			return { name: env, detectedFrom: "appUrl" };
		}
	}
	return { name: "unknown", detectedFrom: "fallback" };
}

function readFirstEnvWithName(...names: string[]): { name: string; value: string } | null {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return { name, value };
	}
	return null;
}

async function loadGitOpsState(
	options: DeploymentMetadataOptions,
): Promise<DeploymentMetadataResponse["gitops"]> {
	const [releasePins, stacksMain, pinHistory] = await Promise.all([
		loadReleasePins(options),
		getStacksMain(options),
		loadPinHistory(DEFAULT_PIN_HISTORY_LIMIT, options),
	]);
	return {
		releasePinsSourceUrl: STACKS_RELEASE_PINS_URL,
		releasePinsFetchedAt: releasePins.fetchedAt,
		releasePinsError: releasePins.error,
		stacksMain,
		desiredImages: releasePins.desiredImages,
		imageHistory: pinHistory.imageHistory,
		imageHistoryError: pinHistory.error,
	};
}

async function loadHubInventory(
	options: DeploymentMetadataOptions = {},
): Promise<DeploymentMetadataResponse["inventory"]> {
	const sourceUrl = readFirstEnv("WORKFLOW_BUILDER_GITOPS_INVENTORY_URL") ?? null;
	if (!sourceUrl) {
		return { sourceUrl: null, fetchedAt: null, error: null, data: null };
	}

	const now = Date.now();
	if (
		!options.fresh &&
		hubInventoryCache &&
		hubInventoryCache.value.sourceUrl === sourceUrl &&
		hubInventoryCache.expiresAt > now
	) {
		return hubInventoryCache.value;
	}

	try {
		const token = readFirstEnv("WORKFLOW_BUILDER_GITOPS_INVENTORY_TOKEN");
		const headers = {
			accept: "application/json",
			"user-agent": "workflow-builder-deployment-metadata",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};
		const body = await fetchInventoryPayload(sourceUrl, headers);
		if (!isGitOpsDeploymentInventory(body)) {
			throw new Error("inventory payload is missing generatedAt or environments");
		}
		const value = {
			sourceUrl,
			fetchedAt: new Date().toISOString(),
			error: null,
			data: body,
		};
		hubInventoryCache = { value, expiresAt: now + HUB_INVENTORY_CACHE_TTL_MS };
		return value;
	} catch (err) {
		const value = {
			sourceUrl,
			fetchedAt: hubInventoryCache?.value.fetchedAt ?? null,
			error: err instanceof Error ? err.message : String(err),
			data: hubInventoryCache?.value.data ?? null,
		};
		hubInventoryCache = { value, expiresAt: now + 15_000 };
		return value;
	}
}

async function fetchInventoryPayload(
	sourceUrl: string,
	headers: Record<string, string>,
): Promise<unknown> {
	try {
		const res = await fetch(sourceUrl, {
			headers,
			signal: AbortSignal.timeout(3_000),
		});
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		return await res.json();
	} catch (err) {
		const egressHost = readFirstEnv("WORKFLOW_BUILDER_GITOPS_INVENTORY_EGRESS_HOST");
		if (!egressHost || !isTailnetUrl(sourceUrl)) throw err;
		return await fetchJsonViaHttpsEgress(sourceUrl, egressHost, headers);
	}
}

function isTailnetUrl(sourceUrl: string): boolean {
	try {
		return new URL(sourceUrl).hostname.endsWith(".ts.net");
	} catch {
		return false;
	}
}

function fetchJsonViaHttpsEgress(
	sourceUrl: string,
	egressHost: string,
	headers: Record<string, string>,
): Promise<unknown> {
	const url = new URL(sourceUrl);
	if (url.protocol !== "https:") {
		throw new Error("inventory egress fallback only supports https URLs");
	}

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: url.hostname,
				servername: url.hostname,
				port: url.port ? Number(url.port) : 443,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers,
				timeout: 3_000,
				lookup: (_hostname, options, callback) => {
					dns.lookup(egressHost, options, callback);
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode < 200 || statusCode >= 300) {
						reject(new Error(`${statusCode} ${res.statusMessage ?? "HTTP error"}`));
						return;
					}

					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch (err) {
						reject(err);
					}
				});
			},
		);

		req.on("timeout", () => req.destroy(new Error("inventory egress request timed out")));
		req.on("error", reject);
		req.end();
	});
}

function isGitOpsDeploymentInventory(value: unknown): value is GitOpsDeploymentInventory {
	if (!value || typeof value !== "object") return false;
	const body = value as Partial<GitOpsDeploymentInventory>;
	return typeof body.generatedAt === "string" && Array.isArray(body.environments);
}

async function loadReleasePins(
	options?: DeploymentMetadataOptions,
): Promise<{
	fetchedAt: string | null;
	desiredImages: DesiredImageMetadata[];
	error: string | null;
}> {
	const now = Date.now();
	if (!options?.fresh && releasePinsCache && releasePinsCache.expiresAt > now)
		return releasePinsCache.value;

	try {
		const res = await fetchWithTimeout(STACKS_RELEASE_PINS_URL);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const doc = yaml.load(await res.text()) as ReleasePinsDocument | null;
		const sections = {
			images: normalizeStringMap(doc?.images),
			imageRefs: normalizeStringMap(doc?.imageRefs),
			digests: normalizeStringMap(doc?.digests),
			sourceShas: normalizeStringMap(doc?.sourceShas),
			pipelineRuns: normalizeStringMap(doc?.pipelineRuns),
			updatedAts: normalizeStringMap(doc?.updatedAts),
		};
		const images = Object.entries(sections.images);
		const uniqueCommitShas = Array.from(
			new Set(
				[
					...images.map(([, tag]) => commitShaFromTag(tag)),
					...Object.values(sections.sourceShas),
				].filter(isLikelyCommitSha),
			),
		);
		const commits = new Map(
			await Promise.all(
				uniqueCommitShas.map(async (sha) => [sha, await getWorkflowBuilderCommit(sha)] as const),
			),
		);
		const desiredImages = images.map(([name, tag]) => {
			const commitSha = commitShaFromTag(tag);
			const sourceSha = sections.sourceShas[name] ?? commitSha;
			return {
				name,
				tag,
				commitSha,
				commit: sourceSha ? (commits.get(sourceSha) ?? null) : null,
				imageRef: sections.imageRefs[name] ?? null,
				digest: sections.digests[name] ?? null,
				sourceSha,
				pipelineRun: sections.pipelineRuns[name] ?? null,
				updatedAt: sections.updatedAts[name] ?? null,
			};
		});
		const value = {
			fetchedAt: new Date().toISOString(),
			desiredImages,
			error: null,
		};
		releasePinsCache = { value, expiresAt: now + GITOPS_CACHE_TTL_MS };
		return value;
	} catch (err) {
		const value = {
			fetchedAt: null,
			desiredImages: releasePinsCache?.value.desiredImages ?? [],
			error: err instanceof Error ? err.message : String(err),
		};
		releasePinsCache = { value, expiresAt: now + 15_000 };
		return value;
	}
}

type ReleasePinsDocument = {
	images?: Record<string, unknown>;
	imageRefs?: Record<string, unknown>;
	digests?: Record<string, unknown>;
	sourceShas?: Record<string, unknown>;
	pipelineRuns?: Record<string, unknown>;
	updatedAts?: Record<string, unknown>;
};

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const entries = Object.entries(value as Record<string, unknown>)
		.map(([key, entry]) => [key, normalizeString(entry)] as const)
		.filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
	return Object.fromEntries(entries);
}

function normalizeString(value: unknown): string | null {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

/**
 * Source Kargo-style image HISTORY from live git: walk the release-pins file's
 * commit history (GitHub commits API filtered by path), fetch each historical
 * blob, and emit a per-service version event ONLY where a service's tag CHANGED
 * relative to the prior (older) commit. Resilient: any fetch error returns []
 * with an error string, never throws.
 */
export async function loadPinHistory(
	limit: number = DEFAULT_PIN_HISTORY_LIMIT,
	options: DeploymentMetadataOptions = {},
): Promise<{ imageHistory: ImageVersion[]; error: string | null }> {
	const now = Date.now();
	if (!options.fresh && pinHistoryCache && pinHistoryCache.expiresAt > now)
		return pinHistoryCache.value;

	try {
		const res = await fetchWithTimeout(`${STACKS_PIN_COMMITS_URL}&per_page=${limit}`);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const commits = (await res.json()) as PinCommitListItem[];
		if (!Array.isArray(commits)) throw new Error("pin commits payload is not an array");

		// GitHub returns commits newest-first. Fetch each commit's blob in parallel.
		const snapshots = await Promise.all(
			commits.map(async (commit) => ({
				sha: commit.sha,
				committedAt:
					commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
				message: commit.commit?.message?.split("\n")[0] ?? null,
				images: await loadPinBlobAt(commit.sha),
			})),
		);

		const history: ImageVersion[] = [];
		// Walk newest→oldest; compare each pin to the next (older) pin and emit
		// version events only for services whose tag changed.
		for (let i = 0; i < snapshots.length; i += 1) {
			const current = snapshots[i];
			if (!current.sha) continue;
			const prior = snapshots[i + 1]?.images.images ?? {};
			const sections = current.images;
			for (const [service, tag] of Object.entries(sections.images)) {
				if (!tag) continue;
				if (prior[service] === tag) continue;
				history.push({
					service,
					tag,
					digest: sections.digests[service] ?? null,
					sourceSha: sections.sourceShas[service] ?? commitShaFromTag(tag) ?? null,
					committedAt: sections.updatedAts[service] ?? null,
					pinCommit: current.sha,
					pinCommittedAt: current.committedAt ?? "",
					message: current.message,
				});
			}
		}

		const value = { imageHistory: history, error: null };
		pinHistoryCache = { value, expiresAt: now + PIN_HISTORY_CACHE_TTL_MS };
		return value;
	} catch (err) {
		const value = {
			imageHistory: pinHistoryCache?.value.imageHistory ?? [],
			error: err instanceof Error ? err.message : String(err),
		};
		pinHistoryCache = { value, expiresAt: now + 15_000 };
		return value;
	}
}

type PinSnapshotSections = {
	images: Record<string, string>;
	digests: Record<string, string>;
	sourceShas: Record<string, string>;
	updatedAts: Record<string, string>;
};

/**
 * Fetch and parse the release-pins YAML blob at a specific commit SHA, reusing
 * the same map-parsing (`normalizeStringMap`) as `loadReleasePins`. Per-commit
 * blobs are immutable, so the Map cache never expires.
 */
async function loadPinBlobAt(sha: string): Promise<PinSnapshotSections> {
	const key = sha.toLowerCase();
	const cached = pinBlobCache.get(key);
	if (cached) return cached;

	const res = await fetchWithTimeout(
		`${STACKS_PIN_BLOB_BASE_URL}${encodeURIComponent(sha)}/${STACKS_RELEASE_PINS_PATH}`,
	);
	if (!res.ok) throw new Error(`pin blob ${sha.slice(0, 8)}: ${res.status} ${res.statusText}`);
	const doc = yaml.load(await res.text()) as ReleasePinsDocument | null;
	const sections: PinSnapshotSections = {
		images: normalizeStringMap(doc?.images),
		digests: normalizeStringMap(doc?.digests),
		sourceShas: normalizeStringMap(doc?.sourceShas),
		updatedAts: normalizeStringMap(doc?.updatedAts),
	};
	pinBlobCache.set(key, sections);
	return sections;
}

type PinCommitListItem = {
	sha: string;
	commit?: {
		message?: string;
		author?: { date?: string };
		committer?: { date?: string };
	};
};

function isLikelyCommitSha(value: string | null | undefined): value is string {
	return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);
}

async function getStacksMain(
	options: DeploymentMetadataOptions = {},
): Promise<GitCommitMetadata | null> {
	const now = Date.now();
	if (!options.fresh && stacksMainCache && stacksMainCache.expiresAt > now)
		return stacksMainCache.value;
	try {
		const res = await fetchWithTimeout(STACKS_MAIN_REF_URL);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const body = (await res.json()) as GithubCommitResponse;
		const value = githubCommitToMetadata(body, "https://github.com/PittampalliOrg/stacks/commit/");
		stacksMainCache = { value, expiresAt: now + GITOPS_CACHE_TTL_MS };
		return value;
	} catch {
		return stacksMainCache?.value ?? null;
	}
}

async function getWorkflowBuilderCommit(sha: string): Promise<GitCommitMetadata | null> {
	const key = sha.toLowerCase();
	const now = Date.now();
	const cached = workflowCommitCache.get(key);
	if (cached && cached.expiresAt > now) return cached.value;
	const inflight = workflowCommitInflight.get(key);
	if (inflight) return inflight;

	const load = (async () => {
		const res = await fetchWithTimeout(`${WORKFLOW_BUILDER_COMMIT_URL}${encodeURIComponent(sha)}`);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const body = (await res.json()) as GithubCommitResponse;
		const value = githubCommitToMetadata(
			body,
			"https://github.com/PittampalliOrg/workflow-builder/commit/",
		);
		workflowCommitCache.set(key, { value, expiresAt: Date.now() + GIT_COMMIT_CACHE_TTL_MS });
		return value;
	})().catch(() => {
		const value = cached?.value ?? null;
		workflowCommitCache.set(key, { value, expiresAt: Date.now() + 15_000 });
		return value;
	}).finally(() => workflowCommitInflight.delete(key));

	workflowCommitInflight.set(key, load);
	return load;
}

function githubCommitToMetadata(
	body: GithubCommitResponse,
	baseCommitUrl: string,
): GitCommitMetadata {
	const sha = body.sha;
	return {
		sha,
		shortSha: sha.slice(0, 8),
		url: body.html_url || `${baseCommitUrl}${sha}`,
		message: body.commit?.message?.split("\n")[0] ?? null,
		authorName: body.commit?.author?.name ?? body.author?.login ?? null,
		committedAt: body.commit?.committer?.date ?? body.commit?.author?.date ?? null,
	};
}

type GithubCommitResponse = {
	sha: string;
	html_url?: string;
	author?: { login?: string } | null;
	commit?: {
		message?: string;
		author?: { name?: string; date?: string };
		committer?: { name?: string; date?: string };
	};
};

async function fetchWithTimeout(url: string): Promise<Response> {
	const githubToken = readFirstEnv("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_TOKEN");
	return fetch(url, {
		headers: {
			accept: "application/vnd.github+json, text/plain;q=0.9, */*;q=0.5",
			"user-agent": "workflow-builder-deployment-metadata",
			...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
		},
		signal: AbortSignal.timeout(4_000),
	});
}

async function loadLiveState(
	namespace: string,
	options: DeploymentMetadataOptions = {},
): Promise<DeploymentMetadataResponse["live"]> {
	try {
		const [deployments, pods, pins] = await Promise.all([
			listDeployments(namespace),
			listPods(namespace),
			loadReleasePins(options),
		]);
		const desiredByName = new Map(pins.desiredImages.map((image) => [image.name, image]));
		return {
			deployments: deployments
				.map((deployment) => deploymentToMetadata(deployment, pods, desiredByName))
				.sort((a, b) => a.name.localeCompare(b.name)),
			error: null,
		};
	} catch (err) {
		return {
			deployments: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function deploymentToMetadata(
	deployment: KubeDeployment,
	pods: KubePod[],
	desiredByName: Map<string, DesiredImageMetadata>,
): LiveDeploymentMetadata {
	const name = deployment.metadata?.name ?? "unknown";
	const namespace = deployment.metadata?.namespace ?? "unknown";
	const labels = deployment.metadata?.labels ?? {};
	const selector = deployment.spec?.selector?.matchLabels ?? {};
	const matchingPods = pods.filter((pod) => labelsMatch(pod.metadata?.labels ?? {}, selector));
	const containerStatuses = new Map(
		matchingPods.flatMap((pod) =>
			[
				...(pod.status?.initContainerStatuses ?? []),
				...(pod.status?.containerStatuses ?? []),
			].map((status) => {
				const state = (
					status as {
						state?: {
							running?: { startedAt?: string };
							terminated?: { startedAt?: string };
						};
					}
				).state;
				return [
					`${pod.metadata?.name ?? ""}:${status.name ?? ""}`,
					{
						...status,
						startedAt: state?.running?.startedAt ?? state?.terminated?.startedAt ?? null,
						podStartedAt: pod.status?.startTime ?? null,
						podCreatedAt: pod.metadata?.creationTimestamp ?? null,
					},
				] as const;
			}),
		),
	);
	const containers = [
		...(deployment.spec?.template?.spec?.initContainers ?? []).map((c) => ({
			...c,
			name: c.name ? `init/${c.name}` : "init/unknown",
		})),
		...(deployment.spec?.template?.spec?.containers ?? []),
	].map((container) =>
		containerToMetadata(name, container.name ?? "unknown", container.image ?? "", containerStatuses, desiredByName),
	);

	return {
		name,
		namespace,
		labels,
		replicas: deployment.status?.replicas ?? deployment.spec?.replicas ?? 0,
		readyReplicas: deployment.status?.readyReplicas ?? 0,
		availableReplicas: deployment.status?.availableReplicas ?? 0,
		updatedReplicas: deployment.status?.updatedReplicas ?? 0,
		createdAt: deployment.metadata?.creationTimestamp ?? null,
		updatedAt: latestIso([
			...(deployment.status?.conditions ?? []).map(
				(condition) => condition.lastUpdateTime ?? condition.lastTransitionTime ?? null,
			),
			...matchingPods.map((pod) => pod.status?.startTime ?? pod.metadata?.creationTimestamp ?? null),
		]),
		availableAt:
			(deployment.status?.conditions ?? []).find(
				(condition) => condition.type === "Available" && condition.status === "True",
			)?.lastTransitionTime ?? null,
		podStartedAt: latestIso(
			matchingPods.map((pod) => pod.status?.startTime ?? pod.metadata?.creationTimestamp ?? null),
		),
		pods: {
			total: matchingPods.length,
			running: matchingPods.filter((pod) => pod.status?.phase === "Running").length,
			ready: matchingPods.filter((pod) =>
				(pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
			).length,
			names: matchingPods
				.map((pod) => pod.metadata?.name)
				.filter((name): name is string => Boolean(name)),
		},
		containers,
	};
}

function labelsMatch(labels: Record<string, string>, selector: Record<string, string>): boolean {
	const entries = Object.entries(selector);
	if (entries.length === 0) return false;
	return entries.every(([key, value]) => labels[key] === value);
}

function latestIso(values: Array<string | null | undefined>): string | null {
	let latest: string | null = null;
	let latestTime = 0;
	for (const value of values) {
		if (!value) continue;
		const time = new Date(value).getTime();
		if (!Number.isFinite(time) || time <= latestTime) continue;
		latest = value;
		latestTime = time;
	}
	return latest;
}

function statusTime(status: {
	startedAt?: string | null;
	podStartedAt?: string | null;
	podCreatedAt?: string | null;
}): number {
	const value = status.startedAt ?? status.podStartedAt ?? status.podCreatedAt;
	return value ? new Date(value).getTime() || 0 : 0;
}

function containerToMetadata(
	deploymentName: string,
	containerName: string,
	image: string,
	statuses: Map<
		string,
		{
			name?: string;
			ready?: boolean;
			restartCount?: number;
			image?: string;
			imageID?: string;
			startedAt?: string | null;
			podStartedAt?: string | null;
			podCreatedAt?: string | null;
		}
	>,
	desiredByName: Map<string, DesiredImageMetadata>,
): LiveContainerMetadata {
	const parsed = parseImageRef(image);
	const pinKey =
		desiredByName.has(parsed.name)
			? parsed.name
			: desiredByName.has(deploymentName)
				? deploymentName
				: null;
	const desired = pinKey ? desiredByName.get(pinKey) : null;
	const status = Array.from(statuses.values())
		.filter((s) => s.name === containerName || `init/${s.name}` === containerName)
		.sort((a, b) => statusTime(b) - statusTime(a))[0];

	return {
		...parsed,
		containerName,
		imageID: status?.imageID ?? null,
		startedAt: status?.startedAt ?? null,
		podStartedAt: status?.podStartedAt ?? null,
		podCreatedAt: status?.podCreatedAt ?? null,
		ready: status?.ready ?? null,
		restartCount: status?.restartCount ?? null,
		desiredTag: desired?.tag ?? null,
		desiredCommitSha: desired?.commitSha ?? null,
		desiredMatches: desired ? parsed.tag === desired.tag : null,
		commit: null,
		pinKey,
	};
}

export async function enrichLiveCommits(
	response: DeploymentMetadataResponse,
): Promise<DeploymentMetadataResponse> {
	const uniqueShas = new Set<string>();
	for (const deployment of response.live.deployments) {
		for (const container of deployment.containers) {
			if (container.commitSha) uniqueShas.add(container.commitSha);
		}
	}
	const commits = new Map<string, GitCommitMetadata | null>();
	await Promise.all(
		Array.from(uniqueShas).map(async (sha) => {
			commits.set(sha, await getWorkflowBuilderCommit(sha));
		}),
	);
	for (const deployment of response.live.deployments) {
		for (const container of deployment.containers) {
			if (container.commitSha) container.commit = commits.get(container.commitSha) ?? null;
		}
	}
	return response;
}

export async function getRuntimeMetadata(): Promise<RuntimeMetadataResponse> {
	const now = Date.now();
	if (runtimeMetadataCache && runtimeMetadataCache.expiresAt > now) {
		return runtimeMetadataCache.value;
	}
	const metadata = await enrichLiveCommits(await getDeploymentMetadata());
	const value = toRuntimeMetadata(metadata);
	runtimeMetadataCache = {
		value,
		expiresAt: now + RUNTIME_METADATA_CACHE_TTL_MS,
	};
	return value;
}

export function toRuntimeMetadata(
	metadata: DeploymentMetadataResponse,
): RuntimeMetadataResponse {
	const current = findCurrentRuntimeImage(metadata.live.deployments);
	const matrix = buildRuntimeMatrix(metadata, current);
	const errors = [
		metadata.live.error,
		metadata.gitops.releasePinsError,
		metadata.inventory.error,
	].filter((message): message is string => Boolean(message));

	return {
		generatedAt: metadata.generatedAt,
		environment: {
			...metadata.environment,
			detectedFrom: metadata.environment.detectedFrom ?? "unknown",
		},
		current,
		matrix,
		errors,
	};
}

function findCurrentRuntimeImage(
	deployments: LiveDeploymentMetadata[],
): RuntimeImageMetadata | null {
	const deployment =
		deployments.find((candidate) => candidate.name === "workflow-builder") ??
		deployments.find((candidate) =>
			candidate.containers.some((container) => container.containerName === "workflow-builder"),
		);
	if (!deployment) return null;

	const container =
		deployment.containers.find((candidate) => candidate.containerName === "workflow-builder") ??
		deployment.containers.find((candidate) => candidate.name === "workflow-builder") ??
		deployment.containers.find((candidate) => !candidate.containerName.startsWith("init/"));
	if (!container) return null;

	return liveContainerToRuntimeImage(deployment.name, container);
}

function liveContainerToRuntimeImage(
	deploymentName: string,
	container: LiveContainerMetadata,
): RuntimeImageMetadata {
	return {
		deploymentName,
		containerName: container.containerName,
		image: container.image,
		repository: container.repository,
		name: container.name,
		tag: container.tag,
		digest: container.digest,
		imageID: container.imageID,
		commitSha: container.commitSha,
		commitUrl: container.commit?.url ?? commitUrl(container.commitSha),
		commitMessage: container.commit?.message ?? null,
		committedAt: container.commit?.committedAt ?? null,
		ready: container.ready,
		restartCount: container.restartCount,
		desiredTag: container.desiredTag,
		desiredMatches: container.desiredMatches,
	};
}

function buildRuntimeMatrix(
	metadata: DeploymentMetadataResponse,
	current: RuntimeImageMetadata | null,
): RuntimeMatrixRow[] {
	const inventoryGeneratedAt = metadata.inventory.data?.generatedAt ?? null;
	const rows: RuntimeMatrixRow[] = [];
	for (const environment of metadata.inventory.data?.environments ?? []) {
		for (const application of environment.applications) {
			if (!isWorkflowBuilderApplication(application.name, application.component)) continue;
			const liveImage = selectWorkflowBuilderImage(application.live.images);
			const parsedLive = liveImage ? parseImageRef(liveImage) : null;
			rows.push({
				environment: environment.name,
				applicationName: application.name,
				component: application.component,
				desiredImage: application.desired.image,
				desiredTag: application.desired.tag,
				desiredCommitSha: application.desired.commitSha,
				liveImage,
				liveTag: parsedLive?.tag ?? null,
				liveCommitSha: parsedLive?.commitSha ?? null,
				syncStatus: application.live.syncStatus,
				healthStatus: application.live.healthStatus,
				driftStatus: application.drift.status,
				promotionHealth: application.promotion?.healthPhase ?? null,
				buildReason: application.build?.reason ?? null,
				buildStatus: application.build?.status ?? null,
				buildFinishedAt: application.build?.finishedAt ?? null,
				generatedAt: inventoryGeneratedAt,
			});
		}
	}

	const currentEnv = metadata.environment.name;
	if (
		current &&
		currentEnv &&
		!rows.some((row) => row.environment === currentEnv && row.component === "workflow-builder")
	) {
		rows.push({
			environment: currentEnv,
			applicationName:
				currentEnv === "unknown" ? current.deploymentName : `${currentEnv}-workflow-builder`,
			component: "workflow-builder",
			desiredImage: null,
			desiredTag: current.desiredTag,
			desiredCommitSha: null,
			liveImage: current.image,
			liveTag: current.tag,
			liveCommitSha: current.commitSha,
			syncStatus: null,
			healthStatus: current.ready === false ? "NotReady" : current.ready === true ? "Healthy" : null,
			driftStatus:
				current.desiredMatches === false
					? "pending_rollout"
					: current.desiredMatches === true
						? "in_sync"
						: "local_live",
			promotionHealth: null,
			buildReason: null,
			buildStatus: null,
			buildFinishedAt: null,
			generatedAt: metadata.generatedAt,
		});
	}

	return rows.sort((a, b) => {
		const order = ["dev", "staging", "ryzen", "hub", "unknown"];
		const aIndex = order.indexOf(a.environment);
		const bIndex = order.indexOf(b.environment);
		if (aIndex !== bIndex) {
			return (aIndex === -1 ? order.length : aIndex) - (bIndex === -1 ? order.length : bIndex);
		}
		return a.component.localeCompare(b.component);
	});
}

function isWorkflowBuilderApplication(name: string, component: string): boolean {
	return component === "workflow-builder" || name.endsWith("-workflow-builder");
}

function selectWorkflowBuilderImage(images: string[]): string | null {
	for (const image of images) {
		if (parseImageRef(image).name === "workflow-builder") return image;
	}
	return null;
}

function commitUrl(sha: string | null | undefined): string | null {
	return sha ? `https://github.com/PittampalliOrg/workflow-builder/commit/${sha}` : null;
}

export function parseImageRef(image: string): ParsedImageRef {
	const [withoutDigest, digest] = image.split("@", 2);
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	const hasTag = lastColon > lastSlash;
	const repository = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
	const tag = hasTag ? withoutDigest.slice(lastColon + 1) : null;
	const name = repository.split("/").pop() || repository;
	const commitSha = tag ? commitShaFromTag(tag) : null;
	return {
		image,
		repository,
		name,
		tag,
		digest: digest ?? null,
		commitSha,
	};
}

function commitShaFromTag(tag: string): string | null {
	const match = tag.match(/^git-([0-9a-f]{7,40})$/i);
	return match ? match[1].toLowerCase() : null;
}
