<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import AgentPicker from '$lib/components/agents/agent-picker.svelte';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { ArrowLeft, Check, KeyRound, Loader2, PlayCircle } from '@lucide/svelte';
	import RepositoriesEditor from '$lib/components/sessions/repositories-editor.svelte';
	import type { AgentSummary } from '$lib/types/agents';
	import type { EnvironmentSummary } from '$lib/types/environments';
	import type { VaultSummary } from '$lib/types/vaults';
	import type { SessionRepositoryInput } from '$lib/types/sessions';

	const { data }: {
		data: {
			cliAuthByRuntime: Record<
				string,
				{
					provider: string;
					credentialKind: 'env_token' | 'file' | 'file_bundle' | 'device_login';
					setupCommand: string | null;
				}
			>;
		};
	} = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

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
	let repositories = $state<SessionRepositoryInput[]>([]);
	// Editor instance — used to flush a half-entered (typed-but-not-added) repo
	// before submit so it isn't silently dropped.
	let repoEditor = $state<{ commitPending?: () => boolean } | undefined>(undefined);

	let selectedAgent = $derived(agents.find((a) => a.id === agentId) ?? null);

	// CLI-token readiness for interactive-CLI runtimes: the spawn path hard-
	// requires a linked subscription token (412 otherwise), so surface the
	// state inline and block submit while it's missing.
	const selectedCliAuth = $derived(
		selectedAgent ? (data.cliAuthByRuntime[selectedAgent.runtime] ?? null) : null
	);
	let cliTokenState = $state<'idle' | 'loading' | 'linked' | 'missing' | 'device_login'>('idle');
	let cliTokenExpiresAt = $state<string | null>(null);
	$effect(() => {
		const auth = selectedCliAuth;
		if (!auth) {
			cliTokenState = 'idle';
			cliTokenExpiresAt = null;
			return;
		}
		// device-code OAuth runtimes have no pre-provisioned credential — the
		// user logs in inside the terminal, so submit is never blocked.
		if (auth.credentialKind === 'device_login') {
			cliTokenState = 'device_login';
			cliTokenExpiresAt = null;
			return;
		}
		cliTokenState = 'loading';
		let cancelled = false;
		fetch(`/api/v1/users/me/cli-tokens/${encodeURIComponent(auth.provider)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { linked?: boolean; expiresAt?: string | null } | null) => {
				if (cancelled) return;
				cliTokenState = body?.linked === true ? 'linked' : 'missing';
				cliTokenExpiresAt = body?.expiresAt ?? null;
			})
			.catch(() => {
				if (!cancelled) cliTokenState = 'missing';
			});
		return () => {
			cancelled = true;
		};
	});
	function cliExpiryLabel(expiresAt: string | null): string | null {
		if (!expiresAt) return null;
		const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
		if (Number.isNaN(days)) return null;
		return days > 0 ? `expires in ${days}d` : 'expired';
	}
	const cliTokenBlocksSubmit = $derived(
		selectedCliAuth !== null &&
			selectedCliAuth.credentialKind !== 'device_login' &&
			cliTokenState !== 'linked'
	);

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
		// Flush a pending repo (URL entered but inner "Add" never clicked) so it
		// still ships in `resources` instead of being silently lost.
		repoEditor?.commitPending?.();
		try {
			const res = await fetch('/api/v1/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId,
					environmentId: environmentId || undefined,
					vaultIds: selectedVaultIds,
					title: title.trim() || undefined,
					initialMessage: initialMessage.trim() || undefined,
					resources: repositories.length > 0 ? repositories : undefined
				})
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status}): ${await res.text()}`;
				return;
			}
			const { session } = await res.json();
			goto(`/workspaces/${slug}/sessions/${session.id}`);
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

<div class="h-full overflow-y-auto max-w-4xl mx-auto w-full p-6 flex flex-col gap-6">
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/sessions`)}>
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
				<div class="mt-1">
					<AgentPicker
						value={agentId || null}
						{agents}
						disabled={loading}
						placeholder="Choose an agent…"
						onChange={(id) => (agentId = id)}
					/>
				</div>
				{#if selectedCliAuth}
					<div class="mt-1.5 flex items-center gap-1.5 text-xs">
						{#if cliTokenState === 'device_login'}
							<KeyRound class="size-3 text-sky-500" />
							<span class="text-sky-700 dark:text-sky-400">
								Signs in inside the terminal ({selectedCliAuth.provider} device-code OAuth) — no
								setup needed; complete the login when the session opens.
							</span>
						{:else if cliTokenState === 'loading'}
							<Loader2 class="size-3 animate-spin text-muted-foreground" />
							<span class="text-muted-foreground">Checking CLI credential…</span>
						{:else if cliTokenState === 'linked'}
							<Check class="size-3 text-green-600" />
							<span class="text-green-700 dark:text-green-400">
								CLI credential linked
								{#if cliExpiryLabel(cliTokenExpiresAt)}
									· {cliExpiryLabel(cliTokenExpiresAt)}
								{/if}
							</span>
						{:else}
							<KeyRound class="size-3 text-amber-500" />
							<span class="text-amber-700 dark:text-amber-400">
								Not linked — this runtime needs your {selectedCliAuth.provider} credential.
								{#if selectedCliAuth.setupCommand}
									Run
									<code class="rounded bg-muted px-1 py-0.5">{selectedCliAuth.setupCommand}</code>
									locally, then
								{/if}
								<a href="/settings/cli-tokens" class="underline">link it in Settings → CLI tokens</a>.
							</span>
						{/if}
					</div>
				{/if}
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
						No credentials yet. Add one at <a href="/workspaces/{slug}/credentials" class="text-primary hover:underline">/credentials</a>.
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

			<div>
				<Label>Repositories (optional)</Label>
				<p class="text-xs text-muted-foreground mt-0.5 mb-2">
					Clone GitHub repos into the agent's sandbox before its first turn. Private repos
					need an auth credential from your vaults.
				</p>
				<RepositoriesEditor
					bind:this={repoEditor}
					workspaceSlug={slug}
					value={repositories}
					onChange={(r) => (repositories = r)}
				/>
			</div>
		</CardContent>
	</Card>

	<div class="flex justify-end gap-2">
		<Button variant="outline" onclick={() => goto(`/workspaces/${slug}/sessions`)}>Cancel</Button>
		<Button
			onclick={submit}
			disabled={!agentId || submitting || cliTokenBlocksSubmit}
			title={cliTokenBlocksSubmit
				? 'Link a CLI token under Settings → CLI tokens first'
				: undefined}
		>
			<PlayCircle class="size-4" />
			{submitting ? 'Starting…' : 'Start session'}
		</Button>
	</div>
</div>
