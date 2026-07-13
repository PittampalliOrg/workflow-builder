<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		Activity,
		Box,
		CheckCircle2,
		CircleAlert,
		Clock3,
		ExternalLink,
		GitBranch,
		GitCommit,
		GitPullRequest,
		Layers3,
		Loader2,
		RefreshCw,
		Server,
		Workflow
	} from '@lucide/svelte';

	import PreviewRunsPanel from '$lib/components/dev/preview-runs-panel.svelte';
	import {
		effectivePreviewStatus,
		expiresIn,
		relativeTime
	} from '$lib/components/dev/preview-lifecycle';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Sheet from '$lib/components/ui/sheet';
	import {
		formatBootElapsed,
		previewDeliveryLabel,
		previewGitOpsHref,
		previewProfileLabel,
		previewRuntimePollInterval
	} from '$lib/dev/dev-operations-view';
	import type {
		VclusterPreviewRuntimeContainerView,
		VclusterPreviewRuntimeView,
		VclusterPreviewSummary
	} from '$lib/types/dev-previews';

	let {
		preview,
		open = false,
		readProxyEnabled = false,
		onOpenChange
	}: {
		preview: VclusterPreviewSummary | null;
		open?: boolean;
		readProxyEnabled?: boolean;
		onOpenChange: (open: boolean) => void;
	} = $props();

	let mounted = $state(false);
	let runtimeValue = $state<VclusterPreviewRuntimeView | null>(null);
	let runtimeName = $state<string | null>(null);
	let loading = $state(false);
	let refreshing = $state(false);
	let errorMessage = $state<string | null>(null);
	let observedAt = $state<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	let activePollingName: string | null = null;

	const runtime = $derived(runtimeName === preview?.name ? runtimeValue : null);
	const status = $derived(preview ? effectivePreviewStatus(preview) : 'unknown');
	const expiry = $derived(preview ? expiresIn(preview.expiresAt) : null);
	const bootElapsed = $derived(preview ? formatBootElapsed(preview.bootSeconds) : null);
	const gitOpsHref = $derived(preview ? previewGitOpsHref(preview) : null);
	const platformCommitHref = $derived(
		revisionUrl(repositoryValue('platformRepository'), preview?.platformRevision ?? null)
	);
	const sourceCommitHref = $derived(
		revisionUrl(repositoryValue('sourceRepository'), preview?.sourceRevision ?? null)
	);
	const pollInterval = $derived(
		preview ? previewRuntimePollInterval(preview, runtime) : 15_000
	);
	const pollLabel = $derived(`${Math.round(pollInterval / 1000)}s`);
	const observedContainers = $derived(
		runtime?.services.reduce((total, service) => total + service.containers.length, 0) ?? 0
	);
	const readyContainers = $derived(
		runtime?.services.reduce(
			(total, service) => total + service.containers.filter((container) => container.ready).length,
			0
		) ?? 0
	);
	const services = $derived.by(() => {
		const order: string[] = [];
		const byName = new Map<string, VclusterPreviewRuntimeContainerView[]>();
		for (const service of preview?.services ?? []) {
			if (!byName.has(service)) {
				order.push(service);
				byName.set(service, []);
			}
		}
		for (const service of runtime?.services ?? []) {
			if (!byName.has(service.service)) order.push(service.service);
			byName.set(service.service, service.containers);
		}
		return order.map((service) => ({ service, containers: byName.get(service) ?? [] }));
	});

	function stopPolling() {
		if (timer) clearTimeout(timer);
		timer = null;
		controller?.abort();
		controller = null;
		loading = false;
		refreshing = false;
	}

	function canPoll(): boolean {
		return mounted && open && !!preview && document.visibilityState === 'visible';
	}

	function scheduleNext() {
		if (!canPoll()) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void readRuntime(), pollInterval);
	}

	async function readRuntime() {
		const current = preview;
		if (!current || !canPoll()) return;
		const requestController = new AbortController();
		controller?.abort();
		controller = requestController;
		if (runtimeName !== current.name) {
			runtimeValue = null;
			runtimeName = current.name;
			observedAt = null;
			errorMessage = null;
		}
		loading = runtimeValue === null;
		refreshing = runtimeValue !== null;

		try {
			const response = await fetch(
				`/api/dev-environments/vcluster/${encodeURIComponent(current.name)}/runtime`,
				{ signal: requestController.signal }
			);
			if (!response.ok) {
				throw new Error(`Runtime observation unavailable (${response.status})`);
			}
			const body = (await response.json()) as { runtime: VclusterPreviewRuntimeView };
			if (preview?.name !== current.name || requestController.signal.aborted) return;
			runtimeValue = body.runtime;
			runtimeName = current.name;
			observedAt = Date.now();
			errorMessage = null;
		} catch (error) {
			if (!requestController.signal.aborted) {
				errorMessage = error instanceof Error ? error.message : 'Runtime observation failed';
			}
		} finally {
			if (controller === requestController) controller = null;
			if (!requestController.signal.aborted) {
				loading = false;
				refreshing = false;
				scheduleNext();
			}
		}
	}

	function restartPolling() {
		stopPolling();
		if (canPoll()) void readRuntime();
	}

	function handleVisibilityChange() {
		if (document.visibilityState === 'visible') {
			activePollingName = preview?.name ?? null;
			restartPolling();
		} else {
			activePollingName = null;
			stopPolling();
		}
	}

	$effect(() => {
		const selectedName = preview?.name ?? null;
		const shouldPoll = open && selectedName !== null;
		if (!mounted) return;
		untrack(() => {
			if (!shouldPoll || document.visibilityState !== 'visible') {
				activePollingName = null;
				stopPolling();
				return;
			}
			if (activePollingName === selectedName) return;
			activePollingName = selectedName;
			restartPolling();
		});
	});

	onMount(() => {
		mounted = true;
		document.addEventListener('visibilitychange', handleVisibilityChange);
			return () => {
				mounted = false;
				activePollingName = null;
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			stopPolling();
		};
	});

	function provisionStatus(snapshot: VclusterPreviewRuntimeView | null): string {
		if (!snapshot || !snapshot.provision.found) return 'not observed';
		if (snapshot.provision.failed) return 'failed';
		if (snapshot.provision.succeeded) return 'succeeded';
		if (snapshot.provision.active) return 'running';
		return 'pending';
	}

	function repositoryValue(key: 'platformRepository' | 'sourceRepository'): string | null {
		const value = preview?.provenance?.[key];
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function githubRepositoryUrl(repository: string | null): string | null {
		if (!repository) return null;
		const ssh = repository.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
		if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/i, '')}`;
		if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repository)) {
			return `https://github.com/${repository.replace(/\.git$/i, '')}`;
		}
		try {
			const url = new URL(repository);
			if (url.hostname !== 'github.com') return null;
			const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
			return path.split('/').length >= 2 ? `https://github.com/${path}` : null;
		} catch {
			return null;
		}
	}

	function revisionUrl(repository: string | null, revision: string | null): string | null {
		const repoUrl = githubRepositoryUrl(repository);
		return repoUrl && revision ? `${repoUrl}/commit/${encodeURIComponent(revision)}` : null;
	}

	function compactImage(image: string): string {
		return image.replace(/^ghcr\.io\/pittampalliorg\//, '');
	}
</script>

<Sheet.Root {open} onOpenChange={onOpenChange}>
	<Sheet.Content side="right" class="flex w-full min-h-0 flex-col gap-0 p-0 sm:max-w-2xl">
		{#if preview}
			<Sheet.Header class="space-y-2 border-b px-5 py-4 pr-14">
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					<Sheet.Title class="min-w-0 truncate font-mono text-base">{preview.name}</Sheet.Title>
					<StatusPill {status} />
					<Badge variant="outline" class="h-5 text-[10px]">{previewProfileLabel(preview.profile)}</Badge>
				</div>
				<Sheet.Description class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					<span>{previewDeliveryLabel(preview)}</span>
					<span>{preview.targetCluster}</span>
					{#if observedAt}
						<span class="inline-flex items-center gap-1">
							<Activity class="size-3 {errorMessage ? 'text-amber-500' : 'text-emerald-500'}" />
							observed {new Date(observedAt).toLocaleTimeString()}
						</span>
					{/if}
				</Sheet.Description>
			</Sheet.Header>

			<div class="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-5 py-2.5">
				{#if preview.ready && preview.url}
					<Button size="sm" href={preview.url} target="_blank" rel="noreferrer">
						Open app <ExternalLink class="size-3.5" />
					</Button>
				{/if}
				{#if preview.prUrl}
					<Button size="sm" variant="outline" href={preview.prUrl} target="_blank" rel="noreferrer">
						<GitPullRequest class="size-3.5" /> PR #{preview.prNumber}
					</Button>
				{/if}
				{#if gitOpsHref}
					<Button size="sm" variant="outline" href={gitOpsHref}>
						<GitBranch class="size-3.5" /> Change journey
					</Button>
				{/if}
				<Button
					size="icon-sm"
					variant="ghost"
					class="ml-auto"
					onclick={restartPolling}
					disabled={loading || refreshing}
					title="Refresh runtime observation"
					aria-label="Refresh runtime observation"
				>
					{#if loading || refreshing}<Loader2 class="size-3.5 motion-safe:animate-spin" />{:else}<RefreshCw class="size-3.5" />{/if}
				</Button>
				<span class="text-[10px] text-muted-foreground">auto-refresh {pollLabel}</span>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto">
				{#if errorMessage}
					<div class="flex items-start gap-2 border-b bg-amber-500/5 px-5 py-3 text-xs text-amber-700 dark:text-amber-300" role="status">
						<CircleAlert class="mt-0.5 size-3.5 shrink-0" />
						<div>
							<div class="font-medium">{errorMessage}</div>
							{#if runtime}<div class="mt-0.5 opacity-80">Showing the last successful observation.</div>{/if}
						</div>
					</div>
				{/if}

				<section class="border-b px-5 py-4" aria-labelledby="preview-runtime-heading">
					<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
						<div>
							<h3 id="preview-runtime-heading" class="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
								<Server class="size-3.5" /> Runtime and lifecycle
							</h3>
							<p class="mt-1 text-[11px] text-muted-foreground">Authorized runtime observations, not aggregate cluster telemetry.</p>
						</div>
						{#if loading && !runtime}<span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 class="size-3.5 motion-safe:animate-spin" /> Reading runtime</span>{/if}
					</div>

					<div class="grid overflow-hidden rounded-md border sm:grid-cols-3">
						<div class="space-y-1 border-b px-3 py-2.5 sm:border-r sm:border-b-0">
							<div class="text-[10px] uppercase text-muted-foreground">Lifecycle</div>
							<StatusPill {status} variant="text" class="text-xs" />
							<div class="text-[10px] text-muted-foreground">phase {preview.phase}</div>
						</div>
						<div class="space-y-1 border-b px-3 py-2.5 sm:border-r sm:border-b-0">
							<div class="text-[10px] uppercase text-muted-foreground">Reconciliation</div>
							{#if runtime?.reconciliationSucceeded}
								<span class="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"><CheckCircle2 class="size-3.5" /> Succeeded</span>
							{:else}
								<span class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground"><Clock3 class="size-3.5" /> {runtime ? 'Not yet succeeded' : 'Not observed'}</span>
							{/if}
							<div class="text-[10px] text-muted-foreground">Tuple-bound desired state</div>
						</div>
						<div class="space-y-1 px-3 py-2.5">
							<div class="text-[10px] uppercase text-muted-foreground">Provision job</div>
							<StatusPill status={provisionStatus(runtime)} variant="text" class="text-xs" />
							<div class="text-[10px] text-muted-foreground">Normalized provision state</div>
						</div>
					</div>

					<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
						{#if bootElapsed}<span>provisioning elapsed <span class="font-mono tabular-nums text-foreground">{bootElapsed}</span></span>{/if}
						{#if preview.pool}<span>allocation <span class="font-mono text-foreground">{preview.pool}</span></span>{/if}
						{#if preview.lastActive}<span>active {relativeTime(preview.lastActive)}</span>{/if}
						{#if expiry}<span class={expiry.urgent ? 'text-amber-600 dark:text-amber-400' : ''}>{expiry.label}</span>{/if}
						{#if preview.protected}<span>protected from automatic lifecycle actions</span>{/if}
					</div>
				</section>

				<section class="border-b px-5 py-4" aria-labelledby="preview-services-heading">
					<div class="mb-3 flex items-center justify-between gap-2">
						<div>
							<h3 id="preview-services-heading" class="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
								<Layers3 class="size-3.5" /> Services
							</h3>
							<p class="mt-1 text-[11px] text-muted-foreground">Observed pod containers and the images they report.</p>
						</div>
						{#if runtime}<span class="font-mono text-[11px] tabular-nums text-muted-foreground">{readyContainers}/{observedContainers} ready</span>{/if}
					</div>

					{#if services.length === 0}
						<div class="border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">No services are declared for this preview.</div>
					{:else}
						<div class="divide-y rounded-md border">
							{#each services as service (service.service)}
								<div class="px-3 py-3">
									<div class="flex items-center justify-between gap-2">
										<div class="flex min-w-0 items-center gap-2">
											<Box class="size-3.5 shrink-0 text-muted-foreground" />
											<span class="truncate text-xs font-medium">{service.service}</span>
										</div>
										<span class="text-[10px] text-muted-foreground">{service.containers.filter((container) => container.ready).length}/{service.containers.length} observed ready</span>
									</div>
									{#if service.containers.length === 0}
										<p class="mt-2 text-[11px] text-muted-foreground">No pod container observation has been reported yet.</p>
									{:else}
										<div class="mt-2 divide-y border-t">
									{#each service.containers as container, index (`${container.image}:${index}`)}
										<div class="grid gap-1 py-2 text-[11px] sm:grid-cols-[2rem_minmax(12rem,1fr)_auto] sm:items-center sm:gap-3">
											<span class="font-mono text-muted-foreground">#{index + 1}</span>
											<span class="truncate font-mono" title={container.image}>{compactImage(container.image)}</span>
											<span class="inline-flex items-center gap-1 {container.ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">
												{#if container.ready}<CheckCircle2 class="size-3" /> Ready{:else}<Clock3 class="size-3" /> Not ready{/if}
											</span>
										</div>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="border-b px-5 py-4" aria-labelledby="preview-delivery-heading">
					<div class="mb-3">
						<h3 id="preview-delivery-heading" class="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
							<GitBranch class="size-3.5" /> Delivery
						</h3>
					<p class="mt-1 text-[11px] text-muted-foreground">
						{preview.mode === 'reconciled' || preview.origin?.kind === 'pull-request'
							? 'Git-backed desired state and its resolved immutable revisions are authoritative for this candidate.'
							: 'The base revisions are immutable, while live-synced workspace changes are disposable and are not Argo CD desired state.'}
					</p>
					</div>

					<div class="divide-y rounded-md border">
						<div class="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
							<span class="text-[10px] uppercase text-muted-foreground">Platform revision</span>
							<code class="break-all text-[11px]">{preview.platformRevision ?? 'Not reported'}</code>
							{#if platformCommitHref}<a href={platformCommitHref} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"><GitCommit class="size-3" /> GitHub <ExternalLink class="size-3" /></a>{/if}
						</div>
						<div class="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
							<span class="text-[10px] uppercase text-muted-foreground">Source revision</span>
							<code class="break-all text-[11px]">{preview.sourceRevision ?? 'Not reported'}</code>
							{#if sourceCommitHref}<a href={sourceCommitHref} target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"><GitCommit class="size-3" /> GitHub <ExternalLink class="size-3" /></a>{/if}
						</div>
						<div class="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-3">
							<span class="text-[10px] uppercase text-muted-foreground">Profile and mode</span>
							<span class="text-[11px]">{previewProfileLabel(preview.profile)} · {preview.lane ?? 'application'} · {preview.mode ?? 'legacy'}</span>
						</div>
						{#if preview.catalogDigest}
							<div class="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-3">
								<span class="text-[10px] uppercase text-muted-foreground">Catalog digest</span>
								<code class="break-all text-[11px]">{preview.catalogDigest}</code>
							</div>
						{/if}
					</div>
				</section>

				<section class="px-5 py-4" aria-labelledby="preview-workflows-heading">
					<div class="mb-3">
						<h3 id="preview-workflows-heading" class="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
							<Workflow class="size-3.5" /> Workflows
						</h3>
						<p class="mt-1 text-[11px] text-muted-foreground">Runs reported by this preview's workflow-builder API.</p>
					</div>
					{#if readProxyEnabled && preview.ready}
						<PreviewRunsPanel name={preview.name} url={preview.url} limit={12} />
					{:else if !preview.ready}
						<div class="border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">Workflow runs become available when the preview reports ready.</div>
					{:else}
							<div class="border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">Fleet workflow history is unavailable in this deployment.</div>
					{/if}
				</section>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
