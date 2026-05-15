<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { KeyRound, Loader2, Plug, Plus, RefreshCw, Trash2 } from '@lucide/svelte';
	import type { McpServerProfileConfig } from '$lib/server/agent-profiles';
	import type { VaultCredentialSummary, VaultSummary } from '$lib/types/vaults';

	interface Props {
		value: McpServerProfileConfig[];
		connectionMode: 'explicit' | 'project' | 'auto';
		vaultIds: string[];
		onModeChange: (mode: 'explicit' | 'project' | 'auto') => void;
		onChange: (next: McpServerProfileConfig[]) => void;
	}

	let { value, connectionMode, vaultIds, onModeChange, onChange }: Props = $props();

	// Load vaults + all credentials across the attached vaults so we can show
	// which MCP server URLs have a matching credential.
	let vaults = $state<VaultSummary[]>([]);
	let credentialsByVault = $state<Record<string, VaultCredentialSummary[]>>({});
	let projectConnections = $state<ProjectMcpConnection[]>([]);
	let availabilityEntries = $state<McpAvailabilityEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// New server form
	let newName = $state('');
	let newUrl = $state('');

	type ProjectMcpConnection = {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		serverKey: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
	};

	type McpAvailabilityEntry = {
		pieceName: string;
		canonicalPieceName: string;
		displayName: string;
		description: string | null;
		categories: string[];
		authType: string;
		requiresAuth: boolean;
		isOAuth2: boolean;
		oauthAppConfigured: boolean;
		actionCount: number;
		registryRef: string;
		serverUrl: string;
		appConnections: Array<{
			id: string;
			externalId: string;
			displayName: string;
			type: string;
			status: string;
		}>;
		mcpConnection: ProjectMcpConnection | null;
		registered: boolean;
		enabled: boolean;
		ready: boolean;
		authStatus: string;
		authStatusLabel: string;
		mcpConnectionExternalId: string | null;
		serviceName: string | null;
		namespace: string | null;
		registrationReason: string | null;
	};

	const BROWSER_PRESETS: McpServerProfileConfig[] = [
		{
			server_name: 'playwright',
			displayName: 'Playwright',
			sourceType: 'preset',
			transport: 'stdio',
			command: 'npx',
			args: ['@playwright/mcp@latest']
		},
		{
			server_name: 'chrome_devtools',
			displayName: 'Chrome DevTools',
			sourceType: 'preset',
			transport: 'stdio',
			command: 'npx',
			args: ['chrome-devtools-mcp@latest']
		}
	];

	onMount(() => {
		void loadSupportData();
	});

	async function loadSupportData() {
		loading = true;
		error = null;
		try {
			const [res, projectRes] = await Promise.all([
				fetch('/api/v1/vaults'),
				fetch('/api/mcp-connections/availability')
			]);
			if (!res.ok) {
				error = `Failed to load vaults (${res.status})`;
				return;
			}
			if (projectRes.ok) {
				const body = (await projectRes.json()) as {
					entries?: McpAvailabilityEntry[];
					projectConnections?: ProjectMcpConnection[];
				};
				availabilityEntries = body.entries ?? [];
				projectConnections = body.projectConnections ?? [];
			} else {
				error = `Failed to load MCP availability (${projectRes.status})`;
			}
			const data = (await res.json()) as { vaults: VaultSummary[] };
			vaults = data.vaults ?? [];
			// Fetch credentials for every attached vault in parallel
			const attached = vaults.filter((v) => vaultIds.includes(v.id));
			const creds = await Promise.all(
				attached.map(async (v) => {
					const r = await fetch(`/api/v1/vaults/${v.id}/credentials`);
					if (!r.ok) return [v.id, []] as const;
					const d = (await r.json()) as { credentials: VaultCredentialSummary[] };
					return [v.id, d.credentials ?? []] as const;
				})
			);
			credentialsByVault = Object.fromEntries(creds);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function serverKey(server: McpServerProfileConfig): string {
		return (
			server.mcpConnectionExternalId ??
			server.server_name ?? server.serverName ?? server.name ?? server.displayName ?? ''
		);
	}

	function normalizeName(value: unknown): string {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[^a-z0-9_-]+/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
	}

	function connectionServerName(connection: ProjectMcpConnection): string {
		const base =
			connection.pieceName || connection.serverKey || connection.displayName || connection.id;
		if (connection.sourceType === 'nimble_piece') return normalizeName(`piece_${base}`);
		if (connection.sourceType === 'nimble_shared') return normalizeName(`shared_${base}`);
		if (connection.sourceType === 'custom_url') return normalizeName(`custom_${base}`);
		return normalizeName(base);
	}

	function projectServerConfig(connection: ProjectMcpConnection): McpServerProfileConfig {
		return {
			server_name: connectionServerName(connection),
			displayName: connection.displayName,
			sourceType: connection.sourceType,
			pieceName: connection.pieceName,
			serverKey: connection.serverKey,
			mcpConnectionExternalId: connection.id,
			transport: 'streamable_http'
		};
	}

	function isProjectSelected(connection: ProjectMcpConnection): boolean {
		return value.some((server) => isSameProjectServer(server, connection));
	}

	function isSameProjectServer(
		server: McpServerProfileConfig,
		connection: ProjectMcpConnection
	): boolean {
		const key = connectionServerName(connection);
		return server.mcpConnectionExternalId === connection.id || serverKey(server) === key;
	}

	function toggleProjectConnection(connection: ProjectMcpConnection, on: boolean) {
		const withoutConnection = value.filter((server) => !isSameProjectServer(server, connection));
		if (on) onChange([...withoutConnection, projectServerConfig(connection)]);
		else onChange(withoutConnection);
	}

	function isPresetSelected(preset: McpServerProfileConfig): boolean {
		return value.some((s) => serverKey(s) === serverKey(preset));
	}

	function togglePreset(preset: McpServerProfileConfig, on: boolean) {
		if (on) onChange([...value, { ...preset }]);
		else onChange(value.filter((s) => serverKey(s) !== serverKey(preset)));
	}

	function addUrlServer() {
		if (!newName.trim() || !newUrl.trim()) return;
		const server: McpServerProfileConfig = {
			server_name: newName.trim(),
			displayName: newName.trim(),
			transport: 'streamable_http',
			url: newUrl.trim()
		};
		onChange([...value, server]);
		newName = '';
		newUrl = '';
	}

	function removeServer(server: McpServerProfileConfig) {
		const key = serverKey(server);
		onChange(value.filter((s) => serverKey(s) !== key));
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

	function availabilityForConnection(connection: ProjectMcpConnection): McpAvailabilityEntry | null {
		if (connection.sourceType !== 'nimble_piece') return null;
		const piece = normalizePiece(connection.pieceName);
		return availabilityEntries.find((entry) => entry.pieceName === piece) ?? null;
	}

	const enabledProjectConnections = $derived.by(() =>
		projectConnections.filter((connection) => connection.status === 'ENABLED')
	);

	const registeredUnavailableEntries = $derived.by(() =>
		availabilityEntries.filter((entry) => entry.registered && !entry.enabled)
	);

	const effectiveProjectConnections = $derived.by(() =>
		enabledProjectConnections.filter((connection) => {
			const availability = availabilityForConnection(connection);
			return !availability || availability.ready || availability.authStatus === 'NO_AUTH_REQUIRED';
		})
	);

	function connectionsHref(): string {
		const slug = String(page.params.slug || '').trim();
		return slug ? `/workspaces/${slug}/connections?tab=mcp` : '/connections?tab=mcp';
	}

	function credentialForServer(
		server: McpServerProfileConfig
	): VaultCredentialSummary | null {
		if (!server.url) return null;
		for (const vid of vaultIds) {
			const creds = credentialsByVault[vid] ?? [];
			const match = creds.find((c) => c.mcpServerUrl === server.url);
			if (match) return match;
		}
		return null;
	}
</script>

<div class="space-y-4">
	<div class="flex items-end gap-3 flex-wrap">
		<div class="space-y-1.5 min-w-[260px]">
			<Label for="mcp-mode">Connection Mode</Label>
			<select
				id="mcp-mode"
				class="w-full rounded-md border bg-background px-3 py-2 text-sm"
				value={connectionMode}
				onchange={(e) =>
					onModeChange(
						(e.target as HTMLSelectElement).value as 'explicit' | 'project' | 'auto'
					)}
			>
				<option value="explicit">Explicit — only servers listed here</option>
				<option value="project">Project — include all project-scoped MCP</option>
				<option value="auto">Auto — project MCP when no explicit selections</option>
			</select>
		</div>
		<Button variant="outline" size="sm" onclick={() => void loadSupportData()}>
			{#if loading}
				<Loader2 class="size-3 animate-spin" />
			{:else}
				<RefreshCw class="size-3" />
			{/if}
			Refresh
		</Button>
	</div>

	{#if error}
		<div class="text-xs text-destructive">{error}</div>
	{/if}

	<div class="space-y-2">
		<p class="text-xs font-medium text-muted-foreground">
			Project MCP connections ({enabledProjectConnections.length})
		</p>
		{#if connectionMode === 'project'}
			<div class="rounded border border-dashed p-3 text-xs text-muted-foreground space-y-2">
				<p>This agent includes every ready workspace MCP server. Use explicit mode to narrow the list.</p>
				{#if effectiveProjectConnections.length > 0}
					<div class="flex flex-wrap gap-1">
						{#each effectiveProjectConnections as conn (conn.id)}
							<Badge variant="outline" class="text-[10px]">{conn.displayName}</Badge>
						{/each}
					</div>
				{:else}
					<p>No ready workspace MCP servers are enabled.</p>
				{/if}
			</div>
		{:else}
			<div class="grid grid-cols-1 md:grid-cols-2 gap-2">
				{#each enabledProjectConnections as conn (conn.id)}
					{@const availability = availabilityForConnection(conn)}
					{@const selectable = !availability || availability.ready || availability.authStatus === 'NO_AUTH_REQUIRED'}
					<label class="rounded border p-3 text-xs cursor-pointer hover:border-primary/50">
						<span class="flex items-start gap-2">
							<input
								type="checkbox"
								checked={isProjectSelected(conn)}
								disabled={!selectable}
								onchange={(e) =>
									toggleProjectConnection(conn, (e.target as HTMLInputElement).checked)}
							/>
							<span class="min-w-0">
								<span class="font-medium flex items-center gap-1 flex-wrap">
									<Plug class="size-3" /> {conn.displayName}
									{#if availability}
										<Badge variant={availability.ready ? 'secondary' : 'outline'} class="text-[10px]">
											{availability.authStatusLabel}
										</Badge>
									{/if}
								</span>
								<span class="block text-[10px] text-muted-foreground truncate">
									{conn.sourceType}{conn.pieceName ? ` · ${conn.pieceName}` : ''}
								</span>
							</span>
						</span>
					</label>
				{/each}
			</div>
			{#if enabledProjectConnections.length === 0}
				<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
					No enabled workspace MCP servers.
				</div>
			{/if}
			{#if registeredUnavailableEntries.length > 0}
				<div class="rounded border border-dashed p-3 text-xs text-muted-foreground space-y-2">
					<div class="flex items-center justify-between gap-2">
						<span>Registered MCP services available to enable</span>
						<a class="underline" href={connectionsHref()}>Open Connections</a>
					</div>
					<div class="flex flex-wrap gap-1">
						{#each registeredUnavailableEntries as entry (entry.pieceName)}
							<Badge variant="outline" class="text-[10px]">
								{entry.displayName} · {entry.authStatusLabel}
							</Badge>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	<div class="space-y-2">
		<p class="text-xs font-medium text-muted-foreground">
			MCP servers ({value.length})
		</p>
		<p class="text-[11px] text-muted-foreground">
			Workspace MCP servers use app connections. Custom URL servers can use attached vault
			credentials matched by MCP server URL.
		</p>
		{#if value.length === 0}
			<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
				No MCP servers declared.
			</div>
		{:else}
			<div class="space-y-2">
				{#each value as server (serverKey(server))}
					{@const cred = credentialForServer(server)}
					<div class="rounded border p-3 space-y-1">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="font-medium text-sm">
										{server.displayName ?? server.server_name}
									</span>
									{#if server.transport}
										<Badge variant="outline" class="text-[10px]">{server.transport}</Badge>
									{/if}
									{#if cred}
										<Badge variant="secondary" class="text-[10px]">
											<KeyRound class="size-3" /> {cred.displayName}
										</Badge>
									{:else if server.mcpConnectionExternalId}
										<Badge variant="secondary" class="text-[10px]">
											<KeyRound class="size-3" /> app connection
										</Badge>
									{:else if server.url}
										<Badge variant="outline" class="text-[10px] text-amber-600">
											no credential match
										</Badge>
									{/if}
								</div>
								{#if server.url}
									<code class="text-[10px] text-muted-foreground truncate block mt-1">
										{server.url}
									</code>
								{/if}
								{#if !cred && server.url}
									<p class="text-[11px] text-muted-foreground mt-1">
										Add a vault credential with <code>mcpServerUrl = {server.url}</code> to
										authenticate this server.
									</p>
								{/if}
							</div>
							<Button
								variant="ghost"
								size="icon"
								class="size-7 text-destructive"
								onclick={() => removeServer(server)}
							>
								<Trash2 class="size-3" />
							</Button>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="flex gap-2 items-end pt-2">
			<div class="flex-1">
				<Label class="text-[11px]">Name</Label>
				<Input bind:value={newName} placeholder="github" />
			</div>
			<div class="flex-[2]">
				<Label class="text-[11px]">Server URL</Label>
				<Input bind:value={newUrl} placeholder="https://api.githubcopilot.com/mcp/" />
			</div>
			<Button onclick={addUrlServer} disabled={!newName.trim() || !newUrl.trim()}>
				<Plus class="size-4" /> Add
			</Button>
		</div>
	</div>

	<div class="space-y-2 border-t pt-4">
		<p class="text-xs font-medium text-muted-foreground">Browser MCP Presets</p>
		<div class="grid grid-cols-1 md:grid-cols-2 gap-2">
			{#each BROWSER_PRESETS as preset}
				<label class="rounded border p-3 text-xs cursor-pointer hover:border-primary/50">
					<span class="flex items-center gap-2">
						<input
							type="checkbox"
							checked={isPresetSelected(preset)}
							onchange={(e) => togglePreset(preset, (e.target as HTMLInputElement).checked)}
						/>
						<span class="font-medium">{preset.displayName}</span>
					</span>
					<code class="mt-2 block truncate text-[10px] text-muted-foreground">
						{preset.command} {(preset.args ?? []).join(' ')}
					</code>
				</label>
			{/each}
		</div>
		{#if BROWSER_PRESETS.some((p) => isPresetSelected(p))}
			<div
				role="note"
				class="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex gap-2"
			>
				<span aria-hidden="true">🌐</span>
				<div class="space-y-1">
					<p class="font-medium">Browser sidecar will be provisioned.</p>
					<p class="text-amber-600/90 dark:text-amber-300/80">
						Publishing this agent adds <code>chromium</code> and <code>playwright-mcp</code>
						containers to its pod (~1 GB memory, 10–30 s cold start). Sessions for this agent
						expose "Browser state" and "Shell" tabs.
					</p>
				</div>
			</div>
		{:else}
			<p class="text-[11px] text-muted-foreground">
				Adding a browser preset auto-provisions a chromium + playwright-mcp sidecar on the agent's
				runtime pod.
			</p>
		{/if}
	</div>
</div>
