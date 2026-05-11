<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import {
		CheckCircle2,
		KeyRound,
		Loader2,
		Plug,
		Plus,
		RefreshCw,
		Search,
		ShieldCheck,
		Trash2,
		Unplug
	} from '@lucide/svelte';
	import type { PageData } from './$types';
	import type { VaultCredentialSummary, VaultSummary } from '$lib/types/vaults';

	type AppConnection = {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
		scope?: string;
		providerId: string;
		providerLabel: string;
		providerIconUrl: string | null;
		category: string | null;
		createdAt: string;
		updatedAt?: string;
	};

	type CatalogAppConnection = {
		id: string;
		externalId: string;
		displayName: string;
		type: string;
		status: string;
	};

	type McpConnection = {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		serverKey: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
		createdAt?: string;
	};

	type CatalogEntry = {
		pieceName: string;
		canonicalPieceName: string;
		displayName: string;
		description: string | null;
		logoUrl: string | null;
		categories: string[];
		authType: string;
		authDisplayName: string | null;
		requiresAuth: boolean;
		isOAuth2: boolean;
		oauthAppConfigured: boolean;
		actionCount: number;
		registryRef: string;
		serverUrl: string;
		appConnections: CatalogAppConnection[];
		mcpConnection: McpConnection | null;
	};

	type PendingOAuth = {
		state: string;
		connectionId: string;
		pieceName: string;
		codeVerifier: string;
		redirectUrl: string;
		addMcp: boolean;
	};

	const OAUTH_PENDING_KEY = 'workflow-builder:pending-oauth2-connection';

	let { data }: { data: PageData } = $props();
	const slug = $derived((page.params.slug as string) ?? 'default');

	let activeTab = $state('apps');
	let appConnections = $state<AppConnection[]>([]);
	let mcpConnections = $state<McpConnection[]>([]);
	let catalogEntries = $state<CatalogEntry[]>([]);
	let vaults = $state<VaultSummary[]>([]);
	let vaultCredentials = $state<VaultCredentialSummary[]>([]);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	let appSearch = $state('');
	let appStatus = $state('ALL');
	let mcpSearch = $state('');
	let selectedConnectionByPiece = $state<Record<string, string>>({});

	let addDialogOpen = $state(false);
	let selectedEntry = $state<CatalogEntry | null>(null);
	let secretValue = $state('');
	let connectionName = $state('');

	let customName = $state('');
	let customUrl = $state('');

	const filteredApps = $derived.by(() => {
		const q = appSearch.trim().toLowerCase();
		return appConnections.filter((conn) => {
			if (appStatus !== 'ALL' && conn.status !== appStatus) return false;
			if (!q) return true;
			return [
				conn.displayName,
				conn.pieceName,
				conn.providerLabel,
				conn.providerId,
				conn.status,
				conn.type
			]
				.join(' ')
				.toLowerCase()
				.includes(q);
		});
	});

	const filteredCatalog = $derived.by(() => {
		const q = mcpSearch.trim().toLowerCase();
		if (!q) return catalogEntries;
		return catalogEntries.filter((entry) =>
			[
				entry.displayName,
				entry.pieceName,
				entry.description ?? '',
				entry.authType,
				...entry.categories
			]
				.join(' ')
				.toLowerCase()
				.includes(q)
		);
	});

	const configuredMcp = $derived.by(() =>
		mcpConnections.filter((conn) => {
			const q = mcpSearch.trim().toLowerCase();
			if (!q) return true;
			return [
				conn.displayName,
				conn.pieceName ?? '',
				conn.serverKey ?? '',
				conn.sourceType,
				conn.status
			]
				.join(' ')
				.toLowerCase()
				.includes(q);
		})
	);

	onMount(() => {
		void loadAll().then(() => resumeOAuthIfPresent());
	});

	async function loadAll() {
		loading = true;
		errorMessage = null;
		try {
			const [appsRes, mcpRes, catalogRes, vaultsRes] = await Promise.all([
				fetch('/api/app-connections'),
				fetch('/api/mcp-connections'),
				fetch('/api/mcp-connections/catalog'),
				fetch('/api/v1/vaults')
			]);
			if (!appsRes.ok) throw new Error(`App connections failed (${appsRes.status})`);
			if (!mcpRes.ok) throw new Error(`MCP connections failed (${mcpRes.status})`);
			if (!catalogRes.ok) throw new Error(`MCP catalog failed (${catalogRes.status})`);

			appConnections = await appsRes.json();
			mcpConnections = await mcpRes.json();
			const catalogBody = (await catalogRes.json()) as { entries?: CatalogEntry[] };
			catalogEntries = catalogBody.entries ?? [];
			if (vaultsRes.ok) {
				const vaultBody = (await vaultsRes.json()) as { vaults?: VaultSummary[] };
				vaults = vaultBody.vaults ?? [];
				await loadVaultCredentials();
			}
			seedSelectedConnections();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadVaultCredentials() {
		const activeVaults = vaults.filter((vault) => !vault.isArchived);
		const results = await Promise.all(
			activeVaults.map(async (vault) => {
				const res = await fetch(`/api/v1/vaults/${vault.id}/credentials`);
				if (!res.ok) return [] as VaultCredentialSummary[];
				const body = (await res.json()) as { credentials?: VaultCredentialSummary[] };
				return body.credentials ?? [];
			})
		);
		vaultCredentials = results.flat();
	}

	function seedSelectedConnections() {
		const next: Record<string, string> = { ...selectedConnectionByPiece };
		for (const entry of catalogEntries) {
			if (!next[entry.pieceName]) {
				const current = entry.mcpConnection?.connectionExternalId;
				next[entry.pieceName] = current || entry.appConnections[0]?.externalId || '';
			}
		}
		selectedConnectionByPiece = next;
	}

	function openAddConnection(entry?: CatalogEntry) {
		selectedEntry = entry ?? null;
		secretValue = '';
		connectionName = entry ? `${entry.displayName}` : '';
		addDialogOpen = true;
	}

	async function createSecretConnection() {
		if (!selectedEntry || !connectionName.trim() || !secretValue.trim()) return;
		busy = `secret:${selectedEntry.pieceName}`;
		try {
			const res = await fetch('/api/app-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pieceName: selectedEntry.canonicalPieceName,
					displayName: connectionName.trim(),
					type: 'SECRET_TEXT',
					value: secretValue.trim()
				})
			});
			if (!res.ok) throw new Error(await res.text());
			toast.success('Connection created');
			addDialogOpen = false;
			await loadAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create connection');
		} finally {
			busy = null;
		}
	}

	async function beginOAuthConnection(entry: CatalogEntry, addMcp: boolean) {
		if (!entry.oauthAppConfigured) {
			toast.error('Configure the platform OAuth app before connecting this provider');
			return;
		}
		busy = `oauth:${entry.pieceName}`;
		try {
			const redirectUrl = `${window.location.origin}/api/app-connections/oauth2/callback`;
			const createRes = await fetch('/api/app-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pieceName: entry.canonicalPieceName,
					displayName: connectionName.trim() || entry.displayName,
					type: 'PLATFORM_OAUTH2',
					value: {
						redirect_url: redirectUrl
					}
				})
			});
			if (!createRes.ok) throw new Error(await createRes.text());
			const connection = (await createRes.json()) as AppConnection;

			const startRes = await fetch('/api/app-connections/oauth2/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pieceName: entry.canonicalPieceName,
					redirectUrl
				})
			});
			if (!startRes.ok) throw new Error(await startRes.text());
			const start = (await startRes.json()) as {
				authorizationUrl: string;
				state: string;
				codeVerifier: string;
				redirectUrl: string;
			};
			const pending: PendingOAuth = {
				state: start.state,
				connectionId: connection.id,
				pieceName: entry.canonicalPieceName,
				codeVerifier: start.codeVerifier,
				redirectUrl: start.redirectUrl,
				addMcp
			};
			localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));
			window.location.href = start.authorizationUrl;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start OAuth');
			busy = null;
		}
	}

	async function resumeOAuthIfPresent() {
		const callback = data.oauthCallback as Record<string, string | null> | null;
		if (!callback) return;
		if (callback.error) {
			toast.error(callback.errorDescription || callback.error);
			return;
		}
		const raw = localStorage.getItem(OAUTH_PENDING_KEY);
		if (!raw) return;
		const pending = JSON.parse(raw) as PendingOAuth;
		if (pending.state !== callback.state || !callback.code) return;

		busy = 'oauth-resume';
		try {
			const completeRes = await fetch('/api/app-connections/oauth2/complete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					connectionId: pending.connectionId,
					pieceName: pending.pieceName,
					code: callback.code,
					codeVerifier: pending.codeVerifier,
					redirectUrl: pending.redirectUrl
				})
			});
			if (!completeRes.ok) throw new Error(await completeRes.text());
			const body = (await completeRes.json()) as { connection: AppConnection };
			if (pending.addMcp) {
				await createPieceMcp(pending.pieceName, body.connection.externalId);
			}
			localStorage.removeItem(OAUTH_PENDING_KEY);
			toast.success(pending.addMcp ? 'Connected and added MCP server' : 'Connection created');
			await invalidateAll();
			await loadAll();
			goto(`/workspaces/${slug}/connections`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'OAuth completion failed');
		} finally {
			busy = null;
		}
	}

	async function createPieceMcp(pieceName: string, connectionExternalId?: string | null) {
		const res = await fetch('/api/mcp-connections', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sourceType: 'nimble_piece',
				pieceName,
				connectionExternalId: connectionExternalId || null
			})
		});
		if (!res.ok) throw new Error(await res.text());
		return (await res.json()) as McpConnection;
	}

	async function addMcp(entry: CatalogEntry) {
		const selectedExternalId = selectedConnectionByPiece[entry.pieceName] || '';
		if (entry.requiresAuth && !selectedExternalId) {
			toast.error('Choose or create an app connection first');
			return;
		}
		busy = `mcp:${entry.pieceName}`;
		try {
			await createPieceMcp(entry.canonicalPieceName, selectedExternalId || null);
			toast.success('MCP server enabled for this workspace');
			await loadAll();
			activeTab = 'mcp';
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to enable MCP server');
		} finally {
			busy = null;
		}
	}

	async function createCustomMcp() {
		if (!customName.trim() || !customUrl.trim()) return;
		busy = 'custom-mcp';
		try {
			const res = await fetch('/api/mcp-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sourceType: 'custom_url',
					displayName: customName.trim(),
					serverUrl: customUrl.trim()
				})
			});
			if (!res.ok) throw new Error(await res.text());
			customName = '';
			customUrl = '';
			toast.success('Custom MCP server added');
			await loadAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to add custom MCP');
		} finally {
			busy = null;
		}
	}

	async function toggleMcp(conn: McpConnection) {
		busy = `toggle:${conn.id}`;
		try {
			const next = conn.status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
			const res = await fetch(`/api/mcp-connections/${conn.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: next })
			});
			if (!res.ok) throw new Error(await res.text());
			await loadAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to update MCP server');
		} finally {
			busy = null;
		}
	}

	async function deleteMcp(conn: McpConnection) {
		busy = `delete:${conn.id}`;
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(await res.text());
			toast.success('MCP server removed');
			await loadAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to remove MCP server');
		} finally {
			busy = null;
		}
	}

	function matchingVaultCredentials(url: string | null | undefined): VaultCredentialSummary[] {
		if (!url) return [];
		return vaultCredentials.filter((cred) => cred.mcpServerUrl === url && !cred.isArchived);
	}

	function formatDate(value: string | undefined): string {
		if (!value) return '';
		return new Date(value).toLocaleDateString();
	}
</script>

<svelte:head>
	<title>Connections · Workflow Builder</title>
</svelte:head>

<div class="h-full overflow-auto">
	<div class="mx-auto max-w-7xl p-6 space-y-5">
		<header class="flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-2xl font-semibold">Connections</h1>
				<p class="text-sm text-muted-foreground mt-1">
					Connect apps and expose approved MCP servers to workflows and managed agents.
				</p>
			</div>
			<Button onclick={() => void loadAll()} variant="outline" disabled={loading}>
				{#if loading}
					<Loader2 class="size-4 animate-spin" />
				{:else}
					<RefreshCw class="size-4" />
				{/if}
				Refresh
			</Button>
		</header>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<Tabs value={activeTab} onValueChange={(value) => (activeTab = value)}>
			<TabsList>
				<TabsTrigger value="apps"><KeyRound class="size-4" /> App Connections</TabsTrigger>
				<TabsTrigger value="mcp"><Plug class="size-4" /> MCP Servers</TabsTrigger>
			</TabsList>

			<TabsContent value="apps" class="space-y-4 pt-4">
				<div class="flex items-center gap-2 flex-wrap">
					<div class="relative min-w-[280px] flex-1">
						<Search class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
						<Input class="pl-9" placeholder="Search connections" bind:value={appSearch} />
					</div>
					<NativeSelect bind:value={appStatus} class="w-[160px]">
						<option value="ALL">All statuses</option>
						<option value="ACTIVE">Active</option>
						<option value="MISSING">Missing</option>
						<option value="ERROR">Error</option>
					</NativeSelect>
					<Button onclick={() => openAddConnection()}>
						<Plus class="size-4" /> New connection
					</Button>
				</div>

				<div class="rounded-md border overflow-hidden">
					<table class="w-full text-sm">
						<thead class="bg-muted/50 text-xs text-muted-foreground">
							<tr>
								<th class="text-left px-4 py-2 font-medium">Name</th>
								<th class="text-left px-4 py-2 font-medium">Provider</th>
								<th class="text-left px-4 py-2 font-medium">Type</th>
								<th class="text-left px-4 py-2 font-medium">Status</th>
								<th class="text-left px-4 py-2 font-medium">Created</th>
							</tr>
						</thead>
						<tbody>
							{#if loading}
								<tr><td colspan="5" class="px-4 py-8 text-center text-muted-foreground">Loading connections…</td></tr>
							{:else if filteredApps.length === 0}
								<tr><td colspan="5" class="px-4 py-8 text-center text-muted-foreground">No app connections found.</td></tr>
							{:else}
								{#each filteredApps as conn (conn.id)}
									<tr class="border-t">
										<td class="px-4 py-3">
											<div class="font-medium">{conn.displayName}</div>
											<div class="text-[11px] text-muted-foreground">{conn.externalId}</div>
										</td>
										<td class="px-4 py-3">
											<div class="flex items-center gap-2">
												{#if conn.providerIconUrl}
													<img src={conn.providerIconUrl} alt="" class="size-5 rounded" />
												{/if}
												<span>{conn.providerLabel}</span>
											</div>
										</td>
										<td class="px-4 py-3 text-xs text-muted-foreground">{conn.type}</td>
										<td class="px-4 py-3"><Badge variant={conn.status === 'ACTIVE' ? 'default' : 'outline'}>{conn.status}</Badge></td>
										<td class="px-4 py-3 text-xs text-muted-foreground">{formatDate(conn.createdAt)}</td>
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				</div>
			</TabsContent>

			<TabsContent value="mcp" class="space-y-5 pt-4">
				<div class="flex items-center gap-2 flex-wrap">
					<div class="relative min-w-[280px] flex-1">
						<Search class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
						<Input class="pl-9" placeholder="Search MCP servers" bind:value={mcpSearch} />
					</div>
				</div>

				<section class="space-y-3">
					<div class="flex items-center justify-between gap-3">
						<h2 class="text-sm font-semibold">Workspace MCP Servers</h2>
						<Badge variant="outline">{configuredMcp.length}</Badge>
					</div>
					<div class="rounded-md border divide-y">
						{#if configuredMcp.length === 0}
							<div class="p-4 text-sm text-muted-foreground">No MCP servers are enabled for this workspace.</div>
						{:else}
							{#each configuredMcp as conn (conn.id)}
								<div class="p-3 flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="font-medium text-sm">{conn.displayName}</span>
											<Badge variant={conn.status === 'ENABLED' ? 'default' : 'outline'}>{conn.status}</Badge>
											<Badge variant="outline">{conn.sourceType}</Badge>
											{#if matchingVaultCredentials(conn.serverUrl).length > 0}
												<Badge variant="secondary">
													<ShieldCheck class="size-3" />
													Vault auth
												</Badge>
											{/if}
										</div>
										<div class="text-[11px] text-muted-foreground truncate mt-1">{conn.serverUrl}</div>
									</div>
									<div class="flex items-center gap-1">
										<Button variant="ghost" size="sm" onclick={() => toggleMcp(conn)}>
											{#if conn.status === 'ENABLED'}<Unplug class="size-4" /> Disable{:else}<Plug class="size-4" /> Enable{/if}
										</Button>
										{#if conn.sourceType !== 'hosted_workflow'}
											<Button variant="ghost" size="icon" class="text-destructive" onclick={() => deleteMcp(conn)}>
												<Trash2 class="size-4" />
											</Button>
										{/if}
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</section>

				<section class="space-y-3">
					<h2 class="text-sm font-semibold">Add Predefined MCP Server</h2>
					<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
						{#each filteredCatalog as entry (entry.pieceName)}
							<Card class="overflow-hidden">
								<CardHeader class="pb-2">
									<div class="flex items-start justify-between gap-3">
										<div class="flex items-center gap-2 min-w-0">
											{#if entry.logoUrl}
												<img src={entry.logoUrl} alt="" class="size-8 rounded" />
											{/if}
											<div class="min-w-0">
												<CardTitle class="text-sm truncate">{entry.displayName}</CardTitle>
												<p class="text-[11px] text-muted-foreground truncate">{entry.pieceName}</p>
											</div>
										</div>
										{#if entry.mcpConnection}
											<Badge variant={entry.mcpConnection.status === 'ENABLED' ? 'default' : 'outline'}>
												{entry.mcpConnection.status}
											</Badge>
										{/if}
									</div>
								</CardHeader>
								<CardContent class="space-y-3">
									<div class="flex items-center gap-1 flex-wrap">
										<Badge variant="outline">{entry.actionCount} tools</Badge>
										<Badge variant="outline">{entry.authType}</Badge>
										{#if entry.isOAuth2 && entry.oauthAppConfigured}
											<Badge variant="secondary"><CheckCircle2 class="size-3" /> OAuth app</Badge>
										{/if}
									</div>
									{#if entry.requiresAuth}
										{#if entry.appConnections.length > 0}
											<NativeSelect
												value={selectedConnectionByPiece[entry.pieceName] || ''}
												onchange={(e) =>
													(selectedConnectionByPiece = {
														...selectedConnectionByPiece,
														[entry.pieceName]: (e.currentTarget as HTMLSelectElement).value
													})}
											>
												{#each entry.appConnections as conn (conn.externalId)}
													<option value={conn.externalId}>{conn.displayName}</option>
												{/each}
											</NativeSelect>
											<Button class="w-full" onclick={() => addMcp(entry)} disabled={busy === `mcp:${entry.pieceName}`}>
												<Plug class="size-4" /> {entry.mcpConnection ? 'Update MCP binding' : 'Add MCP'}
											</Button>
										{:else if entry.isOAuth2}
											<Button class="w-full" onclick={() => beginOAuthConnection(entry, true)} disabled={!entry.oauthAppConfigured || busy === `oauth:${entry.pieceName}`}>
												{#if busy === `oauth:${entry.pieceName}`}<Loader2 class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
												Connect & add
											</Button>
											{#if !entry.oauthAppConfigured}
												<p class="text-[11px] text-muted-foreground">
													Configure this provider in <a href="/settings" class="underline">Settings</a> first.
												</p>
											{/if}
										{:else}
											<Button class="w-full" variant="outline" onclick={() => openAddConnection(entry)}>
												<KeyRound class="size-4" /> Create app connection
											</Button>
										{/if}
									{:else}
										<Button class="w-full" onclick={() => addMcp(entry)}>
											<Plug class="size-4" /> {entry.mcpConnection ? 'Refresh MCP' : 'Add MCP'}
										</Button>
									{/if}
								</CardContent>
							</Card>
						{/each}
					</div>
				</section>

				<section class="space-y-3">
					<h2 class="text-sm font-semibold">Custom MCP Server</h2>
					<div class="rounded-md border p-4 space-y-3">
						<div class="grid grid-cols-1 md:grid-cols-[220px_1fr_auto] gap-2 items-end">
							<div>
								<Label>Name</Label>
								<Input bind:value={customName} placeholder="GitHub MCP" />
							</div>
							<div>
								<Label>Server URL</Label>
								<Input bind:value={customUrl} placeholder="https://example.com/mcp" />
							</div>
							<Button onclick={createCustomMcp} disabled={!customName.trim() || !customUrl.trim() || busy === 'custom-mcp'}>
								<Plus class="size-4" /> Add custom
							</Button>
						</div>
						<p class="text-xs text-muted-foreground">
							Authenticated custom servers use vault credentials with an exact matching MCP server URL.
							<a href="/workspaces/{slug}/credentials" class="underline">Manage vault credentials</a>.
						</p>
						{#if customUrl.trim()}
							<p class="text-xs text-muted-foreground">
								Matching vault credentials: {matchingVaultCredentials(customUrl.trim()).length}
							</p>
						{/if}
					</div>
				</section>
			</TabsContent>
		</Tabs>
	</div>
</div>

<Dialog bind:open={addDialogOpen}>
	<DialogContent class="sm:max-w-4xl max-h-[85vh]">
		<DialogHeader>
			<DialogTitle>New app connection</DialogTitle>
			<DialogDescription>Select a provider and establish a user connection for this workspace.</DialogDescription>
		</DialogHeader>

		<div class="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] gap-4 min-h-[360px]">
			<div class="border rounded-md overflow-hidden">
				<div class="p-2 border-b">
					<Input placeholder="Search providers" bind:value={mcpSearch} />
				</div>
				<div class="max-h-[320px] overflow-auto divide-y">
					{#each filteredCatalog.filter((entry) => entry.requiresAuth) as entry (entry.pieceName)}
						<button
							type="button"
							class="w-full text-left p-2 hover:bg-muted/60 {selectedEntry?.pieceName === entry.pieceName ? 'bg-muted' : ''}"
							onclick={() => {
								selectedEntry = entry;
								connectionName = entry.displayName;
								secretValue = '';
							}}
						>
							<div class="flex items-center gap-2">
								{#if entry.logoUrl}<img src={entry.logoUrl} alt="" class="size-5 rounded" />{/if}
								<div class="min-w-0">
									<div class="text-sm font-medium truncate">{entry.displayName}</div>
									<div class="text-[10px] text-muted-foreground">{entry.authType}</div>
								</div>
							</div>
						</button>
					{/each}
				</div>
			</div>

			<div class="space-y-4">
				{#if selectedEntry}
					<div class="flex items-center gap-3">
						{#if selectedEntry.logoUrl}<img src={selectedEntry.logoUrl} alt="" class="size-10 rounded" />{/if}
						<div>
							<h3 class="font-semibold">{selectedEntry.displayName}</h3>
							<p class="text-xs text-muted-foreground">{selectedEntry.authDisplayName ?? selectedEntry.authType}</p>
						</div>
					</div>
					<div>
						<Label>Connection name</Label>
						<Input bind:value={connectionName} />
					</div>
					{#if selectedEntry.isOAuth2}
						<Alert>
							<AlertDescription>
								OAuth uses the platform app configured in Settings. Tokens are encrypted in app connections and refreshed server-side.
							</AlertDescription>
						</Alert>
						<Button onclick={() => beginOAuthConnection(selectedEntry!, false)} disabled={!selectedEntry.oauthAppConfigured || busy === `oauth:${selectedEntry.pieceName}`}>
							{#if busy === `oauth:${selectedEntry.pieceName}`}<Loader2 class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
							Start OAuth
						</Button>
						{#if !selectedEntry.oauthAppConfigured}
							<p class="text-xs text-muted-foreground">
								This provider needs a platform OAuth app first. Open <a href="/settings" class="underline">Settings</a> to configure it.
							</p>
						{/if}
					{:else}
						<div>
							<Label>Secret value</Label>
							<Input bind:value={secretValue} type="password" placeholder="Paste API key or token" />
						</div>
						<Button onclick={createSecretConnection} disabled={!connectionName.trim() || !secretValue.trim()}>
							<KeyRound class="size-4" /> Create connection
						</Button>
					{/if}
				{:else}
					<div class="h-full flex items-center justify-center text-sm text-muted-foreground">
						Select a provider.
					</div>
				{/if}
			</div>
		</div>

		<DialogFooter>
			<Button variant="outline" onclick={() => (addDialogOpen = false)}>Close</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
