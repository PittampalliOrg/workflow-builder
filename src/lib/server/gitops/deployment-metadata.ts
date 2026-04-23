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
	LiveContainerMetadata,
	LiveDeploymentMetadata,
	ParsedImageRef,
} from "$lib/types/deployment-metadata";

const STACKS_RELEASE_PINS_URL =
	"https://raw.githubusercontent.com/PittampalliOrg/stacks/main/packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml";
const STACKS_MAIN_REF_URL =
	"https://api.github.com/repos/PittampalliOrg/stacks/commits/main";
const WORKFLOW_BUILDER_COMMIT_URL =
	"https://api.github.com/repos/PittampalliOrg/workflow-builder/commits/";
const GITOPS_CACHE_TTL_MS = 60_000;
const GIT_COMMIT_CACHE_TTL_MS = 12 * 60 * 60_000;

type CacheEntry<T> = {
	expiresAt: number;
	value: T;
};

let releasePinsCache: CacheEntry<{
	fetchedAt: string | null;
	desiredImages: DesiredImageMetadata[];
	error: string | null;
}> | null = null;
let stacksMainCache: CacheEntry<GitCommitMetadata | null> | null = null;
const workflowCommitCache = new Map<string, CacheEntry<GitCommitMetadata | null>>();
const workflowCommitInflight = new Map<string, Promise<GitCommitMetadata | null>>();

export async function getDeploymentMetadata(): Promise<DeploymentMetadataResponse> {
	const namespace = await getOwnNamespace();
	const [gitops, live] = await Promise.all([loadGitOpsState(), loadLiveState(namespace)]);
	const appUrl =
		readFirstEnv("APP_PUBLIC_URL", "APP_URL", "ORIGIN", "NEXT_PUBLIC_APP_URL") ?? null;

	return {
		generatedAt: new Date().toISOString(),
		environment: {
			name: inferEnvironmentName(appUrl),
			namespace,
			appUrl,
			nodeEnv: process.env.NODE_ENV ?? null,
			podName: os.hostname() || null,
		},
		gitops,
		live,
	};
}

function readFirstEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function inferEnvironmentName(appUrl: string | null): string {
	const explicit = readFirstEnv("WORKFLOW_BUILDER_ENV", "CLUSTER_NAME", "PUBLIC_CLUSTER_NAME");
	if (explicit) return explicit;
	const source = appUrl ?? "";
	for (const env of ["dev", "staging", "ryzen", "hub"]) {
		if (source.includes(`workflow-builder-${env}`) || source.includes(`${env}.`)) return env;
	}
	return "unknown";
}

async function loadGitOpsState(): Promise<DeploymentMetadataResponse["gitops"]> {
	const [releasePins, stacksMain] = await Promise.all([loadReleasePins(), getStacksMain()]);
	return {
		releasePinsSourceUrl: STACKS_RELEASE_PINS_URL,
		releasePinsFetchedAt: releasePins.fetchedAt,
		releasePinsError: releasePins.error,
		stacksMain,
		desiredImages: releasePins.desiredImages,
	};
}

async function loadReleasePins(): Promise<{
	fetchedAt: string | null;
	desiredImages: DesiredImageMetadata[];
	error: string | null;
}> {
	const now = Date.now();
	if (releasePinsCache && releasePinsCache.expiresAt > now) return releasePinsCache.value;

	try {
		const res = await fetchWithTimeout(STACKS_RELEASE_PINS_URL);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const doc = yaml.load(await res.text()) as { images?: Record<string, string> } | null;
		const images = Object.entries(doc?.images ?? {});
		const uniqueCommitShas = Array.from(
			new Set(
				images
					.map(([, tag]) => commitShaFromTag(tag))
					.filter((sha): sha is string => Boolean(sha)),
			),
		);
		const commits = new Map(
			await Promise.all(
				uniqueCommitShas.map(async (sha) => [sha, await getWorkflowBuilderCommit(sha)] as const),
			),
		);
		const desiredImages = images.map(([name, tag]) => {
			const commitSha = commitShaFromTag(tag);
			return {
				name,
				tag,
				commitSha,
				commit: commitSha ? (commits.get(commitSha) ?? null) : null,
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

async function getStacksMain(): Promise<GitCommitMetadata | null> {
	const now = Date.now();
	if (stacksMainCache && stacksMainCache.expiresAt > now) return stacksMainCache.value;
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

async function loadLiveState(namespace: string): Promise<DeploymentMetadataResponse["live"]> {
	try {
		const [deployments, pods, pins] = await Promise.all([
			listDeployments(namespace),
			listPods(namespace),
			loadReleasePins(),
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
			].map((status) => [`${pod.metadata?.name ?? ""}:${status.name ?? ""}`, status] as const),
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

function containerToMetadata(
	deploymentName: string,
	containerName: string,
	image: string,
	statuses: Map<
		string,
		{ name?: string; ready?: boolean; restartCount?: number; image?: string; imageID?: string }
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
	const status = Array.from(statuses.values()).find(
		(s) => s.name === containerName || `init/${s.name}` === containerName,
	);

	return {
		...parsed,
		containerName,
		imageID: status?.imageID ?? null,
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
