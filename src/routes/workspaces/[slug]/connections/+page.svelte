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
		Check,
		CheckCircle2,
		ChevronDown,
		ChevronRight,
		Copy,
		Globe,
		KeyRound,
		LayoutGrid,
		Loader2,
		Plug,
		Plus,
		RefreshCw,
		Search,
		ShieldCheck,
		Sparkles,
		Trash2,
		Unplug
	} from '@lucide/svelte';
	import {
		completePendingOAuth,
		inspectOAuthCallback,
		startOAuthConnect
	} from '$lib/connections/oauth-popup';
	import { createPieceMcp } from '$lib/connections/piece-mcp';
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
		/** AP-catalog metadata for a piece NOT bundled in the image (not connectable). */
		availableOnly?: boolean;
	};

	type McpAvailabilityEntry = CatalogEntry & {
		registered: boolean;
		enabled: boolean;
		availableOnly: boolean;
		ready: boolean;
		authStatus:
			| 'READY'
			| 'NO_AUTH_REQUIRED'
			| 'CONNECT_REQUIRED'
			| 'OAUTH_APP_MISSING'
			| 'SERVER_NOT_REGISTERED'
			| 'AVAILABLE_NOT_ENABLED';
		authStatusLabel: string;
		selectedAppConnection: CatalogAppConnection | null;
		mcpConnectionExternalId: string | null;
		serviceName: string | null;
		namespace: string | null;
		registrationReason: string | null;
	};

	let { data }: { data: PageData } = $props();
	const slug = $derived((page.params.slug as string) ?? 'default');

	const initialTab = (() => {
		const tab = page.url.searchParams.get('tab');
		if (tab === 'mcp') return 'mcp';
		if (tab === 'apps') return 'apps';
		return 'catalog';
	})();

	let activeTab = $state(initialTab);
	let appConnections = $state<AppConnection[]>([]);
	let mcpConnections = $state<McpConnection[]>([]);
	let catalogEntries = $state<CatalogEntry[]>([]);
	let mcpAvailabilityEntries = $state<McpAvailabilityEntry[]>([]);
	let vaults = $state<VaultSummary[]>([]);
	let vaultCredentials = $state<VaultCredentialSummary[]>([]);
	let loading = $state(true);
	let busy = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	let hubSearch = $state('');
	let hubFilter = $state<'all' | 'connected' | 'available' | 'catalog'>('all');
	let hubCategory = $state('ALL');

	let appSearch = $state('');
	let appStatus = $state('ALL');
	let mcpSearch = $state('');
	let appProviderSearch = $state('');
	let selectedConnectionByPiece = $state<Record<string, string>>({});
	let expandedClientConfig = $state<string | null>(null);
	let copiedKey = $state<string | null>(null);

	let addDialogOpen = $state(false);
	let selectedEntry = $state<CatalogEntry | null>(null);
	let addMcpAfterSecretCreate = $state(false);
	let secretValue = $state('');
	let connectionName = $state('');

	let customName = $state('');
	let customUrl = $state('');

	const availabilityByPiece = $derived.by(() => {
		const map = new Map<string, McpAvailabilityEntry>();
		for (const entry of mcpAvailabilityEntries) map.set(entry.pieceName, entry);
		return map;
	});

	const hubCategories = $derived.by(() =>
		Array.from(new Set(catalogEntries.flatMap((entry) => entry.categories))).sort()
	);

	function isConnectedEntry(entry: CatalogEntry): boolean {
		if (entry.appConnections.length > 0) return true;
		return entry.mcpConnection?.status === 'ENABLED' && !entry.requiresAuth;
	}

	function boundConnection(entry: CatalogEntry): CatalogAppConnection | null {
		if (entry.appConnections.length === 0) return null;
		const boundId = entry.mcpConnection?.connectionExternalId;
		return entry.appConnections.find((conn) => conn.externalId === boundId) ?? entry.appConnections[0];
	}

	function matchesHubSearch(entry: CatalogEntry, q: string): boolean {
		if (!q) return true;
		return [
			entry.displayName,
			entry.pieceName,
			entry.description ?? '',
			entry.authType,
			...entry.categories
		]
			.join(' ')
			.toLowerCase()
			.includes(q);
	}

	const hubFilteredEntries = $derived.by(() => {
		const q = hubSearch.trim().toLowerCase();
		return catalogEntries.filter((entry) => {
			// 'catalog' = the hundreds of available-only pieces (not bundled). Every
			// other filter shows ONLY connectable (bundled) pieces — available-only
			// are excluded so they never crowd the connect flows.
			if (hubFilter === 'catalog') {
				if (!entry.availableOnly) return false;
			} else if (entry.availableOnly) {
				return false;
			}
			if (hubFilter === 'connected' && !isConnectedEntry(entry)) return false;
			if (hubFilter === 'available' && isConnectedEntry(entry)) return false;
			if (hubCategory !== 'ALL' && !entry.categories.includes(hubCategory)) return false;
			return matchesHubSearch(entry, q);
		});
	});

	const availableOnlyCount = $derived(
		catalogEntries.filter((entry) => entry.availableOnly).length
	);

	const connectedEntries = $derived.by(() => catalogEntries.filter(isConnectedEntry));

	/** "Popular" curated row = pieces the reconciler pinned (always-warm Knative services). */
	const popularEntries = $derived.by(() =>
		mcpAvailabilityEntries.filter((entry) => entry.registrationReason === 'pinned')
	);

	const showCuratedSections = $derived(
		hubFilter === 'all' && !hubSearch.trim() && hubCategory === 'ALL'
	);

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

	const filteredProviderCatalog = $derived.by(() => {
		const q = appProviderSearch.trim().toLowerCase();
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

	const filteredMcpAvailability = $derived.by(() => {
		const q = mcpSearch.trim().toLowerCase();
		if (!q) return mcpAvailabilityEntries;
		return mcpAvailabilityEntries.filter((entry) =>
			[
				entry.displayName,
				entry.pieceName,
				entry.description ?? '',
				entry.authType,
				entry.authStatusLabel,
				entry.serviceName ?? '',
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

	/** External-clients endpoint = the hosted workflow MCP gateway connection (public URL). */
	const hostedGatewayConnection = $derived.by(
		() => mcpConnections.find((conn) => conn.sourceType === 'hosted_workflow') ?? null
	);

	onMount(() => {
		void loadAll().then(() => resumeOAuthIfPresent());
	});

	async function loadAll() {
		loading = true;
		errorMessage = null;
		try {
			const [appsRes, availabilityRes, catalogRes, vaultsRes] = await Promise.all([
				fetch('/api/app-connections'),
				fetch('/api/mcp-connections/availability'),
				fetch('/api/mcp-connections/catalog'),
				fetch('/api/v1/vaults')
			]);
			if (!appsRes.ok) throw new Error(`App connections failed (${appsRes.status})`);
			if (!availabilityRes.ok) throw new Error(`MCP availability failed (${availabilityRes.status})`);
			if (!catalogRes.ok) throw new Error(`MCP catalog failed (${catalogRes.status})`);

			appConnections = await appsRes.json();
			const availabilityBody = (await availabilityRes.json()) as {
				entries?: McpAvailabilityEntry[];
				projectConnections?: McpConnection[];
			};
			mcpAvailabilityEntries = availabilityBody.entries ?? [];
			mcpConnections = availabilityBody.projectConnections ?? [];
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

	function openAddConnection(entry?: CatalogEntry, addMcp = false) {
		selectedEntry = entry ?? null;
		addMcpAfterSecretCreate = addMcp;
		secretValue = '';
		connectionName = entry ? `${entry.displayName}` : '';
		appProviderSearch = '';
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
			const connection = (await res.json()) as AppConnection;
			if (addMcpAfterSecretCreate) {
				await createPieceMcp(selectedEntry.canonicalPieceName, connection.externalId);
				activeTab = 'mcp';
			}
			toast.success(addMcpAfterSecretCreate ? 'Connected and added MCP server' : 'Connection created');
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
			const { promise } = startOAuthConnect({
				pieceName: entry.canonicalPieceName,
				displayName: connectionName.trim() || entry.displayName,
				addMcp,
				oauthAppConfigured: entry.oauthAppConfigured
			});
			await promise;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start OAuth');
			busy = null;
		}
	}

	async function resumeOAuthIfPresent() {
		const callback = data.oauthCallback as Record<string, string | null> | null;
		const inspection = inspectOAuthCallback(callback);
		if (inspection.kind === 'none') return;
		if (inspection.kind === 'error') {
			toast.error(inspection.message);
			return;
		}

		busy = 'oauth-resume';
		try {
			const connection = await completePendingOAuth(inspection);
			if (inspection.pending.addMcp) {
				await createPieceMcp(inspection.pending.pieceName, connection.externalId);
			}
			toast.success(
				inspection.pending.addMcp ? 'Connected and added MCP server' : 'Connection created'
			);
			await invalidateAll();
			await loadAll();
			goto(`/workspaces/${slug}/connections`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'OAuth completion failed');
		} finally {
			busy = null;
		}
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

	function normalizePiece(value: string | null | undefined): string {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[_\s]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function availabilityForConnection(conn: McpConnection): McpAvailabilityEntry | null {
		if (conn.sourceType !== 'nimble_piece') return null;
		const piece = normalizePiece(conn.pieceName);
		return availabilityByPiece.get(piece) ?? null;
	}

	function authBadgeVariant(entry: McpAvailabilityEntry): 'default' | 'secondary' | 'outline' {
		if (entry.ready || entry.authStatus === 'READY') return 'secondary';
		if (entry.authStatus === 'NO_AUTH_REQUIRED') return 'outline';
		return 'outline';
	}

	function statusDotClass(availability: McpAvailabilityEntry | null | undefined): string {
		if (!availability || availability.authStatus === 'SERVER_NOT_REGISTERED')
			return 'bg-muted-foreground/40';
		if (availability.authStatus === 'READY' || availability.authStatus === 'NO_AUTH_REQUIRED')
			return 'bg-emerald-500';
		if (availability.authStatus === 'OAUTH_APP_MISSING') return 'bg-red-500';
		return 'bg-amber-500';
	}

	function openPiece(entry: CatalogEntry) {
		goto(`/workspaces/${slug}/connections/${entry.pieceName}`);
	}

	function mcpServerJsonName(conn: McpConnection): string {
		if (conn.sourceType === 'nimble_piece' && conn.pieceName) {
			return `ap-${normalizePiece(conn.pieceName)}`;
		}
		if (conn.sourceType === 'hosted_workflow') return 'workflow-builder-hosted';
		return conn.serverKey || normalizePiece(conn.displayName) || 'mcp-server';
	}

	function clientConfigSnippet(conn: McpConnection): string {
		const server: Record<string, unknown> = {
			type: 'http',
			url: conn.serverUrl ?? ''
		};
		if (conn.connectionExternalId) {
			server.headers = { 'X-Connection-External-Id': conn.connectionExternalId };
		}
		return JSON.stringify({ mcpServers: { [mcpServerJsonName(conn)]: server } }, null, 2);
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

	function formatDate(value: string | undefined): string {
		if (!value) return '';
		return new Date(value).toLocaleDateString();
	}
</script>

<svelte:head>
	<title>Integrations · Workflow Builder</title>
</svelte:head>

{#snippet pieceCard(entry: CatalogEntry)}
	{@const availability = availabilityByPiece.get(entry.pieceName) ?? null}
	{@const bound = boundConnection(entry)}
	{@const availableOnly = entry.availableOnly === true}
	{@const connected = isConnectedEntry(entry)}
	<button
		type="button"
		class="group relative flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card/50 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-lg hover:shadow-primary/5"
		onclick={() => openPiece(entry)}
	>
		<div class="flex items-start gap-3">
			<div class="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-gradient-to-b from-muted/30 to-muted/60">
				{#if entry.logoUrl}
					<img
						src={entry.logoUrl}
						alt=""
						class={`size-7 object-contain transition duration-300 ${availableOnly ? 'opacity-70 grayscale group-hover:opacity-100 group-hover:grayscale-0' : ''}`}
					/>
				{:else}
					<Plug class="size-5 text-muted-foreground" />
				{/if}
			</div>
			<div class="min-w-0 flex-1 pt-0.5">
				<div class="truncate text-sm font-semibold leading-tight text-foreground">{entry.displayName}</div>
				<div class="mt-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
					{entry.categories[0]?.replace(/_/g, ' ') ?? 'Integration'}
				</div>
			</div>
			<span
				class={`mt-1.5 size-2 shrink-0 rounded-full ring-4 ${connected ? 'bg-emerald-400 ring-emerald-400/10' : availableOnly ? 'bg-amber-400 ring-amber-400/10' : availability?.registered ? 'bg-sky-400 ring-sky-400/10' : 'bg-muted-foreground/30 ring-transparent'}`}
				title={connected ? 'Connected' : availableOnly ? 'Available — enable to use' : availability?.registered ? 'Ready to connect' : 'Not connected'}
			></span>
		</div>
		<p class="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-muted-foreground">
			{entry.description ?? 'Activepieces integration'}
		</p>
		<div class="mt-auto flex items-center justify-between border-t border-border/40 pt-2.5 text-[11px] text-muted-foreground">
			<span class="tabular-nums">{entry.actionCount} action{entry.actionCount === 1 ? '' : 's'}</span>
			{#if availableOnly}
				<span class="font-medium text-amber-500/80">Enable to use</span>
			{:else if connected}
				<span class="inline-flex max-w-[150px] items-center gap-1 truncate font-medium text-emerald-500">
					<CheckCircle2 class="size-3 shrink-0" />
					<span class="truncate">{bound ? bound.displayName : 'Connected'}</span>
				</span>
			{:else}
				<span class="inline-flex items-center gap-0.5 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
					Connect <ChevronRight class="size-3" />
				</span>
			{/if}
		</div>
	</button>
{/snippet}

<div class="h-full overflow-auto">
	<div class="mx-auto max-w-7xl p-6 space-y-5">
		<header class="flex items-start justify-between gap-4 flex-wrap">
			<div class="flex items-center gap-3">
				<div class="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary/25 to-primary/5 ring-1 ring-inset ring-primary/20">
					<LayoutGrid class="size-5 text-primary" />
				</div>
				<div>
					<h1 class="text-2xl font-semibold tracking-tight">Integrations</h1>
					<p class="mt-0.5 text-sm text-muted-foreground">
						Connect apps and expose approved MCP servers to your workflows and agents.
					</p>
				</div>
			</div>
			<Button onclick={() => void loadAll()} variant="outline" size="sm" disabled={loading}>
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
				<TabsTrigger value="catalog"><LayoutGrid class="size-4" /> Catalog</TabsTrigger>
				<TabsTrigger value="apps"><KeyRound class="size-4" /> My connections</TabsTrigger>
				<TabsTrigger value="mcp"><Plug class="size-4" /> MCP servers</TabsTrigger>
			</TabsList>

			<TabsContent value="catalog" class="space-y-5 pt-4">
				<div class="flex items-center gap-2 flex-wrap">
					<div class="relative min-w-[240px] flex-1">
						<Search class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
						<Input class="h-9 border-border/60 bg-card/50 pl-9" placeholder="Search integrations…" bind:value={hubSearch} />
					</div>
					<div class="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/50 p-1">
						{#each [['all', 'All'], ['connected', 'Connected'], ['available', 'Available']] as [value, label] (value)}
							<Button
								variant={hubFilter === value ? 'secondary' : 'ghost'}
								size="sm"
								class="h-7 px-3 text-xs"
								onclick={() => (hubFilter = value as typeof hubFilter)}
							>
								{label}
							</Button>
						{/each}
						{#if availableOnlyCount > 0}
							<Button
								variant={hubFilter === 'catalog' ? 'secondary' : 'ghost'}
								size="sm"
								class="h-7 px-3 text-xs gap-1.5"
								onclick={() => (hubFilter = 'catalog')}
								title="Browse the full Activepieces catalog — pieces an admin can enable"
							>
								Catalog
								<Badge variant="outline" class="px-1 text-[10px] leading-none">{availableOnlyCount}</Badge>
							</Button>
						{/if}
					</div>
					<NativeSelect bind:value={hubCategory} class="h-9 w-[170px] border-border/60 bg-card/50">
						<option value="ALL">All categories</option>
						{#each hubCategories as category (category)}
							<option value={category}>{category.replace(/_/g, ' ')}</option>
						{/each}
					</NativeSelect>
				</div>

				{#if hubFilter === 'catalog'}
					<Alert>
						<AlertDescription class="text-xs">
							These {availableOnlyCount} pieces are in the Activepieces catalog but not yet
							bundled in this deployment, so they can't be connected directly. A platform
							admin enables a piece by adding it to the bundle (Admin → Pieces); once
							enabled it becomes connectable here.
						</AlertDescription>
					</Alert>
				{/if}

				{#if loading}
					<div class="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
						Loading integrations…
					</div>
				{:else}
					{#if showCuratedSections && connectedEntries.length > 0}
						<section class="space-y-3">
							<div class="flex items-center gap-2">
								<h2 class="text-sm font-semibold">Connected</h2>
								<Badge variant="outline">{connectedEntries.length}</Badge>
							</div>
							<div class="rounded-md border divide-y">
								{#each connectedEntries as entry (entry.pieceName)}
									{@const bound = boundConnection(entry)}
									{@const availability = availabilityByPiece.get(entry.pieceName) ?? null}
									<button
										type="button"
										class="w-full p-3 flex items-center justify-between gap-3 text-left hover:bg-muted/50"
										onclick={() => openPiece(entry)}
									>
										<div class="flex items-center gap-3 min-w-0">
											{#if entry.logoUrl}
												<img src={entry.logoUrl} alt="" class="size-7 rounded shrink-0" />
											{/if}
											<div class="min-w-0">
												<div class="flex items-center gap-2">
													<span class="text-sm font-medium">{entry.displayName}</span>
													<span class={`size-2 rounded-full ${statusDotClass(availability)}`}></span>
												</div>
												{#if bound}
													<div class="text-xs text-muted-foreground truncate">
														{bound.displayName}
														<span class="text-[10px]">· {bound.externalId}</span>
													</div>
												{:else}
													<div class="text-xs text-muted-foreground">No authentication required</div>
												{/if}
											</div>
										</div>
										<div class="flex items-center gap-1 shrink-0">
											{#if entry.mcpConnection?.status === 'ENABLED'}
												<Badge variant="secondary" class="text-[10px]"><Plug class="size-3" /> MCP</Badge>
											{/if}
											<CheckCircle2 class="size-4 text-emerald-500" />
											<ChevronRight class="size-4 text-muted-foreground" />
										</div>
									</button>
								{/each}
							</div>
						</section>
					{/if}

					{#if showCuratedSections && popularEntries.length > 0}
						<section class="space-y-3">
							<div class="flex items-center gap-2">
								<Sparkles class="size-4 text-muted-foreground" />
								<h2 class="text-sm font-semibold">Popular</h2>
							</div>
							<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
								{#each popularEntries as entry (entry.pieceName)}
									{@render pieceCard(entry)}
								{/each}
							</div>
						</section>
					{/if}

					<section class="space-y-3">
						<div class="flex items-center gap-2">
							<h2 class="text-sm font-semibold">All integrations</h2>
							<Badge variant="outline">{hubFilteredEntries.length}</Badge>
						</div>
						{#if hubFilteredEntries.length === 0}
							<div class="rounded-xl border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
								No integrations match this filter.
							</div>
						{:else}
							<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
								{#each hubFilteredEntries as entry (entry.pieceName)}
									{@render pieceCard(entry)}
								{/each}
							</div>
						{/if}
					</section>
				{/if}
			</TabsContent>

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
						<div>
							<h2 class="text-sm font-semibold">Workspace MCP Servers</h2>
							<p class="text-xs text-muted-foreground">
								Enabled servers are reachable in-cluster by agents and workflows. Copy the URL or a
								client config snippet to wire one up manually.
							</p>
						</div>
						<Badge variant="outline">{configuredMcp.length}</Badge>
					</div>
					<div class="rounded-md border divide-y">
						{#if configuredMcp.length === 0}
							<div class="p-4 text-sm text-muted-foreground">No MCP servers are enabled for this workspace.</div>
						{:else}
							{#each configuredMcp as conn (conn.id)}
								{@const availability = availabilityForConnection(conn)}
								<div class="p-3 space-y-2">
									<div class="flex items-center justify-between gap-3">
										<div class="min-w-0">
											<div class="flex items-center gap-2 flex-wrap">
												<span class="font-medium text-sm">{conn.displayName}</span>
												<Badge variant={conn.status === 'ENABLED' ? 'default' : 'outline'}>{conn.status}</Badge>
												<Badge variant="outline">{conn.sourceType}</Badge>
												{#if availability}
													<Badge variant={authBadgeVariant(availability)}>
														{availability.authStatusLabel}
													</Badge>
													{#if availability.registered}
														<Badge variant="outline">
															<CheckCircle2 class="size-3" />
															Registered
														</Badge>
													{:else if conn.status === 'ENABLED'}
														<Badge variant="outline">
															<Loader2 class="size-3 animate-spin" />
															Provisioning (≤2 min)
														</Badge>
													{/if}
												{:else if conn.connectionExternalId}
													<Badge variant="secondary">
														<KeyRound class="size-3" />
														App connection
													</Badge>
												{/if}
												{#if matchingVaultCredentials(conn.serverUrl).length > 0}
													<Badge variant="secondary">
														<ShieldCheck class="size-3" />
														Vault auth
													</Badge>
												{/if}
											</div>
											<div class="text-[11px] text-muted-foreground truncate mt-1 font-mono">{conn.serverUrl}</div>
										</div>
										<div class="flex items-center gap-1 shrink-0">
											{#if conn.serverUrl}
												<Button
													variant="ghost"
													size="icon"
													title="Copy server URL"
													onclick={() => copyText(`url:${conn.id}`, conn.serverUrl ?? '')}
												>
													{#if copiedKey === `url:${conn.id}`}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onclick={() => (expandedClientConfig = expandedClientConfig === conn.id ? null : conn.id)}
												>
													<ChevronDown
														class={`size-4 transition-transform ${expandedClientConfig === conn.id ? 'rotate-180' : ''}`}
													/>
													Config
												</Button>
											{/if}
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
									{#if expandedClientConfig === conn.id && conn.serverUrl}
										<div class="relative">
											<pre class="bg-muted rounded p-3 text-[11px] overflow-x-auto font-mono">{clientConfigSnippet(conn)}</pre>
											<Button
												variant="ghost"
												size="sm"
												class="absolute top-1.5 right-1.5 h-7 text-xs"
												onclick={() => copyText(`cfg:${conn.id}`, clientConfigSnippet(conn))}
											>
												{#if copiedKey === `cfg:${conn.id}`}<Check class="size-3" /> Copied{:else}<Copy class="size-3" /> Copy{/if}
											</Button>
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				</section>

				<section class="space-y-3">
					<h2 class="text-sm font-semibold">External clients</h2>
					<div class="rounded-md border p-4 space-y-2">
						<div class="flex items-center gap-2">
							<Globe class="size-4 text-muted-foreground" />
							<span class="text-sm font-medium">MCP gateway</span>
						</div>
						{#if hostedGatewayConnection?.serverUrl}
							<div class="flex items-center gap-2">
								<code class="text-[11px] bg-muted rounded px-2 py-1 truncate flex-1">{hostedGatewayConnection.serverUrl}</code>
								<Button
									variant="ghost"
									size="icon"
									title="Copy gateway URL"
									onclick={() => copyText('gateway', hostedGatewayConnection?.serverUrl ?? '')}
								>
									{#if copiedKey === 'gateway'}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
								</Button>
							</div>
							<p class="text-xs text-muted-foreground">
								External MCP clients (Claude Desktop, IDEs) connect through the hosted mcp-gateway with the
								workspace bearer token. Manage the hosted server and token in
								<a href="/settings" class="underline">Settings</a>.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Piece MCP servers are cluster-local (<code>ap-&lt;piece&gt;-service</code>). External clients
								need the hosted mcp-gateway endpoint — enable the hosted workflow MCP server in
								<a href="/settings" class="underline">Settings</a> to get a public URL.
							</p>
						{/if}
					</div>
				</section>

				<section class="space-y-3">
					<div class="flex items-center justify-between gap-3">
						<div>
							<h2 class="text-sm font-semibold">Registered MCP Services</h2>
							<p class="text-xs text-muted-foreground">
								These services are registered by the ActivePieces MCP reconciler and can be enabled for this workspace.
							</p>
						</div>
						<Badge variant="outline">{filteredMcpAvailability.length}</Badge>
					</div>
					<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
						{#each filteredMcpAvailability as entry (entry.pieceName)}
							<Card class="overflow-hidden">
								<CardHeader class="pb-2">
									<div class="flex items-start justify-between gap-3">
										<button type="button" class="flex items-center gap-2 min-w-0 text-left" onclick={() => openPiece(entry)}>
											{#if entry.logoUrl}
												<img src={entry.logoUrl} alt="" class="size-8 rounded" />
											{/if}
											<div class="min-w-0">
												<CardTitle class="text-sm truncate">{entry.displayName}</CardTitle>
												<p class="text-[11px] text-muted-foreground truncate">{entry.pieceName}</p>
											</div>
										</button>
										{#if entry.ready}
											<Badge variant="secondary"><CheckCircle2 class="size-3" /> Ready</Badge>
										{:else if entry.mcpConnection}
											<Badge variant={entry.mcpConnection.status === 'ENABLED' ? 'default' : 'outline'}>
												{entry.mcpConnection.status}
											</Badge>
										{:else if entry.registered}
											<Badge variant="outline">Available</Badge>
										{/if}
									</div>
								</CardHeader>
								<CardContent class="space-y-3">
									<div class="flex items-center gap-1 flex-wrap">
										{#if entry.registered}
											<Badge variant="outline">{entry.registrationReason ?? 'registered'}</Badge>
										{:else}
											<Badge variant="outline">not registered</Badge>
										{/if}
										<Badge variant="outline">{entry.actionCount} tools</Badge>
										<Badge variant="outline">{entry.authType}</Badge>
										<Badge variant={authBadgeVariant(entry)}>{entry.authStatusLabel}</Badge>
										{#if entry.isOAuth2 && entry.oauthAppConfigured}
											<Badge variant="secondary"><CheckCircle2 class="size-3" /> OAuth app</Badge>
										{/if}
									</div>
									{#if entry.serviceName}
										<code class="block truncate text-[10px] text-muted-foreground">
											{entry.serviceName}.{entry.namespace ?? 'workflow-builder'}
										</code>
									{/if}
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
											<Button class="w-full" onclick={() => addMcp(entry)} disabled={!entry.registered || busy === `mcp:${entry.pieceName}`}>
												<Plug class="size-4" /> {entry.mcpConnection ? 'Update MCP binding' : 'Add MCP'}
											</Button>
										{:else if entry.isOAuth2}
											<Button class="w-full" onclick={() => beginOAuthConnection(entry, true)} disabled={!entry.registered || !entry.oauthAppConfigured || busy === `oauth:${entry.pieceName}`}>
												{#if busy === `oauth:${entry.pieceName}`}<Loader2 class="size-4 animate-spin" />{:else}<KeyRound class="size-4" />{/if}
												Connect & add
											</Button>
											{#if !entry.oauthAppConfigured}
												<p class="text-[11px] text-muted-foreground">
													Configure this provider in <a href="/settings" class="underline">Settings</a> first.
												</p>
											{/if}
										{:else}
											<Button class="w-full" variant="outline" onclick={() => openAddConnection(entry, true)} disabled={!entry.registered}>
												<KeyRound class="size-4" /> Connect & add
											</Button>
										{/if}
									{:else}
										<Button class="w-full" onclick={() => addMcp(entry)} disabled={!entry.registered}>
											<Plug class="size-4" /> {entry.mcpConnection ? 'Refresh MCP' : 'Add MCP'}
										</Button>
									{/if}
								</CardContent>
							</Card>
						{/each}
						{#if filteredMcpAvailability.length === 0}
							<div class="rounded-md border border-dashed p-4 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
								No registered MCP services match this search.
							</div>
						{/if}
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
							<a href={`/workspaces/${slug}/credentials`} class="underline">Manage vault credentials</a>.
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
					<Input placeholder="Search providers" bind:value={appProviderSearch} />
				</div>
				<div class="max-h-[320px] overflow-auto divide-y">
					{#each filteredProviderCatalog.filter((entry) => entry.requiresAuth) as entry (entry.pieceName)}
						<button
							type="button"
							class="w-full text-left p-2 hover:bg-muted/60 {selectedEntry?.pieceName === entry.pieceName ? 'bg-muted' : ''}"
							onclick={() => {
								selectedEntry = entry;
								addMcpAfterSecretCreate = false;
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
							<KeyRound class="size-4" /> {addMcpAfterSecretCreate ? 'Create and add MCP' : 'Create connection'}
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
