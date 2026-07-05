import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import type {
	PrPreviewClusterInfo,
	PrPreviewClusterPort,
	PrPreviewDevPodPort,
	PrPreviewDevPodResult,
	PrPreviewLaunchInput,
	PrPreviewProvisionResult,
	PrPreviewPullRequestPort,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewSeedTarget,
	PrPreviewVerifyPort,
} from "$lib/server/application/ports";
import {
	claimVclusterPreview,
	getVclusterPreview,
	listVclusterPreviewsWithCounts,
	provisionVclusterPreview,
	reapVclusterPreviews,
	teardownVclusterPreview,
	VclusterPreviewHttpError,
} from "$lib/server/workflows/vcluster-preview";
import {
	provisionWorkspaceHelperPod,
	runHelperCommand,
} from "$lib/server/workflows/helper-pod";
import { resolveWorkflowGithubToken } from "$lib/server/workflows/github-token";
import {
	DEV_PREVIEW_SERVICES,
	devPreviewSyncPaths,
} from "$lib/server/workflows/dev-preview-registry";

const GITHUB_API = "https://api.github.com";

function prPreviewRepo(): string {
	return (
		env.PR_PREVIEW_REPO ??
		process.env.PR_PREVIEW_REPO ??
		"PittampalliOrg/workflow-builder"
	);
}

function internalToken(): string {
	return env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
}

/** Registry slice for changed-path mapping + seed targets (repoSubdir/syncPaths
 * per service, from the canonical dev-preview registry). */
export function prPreviewRegistryEntries(): PrPreviewRegistryEntry[] {
	return Object.values(DEV_PREVIEW_SERVICES).map((d) => ({
		service: d.service,
		repoSubdir: d.repoSubdir,
		syncPaths: devPreviewSyncPaths(d),
		extraSync: (d.extraSync ?? []).map((e) => ({ from: e.from, to: e.to })),
	}));
}

/** Deterministic per-preview sync token: stable across re-seeds (adopted pods
 * keep the token they were provisioned with), derived from a secret so it is
 * not guessable from the public alias. */
export function prPreviewSyncToken(alias: string): string {
	return createHash("sha256")
		.update(`wfb-pr-preview:${alias}:${internalToken()}`)
		.digest("hex")
		.slice(0, 40);
}

/** Tier-2 cluster lifecycle via the SEA vcluster-preview client (claim-first,
 * capacity-aware cold provision, alias status/teardown, sibling-owned reap). */
export class VclusterPrPreviewClusterGateway implements PrPreviewClusterPort {
	async claim(input: PrPreviewLaunchInput): Promise<PrPreviewClusterInfo | null> {
		const claimed = await claimVclusterPreview({
			name: input.alias,
			devMode: true,
			origin: "pr",
			prNumber: input.prNumber,
			ttlHours: input.ttlHours,
		});
		return claimed
			? { ready: claimed.ready, phase: claimed.phase, url: claimed.url }
			: null;
	}

	async provision(input: PrPreviewLaunchInput): Promise<PrPreviewProvisionResult> {
		try {
			await provisionVclusterPreview({
				name: input.alias,
				devMode: true,
				origin: "pr",
				prNumber: input.prNumber,
				ttlHours: input.ttlHours,
			});
			return { ok: true };
		} catch (err) {
			if (err instanceof VclusterPreviewHttpError && err.status === 429) {
				return { ok: false, capacity: true, detail: err.message };
			}
			return {
				ok: false,
				capacity: false,
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async get(alias: string): Promise<PrPreviewClusterInfo | null> {
		try {
			const preview = await getVclusterPreview(alias);
			if (preview.phase === "absent") return null;
			return { ready: preview.ready, phase: preview.phase, url: preview.url };
		} catch (err) {
			if (err instanceof VclusterPreviewHttpError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async counts(): Promise<{ awake: number; max: number } | null> {
		const { counts } = await listVclusterPreviewsWithCounts();
		return counts ? { awake: counts.awake, max: counts.max } : null;
	}

	async reap(): Promise<boolean> {
		return reapVclusterPreviews();
	}

	async teardown(alias: string): Promise<void> {
		await teardownVclusterPreview(alias);
	}
}

/**
 * Adopt dev-mode pods INSIDE the preview by calling the PREVIEW BFF's own
 * internal dev-preview route over its tailnet URL (preview-native provisioning
 * is served by the preview's own SEA; the shared INTERNAL_API_TOKEN authorizes
 * it — same value fleet-wide via the ExternalSecret chain). Pod IPs come back
 * host-reachable (vcluster pods are host pods).
 */
export class PreviewBffDevPodGateway implements PrPreviewDevPodPort {
	async provision(input: {
		previewUrl: string;
		alias: string;
		services: string[];
		syncToken: string;
	}): Promise<PrPreviewDevPodResult[]> {
		const base = input.previewUrl.replace(/\/+$/, "");
		const waitReadySeconds = 300;
		const res = await fetch(
			`${base}/api/internal/workflows/executions/${encodeURIComponent(input.alias)}/dev-preview`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": internalToken(),
				},
				body: JSON.stringify({
					services: input.services,
					mode: "preview-native",
					adopt: true,
					origin: base,
					syncToken: input.syncToken,
					waitReadySeconds,
				}),
				signal: AbortSignal.timeout(waitReadySeconds * 1000 + 60_000),
			},
		);
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			const detail =
				typeof body.error === "string"
					? body.error
					: `preview dev-pod provision failed (HTTP ${res.status})`;
			throw new Error(detail);
		}
		const services = Array.isArray(body.services) ? body.services : [];
		return services.map((raw) => {
			const s = raw as Record<string, unknown>;
			const info = (s.info ?? {}) as Record<string, unknown>;
			return {
				service: String(s.service ?? ""),
				ok: s.ok === true,
				podIp: typeof info.podIP === "string" ? info.podIP : null,
				syncPort: typeof info.syncPort === "number" ? info.syncPort : null,
				...(typeof s.error === "string" ? { error: s.error } : {}),
			};
		});
	}
}

/**
 * Seed the PR head into each adopted dev pod: one ephemeral helper pod (the
 * Promote `withGithubToken` pattern) clones the PR head once (depth 1, via
 * `pull/<n>/head` so forks work), stages each service's repoSubdir filtered by
 * syncPaths (+extraSync), and gzip-tar-POSTs to `http://<podIp>:<syncPort>/__sync`
 * with the `x-sync-token` header (the sidecar/plugin wire contract).
 */
export class HelperPodPrHeadSeeder implements PrPreviewSeedPort {
	async seed(input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
		syncToken: string;
	}): Promise<{ ok: boolean; detail: string | null }> {
		const helper = await provisionWorkspaceHelperPod(
			`pr-preview-${input.prNumber}`,
			"seed",
			{ withGithubToken: true, timeoutMinutes: 15 },
		);
		if (!helper) {
			return { ok: false, detail: "could not provision a helper pod for PR-head seed" };
		}
		const command = buildPrSeedCommand(input, prPreviewRepo());
		const result = await runHelperCommand(
			helper.baseUrl,
			helper.token,
			command,
			"/tmp",
			600_000,
		);
		if (!result) {
			return { ok: false, detail: "seed command failed (no pod response)" };
		}
		const output = `${result.stdout}\n${result.stderr}`;
		const err = output.match(/SEED_ERR=(\S+)/);
		if (err) return { ok: false, detail: `seed failed: ${err[1]}` };
		const failures: string[] = [];
		for (const target of input.targets) {
			const key = seedResultKey(target.service);
			const m = output.match(new RegExp(`${key}=(\\d{3})`));
			if (!m || !m[1].startsWith("2")) {
				failures.push(`${target.service}: HTTP ${m?.[1] ?? "none"}`);
			}
		}
		if (result.exitCode !== 0) {
			failures.push(`exit ${result.exitCode}`);
		}
		return failures.length
			? { ok: false, detail: `sync rejected: ${failures.join("; ")}` }
			: { ok: true, detail: null };
	}
}

function seedResultKey(service: string): string {
	return `SEED_${service.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/** Exported for tests: the fixed shell the seeding helper pod runs. */
export function buildPrSeedCommand(
	input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
		syncToken: string;
	},
	repo: string,
): string {
	const lines: string[] = [
		`set -e`,
		`GH="$GITHUB_TOKEN"`,
		`[ -n "$GH" ] || { echo "SEED_ERR=no_github_token"; exit 0; }`,
		`SYNC_TOKEN=${shQuote(input.syncToken)}`,
		`git config --global --add safe.directory '*' 2>/dev/null || true`,
		`rm -rf /tmp/pr-src && mkdir -p /tmp/pr-src && cd /tmp/pr-src`,
		`git init -q .`,
		`git remote add origin "https://x-access-token:$GH@github.com/${repo}.git"`,
		// pull/<n>/head resolves fork heads too (no fork clone URL needed).
		`git fetch -q --depth 1 origin "pull/${input.prNumber}/head" || { echo "SEED_ERR=fetch_failed"; exit 0; }`,
		`git checkout -q FETCH_HEAD`,
		`echo "SEED_HEAD=$(git rev-parse HEAD)"`,
		// A force-push between webhook and seed just means we ship the newer head.
		`[ "$(git rev-parse HEAD)" = ${shQuote(input.headSha)} ] || echo "SEED_WARN=head_moved"`,
	];
	for (const target of input.targets) {
		const sub = target.repoSubdir === "." ? "" : `/${target.repoSubdir.replace(/^\/+|\/+$/g, "")}`;
		const stage = `/tmp/stage-${target.service}`;
		lines.push(
			`# --- ${target.service} ---`,
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
		lines.push(
			`tar -czf /tmp/seed-${target.service}.tgz -C ${shQuote(stage)} .`,
			`CODE=$(curl -s -o /tmp/resp-${target.service} -w '%{http_code}' -X POST "http://${target.podIp}:${target.syncPort}/__sync" -H 'Content-Type: application/gzip' -H "x-sync-token: $SYNC_TOKEN" --data-binary @/tmp/seed-${target.service}.tgz || echo 000)`,
			`echo "${seedResultKey(target.service)}=$CODE"`,
		);
	}
	return lines.join("\n");
}

function shQuote(value: string): string {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** GitHub PR reads + the BFF-owned sticky verify comment (the main pr-preview
 * status comment is owned by the hub Tekton dispatch Task). */
export class GithubPrPreviewGateway implements PrPreviewPullRequestPort {
	private async headers(): Promise<Record<string, string>> {
		const token = await resolveWorkflowGithubToken();
		return {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};
	}

	async listChangedFiles(prNumber: number): Promise<string[] | null> {
		try {
			const headers = await this.headers();
			const files: string[] = [];
			for (let page = 1; page <= 3; page++) {
				const res = await fetch(
					`${GITHUB_API}/repos/${prPreviewRepo()}/pulls/${prNumber}/files?per_page=100&page=${page}`,
					{ headers },
				);
				if (!res.ok) return page === 1 ? null : files;
				const batch = (await res.json()) as Array<{ filename?: string }>;
				for (const f of batch) if (f.filename) files.push(f.filename);
				if (batch.length < 100) break;
			}
			return files;
		} catch {
			return null;
		}
	}

	async upsertStickyComment(input: {
		prNumber: number;
		marker: string;
		body: string;
	}): Promise<boolean> {
		try {
			const headers = await this.headers();
			const repo = prPreviewRepo();
			const list = await fetch(
				`${GITHUB_API}/repos/${repo}/issues/${input.prNumber}/comments?per_page=100`,
				{ headers },
			);
			const comments = list.ok
				? ((await list.json()) as Array<{ id: number; body?: string }>)
				: [];
			const existing = comments.find((c) => c.body?.includes(input.marker));
			const res = existing
				? await fetch(`${GITHUB_API}/repos/${repo}/issues/comments/${existing.id}`, {
						method: "PATCH",
						headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify({ body: input.body }),
					})
				: await fetch(`${GITHUB_API}/repos/${repo}/issues/${input.prNumber}/comments`, {
						method: "POST",
						headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify({ body: input.body }),
					});
			return res.ok;
		} catch {
			return false;
		}
	}
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
	}): Promise<{ started: boolean; executionId?: string | null; reason?: string | null }> {
		const workflowName = (
			env.PR_PREVIEW_VERIFY_WORKFLOW ??
			process.env.PR_PREVIEW_VERIFY_WORKFLOW ??
			""
		).trim();
		if (!workflowName) {
			return {
				started: false,
				reason:
					"no Playwright-critic workflow configured (set PR_PREVIEW_VERIFY_WORKFLOW to a seeded workflow name)",
			};
		}
		// Lazy import: start-run pulls in the composition root; a static import
		// here would cycle (index.ts → this adapter → start-run → index.ts).
		const { startWorkflowRun } = await import("$lib/server/workflows/start-run");
		const result = await startWorkflowRun({
			workflowName,
			triggerData: {
				previewUrl: input.previewUrl,
				prNumber: input.prNumber,
				headSha: input.headSha,
				source: "pr-preview-verify",
			},
			triggerSource: "pr-preview-verify",
		});
		if (!result.ok) return { started: false, reason: result.error };
		return { started: true, executionId: result.executionId };
	}

	async waitForVerdict(input: {
		executionId: string;
		timeoutMs: number;
	}): Promise<{ status: string; verdict: string | null }> {
		const { getApplicationAdapters } = await import("$lib/server/application");
		const workflowData = getApplicationAdapters().workflowData;
		const deadline = Date.now() + input.timeoutMs;
		for (;;) {
			const execution = await workflowData
				.getExecutionById(input.executionId)
				.catch(() => null);
			const status = execution?.status ?? "unknown";
			if (status === "success" || status === "error" || status === "cancelled") {
				const output = (execution?.output ?? null) as Record<string, unknown> | null;
				const verdict =
					output && typeof output.verdict === "string"
						? output.verdict
						: output
							? JSON.stringify(output).slice(0, 2000)
							: null;
				return { status: status === "success" ? "completed" : status, verdict };
			}
			if (Date.now() >= deadline) return { status: "timeout", verdict: null };
			await new Promise((r) => setTimeout(r, 15_000));
		}
	}
}
