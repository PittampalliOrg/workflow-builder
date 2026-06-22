<script lang="ts">
	// Configure event/webhook triggers for a workflow + activate them (provisions
	// the backing listener so the workflow fires on its signal). Uses the P4 API:
	//   GET/POST   /api/workflows/[id]/triggers
	//   POST       /api/workflows/[id]/triggers/[tid]/activate|deactivate
	//   DELETE     /api/workflows/[id]/triggers/[tid]
	// and the trigger-kind catalog at /api/workflow-trigger-kinds.
	import { onMount } from 'svelte';

	let { workflowId }: { workflowId: string } = $props();

	type Field = {
		key: string;
		label: string;
		type: string;
		required?: boolean;
		default?: string | number | boolean;
		placeholder?: string;
		help?: string;
		options?: { value: string; label: string }[];
	};
	type Kind = {
		id: string;
		label: string;
		icon: string;
		description: string;
		backing: string;
		configSchema: Field[];
		requiresActivation: boolean;
	};
	type Trigger = {
		id: string;
		kind: string;
		config: Record<string, unknown>;
		status: string;
		lastError?: string | null;
		lastFiredAt?: string | null;
	};

	let kinds = $state<Kind[]>([]);
	let triggers = $state<Trigger[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busyId = $state<string | null>(null);

	// add-form state
	let adding = $state(false);
	let newKind = $state('webhook');
	let newConfig = $state<Record<string, string>>({});
	let creating = $state(false);

	const selectedKind = $derived(kinds.find((k) => k.id === newKind) ?? null);

	async function load() {
		loading = true;
		error = '';
		try {
			const [kr, tr] = await Promise.all([
				fetch('/api/workflow-trigger-kinds').then((r) => r.json()),
				fetch(`/api/workflows/${encodeURIComponent(workflowId)}/triggers`).then((r) => r.json())
			]);
			kinds = kr.kinds ?? [];
			triggers = tr.triggers ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load triggers';
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function resetNewConfig() {
		const cfg: Record<string, string> = {};
		for (const f of selectedKind?.configSchema ?? []) {
			if (f.default !== undefined) cfg[f.key] = String(f.default);
		}
		newConfig = cfg;
	}
	$effect(() => {
		// reset config fields when the chosen kind changes
		newKind;
		resetNewConfig();
	});

	async function createTrigger() {
		creating = true;
		error = '';
		try {
			const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/triggers`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ kind: newKind, config: newConfig })
			});
			if (!res.ok) {
				const b = await res.json().catch(() => ({}));
				throw new Error(b.message || b.error || `Failed (${res.status})`);
			}
			adding = false;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create trigger';
		} finally {
			creating = false;
		}
	}

	async function act(t: Trigger, action: 'activate' | 'deactivate') {
		busyId = t.id;
		error = '';
		try {
			const res = await fetch(
				`/api/workflows/${encodeURIComponent(workflowId)}/triggers/${encodeURIComponent(t.id)}/${action}`,
				{ method: 'POST' }
			);
			if (!res.ok) {
				const b = await res.json().catch(() => ({}));
				throw new Error(b.error || `Failed (${res.status})`);
			}
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : `Failed to ${action}`;
		} finally {
			busyId = null;
		}
	}

	async function remove(t: Trigger) {
		busyId = t.id;
		try {
			await fetch(
				`/api/workflows/${encodeURIComponent(workflowId)}/triggers/${encodeURIComponent(t.id)}`,
				{ method: 'DELETE' }
			);
			await load();
		} finally {
			busyId = null;
		}
	}

	function statusColor(s: string): string {
		if (s === 'active') return 'text-emerald-600 dark:text-emerald-400';
		if (s === 'error') return 'text-red-600 dark:text-red-400';
		if (s === 'activating' || s === 'deactivating') return 'text-sky-600 dark:text-sky-400';
		return 'text-muted-foreground';
	}
	function kindLabel(id: string): string {
		return kinds.find((k) => k.id === id)?.label ?? id;
	}
</script>

<div class="space-y-4 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h3 class="text-sm font-medium">Triggers</h3>
			<p class="text-xs text-muted-foreground">
				Fire this workflow automatically when an external signal arrives. Activate to provision the
				listener.
			</p>
		</div>
		<button
			type="button"
			class="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
			onclick={() => {
				adding = !adding;
				resetNewConfig();
			}}
		>
			{adding ? 'Cancel' : 'Add trigger'}
		</button>
	</div>

	{#if error}
		<div class="rounded border-l-2 border-red-500 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-300">
			{error}
		</div>
	{/if}

	{#if adding}
		<div class="space-y-3 rounded border border-border p-3">
			<div class="flex flex-col gap-1">
				<span class="text-[10px] uppercase text-muted-foreground">Trigger type</span>
				<select bind:value={newKind} class="rounded border bg-background px-2 py-1 text-sm">
					{#each kinds as k}
						<option value={k.id}>{k.label}</option>
					{/each}
				</select>
				{#if selectedKind}<p class="text-xs text-muted-foreground">{selectedKind.description}</p>{/if}
			</div>
			{#each selectedKind?.configSchema ?? [] as f}
				<div class="flex flex-col gap-1">
					<span class="text-[10px] uppercase text-muted-foreground"
						>{f.label}{f.required ? ' *' : ''}</span
					>
					{#if f.type === 'select'}
						<select bind:value={newConfig[f.key]} class="rounded border bg-background px-2 py-1 text-sm">
							{#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
						</select>
					{:else if f.type === 'textarea'}
						<textarea bind:value={newConfig[f.key]} placeholder={f.placeholder} class="rounded border bg-background px-2 py-1 text-sm font-mono" rows="2"></textarea>
					{:else}
						<input bind:value={newConfig[f.key]} placeholder={f.placeholder} class="rounded border bg-background px-2 py-1 text-sm font-mono" />
					{/if}
					{#if f.help}<span class="text-[10px] text-muted-foreground">{f.help}</span>{/if}
				</div>
			{/each}
			<button
				type="button"
				onclick={createTrigger}
				disabled={creating}
				class="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
			>
				{creating ? 'Creating…' : 'Create trigger'}
			</button>
		</div>
	{/if}

	{#if loading}
		<p class="text-xs text-muted-foreground">Loading…</p>
	{:else if triggers.length === 0}
		<p class="text-xs text-muted-foreground">No triggers yet.</p>
	{:else}
		<div class="space-y-2">
			{#each triggers as t}
				<div class="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium">{kindLabel(t.kind)}</span>
							<span class="text-xs {statusColor(t.status)}">● {t.status}</span>
						</div>
						{#if t.lastError}<p class="text-[11px] text-red-600 dark:text-red-400">{t.lastError}</p>{/if}
					</div>
					<div class="flex items-center gap-2">
						{#if t.status === 'active'}
							<button type="button" onclick={() => act(t, 'deactivate')} disabled={busyId === t.id} class="rounded border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50">Deactivate</button>
						{:else}
							<button type="button" onclick={() => act(t, 'activate')} disabled={busyId === t.id} class="rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50">Activate</button>
						{/if}
						<button type="button" onclick={() => remove(t)} disabled={busyId === t.id} class="rounded border px-2.5 py-1 text-xs text-red-600 hover:bg-muted disabled:opacity-50">Delete</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
