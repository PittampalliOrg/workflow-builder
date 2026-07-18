/**
 * Raw GitHub reads shared by the Dev-hub drift overview and the GitOps
 * fleet-drift extras: release pins (dev), repo main HEADs, and the stacks-main
 * preview-control-broker Deployment image digest.
 *
 * All reads are cached (60s raw-fetch TTL, per the deployment-metadata.ts
 * pattern), deduped, and resilient: a failed fetch degrades to the stale value
 * or a null-shaped result — it never throws into a page read.
 */
import yaml from "js-yaml";

import { createCachedLoader, type CachedLoader } from "$lib/server/dev-hub/cache";
import type { GitCommitMetadata } from "$lib/types/deployment-metadata";

const STACKS_RELEASE_PINS_URL =
	"https://raw.githubusercontent.com/PittampalliOrg/stacks/main/packages/components/hub-spoke-appsets/release-pins/workflow-builder-images.yaml";
const PREVIEW_CONTROL_BROKER_DEPLOYMENT_URL =
	"https://raw.githubusercontent.com/PittampalliOrg/stacks/main/packages/components/workloads/dev-preview-platform/Deployment-preview-control-broker.yaml";
const GITHUB_COMMIT_URL: Record<GithubRepo, string> = {
	"workflow-builder":
		"https://api.github.com/repos/PittampalliOrg/workflow-builder/commits/main",
	stacks: "https://api.github.com/repos/PittampalliOrg/stacks/commits/main",
};
const RAW_FETCH_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;

export type GithubRepo = "workflow-builder" | "stacks";

export type ReleasePinService = {
	tag: string | null;
	digest: string | null;
	commitSha: string | null;
	updatedAt: string | null;
	pipelineRun: string | null;
};

export type ReleasePinsSnapshot = {
	fetchedAt: string | null;
	error: string | null;
	services: Record<string, ReleasePinService>;
};

export type BrokerImageSnapshot = {
	fetchedAt: string | null;
	error: string | null;
	digest: string | null;
};

type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export type GithubSources = {
	getReleasePins(): Promise<ReleasePinsSnapshot>;
	getMainHead(repo: GithubRepo): Promise<GitCommitMetadata | null>;
	getBrokerImage(): Promise<BrokerImageSnapshot>;
};

function githubToken(): string | undefined {
	for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_TOKEN"]) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const entries: Array<[string, string]> = [];
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw instanceof Date) {
			entries.push([key, raw.toISOString()]);
		} else if (typeof raw === "string" && raw.trim()) {
			entries.push([key, raw.trim()]);
		} else if (typeof raw === "number" || typeof raw === "boolean") {
			entries.push([key, String(raw)]);
		}
	}
	return Object.fromEntries(entries);
}

export function commitShaFromImageTag(tag: string | null): string | null {
	const match = tag?.match(/^git-([0-9a-f]{7,40})$/i);
	return match ? match[1].toLowerCase() : null;
}

/** Parse the release-pins YAML into a per-service pin map. Pure; exported for tests. */
export function parseReleasePinsYaml(text: string): Record<string, ReleasePinService> {
	const doc = yaml.load(text) as Record<string, unknown> | null;
	const images = normalizeStringMap(doc?.images);
	const digests = normalizeStringMap(doc?.digests);
	const sourceShas = normalizeStringMap(doc?.sourceShas);
	const updatedAts = normalizeStringMap(doc?.updatedAts);
	const pipelineRuns = normalizeStringMap(doc?.pipelineRuns);
	const services: Record<string, ReleasePinService> = {};
	for (const [service, tag] of Object.entries(images)) {
		services[service] = {
			tag,
			digest: digests[service] ?? null,
			commitSha: sourceShas[service] ?? commitShaFromImageTag(tag),
			updatedAt: updatedAts[service] ?? null,
			pipelineRun: pipelineRuns[service] ?? null,
		};
	}
	return services;
}

/**
 * Extract the workflow-builder image digest from the broker Deployment YAML.
 * All broker containers are pinned to the same immutable BFF artifact, so the
 * first `.../workflow-builder@sha256:<64 hex>` reference is authoritative.
 * Pure; exported for tests.
 */
export function parseBrokerImageDigest(text: string): string | null {
	const match = text.match(/\/workflow-builder@(sha256:[0-9a-f]{64})/i);
	return match ? match[1].toLowerCase() : null;
}

function githubCommitToMetadata(body: {
	sha?: unknown;
	html_url?: unknown;
	author?: { login?: string } | null;
	commit?: {
		message?: string;
		author?: { name?: string; date?: string };
		committer?: { name?: string; date?: string };
	};
}): GitCommitMetadata | null {
	if (typeof body.sha !== "string" || !body.sha) return null;
	return {
		sha: body.sha,
		shortSha: body.sha.slice(0, 8),
		url: typeof body.html_url === "string" ? body.html_url : "",
		message: body.commit?.message?.split("\n")[0] ?? null,
		authorName: body.commit?.author?.name ?? body.author?.login ?? null,
		committedAt: body.commit?.committer?.date ?? body.commit?.author?.date ?? null,
	};
}

export function createGithubSources(options?: {
	fetchImpl?: FetchLike;
	now?: () => number;
	ttlMs?: number;
}): GithubSources {
	const fetchImpl: FetchLike = options?.fetchImpl ?? fetch;
	const ttlMs = options?.ttlMs ?? RAW_FETCH_TTL_MS;
	const now = options?.now;

	async function fetchText(url: string): Promise<string> {
		const token = githubToken();
		const response = await fetchImpl(url, {
			headers: {
				accept: "application/vnd.github+json, text/plain;q=0.9, */*;q=0.5",
				"user-agent": "workflow-builder-fleet-drift",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		return response.text();
	}

	const pins = createCachedLoader<ReleasePinsSnapshot>({
		ttlMs,
		now,
		load: async () => ({
			fetchedAt: new Date().toISOString(),
			error: null,
			services: parseReleasePinsYaml(await fetchText(STACKS_RELEASE_PINS_URL)),
		}),
		fallback: (cause, stale) => ({
			fetchedAt: stale?.fetchedAt ?? null,
			error: cause instanceof Error ? cause.message : String(cause),
			services: stale?.services ?? {},
		}),
	});

	const broker = createCachedLoader<BrokerImageSnapshot>({
		ttlMs,
		now,
		load: async () => ({
			fetchedAt: new Date().toISOString(),
			error: null,
			digest: parseBrokerImageDigest(
				await fetchText(PREVIEW_CONTROL_BROKER_DEPLOYMENT_URL),
			),
		}),
		fallback: (cause, stale) => ({
			fetchedAt: stale?.fetchedAt ?? null,
			error: cause instanceof Error ? cause.message : String(cause),
			digest: stale?.digest ?? null,
		}),
	});

	const heads = new Map<GithubRepo, CachedLoader<GitCommitMetadata | null>>();
	function headLoader(repo: GithubRepo): CachedLoader<GitCommitMetadata | null> {
		let loader = heads.get(repo);
		if (!loader) {
			loader = createCachedLoader<GitCommitMetadata | null>({
				ttlMs,
				now,
				load: async () =>
					githubCommitToMetadata(
						JSON.parse(await fetchText(GITHUB_COMMIT_URL[repo])),
					),
				fallback: (_cause, stale) => stale ?? null,
			});
			heads.set(repo, loader);
		}
		return loader;
	}

	return {
		getReleasePins: () => pins.get(),
		getMainHead: (repo) => headLoader(repo).get(),
		getBrokerImage: () => broker.get(),
	};
}

/** Process-wide singleton used by the production read paths. */
export const githubSources: GithubSources = createGithubSources();
