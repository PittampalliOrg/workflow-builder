<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Loader2, KeyRound, Plus, RefreshCw, X } from 'lucide-svelte';
	import type { VaultSummary } from '$lib/types/vaults';

	interface Props {
		value: string[];
		onChange: (next: string[]) => void;
	}

	let { value, onChange }: Props = $props();

	let vaults = $state<VaultSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	let attached = $derived(vaults.filter((v) => value.includes(v.id)));
	let available = $derived(vaults.filter((v) => !value.includes(v.id) && !v.isArchived));

	onMount(() => {
		void load();
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/vaults');
			if (!res.ok) {
				errorMessage = `Failed to load vaults (${res.status})`;
				return;
			}
			const data = (await res.json()) as { vaults: VaultSummary[] };
			vaults = data.vaults ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function attach(vault: VaultSummary) {
		if (value.includes(vault.id)) return;
		onChange([...value, vault.id]);
	}

	function detach(vault: VaultSummary) {
		onChange(value.filter((v) => v !== vault.id));
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<p class="text-xs text-muted-foreground">
			Vaults attached to this agent are available to every session it drives. The proxy injects
			credentials into MCP tool calls by URL match; sandbox never sees them.
		</p>
		<Button variant="outline" size="sm" onclick={() => void load()}>
			{#if loading}
				<Loader2 class="size-3 animate-spin" />
			{:else}
				<RefreshCw class="size-3" />
			{/if}
		</Button>
	</div>

	{#if errorMessage}
		<div class="text-xs text-destructive">{errorMessage}</div>
	{/if}

	<div>
		<p class="text-[11px] font-medium text-muted-foreground mb-1">
			Attached ({attached.length})
		</p>
		{#if attached.length === 0}
			<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
				No vaults attached. MCP servers on this agent will run without credentials.
			</div>
		{:else}
			<div class="space-y-1">
				{#each attached as vault (vault.id)}
					<div class="flex items-center justify-between rounded border p-2">
						<div class="flex items-center gap-2 min-w-0">
							<KeyRound class="size-3.5 text-muted-foreground shrink-0" />
							<span class="font-medium text-sm truncate">{vault.name}</span>
							<Badge variant="outline" class="text-[10px]">
								{vault.credentialCount} cred{vault.credentialCount === 1 ? '' : 's'}
							</Badge>
						</div>
						<div class="flex gap-1">
							<a
								href="/workspaces/{slug}/credentials/{vault.id}"
								target="_blank"
								class="text-xs text-primary hover:underline"
							>
								Edit ↗
							</a>
							<Button
								variant="ghost"
								size="icon"
								class="size-6"
								onclick={() => detach(vault)}
							>
								<X class="size-3" />
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if available.length > 0}
		<div>
			<p class="text-[11px] font-medium text-muted-foreground mb-1">Available</p>
			<div class="flex flex-wrap gap-2">
				{#each available as vault (vault.id)}
					<Button variant="outline" size="sm" onclick={() => attach(vault)}>
						<Plus class="size-3" />
						{vault.name}
					</Button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="pt-2 border-t">
		<a href="/workspaces/{slug}/credentials" target="_blank" class="text-xs text-primary hover:underline">
			Manage vaults in the library →
		</a>
	</div>
</div>
