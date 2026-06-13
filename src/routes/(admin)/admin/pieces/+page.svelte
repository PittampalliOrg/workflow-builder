<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Search, Plug, Workflow, Pin, Info } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type PieceRow = {
		name: string;
		displayName: string;
		logoUrl: string;
		enabled: boolean;
		inUse: boolean;
		pinned: boolean;
	};

	let pieces = $state<PieceRow[]>(data.pieces.map((p) => ({ ...p })));
	let search = $state('');
	let busy = $state<string | null>(null);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return pieces;
		return pieces.filter(
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

	<Card>
		<CardHeader class="pb-2">
			<div class="flex items-center justify-between gap-3 flex-wrap">
				<CardTitle class="text-sm">
					{enabledCount} of {pieces.length} enabled
				</CardTitle>
				<div class="relative w-[240px]">
					<Search class="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
					<Input class="pl-8 h-8 text-sm" placeholder="Search pieces" bind:value={search} />
				</div>
			</div>
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
</div>
