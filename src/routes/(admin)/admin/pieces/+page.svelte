<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Search, Plug, Workflow, Pin, Info, Boxes, Loader2, CheckCircle2, AlertTriangle, Plus } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type PieceRow = {
		name: string;
		displayName: string;
		logoUrl: string;
		enabled: boolean;
		inUse: boolean;
		pinned: boolean;
		perPiece: boolean;
	};
	type AvailableRow = {
		name: string;
		displayName: string;
		logoUrl: string;
		buildStatus: 'building' | 'ready' | 'failed' | null;
		errorMessage: string | null;
	};

	let pieces = $state<PieceRow[]>(data.pieces.map((p) => ({ ...p })));
	let available = $state<AvailableRow[]>(data.available.map((p) => ({ ...p })));
	let search = $state('');
	let busy = $state<string | null>(null);
	let enabling = $state<string | null>(null);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return pieces;
		return pieces.filter(
			(p) => p.displayName.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
		);
	});
	const filteredAvailable = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return available;
		return available.filter(
			(p) => p.displayName.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
		);
	});
	const enabledCount = $derived(pieces.filter((p) => p.enabled).length);

	async function toggle(piece: PieceRow) {
		const next = !piece.enabled;
		const prev = piece.enabled;
		piece.enabled = next; // optimistic
		busy = piece.name;
		try {
			const body = new FormData();
			body.set('pieceName', piece.name);
			body.set('enable', String(next));
			const res = await fetch('?/toggle', {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body
			});
			if (!res.ok) throw new Error(String(res.status));
			toast.success(`${piece.displayName} ${next ? 'enabled' : 'disabled'}`);
		} catch {
			piece.enabled = prev; // revert
			toast.error(`Failed to ${next ? 'enable' : 'disable'} ${piece.displayName}`);
		} finally {
			busy = null;
		}
	}

	async function enable(piece: AvailableRow) {
		enabling = piece.name;
		try {
			// Hit the REST endpoint (plain JSON) rather than the form action (devalue-encoded).
			const res = await fetch(`/api/admin/pieces/${encodeURIComponent(piece.name)}/enable`, {
				method: 'POST'
			});
			const result = await res.json().catch(() => null);
			if (!res.ok) throw new Error(result?.message ?? result?.error ?? String(res.status));
			if (result?.status === 'ready') {
				piece.buildStatus = 'ready';
				toast.success(`${piece.displayName} enabled — per-piece image ready, provisioning…`);
				// It's now runnable; refresh so it moves into the enabled list.
				await invalidateAll();
			} else {
				piece.buildStatus = 'building';
				toast.success(`${piece.displayName} — building per-piece image…`);
			}
		} catch (err) {
			piece.buildStatus = 'failed';
			toast.error(`Failed to enable ${piece.displayName}: ${err instanceof Error ? err.message : ''}`);
		} finally {
			enabling = null;
		}
	}
</script>

<svelte:head><title>Piece enablement · Admin · Workflow Builder</title></svelte:head>

<div class="mx-auto max-w-4xl p-6 space-y-5">
	<div>
		<h1 class="text-2xl font-semibold">Piece enablement</h1>
		<p class="text-sm text-muted-foreground mt-1 max-w-2xl">
			Which Activepieces pieces are provisioned as in-cluster MCP services. Disabling a piece
			reaps its <code>ap-&lt;piece&gt;-service</code> on the next reconcile (~2&nbsp;min); enabling
			it re-provisions it (scale-to-zero, ~0 idle cost). Pieces <strong>in use</strong> by a
			workflow or an enabled MCP connection stay provisioned even when disabled here.
		</p>
	</div>

	<div class="relative w-full max-w-sm">
		<Search class="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
		<Input class="pl-8 h-9 text-sm" placeholder="Search all pieces" bind:value={search} />
	</div>

	<Card>
		<CardHeader class="pb-2">
			<CardTitle class="text-sm flex items-center gap-2">
				<Boxes class="size-4 text-muted-foreground" />
				Provisioned · {enabledCount} of {pieces.length} enabled
			</CardTitle>
		</CardHeader>
		<CardContent>
			{#if pieces.length === 0}
				<p class="text-sm text-muted-foreground">No pieces in the catalog.</p>
			{:else}
				<div class="rounded-md border divide-y">
					{#each filtered as piece (piece.name)}
						<div class="flex items-center justify-between gap-3 p-2.5">
							<div class="flex items-center gap-3 min-w-0">
								{#if piece.logoUrl}
									<img src={piece.logoUrl} alt="" class="size-7 rounded shrink-0" />
								{:else}
									<div class="size-7 rounded bg-muted flex items-center justify-center shrink-0">
										<Plug class="size-3.5 text-muted-foreground" />
									</div>
								{/if}
								<div class="min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="text-sm font-medium truncate">{piece.displayName}</span>
										{#if piece.pinned}
											<Badge variant="secondary" class="text-[10px] gap-1">
												<Pin class="size-2.5" /> pinned
											</Badge>
										{/if}
										{#if piece.perPiece}
											<Badge
												variant="outline"
												class="text-[10px] gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
												title="Runs on a dedicated ap-piece image (~256Mi), not the shared bundle"
											>
												<Boxes class="size-2.5" /> per-piece
											</Badge>
										{/if}
										{#if piece.inUse}
											<Badge variant="outline" class="text-[10px] gap-1">
												<Workflow class="size-2.5" /> in use
											</Badge>
										{/if}
									</div>
									<div class="text-[11px] text-muted-foreground font-mono truncate">{piece.name}</div>
								</div>
							</div>
							<div class="flex items-center gap-2 shrink-0">
								{#if !piece.enabled && piece.inUse}
									<span
										class="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1"
										title="Still provisioned because it's used by a workflow or enabled MCP connection"
									>
										<Info class="size-3" /> still provisioned
									</span>
								{/if}
								<Switch
									checked={piece.enabled}
									disabled={busy === piece.name}
									onCheckedChange={() => toggle(piece)}
								/>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</CardContent>
	</Card>

	<Card>
		<CardHeader class="pb-2">
			<CardTitle class="text-sm flex items-center gap-2">
				<Plus class="size-4 text-muted-foreground" />
				Available to enable · {data.availableCount} pieces
			</CardTitle>
			<p class="text-xs text-muted-foreground">
				Catalog pieces not yet provisioned. Enabling builds a dedicated per-piece runtime image
				(<code>ap-piece-&lt;name&gt;</code>, ~256Mi) and provisions it — no 48-piece bundle rebuild.
				Instant when the image already exists; otherwise it builds in the background.
			</p>
		</CardHeader>
		<CardContent>
			{#if available.length === 0}
				<p class="text-sm text-muted-foreground">Every catalog piece is already provisioned.</p>
			{:else if filteredAvailable.length === 0}
				<p class="text-sm text-muted-foreground">No available pieces match “{search}”.</p>
			{:else}
				<div class="rounded-md border divide-y max-h-[28rem] overflow-y-auto">
					{#each filteredAvailable as piece (piece.name)}
						<div class="flex items-center justify-between gap-3 p-2.5">
							<div class="flex items-center gap-3 min-w-0">
								{#if piece.logoUrl}
									<img src={piece.logoUrl} alt="" class="size-7 rounded shrink-0" />
								{:else}
									<div class="size-7 rounded bg-muted flex items-center justify-center shrink-0">
										<Plug class="size-3.5 text-muted-foreground" />
									</div>
								{/if}
								<div class="min-w-0">
									<span class="text-sm font-medium truncate block">{piece.displayName}</span>
									<div class="text-[11px] text-muted-foreground font-mono truncate">{piece.name}</div>
								</div>
							</div>
							<div class="flex items-center gap-2 shrink-0">
								{#if piece.buildStatus === 'building' || enabling === piece.name}
									<Badge variant="outline" class="text-[10px] gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
										<Loader2 class="size-2.5 animate-spin" /> building
									</Badge>
								{:else if piece.buildStatus === 'ready'}
									<Badge variant="outline" class="text-[10px] gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
										<CheckCircle2 class="size-2.5" /> ready
									</Badge>
								{:else if piece.buildStatus === 'failed'}
									<Badge
										variant="outline"
										class="text-[10px] gap-1 border-red-500/40 text-red-600 dark:text-red-400"
										title={piece.errorMessage ?? 'build failed'}
									>
										<AlertTriangle class="size-2.5" /> failed
									</Badge>
								{/if}
								<Button
									size="sm"
									variant={piece.buildStatus === 'failed' ? 'outline' : 'secondary'}
									class="h-7 text-xs"
									disabled={enabling === piece.name || piece.buildStatus === 'building'}
									onclick={() => enable(piece)}
								>
									{piece.buildStatus === 'failed' ? 'Retry' : piece.buildStatus === 'ready' ? 'Enabled' : 'Enable'}
								</Button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</CardContent>
	</Card>
</div>
