<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		AlertTriangle,
		CheckCircle2,
		CircleSlash,
		Clock3,
		Container,
		GitCommit,
		RefreshCw,
		Server
	} from '@lucide/svelte';

	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import {
		GITOPS_EVENT_REFRESH_DEBOUNCE_MS,
		gitOpsDeploymentMetadataUrl,
		shouldRefreshGitOpsMetadata
	} from '$lib/gitops/event-driven-refresh';
	import type {
		DeploymentMetadataResponse,
		GitOpsInventoryApplication,
		GitOpsInventoryEnvironment,
		LiveContainerMetadata,
		LiveDeploymentMetadata
	} from '$lib/types/deployment-metadata';
	import type { GitOpsActivityEvent } from '$lib/types/gitops-activity';

	type LiveRow = LiveContainerMetadata & {
		deployment: LiveDeploymentMetadata;
	};
	type InventoryRow = {
		environment: GitOpsInventoryEnvironment;
		application: GitOpsInventoryApplication;
	};

	let metadata = $state<DeploymentMetadataResponse | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let activityEventSource: EventSource | null = null;
	let activityReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let filter = $state<'all' | 'tracked' | 'drift' | 'untracked'>('all');

	const releasePinApplies = $derived(
		metadata?.environment.name === 'dev' || metadata?.environment.name === 'staging'
	);

	const rows = $derived(
		(metadata?.live.deployments ?? []).flatMap((deployment) =>
			deployment.containers.map((container) => ({ ...container, deployment }))
		)
	);
	const inventoryRows = $derived<InventoryRow[]>(
		(metadata?.inventory.data?.environments ?? []).flatMap((environment) =>
			environment.applications.map((application) => ({ environment, application }))
		)
	);

	const filteredRows = $derived(
		rows.filter((row) => {
			if (filter === 'all') return true;
			if (filter === 'tracked') return Boolean(row.pinKey);
			if (filter === 'drift') return releasePinApplies && row.desiredMatches === false;
			return !row.pinKey;
		})
	);

	const stats = $derived({
		deployments: metadata?.live.deployments.length ?? 0,
			containers: rows.length,
			tracked: rows.filter((row) => row.pinKey).length,
			drift: releasePinApplies ? rows.filter((row) => row.desiredMatches === false).length : 0
	});
	const inventoryStats = $derived({
		environments: metadata?.inventory.data?.environments.length ?? 0,
		applications: inventoryRows.length,
		inSync: inventoryRows.filter((row) => row.application.drift.status === 'in_sync').length,
		pending: inventoryRows.filter((row) => row.application.drift.status === 'pending_rollout').length
	});

	async function refresh(options: { fresh?: boolean } = {}) {
		loading = true;
		try {
			const res = await fetch(gitOpsDeploymentMetadataUrl(options));
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			metadata = (await res.json()) as DeploymentMetadataResponse;
			const errors = [
				metadata.live.error,
				metadata.gitops.releasePinsError,
				metadata.inventory.error
			].filter((message): message is string => Boolean(message));
			errorMessage = errors.length ? errors.join(' / ') : null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		startFallbackPolling();
		connectActivityStream();
	});

	onDestroy(() => {
		stopFallbackPolling();
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		closeActivityStream();
		if (activityReconnectTimer) clearTimeout(activityReconnectTimer);
	});

	function startFallbackPolling() {
		if (!timer) timer = setInterval(() => void refresh(), 15_000);
	}

	function stopFallbackPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	function scheduleEventRefresh(event: GitOpsActivityEvent) {
		if (!shouldRefreshGitOpsMetadata(event)) return;
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		eventRefreshTimer = setTimeout(() => {
			eventRefreshTimer = null;
			void refresh({ fresh: true });
		}, GITOPS_EVENT_REFRESH_DEBOUNCE_MS);
	}

	function closeActivityStream() {
		activityEventSource?.close();
		activityEventSource = null;
	}

	function connectActivityStream() {
		closeActivityStream();
		if (activityReconnectTimer) {
			clearTimeout(activityReconnectTimer);
			activityReconnectTimer = null;
		}
		const es = new EventSource('/api/v1/gitops/events/stream?since=latest');
		activityEventSource = es;
		es.onopen = () => {
			stopFallbackPolling();
		};
		es.addEventListener('gitops.event', (event) => {
			try {
				scheduleEventRefresh(JSON.parse((event as MessageEvent<string>).data) as GitOpsActivityEvent);
			} catch {
				/* keep the fallback poll responsible for recovery */
			}
		});
		es.onerror = () => {
			es.close();
			startFallbackPolling();
			if (!activityReconnectTimer) {
				activityReconnectTimer = setTimeout(() => {
					activityReconnectTimer = null;
					connectActivityStream();
				}, 5_000);
			}
		};
	}

	function shortSha(sha: string | null | undefined): string {
		return sha ? sha.slice(0, 8) : '—';
	}

	function shortImage(image: string): string {
		if (image.length <= 82) return image;
		const lastSlash = image.lastIndexOf('/');
		const lastColon = image.lastIndexOf(':');
		const hasTag = lastColon > lastSlash;
		if (!hasTag) return `${image.slice(0, 78)}...`;
		const repo = image.slice(0, lastColon);
		const tag = image.slice(lastColon + 1);
		const tail = `${repo.split('/').slice(-2).join('/')}:${tag}`;
		return tail.length <= 82 ? tail : `${tail.slice(0, 78)}...`;
	}

	function shortImageId(imageID: string | null | undefined): string {
		if (!imageID) return '—';
		const digest = imageID.includes('@') ? imageID.split('@').pop() : imageID;
		if (!digest) return '—';
		if (digest.startsWith('sha256:')) return `sha256:${digest.slice(7, 19)}`;
		return digest.length <= 28 ? digest : `${digest.slice(0, 25)}...`;
	}

	function shortDigest(digest: string | null | undefined): string {
		if (!digest) return '—';
		if (digest.startsWith('sha256:')) return `sha256:${digest.slice(7, 19)}`;
		return digest.length <= 20 ? digest : `${digest.slice(0, 17)}...`;
	}

	function relativeTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const diff = Math.max(0, Date.now() - new Date(iso).getTime());
		const min = Math.floor(diff / 60_000);
		if (min < 1) return 'now';
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		return `${Math.floor(hr / 24)}d ago`;
	}

	function rowState(row: LiveRow): 'synced' | 'drift' | 'inner-loop' | 'untracked' {
		if (!row.pinKey) return 'untracked';
		if (!releasePinApplies) return 'inner-loop';
		return row.desiredMatches ? 'synced' : 'drift';
	}

	function rowStateLabel(row: LiveRow): string {
		switch (rowState(row)) {
			case 'synced':
				return 'Pinned';
			case 'drift':
				return 'Drift';
			case 'inner-loop':
				return 'Inner loop';
			case 'untracked':
				return 'Untracked';
		}
	}

	function rowStateVariant(row: LiveRow): 'secondary' | 'destructive' | 'outline' {
		const state = rowState(row);
		if (state === 'synced') return 'secondary';
		if (state === 'drift') return 'destructive';
		return 'outline';
	}

	function inventoryCommitSha(row: InventoryRow): string | null {
		return (
			row.application.desired.commitSha ??
			row.application.provenance?.['org.opencontainers.image.revision'] ??
			null
		);
	}

	function inventoryCommitUrl(row: InventoryRow): string | null {
		const sha = inventoryCommitSha(row);
		return sha ? `https://github.com/PittampalliOrg/workflow-builder/commit/${sha}` : null;
	}

	function firstLiveImage(row: InventoryRow): string | null {
		return row.application.live.images[0] ?? null;
	}

	function shortOptionalImage(image: string | null | undefined): string {
		return image ? shortImage(image) : '—';
	}

	function statusVariant(status: string | null | undefined): 'secondary' | 'destructive' | 'outline' {
		if (status === 'Synced' || status === 'Healthy' || status === 'success' || status === 'True') {
			return 'secondary';
		}
		if (status === 'OutOfSync' || status === 'Degraded' || status === 'False' || status === 'Failure') {
			return 'destructive';
		}
		return 'outline';
	}

	function driftLabel(status: string | null | undefined): string {
		if (status === 'in_sync') return 'In sync';
		if (status === 'pending_rollout') return 'Pending rollout';
		return status ? status.replaceAll('_', ' ') : 'Unknown';
	}

	function driftVariant(status: string | null | undefined): 'secondary' | 'destructive' | 'outline' {
		if (status === 'in_sync') return 'secondary';
		if (status === 'pending_rollout' || status === 'unknown') return 'outline';
		return 'destructive';
	}
</script>

<svelte:head>
	<title>Deployments · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-6 py-4">
		<div class="flex items-start justify-between gap-4">
			<div>
				<div class="flex items-center gap-2">
					<Container class="size-5 text-muted-foreground" />
					<h1 class="text-xl font-semibold">Deployments</h1>
				</div>
				<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span>{metadata?.environment.name ?? 'unknown'}</span>
					<span class="text-muted-foreground/40">/</span>
					<span>{metadata?.environment.namespace ?? 'workflow-builder'}</span>
					{#if metadata?.environment.appUrl}
						<span class="text-muted-foreground/40">/</span>
						<span class="font-mono">{metadata.environment.appUrl}</span>
					{/if}
				</div>
			</div>
			<Button variant="outline" onclick={() => void refresh({ fresh: true })} disabled={loading}>
				{#if loading}
					<RefreshCw class="size-4 animate-spin" />
				{:else}
					<RefreshCw class="size-4" />
				{/if}
				Refresh
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="grid gap-3 md:grid-cols-4">
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Server class="size-3.5" />
					Deployments
				</div>
				<div class="mt-1 text-2xl font-semibold">{stats.deployments}</div>
			</div>
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Container class="size-3.5" />
					Containers
				</div>
				<div class="mt-1 text-2xl font-semibold">{stats.containers}</div>
			</div>
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<GitCommit class="size-3.5" />
					Release-pinned
				</div>
				<div class="mt-1 text-2xl font-semibold">{stats.tracked}</div>
			</div>
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<AlertTriangle class="size-3.5" />
					Drift
				</div>
				<div class="mt-1 text-2xl font-semibold">{stats.drift}</div>
			</div>
		</div>

		{#if errorMessage}
			<div class="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
				{errorMessage}
			</div>
		{/if}

		{#if metadata?.inventory.sourceUrl}
			<section class="mt-5 space-y-3">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h2 class="text-base font-semibold">Environment matrix</h2>
						<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span>{inventoryStats.environments} environments</span>
							<span class="text-muted-foreground/40">/</span>
							<span>{inventoryStats.applications} applications</span>
							<span class="text-muted-foreground/40">/</span>
							<span>{inventoryStats.inSync} in sync</span>
							<span class="text-muted-foreground/40">/</span>
							<span>{inventoryStats.pending} pending</span>
						</div>
					</div>
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Clock3 class="size-3" />
						<span>
							{metadata.inventory.data
								? `Hub updated ${relativeTime(metadata.inventory.data.generatedAt)}`
								: 'Hub inventory unavailable'}
						</span>
					</div>
				</div>

				<div class="overflow-x-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Env</TableHead>
								<TableHead>Application</TableHead>
								<TableHead>Desired</TableHead>
								<TableHead>Live</TableHead>
								<TableHead>Promotion</TableHead>
								<TableHead>Build</TableHead>
								<TableHead>Git / OCI</TableHead>
								<TableHead>Drift</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{#each inventoryRows as row (`${row.environment.name}:${row.application.name}`)}
								<TableRow>
									<TableCell>
										<Badge variant="outline">{row.environment.name}</Badge>
									</TableCell>
									<TableCell>
										<div class="font-medium">{row.application.component}</div>
										<div class="max-w-[14rem] truncate font-mono text-xs text-muted-foreground" title={row.application.name}>
											{row.application.name}
										</div>
									</TableCell>
									<TableCell>
										<div class="max-w-[18rem] truncate font-mono text-xs" title={row.application.desired.image ?? ''}>
											{row.application.desired.tag ?? '—'}
										</div>
										<div class="mt-0.5 font-mono text-[0.68rem] text-muted-foreground" title={row.application.desired.digest ?? ''}>
											{shortDigest(row.application.desired.digest)}
										</div>
									</TableCell>
									<TableCell>
										<div class="flex flex-wrap gap-1">
											<Badge variant={statusVariant(row.application.live.syncStatus)}>
												{row.application.live.syncStatus ?? 'Unknown'}
											</Badge>
											<Badge variant={statusVariant(row.application.live.healthStatus)}>
												{row.application.live.healthStatus ?? 'Unknown'}
											</Badge>
										</div>
										<div class="mt-1 max-w-[20rem] truncate font-mono text-[0.68rem] text-muted-foreground" title={firstLiveImage(row) ?? ''}>
											{shortOptionalImage(firstLiveImage(row))}
										</div>
									</TableCell>
									<TableCell>
										<Badge variant={statusVariant(row.application.promotion?.healthPhase)}>
											{row.application.promotion?.healthPhase ?? 'Unknown'}
										</Badge>
										<div class="mt-1 font-mono text-[0.68rem] text-muted-foreground" title={row.application.promotion?.hydratedSha ?? ''}>
											{shortSha(row.application.promotion?.hydratedSha)}
										</div>
									</TableCell>
									<TableCell>
										<Badge variant={statusVariant(row.application.build?.status)}>
											{row.application.build?.reason ?? row.application.build?.status ?? 'Unknown'}
										</Badge>
										<div class="mt-1 max-w-[13rem] truncate font-mono text-[0.68rem] text-muted-foreground" title={row.application.build?.pipelineRun ?? ''}>
											{row.application.build?.pipelineRun ?? '—'}
										</div>
									</TableCell>
									<TableCell>
										{#if inventoryCommitSha(row)}
											<a class="font-mono text-xs text-primary hover:underline" href={inventoryCommitUrl(row) ?? '#'} target="_blank" rel="noreferrer">
												{shortSha(inventoryCommitSha(row))}
											</a>
										{:else}
											<span class="font-mono text-xs text-muted-foreground">—</span>
										{/if}
										<div class="mt-1 max-w-[16rem] truncate text-[0.68rem] text-muted-foreground" title={row.application.provenance?.['org.opencontainers.image.created'] ?? ''}>
											{row.application.provenance?.['org.opencontainers.image.created']
												? `image ${relativeTime(row.application.provenance['org.opencontainers.image.created'])}`
												: 'no OCI labels'}
										</div>
									</TableCell>
									<TableCell>
										<Badge variant={driftVariant(row.application.drift.status)}>
											{driftLabel(row.application.drift.status)}
										</Badge>
									</TableCell>
								</TableRow>
							{/each}
							{#if inventoryRows.length === 0}
								<TableRow>
									<TableCell colspan={8} class="py-8 text-center text-sm text-muted-foreground">
										{loading ? 'Loading hub inventory...' : 'No hub inventory rows are available.'}
									</TableCell>
								</TableRow>
							{/if}
						</TableBody>
					</Table>
				</div>
			</section>
		{/if}

		<section class="mt-5 space-y-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 class="text-base font-semibold">Live workload images</h2>
					<div class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
						<Clock3 class="size-3" />
						<span>{metadata ? `Updated ${relativeTime(metadata.generatedAt)}` : 'Loading'}</span>
					</div>
				</div>
				<div class="flex gap-1.5">
					{#each [['all', 'All'], ['tracked', 'Pinned'], ['drift', 'Drift'], ['untracked', 'Untracked']] as [value, label]}
						<Button
							size="sm"
							variant={filter === value ? 'default' : 'outline'}
							onclick={() => (filter = value as typeof filter)}
						>
							{label}
						</Button>
					{/each}
				</div>
			</div>

			<div class="overflow-hidden rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Deployment</TableHead>
							<TableHead>Ready</TableHead>
							<TableHead>Container</TableHead>
							<TableHead>Live Image</TableHead>
							<TableHead>Commit</TableHead>
							<TableHead>Release Pin</TableHead>
							<TableHead>Status</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{#each filteredRows as row (`${row.deployment.name}:${row.containerName}`)}
							<TableRow>
								<TableCell>
									<div class="font-medium">{row.deployment.name}</div>
									<div class="text-xs text-muted-foreground">
										{row.deployment.pods.ready}/{row.deployment.pods.total} pods
									</div>
								</TableCell>
								<TableCell class="font-mono text-xs">
									{row.deployment.readyReplicas}/{row.deployment.replicas}
								</TableCell>
								<TableCell class="font-mono text-xs">{row.containerName}</TableCell>
								<TableCell>
									<div class="max-w-[32rem] truncate font-mono text-xs" title={row.image}>
										{shortImage(row.image)}
									</div>
									<div class="mt-0.5 font-mono text-[0.68rem] text-muted-foreground" title={row.imageID ?? ''}>
										id {shortImageId(row.imageID)}
									</div>
								</TableCell>
								<TableCell>
									{#if row.commit}
										<a class="font-mono text-xs text-primary hover:underline" href={row.commit.url} target="_blank" rel="noreferrer">
											{row.commit.shortSha}
										</a>
										<div class="max-w-[18rem] truncate text-xs text-muted-foreground" title={row.commit.message ?? ''}>
											{row.commit.message ?? '—'}
										</div>
									{:else}
										<span class="font-mono text-xs text-muted-foreground">{shortSha(row.commitSha)}</span>
									{/if}
								</TableCell>
								<TableCell>
									{#if row.desiredTag}
										<div class="font-mono text-xs">{row.desiredTag}</div>
										<div class="text-xs text-muted-foreground">{row.pinKey}</div>
									{:else}
										<span class="text-xs text-muted-foreground">—</span>
									{/if}
								</TableCell>
								<TableCell>
									<Badge variant={rowStateVariant(row)} class="gap-1">
										{#if rowState(row) === 'synced'}
											<CheckCircle2 class="size-3" />
										{:else if rowState(row) === 'drift'}
											<AlertTriangle class="size-3" />
										{:else}
											<CircleSlash class="size-3" />
										{/if}
										{rowStateLabel(row)}
									</Badge>
								</TableCell>
							</TableRow>
						{/each}
						{#if filteredRows.length === 0}
							<TableRow>
								<TableCell colspan={7} class="py-8 text-center text-sm text-muted-foreground">
									{loading ? 'Loading deployment metadata...' : 'No containers match this filter.'}
								</TableCell>
							</TableRow>
						{/if}
					</TableBody>
				</Table>
			</div>
		</section>

		<section class="mt-7 space-y-3">
			<div class="flex items-center justify-between gap-3">
				<div>
					<h2 class="text-base font-semibold">Dev and staging release pins</h2>
					<div class="mt-1 text-xs text-muted-foreground">
						stacks/main {metadata?.gitops.stacksMain?.shortSha ?? '—'}
					</div>
				</div>
				{#if metadata?.gitops.stacksMain}
					<Button variant="outline" size="sm" href={metadata.gitops.stacksMain.url} target="_blank">
						<GitCommit class="size-4" />
						Open commit
					</Button>
				{/if}
			</div>

			<div class="overflow-hidden rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Image</TableHead>
							<TableHead>Tag</TableHead>
							<TableHead>Commit</TableHead>
							<TableHead>Message</TableHead>
							<TableHead>Committed</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{#each metadata?.gitops.desiredImages ?? [] as image (image.name)}
							<TableRow>
								<TableCell class="font-medium">{image.name}</TableCell>
								<TableCell class="font-mono text-xs">{image.tag}</TableCell>
								<TableCell>
									{#if image.commit}
										<a class="font-mono text-xs text-primary hover:underline" href={image.commit.url} target="_blank" rel="noreferrer">
											{image.commit.shortSha}
										</a>
									{:else}
										<span class="font-mono text-xs text-muted-foreground">{shortSha(image.commitSha)}</span>
									{/if}
								</TableCell>
								<TableCell>
									<div class="max-w-[28rem] truncate text-sm" title={image.commit?.message ?? ''}>
										{image.commit?.message ?? '—'}
									</div>
								</TableCell>
								<TableCell class="text-xs text-muted-foreground">
									{image.commit?.committedAt ? relativeTime(image.commit.committedAt) : '—'}
								</TableCell>
							</TableRow>
						{/each}
						{#if !metadata?.gitops.desiredImages?.length}
							<TableRow>
								<TableCell colspan={5} class="py-8 text-center text-sm text-muted-foreground">
									{loading ? 'Loading release pins...' : 'No release pins available.'}
								</TableCell>
							</TableRow>
						{/if}
					</TableBody>
				</Table>
			</div>
		</section>
	</div>
</div>
