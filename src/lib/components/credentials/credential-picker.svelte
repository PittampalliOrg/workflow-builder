<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import type { VaultSummary, VaultCredentialSummary } from '$lib/types/vaults';

	type Option = { id: string; label: string };

	interface Props {
		/** Selected vault-credential id, or null for none. */
		value?: string | null;
		onChange: (credentialId: string | null) => void;
		/** Vault-credential authTypes to offer. Defaults to the GitHub-PAT-friendly
		 * types (a PAT is stored as `bearer` → accessToken, or `secret_text`). */
		authTypes?: string[];
		label?: string;
		id?: string;
		/** Text for the "none selected" option. */
		emptyLabel?: string;
	}

	let {
		value = null,
		onChange,
		authTypes = ['bearer', 'secret_text'],
		label = 'Auth credential',
		id = 'credential-picker',
		emptyLabel = 'None (public repo)'
	}: Props = $props();

	let options = $state<Option[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let loaded = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/v1/vaults');
			if (!res.ok) throw new Error(`Failed to load vaults (${res.status})`);
			const { vaults } = (await res.json()) as { vaults: VaultSummary[] };
			const active = (vaults ?? []).filter((v) => !v.isArchived && v.credentialCount > 0);
			const perVault = await Promise.all(
				active.map(async (v) => {
					const r = await fetch(`/api/v1/vaults/${v.id}/credentials`);
					if (!r.ok) return [] as Option[];
					const { credentials } = (await r.json()) as {
						credentials: VaultCredentialSummary[];
					};
					return (credentials ?? [])
						.filter((c) => !c.isArchived && authTypes.includes(c.authType))
						.map((c) => ({ id: c.id, label: `${v.name} / ${c.displayName}` }));
				})
			);
			options = perVault.flat();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load credentials';
		} finally {
			loading = false;
			loaded = true;
		}
	}

	$effect(() => {
		if (!loaded) void load();
	});

	function onSelect(event: Event) {
		const next = (event.currentTarget as HTMLSelectElement).value;
		onChange(next || null);
	}
</script>

<div class="space-y-1">
	<Label class="text-[10px]" for={id}>{label}</Label>
	<select
		{id}
		value={value ?? ''}
		onchange={onSelect}
		disabled={loading}
		class="flex h-7 w-full rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
	>
		<option value="">{loading ? 'Loading…' : emptyLabel}</option>
		{#each options as opt (opt.id)}
			<option value={opt.id}>{opt.label}</option>
		{/each}
	</select>
	{#if error}
		<div class="text-[10px] text-destructive">{error}</div>
	{:else if loaded && options.length === 0}
		<div class="text-[10px] text-muted-foreground">
			No bearer/secret credentials in your vaults. Add one under Vaults to clone private repos.
		</div>
	{/if}
</div>
