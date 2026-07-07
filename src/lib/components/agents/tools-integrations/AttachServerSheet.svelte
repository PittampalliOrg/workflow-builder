<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		Sheet,
		SheetContent,
		SheetDescription,
		SheetHeader,
		SheetTitle
	} from '$lib/components/ui/sheet';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { Check, ExternalLink, Globe, Plug, Plus, Search } from '@lucide/svelte';
	import {
		attachPieceServerConfig,
		attachWorkspaceServerConfig,
		serverMatchesEntry,
		serverMatchesWorkspaceServer,
		serverKey,
		BROWSER_MCP_PRESETS,
		type McpAvailabilityEntryLite,
		type McpWorkspaceServerLite
	} from '$lib/connections/agent-mcp';
	import type { McpServerProfileConfig } from '$lib/server/agent-profiles';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		/** Currently attached servers (so we can show "Attached"). */
		value: McpServerProfileConfig[];
		/** Project availability entries (piece catalog). */
		entries: McpAvailabilityEntryLite[];
		/** Non-piece workspace connections (custom URLs + platform-shared servers). */
		workspaceServers?: McpWorkspaceServerLite[];
		/** Logo lookup by piece name. */
		logoFor: (pieceName: string) => string | null;
		slug: string;
		onAttach: (server: McpServerProfileConfig) => void;
	}

	let {
		open,
		onOpenChange,
		value,
		entries,
		workspaceServers = [],
		logoFor,
		slug,
		onAttach
	}: Props = $props();

	function isWorkspaceServerAttached(row: McpWorkspaceServerLite): boolean {
		return value.some((s) => serverMatchesWorkspaceServer(s, row));
	}
	function attachWorkspaceServer(row: McpWorkspaceServerLite) {
		if (isWorkspaceServerAttached(row)) return;
		onAttach(attachWorkspaceServerConfig(row));
	}
	function workspaceServerDescription(row: McpWorkspaceServerLite): string {
		const metadata = (row.metadata ?? {}) as { description?: string };
		if (typeof metadata.description === 'string' && metadata.description) {
			return metadata.description;
		}
		return row.serverUrl ?? row.sourceType;
	}

	let search = $state('');
	let newName = $state('');
	let newUrl = $state('');

	const filteredEntries = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = [...entries].sort((a, b) => a.displayName.localeCompare(b.displayName));
		if (!q) return list;
		return list.filter((e) =>
			[e.displayName, e.pieceName, e.description ?? '', ...e.categories]
				.join(' ')
				.toLowerCase()
				.includes(q)
		);
	});

	function isAttached(entry: McpAvailabilityEntryLite): boolean {
		return value.some((server) => serverMatchesEntry(server, entry));
	}

	function canAttach(entry: McpAvailabilityEntryLite): boolean {
		return entry.authStatus === 'READY' || entry.authStatus === 'NO_AUTH_REQUIRED';
	}

	function pieceHref(entry: McpAvailabilityEntryLite): string {
		return `/workspaces/${slug}/connections/${entry.pieceName}`;
	}

	function attachPiece(entry: McpAvailabilityEntryLite) {
		onAttach(attachPieceServerConfig(entry));
	}

	function addUrlServer() {
		const name = newName.trim();
		const url = newUrl.trim();
		if (!name || !url) return;
		onAttach({
			server_name: name,
			displayName: name,
			sourceType: 'custom_url',
			transport: 'streamable_http',
			url
		});
		newName = '';
		newUrl = '';
	}

	const hostedAttached = $derived(value.some((s) => s.sourceType === 'hosted_workflow'));
	function toggleHosted(on: boolean) {
		if (on) {
			onAttach({
				server_name: 'workflow-builder-hosted',
				displayName: 'Workflow Builder (hosted)',
				sourceType: 'hosted_workflow',
				transport: 'streamable_http'
			});
		}
	}

	function isPresetAttached(preset: McpServerProfileConfig): boolean {
		return value.some((s) => serverKey(s) === serverKey(preset));
	}
	function attachPreset(preset: McpServerProfileConfig) {
		if (isPresetAttached(preset)) return;
		onAttach({ ...preset });
	}

	const anyPresetAttached = $derived(BROWSER_MCP_PRESETS.some(isPresetAttached));
</script>

<Sheet {open} {onOpenChange}>
	<SheetContent side="right" class="w-full sm:max-w-xl flex flex-col gap-0">
		<SheetHeader>
			<SheetTitle>Attach integration</SheetTitle>
			<SheetDescription>
				Add a workspace MCP server, a custom endpoint, the hosted workflow tools, or a browser
				preset to this agent.
			</SheetDescription>
		</SheetHeader>

		<Tabs value="catalog" class="flex-1 min-h-0 flex flex-col mt-2">
			<TabsList class="grid grid-cols-4">
				<TabsTrigger value="catalog">Catalog</TabsTrigger>
				<TabsTrigger value="custom">Custom URL</TabsTrigger>
				<TabsTrigger value="hosted">Hosted</TabsTrigger>
				<TabsTrigger value="browser">Browser</TabsTrigger>
			</TabsList>

			<TabsContent value="catalog" class="flex-1 min-h-0 overflow-auto space-y-3 pt-3">
				{#if workspaceServers.length > 0}
					<div class="space-y-2">
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Workspace servers
						</div>
						{#each workspaceServers as row (row.id)}
							{@const attached = isWorkspaceServerAttached(row)}
							<div class="rounded-lg border p-3 flex items-center justify-between gap-3">
								<div class="flex items-start gap-2 min-w-0">
									<div class="size-7 rounded bg-muted flex items-center justify-center shrink-0">
										<Plug class="size-3.5 text-muted-foreground" />
									</div>
									<div class="min-w-0">
										<div class="text-sm font-medium truncate">{row.displayName}</div>
										<div class="text-[10px] text-muted-foreground truncate">
											{workspaceServerDescription(row)}
										</div>
									</div>
								</div>
								{#if attached}
									<Badge variant="secondary" class="text-[10px] shrink-0">
										<Check class="size-3" /> Attached
									</Badge>
								{:else}
									<Button
										variant="outline"
										size="sm"
										class="h-7 text-[11px] shrink-0"
										onclick={() => attachWorkspaceServer(row)}
									>
										<Plus class="size-3" /> Attach
									</Button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
				<div class="relative">
					<Search
						class="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input class="pl-8 h-9" placeholder="Search integrations" bind:value={search} />
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
					{#each filteredEntries as entry (entry.pieceName)}
						{@const attached = isAttached(entry)}
						{@const logo = logoFor(entry.pieceName)}
						<div class="rounded-lg border p-3 space-y-2 flex flex-col">
							<div class="flex items-start gap-2">
								{#if logo}
									<img src={logo} alt="" class="size-7 rounded shrink-0" />
								{:else}
									<div
										class="size-7 rounded bg-muted flex items-center justify-center shrink-0"
									>
										<Plug class="size-3.5 text-muted-foreground" />
									</div>
								{/if}
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-1.5">
										<span class="text-sm font-medium truncate">{entry.displayName}</span>
										<span
											class="size-1.5 rounded-full {entry.ready
												? 'bg-emerald-500'
												: 'bg-amber-500'}"
										></span>
									</div>
									<div class="text-[10px] text-muted-foreground">
										{entry.actionCount} actions · {entry.authStatusLabel}
									</div>
								</div>
							</div>
							<div class="mt-auto">
								{#if attached}
									<Badge variant="secondary" class="text-[10px]">
										<Check class="size-3" /> Attached
									</Badge>
								{:else if canAttach(entry)}
									<Button
										variant="outline"
										size="sm"
										class="h-7 w-full text-[11px]"
										onclick={() => attachPiece(entry)}
									>
										<Plus class="size-3" /> Attach
									</Button>
								{:else}
									<a
										class="inline-flex items-center justify-center gap-1 h-7 w-full rounded-md border text-[11px] text-amber-600 dark:text-amber-400 hover:bg-muted"
										href={pieceHref(entry)}
										target="_blank"
										rel="noreferrer"
									>
										Connect <ExternalLink class="size-3" />
									</a>
								{/if}
							</div>
						</div>
					{/each}
					{#if filteredEntries.length === 0}
						<p class="text-xs text-muted-foreground col-span-full">No integrations match.</p>
					{/if}
				</div>
			</TabsContent>

			<TabsContent value="custom" class="space-y-3 pt-3">
				<p class="text-xs text-muted-foreground">
					Add an external streamable-HTTP MCP endpoint. Tool narrowing is client-enforced for
					custom servers.
				</p>
				<div class="space-y-1.5">
					<Label class="text-xs">Name</Label>
					<Input bind:value={newName} placeholder="github" />
				</div>
				<div class="space-y-1.5">
					<Label class="text-xs">Server URL</Label>
					<Input bind:value={newUrl} placeholder="https://api.githubcopilot.com/mcp/" />
				</div>
				<Button onclick={addUrlServer} disabled={!newName.trim() || !newUrl.trim()}>
					<Plus class="size-4" /> Add server
				</Button>
			</TabsContent>

			<TabsContent value="hosted" class="space-y-3 pt-3">
				<div class="rounded-lg border p-3 flex items-center justify-between gap-3">
					<div class="min-w-0">
						<div class="text-sm font-medium">Workflow Builder hosted tools</div>
						<p class="text-xs text-muted-foreground">
							Expose this workspace's hosted MCP gateway (goal + workflow tools) to the agent.
						</p>
					</div>
					{#if hostedAttached}
						<Badge variant="secondary" class="text-[10px]">
							<Check class="size-3" /> Attached
						</Badge>
					{:else}
						<Button variant="outline" size="sm" class="h-8" onclick={() => toggleHosted(true)}>
							<Plus class="size-3.5" /> Attach
						</Button>
					{/if}
				</div>
			</TabsContent>

			<TabsContent value="browser" class="space-y-3 pt-3">
				<div class="grid grid-cols-1 gap-2">
					{#each BROWSER_MCP_PRESETS as preset (serverKey(preset))}
						{@const attached = isPresetAttached(preset)}
						<div class="rounded-lg border p-3 flex items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="text-sm font-medium">{preset.displayName}</div>
								<code class="block truncate text-[10px] text-muted-foreground">
									{preset.command} {(preset.args ?? []).join(' ')}
								</code>
							</div>
							{#if attached}
								<Badge variant="secondary" class="text-[10px]">
									<Check class="size-3" /> Attached
								</Badge>
							{:else}
								<Button
									variant="outline"
									size="sm"
									class="h-8"
									onclick={() => attachPreset(preset)}
								>
									<Plus class="size-3.5" /> Attach
								</Button>
							{/if}
						</div>
					{/each}
				</div>
				{#if anyPresetAttached}
					<div
						role="note"
						class="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex gap-2"
					>
						<Globe class="size-4 shrink-0 mt-0.5" aria-hidden="true" />
						<div class="space-y-1">
							<p class="font-medium">Browser sidecar will be provisioned.</p>
							<p class="text-amber-600/90 dark:text-amber-300/80">
								Publishing this agent adds <code>chromium</code> and
								<code>playwright-mcp</code> containers to its pod (~1 GB memory, 10–30 s cold
								start). Sessions for this agent expose "Browser state" and "Shell" tabs.
							</p>
						</div>
					</div>
				{/if}
			</TabsContent>
		</Tabs>
	</SheetContent>
</Sheet>
