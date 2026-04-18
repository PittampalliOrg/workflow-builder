<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import {
		Popover,
		PopoverContent,
		PopoverTrigger
	} from '$lib/components/ui/popover';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import {
		ArrowLeft,
		Clock,
		Code2,
		KeyRound,
		Pencil,
		Plus,
		RotateCw,
		Save,
		ShieldCheck,
		Trash2
	} from 'lucide-svelte';
	import type {
		VaultAuthType,
		VaultCredentialInput,
		VaultCredentialSummary,
		VaultDetail
	} from '$lib/types/vaults';
	import VaultOverview from '$lib/components/vaults/vault-overview.svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');

	const vaultId = page.params.id as string;

	let vault = $state<VaultDetail | null>(null);
	let credentials = $state<VaultCredentialSummary[]>([]);
	type VaultUsages = {
		agents: Array<{ id: string; slug: string; name: string; avatar: string | null; isArchived: boolean }>;
		sessionCount: number;
	};
	let usages = $state<VaultUsages | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let dirty = $state(false);
	let credentialDialogOpen = $state(false);
	let rotating = $state<VaultCredentialSummary | null>(null);
	let toDelete = $state<VaultCredentialSummary | null>(null);

	// credential dialog state
	let cdName = $state('');
	let cdType = $state<VaultAuthType>('mcp_oauth');
	let cdMcpUrl = $state('');
	let cdAccessToken = $state('');
	let cdRefreshToken = $state('');
	let cdExpiresAt = $state('');
	let cdTokenEndpoint = $state('');
	let cdClientId = $state('');
	let cdTokenEndpointAuth = $state<'none' | 'client_secret_basic' | 'client_secret_post'>('none');
	let cdClientSecret = $state('');
	let cdUsername = $state('');
	let cdPassword = $state('');
	let cdSecret = $state('');
	let cdSaving = $state(false);

	async function load() {
		loading = true;
		try {
			const [v, c, u] = await Promise.all([
				fetch(`/api/v1/vaults/${vaultId}`).then((r) => r.json()),
				fetch(`/api/v1/vaults/${vaultId}/credentials`).then((r) => r.json()),
				fetch(`/api/v1/vaults/${vaultId}/usages`)
					.then((r) => (r.ok ? r.json() : { agents: [], sessionCount: 0 }))
					.catch(() => ({ agents: [], sessionCount: 0 }))
			]);
			if (v.error) {
				errorMessage = v.error;
				return;
			}
			vault = v.vault;
			credentials = c.credentials ?? [];
			usages = u as VaultUsages;
			dirty = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (!vault) return;
		saving = true;
		try {
			const res = await fetch(`/api/v1/vaults/${vaultId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: vault.name,
					description: vault.description
				})
			});
			if (res.ok) dirty = false;
		} finally {
			saving = false;
		}
	}

	function resetCredentialForm() {
		cdName = '';
		cdType = 'mcp_oauth';
		cdMcpUrl = '';
		cdAccessToken = '';
		cdRefreshToken = '';
		cdExpiresAt = '';
		cdTokenEndpoint = '';
		cdClientId = '';
		cdTokenEndpointAuth = 'none';
		cdClientSecret = '';
		cdUsername = '';
		cdPassword = '';
		cdSecret = '';
	}

	function openNewCredential() {
		resetCredentialForm();
		rotating = null;
		credentialDialogOpen = true;
	}

	function openRotate(cred: VaultCredentialSummary) {
		resetCredentialForm();
		rotating = cred;
		cdName = cred.displayName;
		cdType = cred.authType;
		cdMcpUrl = cred.mcpServerUrl ?? '';
		credentialDialogOpen = true;
	}

	let refreshingId = $state<string | null>(null);

	async function refreshNow(cred: VaultCredentialSummary) {
		if (refreshingId) return;
		refreshingId = cred.id;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/v1/vaults/${vaultId}/credentials/${cred.id}/refresh`,
				{ method: 'POST' }
			);
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				error?: string;
				expiresAt?: string | null;
			};
			if (!res.ok || !body.ok) {
				errorMessage = `Refresh failed: ${body.error ?? res.status}`;
				return;
			}
			await load();
		} finally {
			refreshingId = null;
		}
	}

	function expiresSoon(iso: string | null): boolean {
		if (!iso) return false;
		const diff = new Date(iso).getTime() - Date.now();
		return diff > 0 && diff < 24 * 3_600_000;
	}

	async function submitCredential() {
		cdSaving = true;
		errorMessage = null;
		try {
			const payload: VaultCredentialInput = {
				displayName: cdName.trim(),
				authType: cdType,
				mcpServerUrl: cdMcpUrl.trim() || undefined
			};
			if (cdType === 'mcp_oauth' || cdType === 'bearer') {
				if (cdAccessToken) payload.accessToken = cdAccessToken;
			}
			if (cdType === 'mcp_oauth') {
				if (cdRefreshToken) payload.refreshToken = cdRefreshToken;
				if (cdExpiresAt) payload.expiresAt = new Date(cdExpiresAt).toISOString();
				if (cdTokenEndpoint && cdClientId) {
					payload.refreshMetadata = {
						tokenEndpoint: cdTokenEndpoint,
						clientId: cdClientId,
						tokenEndpointAuth:
							cdTokenEndpointAuth === 'none'
								? { type: 'none' }
								: { type: cdTokenEndpointAuth, client_secret: cdClientSecret }
					};
				}
			}
			if (cdType === 'basic') {
				if (cdUsername) payload.username = cdUsername;
				if (cdPassword) payload.password = cdPassword;
			}
			if (cdType === 'secret_text') {
				if (cdSecret) payload.secret = cdSecret;
			}

			const url = rotating
				? `/api/v1/vaults/${vaultId}/credentials/${rotating.id}`
				: `/api/v1/vaults/${vaultId}/credentials`;
			const method = rotating ? 'PUT' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				errorMessage = `Save failed (${res.status}): ${await res.text()}`;
				return;
			}
			credentialDialogOpen = false;
			await load();
		} finally {
			cdSaving = false;
		}
	}

	async function archiveCredential() {
		if (!toDelete) return;
		const res = await fetch(
			`/api/v1/vaults/${vaultId}/credentials/${toDelete.id}`,
			{ method: 'DELETE' }
		);
		if (res.ok) {
			credentials = credentials.filter((c) => c.id !== toDelete!.id);
		}
		toDelete = null;
	}

	onMount(load);
</script>

<div class="flex flex-col max-w-5xl mx-auto w-full p-6 gap-6">
	<div class="flex items-center gap-2 flex-wrap">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/vaults`)}>
			<ArrowLeft class="size-4" />
		</Button>
		<div class="flex items-center gap-2 flex-1 min-w-0">
			<div class="size-10 rounded bg-primary/10 flex items-center justify-center">
				<KeyRound class="size-5 text-primary" />
			</div>
			<div class="flex-1 min-w-0">
				<Input
					class="border-0 shadow-none h-8 px-2 font-semibold text-base focus-visible:ring-1"
					value={vault?.name ?? ''}
					oninput={(e) => {
						if (vault) {
							vault = { ...vault, name: (e.target as HTMLInputElement).value };
							dirty = true;
						}
					}}
				/>
				<div class="text-xs text-muted-foreground px-2">
					{vault?.credentialCount ?? 0} credential{vault?.credentialCount === 1 ? '' : 's'}
					{#if dirty}
						<span class="text-amber-500">· unsaved</span>
					{/if}
				</div>
			</div>
		</div>
		<Popover>
			<PopoverTrigger>
				<Button variant="outline" size="sm" title="Show API snippet">
					<Code2 class="size-4" /> Code
				</Button>
			</PopoverTrigger>
			<PopoverContent class="w-[560px] p-3" align="end">
				<div class="text-xs font-semibold mb-1">Attach this vault to an agent</div>
				<p class="text-xs text-muted-foreground mb-2">
					Pass the vault id in <code class="text-[10px]">defaultVaultIds</code>.
				</p>
				<ApiSnippet
					curl={`curl -X PATCH $WORKFLOW_BUILDER_URL/api/agents/<AGENT_ID> \\\n  -H 'Authorization: Bearer $WB_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"defaultVaultIds":["${vaultId}"]}'`}
					python={`import requests\n\nrequests.patch(\n    f"{WORKFLOW_BUILDER_URL}/api/agents/<AGENT_ID>",\n    headers={"Authorization": f"Bearer {WB_API_KEY}"},\n    json={"defaultVaultIds": ["${vaultId}"]},\n)`}
					typescript={`await fetch(\`\${WORKFLOW_BUILDER_URL}/api/agents/<AGENT_ID>\`, {\n  method: 'PATCH',\n  headers: {\n    Authorization: \`Bearer \${WB_API_KEY}\`,\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({ defaultVaultIds: ['${vaultId}'] })\n});`}
				/>
			</PopoverContent>
		</Popover>
		<Button disabled={!dirty || saving} onclick={save}>
			<Save class="size-4" />
			{saving ? 'Saving…' : 'Save'}
		</Button>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading || !vault}
		<Skeleton class="h-48" />
	{:else}
		<!-- CMA-shape overview: read-only summary + credential list with
		     expiry chips + rotate actions. The old edit Description + Credentials
		     table stays below for authoring. -->
		{#if vault}
			<VaultOverview
				{vault}
				{credentials}
				onRotate={(credId) => {
					const target = credentials.find((c) => c.id === credId);
					if (target) openRotate(target);
				}}
			/>
		{/if}

		<Card>
			<CardHeader>
				<CardTitle class="text-sm">Description</CardTitle>
			</CardHeader>
			<CardContent>
				<Textarea
					rows={2}
					value={vault.description ?? ''}
					oninput={(e) => {
						if (vault) {
							vault = {
								...vault,
								description: (e.target as HTMLTextAreaElement).value
							};
							dirty = true;
						}
					}}
				/>
			</CardContent>
		</Card>

		{#if usages && (usages.agents.length > 0 || usages.sessionCount > 0)}
			<Card>
				<CardHeader>
					<CardTitle class="text-base">Used by</CardTitle>
				</CardHeader>
				<CardContent class="space-y-2">
					{#if usages.agents.length > 0}
						<div class="text-xs text-muted-foreground mb-1">
							{usages.agents.length} agent{usages.agents.length === 1 ? '' : 's'}
							reference{usages.agents.length === 1 ? 's' : ''} this vault:
						</div>
						<div class="flex flex-wrap gap-2">
							{#each usages.agents as a (a.id)}
								<a
									href="/workspaces/{slug}/agents/{a.id}"
									class="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs hover:bg-muted"
								>
									<span>{a.avatar ?? '🤖'}</span>
									<span>{a.name}</span>
								</a>
							{/each}
						</div>
					{/if}
					{#if usages.sessionCount > 0}
						<div class="text-xs text-muted-foreground">
							{usages.sessionCount} session{usages.sessionCount === 1 ? '' : 's'} attached this vault.
						</div>
					{/if}
				</CardContent>
			</Card>
		{/if}

		<div class="flex items-center justify-between">
			<h2 class="text-lg font-semibold">Credentials</h2>
			<Button onclick={openNewCredential}>
				<Plus class="size-4" /> Add credential
			</Button>
		</div>

		{#if credentials.length === 0}
			<div class="rounded border border-dashed p-6 text-center">
				<ShieldCheck class="size-8 mx-auto mb-2 text-muted-foreground" />
				<p class="text-sm text-muted-foreground">
					No credentials yet. Add one to authenticate MCP servers or custom tools.
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each credentials as cred (cred.id)}
					<Card>
						<CardContent class="py-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-medium text-sm">{cred.displayName}</span>
										<Badge variant="outline">{cred.authType}</Badge>
										{#if cred.expiresAt}
											<Badge
												variant={expiresSoon(cred.expiresAt) ? 'destructive' : 'secondary'}
												class="text-[10px]"
											>
												<Clock class="size-3 mr-1" />
												expires {new Date(cred.expiresAt).toLocaleString()}
											</Badge>
										{/if}
									</div>
									{#if cred.mcpServerUrl}
										<code class="text-[10px] text-muted-foreground truncate block mt-1">
											{cred.mcpServerUrl}
										</code>
									{/if}
									<div class="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground mt-1">
										{#if cred.lastRefreshedAt}
											<span>Last refreshed {new Date(cred.lastRefreshedAt).toLocaleString()}</span>
										{/if}
										{#if cred.lastUsedAt}
											<span>Last used {new Date(cred.lastUsedAt).toLocaleString()}</span>
										{/if}
									</div>
								</div>
								<div class="flex gap-1">
									{#if cred.authType === 'mcp_oauth'}
										<Button
											variant="ghost"
											size="icon"
											class="size-7"
											disabled={refreshingId !== null}
											onclick={() => refreshNow(cred)}
											title="Refresh now (OAuth refresh_token grant)"
										>
											<RotateCw
												class="size-3.5 {refreshingId === cred.id ? 'animate-spin' : ''}"
											/>
										</Button>
									{/if}
									<Button
										variant="ghost"
										size="icon"
										class="size-7"
										onclick={() => openRotate(cred)}
										title="Edit / rotate manually"
									>
										<Pencil class="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="size-7 text-destructive"
										onclick={() => (toDelete = cred)}
										title="Archive"
									>
										<Trash2 class="size-3.5" />
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<Dialog bind:open={credentialDialogOpen}>
	<DialogContent class="max-h-[90vh] overflow-y-auto">
		<DialogHeader>
			<DialogTitle>
				{rotating ? `Rotate ${rotating.displayName}` : 'New credential'}
			</DialogTitle>
			<DialogDescription>
				Values are encrypted at rest and write-only. You won't be able to see them again after
				saving.
			</DialogDescription>
		</DialogHeader>
		<div class="space-y-3">
			<div>
				<Label>Display name</Label>
				<Input bind:value={cdName} placeholder="e.g. Notion workspace — foo" />
			</div>
			<div>
				<Label>Type</Label>
				<select
					class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
					bind:value={cdType}
					disabled={!!rotating}
				>
					<option value="mcp_oauth">MCP OAuth</option>
					<option value="bearer">Bearer token</option>
					<option value="basic">Basic auth</option>
					<option value="secret_text">Secret text</option>
				</select>
			</div>
			{#if cdType === 'mcp_oauth' || cdType === 'bearer'}
				<div>
					<Label>MCP server URL {cdType === 'mcp_oauth' ? '' : '(optional)'}</Label>
					<Input
						bind:value={cdMcpUrl}
						placeholder="https://mcp.notion.com/mcp"
					/>
				</div>
				<div>
					<Label>Access token</Label>
					<Input type="password" bind:value={cdAccessToken} placeholder="••••••" />
				</div>
			{/if}
			{#if cdType === 'mcp_oauth'}
				<div>
					<Label>Refresh token</Label>
					<Input type="password" bind:value={cdRefreshToken} placeholder="••••••" />
				</div>
				<div>
					<Label>Expires at (ISO or datetime-local)</Label>
					<Input type="datetime-local" bind:value={cdExpiresAt} />
				</div>
				<div class="border-t pt-3 space-y-3">
					<p class="text-xs font-medium text-muted-foreground">Refresh config</p>
					<div>
						<Label>Token endpoint</Label>
						<Input bind:value={cdTokenEndpoint} placeholder="https://..." />
					</div>
					<div>
						<Label>Client ID</Label>
						<Input bind:value={cdClientId} />
					</div>
					<div>
						<Label>Token endpoint auth</Label>
						<select
							class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
							bind:value={cdTokenEndpointAuth}
						>
							<option value="none">None (public client)</option>
							<option value="client_secret_basic">Basic (header)</option>
							<option value="client_secret_post">Body</option>
						</select>
					</div>
					{#if cdTokenEndpointAuth !== 'none'}
						<div>
							<Label>Client secret</Label>
							<Input type="password" bind:value={cdClientSecret} />
						</div>
					{/if}
				</div>
			{/if}
			{#if cdType === 'basic'}
				<div>
					<Label>Username</Label>
					<Input bind:value={cdUsername} />
				</div>
				<div>
					<Label>Password</Label>
					<Input type="password" bind:value={cdPassword} />
				</div>
			{/if}
			{#if cdType === 'secret_text'}
				<div>
					<Label>Secret</Label>
					<Input type="password" bind:value={cdSecret} />
				</div>
			{/if}
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (credentialDialogOpen = false)}>Cancel</Button>
			<Button onclick={submitCredential} disabled={!cdName.trim() || cdSaving}>
				{cdSaving ? 'Saving…' : rotating ? 'Rotate' : 'Create'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>

<AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && (toDelete = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Archive {toDelete?.displayName}?</AlertDialogTitle>
			<AlertDialogDescription>
				Archived credentials are not returned to the proxy; tool calls using them will fail.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={archiveCredential}>Archive</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>
