<script lang="ts">
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
	import { Switch } from '$lib/components/ui/switch';
	import {
		ArrowLeft,
		Check,
		CheckCircle2,
		Copy,
		KeyRound,
		Loader2,
		Pencil,
		Plug,
		RefreshCw,
		Search,
		Workflow
	} from '@lucide/svelte';
	import { startOAuthConnect } from '$lib/connections/oauth-popup';
	import {
		createPieceMcp,
		toolSelectionFromMetadata,
		updateMcpConnection,
		type PieceMcpConnection
	} from '$lib/connections/piece-mcp';
	import ToolGroupList from '$lib/components/agents/tools-integrations/ToolGroupList.svelte';
	import { isReadOnlyPieceAction } from '$lib/connections/piece-tools';
	import type { PageData } from './$types';

	type CatalogAppConnection = {
		id: string;
		externalId: string;
		displayName: string;
		type: string;
		status: string;
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
		mcpConnection: PieceMcpConnection | null;
	};

	type McpAvailabilityEntry = CatalogEntry & {
		registered: boolean;
		enabled: boolean;
		ready: boolean;
		authStatus:
			| 'READY'
			| 'NO_AUTH_REQUIRED'
			| 'CONNECT_REQUIRED'
			| 'OAUTH_APP_MISSING'
			| 'SERVER_NOT_REGISTERED';
		authStatusLabel: string;
		serviceName: string | null;
		namespace: string | null;
		registrationReason: string | null;
	};

	let { data }: { data: PageData } = $props();
	const slug = $derived((page.params.slug as string) ?? 'default');
	const piece = $derived(data.piece);
	const actions = $derived(data.actions);
	const usageByConnection = $derived(data.usageByConnection);

	let entry = $state<CatalogEntry | null>(null);
	let availability = $state<McpAvailabilityEntry | null>(null);
	let mcpConn = $state<PieceMcpConnection | null>(null);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let toolSearch = $state('');
	let copiedKey = $state<string | null>(null);

	let secretDialogOpen = $state(false);
	let connectionName = $state('');
	let secretValue = $state('');

	const allToolNames = $derived(actions.map((action) => action.name));

	/** null toolSelection = all tools enabled (including future ones). */
	const enabledTools = $derived.by(() => {
		const selection = toolSelectionFromMetadata(mcpConn?.metadata ?? null);
		if (selection === null) return new Set(allToolNames);
		return new Set(selection);
	});

	const filteredActions = $derived.by(() => {
		const q = toolSearch.trim().toLowerCase();
		if (!q) return actions;
		return actions.filter((action) =>
			[action.name, action.displayName, action.description ?? '']
				.join(' ')
				.toLowerCase()
				.includes(q)
		);
	});

	const readOnlyActions = $derived(filteredActions.filter(isReadOnlyPieceAction));
	const writeActions = $derived(
		filteredActions.filter((action) => !isReadOnlyPieceAction(action))
	);

	const mcpEnabled = $derived(mcpConn?.status === 'ENABLED');
	const provisioning = $derived(mcpEnabled && !(availability?.registered ?? false));
	const appConnections = $derived(entry?.appConnections ?? []);

	const overviewBullets = $derived.by(() => {
		const bullets: string[] = [];
		bullets.push(`${actions.length} actions available as deterministic workflow steps and MCP tools`);
		if (piece.categories.length > 0) bullets.push(`Categories: ${piece.categories.join(', ')}`);
		if (!piece.requiresAuth) {
			bullets.push('No authentication required');
		} else if (piece.isOAuth2) {
			bullets.push(`Authenticates via ${piece.authDisplayName ?? 'OAuth2'} (platform OAuth app)`);
		} else {
			bullets.push(`Authenticates via ${piece.authDisplayName ?? piece.authType}`);
		}
		if (availability?.serviceName) {
			bullets.push(
				`Served by ${availability.serviceName}.${availability.namespace ?? 'workflow-builder'} (${availability.registrationReason ?? 'registered'})`
			);
		} else {
			bullets.push('MCP service provisioned on demand by the reconciler (≤2 min after enable)');
		}
		return bullets;
	});

	onMount(() => {
		void loadLive();
	});

	async function loadLive() {
		loading = true;
		errorMessage = null;
		try {
			const [catalogRes, availabilityRes] = await Promise.all([
				fetch('/api/mcp-connections/catalog'),
				fetch('/api/mcp-connections/availability')
			]);
			if (!catalogRes.ok) throw new Error(`MCP catalog failed (${catalogRes.status})`);
			if (!availabilityRes.ok) throw new Error(`MCP availability failed (${availabilityRes.status})`);
			const catalogBody = (await catalogRes.json()) as { entries?: CatalogEntry[] };
			const availabilityBody = (await availabilityRes.json()) as {
				entries?: McpAvailabilityEntry[];
			};
			entry =
				(catalogBody.entries ?? []).find((item) => item.pieceName === piece.pieceName) ?? null;
			availability =
				(availabilityBody.entries ?? []).find((item) => item.pieceName === piece.pieceName) ?? null;
			mcpConn = availability?.mcpConnection ?? entry?.mcpConnection ?? null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function connectAccount() {
		if (!piece.requiresAuth) return;
		if (piece.isOAuth2) {
			void beginOAuth();
			return;
		}
		connectionName = piece.displayName;
		secretValue = '';
		secretDialogOpen = true;
	}

	async function beginOAuth() {
		const oauthAppConfigured = entry?.oauthAppConfigured ?? false;
		if (!oauthAppConfigured) {
			toast.error('Configure the platform OAuth app before connecting this provider');
			return;
		}
		busy = 'oauth';
		try {
			// Same-tab redirect: completion resumes on the Integrations hub
			// (the OAuth callback always redirects to /connections?oauth2_resume=1).
			const { promise } = startOAuthConnect({
				pieceName: piece.canonicalPieceName,
				displayName: piece.displayName,
				addMcp: false,
				oauthAppConfigured
			});
			await promise;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start OAuth');
			busy = null;
		}
	}

	async function reconnectAccount(conn: CatalogAppConnection) {
		if (!piece.isOAuth2) return;
		const oauthAppConfigured = entry?.oauthAppConfigured ?? false;
		if (!oauthAppConfigured) {
			toast.error('Configure the platform OAuth app before reconnecting this provider');
			return;
		}
		busy = `reconnect:${conn.id}`;
		try {
			// In-place re-auth: reuse the SAME connection row so /oauth2/complete
			// refreshes its token without changing external_id. Every
			// mcp_connection binding + agent reference keeps pointing at it.
			const { promise } = startOAuthConnect({
				pieceName: piece.canonicalPieceName,
				displayName: conn.displayName,
				existingConnectionId: conn.id,
				addMcp: false,
				oauthAppConfigured
			});
			await promise;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start reconnect');
			busy = null;
		}
	}

	async function createSecretConnection() {
		if (!connectionName.trim() || !secretValue.trim()) return;
		busy = 'secret';
		try {
			const res = await fetch('/api/app-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pieceName: piece.canonicalPieceName,
					displayName: connectionName.trim(),
					type: 'SECRET_TEXT',
					value: secretValue.trim()
				})
			});
			if (!res.ok) throw new Error(await res.text());
			toast.success('Connection created');
			secretDialogOpen = false;
			await loadLive();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create connection');
		} finally {
			busy = null;
		}
	}

	async function toggleMcpExposure(checked: boolean) {
		busy = 'mcp-toggle';
		try {
			if (mcpConn) {
				mcpConn = await updateMcpConnection(mcpConn.id, {
					status: checked ? 'ENABLED' : 'DISABLED'
				});
			} else if (checked) {
				const bound = appConnections[0]?.externalId ?? null;
				if (piece.requiresAuth && !bound) {
					toast.error('Connect an account first');
					return;
				}
				mcpConn = await createPieceMcp(piece.canonicalPieceName, bound);
			}
			toast.success(checked ? 'MCP server enabled' : 'MCP server disabled');
			await loadLive();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to update MCP server');
		} finally {
			busy = null;
		}
	}

	async function persistToolSelection(next: Set<string>) {
		if (!mcpConn) return;
		const everyEnabled =
			next.size >= allToolNames.length && allToolNames.every((name) => next.has(name));
		busy = 'tools';
		try {
			mcpConn = await updateMcpConnection(mcpConn.id, {
				toolSelection: everyEnabled ? null : { tools: allToolNames.filter((n) => next.has(n)) }
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to save tool selection');
		} finally {
			busy = null;
		}
	}

	function setToolEnabled(name: string, enabled: boolean) {
		const next = new Set(enabledTools);
		if (enabled) next.add(name);
		else next.delete(name);
		void persistToolSelection(next);
	}

	function setGroupEnabled(group: Array<{ name: string }>, enabled: boolean) {
		const next = new Set(enabledTools);
		for (const action of group) {
			if (enabled) next.add(action.name);
			else next.delete(action.name);
		}
		void persistToolSelection(next);
	}

	async function bindConnection(externalId: string) {
		if (!mcpConn) {
			busy = `bind:${externalId}`;
			try {
				mcpConn = await createPieceMcp(piece.canonicalPieceName, externalId);
				toast.success('MCP server enabled with this connection');
				await loadLive();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to bind connection');
			} finally {
				busy = null;
			}
			return;
		}
		busy = `bind:${externalId}`;
		try {
			mcpConn = await updateMcpConnection(mcpConn.id, { connectionExternalId: externalId });
			toast.success('MCP server now uses this connection');
			await loadLive();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to bind connection');
		} finally {
			busy = null;
		}
	}

	async function copyText(key: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedKey = key;
			setTimeout(() => {
				if (copiedKey === key) copiedKey = null;
			}, 1500);
		} catch {
			toast.error('Clipboard unavailable');
		}
	}

	function formatRelativeAge(value: string | null): string {
		if (!value) return 'unknown';
		const delta = Date.now() - new Date(value).getTime();
		if (!Number.isFinite(delta) || delta < 0) return 'just now';
		const minutes = Math.floor(delta / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}
</script>

<svelte:head>
	<title>{piece.displayName} · Integrations · Workflow Builder</title>
</svelte:head>

<div class="h-full overflow-auto">
	<div class="mx-auto max-w-5xl p-6 space-y-5">
		<div>
			<Button variant="ghost" size="sm" href={`/workspaces/${slug}/connections`} class="-ml-2 text-muted-foreground">
				<ArrowLeft class="size-4" /> Integrations
			</Button>
		</div>

		<header class="flex items-start justify-between gap-4 flex-wrap">
			<div class="flex items-start gap-3 min-w-0">
				{#if piece.logoUrl}
					<img src={piece.logoUrl} alt="" class="size-12 rounded" />
				{:else}
					<div class="size-12 rounded bg-muted flex items-center justify-center">
						<Plug class="size-6 text-muted-foreground" />
					</div>
				{/if}
				<div class="min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<h1 class="text-2xl font-semibold">{piece.displayName}</h1>
						<Badge variant="outline">v{piece.version}</Badge>
						{#if availability?.ready}
							<Badge variant="secondary"><CheckCircle2 class="size-3" /> Ready</Badge>
						{/if}
					</div>
					<p class="text-sm text-muted-foreground mt-1 max-w-2xl">
						{piece.description ?? 'Activepieces integration'}
					</p>
				</div>
			</div>
			{#if piece.requiresAuth}
				<Button onclick={connectAccount} disabled={busy === 'oauth' || busy === 'secret'}>
					{#if busy === 'oauth'}<Loader2 class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
					Connect account
				</Button>
			{/if}
		</header>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
			<div class="space-y-5 min-w-0">
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Overview</CardTitle>
					</CardHeader>
					<CardContent>
						<ul class="space-y-1.5">
							{#each overviewBullets as bullet (bullet)}
								<li class="text-sm text-muted-foreground flex items-start gap-2">
									<CheckCircle2 class="size-4 mt-0.5 shrink-0 text-emerald-500/70" />
									<span>{bullet}</span>
								</li>
							{/each}
						</ul>
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<div class="flex items-center justify-between gap-3 flex-wrap">
							<CardTitle class="text-sm">Actions &amp; tools</CardTitle>
							<div class="relative w-[220px]">
								<Search class="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
								<Input class="pl-8 h-8 text-sm" placeholder="Search tools" bind:value={toolSearch} />
							</div>
						</div>
						{#if !mcpConn}
							<p class="text-xs text-muted-foreground">
								Tool toggles control which tools the piece MCP server registers. Enable
								"Exposed as MCP server" to manage the selection — workflow actions are unaffected.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Disabled tools are excluded from the MCP server's tool list for agents and external clients.
							</p>
						{/if}
					</CardHeader>
					<CardContent class="space-y-4">
						<ToolGroupList
							title="Read-only"
							actions={readOnlyActions}
							enabled={enabledTools}
							ceiling={null}
							busy={busy === 'tools'}
							disabled={!mcpConn}
							onToolToggle={setToolEnabled}
							onGroupToggle={setGroupEnabled}
						/>
						<ToolGroupList
							title="Write"
							actions={writeActions}
							enabled={enabledTools}
							ceiling={null}
							busy={busy === 'tools'}
							disabled={!mcpConn}
							onToolToggle={setToolEnabled}
							onGroupToggle={setGroupEnabled}
						/>
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Connections</CardTitle>
					</CardHeader>
					<CardContent>
						{#if loading}
							<p class="text-sm text-muted-foreground">Loading connections…</p>
						{:else if appConnections.length === 0}
							<div class="text-sm text-muted-foreground">
								{#if piece.requiresAuth}
									No accounts connected yet. Use “Connect account” to add one.
								{:else}
									This integration does not require an account.
								{/if}
							</div>
						{:else}
							<div class="rounded-md border divide-y">
								{#each appConnections as conn (conn.externalId)}
									{@const usage = usageByConnection[conn.externalId]}
									{@const bound = mcpConn?.connectionExternalId === conn.externalId}
									<div class="p-3 flex items-center justify-between gap-3">
										<div class="min-w-0">
											<div class="flex items-center gap-2 flex-wrap">
												<span class="text-sm font-medium">{conn.displayName}</span>
												<Badge variant={conn.status === 'ACTIVE' ? 'secondary' : 'outline'}>{conn.status}</Badge>
												{#if bound}
													<Badge variant="default" class="text-[10px]"><Plug class="size-3" /> MCP binding</Badge>
												{/if}
											</div>
											<div class="text-[11px] text-muted-foreground truncate">{conn.externalId}</div>
										</div>
										<div class="flex items-center gap-2 shrink-0">
											<Badge variant="outline" class="text-[10px]">
												<Workflow class="size-3" />
												{usage?.workflowCount ?? 0} workflows · {usage?.refCount ?? 0} steps
											</Badge>
											{#if piece.isOAuth2}
												<Button
													variant="ghost"
													size="sm"
													disabled={busy === `reconnect:${conn.id}`}
													onclick={() => reconnectAccount(conn)}
													title="Re-run OAuth for this connection — refreshes the token in place (same external_id), so MCP + agent bindings keep working"
												>
													{#if busy === `reconnect:${conn.id}`}<Loader2 class="size-4 animate-spin" />{:else}<RefreshCw class="size-4" />{/if}
													Reconnect
												</Button>
											{/if}
											{#if !bound}
												<Button
													variant="ghost"
													size="sm"
													disabled={busy === `bind:${conn.externalId}`}
													onclick={() => bindConnection(conn.externalId)}
												>
													{#if busy === `bind:${conn.externalId}`}<Loader2 class="size-4 animate-spin" />{:else}<Pencil class="size-4" />{/if}
													Use for MCP
												</Button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</CardContent>
				</Card>
			</div>

			<div class="space-y-5">
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Capabilities</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="flex items-center justify-between gap-3">
							<div>
								<div class="text-sm font-medium">Workflow actions</div>
								<p class="text-xs text-muted-foreground">
									Available as deterministic steps in the canvas.
								</p>
							</div>
							<Badge variant="secondary"><CheckCircle2 class="size-3" /> {actions.length}</Badge>
						</div>
						<div class="flex items-center justify-between gap-3">
							<div>
								<div class="text-sm font-medium">Exposed as MCP server</div>
								<p class="text-xs text-muted-foreground">
									Registers an <code>ap-{piece.pieceName}-service</code> endpoint for agents.
								</p>
							</div>
							<Switch
								checked={mcpEnabled}
								disabled={loading || busy === 'mcp-toggle'}
								onCheckedChange={(checked) => void toggleMcpExposure(checked)}
							/>
						</div>
						{#if provisioning}
							<Alert>
								<AlertDescription class="flex items-center gap-2 text-xs">
									<Loader2 class="size-3.5 animate-spin" />
									Provisioning the MCP service — the reconciler registers it within ~2 minutes.
								</AlertDescription>
							</Alert>
						{:else if availability && mcpEnabled}
							<div class="text-xs text-muted-foreground space-y-1">
								<div class="flex items-center gap-1">
									<Badge variant="outline" class="text-[10px]">{availability.authStatusLabel}</Badge>
									{#if availability.registrationReason}
										<Badge variant="outline" class="text-[10px]">{availability.registrationReason}</Badge>
									{/if}
								</div>
								{#if mcpConn?.serverUrl}
									<div class="flex items-center gap-1">
										<code class="truncate text-[10px] bg-muted rounded px-1.5 py-0.5 flex-1">{mcpConn.serverUrl}</code>
										<Button
											variant="ghost"
											size="icon"
											class="size-6"
											title="Copy MCP URL"
											onclick={() => copyText('mcp-url', mcpConn?.serverUrl ?? '')}
										>
											{#if copiedKey === 'mcp-url'}<Check class="size-3" />{:else}<Copy class="size-3" />{/if}
										</Button>
									</div>
								{/if}
							</div>
						{/if}
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Metadata</CardTitle>
					</CardHeader>
					<CardContent class="space-y-2 text-sm">
						<div class="flex items-center justify-between gap-2">
							<span class="text-muted-foreground">Piece version</span>
							<code class="text-xs">{piece.version}</code>
						</div>
						<div class="flex items-center justify-between gap-2">
							<span class="text-muted-foreground">Catalog synced</span>
							<span class="text-xs" title={piece.catalogSyncedAt ?? undefined}>
								{formatRelativeAge(piece.catalogSyncedAt ?? piece.metadataUpdatedAt)}
							</span>
						</div>
						{#if piece.catalogSourceImage}
							<div class="space-y-1">
								<span class="text-muted-foreground text-xs">Catalog source image</span>
								<code class="block text-[10px] text-muted-foreground break-all">{piece.catalogSourceImage}</code>
							</div>
						{/if}
						<div class="flex items-center justify-between gap-2">
							<span class="text-muted-foreground">Auth</span>
							<Badge variant="outline" class="text-[10px]">{piece.authDisplayName ?? piece.authType}</Badge>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	</div>
</div>

<Dialog bind:open={secretDialogOpen}>
	<DialogContent class="sm:max-w-md">
		<DialogHeader>
			<DialogTitle>Connect {piece.displayName}</DialogTitle>
			<DialogDescription>{piece.authDisplayName ?? piece.authType}</DialogDescription>
		</DialogHeader>
		<div class="space-y-3">
			<div>
				<Label>Connection name</Label>
				<Input bind:value={connectionName} />
			</div>
			<div>
				<Label>Secret value</Label>
				<Input bind:value={secretValue} type="password" placeholder="Paste API key or token" />
			</div>
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (secretDialogOpen = false)}>Cancel</Button>
			<Button onclick={createSecretConnection} disabled={!connectionName.trim() || !secretValue.trim() || busy === 'secret'}>
				{#if busy === 'secret'}<Loader2 class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
				Create connection
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
