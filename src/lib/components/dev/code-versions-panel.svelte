<!--
	Code checkpoints for one dev execution. Strict atomic preview captures cross the
	preview-session continuation boundary; legacy bundles retain the generic
	version promotion path used by non-preview workflows.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import {
		CheckCircle2,
		ExternalLink,
		GitPullRequest,
		Loader2,
		RefreshCw,
		Save,
		ShieldCheck
	} from '@lucide/svelte';
	import {
		promoteStrictCheckpointUntilConfirmed,
		strictCheckpointPromotionReceiptFromVersion,
		type StrictCheckpointPromotionProgress
	} from '$lib/dev-preview-checkpoint-promotion';
	import CodePromotionChain from '../workflow/code/code-promotion-chain.svelte';

	type PullRequestReceipt = {
		repository?: string | null;
		number?: number | null;
	};
	type VersionPayload = {
		tier?: string;
		iteration?: number | null;
		repoUrl?: string | null;
		repoSubdir?: string | null;
		syncPaths?: string[] | null;
		services?: string[] | null;
		serviceCount?: number | null;
		generation?: string | null;
		captureProtocol?: string | null;
		acceptanceEligible?: boolean | null;
	} | null;
	type Promotion = {
		prUrl?: string | null;
		branch?: string | null;
		commitSha?: string | null;
		baseSha?: string | null;
		headSha?: string | null;
		mode?: string;
		promotedAt?: string;
		receiptId?: string | null;
		repository?: string | null;
		pullRequestNumber?: number | null;
		pullRequest?: PullRequestReceipt | null;
	} | null;
	type Acceptance = {
		ok?: boolean;
		acceptedAt?: string | null;
		receiptId?: string | null;
		stage?: string | null;
		message?: string | null;
		evidenceReceiptDigest?: string | null;
	} | null;
	type Version = {
		artifactId: string;
		executionId: string;
		nodeId: string | null;
		fileId: string | null;
		sizeBytes: number | null;
		title: string | null;
		payload: VersionPayload;
		promotion: Promotion;
		acceptance: Acceptance;
		createdAt: string;
	};
	type ContinuationResponse = {
		action?: string;
		ok?: boolean;
		artifactId?: string;
		receiptId?: string;
		generation?: string | null;
		captureId?: string;
		bytes?: number;
		skipped?: string;
		services?: Array<{ service?: string | null; ok?: boolean } | string>;
		prUrl?: string | null;
		branch?: string | null;
		pullRequest?: PullRequestReceipt | null;
		prError?: string | null;
		stage?: string | null;
		evidenceReceiptDigest?: string | null;
		error?: string;
		message?: string;
	};
	type VersionResult = {
		prUrl?: string | null;
		branch?: string | null;
		receiptId?: string | null;
		promotionProgress?: StrictCheckpointPromotionProgress;
		promotionError?: string;
		accepted?: boolean;
		stage?: string | null;
		evidenceReceiptDigest?: string | null;
		acceptanceError?: string;
	};

	let {
		executionId,
		services,
		live = false,
		sourceReadOnly = false,
		onoutstanding,
		oncapability
	}: {
		executionId: string;
		/** Complete service set for one coherent strict capture. */
		services: string[];
		live?: boolean;
		sourceReadOnly?: boolean;
		/** Current strict-snapshot debt plus independent legacy version debt. */
		onoutstanding?: (count: number) => void;
		oncapability?: (allowed: boolean) => void;
	} = $props();

	let versions = $state<Version[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let capturing = $state(false);
	let promoting = $state<string | null>(null);
	let accepting = $state<string | null>(null);
	let captureState = $state<{
		ok: boolean;
		artifactId?: string;
		generation?: string | null;
		error?: string;
	} | null>(null);
	let results = $state<Record<string, VersionResult>>({});
	let outstandingCount = $state(0);
	let canManageStrictCheckpoints = $state(false);
	let latestStrictArtifactId = $state<string | null>(null);

	function fmtBytes(n: number | null): string {
		if (!n) return '—';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function isStrictPreviewVersion(version: Version): boolean {
		return (
			version.payload?.tier === 'tar-overlay-set' &&
			(version.payload.captureProtocol === 'atomic-generation-v2' ||
				version.payload.acceptanceEligible === true)
		);
	}

	function pullRequestUrl(receipt: PullRequestReceipt | null | undefined): string | null {
		const repository = receipt?.repository?.trim();
		const number = receipt?.number;
		if (
			!repository ||
			typeof number !== 'number' ||
			!Number.isSafeInteger(number) ||
			number < 1
		) {
			return null;
		}
		return `https://github.com/${repository}/pull/${number}`;
	}

	function prUrlFor(version: Version): string | null {
		const storedUrl = version.promotion?.prUrl?.trim();
		if (storedUrl) return storedUrl;
		return (
			pullRequestUrl(
				version.promotion?.pullRequest ?? {
					repository: version.promotion?.repository,
					number: version.promotion?.pullRequestNumber
				}
			) ??
			results[version.artifactId]?.prUrl?.trim() ??
			null
		);
	}

	function responseError(body: ContinuationResponse, fallback: string): string {
		return body.error || body.message || body.prError || body.skipped || fallback;
	}

	function updateResult(artifactId: string, result: VersionResult) {
		results = { ...results, [artifactId]: result };
	}

	function reconcilePersistedPromotions(nextVersions: Version[]) {
		let changed = false;
		const nextResults = { ...results };
		for (const version of nextVersions) {
			const receipt = strictCheckpointPromotionReceiptFromVersion(
				version,
				version.artifactId
			);
			if (!receipt) continue;
			const current = nextResults[version.artifactId] ?? {};
			if (
				current.prUrl === receipt.prUrl &&
				current.branch === receipt.branch &&
				current.receiptId === receipt.receiptId &&
				current.promotionProgress === undefined &&
				current.promotionError === undefined
			) {
				continue;
			}
			nextResults[version.artifactId] = {
				...current,
				prUrl: receipt.prUrl,
				branch: receipt.branch,
				receiptId: receipt.receiptId,
				promotionProgress: undefined,
				promotionError: undefined
			};
			changed = true;
		}
		if (changed) results = nextResults;
	}

	async function load() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/versions`);
			if (!res.ok) throw new Error(`Checkpoint history request failed (${res.status})`);
			const body = (await res.json()) as {
				versions?: Version[];
				unpromotedCount?: unknown;
				canManageStrictCheckpoints?: unknown;
				latestStrictArtifactId?: unknown;
			};
			if (
				!Array.isArray(body.versions) ||
				typeof body.unpromotedCount !== 'number' ||
				!Number.isSafeInteger(body.unpromotedCount) ||
				body.unpromotedCount < 0 ||
				(body.latestStrictArtifactId !== null &&
					typeof body.latestStrictArtifactId !== 'string')
			) {
				throw new Error('Checkpoint history response was invalid');
			}
			reconcilePersistedPromotions(body.versions);
			versions = body.versions;
			latestStrictArtifactId = body.latestStrictArtifactId;
			outstandingCount = body.unpromotedCount;
			canManageStrictCheckpoints = body.canManageStrictCheckpoints === true;
			oncapability?.(canManageStrictCheckpoints);
			onoutstanding?.(outstandingCount);
			loadError = null;
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Checkpoint history is unavailable';
		} finally {
			loading = false;
		}
	}

	async function captureCheckpoint() {
		if (capturing || promoting || accepting || services.length === 0 || sourceReadOnly) return;
		capturing = true;
		captureState = null;
		try {
			const res = await fetch(`/api/dev-environments/${executionId}/preview-continuation`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'capture', services })
			});
			const body = (await res.json().catch(() => ({}))) as ContinuationResponse;
			if (!res.ok || body.action !== 'capture' || body.ok !== true || !body.artifactId) {
				captureState = {
					ok: false,
					error: responseError(body, `Capture failed (${res.status})`)
				};
				return;
			}
			captureState = {
				ok: true,
				artifactId: body.artifactId,
				generation: body.generation ?? null
			};
			await load();
		} catch (error) {
			captureState = {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			};
		} finally {
			capturing = false;
		}
	}

	async function promote(version: Version) {
		if (capturing || promoting || accepting) return;
		const strict = isStrictPreviewVersion(version);
		if (
			strict &&
			(!canManageStrictCheckpoints || version.artifactId !== latestStrictArtifactId)
		) {
			return;
		}
		promoting = version.artifactId;
		updateResult(version.artifactId, {
			...results[version.artifactId],
			promotionProgress: 'submitting',
			promotionError: undefined
		});
		try {
			if (strict) {
				const receipt = await promoteStrictCheckpointUntilConfirmed(
					executionId,
					version.artifactId,
					version.title,
					{
						onProgress: (promotionProgress) =>
							updateResult(version.artifactId, {
								...results[version.artifactId],
								promotionProgress:
									promotionProgress === 'complete' ? undefined : promotionProgress,
								promotionError: undefined
							})
					}
				);
				updateResult(version.artifactId, {
					...results[version.artifactId],
					prUrl: receipt.prUrl,
					branch: receipt.branch,
					receiptId: receipt.receiptId,
					promotionProgress: undefined,
					promotionError: undefined
				});
				await load();
				return;
			}
			const res = await fetch(
				`/api/workflows/executions/${executionId}/versions/${version.artifactId}/promote`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mode: 'pr' })
				}
			);
			const body = (await res.json().catch(() => ({}))) as ContinuationResponse;
			const prUrl = body.prUrl?.trim() || pullRequestUrl(body.pullRequest);
			if (
				!res.ok ||
				body.ok === false ||
				!prUrl
			) {
				updateResult(version.artifactId, {
					...results[version.artifactId],
					promotionProgress: undefined,
					promotionError: responseError(body, `Promotion failed (${res.status})`)
				});
				return;
			}
			updateResult(version.artifactId, {
				...results[version.artifactId],
				prUrl,
				branch: body.branch,
				receiptId: body.receiptId,
				promotionProgress: undefined,
				promotionError: undefined
			});
			await load();
		} catch (error) {
			updateResult(version.artifactId, {
				...results[version.artifactId],
				promotionProgress: undefined,
				promotionError: error instanceof Error ? error.message : String(error)
			});
		} finally {
			if (results[version.artifactId]?.promotionProgress) {
				updateResult(version.artifactId, {
					...results[version.artifactId],
					promotionProgress: undefined
				});
			}
			promoting = null;
		}
	}

	async function runAcceptance(version: Version) {
		if (
			capturing ||
			promoting ||
			accepting ||
			!isStrictPreviewVersion(version) ||
			!canManageStrictCheckpoints ||
			version.artifactId !== latestStrictArtifactId
		) {
			return;
		}
		accepting = version.artifactId;
		try {
			const res = await fetch(`/api/dev-environments/${executionId}/preview-continuation`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'acceptance', artifactId: version.artifactId })
			});
			const body = (await res.json().catch(() => ({}))) as ContinuationResponse;
			if (!res.ok || body.action !== 'acceptance' || body.ok !== true) {
				updateResult(version.artifactId, {
					...results[version.artifactId],
					accepted: false,
					stage: body.stage,
					evidenceReceiptDigest: body.evidenceReceiptDigest,
					acceptanceError: responseError(body, `Acceptance failed (${res.status})`)
				});
				return;
			}
			updateResult(version.artifactId, {
				...results[version.artifactId],
				accepted: true,
				receiptId: body.receiptId ?? results[version.artifactId]?.receiptId,
				stage: body.stage,
				evidenceReceiptDigest: body.evidenceReceiptDigest,
				acceptanceError: undefined
			});
			await load();
		} catch (error) {
			updateResult(version.artifactId, {
				...results[version.artifactId],
				accepted: false,
				acceptanceError: error instanceof Error ? error.message : String(error)
			});
		} finally {
			accepting = null;
		}
	}

	onMount(() => void load());
	$effect(() => {
		if (!live) return;
		const timer = setInterval(() => void load(), 6000);
		return () => clearInterval(timer);
	});
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<h3 class="text-sm font-medium">Code checkpoints</h3>
			{#if !loading && versions.length > 0}
				{#if outstandingCount > 0}
					<Badge
						variant="outline"
						class="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
						title="Not yet represented by a GitHub pull request"
					>
						{outstandingCount} not pushed
					</Badge>
				{:else}
					<Badge variant="outline" class="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
						current state pushed
					</Badge>
				{/if}
			{/if}
		</div>
		<div class="flex items-center gap-1">
			<Button
				variant="outline"
				size="sm"
				class="h-8"
				disabled={
					capturing ||
					Boolean(promoting) ||
					Boolean(accepting) ||
					services.length === 0 ||
					sourceReadOnly
				}
				onclick={() => void captureCheckpoint()}
			>
				{#if capturing}<Loader2 class="size-3.5 animate-spin" />{:else}<Save class="size-3.5" />{/if}
				{capturing ? 'Capturing…' : 'Capture checkpoint'}
			</Button>
			<Button variant="ghost" size="icon" class="size-8" onclick={() => void load()} title="Refresh">
				<RefreshCw class="size-3.5" />
			</Button>
		</div>
	</div>

	{#if loadError}
		<div
			class="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
			role="alert"
		>
			{loadError}{versions.length > 0 ? ' Showing the last successfully loaded checkpoint data.' : ''}
		</div>
	{/if}

	{#if captureState}
		<div
			class="rounded-md border px-2.5 py-2 text-xs {captureState.ok
				? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
				: 'border-destructive/30 bg-destructive/5 text-destructive'}"
			role="status"
			aria-live="polite"
		>
			{#if captureState.ok}
				<span class="inline-flex items-center gap-1.5">
					<CheckCircle2 class="size-3.5" /> Checkpoint captured
					{#if captureState.generation}
						<code title={captureState.generation}>{captureState.generation.slice(0, 8)}</code>
					{/if}
				</span>
			{:else}
				{captureState.error}
			{/if}
		</div>
	{/if}

	{#if loading}
		<p class="text-xs text-muted-foreground">Loading checkpoints…</p>
	{:else if versions.length === 0 && !loadError}
		<p class="text-xs text-muted-foreground">No code checkpoints captured yet.</p>
	{:else if versions.length > 0}
		<ul class="space-y-2">
			{#each versions as version (version.artifactId)}
				{@const result = results[version.artifactId]}
				{@const prUrl = prUrlFor(version)}
				{@const strict = isStrictPreviewVersion(version)}
				{@const historical = strict && version.artifactId !== latestStrictArtifactId}
				{@const snapshotSha = version.promotion?.commitSha ?? version.promotion?.headSha ?? null}
				{@const accepted = version.acceptance?.ok === true || result?.accepted === true}
				{@const receiptId =
					result?.receiptId ?? version.promotion?.receiptId ?? version.acceptance?.receiptId}
				<li class="space-y-1.5 rounded-md border p-2.5 text-xs">
					<div class="flex flex-wrap items-center gap-2">
						{#if version.payload?.iteration != null}
							<Badge variant="secondary">iter {version.payload.iteration}</Badge>
						{/if}
						<Badge variant="outline">{version.payload?.tier ?? 'full'}</Badge>
						{#if strict}<Badge variant="outline">atomic</Badge>{/if}
						{#if historical}<Badge variant="secondary">history</Badge>{/if}
						{#if version.payload?.serviceCount}
							<span class="text-muted-foreground">{version.payload.serviceCount} services</span>
						{/if}
						<span class="text-muted-foreground">{fmtBytes(version.sizeBytes)}</span>
						<span class="ml-auto text-muted-foreground">
							{new Date(version.createdAt).toLocaleString()}
						</span>
					</div>
					{#if version.payload?.generation}
						<p class="truncate text-muted-foreground" title={version.payload.generation}>
							generation <code>{version.payload.generation}</code>
						</p>
					{/if}
					<div class="flex flex-wrap items-center gap-2">
						{#if historical}
							<span class="text-muted-foreground" title={snapshotSha ?? undefined}>
								{#if snapshotSha}
									snapshot <code>{snapshotSha.slice(0, 12)}</code>
								{:else}
									historical snapshot · read-only
								{/if}
							</span>
						{:else if prUrl}
							<a
								href={prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-medium text-emerald-600 hover:underline dark:text-emerald-400"
							>
								<GitPullRequest class="size-3.5" /> {strict ? 'Stable draft PR' : 'Pull request'}
								<ExternalLink class="size-3" />
							</a>
							{#if strict}
								{#if historical}
									<span class="text-muted-foreground">read-only history</span>
								{:else if canManageStrictCheckpoints}
									<Button
										variant="outline"
										size="sm"
										class="h-7"
										disabled={capturing || Boolean(promoting) || Boolean(accepting) || accepted}
										onclick={() => void runAcceptance(version)}
									>
										{#if accepting === version.artifactId}
											<Loader2 class="size-3.5 animate-spin" /> Checking…
										{:else if accepted}
											<CheckCircle2 class="size-3.5" /> Accepted
										{:else}
											<ShieldCheck class="size-3.5" /> Run acceptance
										{/if}
									</Button>
								{:else if !accepted}
									<Badge variant="secondary">Admin required</Badge>
								{/if}
							{:else}
								<Button
									variant="ghost"
									size="sm"
									class="h-7 text-muted-foreground"
									disabled={capturing || Boolean(promoting) || Boolean(accepting) || !version.fileId}
									onclick={() => void promote(version)}
								>
									{promoting === version.artifactId ? 'Promoting…' : 'Promote again'}
								</Button>
							{/if}
						{:else if strict && historical}
							<span class="text-muted-foreground">historical snapshot · read-only</span>
						{:else if strict && !canManageStrictCheckpoints}
							<Badge variant="secondary">Admin required</Badge>
							<span class="text-amber-600 dark:text-amber-400">not pushed to GitHub</span>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="h-7"
								disabled={capturing || Boolean(promoting) || Boolean(accepting) || !version.fileId}
								onclick={() => void promote(version)}
							>
								{#if promoting === version.artifactId}
									<Loader2 class="size-3.5 animate-spin" />
									{result?.promotionProgress === 'confirming' ? 'Confirming…' : 'Promoting…'}
								{:else}
									<GitPullRequest class="size-3.5" />
									{strict ? 'Create draft PR' : 'Create pull request'}
								{/if}
							</Button>
							<span class="text-amber-600 dark:text-amber-400">not pushed to GitHub</span>
						{/if}
						{#if accepted}
							<Badge variant="outline" class="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
								acceptance passed
							</Badge>
						{:else if version.acceptance?.ok === false || result?.accepted === false}
							<Badge variant="outline" class="border-destructive/40 text-destructive">acceptance failed</Badge>
						{/if}
					</div>
					{#if prUrl && !historical}
						<CodePromotionChain
							{prUrl}
							version={version.payload?.tier ??
								(version.payload?.iteration != null ? `iter ${version.payload.iteration}` : null)}
						/>
					{/if}
					{#if receiptId}
						<p class="truncate text-muted-foreground" title={receiptId}>
							receipt <code>{receiptId}</code>
						</p>
					{/if}
					{#if result?.promotionProgress}
						<p
							class="inline-flex items-center gap-1.5 text-muted-foreground"
							role="status"
							aria-live="polite"
						>
							<Loader2 class="size-3.5 motion-safe:animate-spin" />
							{result.promotionProgress === 'confirming'
								? 'Connection changed. Verifying the exact GitHub receipt…'
								: 'Submitting this checkpoint to the stable draft PR…'}
						</p>
					{/if}
					{#if result?.promotionError}
						<p class="text-destructive">{result.promotionError}</p>
					{/if}
					{#if result?.acceptanceError}
						<p class="text-destructive">{result.acceptanceError}</p>
					{/if}
					{#if result?.stage || version.acceptance?.stage}
						<p class="text-muted-foreground">
							acceptance stage <code>{result?.stage ?? version.acceptance?.stage}</code>
						</p>
					{/if}
					{#if version.acceptance?.message && !result?.acceptanceError}
						<p class="text-destructive">{version.acceptance.message}</p>
					{/if}
					{#if result?.evidenceReceiptDigest || version.acceptance?.evidenceReceiptDigest}
						{@const evidence =
							result?.evidenceReceiptDigest ?? version.acceptance?.evidenceReceiptDigest}
						<p class="truncate text-muted-foreground" title={evidence ?? undefined}>
							evidence <code>{evidence}</code>
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
