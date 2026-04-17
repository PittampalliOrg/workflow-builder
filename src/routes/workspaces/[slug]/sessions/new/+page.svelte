<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { ArrowLeft, PlayCircle } from 'lucide-svelte';
	import type { AgentSummary } from '$lib/types/agents';
	import type { EnvironmentSummary } from '$lib/types/environments';
	import type { VaultSummary } from '$lib/types/vaults';

	let agents = $state<AgentSummary[]>([]);
	let environments = $state<EnvironmentSummary[]>([]);
	let vaults = $state<VaultSummary[]>([]);
	let loading = $state(true);
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	const preselectedAgentId = page.url.searchParams.get('agent');

	let agentId = $state<string>('');
	let environmentId = $state<string>('');
	let selectedVaultIds = $state<string[]>([]);
	let title = $state<string>('');
	let initialMessage = $state<string>('');

	let selectedAgent = $derived(agents.find((a) => a.id === agentId) ?? null);

	async function load() {
		loading = true;
		try {
			const [a, e, v] = await Promise.all([
				fetch('/api/agents').then((r) => r.json()),
				fetch('/api/v1/environments').then((r) => r.json()),
				fetch('/api/v1/vaults').then((r) => r.json())
			]);
			agents = a.agents ?? [];
			environments = e.environments ?? [];
			vaults = v.vaults ?? [];
			if (preselectedAgentId && agents.some((x) => x.id === preselectedAgentId)) {
				agentId = preselectedAgentId;
			} else if (agents.length > 0) {
				agentId = agents[0].id;
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	// Prefill environment + vaults from chosen agent's defaults.
	$effect(() => {
		if (!selectedAgent) return;
		if (!environmentId && selectedAgent.environmentId) {
			environmentId = selectedAgent.environmentId;
		}
		if (selectedVaultIds.length === 0 && selectedAgent.defaultVaultIds.length > 0) {
			selectedVaultIds = [...selectedAgent.defaultVaultIds];
		}
	});

	async function submit() {
		if (!agentId || submitting) return;
		submitting = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId,
					environmentId: environmentId || undefined,
					vaultIds: selectedVaultIds,
					title: title.trim() || undefined,
					initialMessage: initialMessage.trim() || undefined
				})
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status}): ${await res.text()}`;
				return;
			}
			const { session } = await res.json();
			goto(`/workspaces/default/sessions/${session.id}`);
		} finally {
			submitting = false;
		}
	}

	function toggleVault(id: string) {
		selectedVaultIds = selectedVaultIds.includes(id)
			? selectedVaultIds.filter((v) => v !== id)
			: [...selectedVaultIds, id];
	}

	onMount(load);
</script>

<div class="max-w-4xl mx-auto w-full p-6 flex flex-col gap-6">
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" onclick={() => goto('/workspaces/default/sessions')}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1 class="text-2xl font-semibold">Start a session</h1>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Agent</CardTitle>
			<CardDescription>
				Pick the agent to drive this session. Environment + vaults prefill from the agent's
				defaults.
			</CardDescription>
		</CardHeader>
		<CardContent class="space-y-4">
			<div>
				<Label>Agent</Label>
				<select
					class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
					bind:value={agentId}
					disabled={loading}
				>
					<option value="" disabled>Choose an agent…</option>
					{#each agents as a}
						<option value={a.id}>
							{a.avatar ?? '🤖'} {a.name} — v{a.currentVersion ?? '—'}
						</option>
					{/each}
				</select>
			</div>

			<div>
				<Label>Environment</Label>
				<select
					class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
					bind:value={environmentId}
				>
					<option value="">Use agent default</option>
					{#each environments as env}
						<option value={env.id}>
							{env.avatar ?? '🧱'} {env.name}
						</option>
					{/each}
				</select>
			</div>

			<div>
				<Label>Vaults</Label>
				{#if vaults.length === 0}
					<p class="text-xs text-muted-foreground mt-1">
						No vaults yet. Add one at <a href="/workspaces/default/vaults" class="text-primary hover:underline">/vaults</a>.
					</p>
				{:else}
					<div class="mt-1 flex flex-wrap gap-2">
						{#each vaults as vault}
							<button
								type="button"
								class="px-2 py-1 rounded border text-xs {selectedVaultIds.includes(vault.id)
									? 'bg-primary text-primary-foreground border-primary'
									: 'bg-muted hover:bg-muted/70'}"
								onclick={() => toggleVault(vault.id)}
							>
								{vault.name}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div>
				<Label>Title (optional)</Label>
				<Input bind:value={title} placeholder="e.g. Refactor auth module" />
			</div>

			<div>
				<Label>Kickoff message (optional)</Label>
				<Textarea
					rows={4}
					bind:value={initialMessage}
					placeholder="Send an initial user.message when the session starts."
				/>
			</div>
		</CardContent>
	</Card>

	<div class="flex justify-end gap-2">
		<Button variant="outline" onclick={() => goto('/workspaces/default/sessions')}>Cancel</Button>
		<Button onclick={submit} disabled={!agentId || submitting}>
			<PlayCircle class="size-4" />
			{submitting ? 'Starting…' : 'Start session'}
		</Button>
	</div>
</div>
