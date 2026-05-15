<script lang="ts">
	import { page } from '$app/stores';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
	import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
	import { CircleAlert, Copy, Check, Lock, Trash2, Loader2, Power, PowerOff, Plus } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { env } from '$env/dynamic/public';

	type ApiKey = {
		id: string;
		name: string | null;
		keyPrefix: string;
		createdAt: string;
		lastUsedAt: string | null;
	};

	let activeTab = $state('api-keys');
	let apiKeys = $state<ApiKey[]>([]);
	let loading = $state(false);
	let newKeyName = $state('');
	let creating = $state(false);
	let generatedKey = $state<string | null>(null);
	let showKeyDialog = $state(false);
	let deleteConfirmId = $state<string | null>(null);
	let deleting = $state(false);
	let errorMessage = $state<string | null>(null);
	let copiedField = $state<string | null>(null);

	// Server-loaded data
	const profile = $derived($page.data.profile as {
		id: string;
		name: string | null;
		email: string | null;
		image: string | null;
		platformId: string | null;
		platformRole: string | null;
	} | null);

	const baseUrl = $derived($page.data.baseUrl as string);

	// Database-loaded OAuth apps (enriched with display names and logos from server)
	const oauthApps = $derived(($page.data.oauthApps ?? []) as Array<{
		id: string | null;
		pieceName: string;
		clientId: string;
		displayName: string;
		logoUrl: string | null;
		configured: boolean;
		createdAt: string | null;
		updatedAt: string | null;
	}>);

	// Redirect URI for OAuth apps
	const redirectUri = $derived(`${baseUrl}/api/app-connections/oauth2/callback`);

	// OAuth app configure dialog
	let oauthDialogOpen = $state(false);
	let oauthDialogApp = $state<typeof oauthApps[number] | null>(null);
	let oauthClientId = $state('');
	let oauthClientSecret = $state('');
	let oauthSaving = $state(false);

	function openOauthDialog(app: typeof oauthApps[number]) {
		oauthDialogApp = app;
		oauthClientId = app.clientId;
		oauthClientSecret = '';
		oauthDialogOpen = true;
	}

	async function saveOauthApp() {
		if (!oauthDialogApp || !oauthClientId.trim()) return;
		oauthSaving = true;
		try {
			const res = await fetch('/api/settings/oauth-apps', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: oauthDialogApp.id,
					pieceName: oauthDialogApp.pieceName,
					clientId: oauthClientId.trim(),
					clientSecret: oauthClientSecret.trim() || undefined
				})
			});
			if (res.ok) {
				oauthDialogOpen = false;
				oauthDialogApp = null;
				toast.success('OAuth app saved');
				await invalidateAll();
			} else {
				const data = await res.json().catch(() => ({}));
				toast.error(data.message || 'Failed to save OAuth app');
			}
		} catch {
			toast.error('Failed to save OAuth app');
		} finally {
			oauthSaving = false;
		}
	}

	async function deleteOauthApp(app: typeof oauthApps[number]) {
		if (!app.id) return;
		try {
			const res = await fetch(`/api/settings/oauth-apps?id=${app.id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success(`Removed ${app.displayName}`);
				await invalidateAll();
			} else {
				toast.error('Failed to remove OAuth app');
			}
		} catch {
			toast.error('Failed to remove OAuth app');
		}
	}

	// MCP Connections
	interface McpConnection {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
		createdAt: string;
	}

	interface AppConnection {
		externalId: string;
		pieceName: string;
		displayName: string;
		providerId: string;
		providerLabel: string;
		status: string;
		type: string;
	}

	let mcpConnections = $state<McpConnection[]>([]);
	let appConnections = $state<AppConnection[]>([]);
	let mcpLoading = $state(false);
	let mcpCustomName = $state('');
	let mcpCustomUrl = $state('');
	let mcpCreating = $state(false);
	let mcpBusyId = $state<string | null>(null);

	async function loadMcpConnections() {
		mcpLoading = true;
		try {
			const res = await fetch('/api/mcp-connections');
			if (res.ok) mcpConnections = await res.json();
		} catch { /* */ } finally { mcpLoading = false; }
	}

	async function loadAppConnections() {
		try {
			const res = await fetch('/api/app-connections');
			if (res.ok) appConnections = await res.json();
		} catch { /* */ }
	}

	async function createMcpCustom() {
		if (!mcpCustomName.trim() || !mcpCustomUrl.trim()) return;
		mcpCreating = true;
		try {
			const res = await fetch('/api/mcp-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: mcpCustomName.trim(), serverUrl: mcpCustomUrl.trim(), sourceType: 'custom_url' })
			});
			if (res.ok) {
				mcpCustomName = '';
				mcpCustomUrl = '';
				toast.success('MCP connection created');
				await loadMcpConnections();
			} else { toast.error('Failed to create connection'); }
		} catch { toast.error('Failed to create connection'); } finally { mcpCreating = false; }
	}

	async function toggleMcpStatus(conn: McpConnection) {
		mcpBusyId = conn.id;
		const newStatus = conn.status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: newStatus })
			});
			if (res.ok) { toast.success(`${conn.displayName} ${newStatus.toLowerCase()}`); await loadMcpConnections(); }
			else { toast.error('Failed to update status'); }
		} catch { toast.error('Failed to update status'); } finally { mcpBusyId = null; }
	}

	async function updateMcpCredential(conn: McpConnection, connectionExternalId: string) {
		mcpBusyId = conn.id;
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionExternalId: connectionExternalId || null })
			});
			if (res.ok) {
				toast.success('MCP credential binding updated');
				await loadMcpConnections();
			} else {
				const data = await res.json().catch(() => ({}));
				toast.error(data.message || 'Failed to update credential binding');
			}
		} catch {
			toast.error('Failed to update credential binding');
		} finally {
			mcpBusyId = null;
		}
	}

	async function deleteMcpConnection(conn: McpConnection) {
		mcpBusyId = conn.id;
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, { method: 'DELETE' });
			if (res.ok) { toast.success(`Deleted ${conn.displayName}`); await loadMcpConnections(); }
			else { const data = await res.json().catch(() => ({})); toast.error(data.message || 'Failed to delete'); }
		} catch { toast.error('Failed to delete'); } finally { mcpBusyId = null; }
	}

	function mcpSourceLabel(type: string): string {
		switch (type) {
			case 'nimble_piece': return 'Piece';
			case 'nimble_shared': return 'Shared';
			case 'custom_url': return 'Custom';
			case 'hosted_workflow': return 'Hosted';
			default: return type;
		}
	}

	function mcpToolCount(conn: McpConnection): number {
		return (conn.metadata as Record<string, unknown>)?.toolCount as number ?? 0;
	}

	function normalizePieceName(value: string | null | undefined): string {
		return (value || '')
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[_\s]+/g, '-')
			.replace(/-+/g, '-');
	}

	function appConnectionsForMcp(conn: McpConnection): AppConnection[] {
		const piece = normalizePieceName(conn.pieceName);
		if (!piece) return [];
		return appConnections.filter((app) => normalizePieceName(app.pieceName) === piece && app.status === 'ACTIVE');
	}

	async function loadApiKeys() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys');
			if (res.ok) {
				apiKeys = await res.json();
			} else {
				errorMessage = 'Failed to load API keys';
			}
		} catch {
			errorMessage = 'Failed to load API keys';
		} finally {
			loading = false;
		}
	}

	async function createApiKey() {
		if (!newKeyName.trim()) return;
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newKeyName.trim() })
			});
			if (res.ok) {
				const data = await res.json();
				generatedKey = data.key;
				showKeyDialog = true;
				newKeyName = '';
				await loadApiKeys();
			} else {
				const err = await res.json().catch(() => ({}));
				errorMessage = err.message || 'Failed to create API key';
			}
		} catch {
			errorMessage = 'Failed to create API key';
		} finally {
			creating = false;
		}
	}

	async function deleteApiKey(id: string) {
		deleting = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' });
			if (res.ok) {
				deleteConfirmId = null;
				await loadApiKeys();
			} else {
				errorMessage = 'Failed to delete API key';
			}
		} catch {
			errorMessage = 'Failed to delete API key';
		} finally {
			deleting = false;
		}
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		return new Date(dateStr).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function copyToClipboard(text: string, field?: string) {
		navigator.clipboard.writeText(text);
		if (field) {
			copiedField = field;
			setTimeout(() => {
				copiedField = null;
			}, 2000);
		}
	}

	// Load API keys on mount
	$effect(() => {
		if (activeTab === 'api-keys') {
			loadApiKeys();
		}
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Settings</h1>
	</header>
	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-5xl">
			<Tabs value={activeTab} onValueChange={(v) => { activeTab = v; if (v === 'mcp-connections') { if (mcpConnections.length === 0) loadMcpConnections(); if (appConnections.length === 0) loadAppConnections(); } }}>
				<TabsList class="mb-6 h-9">
					<TabsTrigger value="api-keys" class="text-xs px-3">API Keys</TabsTrigger>
					<TabsTrigger value="profile" class="text-xs px-3">Profile</TabsTrigger>
					<TabsTrigger value="oauth-apps" class="text-xs px-3">OAuth Apps</TabsTrigger>
					<TabsTrigger value="mcp-connections" class="text-xs px-3">MCP Connections</TabsTrigger>
				</TabsList>

				<!-- API Keys Tab -->
				<TabsContent value="api-keys">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">API Keys</h2>
							<p class="text-sm text-muted-foreground">
								Create and manage API keys for programmatic access to the workflow builder.
							</p>
						</div>

						{#if errorMessage}
							<Alert variant="destructive">
								<CircleAlert class="size-4" />
								<AlertDescription>{errorMessage}</AlertDescription>
							</Alert>
						{/if}

						<!-- Create new key -->
						<Card>
							<CardContent class="pt-6">
								<div class="flex items-end gap-3">
									<div class="flex-1 space-y-1.5">
										<Label for="key-name">Key Name</Label>
										<Input
											id="key-name"
											placeholder="e.g. CI/CD Pipeline"
											value={newKeyName}
											oninput={(e) => {
												newKeyName = e.currentTarget.value;
											}}
											onkeydown={(e) => {
												if (e.key === 'Enter') createApiKey();
											}}
										/>
									</div>
									<Button onclick={createApiKey} disabled={creating || !newKeyName.trim()}>
										{creating ? 'Creating...' : 'Generate Key'}
									</Button>
								</div>
							</CardContent>
						</Card>

						<!-- Keys list -->
						{#if loading}
							<div class="py-8 text-center text-sm text-muted-foreground">Loading API keys...</div>
						{:else if apiKeys.length === 0}
							<Card>
								<CardContent class="py-8 text-center">
									<p class="text-sm text-muted-foreground">
										No API keys yet. Create one above to get started.
									</p>
								</CardContent>
							</Card>
						{:else}
							<div class="space-y-3">
								{#each apiKeys as key (key.id)}
									<Card>
										<CardContent class="flex items-center justify-between py-4">
											<div class="min-w-0 flex-1">
												<div class="flex items-center gap-2">
													<span class="text-sm font-medium">{key.name || 'Unnamed'}</span>
													<Badge variant="outline">
														<code class="text-xs">{key.keyPrefix}</code>
													</Badge>
													<Badge variant="secondary" class="text-xs">Active</Badge>
												</div>
												<div class="mt-1 flex gap-4 text-xs text-muted-foreground">
													<span>Created: {formatDate(key.createdAt)}</span>
													<span>Last used: {formatDate(key.lastUsedAt)}</span>
												</div>
											</div>
											<div>
												{#if deleteConfirmId === key.id}
													<div class="flex items-center gap-2">
														<span class="text-xs text-muted-foreground">Delete?</span>
														<Button
															size="sm"
															variant="destructive"
															onclick={() => deleteApiKey(key.id)}
															disabled={deleting}
														>
															{deleting ? '...' : 'Yes'}
														</Button>
														<Button
															size="sm"
															variant="outline"
															onclick={() => (deleteConfirmId = null)}
														>
															No
														</Button>
													</div>
												{:else}
													<Button
														size="sm"
														variant="ghost"
														onclick={() => (deleteConfirmId = key.id)}
													>
														Delete
													</Button>
												{/if}
											</div>
										</CardContent>
									</Card>
								{/each}
							</div>
						{/if}
					</div>
				</TabsContent>

				<!-- Profile Tab -->
				<TabsContent value="profile">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">Profile</h2>
							<p class="text-sm text-muted-foreground">Your account information.</p>
						</div>

						{#if profile}
							<Card>
								<CardHeader>
									<CardTitle class="text-sm">Profile</CardTitle>
								</CardHeader>
								<CardContent class="space-y-3">
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Name</Label>
										<span class="text-sm">{profile.name || 'Not set'}</span>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Email</Label>
										<span class="text-sm">{profile.email || 'Not set'}</span>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Avatar</Label>
										<div>
											{#if profile.image}
												<img
													src={profile.image}
													alt="Avatar"
													class="h-8 w-8 rounded-full"
												/>
											{:else}
												<div
													class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium"
												>
													{(profile.name || profile.email || '?').charAt(0).toUpperCase()}
												</div>
											{/if}
										</div>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Platform ID</Label>
										<code class="rounded bg-muted px-2 py-0.5 text-xs"
											>{profile.platformId || 'Not set'}</code
										>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">User ID</Label>
										<code class="rounded bg-muted px-2 py-0.5 text-xs">{profile.id}</code>
									</div>
								</CardContent>
							</Card>
						{:else}
							<Card>
								<CardContent class="py-8 text-center">
									<p class="text-sm text-muted-foreground">No session found. Please sign in.</p>
								</CardContent>
							</Card>
						{/if}
					</div>
				</TabsContent>

				<!-- OAuth Apps Tab -->
				<TabsContent value="oauth-apps">
					<div class="space-y-4">
						<!-- Redirect URI helper -->
						<Card class="bg-muted/30">
							<CardContent class="py-3 space-y-1.5">
								<div>
									<Label class="text-xs font-medium">Redirect URI</Label>
									<p class="text-[10px] text-muted-foreground">Use this as the redirect/callback URI when registering OAuth apps with providers.</p>
								</div>
								<div class="flex items-center gap-2">
									<code class="flex-1 rounded-md bg-muted px-3 py-1.5 font-mono text-[11px] truncate">{redirectUri}</code>
									<Button
										variant="outline"
										size="sm"
										class="h-7 shrink-0"
										onclick={() => copyToClipboard(redirectUri, 'redirect-uri')}
									>
										{#if copiedField === 'redirect-uri'}
											<Check size={12} class="text-green-500" />
										{:else}
											<Copy size={12} />
										{/if}
									</Button>
								</div>
							</CardContent>
						</Card>

						<!-- OAuth Apps Table -->
						{#if oauthApps.length === 0}
							<div class="py-12 text-center text-sm text-muted-foreground">
								No OAuth-capable pieces found. Sync piece metadata first.
							</div>
						{:else}
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Piece</TableHead>
										<TableHead>Client ID</TableHead>
										<TableHead>Status</TableHead>
										<TableHead class="text-right">Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{#each oauthApps as app (app.id ?? app.pieceName)}
										<TableRow>
											<TableCell>
												<div class="flex items-center gap-2">
													{#if app.logoUrl}
														<img src={app.logoUrl} alt={app.displayName} class="h-5 w-5 rounded" />
													{:else}
														<div class="flex h-5 w-5 items-center justify-center rounded bg-muted text-[9px] font-medium">
															{app.displayName.charAt(0)}
														</div>
													{/if}
													<span class="text-xs font-medium">{app.displayName}</span>
												</div>
											</TableCell>
											<TableCell>
												{#if app.clientId}
													<code class="font-mono text-[10px] text-muted-foreground">{app.clientId}</code>
												{:else}
													<span class="text-[10px] text-muted-foreground">Not configured</span>
												{/if}
											</TableCell>
											<TableCell>
												{#if app.configured}
													<Badge variant="default" class="gap-1 text-[9px]">
														<Lock size={10} />
														Configured
													</Badge>
												{:else}
													<Badge variant="secondary" class="text-[9px]">Missing</Badge>
												{/if}
											</TableCell>
											<TableCell class="text-right">
												<div class="flex items-center justify-end gap-1">
													<Button variant="outline" size="sm" class="h-7 text-[10px]" onclick={() => openOauthDialog(app)}>
														{app.configured ? 'Update' : 'Configure'}
													</Button>
													{#if app.id}
														<Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" onclick={() => deleteOauthApp(app)}>
															<Trash2 size={12} />
														</Button>
													{/if}
												</div>
											</TableCell>
										</TableRow>
									{/each}
								</TableBody>
							</Table>
						{/if}
					</div>
				</TabsContent>

				<!-- MCP Connections Tab -->
				<TabsContent value="mcp-connections">
					<div class="space-y-6">
						<Card>
							<CardContent class="py-3 text-xs text-muted-foreground">
								Workspace Connections is the primary place to enable registered MCP services and bind app connection auth.
								<a href="/connections?tab=mcp" class="underline">Open workspace MCP connections</a>.
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle class="flex items-center gap-2 text-sm">
									Add Custom MCP Server
								</CardTitle>
							</CardHeader>
							<CardContent>
								<form class="flex items-end gap-3" onsubmit={(e) => { e.preventDefault(); createMcpCustom(); }}>
									<div class="flex-1 space-y-1">
										<Label class="text-[11px]">Display Name</Label>
										<Input bind:value={mcpCustomName} placeholder="My MCP Server" class="text-xs" />
									</div>
									<div class="flex-[2] space-y-1">
										<Label class="text-[11px]">Server URL</Label>
										<Input bind:value={mcpCustomUrl} placeholder="https://example.com/mcp" class="font-mono text-xs" />
									</div>
									<Button size="sm" class="h-8" type="submit" disabled={mcpCreating || !mcpCustomName.trim() || !mcpCustomUrl.trim()}>
										{#if mcpCreating}<Loader2 size={12} class="animate-spin" />{/if}
										<Plus size={12} />
										Add
									</Button>
								</form>
							</CardContent>
						</Card>

						<!-- MCP Connections Table -->
						<div>
							<h3 class="text-sm font-semibold mb-3">Managed Connections</h3>
							{#if mcpLoading}
								<div class="flex items-center justify-center py-8">
									<Loader2 size={16} class="animate-spin text-muted-foreground" />
								</div>
							{:else if mcpConnections.length === 0}
								<Card>
									<CardContent class="py-8 text-center text-muted-foreground">
										<p class="text-xs">No MCP connections configured.</p>
									</CardContent>
								</Card>
							{:else}
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead>Source</TableHead>
											<TableHead>Credential</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Server URL</TableHead>
											<TableHead>Tools</TableHead>
											<TableHead class="text-right">Actions</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each mcpConnections as conn (conn.id)}
											{@const matchingAppConnections = appConnectionsForMcp(conn)}
											<TableRow>
												<TableCell class="font-medium text-xs">{conn.displayName}</TableCell>
												<TableCell>
													<Badge variant="outline" class="text-[9px]">{mcpSourceLabel(conn.sourceType)}</Badge>
												</TableCell>
												<TableCell>
													{#if conn.sourceType === 'nimble_piece'}
														{#if matchingAppConnections.length > 0}
															<NativeSelect
																value={conn.connectionExternalId || ''}
																disabled={mcpBusyId === conn.id}
																class="h-7 max-w-[190px] text-[10px]"
																onchange={(event) => updateMcpCredential(conn, (event.currentTarget as HTMLSelectElement).value)}
															>
																<option value="">No credential</option>
																{#each matchingAppConnections as app (app.externalId)}
																	<option value={app.externalId}>{app.displayName || app.providerLabel}</option>
																{/each}
															</NativeSelect>
														{:else}
															<span class="text-[9px] text-muted-foreground">No matching app connection</span>
														{/if}
													{:else}
														<span class="text-[9px] text-muted-foreground">—</span>
													{/if}
												</TableCell>
												<TableCell>
													{#if conn.status === 'ENABLED'}
														<Badge variant="default" class="text-[9px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">Enabled</Badge>
													{:else if conn.status === 'ERROR'}
														<Badge variant="destructive" class="text-[9px]">Error</Badge>
													{:else}
														<Badge variant="secondary" class="text-[9px]">Disabled</Badge>
													{/if}
												</TableCell>
												<TableCell>
													{#if conn.serverUrl}
														<code class="font-mono text-[9px] text-muted-foreground truncate max-w-[200px] block">{conn.serverUrl}</code>
													{:else}
														<span class="text-[9px] text-muted-foreground">—</span>
													{/if}
												</TableCell>
												<TableCell>
													<span class="text-[10px] text-muted-foreground">{mcpToolCount(conn)}</span>
												</TableCell>
												<TableCell class="text-right">
													<div class="flex items-center justify-end gap-0.5">
														<Button
															variant="ghost"
															size="icon"
															class="h-7 w-7"
															disabled={mcpBusyId === conn.id}
															onclick={() => toggleMcpStatus(conn)}
														>
															{#if mcpBusyId === conn.id}
																<Loader2 size={12} class="animate-spin" />
															{:else if conn.status === 'ENABLED'}
																<PowerOff size={12} class="text-muted-foreground" />
															{:else}
																<Power size={12} class="text-green-500" />
															{/if}
														</Button>
														{#if conn.sourceType !== 'hosted_workflow'}
															<Button
																variant="ghost"
																size="icon"
																class="h-7 w-7 text-muted-foreground hover:text-destructive"
																disabled={mcpBusyId === conn.id}
																onclick={() => deleteMcpConnection(conn)}
															>
																<Trash2 size={12} />
															</Button>
														{/if}
													</div>
												</TableCell>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							{/if}
						</div>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	</div>
</div>

<!-- Generated Key Dialog -->
<Dialog
	open={showKeyDialog}
	onOpenChange={(v) => {
		if (!v) {
			showKeyDialog = false;
			generatedKey = null;
		}
	}}
>
	<DialogHeader>
		<DialogTitle>API Key Created</DialogTitle>
		<DialogDescription>Copy your API key now. It will not be shown again.</DialogDescription>
	</DialogHeader>
	{#if generatedKey}
		<div class="my-4 rounded-md border border-border bg-muted p-3">
			<code class="block break-all text-sm">{generatedKey}</code>
		</div>
		<DialogFooter>
			<Button
				variant="outline"
				onclick={() => {
					showKeyDialog = false;
					generatedKey = null;
				}}
			>
				Close
			</Button>
			<Button onclick={() => copyToClipboard(generatedKey!)}>Copy to Clipboard</Button>
		</DialogFooter>
	{/if}
</Dialog>

<!-- OAuth App Configure Dialog -->
<Dialog open={oauthDialogOpen} onOpenChange={(v) => { if (!v) { oauthDialogOpen = false; oauthDialogApp = null; } }}>
	<DialogContent class="sm:max-w-md">
		<DialogHeader>
			<DialogTitle class="flex items-center gap-2">
				{#if oauthDialogApp?.logoUrl}
					<img src={oauthDialogApp.logoUrl} alt="" class="h-5 w-5 rounded" />
				{/if}
				Configure {oauthDialogApp?.displayName ?? 'OAuth App'}
			</DialogTitle>
			<DialogDescription>
				Enter the OAuth2 credentials for this integration.
			</DialogDescription>
		</DialogHeader>
		<form class="space-y-4" onsubmit={(e) => { e.preventDefault(); saveOauthApp(); }}>
			<div class="space-y-1.5">
				<Label for="oauth-client-id">Client ID</Label>
				<Input id="oauth-client-id" bind:value={oauthClientId} placeholder="Your OAuth2 Client ID" class="text-xs font-mono" />
			</div>
			<div class="space-y-1.5">
				<Label for="oauth-client-secret">Client Secret</Label>
				<Input
					id="oauth-client-secret"
					type="password"
					bind:value={oauthClientSecret}
					placeholder={oauthDialogApp?.configured ? 'Leave blank to keep existing' : 'Required for new app'}
					class="text-xs"
				/>
			</div>
			<DialogFooter>
				<Button variant="outline" type="button" onclick={() => { oauthDialogOpen = false; oauthDialogApp = null; }}>Cancel</Button>
				<Button type="submit" disabled={oauthSaving || !oauthClientId.trim() || (!oauthDialogApp?.configured && !oauthClientSecret.trim())}>
					{#if oauthSaving}<Loader2 size={12} class="animate-spin" />{/if}
					Save
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>
</Dialog>
