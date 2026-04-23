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
	} from 'lucide-svelte';

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
	import type {
		DeploymentMetadataResponse,
		LiveContainerMetadata,
		LiveDeploymentMetadata
	} from '$lib/types/deployment-metadata';

	type LiveRow = LiveContainerMetadata & {
		deployment: LiveDeploymentMetadata;
	};

	let metadata = $state<DeploymentMetadataResponse | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let filter = $state<'all' | 'tracked' | 'drift' | 'untracked'>('all');

	const releasePinApplies = $derived(
		metadata?.environment.name === 'dev' || metadata?.environment.name === 'staging'
	);

	const rows = $derived(
		(metadata?.live.deployments ?? []).flatMap((deployment) =>
			deployment.containers.map((container) => ({ ...container, deployment }))
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

	async function refresh() {
		loading = true;
		try {
			const res = await fetch('/api/v1/gitops/deployment-metadata');
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			metadata = (await res.json()) as DeploymentMetadataResponse;
			errorMessage = metadata.live.error ?? metadata.gitops.releasePinsError ?? null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		timer = setInterval(() => void refresh(), 15_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

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
			<Button variant="outline" onclick={refresh} disabled={loading}>
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
