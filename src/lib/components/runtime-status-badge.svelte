<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		AlertTriangle,
		CheckCircle2,
		Clock3,
		Copy,
		GitCommit,
		RefreshCw,
		Server
	} from '@lucide/svelte';

	import { Badge } from '$lib/components/ui/badge';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import type { RuntimeMatrixRow, RuntimeMetadataResponse } from '$lib/types/deployment-metadata';

	interface Props {
		collapsed: boolean;
		platformRole?: 'ADMIN' | 'MEMBER';
	}

	let { collapsed, platformRole = 'MEMBER' }: Props = $props();

	let metadata = $state<RuntimeMetadataResponse | null>(null);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	const currentVersion = $derived(
		metadata?.current?.commitSha?.slice(0, 8) ??
			shortTag(metadata?.current?.tag) ??
			'unknown',
	);
	const envName = $derived(metadata?.environment.name ?? 'unknown');
	const currentDrift = $derived(metadata?.current?.desiredMatches === false);

	onMount(() => {
		void refresh();
		timer = setInterval(() => void refresh(), 60_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	async function refresh() {
		loading = true;
		try {
			const res = await fetch('/api/v1/runtime-metadata');
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			metadata = (await res.json()) as RuntimeMetadataResponse;
			errorMessage = metadata.errors[0] ?? null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function shortTag(tag: string | null | undefined): string | null {
		if (!tag) return null;
		if (tag.startsWith('git-')) return tag.slice(4, 12);
		return tag.length <= 14 ? tag : `${tag.slice(0, 11)}...`;
	}

	function shortImage(image: string | null | undefined): string {
		if (!image) return '—';
		const lastSlash = image.lastIndexOf('/');
		const lastColon = image.lastIndexOf(':');
		if (lastColon > lastSlash) {
			const repo = image.slice(0, lastColon);
			const tag = image.slice(lastColon + 1);
			return `${repo.split('/').slice(-1)[0]}:${shortTag(tag) ?? tag}`;
		}
		return image.split('/').slice(-1)[0] ?? image;
	}

	function statusVariant(
		status: string | boolean | null | undefined,
	): 'secondary' | 'destructive' | 'outline' {
		if (
			status === true ||
			status === 'Synced' ||
			status === 'Healthy' ||
			status === 'success' ||
			status === 'True' ||
			status === 'in_sync'
		) {
			return 'secondary';
		}
		if (
			status === false ||
			status === 'OutOfSync' ||
			status === 'Degraded' ||
			status === 'False' ||
			status === 'Failure'
		) {
			return 'destructive';
		}
		return 'outline';
	}

	function driftLabel(status: string | null | undefined): string {
		if (status === 'in_sync') return 'In sync';
		if (status === 'pending_rollout') return 'Pending';
		if (status === 'local_live') return 'Local live';
		return status ? status.replaceAll('_', ' ') : 'Unknown';
	}

	function rowVersion(row: RuntimeMatrixRow): string {
		return row.liveCommitSha?.slice(0, 8) ?? shortTag(row.liveTag) ?? '—';
	}

	function relativeTime(iso: string | null | undefined): string {
		if (!iso) return '—';
		const time = new Date(iso).getTime();
		if (Number.isNaN(time)) return '—';
		const diff = Math.max(0, Date.now() - time);
		const min = Math.floor(diff / 60_000);
		if (min < 1) return 'now';
		if (min < 60) return `${min}m`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h`;
		return `${Math.floor(hr / 24)}d`;
	}

	function friendlyRelativeTime(iso: string | null | undefined): string {
		if (!iso) return 'unknown';
		const time = new Date(iso).getTime();
		if (Number.isNaN(time)) return 'unknown';
		const diff = Math.max(0, Date.now() - time);
		const min = Math.floor(diff / 60_000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
		const days = Math.floor(hr / 24);
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}

	function absoluteDateTime(iso: string | null | undefined): string {
		if (!iso) return 'Time unavailable';
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return 'Time unavailable';
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}).format(date);
	}

	function friendlyDateTime(iso: string | null | undefined): string {
		if (!iso) return 'Time unavailable';
		return `${friendlyRelativeTime(iso)} - ${absoluteDateTime(iso)}`;
	}

	async function copyImage() {
		const image = metadata?.current?.image;
		if (!image || typeof navigator === 'undefined') return;
		try {
			await navigator.clipboard.writeText(image);
		} catch {
			/* best effort */
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="group flex h-9 w-full items-center rounded-md border border-border/60 bg-background/80 text-left transition-colors hover:bg-accent/50 {collapsed ? 'justify-center px-0' : 'gap-2 px-2'}"
				title={`${envName} · ${currentVersion}`}
			>
				<span
					class="flex size-5 shrink-0 items-center justify-center rounded-full {currentDrift
						? 'bg-destructive/10 text-destructive'
						: errorMessage
							? 'bg-amber-500/10 text-amber-600'
							: 'bg-emerald-500/10 text-emerald-600'}"
				>
					{#if currentDrift}
						<AlertTriangle size={12} />
					{:else if errorMessage}
						<Clock3 size={12} />
					{:else}
						<CheckCircle2 size={12} />
					{/if}
				</span>
				{#if !collapsed}
					<span class="min-w-0 flex-1">
						<span class="flex items-center gap-1.5">
							<span class="text-[11px] font-semibold uppercase tracking-wide">{envName}</span>
							{#if loading}
								<RefreshCw size={10} class="animate-spin text-muted-foreground" />
							{/if}
						</span>
						<span class="block truncate font-mono text-[10px] text-muted-foreground">
							{currentVersion}
						</span>
					</span>
				{/if}
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content side={collapsed ? 'right' : 'top'} align="start" class="w-96 p-0">
		<div class="border-b p-3">
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="flex items-center gap-2">
						<Server class="size-4 text-muted-foreground" />
						<p class="text-sm font-semibold">Runtime metadata</p>
					</div>
					<p class="mt-1 text-xs text-muted-foreground">
						{metadata?.environment.namespace ?? 'workflow-builder'} · detected from {metadata?.environment.detectedFrom ?? 'unknown'}
					</p>
				</div>
				<button
					type="button"
					class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					onclick={refresh}
					disabled={loading}
					title="Refresh runtime metadata"
				>
					<RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
				</button>
			</div>
		</div>

		<div class="space-y-3 p-3">
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center justify-between gap-2">
					<div>
						<p class="text-xs text-muted-foreground">Current environment</p>
						<div class="mt-1 flex items-center gap-2">
							<Badge variant="outline" class="uppercase">{envName}</Badge>
							<Badge variant={statusVariant(metadata?.current?.ready ?? null)}>
								{metadata?.current?.ready === true
									? 'Running'
									: metadata?.current?.ready === false
										? 'Not ready'
										: 'Unknown'}
							</Badge>
						</div>
					</div>
					<div class="text-right">
						<p class="text-xs text-muted-foreground">Version</p>
						{#if metadata?.current?.commitUrl}
							<a
								class="mt-1 block font-mono text-xs text-primary hover:underline"
								href={metadata.current.commitUrl}
								target="_blank"
								rel="noreferrer"
							>
								{currentVersion}
							</a>
						{:else}
							<p class="mt-1 font-mono text-xs">{currentVersion}</p>
						{/if}
						<p
							class="mt-1 text-[10px] text-muted-foreground"
							title={absoluteDateTime(metadata?.current?.committedAt)}
						>
							Committed {friendlyRelativeTime(metadata?.current?.committedAt)}
						</p>
					</div>
				</div>

				<div class="mt-3 flex items-start gap-2 rounded-md bg-muted/40 p-2">
					<GitCommit class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
					<div class="min-w-0 flex-1">
						<p class="truncate font-mono text-[11px]" title={metadata?.current?.image ?? ''}>
							{metadata?.current ? shortImage(metadata.current.image) : 'No live workflow-builder image found'}
						</p>
						<p class="truncate text-[10px] text-muted-foreground" title={metadata?.current?.commitMessage ?? ''}>
							{metadata?.current?.commitMessage ?? metadata?.current?.image ?? 'Waiting for metadata'}
						</p>
						{#if metadata?.current?.committedAt}
							<p class="truncate text-[10px] text-muted-foreground" title={absoluteDateTime(metadata.current.committedAt)}>
								Commit time: {friendlyDateTime(metadata.current.committedAt)}
							</p>
						{/if}
					</div>
					<button
						type="button"
						class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
						onclick={copyImage}
						title="Copy full image reference"
					>
						<Copy size={12} />
					</button>
				</div>
			</div>

			<div>
				<div class="mb-2 flex items-center justify-between">
					<p class="text-xs font-medium">Environment matrix</p>
					<p class="text-[10px] text-muted-foreground">
						updated {relativeTime(metadata?.generatedAt)}
					</p>
				</div>
				<div class="overflow-hidden rounded-lg border">
					{#each metadata?.matrix ?? [] as row (`${row.environment}:${row.applicationName}`)}
						<div class="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 border-b px-2 py-2 last:border-b-0">
							<Badge variant={row.environment === envName ? 'default' : 'outline'} class="justify-center uppercase">
								{row.environment}
							</Badge>
							<div class="min-w-0">
								<p class="truncate font-mono text-[11px]" title={row.liveImage ?? ''}>
									{rowVersion(row)}
								</p>
								<p class="truncate text-[10px] text-muted-foreground" title={row.liveImage ?? ''}>
									{shortImage(row.liveImage)}
								</p>
								{#if row.buildFinishedAt}
									<p class="truncate text-[10px] text-muted-foreground" title={absoluteDateTime(row.buildFinishedAt)}>
										Built {friendlyRelativeTime(row.buildFinishedAt)}
									</p>
								{/if}
							</div>
							<Badge variant={statusVariant(row.driftStatus)} class="justify-center">
								{driftLabel(row.driftStatus)}
							</Badge>
						</div>
					{/each}
					{#if !metadata?.matrix?.length}
						<div class="p-4 text-center text-xs text-muted-foreground">
							{loading ? 'Loading runtime metadata...' : 'No environment metadata available.'}
						</div>
					{/if}
				</div>
			</div>

			{#if errorMessage}
				<div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
					{errorMessage}
				</div>
			{/if}

			{#if platformRole === 'ADMIN'}
				<a
					href="/admin/deployments"
					class="block rounded-md border px-3 py-2 text-center text-xs font-medium hover:bg-accent"
				>
					Open deployments page
				</a>
			{/if}
		</div>
	</DropdownMenu.Content>
</DropdownMenu.Root>
