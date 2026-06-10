<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import {
		ChevronDown,
		ChevronRight,
		ExternalLink,
		KeyRound,
		Loader2,
		Plug,
		RotateCcw,
		Search,
		Trash2
	} from '@lucide/svelte';
	import { isReadOnlyPieceAction, type PieceMetadataAction } from '$lib/connections/piece-tools';
	import { toolSelectionFromMetadata } from '$lib/connections/piece-mcp';
	import {
		effectiveAgentTools,
		materializeAllowedTools,
		normalizePiece,
		type McpAvailabilityEntryLite
	} from '$lib/connections/agent-mcp';
	import type { McpServerProfileConfig } from '$lib/server/agent-profiles';
	import type { VaultCredentialSummary } from '$lib/types/vaults';
	import ToolGroupList from './ToolGroupList.svelte';

	interface Props {
		server: McpServerProfileConfig;
		/** Project availability entry for piece servers (null for custom/preset/hosted). */
		entry: McpAvailabilityEntryLite | null;
		/** Catalog logo URL (piece servers). */
		logoUrl?: string | null;
		/** Workspace slug for deep links. */
		slug: string;
		/** Matched vault credential for custom-URL servers (null if none). */
		credential?: VaultCredentialSummary | null;
		onChange: (next: McpServerProfileConfig) => void;
		onRemove: () => void;
	}

	let { server, entry, logoUrl, slug, credential = null, onChange, onRemove }: Props = $props();

	let open = $state(false);
	let toolSearch = $state('');
	let liveToolNames = $state<string[] | null>(null);
	let actions = $state<PieceMetadataAction[] | null>(null);
	let loadingTools = $state(false);
	let toolError = $state<string | null>(null);
	let loaded = $state(false);

	const isPiece = $derived(server.sourceType === 'nimble_piece');
	const displayName = $derived(server.displayName ?? server.server_name ?? 'MCP server');

	/** "server-enforced" for piece servers (?tools= transport), else "client-enforced". */
	const transportLabel = $derived(isPiece ? 'server-enforced' : 'client-enforced');

	/** Capability chips. */
	const capabilities = $derived.by(() => {
		const chips: string[] = ['MCP'];
		if (isPiece) chips.unshift('Actions');
		return chips;
	});

	/** Project ceiling for THIS piece (workspace tool selection). null = unbounded. */
	const ceiling = $derived.by(() => {
		if (!isPiece) return null;
		return toolSelectionFromMetadata(entry?.mcpConnection?.metadata ?? null);
	});

	/** Effective per-agent tool set + count. */
	const effective = $derived(
		effectiveAgentTools(server, ceiling, liveToolNames ?? [])
	);

	/** Live tool-count badge: enabled / ceiling-bounded universe. */
	const badge = $derived.by(() => {
		if (liveToolNames === null) return null;
		const ceilSet = ceiling === null ? null : new Set(ceiling);
		const universe = liveToolNames.filter((n) => (ceilSet ? ceilSet.has(n) : true)).length;
		return { enabled: effective.count, total: universe };
	});

	/** Pinned allowedTools that are no longer in the live tool list (removed upstream). */
	const driftedTools = $derived.by(() => {
		if (!Array.isArray(server.allowedTools) || liveToolNames === null) return [];
		const live = new Set(liveToolNames);
		return server.allowedTools.filter((t) => !live.has(t));
	});

	/** Whether a "Connect ↗" / "Manage ↗" deep-link should show in the footer. */
	const needsConnect = $derived.by(() => {
		const status = entry?.authStatus;
		return (
			status === 'CONNECT_REQUIRED' ||
			status === 'OAUTH_APP_MISSING' ||
			status === 'SERVER_NOT_REGISTERED'
		);
	});

	function pieceHref(): string {
		const piece = normalizePiece(server.pieceName ?? entry?.pieceName ?? '');
		return `/workspaces/${slug}/connections/${piece}`;
	}

	const filteredActions = $derived.by(() => {
		const list = actions ?? [];
		const q = toolSearch.trim().toLowerCase();
		if (!q) return list;
		return list.filter((a) =>
			[a.name, a.displayName, a.description ?? ''].join(' ').toLowerCase().includes(q)
		);
	});
	const readOnlyActions = $derived(filteredActions.filter(isReadOnlyPieceAction));
	const writeActions = $derived(filteredActions.filter((a) => !isReadOnlyPieceAction(a)));

	const ceilingSet = $derived(ceiling === null ? null : new Set(ceiling));

	async function ensureLoaded() {
		if (loaded || loadingTools) return;
		loadingTools = true;
		toolError = null;
		try {
			const connId = server.mcpConnectionExternalId ?? entry?.mcpConnection?.id ?? null;
			const tasks: Promise<void>[] = [];
			if (connId) {
				tasks.push(
					(async () => {
						const res = await fetch(`/api/mcp-connections/${connId}/tools`);
						if (res.ok) {
							const body = (await res.json()) as { toolNames?: string[] };
							liveToolNames = body.toolNames ?? [];
						} else {
							liveToolNames = [];
						}
					})()
				);
			} else {
				liveToolNames = [];
			}
			if (isPiece) {
				const piece = normalizePiece(server.pieceName ?? entry?.pieceName ?? '');
				if (piece) {
					tasks.push(
						(async () => {
							const res = await fetch(`/api/mcp-connections/catalog/${piece}/actions`);
							if (res.ok) {
								const body = (await res.json()) as { actions?: PieceMetadataAction[] };
								actions = body.actions ?? [];
								// Prefer the richer action list as the live universe when the
								// tools endpoint returned nothing.
								if ((liveToolNames?.length ?? 0) === 0) {
									liveToolNames = (body.actions ?? []).map((a) => a.name);
								}
							} else {
								actions = [];
							}
						})()
					);
				} else {
					actions = [];
				}
			} else {
				actions = [];
			}
			await Promise.all(tasks);
			loaded = true;
		} catch (err) {
			toolError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingTools = false;
		}
	}

	function onOpenChange(next: boolean) {
		open = next;
		if (next) void ensureLoaded();
	}

	/** Apply a tool-selection delta and persist as an explicit allowedTools list. */
	function applyToolSelection(add: string[], remove: string[]) {
		// Start from the current effective set so we never widen past the ceiling.
		const removeSet = new Set(remove);
		const names = [...[...effective.enabled].filter((t) => !removeSet.has(t)), ...add].filter((t) =>
			ceilingSet ? ceilingSet.has(t) : true
		);
		onChange({ ...server, allowedTools: materializeAllowedTools(names) });
	}

	/** Toggle one tool for this agent — materializes allowedTools on first narrow. */
	function setToolEnabled(name: string, checked: boolean) {
		if (checked) applyToolSelection([name], []);
		else applyToolSelection([], [name]);
	}

	function setGroupEnabled(group: PieceMetadataAction[], checked: boolean) {
		const names = group.map((a) => a.name);
		if (checked) applyToolSelection(names, []);
		else applyToolSelection([], names);
	}

	/** Reset to the workspace default — DELETE the key (never write `[]`). */
	function resetToDefault() {
		const next = { ...server };
		delete next.allowedTools;
		onChange(next);
	}

	const isNarrowed = $derived(Array.isArray(server.allowedTools));
</script>

<div class="rounded-lg border bg-card">
	<div class="flex items-start gap-3 p-3">
		{#if logoUrl}
			<img src={logoUrl} alt="" class="size-8 rounded shrink-0" />
		{:else}
			<div class="size-8 rounded bg-muted flex items-center justify-center shrink-0">
				<Plug class="size-4 text-muted-foreground" />
			</div>
		{/if}
		<div class="min-w-0 flex-1 space-y-1.5">
			<div class="flex items-center gap-2 flex-wrap">
				<span class="font-medium text-sm truncate">{displayName}</span>
				{#if entry}
					<span class="flex items-center gap-1">
						<span
							class="size-1.5 rounded-full {entry.ready
								? 'bg-emerald-500'
								: 'bg-amber-500'}"
						></span>
						<span class="text-[11px] text-muted-foreground">{entry.authStatusLabel}</span>
					</span>
				{/if}
			</div>
			<div class="flex items-center gap-1.5 flex-wrap">
				{#each capabilities as cap (cap)}
					<Badge variant="outline" class="text-[10px]">{cap}</Badge>
				{/each}
				<Badge variant="outline" class="text-[10px]">{transportLabel}</Badge>
				{#if badge}
					<Badge variant="secondary" class="text-[10px]">{badge.enabled}/{badge.total}</Badge>
				{/if}
				{#if isNarrowed}
					<Badge variant="outline" class="text-[10px] text-primary">narrowed</Badge>
				{/if}
			</div>
		</div>
		<Button
			variant="ghost"
			size="icon"
			class="size-7 text-destructive shrink-0"
			onclick={onRemove}
			title="Remove server"
		>
			<Trash2 class="size-3.5" />
		</Button>
	</div>

	<Collapsible {open} {onOpenChange}>
		<CollapsibleTrigger
			class="flex items-center gap-1.5 w-full px-3 pb-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
		>
			{#if open}
				<ChevronDown class="size-3.5" />
			{:else}
				<ChevronRight class="size-3.5" />
			{/if}
			Tool permissions{badge ? ` (${badge.enabled})` : ''}
		</CollapsibleTrigger>
		<CollapsibleContent class="px-3 pb-3 space-y-3">
			{#if loadingTools}
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 class="size-3.5 animate-spin" /> Loading tools…
				</div>
			{:else if toolError}
				<p class="text-xs text-destructive">{toolError}</p>
			{:else if !isPiece}
				<p class="text-xs text-muted-foreground">
					This server is client-enforced. Tool narrowing applies at the runtime, not the
					transport — no per-tool list is available here.
				</p>
			{:else if (actions ?? []).length === 0}
				<p class="text-xs text-muted-foreground">No tools registered for this server.</p>
			{:else}
				<div class="flex items-center justify-between gap-2">
					<div class="relative w-[220px]">
						<Search
							class="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
						/>
						<Input class="pl-8 h-8 text-sm" placeholder="Search tools" bind:value={toolSearch} />
					</div>
					{#if isNarrowed}
						<Button
							variant="ghost"
							size="sm"
							class="h-7 px-2 text-[11px]"
							onclick={resetToDefault}
						>
							<RotateCcw class="size-3" /> Reset to workspace default
						</Button>
					{/if}
				</div>
				{#if driftedTools.length > 0}
					<p class="text-[11px] text-muted-foreground">
						Pinned tools no longer registered:
						{#each driftedTools as tool (tool)}
							<code class="text-[10px] line-through mr-1">{tool}</code>
						{/each}
						<span class="text-amber-600 dark:text-amber-400">removed upstream</span>
					</p>
				{/if}
				<ToolGroupList
					title="Read-only"
					actions={readOnlyActions}
					enabled={effective.enabled}
					ceiling={ceilingSet}
					manageHref={pieceHref()}
					onToolToggle={setToolEnabled}
					onGroupToggle={setGroupEnabled}
				/>
				<ToolGroupList
					title="Write"
					actions={writeActions}
					enabled={effective.enabled}
					ceiling={ceilingSet}
					manageHref={pieceHref()}
					onToolToggle={setToolEnabled}
					onGroupToggle={setGroupEnabled}
				/>
			{/if}

			<div class="border-t pt-2 flex items-center justify-between gap-2 flex-wrap">
				<div class="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
					{#if credential}
						<Badge variant="secondary" class="text-[10px]">
							<KeyRound class="size-3" /> {credential.displayName}
						</Badge>
					{:else if server.mcpConnectionExternalId}
						<Badge variant="secondary" class="text-[10px]">
							<KeyRound class="size-3" /> app connection
						</Badge>
					{:else if server.url}
						<code class="text-[10px] truncate">{server.url}</code>
					{/if}
				</div>
				{#if isPiece && needsConnect}
					<a
						class="inline-flex items-center gap-1 text-[11px] underline text-amber-600 dark:text-amber-400 hover:text-amber-700"
						href={pieceHref()}
						target="_blank"
						rel="noreferrer"
					>
						{entry?.authStatus === 'SERVER_NOT_REGISTERED' ? 'Manage' : 'Connect'}
						<ExternalLink class="size-3" />
					</a>
				{/if}
			</div>
		</CollapsibleContent>
	</Collapsible>
</div>
